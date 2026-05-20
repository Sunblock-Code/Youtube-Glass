const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Read the on-disk settings + auth backup *synchronously* in the preload so
// the renderer can apply them on its first tick — no FOUC where the default
// purple theme paints, then snaps to whatever the user actually picked.
function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function userDataDir() {
  // Replicates Electron's app.getPath('userData') for Windows so we don't
  // need to await the main process from preload.
  const appName = 'youtube-glass';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}
const _initialSettings = readJsonSync(path.join(userDataDir(), 'glass-settings.json'));
const _initialAuth     = readJsonSync(path.join(userDataDir(), 'glass-piped-auth.json'));
const _initialState    = readJsonSync(path.join(userDataDir(), 'glass-state.json'));

// Theme palette mirrored from renderer/app.js so we can pre-resolve the
// active theme's CSS variables HERE (synchronously, before any paint) and
// hand them to the inline boot script in index.html. Without this, there's
// a flash of the default purple theme between first paint and when the
// async-ish renderer module finally runs applySettings().
const _THEMES = {
  purple:    { accent: '#c084fc', accentSoft: 'rgba(192,132,252,0.18)', blob1: '#8b5cf6', blob2: '#ec4899', blob3: '#3b82f6', bg: '#0a0612' },
  blue:      { accent: '#60a5fa', accentSoft: 'rgba(96,165,250,0.18)',  blob1: '#3b82f6', blob2: '#06b6d4', blob3: '#0ea5e9', bg: '#040a18' },
  pink:      { accent: '#f472b6', accentSoft: 'rgba(244,114,182,0.18)', blob1: '#ec4899', blob2: '#f43f5e', blob3: '#a855f7', bg: '#10060e' },
  green:     { accent: '#4ade80', accentSoft: 'rgba(74,222,128,0.18)',  blob1: '#10b981', blob2: '#14b8a6', blob3: '#84cc16', bg: '#040c08' },
  mono:      { accent: '#d1d5db', accentSoft: 'rgba(209,213,219,0.18)', blob1: '#6b7280', blob2: '#4b5563', blob3: '#9ca3af', bg: '#0c0c0e' },
  sunset:    { accent: '#fb923c', accentSoft: 'rgba(251,146,60,0.18)',  blob1: '#f97316', blob2: '#ef4444', blob3: '#fbbf24', bg: '#100806' },
  ocean:     { accent: '#22d3ee', accentSoft: 'rgba(34,211,238,0.18)',  blob1: '#0ea5e9', blob2: '#0891b2', blob3: '#1e40af', bg: '#020812' },
  synthwave: { accent: '#f0abfc', accentSoft: 'rgba(240,171,252,0.18)', blob1: '#a855f7', blob2: '#ec4899', blob3: '#22d3ee', bg: '#0a061a' },
  aurora:    { accent: '#a3e635', accentSoft: 'rgba(163,230,53,0.18)',  blob1: '#10b981', blob2: '#14b8a6', blob3: '#a855f7', bg: '#040a0a' },
  lava:      { accent: '#fb7185', accentSoft: 'rgba(251,113,133,0.18)', blob1: '#dc2626', blob2: '#f97316', blob3: '#7c2d12', bg: '#10060a' },
  cyberpunk: { accent: '#fde047', accentSoft: 'rgba(253,224,71,0.18)',  blob1: '#f43f5e', blob2: '#22d3ee', blob3: '#facc15', bg: '#0c0410' },
};
const _themeKey = (_initialSettings && _initialSettings.theme) || 'purple';
const _initialTheme = _THEMES[_themeKey] || _THEMES.purple;
// Pre-resolved attrs for early paint — bgmode/material/etc. We mirror just
// the ones that meaningfully affect the first-paint layout/colour.
const _initialAttrs = {
  theme:    _themeKey,
  bgmode:   _initialSettings && ['solid', 'acrylic'].includes(_initialSettings.bgMode) ? _initialSettings.bgMode : 'gradient',
  material: (_initialSettings && _initialSettings.material) || 'none',
  motion:   (_initialSettings && _initialSettings.motion) || 'subtle',
};
// Pre-resolved sign-in display name so the account button can paint with
// the right label on first frame instead of "Sign in" → flash → username.
// Auth file shape is { token, user: { username, instance }, instance }
// — the username lives one level deeper than I first wrote, so we have
// to dig into `user.username` rather than treating `user` as a string.
const _initialDisplayName = (() => {
  // The user's custom topnav name wins over the raw Piped username. It's
  // mirrored into glass-state.json under 'piped-display-name' (STATE_KEYS
  // snapshot), which we've already read into _initialState. Without this,
  // boot.js painted the auth username on first frame and overwrote the
  // custom name app.js had just set — so it only "took" after a manual Save.
  const custom = _initialState && typeof _initialState['piped-display-name'] === 'string'
    ? _initialState['piped-display-name'].trim() : '';
  if (custom) return custom;
  if (!_initialAuth || !_initialAuth.token) return null;
  const u = _initialAuth.user;
  if (typeof u === 'string') return u;
  if (u && typeof u === 'object') return u.username || u.name || null;
  return null;
})();

// Synchronous on-disk write helpers. We use the Node fs API in the preload
// context (full Node access) so saves can't race with app shutdown — every
// `save*` call returns only after the file is fully flushed.
function writeJsonSync(file, json) {
  try {
    if (typeof json !== 'string') return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json, 'utf8');
    return true;
  } catch (e) {
    console.warn('[preload] sync write failed', file, e?.message);
    return false;
  }
}
function clearFileSync(file) {
  try { fs.unlinkSync(file); } catch {}
}
const settingsFile = path.join(userDataDir(), 'glass-settings.json');
const authFile     = path.join(userDataDir(), 'glass-piped-auth.json');
const stateFile    = path.join(userDataDir(), 'glass-state.json');

contextBridge.exposeInMainWorld('app', {
  // Synchronously-loaded settings + auth + general state, available the
  // moment the renderer boots. null if the file didn't exist or was unreadable.
  initialSettings: _initialSettings,
  initialAuth:     _initialAuth,
  initialState:    _initialState,
  // Pre-resolved theme palette + boot-time HTML attrs + sign-in label.
  // Read by the inline boot script in index.html so the first paint shows
  // the user's actual theme/material/login state, not the defaults.
  initialTheme:    _initialTheme,
  initialAttrs:    _initialAttrs,
  initialDisplayName: _initialDisplayName,
  // Sync save methods — the file is on disk before the call returns, so
  // closing the app immediately after changing a setting can't lose it.
  saveSettingsSync: (json) => writeJsonSync(settingsFile, json),
  saveAuthSync:     (json) => writeJsonSync(authFile, json),
  clearAuthSync:    () => clearFileSync(authFile),
  saveStateSync:    (json) => writeJsonSync(stateFile, json),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setWindowOpacity: (v) => ipcRenderer.invoke('window:set-opacity', v),
  setWindowMaterial: (m) => ipcRenderer.invoke('window:set-material', m),
  // Whether the window was CREATED transparent this launch — true for BOTH
  // Clear and Acrylic (both need the transparent window; acrylic's OS
  // material only renders on it). main.js reads the same settings file at
  // startup so this matches what it did; the renderer compares it to the
  // current bgMode to know when a restart is needed (crossing in/out of a
  // see-through mode, since window transparency is fixed at creation).
  launchedTransparent: !!(_initialSettings && ['clear', 'acrylic', 'mica', 'gaussian'].includes(_initialSettings.bgMode)),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  maximize:       () => ipcRenderer.invoke('window:maximize'),
  unmaximize:     () => ipcRenderer.invoke('window:unmaximize'),
  settingsRead:   () => ipcRenderer.invoke('settings:read'),
  settingsWrite:  (json) => ipcRenderer.invoke('settings:write', json),
  pipedAuth: {
    read:  () => ipcRenderer.invoke('piped-auth:read'),
    write: (json) => ipcRenderer.invoke('piped-auth:write', json),
    clear: () => ipcRenderer.invoke('piped-auth:clear'),
  },
  download: {
    defaultDir: () => ipcRenderer.invoke('download:default-dir'),
    pickDir:    (current) => ipcRenderer.invoke('download:pick-dir', current),
  },
  configurePullout: (cfg) => ipcRenderer.invoke('pullout:configure', cfg),
  ytdlp: {
    status: () => ipcRenderer.invoke('ytdlp:status'),
    install: () => ipcRenderer.invoke('ytdlp:install'),
    getVideo: (videoId) => ipcRenderer.invoke('ytdlp:get-video', videoId),
    getChannelVideos: (channelId, limit) => ipcRenderer.invoke('ytdlp:get-channel-videos', channelId, limit),
    download: (videoId, opts) => ipcRenderer.invoke('ytdlp:download', videoId, opts),
    onInstallProgress: (cb) => {
      const handler = (_e, p) => cb(p);
      ipcRenderer.on('ytdlp:install-progress', handler);
      return () => ipcRenderer.removeListener('ytdlp:install-progress', handler);
    },
    onDownloadProgress: (cb) => {
      const handler = (_e, p) => cb(p);
      ipcRenderer.on('ytdlp:download-progress', handler);
      return () => ipcRenderer.removeListener('ytdlp:download-progress', handler);
    },
  },
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),
  google: {
    status:          ()  => ipcRenderer.invoke('google:status'),
    getClientId:     ()  => ipcRenderer.invoke('google:get-client-id'),
    getClientSecret: ()  => ipcRenderer.invoke('google:get-client-secret'),
    setCredentials:  (c) => ipcRenderer.invoke('google:set-credentials', c),
    signIn:          ()  => ipcRenderer.invoke('google:sign-in'),
    cancelSignIn:    ()  => ipcRenderer.invoke('google:cancel-sign-in'),
    signOut:         ()  => ipcRenderer.invoke('google:sign-out'),
    fetchSubs:       ()  => ipcRenderer.invoke('google:fetch-subs'),
    postComment:     (videoId, text) => ipcRenderer.invoke('google:post-comment', { videoId, text }),
  },
});
