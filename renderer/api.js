// Piped API client.
// - Anonymous endpoints (trending/search/streams/channel) fail over across instances.
// - Authenticated endpoints (login/feed/subs) are pinned to whatever instance the
//   token was issued by, since accounts are not portable across Piped instances.

// Wider seed list. The live list (refreshInstances() below) replaces this on boot.
let INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.privacydev.net',
  'https://pipedapi.r4fo.com',
  'https://api.piped.private.coffee',
  'https://pipedapi.smnz.de',
  'https://pipedapi.darkness.services',
  'https://pipedapi.us.projectsegfau.lt',
  'https://api.piped.yt',
  'https://piapi.ggtyler.dev',
  'https://pipedapi.drgns.space',
  'https://pipedapi.ducks.party',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.leptons.xyz',
  'https://api-piped.mha.fi',
];

// Pulls the live Piped instance index, filters to instances marked up-to-date,
// and replaces the in-memory list. Best-effort — silently falls back to the seed
// list above if every index source is down.
const INSTANCE_INDEXES = [
  'https://piped-instances.kavin.rocks/',
  'https://worker-instances.piped.workers.dev/',
];

export async function refreshInstances() {
  for (const idx of INSTANCE_INDEXES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(idx, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) continue;
      const live = list
        .filter(i => i.api_url && (i.up_to_date !== false))
        .map(i => i.api_url.replace(/\/$/, ''));
      if (live.length) {
        // Keep the user's active instance first if it's in the live list.
        const ordered = live.includes(activeInstance)
          ? [activeInstance, ...live.filter(u => u !== activeInstance)]
          : live;
        INSTANCES = ordered;
        return INSTANCES;
      }
    } catch {}
  }
  return INSTANCES;
}

let activeInstance = localStorage.getItem('piped-instance') || INSTANCES[0];
let token = localStorage.getItem('piped-token') || null;
let user = null;
try { user = JSON.parse(localStorage.getItem('piped-user') || 'null'); } catch {}

// Synchronously hydrate from the preload-mirrored auth file when localStorage
// is empty (Chromium drops it under some odd conditions). This runs before
// any UI code so the user starts already-signed-in on first paint.
if (!token && window.app?.initialAuth) {
  const a = window.app.initialAuth;
  if (a?.token) {
    token = a.token;
    user  = a.user || null;
    if (a.instance) activeInstance = a.instance;
    try {
      localStorage.setItem('piped-token', token);
      if (user) localStorage.setItem('piped-user', JSON.stringify(user));
      if (activeInstance) localStorage.setItem('piped-instance', activeInstance);
    } catch {}
  }
}

// If the user has a saved session, force-restore their home instance — earlier
// versions of tryFetch could rotate activeInstance away when an anonymous call
// failed over, which silently broke the user's auth (token is per-instance).
// Pin back to the recorded home so the token actually works again.
if (user?.instance && user.instance !== activeInstance) {
  activeInstance = user.instance;
  localStorage.setItem('piped-instance', activeInstance);
}

export function getInstance() { return activeInstance; }
export function setInstance(url) {
  activeInstance = url;
  localStorage.setItem('piped-instance', url);
}

export function getToken() { return token; }
export function getUser() { return user; }
export function isLoggedIn() { return !!token; }

function setSession(t, u) {
  token = t;
  user = u;
  if (t) localStorage.setItem('piped-token', t); else localStorage.removeItem('piped-token');
  if (u) localStorage.setItem('piped-user', JSON.stringify(u)); else localStorage.removeItem('piped-user');
  // Mirror to file via SYNCHRONOUS preload helper so the session is on disk
  // before this call returns — no race with app shutdown. Falls back to the
  // async IPC handlers if the sync helper isn't loaded.
  if (t && u) {
    const json = JSON.stringify({ token: t, user: u, instance: activeInstance });
    if (window.app?.saveAuthSync) window.app.saveAuthSync(json);
    else if (window.app?.pipedAuth) window.app.pipedAuth.write(json).catch(() => {});
  } else {
    if (window.app?.clearAuthSync) window.app.clearAuthSync();
    else if (window.app?.pipedAuth) window.app.pipedAuth.clear().catch(() => {});
  }
}

export function logout() { setSession(null, null); subsCache = null; }

// Boot-time recovery: if localStorage doesn't have a token but the on-disk
// file does, restore the session from the file. Async because IPC is async.
async function rehydrateAuthFromFile() {
  if (!window.app?.pipedAuth) return;
  if (token) return; // already loaded from localStorage — nothing to do
  try {
    const json = await window.app.pipedAuth.read();
    if (!json) return;
    const parsed = JSON.parse(json);
    if (!parsed?.token) return;
    token = parsed.token;
    user  = parsed.user || null;
    if (parsed.instance) activeInstance = parsed.instance;
    localStorage.setItem('piped-token', token);
    if (user) localStorage.setItem('piped-user', JSON.stringify(user));
    if (activeInstance) localStorage.setItem('piped-instance', activeInstance);
    // Notify the rest of the app so the topnav account button can refresh.
    window.dispatchEvent(new CustomEvent('piped-auth-restored'));
  } catch {}
}
rehydrateAuthFromFile();

// ---------- Internals ----------
async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 10000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Anonymous: try each instance until one works.
//
// Piped accounts are pinned to a single instance (the one that issued the
// token). If we let anonymous failover *change* the active instance, the
// user's existing token would suddenly be invalidated against the new home
// — they appear signed out for no reason. So when the user is logged in,
// we use the working instance only for THIS call and keep activeInstance
// untouched. Anonymous users can still rotate as before.
async function tryFetch(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const order = [activeInstance, ...INSTANCES.filter(i => i !== activeInstance)];
  let lastErr;
  for (const inst of order) {
    try {
      const data = await fetchJson(inst + path + qs, { timeout: 8000 });
      if (inst !== activeInstance && !token) setInstance(inst);
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('All Piped instances failed');
}

// Authenticated: pinned to user's instance, no failover.
function authFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = token;
  return fetchJson(activeInstance + path, { ...opts, headers });
}

// ---------- Public API ----------
let subsCache = null;
function invalidateSubsCache() { subsCache = null; }

export const api = {
  trending: (region = 'US') => tryFetch('/trending', { region }),
  search:   (q)             => tryFetch('/search', { q, filter: 'videos' }),
  streams:  (id)            => tryFetch('/streams/' + id),
  channel:  (id)            => tryFetch('/channel/' + id),
  comments: (id)            => tryFetch('/comments/' + id),

  // ---- Auth ----
  // Login is normally pinned to one instance (accounts aren't portable),
  // but if the active instance returns a server-side error (5xx, abort,
  // network), fail over and retry — the user's account either exists on
  // the next instance or it doesn't, which is still more informative than
  // a generic "HTTP 526".
  async login(username, password) {
    const order = [activeInstance, ...INSTANCES.filter(i => i !== activeInstance)];
    let lastErr;
    for (const inst of order) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        const data = await fetchJson(inst + '/login', {
          method: 'POST',
          headers,
          body: JSON.stringify({ username, password }),
          timeout: 8000,
        });
        if (!data?.token) throw new Error('Login failed');
        setInstance(inst);
        setSession(data.token, { username, instance: inst });
        invalidateSubsCache();
        return user;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        // Only fail over on transient/instance faults — not on credential errors.
        const transient = /HTTP 5\d\d/.test(msg) || /aborted/i.test(msg) || /failed to fetch/i.test(msg) || /Network/i.test(msg);
        if (!transient) break;
      }
    }
    throw lastErr ?? new Error('Login failed');
  },

  // Register tries instances in order until one accepts the new account.
  async register(username, password) {
    const order = [activeInstance, ...INSTANCES.filter(i => i !== activeInstance)];
    let lastErr;
    for (const inst of order) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        const data = await fetchJson(inst + '/register', {
          method: 'POST',
          headers,
          body: JSON.stringify({ username, password }),
          timeout: 8000,
        });
        if (!data?.token) throw new Error('Registration failed');
        setInstance(inst);
        setSession(data.token, { username, instance: inst });
        invalidateSubsCache();
        return user;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        // 4xx = real rejection (username taken, weak password) — surface as-is.
        const transient = /HTTP 5\d\d/.test(msg) || /aborted/i.test(msg) || /failed to fetch/i.test(msg) || /Network/i.test(msg);
        if (!transient) break;
      }
    }
    throw lastErr ?? new Error('Registration failed');
  },

  // ---- Subscriptions / feed (logged in) ----
  feed: () => authFetch('/feed?authToken=' + encodeURIComponent(token || '')),

  async subscriptions() {
    if (subsCache) return subsCache;
    subsCache = await authFetch('/subscriptions?authToken=' + encodeURIComponent(token || ''));
    return subsCache;
  },

  async subscribe(channelId) {
    await authFetch('/subscribe', {
      method: 'POST',
      body: JSON.stringify({ channelId }),
    });
    invalidateSubsCache();
  },

  async unsubscribe(channelId) {
    await authFetch('/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ channelId }),
    });
    invalidateSubsCache();
  },

  async isSubscribed(channelId) {
    if (!isLoggedIn()) return false;
    const subs = await api.subscriptions();
    return subs.some(s => (s.url || '').endsWith('/' + channelId) || s.id === channelId);
  },

  async importChannels(channelIds) {
    // Piped's /import endpoint accepts an array of channel IDs.
    return authFetch('/import?override=false', {
      method: 'POST',
      body: JSON.stringify(channelIds),
    });
  },
};

// ---------- Utils ----------
export function videoIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
}

// Accepts a full YouTube URL, a youtu.be link, a /shorts/ link, or a bare 11-char ID.
// Returns the video ID, or null if it's not recognisably a YouTube reference.
export function videoIdFromAny(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const m = u.pathname.match(/^\/([\w-]{11})/);
      if (m) return m[1];
    }
    if (/(^|\.)youtube\.com$/.test(host)) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

export function nextInstance() {
  const i = INSTANCES.indexOf(activeInstance);
  const next = INSTANCES[(i + 1) % INSTANCES.length];
  setInstance(next);
  return next;
}

export function getInstances() { return INSTANCES; }

export function channelIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/channel\/([\w-]+)/);
  return m ? m[1] : null;
}

export function fmtNumber(n) {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1e6)  return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9)  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
}

export function fmtViews(n) {
  if (n == null) return '';
  return fmtNumber(n) + ' views';
}

export function fmtDuration(s) {
  if (!s || s < 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtRelative(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60)        return 'just now';
  if (diff < 3600)      return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400)     return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800)    return Math.floor(diff / 86400) + 'd ago';
  if (diff < 2592000)   return Math.floor(diff / 604800) + 'w ago';
  if (diff < 31536000)  return Math.floor(diff / 2592000) + 'mo ago';
  return Math.floor(diff / 31536000) + 'y ago';
}

// ---------- Takeout parsers ----------
// Google Takeout exports YouTube subscriptions as either CSV or JSON.
// We extract the channel IDs (UC...) from whichever format the user picks.
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

export function parseTakeoutCsv(text) {
  const out = new Set();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    // Naive CSV split — Takeout doesn't quote channel IDs/URLs.
    const cols = lines[i].split(',');
    for (const col of cols) {
      const v = col.trim();
      if (CHANNEL_ID_RE.test(v)) { out.add(v); continue; }
      const m = v.match(/\/channel\/(UC[\w-]{22})/);
      if (m) out.add(m[1]);
    }
  }
  return [...out];
}

export function parseTakeoutJson(text) {
  const data = JSON.parse(text);
  const out = new Set();
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (typeof val === 'string' && CHANNEL_ID_RE.test(val)) out.add(val);
      else if (typeof val === 'string') {
        const m = val.match(/\/channel\/(UC[\w-]{22})/);
        if (m) out.add(m[1]);
      } else visit(val);
    }
  };
  visit(data);
  return [...out];
}
