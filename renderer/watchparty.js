// Watch-together networking. Thin wrapper around PeerJS.
//
// Topology: star, with the room creator as the hub. Joining peers open a
// single DataChannel to the host. The host relays inbound messages to every
// other peer. This keeps the per-client connection count at 1 for guests
// (only the host pays the N-1 cost), so it scales fine for the kinds of
// watch parties this app is meant for (handful of friends, not a stadium).
//
// Control model: anyone-can-control. Any client's local play/pause/seek
// broadcasts an event that everyone else applies. The flag `applyingRemote`
// suppresses the echo so we don't get feedback loops.
//
// Drift: every 3 seconds the host emits its currentTime + paused state.
// Peers only re-sync if they've drifted >0.75s — otherwise the constant
// micro-corrections would feel jittery on top of the sidecar-audio drift
// correction the player already does.
//
// The relay used for signaling is PeerJS's public broker at peerjs.com.
// That handles the WebRTC handshake; once peers are connected the actual
// sync traffic is P2P, never touching any server we don't run.

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit I/O/0/1 for legibility
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_PREFIX = 'ytg-'; // disambiguates from random peerjs IDs in the public broker

function makeRoomCode() {
  let out = '';
  const buf = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(buf);
  for (const b of buf) out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return out;
}

function normalizeRoomCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

// EventTarget wrapper. Events emitted:
//   'state' — internal state changed (in-room, code, peer list, host status)
//   'message' — { data, from } — a sync message arrived from a peer
//   'error' — { message }
export class WatchParty extends EventTarget {
  constructor() {
    super();
    this.peer = null;          // PeerJS Peer instance
    this.connections = new Map(); // remote peer id → DataConnection
    this.roomCode = null;      // current room code (== host peer id minus prefix)
    this.isHost = false;
    this.applyingRemote = false; // set true while we apply an inbound event so the
                                 // resulting local play/pause doesn't echo back
    this.displayName = 'Guest';  // local user's name, shown in the room roster
    this._roster = new Map();    // HOST only: guest peerId → display name
    this._rosterList = [];       // EVERYONE: [{name, host}] for the "who's watching" UI
  }

  get peerCount() { return this.connections.size; }
  get inRoom() { return !!this.roomCode; }

  // Set the local display name (call before create/join). Used in the roster.
  setName(name) {
    this.displayName = (String(name || '').trim().slice(0, 32)) || 'Guest';
  }
  // The current room roster — [{ name, host }] including ourselves. Host builds
  // it from guest 'identify' messages; guests receive it via 'roster'.
  getRoster() { return this._rosterList.slice(); }

  // HOST: rebuild the roster (self + identified guests) and push it to guests.
  _broadcastRoster() {
    if (!this.isHost) return;
    const peers = [{ name: this.displayName, host: true }];
    for (const nm of this._roster.values()) peers.push({ name: nm, host: false });
    this._rosterList = peers;
    const payload = JSON.stringify({ type: 'roster', peers });
    for (const conn of this.connections.values()) { try { conn.send(payload); } catch {} }
    this._emitState();
  }

  // --- Public API -----------------------------------------------------------

  // Create a new room. Resolves with the 6-char room code once the broker
  // accepts our peer ID. Retries up to 3x on collision.
  async create() {
    if (this.peer) this.leave();
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = makeRoomCode();
      try {
        await this._openPeer(ROOM_CODE_PREFIX + code);
        this.roomCode = code;
        this.isHost = true;
        // Seed the roster with ourselves; guests get added as they identify.
        this._roster.clear();
        this._rosterList = [{ name: this.displayName, host: true }];
        // Host accepts inbound connections from guests.
        this.peer.on('connection', (conn) => this._wireConnection(conn));
        this._emitState();
        return code;
      } catch (e) {
        // ID taken → loop and pick a new one. Anything else bubbles up.
        const msg = String(e?.message || e || '');
        if (!/unavailable|taken/i.test(msg) && attempt > 0) {
          this._error(msg || 'Could not create room.');
          throw e;
        }
      }
    }
    const err = new Error('Could not allocate a room code after several tries.');
    this._error(err.message);
    throw err;
  }

  // Join a room by entering its code. Resolves once the DataChannel is open.
  async join(code) {
    const clean = normalizeRoomCode(code);
    if (clean.length !== ROOM_CODE_LENGTH) throw new Error('Room code should be 6 letters/numbers.');
    if (this.peer) this.leave();
    // Guests use a random peerjs ID. They only ever connect to the host.
    await this._openPeer(undefined);
    this.isHost = false;
    this.roomCode = clean;
    const conn = this.peer.connect(ROOM_CODE_PREFIX + clean, { reliable: true });
    await new Promise((resolve, reject) => {
      const onOpen = () => { conn.off('error', onErr); resolve(); };
      const onErr = (e) => { conn.off('open', onOpen); reject(e); };
      conn.once('open', onOpen);
      conn.once('error', onErr);
      // Hard timeout — broker is sometimes slow / the room code may not exist.
      setTimeout(() => reject(new Error('Couldn\'t reach that room. Double-check the code.')), 12000);
    }).catch((e) => {
      this.leave();
      throw e;
    });
    this._wireConnection(conn);
    this._emitState();
    // Say hello so the host sends us its current state, and identify
    // ourselves so the host can add us to the room roster.
    this.send(conn, { type: 'hello' });
    this.send(conn, { type: 'identify', name: this.displayName });
  }

  leave() {
    for (const c of this.connections.values()) {
      try { c.close(); } catch {}
    }
    this.connections.clear();
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }
    this.roomCode = null;
    this.isHost = false;
    this._roster.clear();
    this._rosterList = [];
    this._emitState();
  }

  // Broadcast a message to everyone in the room.
  // - Host: send to every connected guest
  // - Guest: send to host (host will relay to other guests if needed)
  broadcast(msg) {
    if (!this.inRoom) return;
    if (this.applyingRemote) return; // don't echo events we just applied
    const payload = JSON.stringify(msg);
    for (const conn of this.connections.values()) {
      try { conn.send(payload); } catch {}
    }
  }

  send(conn, msg) {
    try { conn.send(JSON.stringify(msg)); } catch {}
  }

  // --- Internals ------------------------------------------------------------

  _openPeer(id) {
    return new Promise((resolve, reject) => {
      // Lazy-loaded global from peerjs.min.js (loaded via <script> in index.html).
      const Peer = window.Peer;
      if (!Peer) { reject(new Error('PeerJS not loaded.')); return; }
      const peer = id ? new Peer(id) : new Peer();
      this.peer = peer;
      const cleanup = () => { peer.off('open', onOpen); peer.off('error', onErr); };
      const onOpen = () => { cleanup(); resolve(peer); };
      const onErr  = (e) => { cleanup(); reject(e); };
      peer.once('open', onOpen);
      peer.once('error', onErr);
    });
  }

  _wireConnection(conn) {
    this.connections.set(conn.peer, conn);
    this._emitState();
    conn.on('data', (raw) => this._handleData(conn, raw));
    conn.on('close', () => {
      this.connections.delete(conn.peer);
      if (this.isHost && this._roster.delete(conn.peer)) this._broadcastRoster();
      this._emitState();
      // If the host disappears we leave the room entirely; there's no point
      // sitting alone in an orphaned guest connection.
      if (!this.isHost && this.inRoom && this.connections.size === 0) {
        this._error('The host left the room.');
        this.leave();
      }
    });
    conn.on('error', () => {
      this.connections.delete(conn.peer);
      this._emitState();
    });
  }

  _handleData(conn, raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return; }
    if (!msg || typeof msg !== 'object') return;
    // Roster handshake — handled here, never relayed or dispatched to the app.
    // Guests 'identify' to the host; the host keeps the authoritative roster
    // and pushes it back to everyone as 'roster'.
    if (msg.type === 'identify') {
      if (this.isHost) {
        this._roster.set(conn.peer, (String(msg.name || '').trim().slice(0, 32)) || 'Guest');
        this._broadcastRoster();
      }
      return;
    }
    if (msg.type === 'roster') {
      if (!this.isHost) {
        this._rosterList = Array.isArray(msg.peers) ? msg.peers : [];
        this._emitState();
      }
      return;
    }
    // If we're the host, relay anything from a guest to all other guests
    // so they stay in sync without each guest needing a direct line to
    // every other guest.
    if (this.isHost && msg.type !== 'hello') {
      const fromId = conn.peer;
      const payload = JSON.stringify(msg);
      for (const [id, other] of this.connections.entries()) {
        if (id !== fromId) { try { other.send(payload); } catch {} }
      }
    }
    // Let the app decide what to do with the message (apply to player, etc.).
    this.dispatchEvent(new CustomEvent('message', { detail: { data: msg, from: conn.peer } }));
  }

  _emitState() {
    this.dispatchEvent(new CustomEvent('state', { detail: {
      inRoom: this.inRoom,
      isHost: this.isHost,
      roomCode: this.roomCode,
      peerCount: this.peerCount,
      roster: this.getRoster(),
    }}));
  }

  _error(message) {
    this.dispatchEvent(new CustomEvent('error', { detail: { message }}));
  }
}

export const watchParty = new WatchParty();
export { ROOM_CODE_LENGTH, normalizeRoomCode };
