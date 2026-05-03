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
  // Sync save methods — the file is on disk before the call returns, so
  // closing the app immediately after changing a setting can't lose it.
  saveSettingsSync: (json) => writeJsonSync(settingsFile, json),
  saveAuthSync:     (json) => writeJsonSync(authFile, json),
  clearAuthSync:    () => clearFileSync(authFile),
  saveStateSync:    (json) => writeJsonSync(stateFile, json),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setWindowOpacity: (v) => ipcRenderer.invoke('window:set-opacity', v),
  setWindowMaterial: (m) => ipcRenderer.invoke('window:set-material', m),
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
