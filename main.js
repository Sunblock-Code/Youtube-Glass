const { app, BrowserWindow, session, shell, ipcMain, globalShortcut, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { setupAdblock } = require('./adblock');
const ytdlp = require('./ytdlp');
const auth = require('./auth');

// Electron's `transparent` is fixed at window-creation time — it can't be
// toggled live. The "Clear glass" background mode needs a genuinely
// transparent window, so we read the persisted bgMode synchronously BEFORE
// creating the window and recreate (via app relaunch) when the user switches
// in/out of clear mode. We read the same file the renderer actually writes
// through preload's saveSettingsSync (%APPDATA%/youtube-glass on Windows).
function readPersistedSettings() {
  try {
    const base = process.platform === 'win32'
      ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
    return JSON.parse(fs.readFileSync(path.join(base, 'youtube-glass', 'glass-settings.json'), 'utf8'));
  } catch { return null; }
}
// BOTH "Clear glass" and "Acrylic" need a genuinely transparent window.
// Empirically (user-confirmed): setBackgroundMaterial('acrylic') only
// actually renders the frosted desktop when the window is transparent —
// it did nothing on a non-transparent window and "broke after restart".
// So: transparent for clear OR acrylic. Clear uses no OS material (sharp
// desktop); Acrylic adds setBackgroundMaterial('acrylic') on top of the
// transparent window (real OS frost). Transparency is creation-time, so
// switching in/out of either mode needs a restart.
const SEE_THROUGH_MODES = ['clear', 'acrylic', 'mica', 'gaussian'];
const launchedTransparent = (() => {
  const s = readPersistedSettings();
  return !!(s && SEE_THROUGH_MODES.includes(s.bgMode));
})();

// Tell Windows this is a distinct app (separate from generic Electron) so the
// taskbar can group/pin it correctly with the Glass icon. Must be set early —
// before BrowserWindow creation. The string is an "AppUserModelID".
app.setAppUserModelId('com.glass.youtube');

// Set the runtime name so the Windows Volume Mixer shows "Glass" instead of
// "Electron" / "youtube-glass". The Volume Mixer reads the display name from
// the process that owns the audio session — see disable-features below.
app.setName('Glass');

// Chromium runs audio out-of-process by default ("Audio Service"), which means
// the audio session in Volume Mixer belongs to an anonymous helper rather
// than our main process. Disabling that feature folds the audio session into
// the main process so it picks up the AppUserModelId / app name set above
// and shows up as "Glass" in the mixer. Must be called before app.whenReady.
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');

let mainWindow;

function createWindow() {
  const iconIco = path.join(__dirname, 'assets', 'icon.ico');
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const iconPath = require('fs').existsSync(iconIco) ? iconIco
    : (require('fs').existsSync(iconPng) ? iconPng : undefined);

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    // Transparent for BOTH Clear and Acrylic (acrylic's OS material only
    // renders on a transparent window — confirmed by the user). Clear has
    // no material (sharp); Acrylic adds setBackgroundMaterial on top.
    transparent: launchedTransparent,
    backgroundColor: launchedTransparent ? '#00000000' : '#1a0d2e',
    icon: iconPath,
    // Frameless: the titlebar is hidden and we draw our OWN min/max/close
    // buttons (.window-controls) so they match the app's rounded-glass icon
    // style instead of the native OS look. No titleBarOverlay → no native
    // caption buttons. The window stays resizable and draggable (the titlebar
    // is a -webkit-app-region: drag surface in styles.css).
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep the renderer running at full speed when the window is hidden
      // or off-screen. The pull-out feature (Alt+T) slides the window away
      // and calls mainWindow.hide() — by default Chromium throttles hidden
      // renderers, which suspends audio playback and stalls the player.js
      // audio-sync drift loop. Disabling background throttling lets audio
      // keep playing while the window is tucked away and keeps A/V aligned.
      backgroundThrottling: false,
    },
  });

  // Tell the renderer when the OS maximize state flips (e.g. via double-click
  // on the drag region, Win+Up, or snap) so the custom maximize/restore button
  // can swap its glyph to match.
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximize-changed', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  setupAdblock(session.defaultSession);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('window:set-opacity', (_e, value) => {
  if (typeof value !== 'number' || !isFinite(value)) return;
  const v = Math.min(1, Math.max(0.2, value));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setOpacity(v);
});

// --- Download directory helpers ---
ipcMain.handle('download:default-dir', () => {
  return path.join(app.getPath('downloads'), 'YouTube');
});
ipcMain.handle('download:pick-dir', async (_e, current) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose download folder',
    defaultPath: current || path.join(app.getPath('downloads'), 'YouTube'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

// --- Persistent settings backup ---
// localStorage normally holds glass settings, but Chromium can drop it under
// some odd conditions (transparent-window flips, force-kill before flush).
// Mirroring saves to a JSON file under userData gives us a deterministic
// fallback that survives those edge cases.
const fsp = require('fs').promises;
const settingsFilePath = () => path.join(app.getPath('userData'), 'glass-settings.json');
ipcMain.handle('settings:read', async () => {
  try {
    return await fsp.readFile(settingsFilePath(), 'utf8');
  } catch {
    return null;
  }
});
ipcMain.handle('settings:write', async (_e, json) => {
  try {
    if (typeof json !== 'string') return { ok: false, error: 'expected string' };
    await fsp.writeFile(settingsFilePath(), json, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Piped auth (token / user / instance) — same pattern as settings, separate
// file so corrupt settings never invalidate the user's session.
const authFilePath = () => path.join(app.getPath('userData'), 'glass-piped-auth.json');
ipcMain.handle('piped-auth:read', async () => {
  try { return await fsp.readFile(authFilePath(), 'utf8'); } catch { return null; }
});
ipcMain.handle('piped-auth:write', async (_e, json) => {
  try {
    if (typeof json !== 'string') return { ok: false, error: 'expected string' };
    await fsp.writeFile(authFilePath(), json, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('piped-auth:clear', async () => {
  try { await fsp.unlink(authFilePath()); } catch { /* ignore missing */ }
  return { ok: true };
});

// Generic app state backup — dashboard, widgets, history, resume points,
// local subs. Anything that lives in localStorage and would be painful to
// lose if Chromium drops the storage backend.
const stateFilePath = () => path.join(app.getPath('userData'), 'glass-state.json');
ipcMain.handle('state:read', async () => {
  try { return await fsp.readFile(stateFilePath(), 'utf8'); } catch { return null; }
});
ipcMain.handle('state:write', async (_e, json) => {
  try {
    if (typeof json !== 'string') return { ok: false, error: 'expected string' };
    await fsp.writeFile(stateFilePath(), json, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:maximize',   () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.maximize(); });
ipcMain.handle('window:unmaximize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.unmaximize(); });
ipcMain.handle('window:minimize',   () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
ipcMain.handle('window:close',      () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });

// Windows 11 only — Mica / Acrylic / Tabbed material on the window background.
// Silently no-ops on other OSes / older Windows.
ipcMain.handle('window:set-material', (_e, material) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: true };
  const allowed = ['none', 'mica', 'acrylic', 'tabbed', 'auto'];
  const m = allowed.includes(material) ? material : 'none';
  try {
    if (typeof mainWindow.setBackgroundMaterial === 'function') {
      mainWindow.setBackgroundMaterial(m);
    }
    // Keep the window background transparent when the window itself was
    // launched transparent (Clear) OR a material is active (Acrylic/Mica —
    // the OS material needs a #00000000 backgroundColor to show the frosted
    // desktop). Only fall back to opaque when there's no see-through at all.
    if (typeof mainWindow.setBackgroundColor === 'function') {
      const keepClear = launchedTransparent || m !== 'none';
      mainWindow.setBackgroundColor(keepClear ? '#00000000' : '#0a0612');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Relaunch the app — used when the user toggles Clear-glass mode, since
// `transparent` can only be set at window creation.
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// ---- Pull-out / slide window ----
const pullout = {
  registered: null, // currently-registered accelerator
  cfg: { enabled: false, side: 'right', width: 45, hotkey: 'Alt+T' },
  state: 'docked', // 'docked' | 'hidden' | 'animating'
};

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function getDockGeometry() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  const w = Math.max(240, Math.round(wa.width * (pullout.cfg.width / 100)));
  const dockedX = pullout.cfg.side === 'left' ? wa.x : wa.x + wa.width - w;
  const hiddenX = pullout.cfg.side === 'left' ? wa.x - w : wa.x + wa.width;
  return { w, h: wa.height, y: wa.y, dockedX, hiddenX };
}

function animateBounds(fromX, toX, geom) {
  return new Promise(resolve => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve();
    const start = Date.now();
    const duration = 220;
    const tick = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return resolve();
      const t = Math.min(1, (Date.now() - start) / duration);
      const x = Math.round(fromX + (toX - fromX) * easeOutCubic(t));
      mainWindow.setBounds({ x, y: geom.y, width: geom.w, height: geom.h });
      if (t < 1) setTimeout(tick, 8);
      else resolve();
    };
    tick();
  });
}

async function slideIn() {
  if (!mainWindow || mainWindow.isDestroyed() || pullout.state === 'animating') return;
  pullout.state = 'animating';
  const g = getDockGeometry();
  if (!mainWindow.isVisible()) {
    mainWindow.setBounds({ x: g.hiddenX, y: g.y, width: g.w, height: g.h });
    mainWindow.showInactive();
  }
  mainWindow.show();
  mainWindow.focus();
  await animateBounds(g.hiddenX, g.dockedX, g);
  pullout.state = 'docked';
}

async function slideOut() {
  if (!mainWindow || mainWindow.isDestroyed() || pullout.state === 'animating') return;
  pullout.state = 'animating';
  const g = getDockGeometry();
  const cur = mainWindow.getBounds();
  await animateBounds(cur.x, g.hiddenX, g);
  mainWindow.hide();
  pullout.state = 'hidden';
}

function togglePullout() {
  if (pullout.state === 'hidden') slideIn();
  else slideOut();
}

function applyPulloutConfig(cfg) {
  pullout.cfg = { ...pullout.cfg, ...cfg };
  if (pullout.registered) {
    globalShortcut.unregister(pullout.registered);
    pullout.registered = null;
  }
  if (!pullout.cfg.enabled || !pullout.cfg.hotkey) return { ok: true };
  try {
    const ok = globalShortcut.register(pullout.cfg.hotkey, togglePullout);
    if (!ok) return { ok: false, error: `Couldn't register hotkey ${pullout.cfg.hotkey} (taken by another app?)` };
    pullout.registered = pullout.cfg.hotkey;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('pullout:configure', (_e, cfg) => applyPulloutConfig(cfg || {}));

ipcMain.handle('ytdlp:status', () => ({
  installed: ytdlp.isInstalled(),
  path: ytdlp.binPath(),
}));

ipcMain.handle('ytdlp:install', async (event) => {
  try {
    await ytdlp.install(({ received, total }) => {
      try { event.sender.send('ytdlp:install-progress', { received, total }); } catch {}
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ytdlp:get-video', async (_e, videoId) => {
  try {
    const data = await ytdlp.getVideo(videoId);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ytdlp:get-channel-videos', async (_e, channelId, limit) => {
  try {
    const items = await ytdlp.getChannelVideos(channelId, limit);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ytdlp:get-related', async (_e, videoId, limit) => {
  try {
    const items = await ytdlp.getRelated(videoId, limit);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ytdlp:download', async (event, videoId, opts) => {
  try {
    const result = await ytdlp.downloadVideo(videoId, opts || {}, (p) => {
      try { event.sender.send('ytdlp:download-progress', p); } catch {}
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

const { shell: electronShell } = require('electron');
ipcMain.handle('shell:show-in-folder', (_e, fullPath) => {
  if (typeof fullPath === 'string' && fullPath.length) {
    try { electronShell.showItemInFolder(fullPath); } catch {}
  }
});

// ---- Google OAuth ----
ipcMain.handle('google:status',            ()       => auth.status());
ipcMain.handle('google:get-client-id',     ()       => auth.getClientId());
ipcMain.handle('google:get-client-secret', ()       => auth.getClientSecret());
ipcMain.handle('google:set-credentials',   (_e, c)  => {
  if (!c?.clientId || !c?.clientSecret) return { ok: false, error: 'Missing client ID or secret' };
  auth.setClientId(String(c.clientId).trim());
  auth.setClientSecret(String(c.clientSecret).trim());
  return { ok: true };
});
ipcMain.handle('google:sign-in', async () => {
  try { await auth.signIn(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('google:cancel-sign-in', () => { auth.cancelSignIn(); });
ipcMain.handle('google:sign-out',       async () => { await auth.signOut(); return { ok: true }; });
ipcMain.handle('google:fetch-subs', async () => {
  try { return { ok: true, subs: await auth.fetchSubscriptions() }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('google:post-comment', async (_e, payload) => {
  try {
    const comment = await auth.postComment(payload?.videoId, payload?.text);
    return { ok: true, comment };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
