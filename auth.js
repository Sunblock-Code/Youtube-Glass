// Google OAuth (PKCE) for desktop. Sign-in happens in the user's default
// browser (Google blocks embedded webviews as "disallowed_useragent"). A
// short-lived loopback HTTP server on 127.0.0.1 catches the redirect.
//
// Tokens + the user-supplied OAuth client ID live in userData/google-auth.json.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

// readonly: subscriptions/lists. force-ssl: write actions (comments, likes, etc).
// Existing readonly-only tokens still work for fetching subs; posting a comment
// will return 403 until the user signs in again to grant the write scope.
const SCOPE = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YT_API = 'https://www.googleapis.com/youtube/v3';

// ---------- Persistence ----------
function configFile() {
  return path.join(app.getPath('userData'), 'google-auth.json');
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); }
  catch { return {}; }
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

function getClientId() { return readConfig().clientId || null; }
function setClientId(id) {
  const c = readConfig();
  c.clientId = id;
  writeConfig(c);
}

function getClientSecret() { return readConfig().clientSecret || null; }
function setClientSecret(s) {
  const c = readConfig();
  c.clientSecret = s;
  writeConfig(c);
}

function getTokens() { return readConfig().tokens || null; }
function setTokens(t) {
  const c = readConfig();
  c.tokens = t;
  writeConfig(c);
}
function clearTokens() {
  const c = readConfig();
  delete c.tokens;
  writeConfig(c);
}

function status() {
  return {
    hasClientId: !!getClientId(),
    hasClientSecret: !!getClientSecret(),
    signedIn: !!getTokens(),
  };
}

// ---------- PKCE ----------
function b64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makePKCE() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ---------- Loopback server ----------
const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Glass</title><style>
body{margin:0;background:linear-gradient(135deg,#0a0612,#1a0a3e);color:#ece6ff;font-family:Segoe UI,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}
.card{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:20px;
padding:48px 56px;backdrop-filter:blur(40px)}
h1{font-size:28px;margin:0 0 8px;background:linear-gradient(135deg,#c084fc,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p{color:#9b94b3;margin:0}
</style></head><body><div class="card"><h1>Signed in</h1><p>You can close this tab and return to Glass.</p>
<script>setTimeout(()=>window.close(),900)</script></div></body></html>`;

const ERROR_HTML = (e) => `<!doctype html><html><body style="background:#0a0612;color:#fbcfe8;font-family:sans-serif;padding:60px;text-align:center">
<h2>Sign-in error</h2><p>${e}</p><p>You can close this tab.</p></body></html>`;

let activeServer = null;
let activeReject = null;

function startLoopback() {
  return new Promise((resolveBound, rejectBound) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
    activeReject = rejectCode;

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(error));
        rejectCode(new Error(error));
      } else if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        resolveCode(code);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Glass: unexpected callback');
      }
    });

    server.on('error', rejectBound);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      activeServer = server;
      resolveBound({ port, codePromise, server });
    });
  });
}

function stopLoopback() {
  if (activeReject) { try { activeReject(new Error('Sign-in cancelled')); } catch {} activeReject = null; }
  if (activeServer) { try { activeServer.close(); } catch {} activeServer = null; }
}

// ---------- Sign-in ----------
async function signIn() {
  const clientId = getClientId();
  if (!clientId) throw new Error('No OAuth Client ID configured. Run setup first.');

  stopLoopback(); // belt-and-suspenders
  const { port, codePromise, server } = await startLoopback();
  const redirectUri = `http://127.0.0.1:${port}/`;
  const { verifier, challenge } = makePKCE();

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  shell.openExternal(authUrl.toString());

  let code;
  try {
    code = await Promise.race([
      codePromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Sign-in timed out (5 min)')), 5 * 60 * 1000)),
    ]);
  } finally {
    setTimeout(() => server.close(), 500);
    if (activeServer === server) activeServer = null;
  }

  // Exchange code for tokens. Google's Desktop OAuth flow requires the
  // client_secret field even though PKCE makes it unnecessary in spec.
  const clientSecret = getClientSecret();
  const tokenBody = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  };
  if (clientSecret) tokenBody.client_secret = clientSecret;
  const body = new URLSearchParams(tokenBody);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: HTTP ${res.status} — ${text}`);
  }
  const tokens = await res.json();
  tokens.expires_at = Date.now() + (tokens.expires_in * 1000) - 60_000;
  setTokens(tokens);
  return true;
}

function cancelSignIn() {
  stopLoopback();
}

// ---------- Token refresh ----------
async function getAccessToken() {
  let tokens = getTokens();
  if (!tokens) throw new Error('Not signed in');
  if (Date.now() < (tokens.expires_at || 0)) return tokens.access_token;

  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const refreshBody = {
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  };
  if (clientSecret) refreshBody.client_secret = clientSecret;
  const body = new URLSearchParams(refreshBody);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      clearTokens();
      throw new Error('Refresh token expired — please sign in again');
    }
    throw new Error(`Token refresh failed: HTTP ${res.status}`);
  }
  const fresh = await res.json();
  fresh.refresh_token = fresh.refresh_token || tokens.refresh_token;
  fresh.expires_at = Date.now() + (fresh.expires_in * 1000) - 60_000;
  setTokens(fresh);
  return fresh.access_token;
}

// ---------- Sign out ----------
async function signOut() {
  const tokens = getTokens();
  if (tokens?.access_token) {
    try {
      await fetch(REVOKE_URL + '?token=' + encodeURIComponent(tokens.access_token), { method: 'POST' });
    } catch {}
  }
  clearTokens();
}

// ---------- Subscriptions ----------
async function fetchSubscriptions() {
  const token = await getAccessToken();
  const channels = [];
  let pageToken = null;

  do {
    const url = new URL(YT_API + '/subscriptions');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('order', 'alphabetical');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`YouTube API: HTTP ${res.status} — ${text}`);
    }
    const data = await res.json();
    for (const item of data.items || []) {
      const id = item.snippet?.resourceId?.channelId;
      const name = item.snippet?.title;
      if (id) channels.push({ id, name });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return channels;
}

// ---------- Comments ----------
async function postComment(videoId, text) {
  if (!videoId) throw new Error('Missing videoId');
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Comment is empty');
  const token = await getAccessToken();
  const url = new URL(YT_API + '/commentThreads');
  url.searchParams.set('part', 'snippet');
  const body = {
    snippet: {
      videoId,
      topLevelComment: { snippet: { textOriginal: trimmed } },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch {}
    const msg = parsed?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${msg} — your sign-in may be missing the comment scope. Sign out and sign back in to grant it.`
      );
    }
    throw new Error(msg);
  }
  const data = await res.json();
  return {
    id: data.id,
    text: data.snippet?.topLevelComment?.snippet?.textDisplay || trimmed,
    author: data.snippet?.topLevelComment?.snippet?.authorDisplayName,
    avatar: data.snippet?.topLevelComment?.snippet?.authorProfileImageUrl,
    publishedAt: data.snippet?.topLevelComment?.snippet?.publishedAt,
  };
}

module.exports = {
  status,
  getClientId, setClientId,
  getClientSecret, setClientSecret,
  signIn, signOut, cancelSignIn,
  fetchSubscriptions,
  postComment,
};
