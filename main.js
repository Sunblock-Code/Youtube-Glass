const { app, BrowserWindow, WebContentsView, session, shell, ipcMain, globalShortcut, screen, dialog } = require('electron');
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
  // Also transparent when the user has rounded corners on: the window must be
  // transparent so the rounded-off corner notches reveal the desktop instead
  // of square window-background fringe (works in opaque gradient/solid modes
  // too). Transparency is fixed at creation, so toggling either needs a
  // restart — the settings UI prompts for it.
  return !!(s && (SEE_THROUGH_MODES.includes(s.bgMode) || s.roundedCorners));
})();

// --- Native window corner rounding (Windows) ------------------------------
// CSS border-radius can't round the window when the acrylic/mica MATERIAL is
// active: Windows paints that frosted material across the full SQUARE window
// rect, behind the web content, where CSS can't reach. DWM's corner rounding
// (DWMWA_WINDOW_CORNER_PREFERENCE) is ALSO out — it's silently ignored on
// LAYERED windows, and acrylic forces this window transparent => layered.
// What DOES work on a layered window is a GDI region clip: SetWindowRgn with a
// round-rect region clips the whole window — web content AND the frosted
// material — to the rounded shape. Trade-off: GDI regions have no
// anti-aliasing, so the corners are slightly stair-stepped. Bound with koffi
// (prebuilt FFI, no native compile). Unavailable off-Windows / if koffi fails
// to load, in which case the CSS fallback in styles.css takes over.
let _rgn = null;
try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    _rgn = {
      koffi,
      SetWindowRgn: user32.func('int __stdcall SetWindowRgn(void *hWnd, void *hRgn, bool bRedraw)'),
      CreateRoundRectRgn: gdi32.func('void* __stdcall CreateRoundRectRgn(int x1, int y1, int x2, int y2, int wEllipse, int hEllipse)'),
    };
  }
} catch { _rgn = null; }
const nativeRoundingAvailable = !!_rgn;
const CORNER_RADIUS_DIP = 14; // matches the card / channel-row radius

// Mirrors the renderer's roundedCorners setting; seeded from disk so the very
// first paint is correct, then kept live via the window:set-rounded IPC.
let wantRoundedCorners = !!((readPersistedSettings() || {}).roundedCorners);

// Clip the window to a rounded-rect region (or clear it for a square window).
// Squared off while maximized (a maximized rounded window would notch the
// screen corners). The region is in PHYSICAL pixels, so scale by the display's
// scaleFactor. Returns true when the native call succeeds.
function applyWindowCorners() {
  if (!nativeRoundingAvailable || !mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const hwnd = _rgn.koffi.decode(mainWindow.getNativeWindowHandle(), 'void *');
    const round = wantRoundedCorners && !mainWindow.isMaximized();
    if (!round) {
      _rgn.SetWindowRgn(hwnd, null, true); // null region => full square window
      return true;
    }
    const [wDip, hDip] = mainWindow.getContentSize();
    const sf = (screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor) || 1;
    const W = Math.round(wDip * sf);
    const H = Math.round(hDip * sf);
    const d = Math.round(CORNER_RADIUS_DIP * sf) * 2; // ellipse axis = 2 * radius
    const region = _rgn.CreateRoundRectRgn(0, 0, W + 1, H + 1, d, d);
    // SetWindowRgn takes ownership of the region on success (and frees the
    // previously-set one), so there's nothing to delete here.
    const ok = _rgn.SetWindowRgn(hwnd, region, true);
    return ok !== 0;
  } catch { return false; }
}

// Tell the renderer whether the OS is handling the corners, so it can drop its
// CSS-radius fallback (which would otherwise double-round against the region clip).
function sendNativeRoundingState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:native-rounding', nativeRoundingAvailable && wantRoundedCorners);
  }
}

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

  // Native rounded corners via SetWindowRgn (see applyWindowCorners above).
  // The region is sized to the window, so re-apply on resize and maximize
  // changes; re-assert on load and tell the renderer to drop its CSS fallback.
  applyWindowCorners();
  mainWindow.on('resize', applyWindowCorners);
  mainWindow.on('maximize', applyWindowCorners);
  mainWindow.on('unmaximize', applyWindowCorners);
  mainWindow.webContents.on('did-finish-load', () => { applyWindowCorners(); sendNativeRoundingState(); });

  // The w2g WebContentsView is a child of this window's contentView, so it's
  // torn down with the window — drop our reference so a recreated window
  // doesn't try to reuse an orphaned view.
  mainWindow.on('closed', () => { w2gView = null; });

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

// ---- Watch2Gether embed (WebContentsView) ----------------------------------
// A docked real web-view (same engine as the main window — plays media where
// the <webview> tag didn't). After every navigation we inject JS into the
// guest to fullscreen the player iframe/video and hide w2g's surrounding UI,
// so the user only sees the video. Scoped to w2g.tv: top-level navigation
// elsewhere and popups are routed to the real browser, keeping this a w2g
// view, not a general embedded browser.
let w2gView = null;
function isW2gHost(u) {
  try { const h = new URL(u).hostname.toLowerCase(); return h === 'w2g.tv' || h.endsWith('.w2g.tv'); }
  catch { return false; }
}
// JS injected into the guest. Finds the player iframe (YouTube/Vimeo/etc.) or
// a raw <video>, walks up its ancestor chain hiding siblings at every level so
// the surrounding w2g UI/chat/ads disappear, then forces the player to fill
// the viewport. A MutationObserver re-runs the logic if w2g rebuilds the DOM
// (it loads the player asynchronously). If there's no player (an unsupported
// source — e.g., a content type w2g can't play natively), an overlay says so.
const W2G_JUST_VIDEO_JS = `
(function () {
  if (window.__glassW2g) return; window.__glassW2g = true;
  // Provider iframes are the ACTUAL player for almost everything w2g plays
  // (YouTube/Vimeo/Dailymotion/SoundCloud/Twitch). w2g also has a stray empty
  // <video> element on the page for sync bookkeeping — we used to grab it
  // first and fullscreen an empty player with no source. Always prefer a
  // real provider iframe; fall back to a <video> ONLY if it has a source AND
  // a meaningful size, to dodge the empty bookkeeping element.
  const PROVIDER_IFRAME_SEL = [
    'iframe[src*="youtube"]', 'iframe[src*="youtube-nocookie"]', 'iframe[src*="youtu.be"]',
    'iframe[src*="vimeo"]', 'iframe[src*="dailymotion"]',
    'iframe[src*="soundcloud"]', 'iframe[src*="twitch"]', 'iframe[src*="player.twitch"]',
  ].join(', ');
  const setImp = (el, prop, val) => { try { el.style.setProperty(prop, val, 'important'); } catch (e) {} };
  function iframeRealSrc(f) {
    const s = f.src || f.getAttribute('data-src') || '';
    return /^https?:\\//.test(s) && !/about:blank/i.test(s) ? s : '';
  }
  function findPlayer() {
    // Tier 1: known provider iframes by host substring (with a real src).
    for (const f of document.querySelectorAll(PROVIDER_IFRAME_SEL)) {
      if (iframeRealSrc(f)) return f;
    }
    // Tier 2: largest iframe on the page with a real src. Catches providers
    // we didn't list explicitly. Skip tiny iframes (ads / trackers).
    let bestIf = null, bestIfArea = 0;
    for (const f of document.querySelectorAll('iframe')) {
      if (!iframeRealSrc(f)) continue;
      const r = f.getBoundingClientRect();
      const a = Math.max(0, r.width) * Math.max(0, r.height);
      if (a < 50000) continue;
      if (a > bestIfArea) { bestIfArea = a; bestIf = f; }
    }
    if (bestIf) return bestIf;
    // Tier 3: largest <video> with a source — skips empty sync placeholders.
    let bestV = null, bestVArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!v.src && !v.currentSrc) continue;
      const r = v.getBoundingClientRect();
      const a = Math.max(0, r.width) * Math.max(0, r.height);
      if (a >= bestVArea) { bestVArea = a; bestV = v; }
    }
    return bestV;
  }
  function styleHost() {
    setImp(document.documentElement, 'background', '#000');
    setImp(document.documentElement, 'margin', '0');
    setImp(document.documentElement, 'padding', '0');
    setImp(document.documentElement, 'overflow', 'hidden');
    setImp(document.body, 'background', '#000');
    setImp(document.body, 'margin', '0');
    setImp(document.body, 'padding', '0');
    setImp(document.body, 'overflow', 'hidden');
  }
  function hideAround(player) {
    let el = player;
    while (el && el !== document.body) {
      const parent = el.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib !== el) setImp(sib, 'display', 'none');
      }
      setImp(parent, 'position', 'static');
      setImp(parent, 'width', '100%');
      setImp(parent, 'height', '100%');
      setImp(parent, 'margin', '0');
      setImp(parent, 'padding', '0');
      setImp(parent, 'background', '#000');
      el = parent;
    }
    setImp(player, 'position', 'fixed');
    setImp(player, 'top', '0');
    setImp(player, 'left', '0');
    setImp(player, 'width', '100vw');
    setImp(player, 'height', '100vh');
    setImp(player, 'border', '0');
    setImp(player, 'margin', '0');
    setImp(player, 'background', '#000');
    setImp(player, 'z-index', '2147483647');
    setImp(player, 'display', 'block');
  }
  function noVideoDebugLine() {
    const ifrs = Array.from(document.querySelectorAll('iframe')).filter(f => iframeRealSrc(f));
    const vids = Array.from(document.querySelectorAll('video')).filter(v => v.src || v.currentSrc);
    const ifrInfo = ifrs.map(f => {
      let host = '?';
      try { host = new URL(iframeRealSrc(f)).hostname.replace(/^www\\./, ''); } catch (e) {}
      const r = f.getBoundingClientRect();
      return host + ' ' + Math.round(r.width) + '\\u00d7' + Math.round(r.height);
    });
    const vidInfo = vids.map(v => {
      const r = v.getBoundingClientRect();
      return Math.round(r.width) + '\\u00d7' + Math.round(r.height);
    });
    return 'iframes(' + ifrs.length + '): ' + (ifrInfo.join('; ') || 'none')
         + ' \\u00b7 videos(' + vids.length + '): ' + (vidInfo.join('; ') || 'none');
  }
  function showNoVideo() {
    const dbgText = noVideoDebugLine();
    let ov = document.getElementById('__glass_no_video');
    if (ov) {
      const dbg = ov.querySelector('.__glass_dbg');
      if (dbg) dbg.textContent = dbgText;
      return;
    }
    ov = document.createElement('div');
    ov.id = '__glass_no_video';
    ov.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;color:#9b94b3;display:flex;flex-direction:column;align-items:center;justify-content:center;font:14px system-ui,sans-serif;text-align:center;padding:24px;z-index:2147483647;gap:10px;';
    const main = document.createElement('div');
    main.textContent = 'No video playing in this room (or the source isn\\u2019t one w2g can play natively).';
    const dbg = document.createElement('div');
    dbg.className = '__glass_dbg';
    dbg.style.cssText = 'font:11px ui-monospace,Consolas,monospace;color:#6b6580;opacity:0.75;';
    dbg.textContent = dbgText;
    ov.append(main, dbg);
    document.body.appendChild(ov);
  }
  function clearNoVideo() {
    const ov = document.getElementById('__glass_no_video');
    if (ov) ov.remove();
  }
  function run() {
    if (!document.body) return;
    styleHost();
    const player = findPlayer();
    if (player) { clearNoVideo(); hideAround(player); }
    else { showNoVideo(); }
  }
  run();
  // w2g often (a) mounts the player AFTER the page loads, and (b) updates an
  // already-existing iframe's src when the host changes the video — that's an
  // ATTRIBUTE mutation, not a childList one — so the observer has to watch
  // attribute changes for src too, not just node additions.
  const obs = new MutationObserver(() => { try { run(); } catch (e) {} });
  obs.observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src', 'data-src'],
  });
})();
`;
function destroyW2gView() {
  if (!w2gView) return;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(w2gView); } catch {}
  try { w2gView.webContents.destroy(); } catch {}
  w2gView = null;
}
ipcMain.handle('w2g:open', (_e, url, mode) => {
  if (!mainWindow || mainWindow.isDestroyed() || !isW2gHost(url)) return false;
  if (!w2gView) {
    w2gView = new WebContentsView({
      webPreferences: { partition: 'persist:w2g', autoplayPolicy: 'no-user-gesture-required' },
    });
    mainWindow.contentView.addChildView(w2gView);
    // Popups → real browser (sign-in flows, "open in new window" links).
    w2gView.webContents.setWindowOpenHandler(({ url: u }) => {
      if (typeof u === 'string' && /^https?:\/\//.test(u)) shell.openExternal(u);
      return { action: 'deny' };
    });
    // Top-level navigation away from w2g.tv → real browser, keeping this
    // view scoped (not a general embedded site).
    w2gView.webContents.on('will-navigate', (ev, u) => {
      if (!isW2gHost(u)) { ev.preventDefault(); if (/^https?:\/\//.test(u)) shell.openExternal(u); }
    });
    // Inject the just-video chrome-stripper on every load — but only in
    // 'just-video' mode. In 'full' (Show chat) mode we render w2g's page
    // as-is so the user sees chat + member list + playlist.
    w2gView.webContents.on('did-finish-load', () => {
      if (w2gView && w2gView.__mode !== 'full') {
        w2gView.webContents.executeJavaScript(W2G_JUST_VIDEO_JS).catch(() => {});
      }
    });
    w2gView.webContents.on('did-frame-finish-load', (_e, isMain) => {
      if (isMain && w2gView && w2gView.__mode !== 'full') {
        w2gView.webContents.executeJavaScript(W2G_JUST_VIDEO_JS).catch(() => {});
      }
    });
  }
  w2gView.__mode = (mode === 'full') ? 'full' : 'just-video';
  w2gView.webContents.loadURL(url);
  return true;
});
ipcMain.handle('w2g:bounds', (_e, b) => {
  if (w2gView && b) {
    w2gView.setBounds({
      x: Math.round(b.x || 0), y: Math.round(b.y || 0),
      width: Math.max(0, Math.round(b.width || 0)), height: Math.max(0, Math.round(b.height || 0)),
    });
  }
});
ipcMain.handle('w2g:setVisible', (_e, vis) => { if (w2gView) w2gView.setVisible(!!vis); });
ipcMain.handle('w2g:close', () => destroyW2gView());

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

// Live toggle for rounded corners. Unlike transparency, DWM corner rounding
// can be set at any time and works with the acrylic material on, so this needs
// no restart on Win11. `native` tells the renderer whether the OS handled it
// (false on Win10/older → renderer keeps its CSS-radius fallback).
ipcMain.handle('window:set-rounded', (_e, rounded) => {
  wantRoundedCorners = !!rounded;
  const ok = applyWindowCorners();
  sendNativeRoundingState();
  return { ok, native: nativeRoundingAvailable };
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

// YouTube watch-page sidebar recommendations (matches what youtube.com shows
// for that video). Richer than the autoplay mix; preferred source for the
// "Up next" tab.
ipcMain.handle('ytdlp:get-recommendations', async (_e, videoId, limit) => {
  try {
    const items = await ytdlp.getRecommendations(videoId, limit);
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
