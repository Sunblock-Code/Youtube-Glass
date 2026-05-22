import {
  api, videoIdFromUrl, videoIdFromAny, channelIdFromUrl,
  fmtViews, fmtNumber, fmtDuration, fmtRelative,
  isLoggedIn, getUser, logout,
  parseTakeoutCsv, parseTakeoutJson,
  nextInstance, getInstance, refreshInstances,
} from './api.js';
import * as playerLib from './player.js';
const { play, destroy } = playerLib;
import { watchParty, normalizeRoomCode, ROOM_CODE_LENGTH } from './watchparty.js';

const view = document.getElementById('view');
const search = document.getElementById('search');
const navButtons = document.querySelectorAll('.topnav button[data-route]');
const accountBtn = document.getElementById('account-btn');
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
const takeoutInput = document.getElementById('takeout-file');
const banner = document.getElementById('banner');
const settingsBtn = document.getElementById('settings-btn');
const backBtn = document.getElementById('back-btn');

let ytdlpReady = false;

// ---------- Back/forward navigation history ----------
const navStack = [];     // pages behind the current one
const navForward = [];   // pages ahead (populated by going Back)
let currentNav = null;
let navSuppressPush = false;
const fwdBtn = document.getElementById('fwd-btn');

function pushNav(state) {
  navStack.push(state);
  if (navStack.length > 50) navStack.shift();
}
// Kept the name (called from go()) but now also drives the forward button.
function refreshBackBtn() {
  if (backBtn) backBtn.disabled = navStack.length === 0;
  if (fwdBtn)  fwdBtn.disabled  = navForward.length === 0;
}
async function goBack() {
  if (!navStack.length) return;
  if (currentNav) navForward.push(currentNav);   // current page becomes "forward"
  const prev = navStack.pop();
  navSuppressPush = true;     // go() must not re-push or wipe the forward stack
  await go(prev.route, ...prev.args);
}
async function goForward() {
  if (!navForward.length) return;
  if (currentNav) pushNav(currentNav);           // current page goes back onto Back
  const next = navForward.pop();
  navSuppressPush = true;
  await go(next.route, ...next.args);
}
backBtn.onclick = goBack;
if (fwdBtn) fwdBtn.onclick = goForward;
document.addEventListener('mouseup', (e) => {
  // Mouse button 3 = browser Back, button 4 = browser Forward.
  if (e.button === 3) { e.preventDefault(); goBack(); }
  else if (e.button === 4) { e.preventDefault(); goForward(); }
});
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
});

// ---------- Hold "R" to refresh ----------
// Hold R: a ring fills over ~850ms and the current view reloads the instant
// it completes a full 360°. Release early → cancels, no refresh. Ignored
// while typing so it doesn't fight the search box / forms.
(function setupHoldRefresh() {
  const HOLD_MS = 850;
  const R = 26;
  const CIRC = 2 * Math.PI * R;
  let ring = null, ringProg = null, raf = null, startT = 0, active = false;

  const isTyping = () => {
    const el = document.activeElement;
    if (!el) return false;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    return !!el.isContentEditable;
  };
  const ensureRing = () => {
    if (ring) return;
    ring = document.createElement('div');
    ring.className = 'refresh-ring';
    ring.innerHTML =
      '<svg viewBox="0 0 64 64" aria-hidden="true">' +
        '<circle class="rr-track" cx="32" cy="32" r="' + R + '"></circle>' +
        '<circle class="rr-prog" cx="32" cy="32" r="' + R + '"></circle>' +
      '</svg>' +
      '<svg class="rr-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>' +
      '</svg>';
    document.body.appendChild(ring);
    ringProg = ring.querySelector('.rr-prog');
    ringProg.style.strokeDasharray = CIRC.toFixed(2);
  };
  const setProgress = (p) => {
    ringProg.style.strokeDashoffset = (CIRC * (1 - p)).toFixed(2);
  };
  const stop = () => {
    active = false;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (ring) ring.classList.remove('show', 'done');
  };
  const tick = () => {
    if (!active) return;
    const p = Math.min(1, (performance.now() - startT) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      active = false;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      ring.classList.add('done');
      setTimeout(() => { if (ring) ring.classList.remove('show', 'done'); }, 220);
      // Reload the current view WITHOUT touching back/forward history.
      if (currentNav) { navSuppressPush = true; go(currentNav.route, ...currentNav.args); }
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;  // leave Ctrl+R etc. alone
    if (e.repeat) { e.preventDefault(); return; }
    if (isTyping() || active) return;
    e.preventDefault();
    ensureRing();
    active = true;
    startT = performance.now();
    setProgress(0);
    ring.classList.add('show');
    raf = requestAnimationFrame(tick);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (active) stop();                 // released before 360° → cancel
  });
  // Lose the key-up if the window is blurred mid-hold — cancel cleanly.
  window.addEventListener('blur', () => { if (active) stop(); });
})();

// --- Aero-Snap-style window controls on the titlebar ---
// Electron's CSS drag regions don't always trigger Windows' native Aero Snap,
// so we provide the same UX manually:
//   - Double-click on titlebar → toggle maximize
//   - Drag and release with cursor at the very top edge of any monitor
//     → maximize (mimics dragging a window's titlebar to the top)
const titlebarEl = document.querySelector('.titlebar');
if (titlebarEl && window.app?.toggleMaximize) {
  titlebarEl.addEventListener('dblclick', (e) => {
    // Don't intercept double-clicks on the brand button, search box,
    // nav buttons, etc. — only the empty drag area.
    if (e.target.closest('button, input, a, svg, .search-wrap')) return;
    window.app.toggleMaximize();
  });

  // Drag-to-top fallback: detect mousedown on the titlebar, watch for
  // mouseup with screen coordinates near the top of the monitor.
  let dragStarted = false;
  titlebarEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, a, .search-wrap')) return;
    dragStarted = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragStarted) return;
    dragStarted = false;
    // screenY === 0 means the cursor is at the very top of the user's monitor.
    // Allow a small tolerance for high-DPI rounding.
    if (e.screenY <= 2) {
      window.app.maximize?.();
    }
  });
}

// ============================================================
// Settings
// ============================================================
const THEMES = {
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

// Play-bar colour palette. 'accent' is sentinel = use the active theme accent.
const PB_COLORS = {
  red:    '#ef4444',
  orange: '#f97316',
  yellow: '#facc15',
  green:  '#4ade80',
  cyan:   '#22d3ee',
  blue:   '#3b82f6',
  purple: '#a855f7',
  pink:   '#ec4899',
  white:  '#f5f5f5',
};

const DEFAULT_SETTINGS = {
  theme: 'purple',
  blur: 20,           // px
  glassAlpha: 5,      // %
  bgOpacity: 100,     // %  — opacity of the gradient/blobs layer (text + video stay solid)
  windowOpacity: 100, // %  — opacity of the entire window (everything translucent)
  askResume: true,
  showLikes: false,
  hideScrollbars: false,
  hidePassButton: false,
  hideDonateButton: false,
  searchStyle: 'pill',   // 'pill' | 'square'
  topnavStyle: 'text',   // 'text' | 'icon' | 'both' — Subs/Shorts/History buttons
  includeChannelInFilename: false,
  downloadDir: '',                 // empty = use platform default (Downloads/YouTube)
  relatedWidth: 380,     // px — width of the Up next sidebar
  commentsPlacement: 'side',  // 'auto' | 'side' | 'below'  (default = always left)
  motion: 'subtle',   // 'still' | 'subtle' | 'lively'
  bgMode: 'gradient', // 'gradient' | 'solid' | 'acrylic' | 'mica' | 'gaussian' | 'clear'
  bgSolidColor: '#0a0612',
  bgTint: 78,         // % — (legacy) was acrylic/clear surface tint; unused now.
  clearSeeThrough: 0, // % — "Background dim" veil over the desktop in
                      // see-through modes (Clear/Acrylic/Mica/Gaussian).
                      // 0 = no veil (full desktop), higher = darker veil.
                      // UI cards are NOT affected by this — see
                      // acrylicCardAlpha for the surface-see-through slider.
  acrylicCardAlpha: 0,  // % — see-through modes only: how transparent the
                        // cards/panels/titlebar are. 0 = solid (current
                        // default), higher = the OS acrylic / real desktop
                        // shows through the cards too. This is what makes
                        // acrylic feel "really see-through" instead of just
                        // dim around the edges.
  acrylicBlur: 0,       // px — see-through modes only: additional CSS
                        // backdrop-filter blur on cards/titlebar. Only
                        // visible when acrylicCardAlpha > 0 (i.e. when the
                        // cards are translucent enough to let the backdrop
                        // show through). 0 = off (blanket no-backdrop-filter
                        // rule wins, keeping the smooth-composite default).
  seeThrough: 0,      // % — how transparent the UI background is. Higher = more
                      // desktop showthrough (best paired with Mica/Acrylic backdrop)
  cardGlow: true,
  material: 'none',   // 'none' | 'mica' | 'acrylic' | 'tabbed' | 'frosted'
  playbarStyle: 'glow', // 'none' | 'solid' | 'glow' | 'neon' | 'pulse' | 'rainbow'
  playbarColor: 'accent', // 'accent' | named colour key in PB_COLORS — ignored for 'none' & 'rainbow'
  playbarHeight: 4,     // px — height of the play bar at rest
  playbarHeightHover: 12, // px — height while hovering the player
  showHeatmap: true,    // YouTube "Most Replayed" curve over the progress bar
  homeMode: 'mixed',    // Home feed: 'mixed' | 'trending' | 'foryou' | 'dashboard'
  subtitlePos: { x: 0.5, y: 0.88 }, // normalized center (fraction of player W/H) of the draggable caption box
  pullout: {
    enabled: false,
    side: 'right',                           // 'left' | 'right'
    width: 45,                               // % of work-area width
    hotkey: 'Alt+T',                         // Electron accelerator
  },
};

function loadSettings() {
  // Prefer the synchronously-loaded preload mirror so the right theme paints
  // on the very first frame — no flash of the default purple.
  const fromPreload = window.app?.initialSettings;
  if (fromPreload && typeof fromPreload === 'object') {
    try {
      // Also seed localStorage so the rest of the renderer sees consistent state.
      localStorage.setItem('glass-settings', JSON.stringify(fromPreload));
    } catch {}
    return { ...DEFAULT_SETTINGS, ...fromPreload };
  }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('glass-settings') || '{}') };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) {
  const json = JSON.stringify(s);
  // Primary: localStorage for fast sync access.
  localStorage.setItem('glass-settings', json);
  // Backup: SYNCHRONOUS file write via preload. The file is fully flushed
  // before this returns, so closing the app right after a save can't lose
  // the change. Falls back to async IPC if the sync helper is unavailable.
  if (window.app?.saveSettingsSync) {
    window.app.saveSettingsSync(json);
  } else if (window.app?.settingsWrite) {
    window.app.settingsWrite(json).catch(() => {});
  }
}

// On boot, if localStorage is empty but the file backup exists, pull settings
// back in and re-apply them. Async because the file read is via IPC.
async function rehydrateSettingsFromFile() {
  if (!window.app?.settingsRead) return;
  const ls = localStorage.getItem('glass-settings');
  if (ls && ls !== '{}') return; // localStorage already has settings — nothing to do
  try {
    const json = await window.app.settingsRead();
    if (!json) return;
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return;
    localStorage.setItem('glass-settings', json);
    currentSettings = { ...DEFAULT_SETTINGS, ...parsed };
    applySettings(currentSettings);
  } catch {}
}

function applySettings(s) {
  const root = document.documentElement;
  const t = THEMES[s.theme] || THEMES.purple;
  root.style.setProperty('--accent',      t.accent);
  root.style.setProperty('--accent-soft', t.accentSoft);
  root.style.setProperty('--blob-1',      t.blob1);
  root.style.setProperty('--blob-2',      t.blob2);
  root.style.setProperty('--blob-3',      t.blob3);
  root.dataset.motion = s.motion || 'subtle';
  // bgMode: 'gradient' (default colourful blobs), 'solid' (flat colour),
  // 'acrylic' (Win11 OS frosted backdrop — blurred desktop shows in empty
  // areas), or 'clear' (genuinely transparent window — SHARP desktop behind
  // the UI; requires the window to have been created transparent, hence the
  // restart prompt when toggling it).
  // Mica & Gaussian are extra Win11 OS materials that look/behave exactly
  // like Acrylic (transparent window + OS material + opaque UI + the
  // Background-dim veil). They REUSE Acrylic's CSS by mapping the styling
  // attribute to 'acrylic' — the real mode is still in s.bgMode for the
  // material call & pill highlight. Zero CSS duplication, so Acrylic's
  // working rules are untouched.
  const cssBgMode = (s.bgMode === 'mica' || s.bgMode === 'gaussian') ? 'acrylic' : s.bgMode;
  root.dataset.bgmode = ['solid', 'acrylic', 'clear'].includes(cssBgMode) ? cssBgMode : 'gradient';
  // Clear-glass "Background dim": opacity of the dark veil over the desktop
  // in the empty space ONLY. 0 = no veil (pure sharp desktop), higher =
  // desktop progressively darkened. The UI surfaces stay fully opaque and
  // are NEVER touched by this. CSS reads --clear-bg-tint (bgMode=clear).
  {
    const st = (typeof s.clearSeeThrough === 'number') ? s.clearSeeThrough : 0;
    const veil = Math.min(0.85, Math.max(0, st / 100));
    root.style.setProperty('--clear-bg-tint', veil.toFixed(3));
  }
  // See-through-modes "Surface see-through": alpha of the cards/titlebar.
  // 0% = fully solid (default, the original behavior); higher = the OS
  // acrylic / real desktop shows progressively through the cards too.
  // Capped at 75% so text never becomes unreadable.
  {
    const sa = (typeof s.acrylicCardAlpha === 'number') ? s.acrylicCardAlpha : 0;
    const seeThrough = Math.min(0.75, Math.max(0, sa / 100));
    // Card alpha is the INVERSE of see-through: 0% see-through = alpha 1.
    root.style.setProperty('--acrylic-card-alpha', (1 - seeThrough).toFixed(3));
  }
  // See-through-modes "Blur": optional backdrop-filter blur on cards.
  // The blanket `* { backdrop-filter: none !important }` rule in the
  // acrylic/clear CSS keeps the smooth-composite default in place. We
  // toggle a root attribute that activates the scoped, opted-in
  // backdrop-filter rule only when the slider is above 0.
  {
    const blur = (typeof s.acrylicBlur === 'number') ? s.acrylicBlur : 0;
    const px = Math.min(40, Math.max(0, blur));
    root.style.setProperty('--acrylic-blur', px + 'px');
    root.dataset.acrylicBlur = px > 0 ? 'on' : 'off';
  }
  // Solid bg now reuses the active theme's deep background colour — no
  // separate solid-colour picker. Pick a different theme to change it.
  root.style.setProperty('--bg-solid', t.bg || '#0a0612');
  root.dataset.glow = s.cardGlow ? 'true' : 'false';
  root.dataset.scrollbars = s.hideScrollbars ? 'hidden' : 'visible';
  root.dataset.passbtn = s.hidePassButton ? 'hidden' : 'visible';
  root.dataset.donate = s.hideDonateButton ? 'hidden' : 'visible';
  root.dataset.search = s.searchStyle === 'square' ? 'square' : 'pill';
  root.dataset.topnav = ['text', 'icon', 'both'].includes(s.topnavStyle) ? s.topnavStyle : 'text';
  root.dataset.heatmap = s.showHeatmap === false ? 'off' : 'on';
  root.style.setProperty('--related-width', (s.relatedWidth || 380) + 'px');
  root.dataset.comments = s.commentsPlacement || 'auto';
  root.dataset.material = s.material || 'none';
  root.dataset.pbstyle = s.playbarStyle || 'glow';
  // Resolve playbar colour into the --pb-color CSS var. 'accent' (default) falls
  // back to the theme accent so changing themes still works.
  const pbCol = PB_COLORS[s.playbarColor] || null;
  if (pbCol) root.style.setProperty('--pb-color', pbCol);
  else       root.style.removeProperty('--pb-color');
  root.style.setProperty('--pb-h',       (s.playbarHeight       ?? 4)  + 'px');
  root.style.setProperty('--pb-h-hover', (s.playbarHeightHover  ?? 12) + 'px');
  // SINGLE source of truth = bgMode. The old separate "material" axis kept
  // making the window see-through behind the user's back (e.g. Solid mode
  // with a stale material='acrylic'), bleeding the desktop through the
  // translucent glass cards — which read as "background opacity affecting
  // the UI". Only Acrylic uses the OS material now; everything else keeps
  // the window opaque (Gradient/Solid) or transparent (Clear, no material).
  // Real OS material per mode: Acrylic→acrylic, Mica→mica, Gaussian→the
  // Win11 'tabbed' material, Clear→none (sharp), everything else→none.
  const osMaterial =
    s.bgMode === 'acrylic'  ? 'acrylic' :
    s.bgMode === 'mica'     ? 'mica'    :
    s.bgMode === 'gaussian' ? 'tabbed'  : 'none';
  if (window.app?.setWindowMaterial) window.app.setWindowMaterial(osMaterial);
  root.style.setProperty('--blur',        s.blur + 'px');
  root.style.setProperty('--glass-alpha', (s.glassAlpha / 100).toFixed(3));
  root.style.setProperty('--glass-strong-alpha', Math.min(0.30, (s.glassAlpha / 100) + 0.04).toFixed(3));
  // Background opacity → ONLY the .bg layer (the app background). 100% =
  // fully visible background, 0% = background hidden. Nothing else (cards,
  // text, video, titlebar) is touched.
  const bgOpacity = (typeof s.bgOpacity === 'number') ? s.bgOpacity : 100;
  root.style.setProperty('--bg-opacity', (bgOpacity / 100).toFixed(3));
  // The whole-window opacity dimming is intentionally NOT applied anymore —
  // it made everything (incl. text) translucent. Force the window fully
  // opaque so a stale setting can't keep dimming the app.
  if (window.app?.setWindowOpacity) window.app.setWindowOpacity(1);
  if (window.app?.configurePullout) {
    window.app.configurePullout(s.pullout || DEFAULT_SETTINGS.pullout).then(r => {
      if (r && !r.ok) console.warn('Pull-out:', r.error);
    });
  }
}

let currentSettings = loadSettings();
applySettings(currentSettings);
// If localStorage was empty (Chromium dropped it for whatever reason), pull
// from the on-disk JSON backup and re-apply.
rehydrateSettingsFromFile();

// Generic state backup — any localStorage key in this list is mirrored to
// glass-state.json on every write, so dashboard / widgets / history / per-
// video preferences / panel layout state all survive Chromium dropping the
// storage backend.
const STATE_KEYS = [
  // Core data
  'glass-dashboard',
  'glass-widgets',
  'glass-history',
  'glass-resume',
  'glass-last-video',
  'subs',
  // Per-feature preferences (small but annoying to lose)
  'related-mode',         // Up next layout (list / overlay / thumbs)
  'related-collapsed',    // Up next sidebar collapsed
  'comments-collapsed',   // Comments sidebar collapsed
  'panel-merged',         // Merged panel side
  'panel-active-tab',     // Active tab when merged
  'merged-collapsed',     // Merged-mode collapsed
  'desc-mode',            // Description mode (raw / rich)
  'shorts-tab',           // Last-selected shorts tab
  'cc-volume',            // Last video volume
  'piped-display-name',   // Custom name for the topnav button
];
function snapshotState() {
  const state = {};
  for (const k of STATE_KEYS) {
    const v = localStorage.getItem(k);
    if (v != null) state[k] = v;
  }
  if (window.app?.saveStateSync) window.app.saveStateSync(JSON.stringify(state));
}
// Hydrate from preload mirror on boot if any key is missing.
(function hydrateState() {
  const initial = window.app?.initialState;
  if (!initial || typeof initial !== 'object') return;
  let restored = false;
  for (const k of STATE_KEYS) {
    if (localStorage.getItem(k) == null && typeof initial[k] === 'string') {
      try { localStorage.setItem(k, initial[k]); restored = true; } catch {}
    }
  }
  if (restored) console.info('[state] restored from preload mirror');
})();
// Wrap localStorage.setItem so any of the listed keys triggers a fresh
// snapshot on disk. Other keys (settings + auth) have their own backups.
const _origSetItem = localStorage.setItem.bind(localStorage);
const _origRemoveItem = localStorage.removeItem.bind(localStorage);
localStorage.setItem = (k, v) => {
  _origSetItem(k, v);
  if (STATE_KEYS.includes(k)) snapshotState();
};
localStorage.removeItem = (k) => {
  _origRemoveItem(k);
  if (STATE_KEYS.includes(k)) snapshotState();
};

// ---------- Local subscriptions (used when NOT logged in) ----------
function getLocalSubs() {
  try { return JSON.parse(localStorage.getItem('subs') || '[]'); }
  catch { return []; }
}
function setLocalSubs(s) { localStorage.setItem('subs', JSON.stringify(s)); }
function isLocallySubbed(id) { return !!id && getLocalSubs().some(c => c.id === id); }
function toggleLocalSub(channel) {
  if (!channel.id) return;
  const subs = getLocalSubs();
  const i = subs.findIndex(c => c.id === channel.id);
  if (i >= 0) subs.splice(i, 1); else subs.push(channel);
  setLocalSubs(subs);
}

// ---------- Local watch history ----------
const HISTORY_LIMIT = 200;
function getHistory() {
  try { return JSON.parse(localStorage.getItem('glass-history') || '[]'); }
  catch { return []; }
}
function recordWatch(item) {
  if (!item.id) return;
  let hist = getHistory();
  hist = hist.filter(h => h.id !== item.id);
  hist.unshift({ ...item, watchedAt: Date.now() });
  if (hist.length > HISTORY_LIMIT) hist.length = HISTORY_LIMIT;
  localStorage.setItem('glass-history', JSON.stringify(hist));
  // Also keep a "last watched" pointer with thumbnail/title so we can prompt
  // to resume on next app launch.
  localStorage.setItem('glass-last-video', JSON.stringify({ ...item, savedAt: Date.now() }));
}
function getLastVideo() {
  try { return JSON.parse(localStorage.getItem('glass-last-video') || 'null'); }
  catch { return null; }
}
function clearLastVideo() { localStorage.removeItem('glass-last-video'); }
function clearHistory() { localStorage.removeItem('glass-history'); }

// ---------- Resume points ----------
const RESUME_LIMIT = 200;
function getResume(id) {
  if (!id) return null;
  try {
    const m = JSON.parse(localStorage.getItem('glass-resume') || '{}');
    return m[id] || null;
  } catch { return null; }
}
function setResume(id, position, duration) {
  if (!id || !position || position < 3) return;
  let m;
  try { m = JSON.parse(localStorage.getItem('glass-resume') || '{}'); } catch { m = {}; }
  m[id] = { position, duration: duration || 0, savedAt: Date.now() };
  const keys = Object.keys(m);
  if (keys.length > RESUME_LIMIT) {
    const sorted = keys.sort((a, b) => m[b].savedAt - m[a].savedAt).slice(0, RESUME_LIMIT);
    const pruned = {};
    for (const k of sorted) pruned[k] = m[k];
    m = pruned;
  }
  try { localStorage.setItem('glass-resume', JSON.stringify(m)); }
  catch (e) { console.warn('Resume save failed:', e); }
}
function clearResume(id) {
  if (!id) return;
  try {
    const m = JSON.parse(localStorage.getItem('glass-resume') || '{}');
    delete m[id];
    localStorage.setItem('glass-resume', JSON.stringify(m));
  } catch {}
}

let currentVideoId = null;
function flushResumeForCurrent() {
  if (!currentVideoId) return;
  const v = document.querySelector('video');
  if (!v || !v.duration) return;
  if (v.currentTime > 5 && v.currentTime / v.duration < 0.95) {
    setResume(currentVideoId, v.currentTime, v.duration);
  }
}
window.addEventListener('beforeunload', flushResumeForCurrent);

// ---------- Dashboard ----------
function getDashboard() {
  try { return JSON.parse(localStorage.getItem('glass-dashboard') || '[]'); }
  catch { return []; }
}
function setDashboard(d) { localStorage.setItem('glass-dashboard', JSON.stringify(d)); }

// Dashboard widgets — independent of channel rows. Stored separately so
// existing users keep their layout. Booleans only (no per-widget options yet).
const DEFAULT_WIDGETS = {
  clock: true,
  recentHistory: true,
  quickLinks: false,
};
function getWidgets() {
  try { return { ...DEFAULT_WIDGETS, ...JSON.parse(localStorage.getItem('glass-widgets') || '{}') }; }
  catch { return { ...DEFAULT_WIDGETS }; }
}
function setWidgets(w) { localStorage.setItem('glass-widgets', JSON.stringify(w)); }
function patchWidgets(patch) { setWidgets({ ...getWidgets(), ...patch }); }

// All channels the user could feature on the dashboard — local subs plus,
// if signed in to Piped, the server-side subscription list. Deduped by id.
async function getAvailableChannels() {
  const local = getLocalSubs();
  let piped = [];
  if (isLoggedIn()) {
    try {
      const subs = await api.subscriptions();
      piped = (subs || []).map(s => ({
        id: (s.url || '').replace(/^.*\/channel\//, ''),
        name: s.name,
      })).filter(s => s.id);
    } catch {}
  }
  const seen = new Set();
  const merged = [];
  for (const c of [...local, ...piped]) {
    if (c.id && !seen.has(c.id)) {
      seen.add(c.id);
      merged.push({ id: c.id, name: c.name || c.id });
    }
  }
  return merged.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// ---------- Routing ----------
async function go(route, ...args) {
  // Track history (skip when this call is itself a goBack pop)
  if (!navSuppressPush && currentNav && (currentNav.route !== route || JSON.stringify(currentNav.args) !== JSON.stringify(args))) {
    pushNav(currentNav);
    // A fresh navigation starts a new branch — anything that was "forward"
    // (only reachable by pressing Back) is no longer reachable.
    navForward.length = 0;
  }
  navSuppressPush = false;
  currentNav = { route, args };
  refreshBackBtn();

  navButtons.forEach(b => b.classList.toggle('active', b.dataset.route === route));

  // Any open modal (donate menu, settings, auth picker, …) is implicitly
  // dismissed when the user navigates — otherwise it can hang around in the
  // background after a route change.
  if (!modal.classList.contains('hidden')) closeModal();

  const v = view.querySelector('video');
  if (v) {
    flushResumeForCurrent();
    destroy(v);
  }
  currentVideoId = null;

  view.scrollTop = 0;
  view.innerHTML = `<div class="loader">Loading</div>`;

  // Watch-together: if we're in a room and the user navigated to a video,
  // tell everyone else so they follow. Skip when we ourselves are applying a
  // remote nav — otherwise we'd echo it back as a fresh broadcast.
  if (route === 'video' && watchParty.inRoom && !watchParty.applyingRemote) {
    watchParty.broadcast({ type: 'video', id: args[0] });
  }
  try {
    if (route === 'home')         await renderDashboard();
    else if (route === 'search')  await renderSearch(args[0]);
    else if (route === 'video')   await renderVideo(args[0]);
    else if (route === 'subs')    await renderSubs();
    else if (route === 'shorts')  await renderShorts();
    else if (route === 'history') await renderHistory();
    else if (route === 'channel') await renderChannel(args[0]);
    else view.innerHTML = `<div class="empty">Not found</div>`;
  } catch (e) {
    console.error(e);
    showError(e, route, args);
  }
}

function showError(e, route, args) {
  const raw = e.message || String(e);
  const isBotBlock = /SignInConfirmNotBot|LOGIN_REQUIRED|not a bot|blocked anonymous/i.test(raw);
  // YouTube-side content restrictions: retrying or switching instances won't
  // help. The video simply isn't playable through Piped/yt-dlp because YouTube
  // gates it (members-only, private, age-gated, geo-blocked, premium music).
  const restriction = classifyRestriction(raw);
  // Only treat as instance fault if it ISN'T a content restriction — restriction
  // errors sometimes carry the org.schabi prefix and would otherwise be
  // miscategorized as a transient instance problem.
  const isInstanceFault = !restriction && (
    /^HTTP 5\d\d/.test(raw)
    || /failed/i.test(raw) || /aborted/i.test(raw)
    || /org\.schabi|java\.|StreamHandlers|NewPipe/i.test(raw)
  );
  const host = new URL(getInstance()).host;

  // Friendly headline + collapsed raw stack/error.
  let headline, body;
  if (restriction) {
    headline = restriction.headline;
    body = restriction.body;
  } else if (isBotBlock) {
    headline = 'YouTube is bot-blocking this Piped instance.';
    if (!ytdlpReady) {
      body = `<strong>Install yt-dlp at the top of the page to fix this for good.</strong> yt-dlp runs locally on your machine, so YouTube can't bot-block it like it can with Piped's datacenter IPs. ~17 MB, one-time download into the youtube-glass folder. The Install banner should be visible at the top of Glass — if it isn't, you may already have yt-dlp but it's failing on this video.`;
    } else {
      body = `yt-dlp couldn't extract this video either. Try updating yt-dlp (delete <code>yt-dlp.exe</code> from the youtube-glass folder and click Install again), or rotate to a different Piped instance.`;
    }
  } else if (isInstanceFault) {
    headline = `Piped instance ${host} is having trouble.`;
    body = 'Try another one or retry.';
  } else {
    headline = raw;
    body = '';
  }

  // On a content restriction, Retry is useless — offer "Open on YouTube" and
  // "Go back" instead.
  const videoId = route === 'video' ? args[0] : null;
  const showYouTubeBtn = !!(restriction && videoId);

  view.innerHTML = `
    <div class="error">
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">${escape(headline)}</div>
      ${body ? `<div style="font-size:13px;opacity:0.9;margin-bottom:14px;line-height:1.5">${body}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:${isInstanceFault ? '14px' : '0'}">
        ${restriction
          ? `<button id="err-back" class="sub-btn" style="background:var(--glass);color:var(--text);border:1px solid var(--glass-border)">Go back</button>
             ${showYouTubeBtn ? `<button id="err-yt" class="sub-btn" style="background:var(--glass);color:var(--text);border:1px solid var(--glass-border)">Open on YouTube</button>` : ''}`
          : `<button id="err-retry" class="sub-btn" style="background:var(--glass);color:var(--text);border:1px solid var(--glass-border)">Retry</button>
             ${isInstanceFault ? `<button id="err-switch" class="sub-btn" style="background:var(--glass);color:var(--text);border:1px solid var(--glass-border)">Try another instance</button>` : ''}`}
      </div>
      ${isInstanceFault ? `<details style="font-size:11px;opacity:0.6;cursor:pointer"><summary>Raw error</summary><pre style="white-space:pre-wrap;margin-top:8px;font-family:monospace">${escape(raw)}</pre></details>` : ''}
    </div>
  `;
  const retry = view.querySelector('#err-retry');
  if (retry) retry.onclick = () => go(route, ...args);
  const sw = view.querySelector('#err-switch');
  if (sw) sw.onclick = () => { const n = nextInstance(); console.log('Switched to', n); go(route, ...args); };
  const back = view.querySelector('#err-back');
  if (back) back.onclick = () => (navStack.length ? goBack() : go('home'));
  const yt = view.querySelector('#err-yt');
  if (yt) yt.onclick = () => window.app?.openExternal?.(`https://www.youtube.com/watch?v=${videoId}`)
    || window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
}

// Map a raw Piped/yt-dlp error message to a user-friendly explanation of the
// YouTube-side content gate. Returns null if the error doesn't look like a
// content restriction (caller falls back to generic handling).
function classifyRestriction(raw) {
  const r = String(raw || '');
  if (/PaidContentException|only available for members|members.only/i.test(r)) {
    return {
      headline: 'This video is members-only.',
      body: 'The channel owner gates this video behind a paid membership on YouTube. There\'s no way to play it through Glass — you\'d need to be a paying member and watch it on youtube.com.',
    };
  }
  if (/PrivateContentException|This video is private|private video/i.test(r)) {
    return {
      headline: 'This video is private.',
      body: 'The uploader has set this video to private. Only people they\'ve directly invited can watch it.',
    };
  }
  if (/AgeRestrictedContentException|age.restricted|age.gated|sign in to confirm your age/i.test(r)) {
    return {
      headline: 'This video is age-restricted.',
      body: 'YouTube requires a signed-in, age-verified account to watch this. Glass plays anonymously, so it can\'t bypass the gate.',
    };
  }
  if (/GeographicRestrictionException|not available in your country|geo.restricted|geo.blocked/i.test(r)) {
    return {
      headline: 'This video is blocked in your region.',
      body: 'The uploader (or YouTube) has restricted this video from being played in your country.',
    };
  }
  if (/YoutubeMusicPremiumContentException|Premium.*content|premium.only/i.test(r)) {
    return {
      headline: 'This is YouTube Premium content.',
      body: 'This video is exclusive to YouTube Premium subscribers and can\'t be played through Glass.',
    };
  }
  if (/ContentNotAvailableException|video.*(unavailable|removed|deleted|terminated)|This video isn't available/i.test(r)) {
    return {
      headline: 'This video is unavailable.',
      body: 'It may have been removed by the uploader, taken down by YouTube, or the channel may have been terminated.',
    };
  }
  if (/live stream.*(ended|offline)|livestream.*(ended|not started)/i.test(r)) {
    return {
      headline: 'This live stream isn\'t playable right now.',
      body: 'The stream has ended, hasn\'t started yet, or its archive is unavailable.',
    };
  }
  return null;
}

// ---------- Views ----------
let dashboardEditing = false;

// Home dispatcher. Home is no longer just the channel-row dashboard — the
// user picks a feed via the mode bar; the choice persists in settings.
async function renderDashboard() {
  const mode = currentSettings.homeMode || 'mixed';
  try {
    if (mode === 'trending') return await renderHomeTrending();
    if (mode === 'foryou')   return await renderHomeForYou();
    if (mode === 'dashboard') return await renderHomeDashboard();
    return await renderHomeMixed();
  } catch (e) {
    console.error('[home] render failed', e);
    view.innerHTML = homeModeBar(mode) +
      `<div class="empty">Couldn't load this feed. Pick another above, or retry.</div>`;
    wireHomeModeBar();
  }
}

// The segmented switcher shown at the top of every Home mode.
const HOME_MODES = [
  { key: 'mixed',     label: 'Mixed' },
  { key: 'trending',  label: 'Trending' },
  { key: 'foryou',    label: 'For You' },
  { key: 'dashboard', label: 'Dashboard' },
];
// Tracks the mode that was active right before the user clicked a new tab.
// Consumed by the next wireHomeModeBar() to seed the indicator at the OLD
// position and animate to the NEW one. Cleared after use so navigations
// back to home from elsewhere don't trigger a phantom slide.
let _prevHomeMode = null;
function homeModeBar(active) {
  return `<div class="home-modebar" role="tablist">
    <div class="home-mode-indicator" aria-hidden="true"></div>
    ${HOME_MODES.map(m =>
      `<button class="home-modebtn${m.key === active ? ' active' : ''}" role="tab" data-home-mode="${m.key}">${m.label}</button>`
    ).join('')}
  </div>`;
}
function wireHomeModeBar() {
  const bar = view.querySelector('.home-modebar');
  if (!bar) return;
  const indicator = bar.querySelector('.home-mode-indicator');
  const activeBtn = bar.querySelector('.home-modebtn.active');
  if (!indicator || !activeBtn) return;

  // Move the indicator under a given button. We use offsetLeft/offsetTop —
  // those are in the bar's coordinate space (relative to its border-box).
  // The indicator is absolutely positioned with `top:0; left:0`, which
  // references the PADDING box (inside the border), so we subtract the
  // bar's border width (clientLeft/clientTop) to land exactly on the
  // button's outer corner. Same trick for width/height: offsetWidth/Height
  // include the button's own border, and our indicator is box-sizing:
  // border-box, so its 1px border fits cleanly inside without inflating.
  const positionAt = (btn) => {
    const x = btn.offsetLeft - bar.clientLeft;
    const y = btn.offsetTop  - bar.clientTop;
    indicator.style.transform = `translate(${x}px, ${y}px)`;
    indicator.style.width  = btn.offsetWidth  + 'px';
    indicator.style.height = btn.offsetHeight + 'px';
  };

  // First paint after a click: snap to the OLD position with transitions
  // off, then on the next frame turn transitions back on and move to the
  // NEW position so the indicator visibly slides over. On any other mount
  // (initial load, nav back to home) we just snap silently.
  const fromBtn = _prevHomeMode
    ? bar.querySelector(`[data-home-mode="${_prevHomeMode}"]`)
    : null;
  if (fromBtn && fromBtn !== activeBtn) {
    indicator.style.transition = 'none';
    positionAt(fromBtn);
    // Force layout so the "no transition" assignment lands before we
    // re-enable transitions on the next frame.
    void indicator.offsetWidth;
    requestAnimationFrame(() => {
      indicator.style.transition = '';
      positionAt(activeBtn);
    });
  } else {
    indicator.style.transition = 'none';
    requestAnimationFrame(() => {
      positionAt(activeBtn);
      requestAnimationFrame(() => { indicator.style.transition = ''; });
    });
  }
  _prevHomeMode = null;

  view.querySelectorAll('[data-home-mode]').forEach(btn => {
    btn.onclick = () => {
      const next = btn.dataset.homeMode;
      if (next === (currentSettings.homeMode || 'mixed')) return;
      _prevHomeMode = currentSettings.homeMode || 'mixed';
      currentSettings.homeMode = next;
      saveSettings(currentSettings);
      renderDashboard();
    };
  });
}

// Best-effort region for /trending from the UI locale (e.g. en-US → US).
function regionGuess() {
  try {
    const loc = navigator.language || 'en-US';
    const m = loc.match(/[-_]([A-Za-z]{2})\b/);
    return m ? m[1].toUpperCase() : 'US';
  } catch { return 'US'; }
}

// Recent uploads from the user's subscriptions. Logged-in Piped accounts get
// the fast server-side feed; otherwise we aggregate local-sub channels (and
// fall back to the featured dashboard channels) with a hard cap so Home
// doesn't fire hundreds of channel requests.
async function fetchSubItems() {
  if (isLoggedIn()) {
    try {
      const feed = await api.feed();
      if (Array.isArray(feed) && feed.length) return feed;
    } catch {}
  }
  let channels = getLocalSubs();
  if (!channels.length) {
    channels = getDashboard().map(d => ({ id: d.id, name: d.name }));
  }
  channels = channels.filter(c => c && c.id).slice(0, 25);
  if (!channels.length) return [];
  const out = [];
  await Promise.all(channels.map(async c => {
    try {
      const ch = await api.channel(c.id);
      for (const r of (ch.relatedStreams || []).slice(0, 5)) out.push(r);
    } catch {}
  }));
  out.sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0));
  return out;
}

// Round-robin two lists into one, de-duped by video id, newest-ish first.
function interleaveDedupe(primary, secondary, cap = 48) {
  const seen = new Set();
  const out = [];
  const push = (it) => {
    if (!it || !it.url) return;
    const vid = videoIdFromUrl(it.url);
    if (!vid || seen.has(vid)) return;
    seen.add(vid);
    out.push(it);
  };
  const a = primary || [], b = secondary || [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < cap; i++) {
    if (i < a.length) push(a[i]);
    if (i < b.length) push(b[i]);
  }
  return out.slice(0, cap);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Home: Trending ---
async function renderHomeTrending() {
  view.innerHTML = homeModeBar('trending') + `<div class="loader">Loading trending</div>`;
  wireHomeModeBar();
  let items = [];
  try { items = await api.trending(regionGuess()); } catch {}
  items = (items || []).filter(i => i && i.url);
  view.innerHTML = homeModeBar('trending') + (items.length
    ? `<h2 class="section-title">Trending</h2><div class="grid">${items.map(videoCard).join('')}</div>`
    : `<div class="empty">Couldn't load trending right now — Piped instances vary. Try again, or switch to Dashboard.</div>`);
  attachCardClicks();
  wireHomeModeBar();
}

// --- Home: Mixed (subscriptions + trending interleaved) ---
async function renderHomeMixed() {
  view.innerHTML = homeModeBar('mixed') + `<div class="loader">Loading your mix</div>`;
  wireHomeModeBar();
  const [subItems, trend] = await Promise.all([
    fetchSubItems().catch(() => []),
    api.trending(regionGuess()).catch(() => []),
  ]);
  // Subs lead (it's "your" feed) but trending is woven through for discovery.
  const merged = interleaveDedupe(subItems, (trend || []).filter(i => i && i.url));
  view.innerHTML = homeModeBar('mixed') + (merged.length
    ? `<h2 class="section-title">Your mix</h2><div class="grid">${merged.map(videoCard).join('')}</div>`
    : `<div class="empty">Nothing to mix yet. Subscribe to channels or sign in, or switch to Trending above.</div>`);
  attachCardClicks();
  wireHomeModeBar();
}

// --- Home: For You (homegrown algo from watch history + subs) ---
async function renderHomeForYou() {
  view.innerHTML = homeModeBar('foryou') + `<div class="loader">Building suggestions</div>`;
  wireHomeModeBar();
  const hist = getHistory();
  const watched = new Set(hist.map(h => h.id).filter(Boolean));
  const seedIds = [...watched].slice(0, 6);

  let related = [];
  if (seedIds.length) {
    const lists = await Promise.all(seedIds.map(id => fetchSidebarRelated(id).catch(() => [])));
    related = lists.flat();
  }
  const seen = new Set();
  const pool = [];
  for (const it of related) {
    if (!it || !it.url) continue;
    const vid = videoIdFromUrl(it.url);
    if (!vid || watched.has(vid) || seen.has(vid)) continue;
    seen.add(vid);
    pool.push(it);
  }
  shuffleInPlace(pool);
  // Sparse history → top up with subs so the page is never near-empty.
  if (pool.length < 12) {
    const filler = await fetchSubItems().catch(() => []);
    for (const it of filler) {
      if (!it || !it.url) continue;
      const vid = videoIdFromUrl(it.url);
      if (!vid || watched.has(vid) || seen.has(vid)) continue;
      seen.add(vid);
      pool.push(it);
    }
  }
  const final = pool.slice(0, 48);
  view.innerHTML = homeModeBar('foryou') + (final.length
    ? `<h2 class="section-title">For you</h2><div class="grid">${final.map(videoCard).join('')}</div>`
    : `<div class="empty">Watch a few videos and this fills with suggestions based on them.</div>`);
  attachCardClicks();
  wireHomeModeBar();
}

async function renderHomeDashboard() {
  const dashboard = getDashboard();

  if (!dashboard.length) {
    const all = await getAvailableChannels();
    if (!all.length) {
      view.innerHTML = homeModeBar('dashboard') + `
        <div class="dash-empty">
          <div class="title">Build your dashboard</div>
          <div class="sub">Sign in or import your YouTube subscriptions to start.<br>Then come back here and pick channels to feature on your home screen.</div>
          <button id="dash-go-signin">Get subscriptions</button>
        </div>
      `;
      wireHomeModeBar();
      view.querySelector('#dash-go-signin').onclick = showAuthMenu;
      return;
    }
    view.innerHTML = homeModeBar('dashboard') + `
      <div class="dash-empty">
        <div class="title">Build your dashboard</div>
        <div class="sub">Pick which of your ${all.length} subscribed channel${all.length === 1 ? '' : 's'} appear on your home screen, in your own order.</div>
        <button id="dash-build">+ Add channels</button>
      </div>
    `;
    wireHomeModeBar();
    view.querySelector('#dash-build').onclick = showChannelPicker;
    return;
  }

  view.innerHTML = homeModeBar('dashboard') + `
    <div class="dash-page-header">
      <h2 class="section-title" style="margin:0;flex:1">Your dashboard</h2>
      <button id="dash-edit" class="topnav-style-btn ${dashboardEditing ? 'primary' : ''}">${dashboardEditing ? 'Done' : 'Edit dashboard'}</button>
    </div>
    ${dashboardEditing ? `
      <div class="dash-edit-banner">
        <span>Reorder, remove, or add channels — and toggle widgets below. Click <strong>Done</strong> when finished.</span>
      </div>
      <div id="dash-widget-toggles" class="dash-widget-toggles"></div>
    ` : ''}
    <div id="dash-widgets"></div>
    <div id="dash-rows"></div>
    ${dashboardEditing ? `
      <div style="display:flex;justify-content:center;margin-top:8px">
        <button id="dash-add" class="topnav-style-btn primary">+ Add channel</button>
      </div>
    ` : ''}
  `;
  wireHomeModeBar();
  renderDashboardWidgets(view.querySelector('#dash-widgets'));
  if (dashboardEditing) {
    renderWidgetToggles(view.querySelector('#dash-widget-toggles'));
  }

  view.querySelector('#dash-edit').onclick = () => {
    dashboardEditing = !dashboardEditing;
    renderDashboard();
  };
  if (dashboardEditing) {
    view.querySelector('#dash-add').onclick = showChannelPicker;
  }

  const rows = view.querySelector('#dash-rows');
  const arrowSvg = (dir) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="${dir === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'}"/></svg>`;
  rows.innerHTML = dashboard.map((c, idx) => `
    <div class="dash-row" data-id="${escape(c.id)}" data-idx="${idx}">
      <div class="dash-row-header">
        <button class="dash-row-titlebtn" data-channel-id="${escape(c.id)}" title="Open channel">
          <span class="dash-row-avatar" data-avatar-for="${escape(c.id)}">
            ${c.avatar
              ? `<img src="${escapeAttr(c.avatar)}" referrerpolicy="no-referrer" alt="" />`
              : `<span class="dash-row-avatar-fallback">${escape((c.name || c.id || '?').slice(0, 1).toUpperCase())}</span>`}
          </span>
          <span class="dash-row-title">${escape(c.name || c.id)}</span>
          <svg class="dash-row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
        ${dashboardEditing ? `
          <div class="dash-row-actions">
            <button class="dash-row-edit-btn" data-action="up" title="Move up" ${idx === 0 ? 'disabled style="opacity:0.3"' : ''}>↑</button>
            <button class="dash-row-edit-btn" data-action="down" title="Move down" ${idx === dashboard.length - 1 ? 'disabled style="opacity:0.3"' : ''}>↓</button>
            <button class="dash-row-edit-btn danger" data-action="remove" title="Remove from dashboard">×</button>
          </div>
        ` : ''}
      </div>
      <div class="dash-row-frame">
        <button class="dash-arrow left"  aria-label="Scroll left">${arrowSvg('left')}</button>
        <button class="dash-arrow right" aria-label="Scroll right">${arrowSvg('right')}</button>
        <div class="dash-row-scroll" data-row-id="${escape(c.id)}">
          <div class="loader" style="padding:30px">Loading</div>
        </div>
      </div>
    </div>
  `).join('');

  // Title row → channel page
  rows.querySelectorAll('.dash-row-titlebtn').forEach(btn => {
    btn.onclick = (e) => {
      // Avoid stealing clicks while edit mode is active (the action buttons sit
      // alongside; user expects to interact with them, not navigate).
      if (dashboardEditing) { e.preventDefault(); return; }
      go('channel', btn.dataset.channelId);
    };
  });

  if (dashboardEditing) {
    rows.querySelectorAll('.dash-row-edit-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const row = btn.closest('.dash-row');
        const idx = parseInt(row.dataset.idx, 10);
        const action = btn.dataset.action;
        const dash = getDashboard();
        if (action === 'up' && idx > 0) {
          [dash[idx - 1], dash[idx]] = [dash[idx], dash[idx - 1]];
        } else if (action === 'down' && idx < dash.length - 1) {
          [dash[idx + 1], dash[idx]] = [dash[idx], dash[idx + 1]];
        } else if (action === 'remove') {
          dash.splice(idx, 1);
        }
        setDashboard(dash);
        renderDashboard();
      };
    });
  }

  // Fetch each channel's recent videos in parallel. Also captures the channel
  // avatar so it can render in the row header (and persist for the next load
  // so we're not avatar-less while we wait on Piped).
  const persisted = getDashboard();
  let avatarsChanged = false;
  await Promise.all(dashboard.map(async (c) => {
    const container = rows.querySelector(`.dash-row-scroll[data-row-id="${CSS.escape(c.id)}"]`);
    if (!container) return;
    try {
      const ch = await api.channel(c.id);

      // Patch the avatar slot once we know what the channel looks like.
      const avSlot = rows.querySelector(`.dash-row-avatar[data-avatar-for="${CSS.escape(c.id)}"]`);
      if (avSlot && ch.avatarUrl) {
        avSlot.innerHTML = `<img src="${escapeAttr(ch.avatarUrl)}" referrerpolicy="no-referrer" alt="" />`;
      }
      const entry = persisted.find(d => d.id === c.id);
      if (entry) {
        if (ch.avatarUrl && entry.avatar !== ch.avatarUrl) { entry.avatar = ch.avatarUrl; avatarsChanged = true; }
        if (ch.name && entry.name !== ch.name) { entry.name = ch.name; avatarsChanged = true; }
      }

      let items = (ch.relatedStreams || []).slice(0, 12);
      // Piped occasionally returns empty relatedStreams for channels that
      // yt-dlp can still extract just fine. Fall back to a local yt-dlp
      // listing so the dashboard row isn't permanently stuck on "No videos."
      if (!items.length && ytdlpReady) {
        try {
          const r = await window.app.ytdlp.getChannelVideos(c.id, 12);
          if (r?.ok && Array.isArray(r.items) && r.items.length) items = r.items;
        } catch { /* ignore — fall through to empty message */ }
      }
      if (!items.length) {
        container.innerHTML = `<div class="empty" style="padding:20px;flex:1">No videos.</div>`;
        return;
      }
      container.innerHTML = items.map(videoCard).join('');
      container.querySelectorAll('.card').forEach(card => {
        card.onclick = () => go('video', card.dataset.id);
      });
      attachRowScrollControls(container);
    } catch {
      container.innerHTML = `<div class="empty" style="padding:20px;flex:1;color:#fca5a5">Couldn't load this channel.</div>`;
    }
  }));
  if (avatarsChanged) setDashboard(persisted);
}

// Dashboard widgets — rendered as a grid of glass cards above the channel rows.
function renderDashboardWidgets(container) {
  if (!container) return;
  const w = getWidgets();
  const cards = [];
  if (w.clock)         cards.push(clockWidget());
  if (w.quickLinks)    cards.push(quickLinksWidget());
  if (w.recentHistory) cards.push(recentHistoryWidget());

  if (!cards.length) {
    container.innerHTML = '';
    container.style.marginBottom = '0';
    return;
  }
  container.innerHTML = `<div class="dash-widgets-grid">${cards.join('')}</div>`;
  container.style.marginBottom = '24px';

  // Live-update the clock once per second.
  const clockTime = container.querySelector('[data-widget="clock"] .clock-time');
  const clockDate = container.querySelector('[data-widget="clock"] .clock-date');
  const clockGreeting = container.querySelector('[data-widget="clock"] .clock-greeting');
  if (clockTime) {
    if (window._glassClockInterval) clearInterval(window._glassClockInterval);
    const tick = () => {
      const d = new Date();
      const hh = d.getHours();
      const mm = String(d.getMinutes()).padStart(2, '0');
      const am = hh < 12 ? 'AM' : 'PM';
      const h12 = ((hh + 11) % 12) + 1;
      clockTime.textContent = `${h12}:${mm}`;
      clockTime.setAttribute('data-am', am);
      if (clockDate) {
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        clockDate.textContent = `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
      }
      if (clockGreeting) {
        let g = 'Good evening';
        if (hh < 5) g = 'Up late';
        else if (hh < 12) g = 'Good morning';
        else if (hh < 18) g = 'Good afternoon';
        clockGreeting.textContent = g;
      }
    };
    tick();
    window._glassClockInterval = setInterval(tick, 1000);
  }

  // Wire history widget cards.
  container.querySelectorAll('.widget-history-card').forEach(card => {
    card.onclick = () => go('video', card.dataset.id);
  });
  // Quick-links buttons
  container.querySelectorAll('[data-widget-go]').forEach(btn => {
    btn.onclick = () => go(btn.dataset.widgetGo);
  });
}

function clockWidget() {
  return `
    <div class="dash-widget dash-widget-clock" data-widget="clock">
      <div class="clock-greeting">Hello</div>
      <div class="clock-time" data-am="AM">--:--</div>
      <div class="clock-date">—</div>
    </div>
  `;
}

function quickLinksWidget() {
  return `
    <div class="dash-widget dash-widget-quicklinks" data-widget="quickLinks">
      <div class="widget-title">Jump to</div>
      <div class="widget-quicklinks">
        <button class="widget-link-btn" data-widget-go="subs">Subs</button>
        <button class="widget-link-btn" data-widget-go="shorts">Shorts</button>
        <button class="widget-link-btn" data-widget-go="history">History</button>
      </div>
    </div>
  `;
}

function recentHistoryWidget() {
  const hist = getHistory().slice(0, 6);
  if (!hist.length) {
    return `
      <div class="dash-widget dash-widget-history" data-widget="recentHistory">
        <div class="widget-title">Recently watched</div>
        <div class="widget-empty">Nothing yet — watched videos will show here.</div>
      </div>
    `;
  }
  const cards = hist.map(h => `
    <div class="widget-history-card" data-id="${escape(h.id)}" title="${escapeAttr(h.title || '')}">
      <div class="widget-history-thumb">
        ${h.thumbnail ? `<img src="${escapeAttr(h.thumbnail)}" referrerpolicy="no-referrer" alt="" />` : ''}
        <div class="widget-history-overlay">
          <div class="widget-history-title">${escape(h.title || '')}</div>
        </div>
        ${h.duration ? `<div class="widget-history-dur">${fmtDuration(h.duration)}</div>` : ''}
      </div>
    </div>
  `).join('');
  return `
    <div class="dash-widget dash-widget-history" data-widget="recentHistory">
      <div class="widget-title-row">
        <div class="widget-title">Recently watched</div>
        <button class="widget-more" data-widget-go="history">See all →</button>
      </div>
      <div class="widget-history-grid">${cards}</div>
    </div>
  `;
}

function renderWidgetToggles(container) {
  if (!container) return;
  const w = getWidgets();
  const items = [
    { key: 'clock',         label: '🕓 Clock',           sub: 'Time, date, greeting' },
    { key: 'quickLinks',    label: '⚡ Quick links',     sub: 'Subs / Shorts / History buttons' },
    { key: 'recentHistory', label: '🎬 Recently watched', sub: 'Last 6 videos' },
  ];
  container.innerHTML = `
    <div class="dash-widget-toggles-title">Widgets</div>
    <div class="dash-widget-toggles-row">
      ${items.map(it => `
        <label class="widget-toggle ${w[it.key] ? 'on' : ''}">
          <input type="checkbox" data-widget-key="${it.key}" ${w[it.key] ? 'checked' : ''} />
          <div class="widget-toggle-body">
            <div class="widget-toggle-label">${it.label}</div>
            <div class="widget-toggle-sub">${escape(it.sub)}</div>
          </div>
        </label>
      `).join('')}
    </div>
  `;
  container.querySelectorAll('input[data-widget-key]').forEach(cb => {
    cb.onchange = () => {
      patchWidgets({ [cb.dataset.widgetKey]: cb.checked });
      renderDashboardWidgets(view.querySelector('#dash-widgets'));
      cb.closest('.widget-toggle').classList.toggle('on', cb.checked);
    };
  });
}

// Wires the ◀ ▶ arrow buttons, overflow-edge fade indicators, and click-and-drag
// horizontal scrolling on a single dashboard row.
function attachRowScrollControls(scroll) {
  const frame = scroll.closest('.dash-row-frame');
  if (!frame) return;
  const leftBtn  = frame.querySelector('.dash-arrow.left');
  const rightBtn = frame.querySelector('.dash-arrow.right');

  const updateOverflow = () => {
    const max = scroll.scrollWidth - scroll.clientWidth;
    const x = scroll.scrollLeft;
    const canLeft  = x > 4;
    const canRight = x < max - 4;
    frame.classList.toggle('has-overflow-left',  canLeft);
    frame.classList.toggle('has-overflow-right', canRight);
    leftBtn.classList.toggle('show',  canLeft);
    rightBtn.classList.toggle('show', canRight);
  };
  updateOverflow();
  scroll.addEventListener('scroll', updateOverflow, { passive: true });
  // Re-check after thumbnails load, since they can change scrollWidth
  scroll.querySelectorAll('img').forEach(img => {
    if (!img.complete) img.addEventListener('load', updateOverflow, { once: true });
  });

  // Arrow buttons scroll by ~85% of the visible width
  const step = () => Math.max(240, Math.round(scroll.clientWidth * 0.85));
  leftBtn.onclick  = (e) => { e.stopPropagation(); scroll.scrollBy({ left: -step(), behavior: 'smooth' }); };
  rightBtn.onclick = (e) => { e.stopPropagation(); scroll.scrollBy({ left:  step(), behavior: 'smooth' }); };

  // Drag-to-scroll
  let dragging = false;
  let startX = 0;
  let startLeft = 0;
  let moved = 0;

  scroll.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.dash-arrow')) return;
    dragging = true;
    moved = 0;
    startX = e.clientX;
    startLeft = scroll.scrollLeft;
    scroll.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    scroll.scrollLeft = startLeft - dx;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    scroll.classList.remove('dragging');
  });
  // If the user actually dragged (>5px), swallow the resulting card click
  scroll.addEventListener('click', (e) => {
    if (moved > 5) { e.stopPropagation(); e.preventDefault(); moved = 0; }
  }, true);
}

async function showChannelPicker() {
  const [all, dash] = await Promise.all([getAvailableChannels(), Promise.resolve(getDashboard())]);
  const dashIds = new Set(dash.map(c => c.id));

  if (!all.length) {
    openModal(`
      <h2>No subscriptions yet</h2>
      <div class="modal-sub">Sign in or import your YouTube subs first, then come back to pick channels.</div>
      <div class="modal-actions">
        <button id="cp-close">Close</button>
        <button id="cp-signin" class="primary">Get subscriptions</button>
      </div>
    `);
    modalBody.querySelector('#cp-close').onclick = closeModal;
    modalBody.querySelector('#cp-signin').onclick = () => { closeModal(); showAuthMenu(); };
    return;
  }

  const renderList = (filter = '') => {
    const f = filter.trim().toLowerCase();
    return all
      .filter(c => !f || (c.name || '').toLowerCase().includes(f))
      .map(c => `
        <label class="picker-row">
          <input type="checkbox" data-id="${escape(c.id)}" ${dashIds.has(c.id) ? 'checked' : ''} />
          <span>${escape(c.name || c.id)}</span>
        </label>
      `).join('');
  };

  openModal(`
    <h2>Channels on dashboard</h2>
    <div class="modal-sub">Tick the channels you want featured on your home screen. ${all.length} subscribed.</div>
    <input type="text" class="picker-search" id="cp-search" placeholder="Filter…" autocomplete="off" />
    <div class="picker-list" id="cp-list">${renderList()}</div>
    <div class="modal-actions">
      <button id="cp-cancel">Cancel</button>
      <button id="cp-save" class="primary">Save</button>
    </div>
  `, { wide: true });

  const list = modalBody.querySelector('#cp-list');
  modalBody.querySelector('#cp-search').oninput = (e) => {
    // Preserve existing checkbox state into a Set so re-rendering doesn't lose unsaved ticks
    const currentlyChecked = new Set([...list.querySelectorAll('input:checked')].map(i => i.dataset.id));
    list.innerHTML = renderList(e.target.value);
    // Re-apply state after re-render
    list.querySelectorAll('input').forEach(i => {
      i.checked = currentlyChecked.has(i.dataset.id) || (dashIds.has(i.dataset.id) && !currentlyChecked.size);
    });
    // Actually simpler: re-derive from a tracking set
  };

  // Track checkbox state across filtering (above oninput is brittle; use a tracked set instead)
  const tracked = new Set(dashIds);
  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    if (cb.checked) tracked.add(cb.dataset.id); else tracked.delete(cb.dataset.id);
  });
  modalBody.querySelector('#cp-search').oninput = (e) => {
    list.innerHTML = renderList(e.target.value);
    list.querySelectorAll('input').forEach(i => { i.checked = tracked.has(i.dataset.id); });
  };

  modalBody.querySelector('#cp-cancel').onclick = closeModal;
  modalBody.querySelector('#cp-save').onclick = () => {
    const checked = [...tracked];
    // Preserve existing dashboard order for kept channels; append newly-checked at end.
    const existingKept = dash.filter(c => checked.includes(c.id));
    const existingIds = new Set(existingKept.map(c => c.id));
    const newOnes = all.filter(c => checked.includes(c.id) && !existingIds.has(c.id));
    setDashboard([...existingKept, ...newOnes]);
    closeModal();
    renderDashboard();
  };
}

async function renderSearch(q) {
  const data = await api.search(q);
  const items = (data.items || []).filter(i => i.type === 'stream' && i.url);
  view.innerHTML = items.length
    ? `<h2 class="section-title">Results for "${escape(q)}"</h2>
       <div class="grid">${items.map(videoCard).join('')}</div>`
    : `<div class="empty">No results for "${escape(q)}"</div>`;
  attachCardClicks();
}

async function renderSubs() {
  // Logged in → server-side feed (single fast call). Else → manual aggregation.
  if (isLoggedIn()) {
    const items = await api.feed();
    view.innerHTML = items?.length
      ? `<h2 class="section-title">Your feed</h2>
         <div class="grid">${items.map(videoCard).join('')}</div>`
      : `<div class="empty">Your feed is empty. Subscribe to some channels (or import from YouTube Takeout).</div>`;
    attachCardClicks();
    return;
  }

  const subs = getLocalSubs();
  if (!subs.length) {
    view.innerHTML = `<div class="empty">No subscriptions yet — sign in or open a video and tap Subscribe.</div>`;
    return;
  }
  view.innerHTML = `<div class="loader">Fetching ${subs.length} channel${subs.length > 1 ? 's' : ''}</div>`;

  const all = [];
  await Promise.all(subs.map(async c => {
    try {
      const ch = await api.channel(c.id);
      for (const r of (ch.relatedStreams || []).slice(0, 6)) all.push(r);
    } catch {}
  }));
  all.sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0));

  view.innerHTML = all.length
    ? `<h2 class="section-title">Latest from your subscriptions</h2>
       <div class="grid">${all.map(videoCard).join('')}</div>`
    : `<div class="empty">Couldn't fetch any subscription videos right now.</div>`;
  attachCardClicks();
}

// Convert yt-dlp -j output to the same shape player.js / renderVideo expects from Piped.
function normalizeYtDlp(d) {
  const formats = d.formats || [];

  // HLS variants — best for adaptive playback when present.
  const hlsCandidates = formats.filter(f =>
    (f.protocol === 'm3u8_native' || f.protocol === 'm3u8' || (f.url || '').includes('.m3u8'))
    && f.vcodec && f.vcodec !== 'none'
  );
  // Highest-quality HLS variant
  hlsCandidates.sort((a, b) => (b.height || 0) - (a.height || 0));
  const hls = hlsCandidates[0]?.manifest_url || hlsCandidates[0]?.url || null;

  // Muxed progressive formats (have both audio and video in one stream).
  // YouTube's muxed streams cap at 360p these days — higher quality requires
  // pairing a video-only stream with an audio-only one (see videoOnly below).
  const muxed = formats
    .filter(f => f.url
      && f.vcodec && f.vcodec !== 'none'
      && f.acodec && f.acodec !== 'none'
      && (f.protocol === 'https' || f.protocol === 'http' || !f.protocol))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  // Video-only mp4/H.264 streams — used to unlock 480p / 720p / 1080p+ when
  // no DASH manifest is available. We restrict to AVC (H.264) for the widest
  // compatibility — every browser/Electron build can decode it natively.
  const videoOnly = formats
    .filter(f => f.url
      && f.vcodec && f.vcodec !== 'none'
      && (f.acodec === 'none' || !f.acodec)
      && (f.ext === 'mp4' || f.ext === 'm4v')
      && /^avc1/i.test(f.vcodec || '')
      && (f.protocol === 'https' || f.protocol === 'http' || !f.protocol))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  // Audio-only m4a/AAC — paired with a video-only stream for HD playback.
  const audioOnlyList = formats
    .filter(f => f.url
      && f.acodec && f.acodec !== 'none'
      && (f.vcodec === 'none' || !f.vcodec)
      && (f.ext === 'm4a' || f.ext === 'mp4')
      && /^mp4a/i.test(f.acodec || '')
      && (f.protocol === 'https' || f.protocol === 'http' || !f.protocol))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  const bestAudio = audioOnlyList[0] || null;

  // DASH manifest URL — yt-dlp attaches `manifest_url` to DASH-derived formats.
  // Any one of them works; they all reference the same master manifest.
  const dashFormat = formats.find(f =>
    f.manifest_url && /manifest\/dash/i.test(f.manifest_url)
  );
  const dash = dashFormat ? dashFormat.manifest_url : null;

  // Upload date: yt-dlp gives YYYYMMDD
  let uploadDate = null;
  if (d.upload_date && d.upload_date.length === 8) {
    uploadDate = `${d.upload_date.slice(0, 4)}-${d.upload_date.slice(4, 6)}-${d.upload_date.slice(6, 8)}`;
  }

  return {
    title: d.title,
    description: d.description,
    uploader: d.uploader || d.channel,
    uploaderUrl: d.channel_id ? `/channel/${d.channel_id}` : (d.channel_url || ''),
    views: d.view_count,
    likes: d.like_count,
    duration: d.duration,
    uploadDate,
    thumbnailUrl: d.thumbnail,
    hls,
    dash,
    // Video-only first (highest quality), then muxed (e.g. 360p) — same array,
    // distinguishable by .videoOnly. The resolution picker shows them all.
    videoStreams: [
      ...videoOnly.map(f => ({
        url: f.url,
        mimeType: 'video/mp4',
        quality: f.height ? `${f.height}p` : 'auto',
        codec: f.vcodec,
        videoOnly: true,
      })),
      ...muxed.map(f => ({
        url: f.url,
        mimeType: f.ext ? `video/${f.ext}` : 'video/mp4',
        quality: f.height ? `${f.height}p` : 'auto',
        codec: f.vcodec,
        videoOnly: false,
      })),
    ],
    audioStream: bestAudio ? {
      url: bestAudio.url,
      mimeType: 'audio/mp4',
      codec: bestAudio.acodec,
      bitrate: bestAudio.abr || bestAudio.tbr || null,
    } : null,
    audioStreams: [],
    relatedStreams: [],
    heatmap: d.heatmap || null,  // YouTube "Most Replayed" curve, when available
    // Subtitles: yt-dlp returns { lang: [{ url, ext, name }] }. Prefer manual
    // tracks over auto-captions; flatten to a simple [{lang,label,url,ext}].
    subtitles: collectSubtitles(d.subtitles, d.automatic_captions),
  };
}

function collectSubtitles(manual, auto) {
  const out = [];
  const pickVtt = (arr) => {
    if (!Array.isArray(arr)) return null;
    return arr.find(t => t.ext === 'vtt' || /vtt/i.test(t.url || '')) || arr[0];
  };
  const add = (lang, track, isAuto) => {
    const t = pickVtt(track);
    if (!t || !t.url) return;
    out.push({
      lang,
      label: (t.name || lang) + (isAuto ? ' (auto)' : ''),
      url: t.url,
      ext: t.ext || 'vtt',
      auto: !!isAuto,
    });
  };
  if (manual && typeof manual === 'object') {
    for (const lang of Object.keys(manual)) add(lang, manual[lang], false);
  }
  // For auto-captions, YouTube exposes one real auto track plus auto-translations
  // into every language they support — that's hundreds of useless duplicates.
  // Keep only the original auto track: the language whose sub URL does NOT
  // contain a `tlang=` translation parameter (i.e. it IS the source caption).
  if (auto && typeof auto === 'object') {
    for (const lang of Object.keys(auto)) {
      if (out.some(s => s.lang === lang && !s.auto)) continue;
      const track = pickVtt(auto[lang]);
      if (!track || !track.url) continue;
      // tlang= means it's an auto-translation of the source — drop those.
      if (/[?&]tlang=/.test(track.url)) continue;
      add(lang, auto[lang], true);
    }
  }
  return out;
}

// Build an SVG path that smoothly curves through the heatmap points
// (Catmull-Rom -> cubic Bezier conversion). Returns '' if data is empty.
function buildHeatmapSVG(heatmap) {
  if (!heatmap || heatmap.length < 2) return '';
  const W = 1000, H = 100;
  // Normalise field names — yt-dlp / Piped variants use start_time, startTime,
  // start, etc. Fall back to evenly-spaced indices if no time info present.
  const pickT = (h, ...keys) => {
    for (const k of keys) {
      if (typeof h[k] === 'number') return h[k];
    }
    return null;
  };
  const norm = heatmap.map((h, i) => ({
    start: pickT(h, 'start_time', 'startTime', 'start') ?? i,
    end:   pickT(h, 'end_time',   'endTime',   'end')   ?? (i + 1),
    value: Number(h.value ?? h.score ?? h.intensity ?? 0),
  }));
  const max = Math.max(...norm.map(h => h.value));
  if (!isFinite(max) || max <= 0) return '';
  const total = norm[norm.length - 1].end || norm.length;
  if (!total) return '';
  const points = norm.map(h => {
    const mid = ((h.start + h.end) / 2) / total;
    const x = Math.max(0, Math.min(1, mid)) * W;
    const y = H - (h.value / max) * H * 0.92 - H * 0.04;
    return [x, y];
  });
  // Anchor curve to baseline at both ends
  points.unshift([0, H]);
  points.push([W, H]);

  const t = 0.18;
  let d = `M ${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  // Close to baseline so we can fill the area under the curve
  const fillD = d + ` L ${W},${H} L 0,${H} Z`;

  // Stroke + fill use `currentColor` so the curve picks up the theme accent
  // (or the user's chosen playbar colour) via CSS, instead of being hard-coded
  // white. The fill uses a multi-stop gradient that fades to transparent at
  // the bottom so the curve sits cleanly above the progress strip; a soft
  // top-edge highlight gives the crest a subtle "lit" feel.
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="heatGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%"   stop-color="currentColor" stop-opacity="0.55"/>
        <stop offset="55%"  stop-color="currentColor" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${fillD}" fill="url(#heatGrad)"/>
    <path d="${d}" fill="none" stroke="currentColor" stroke-opacity="0.95" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <path d="${d}" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

async function fetchVideoData(id) {
  // Prefer yt-dlp when available (sidesteps YouTube's bot-block on Piped instances).
  if (ytdlpReady) {
    const r = await window.app.ytdlp.getVideo(id);
    if (r.ok) return { data: normalizeYtDlp(r.data), source: 'ytdlp' };
    console.warn('yt-dlp failed, falling back to Piped:', r.error);
  }
  const data = await api.streams(id);
  return { data, source: 'piped' };
}

async function renderHistory() {
  const hist = getHistory();
  if (!hist.length) {
    view.innerHTML = `<div class="empty">Nothing watched yet — videos you open will show up here.</div>`;
    return;
  }
  const items = hist.map(h => ({
    url: `https://youtube.com/watch?v=${h.id}`,
    title: h.title,
    thumbnail: h.thumbnail,
    duration: h.duration,
    uploaderName: h.uploaderName,
    views: h.views,
  }));
  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <h2 class="section-title" style="margin:0;flex:1">History · ${hist.length}</h2>
      <button id="clear-history" class="topnav-style-btn">Clear history</button>
    </div>
    <div class="grid">${items.map(videoCard).join('')}</div>
  `;
  attachCardClicks();
  view.querySelector('#clear-history').onclick = () => {
    if (!confirm(`Clear all ${hist.length} videos from your watch history?`)) return;
    clearHistory();
    go('history');
  };
}

// Trending Shorts. Piped has no dedicated /shorts endpoint, so we pull from
// multiple sources in parallel — trending across several regions, plus a
// "#shorts" search — and merge by what looks like a Short (explicit isShort
// flag, /shorts/ in the URL, or duration ≤ 60s).
const SHORTS_REGIONS = ['US', 'CA', 'GB', 'IN', 'BR', 'JP'];
const isShortItem = (it) => {
  if (!it || !it.url) return false;
  if (it.isShort === true) return true;
  if (typeof it.url === 'string' && /\/shorts\//i.test(it.url)) return true;
  if (typeof it.duration === 'number' && it.duration > 0 && it.duration <= 60) return true;
  return false;
};

async function renderShorts(tab) {
  // Saved tab choice persists between visits.
  const SAVED = localStorage.getItem('shorts-tab');
  const activeTab = tab || SAVED || 'trending';
  if (tab) localStorage.setItem('shorts-tab', tab);

  // Skeleton with tabs first so the user sees something immediately.
  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <h2 class="section-title" style="margin:0;flex:1">Shorts</h2>
      <span id="shorts-count" class="hint" style="color:var(--muted);font-size:12px"></span>
    </div>
    <div class="shorts-tabs">
      <button class="shorts-tab ${activeTab === 'trending' ? 'active' : ''}" data-shorts-tab="trending">Trending</button>
      <button class="shorts-tab ${activeTab === 'subs' ? 'active' : ''}" data-shorts-tab="subs">From subscriptions</button>
    </div>
    <div id="shorts-body"><div class="loader" style="padding:30px">Loading shorts</div></div>
  `;
  view.querySelectorAll('[data-shorts-tab]').forEach(btn => {
    btn.onclick = () => renderShorts(btn.dataset.shortsTab);
  });

  const body = view.querySelector('#shorts-body');
  const countEl = view.querySelector('#shorts-count');
  const renderResults = (items) => {
    if (!items.length) {
      body.innerHTML = activeTab === 'subs'
        ? `<div class="empty">No Shorts found in your subscribed channels' recent uploads.</div>`
        : `<div class="empty">Couldn't find any Shorts right now. Piped's instances vary on what they index — try the other tab, or rotate to another instance from Settings.</div>`;
      countEl.textContent = '';
      return;
    }
    body.innerHTML = `<div class="shorts-grid">${items.map(shortsCard).join('')}</div>`;
    body.querySelectorAll('.shorts-card').forEach(c => {
      c.onclick = () => go('video', c.dataset.id);
    });
    countEl.textContent = `${items.length} found`;
  };

  if (activeTab === 'subs') {
    // Pull the user's subscribed channels (server-side feed when logged in,
    // falling back to local subs list), then fetch each channel's recent
    // videos in parallel and keep only the Shorts.
    let channels = [];
    try {
      if (isLoggedIn()) {
        const subs = await api.subscriptions();
        channels = (subs || []).map(s => ({
          id: (s.url || '').replace(/^.*\/channel\//, ''),
          name: s.name,
        })).filter(s => s.id);
      } else {
        channels = getLocalSubs();
      }
    } catch {}

    if (!channels.length) {
      body.innerHTML = `
        <div class="empty">
          No subscribed channels yet — sign in or import your YouTube subs first, then this tab will show their Shorts.
        </div>
      `;
      countEl.textContent = '';
      return;
    }

    // Cap concurrent channel fetches (large sub lists can hit hundreds).
    const CHANNEL_LIMIT = 60;
    const targetChannels = channels.slice(0, CHANNEL_LIMIT);
    const seen = new Set();
    const collected = [];
    await Promise.all(targetChannels.map(async (c) => {
      try {
        const ch = await api.channel(c.id);
        for (const it of (ch.relatedStreams || [])) {
          if (!isShortItem(it)) continue;
          const id = videoIdFromUrl(it.url);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          collected.push({
            ...it,
            uploaderName: it.uploaderName || c.name || ch.name,
            // Treat the channel's most-recent uploaded date as a sort key.
            _upMs: it.uploaded || 0,
          });
        }
      } catch { /* skip channels that fail */ }
    }));
    collected.sort((a, b) => (b._upMs || 0) - (a._upMs || 0));
    renderResults(collected);
    return;
  }

  // 'trending' (default): merge multiple regions + a "#shorts" search.
  const sources = [
    ...SHORTS_REGIONS.map(r => api.trending(r).catch(() => [])),
    api.search('#shorts').then(d => d?.items || []).catch(() => []),
    api.search('shorts').then(d => d?.items || []).catch(() => []),
  ];
  const results = await Promise.all(sources);
  const seen = new Set();
  const merged = [];
  for (const arr of results) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (!isShortItem(it)) continue;
      const id = videoIdFromUrl(it.url);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(it);
    }
  }
  renderResults(merged);
}

function shortsCard(item) {
  const id = videoIdFromUrl(item.url);
  return `
    <div class="shorts-card" data-id="${id}">
      <div class="shorts-thumb">
        <img src="${escapeAttr(item.thumbnail || '')}" loading="lazy" referrerpolicy="no-referrer" alt="" />
        <div class="shorts-badge">Shorts</div>
        ${item.duration ? `<div class="duration">${fmtDuration(item.duration)}</div>` : ''}
      </div>
      <div class="shorts-meta">
        <div class="title">${escape(item.title || '')}</div>
        <div class="sub"><span class="ch">${escape(item.uploaderName || '')}</span>${item.views != null ? '<span class="dot">·</span>' + fmtViews(item.views) : ''}</div>
      </div>
    </div>
  `;
}

async function renderVideo(id) {
  const { data, source } = await fetchVideoData(id);
  const channelId = channelIdFromUrl(data.uploaderUrl);
  recordWatch({
    id,
    title: data.title,
    uploaderName: data.uploader,
    thumbnail: data.thumbnailUrl,
    duration: data.duration,
    views: data.views,
  });
  const subbed = isLoggedIn()
    ? await api.isSubscribed(channelId).catch(() => false)
    : isLocallySubbed(channelId);

  const relatedCollapsed = localStorage.getItem('related-collapsed') === '1';
  const commentsCollapsed = localStorage.getItem('comments-collapsed') !== '0'; // default collapsed
  const RELATED_MODES = ['list', 'overlay', 'thumbs'];
  let relatedMode = localStorage.getItem('related-mode') || 'list';
  if (!RELATED_MODES.includes(relatedMode)) relatedMode = 'list';
  // Sidebar can show one of three sources, persisted across pages.
  const RELATED_SOURCES = ['related', 'subs', 'history'];
  let relatedSource = localStorage.getItem('related-source') || 'related';
  if (!RELATED_SOURCES.includes(relatedSource)) relatedSource = 'related';
  const statsParts = [];
  if (data.views != null) statsParts.push(`<span class="stat"><b>${escape(fmtNumber(data.views))}</b> views</span>`);
  if (currentSettings.showLikes && data.likes != null) statsParts.push(`<span class="stat"><b>${escape(fmtNumber(data.likes))}</b> likes</span>`);
  if (data.uploadDate) statsParts.push(`<span class="stat stat-time">${escape(fmtRelative(Date.parse(data.uploadDate)))}</span>`);
  const statsLine = statsParts.join('<span class="stat-sep" aria-hidden="true">·</span>');

  const descMode = localStorage.getItem('desc-mode') || 'raw';

  view.innerHTML = `
    <div class="player-page ${relatedCollapsed ? 'related-collapsed' : ''} ${commentsCollapsed ? 'comments-collapsed' : ''}">
      <div class="comments-col" data-cside="comments">
        <div class="comments-tabs" role="tablist" aria-label="Comments / Chat">
          <button class="comments-tab active" data-cside-target="comments" role="tab" aria-selected="true">
            <svg class="comments-tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Comments</span>
          </button>
          <button class="comments-tab" data-cside-target="chat" role="tab" aria-selected="false">
            <svg class="comments-tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            <span>Chat</span>
            <span class="chat-tab-dot" id="chat-tab-dot" hidden></span>
          </button>
        </div>
        <div class="comments-stickyhead">
          <div class="comments-header">
            <h2 class="section-title">Comments</h2>
            <button class="related-toggle" id="comments-toggle" title="${commentsCollapsed ? 'Show comments' : 'Hide comments'}" aria-label="Toggle comments">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
          </div>
          <div class="comment-composer" id="comment-composer">
            <textarea id="cc-input" rows="1" placeholder="Add a comment…"></textarea>
            <div class="comment-composer-actions">
              <span class="comment-composer-hint">Posting requires YouTube — we'll copy your comment & open the video.</span>
              <button id="cc-cancel" type="button">Cancel</button>
              <button id="cc-post" type="button" class="primary">Comment</button>
            </div>
          </div>
          <div class="comment-filters">
            <button class="comment-filter active" data-sort="top">Top</button>
            <button class="comment-filter" data-sort="new">New</button>
          <button class="comment-filter" data-sort="replies">Most replies</button>
          <button class="comment-filter" data-sort="pinned">Pinned</button>
          </div>
        </div>
        <div class="comments-list" id="comments-list">
          <div class="loader" style="padding:30px">Loading comments</div>
        </div>
        <div class="chat-panel" id="chat-panel">
          <div class="chat-empty" id="chat-empty">
            <svg class="chat-empty-icon" width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            <div class="chat-empty-title">No room yet</div>
            <div class="chat-empty-sub">Start or join a watch-together room to chat with whoever's watching with you.</div>
            <button class="modal-btn primary" id="chat-open-wp" type="button">Watch together</button>
          </div>
          <div class="chat-composer" id="chat-composer">
            <input type="text" id="chat-input" placeholder="Send a message…" autocomplete="off" maxlength="500" />
            <button id="chat-send" type="button" aria-label="Send" title="Send (Enter)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
              </svg>
            </button>
          </div>
          <div class="chat-messages" id="chat-messages"></div>
        </div>
      </div>
      <div class="player-col">
        <div class="player-wrap" id="player-wrap">
          <video autoplay playsinline></video>
          <div class="cc-subs" id="cc-subs" aria-hidden="true"></div>
          <div class="player-spinner" aria-hidden="true"><div class="player-spinner-ring"></div></div>
          <div class="player-bottom-fade"></div>
          <div class="player-heatmap" id="player-heatmap"></div>
          <div class="player-progress-strip">
            <div class="progress-buffered" id="pb-buffered"></div>
            <div class="progress-fill" id="pb-fill"></div>
          </div>
          <div class="vol-side" id="vol-side">
            <div class="vol-track" id="vol-track"><div class="vol-fill" id="vol-fill"></div></div>
          </div>
          <div class="vol-indicator" id="vol-indicator"></div>
          <div class="cc-bar" id="cc-bar">
            <button class="cc-btn" id="cc-play" title="Play/Pause (Space)" aria-label="Play/Pause">
              <svg class="cc-icon-play"  width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>
              <svg class="cc-icon-pause" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </button>
            <span class="cc-time" id="cc-time">0:00 / 0:00</span>
            <div class="cc-spacer"></div>
            <div class="cc-volume-wrap">
              <button class="cc-btn" id="cc-mute" title="Mute (M)" aria-label="Mute">
                <svg class="cc-icon-vol-on"  width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                <svg class="cc-icon-vol-off" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
              </button>
              <input type="range" class="cc-volume" id="cc-volume" min="0" max="1" step="0.01" value="1" />
            </div>
            <button class="cc-btn" id="cc-options" title="Player options" aria-label="Player options">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
            <button class="cc-btn" id="cc-fullscreen" title="Fullscreen (F)" aria-label="Fullscreen">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            </button>
          </div>
          <div class="cc-options-panel" id="cc-options-panel">
            <div class="cc-opt-section-label">Progress bar</div>
            <div class="cc-opt-pills" id="cc-opt-pills">
              ${['none','solid','glow','neon','pulse','rainbow'].map(k => `
                <button class="theme-pill ${currentSettings.playbarStyle === k ? 'active' : ''}" data-cc-pb="${k}">${k.charAt(0).toUpperCase() + k.slice(1)}</button>
              `).join('')}
            </div>
            <div class="cc-opt-color-row" id="cc-opt-color-row">
              <button class="cc-color-pill ${(currentSettings.playbarColor || 'accent') === 'accent' ? 'active' : ''}" data-pcol="accent" title="Theme accent"></button>
              ${Object.entries(PB_COLORS).map(([k, c]) => `
                <button class="cc-color-pill ${currentSettings.playbarColor === k ? 'active' : ''}" data-pcol="${k}" title="${k.charAt(0).toUpperCase() + k.slice(1)}" style="background:${c}"></button>
              `).join('')}
            </div>
            <div class="cc-opt-height-row">
              <label>
                <span>Height <em id="cc-pb-h-val">${currentSettings.playbarHeight ?? 4}px</em></span>
                <input type="range" id="cc-pb-h" min="1" max="16" value="${currentSettings.playbarHeight ?? 4}" />
              </label>
              <label>
                <span>Hover height <em id="cc-pb-hh-val">${currentSettings.playbarHeightHover ?? 12}px</em></span>
                <input type="range" id="cc-pb-hh" min="2" max="40" value="${currentSettings.playbarHeightHover ?? 12}" />
              </label>
            </div>
            <label class="cc-opt-check">
              <input type="checkbox" id="cc-heatmap-toggle" class="glass-check" ${currentSettings.showHeatmap !== false ? 'checked' : ''} />
              "Most Replayed" curve
            </label>

            <div class="cc-opt-section-label" style="margin-top:14px">Speed</div>
            <div class="cc-opt-pills" id="cc-opt-speed">
              ${[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => `
                <button class="theme-pill" data-cc-speed="${s}">${s}x</button>
              `).join('')}
            </div>

            <div class="cc-opt-row">
              <div class="cc-opt-col">
                <div class="cc-opt-section-label">Resolution</div>
                <div class="cc-dropdown" id="cc-opt-res">
                  <button class="cc-dropdown-btn" type="button">
                    <span class="cc-dropdown-label">Auto</span>
                    <svg class="cc-dropdown-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="cc-dropdown-list"></div>
                </div>
              </div>
              <div class="cc-opt-col">
                <div class="cc-opt-section-label">Subtitles</div>
                <div class="cc-dropdown" id="cc-opt-cc">
                  <button class="cc-dropdown-btn" type="button">
                    <span class="cc-dropdown-label">Off</span>
                    <svg class="cc-dropdown-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="cc-dropdown-list"></div>
                </div>
              </div>
            </div>

            <div class="cc-opt-section-label" style="margin-top:14px">Caption placement</div>
            <div class="cc-opt-hint">Drag the caption text anywhere on the video to reposition it. The spot is remembered for every video.</div>
          </div>
        </div>
        <div class="video-meta">
          <div class="title-row">
            <h1>${escape(data.title || '')}</h1>
            <div class="stats">${statsLine}</div>
          </div>
          <div class="channel-row">
            <button class="channel-link" id="channel-link" ${channelId ? '' : 'disabled'} title="${escape(data.uploader || '')}">
              <img class="channel-avatar-small" id="channel-avatar" alt="" referrerpolicy="no-referrer" />
              <span class="channel-name">${escape(data.uploader || '')}</span>
            </button>
            <button id="dl-btn" class="dl-btn" title="Download to your Downloads folder">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Download</span>
            </button>
            <button id="sub-btn" class="sub-btn ${subbed ? 'subbed' : ''}">
              <span>${subbed ? 'Subscribed' : 'Subscribe'}</span>
            </button>
          </div>
          <div class="video-desc-wrap">
            <div class="desc-controls">
              <button class="desc-toggle ${descMode === 'raw' ? 'active' : ''}" data-mode="raw">Raw</button>
              <button class="desc-toggle ${descMode === 'rich' ? 'active' : ''}" data-mode="rich">Rendered</button>
            </div>
            <div class="video-desc" id="video-desc"></div>
          </div>
        </div>
      </div>
      <div class="related-col">
        <div class="related-tabs" role="tablist" aria-label="Sidebar source">
          <button class="related-tab ${relatedSource === 'related' ? 'active' : ''}" data-rt="related" role="tab">Up next</button>
          <button class="related-tab ${relatedSource === 'subs' ? 'active' : ''}" data-rt="subs" role="tab">Subs</button>
          <button class="related-tab ${relatedSource === 'history' ? 'active' : ''}" data-rt="history" role="tab">History</button>
        </div>
        <div class="related-header">
          <h2 class="section-title" id="related-active-label">${relatedSource === 'subs' ? 'Subs' : (relatedSource === 'history' ? 'History' : 'Up next')}</h2>
          <button class="related-toggle" id="related-layout" title="Layout: ${relatedMode}" aria-label="Cycle layout">
            ${relatedLayoutIcon(relatedMode)}
          </button>
          <button class="related-toggle" id="related-toggle" title="${relatedCollapsed ? 'Show sidebar' : 'Hide sidebar'}" aria-label="Toggle sidebar panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
        <div class="related" data-mode="${relatedMode}" data-src="${relatedSource}">
          ${relatedSource === 'related'
            ? (data.relatedStreams || []).slice(0, 16).map(relatedRow).join('')
            : '<div class="loader" style="padding:30px">Loading</div>'}
        </div>
      </div>
    </div>
  `;

  // --- Description toggle ---
  const descEl = view.querySelector('#video-desc');
  const descRaw = data.description || '';
  const renderDesc = (mode) => {
    if (mode === 'rich') {
      descEl.innerHTML = sanitizeDescription(descRaw);
    } else {
      // Raw: strip all HTML tags except <br>, then linkify plain-text URLs.
      // The visible text remains the raw URL, but it becomes clickable.
      const tmp = document.createElement('div');
      tmp.innerHTML = descRaw.replace(/<br\s*\/?>/gi, '\n');
      const plain = tmp.textContent || '';
      const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = URL_RE.exec(plain)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(plain.slice(last, m.index)));
        try {
          const u = new URL(m[0]);
          if (['http:', 'https:'].includes(u.protocol)) {
            const a = document.createElement('a');
            a.setAttribute('href', u.toString());
            a.classList.add('desc-link');
            a.textContent = m[0];
            frag.appendChild(a);
          } else frag.appendChild(document.createTextNode(m[0]));
        } catch {
          frag.appendChild(document.createTextNode(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < plain.length) frag.appendChild(document.createTextNode(plain.slice(last)));
      descEl.replaceChildren(frag);
    }
    descEl.querySelectorAll('a.desc-link').forEach(a => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const href = a.getAttribute('href');
        if (href) window.app.openExternal(href);
      };
    });
  };
  renderDesc(localStorage.getItem('desc-mode') || 'raw');
  view.querySelectorAll('.desc-toggle').forEach(btn => {
    btn.onclick = () => {
      const m = btn.dataset.mode;
      localStorage.setItem('desc-mode', m);
      view.querySelectorAll('.desc-toggle').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
      renderDesc(m);
    };
  });

  const v = view.querySelector('video');
  play(v, data);
  currentVideoId = id;

  // Always render the heatmap when data is available — the user's setting
  // toggles its visibility via CSS (:root[data-heatmap=off]) so changes apply
  // live without needing to re-render the video.
  // Accept any of the common field names yt-dlp / Piped may have used.
  const hmData = data.heatmap || data.mostReplayed || data.most_replayed || data.markers_map || null;
  if (hmData && hmData.length) {
    const hm = view.querySelector('#player-heatmap');
    if (hm) {
      const svg = buildHeatmapSVG(hmData);
      hm.innerHTML = svg;
      if (!svg) console.info('[heatmap] data present but failed to render', hmData.slice(0, 3));
    }
  } else {
    console.info('[heatmap] no Most-Replayed data on this video');
  }

  // --- Resume where left off ---
  const askResume = (currentSettings.askResume !== false);
  const saved = getResume(id);
  const eligible = askResume && saved && saved.position > 10
    && (!saved.duration || saved.position / saved.duration < 0.95);
  if (eligible) {
    const showWhenReady = () => showResumeBanner(saved.position, () => {
      const apply = () => { try { v.currentTime = saved.position; } catch (e) { console.warn('seek failed', e); } };
      if (v.readyState >= 1) apply();
      else v.addEventListener('loadedmetadata', apply, { once: true });
    });
    // Don't flash the banner over the still-black loading frame — that read
    // as "a weird rectangle sliding down behind the video while it loads".
    // Wait until the video can actually play; show immediately if it already
    // can. If `canplay` never arrives we simply skip the prompt.
    if (v.readyState >= 3) showWhenReady();
    else v.addEventListener('canplay', showWhenReady, { once: true });
  }

  // Save extra times for safety: on pause, on seek-finished
  v.addEventListener('pause', () => {
    if (v.duration && v.currentTime > 3 && v.currentTime / v.duration < 0.95) {
      setResume(id, v.currentTime, v.duration);
    }
  });

  // Click-to-seek on the themed progress strip (now the canonical timeline)
  const strip = view.querySelector('.player-progress-strip');
  const playerWrap = view.querySelector('#player-wrap');
  if (strip) {
    strip.onclick = (ev) => {
      if (!v.duration) return;
      const rect = strip.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      v.currentTime = ratio * v.duration;
    };

    // --- Hover seek preview ---
    // Floating tooltip that follows the cursor and shows the timestamp + a
    // thumbnail of where the video would jump to if clicked. The thumbnail
    // is a secondary <video> element that seeks (without playing) to the
    // hover position; the rendered frame acts as the thumbnail.
    let preview = playerWrap.querySelector('.seek-preview');
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'seek-preview';
      preview.innerHTML = `
        <div class="seek-preview-thumb-wrap">
          <img class="seek-preview-thumb-img" referrerpolicy="no-referrer" alt="" />
          <video class="seek-preview-thumb" muted preload="auto" playsinline></video>
        </div>
        <div class="seek-preview-time">0:00</div>
      `;
      playerWrap.appendChild(preview);
    }
    const previewTime  = preview.querySelector('.seek-preview-time');
    const previewThumb = preview.querySelector('.seek-preview-thumb');
    const previewImg   = preview.querySelector('.seek-preview-thumb-img');

    // Static fallback: always show the video's poster so hover always has
    // *some* thumbnail, even when MediaSource (DASH/HLS) blocks cloning
    // the live source into a second <video>.
    if (data.thumbnailUrl && previewImg) {
      previewImg.src = data.thumbnailUrl;
    }

    // The thumbnail <video> seeks to the hover position. Always use the
    // SMALLEST mp4 stream available (typically 144p–360p) — even if the main
    // player is on 1080p. That way the thumb loads/seeks fast, and we
    // don't fight to seek through a giant high-res stream.
    //
    // Fallback chain (in order of preference):
    //   1. Lowest-res muxed mp4 (has audio + video — but audio is muted anyway)
    //   2. Lowest-res video-only mp4 (no audio, but still a real frame source —
    //      this is the common case on modern YouTube where muxed streams are
    //      rare/absent and almost everything is split into video-only tracks)
    //   3. Main video's currentSrc if it's a direct URL (not blob/m3u8)
    //   4. Static poster image (data.thumbnailUrl) shown via the <img> layer
    let thumbReady = false;
    const allMp4 = (data.videoStreams || [])
      .filter(s => s.url && (s.mimeType || '').includes('mp4'));
    const lowResMuxed = allMp4
      .filter(s => !s.videoOnly)
      .sort((a, b) => (parseInt(a.quality) || 0) - (parseInt(b.quality) || 0))[0];
    const lowResVideoOnly = allMp4
      .filter(s => s.videoOnly)
      .sort((a, b) => (parseInt(a.quality) || 0) - (parseInt(b.quality) || 0))[0];

    const initThumb = () => {
      try {
        let thumbSrc = lowResMuxed?.url || lowResVideoOnly?.url || '';
        if (!thumbSrc) {
          const src = v.currentSrc || '';
          if (src && !src.startsWith('blob:') && !src.includes('.m3u8')) {
            thumbSrc = src;
          }
        }
        if (thumbSrc) {
          if (previewThumb.src !== thumbSrc) {
            previewThumb.src = thumbSrc;
            previewThumb.muted = true;
            previewThumb.preload = 'auto';
            previewThumb.load();
          }
          thumbReady = true;
          preview.classList.remove('no-thumb');
          preview.classList.remove('use-poster');
        } else {
          thumbReady = false;
          // Keep the poster visible — only hide the live-thumb <video>.
          preview.classList.add('use-poster');
          preview.classList.toggle('no-thumb', !data.thumbnailUrl);
        }
      } catch { /* ignore */ }
    };
    // Run once now, and again after the main video reports its codec/duration
    // (some renderers need that as a trigger).
    initThumb();
    v.addEventListener('loadedmetadata', initThumb);

    const fmtTime = (secs) => {
      if (!isFinite(secs) || secs < 0) secs = 0;
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = Math.floor(secs % 60);
      const pad = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    };

    // Throttle via requestAnimationFrame so the seek happens at most once per
    // frame — matches cursor movement smoothly without queuing up dozens of
    // seeks and choking the decoder.
    let pendingSeek = null;
    let rafScheduled = false;
    const seekThumb = (t) => {
      if (!thumbReady) return;
      pendingSeek = t;
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        try {
          if (previewThumb && pendingSeek != null) {
            previewThumb.currentTime = pendingSeek;
          }
        } catch {}
      });
    };

    const updatePreview = (ev) => {
      if (!v.duration) return;
      const rect = strip.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const t = ratio * v.duration;
      previewTime.textContent = fmtTime(t);
      const wrapRect = playerWrap.getBoundingClientRect();
      const rawX = ev.clientX - wrapRect.left;
      // Clamp the X used for the preview tooltip so it can't slide off the
      // player edges. The preview is 120px wide and centred on the cursor
      // (translateX(-50%)), so it needs 60px of room on each side. The hover
      // line just sits at the cursor and doesn't need clamping — but keeping
      // them in sync via the same variable is fine for our 120px tooltip.
      const half = 60;
      const x = Math.max(half, Math.min(wrapRect.width - half, rawX));
      playerWrap.style.setProperty('--seek-x', x + 'px');
      preview.classList.add('show');
      seekThumb(t);
    };
    strip.addEventListener('mousemove', updatePreview);
    strip.addEventListener('mouseenter', (e) => {
      playerWrap.classList.add('pb-hovered');
      updatePreview(e);
    });
    strip.addEventListener('mouseleave', () => {
      preview.classList.remove('show');
      playerWrap.classList.remove('pb-hovered');
    });
  }

  // --- Custom video controls (replace native) ---
  attachCustomControls(v, view, data);
  // Wire up the Comments/Chat tab bar and chat panel for this page.
  wireChatPanel();

  let lastResumeSave = 0;
  const pbFill = view.querySelector('#pb-fill');
  const pbBuffered = view.querySelector('#pb-buffered');
  const playerWrapEl = view.querySelector('#player-wrap');

  // rAF-driven progress updates instead of `timeupdate`. `timeupdate` only
  // fires ~4Hz and stops entirely while the video is buffering, which made
  // the progress bar feel laggy and look frozen mid-buffer. With rAF we get
  // smooth ~60Hz updates and the buffered-range indicator keeps moving even
  // when playback is stalled — so the user can see that data is loading.
  let pbRafId = null;
  let pbAlive = true;
  const updatePb = () => {
    if (!pbAlive) return;
    const d = v.duration;
    if (d) {
      if (pbFill) pbFill.style.width = ((v.currentTime / d) * 100).toFixed(3) + '%';
      if (pbBuffered && v.buffered && v.buffered.length) {
        // Use the buffered range that contains the current time, falling back
        // to the last range if the playhead is between gaps.
        let bufEnd = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          const start = v.buffered.start(i);
          const end = v.buffered.end(i);
          if (start <= v.currentTime && end > bufEnd) bufEnd = end;
        }
        if (!bufEnd) bufEnd = v.buffered.end(v.buffered.length - 1);
        pbBuffered.style.width = ((bufEnd / d) * 100).toFixed(3) + '%';
      }
    }
    pbRafId = requestAnimationFrame(updatePb);
  };
  pbRafId = requestAnimationFrame(updatePb);

  // Buffering visual: pulse the strip so the user has feedback that the
  // player isn't dead, just waiting on bytes. waiting/stalled add the class,
  // playing/canplay/seeked clear it.
  const onWaiting = () => playerWrapEl?.classList.add('buffering');
  const onResumed = () => playerWrapEl?.classList.remove('buffering');
  v.addEventListener('waiting', onWaiting);
  v.addEventListener('stalled', onWaiting);
  v.addEventListener('playing', onResumed);
  v.addEventListener('canplay', onResumed);
  v.addEventListener('seeked',  onResumed);

  v.addEventListener('emptied', () => {
    pbAlive = false;
    if (pbRafId) cancelAnimationFrame(pbRafId);
    v.removeEventListener('waiting', onWaiting);
    v.removeEventListener('stalled', onWaiting);
    v.removeEventListener('playing', onResumed);
    v.removeEventListener('canplay', onResumed);
    v.removeEventListener('seeked',  onResumed);
  }, { once: true });

  // Resume save still rides on `timeupdate` — it's throttled to 5s anyway so
  // the lower frequency is fine, and it only matters during playback.
  v.addEventListener('timeupdate', () => {
    const t = v.currentTime, d = v.duration;
    if (!d || t < 5) return;
    const now = Date.now();
    if (now - lastResumeSave >= 5000) {
      setResume(id, t, d);
      lastResumeSave = now;
    }
    if (t / d > 0.95) clearResume(id);
  });
  v.addEventListener('ended', () => clearResume(id));

  const subBtn = view.querySelector('#sub-btn');
  let currentlySubbed = subbed;
  subBtn.onclick = async () => {
    subBtn.disabled = true;
    try {
      if (isLoggedIn()) {
        if (currentlySubbed) await api.unsubscribe(channelId);
        else await api.subscribe(channelId);
        currentlySubbed = !currentlySubbed;
      } else {
        toggleLocalSub({ id: channelId, name: data.uploader });
        currentlySubbed = isLocallySubbed(channelId);
      }
      subBtn.textContent = currentlySubbed ? 'Subscribed' : 'Subscribe';
      subBtn.classList.toggle('subbed', currentlySubbed);
    } catch (e) {
      console.error(e);
    } finally {
      subBtn.disabled = false;
    }
  };

  // Bind row clicks within the related list. Called every time we re-render
  // the list (e.g. when the user switches sidebar source).
  const bindRelatedRowClicks = () => {
    view.querySelectorAll('.related .row').forEach(r => {
      r.onclick = () => go('video', r.dataset.id);
    });
  };
  bindRelatedRowClicks();

  // Sidebar source switching: Up next / Subs / History. Each shares the
  // .related container's layout (list/overlay/thumbs) and the relatedRow
  // formatter — only the items differ.
  const relatedListEl = view.querySelector('.related');
  // Generation counter so a slow Subs fetch can't stomp on a tab the user
  // has since switched away from.
  let sourceGen = 0;
  const renderSource = async (src) => {
    const gen = ++sourceGen;
    relatedSource = src;
    localStorage.setItem('related-source', src);
    relatedListEl.dataset.src = src;
    view.querySelectorAll('.related-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.rt === src);
    });
    const labelEl = view.querySelector('#related-active-label');
    if (labelEl) {
      labelEl.textContent = src === 'subs' ? 'Subs' : (src === 'history' ? 'History' : 'Up next');
    }

    if (src === 'related') {
      let items = (data.relatedStreams || []).slice(0, 16);
      // yt-dlp doesn't expose related videos, so when our primary data source
      // is yt-dlp the array is empty. Lazy-fetch from Piped only on demand
      // (per video, cached for the session) so the user actually gets a
      // populated Up next tab. Same fetch for users who got an empty array
      // from Piped — harmless retry.
      if (!items.length) {
        relatedListEl.innerHTML = `<div class="loader" style="padding:30px">Loading</div>`;
        items = await fetchSidebarRelated(id);
        if (gen !== sourceGen) return;
        // Stash on data so subsequent tab switches use the cached result
        // without another sessionStorage round trip.
        data.relatedStreams = items;
      }
      relatedListEl.innerHTML = items.length
        ? items.slice(0, 16).map(relatedRow).join('')
        : `<div class="empty-mini">No related videos</div>`;
      bindRelatedRowClicks();
      return;
    }

    if (src === 'history') {
      const items = getHistory().slice(0, 24).map(h => ({
        url: `https://youtube.com/watch?v=${h.id}`,
        title: h.title,
        thumbnail: h.thumbnail,
        duration: h.duration,
        uploaderName: h.uploaderName,
        views: h.views,
      }));
      relatedListEl.innerHTML = items.length
        ? items.map(relatedRow).join('')
        : `<div class="empty-mini">Nothing watched yet</div>`;
      bindRelatedRowClicks();
      return;
    }

    if (src === 'subs') {
      relatedListEl.innerHTML = `<div class="loader" style="padding:30px">Loading subscriptions</div>`;
      const items = await fetchSidebarSubs();
      // Bail if the user switched tabs while we were fetching.
      if (gen !== sourceGen) return;
      relatedListEl.innerHTML = items.length
        ? items.slice(0, 24).map(relatedRow).join('')
        : `<div class="empty-mini">No subscription videos</div>`;
      bindRelatedRowClicks();
      return;
    }
  };
  view.querySelectorAll('.related-tab').forEach(t => {
    t.addEventListener('click', () => renderSource(t.dataset.rt));
  });
  // If the user previously selected Subs/History, the static initial HTML
  // showed a loader — kick off the actual render now.
  if (relatedSource !== 'related') renderSource(relatedSource);

  const toggle = view.querySelector('#related-toggle');
  const playerPage = view.querySelector('.player-page');
  toggle.onclick = () => {
    const nowCollapsed = playerPage.classList.toggle('related-collapsed');
    localStorage.setItem('related-collapsed', nowCollapsed ? '1' : '0');
    toggle.title = nowCollapsed ? 'Show sidebar' : 'Hide sidebar';
  };

  const commentsToggle = view.querySelector('#comments-toggle');
  if (commentsToggle) {
    commentsToggle.onclick = () => {
      const nowCollapsed = playerPage.classList.toggle('comments-collapsed');
      localStorage.setItem('comments-collapsed', nowCollapsed ? '1' : '0');
      commentsToggle.title = nowCollapsed ? 'Show comments' : 'Hide comments';
      // Lazy-load comments the first time the user expands the panel
      if (!nowCollapsed && !view.dataset.commentsLoaded) {
        loadComments(id);
      }
    };
  }
  // If the user starts with comments expanded, kick off the fetch immediately
  if (!commentsCollapsed) loadComments(id);

  // ---- Comment composer ----
  // If the user is signed in to Google with the comment scope, posts go
  // straight to YouTube via the Data API. Otherwise we fall back to copying
  // the draft to the clipboard and opening the video page so they can paste.
  const composer = view.querySelector('#comment-composer');
  if (composer) {
    const ta     = composer.querySelector('#cc-input');
    const cancel = composer.querySelector('#cc-cancel');
    const post   = composer.querySelector('#cc-post');
    const hint   = composer.querySelector('.comment-composer-hint');

    // Refresh the hint based on current sign-in state.
    const refreshHint = async () => {
      try {
        const s = await window.app?.google?.status();
        if (s?.signedIn) {
          hint.textContent = 'Posts directly to YouTube as you.';
          hint.classList.add('signed-in');
        } else {
          hint.textContent = 'Sign in (account menu) to post directly, or we\'ll copy & open YouTube.';
          hint.classList.remove('signed-in');
        }
      } catch { /* offline / not wired up */ }
    };
    refreshHint();

    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(180, ta.scrollHeight) + 'px';
    };
    const setActive = (on) => {
      composer.classList.toggle('active', on);
      autosize();
      if (on) refreshHint();
    };
    ta.addEventListener('focus', () => setActive(true));
    ta.addEventListener('input', autosize);
    cancel.onclick = () => {
      ta.value = '';
      ta.blur();
      setActive(false);
    };

    let posting = false;
    const flash = (msg, dur = 1600) => {
      post.textContent = msg;
      setTimeout(() => { post.textContent = 'Comment'; }, dur);
    };
    post.onclick = async () => {
      if (posting) return;
      const text = ta.value.trim();
      if (!text) {
        ta.focus();
        return;
      }
      // Try direct post via Google OAuth first.
      const status = await window.app?.google?.status?.();
      if (status?.signedIn) {
        posting = true;
        post.disabled = true;
        post.textContent = 'Posting…';
        try {
          const res = await window.app.google.postComment(id, text);
          if (res?.ok) {
            ta.value = '';
            setActive(false);
            // Optimistically prepend the new comment to the visible list so
            // the user sees their post immediately (the API doesn't always
            // include it in the next /comments fetch right away).
            const list = view.querySelector('#comments-list');
            if (list) {
              const c = res.comment || {};
              const node = document.createElement('div');
              node.className = 'comment-row';
              node.innerHTML = `
                <img class="comment-avatar" src="${escapeAttr(c.avatar || '')}" referrerpolicy="no-referrer" alt="" />
                <div class="comment-body">
                  <div class="comment-meta">
                    <strong>${escape(c.author || 'You')}</strong>
                    <span class="comment-time">just now</span>
                    <span class="comment-pinned">YOU</span>
                  </div>
                  <div class="comment-text">${escape(c.text || text)}</div>
                </div>
              `;
              list.prepend(node);
            }
            flash('Posted ✓');
          } else {
            console.warn('postComment failed:', res?.error);
            flash('Failed — falling back', 2200);
            await fallbackPost(text);
          }
        } catch (e) {
          console.warn('postComment threw:', e);
          flash('Failed — falling back', 2200);
          await fallbackPost(text);
        } finally {
          posting = false;
          post.disabled = false;
        }
      } else {
        await fallbackPost(text);
      }
    };

    async function fallbackPost(text) {
      const url = `https://www.youtube.com/watch?v=${id}`;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          flash('Copied — paste on YouTube', 2200);
        } else {
          flash('Opening YouTube…');
        }
      } catch {
        flash('Opening YouTube…');
      }
      window.app?.openExternal?.(url);
    }
  }

  // Track when comments is rendered "below" the player vs as a side panel.
  // Only switches to below-banner when EXPLICITLY chosen — auto/side both
  // keep it as a left side tab, mirroring Up next on the right.
  const updateCommentsMode = () => {
    const placement = currentSettings.commentsPlacement || 'side';
    if (placement === 'below') playerPage.setAttribute('data-cmode-below', '');
    else playerPage.removeAttribute('data-cmode-below');
  };
  updateCommentsMode();
  window.addEventListener('resize', updateCommentsMode);

  // Make the entire collapsed sliver a click target — clicking anywhere on
  // the tab expands it, not just the chevron icon.
  const relatedCol  = view.querySelector('.related-col');
  const commentsCol = view.querySelector('.comments-col');
  if (relatedCol) {
    relatedCol.addEventListener('click', (e) => {
      if (!playerPage.classList.contains('related-collapsed')) return;
      if (e.target.closest('button')) return;  // chevron handles its own click
      toggle.click();
    });
  }
  if (commentsCol && commentsToggle) {
    commentsCol.addEventListener('click', (e) => {
      if (!playerPage.classList.contains('comments-collapsed')) return;
      if (e.target.closest('button')) return;
      commentsToggle.click();
    });
  }

  // ---------- Merge / split / tab switching ----------
  const setMerge = (side) => {
    // Clear any collapsed states — they don't make sense when merged
    playerPage.classList.remove('related-collapsed', 'comments-collapsed');
    localStorage.setItem('related-collapsed', '0');
    localStorage.setItem('comments-collapsed', '0');
    playerPage.dataset.merged = side;
    // When user clicks merge on related panel (right), bring comments in as
    // active tab; vice versa for left.
    const initialTab = side === 'right' ? 'comments' : 'related';
    playerPage.dataset.activeTab = initialTab;
    localStorage.setItem('panel-merged', side);
    localStorage.setItem('panel-active-tab', initialTab);
    syncTabActive();
  };
  const splitPanels = () => {
    playerPage.removeAttribute('data-merged');
    playerPage.removeAttribute('data-active-tab');
    localStorage.removeItem('panel-merged');
    localStorage.removeItem('panel-active-tab');
  };
  const setActiveTab = (target) => {
    playerPage.dataset.activeTab = target;
    localStorage.setItem('panel-active-tab', target);
    syncTabActive();
  };
  const syncTabActive = () => {
    const active = playerPage.dataset.activeTab;
    view.querySelectorAll('.panel-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.ptTarget === active);
    });
  };

  view.querySelector('#comments-merge')?.addEventListener('click', () => setMerge('left'));
  view.querySelector('#related-merge')?.addEventListener('click', () => setMerge('right'));
  view.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.ptTarget));
  });
  view.querySelectorAll('.panel-tab-split').forEach(btn => {
    btn.addEventListener('click', splitPanels);
  });

  // ---------- Merged-panel collapse ----------
  const setMergedCollapsed = (collapsed) => {
    playerPage.classList.toggle('merged-collapsed', collapsed);
    localStorage.setItem('merged-collapsed', collapsed ? '1' : '0');
  };
  view.querySelectorAll('.panel-collapse').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMergedCollapsed(!playerPage.classList.contains('merged-collapsed'));
    });
  });
  // Click anywhere on the collapsed merged sliver to expand
  [relatedCol, commentsCol].forEach(col => {
    if (!col) return;
    col.addEventListener('click', (e) => {
      if (!playerPage.classList.contains('merged-collapsed')) return;
      if (e.target.closest('button')) return;
      setMergedCollapsed(false);
    });
  });

  // Restore saved merge state
  const savedMerge = localStorage.getItem('panel-merged');
  if (savedMerge) {
    playerPage.dataset.merged = savedMerge;
    const savedActive = localStorage.getItem('panel-active-tab') || (savedMerge === 'right' ? 'related' : 'comments');
    playerPage.dataset.activeTab = savedActive;
    syncTabActive();
    if (localStorage.getItem('merged-collapsed') === '1') {
      playerPage.classList.add('merged-collapsed');
    }
  }

  // Drag-and-drop: drag a panel header onto the other column to merge
  const commentsHeader = view.querySelector('.comments-header');
  const relatedHeader  = view.querySelector('.related-header');
  if (commentsHeader) commentsHeader.draggable = true;
  if (relatedHeader)  relatedHeader.draggable  = true;
  const wireDrag = (header, which) => {
    if (!header) return;
    header.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', which);
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dragging-panel');
    });
    header.addEventListener('dragend', () => {
      document.body.classList.remove('dragging-panel');
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });
  };
  wireDrag(commentsHeader, 'comments');
  wireDrag(relatedHeader,  'related');
  const wireDrop = (col, isComments) => {
    if (!col) return;
    col.addEventListener('dragover', (e) => {
      const src = e.dataTransfer?.types?.[0];
      if (!document.body.classList.contains('dragging-panel')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drop-target');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop-target');
      const source = e.dataTransfer.getData('text/plain');
      if (source === 'comments' && !isComments) setMerge('right');
      else if (source === 'related' && isComments) setMerge('left');
    });
  };
  wireDrop(commentsCol, true);
  wireDrop(relatedCol,  false);

  const layoutBtn = view.querySelector('#related-layout');
  layoutBtn.onclick = () => {
    const cur = view.querySelector('.related').dataset.mode || 'list';
    const next = RELATED_MODES[(RELATED_MODES.indexOf(cur) + 1) % RELATED_MODES.length];
    view.querySelector('.related').dataset.mode = next;
    layoutBtn.innerHTML = relatedLayoutIcon(next);
    layoutBtn.title = `Layout: ${next}`;
    localStorage.setItem('related-mode', next);
  };

  // Wire channel link → channel page
  const channelLink = view.querySelector('#channel-link');
  if (channelLink && channelId) {
    channelLink.onclick = () => go('channel', channelId);
  }

  // Wire download button
  const dlBtn = view.querySelector('#dl-btn');
  if (dlBtn) dlBtn.onclick = () => downloadCurrentVideo(id);

  // Fetch channel info: avatar for the channel-row + related backfill if ytdlp.
  if (channelId) {
    api.channel(channelId).then(ch => {
      // Avatar
      const avatarEl = view.querySelector('#channel-avatar');
      if (avatarEl && ch.avatarUrl) avatarEl.src = ch.avatarUrl;
      // Related backfill (only when yt-dlp didn't supply any)
      if (source === 'ytdlp') {
        const related = (ch.relatedStreams || [])
          .filter(r => videoIdFromUrl(r.url) !== id)
          .slice(0, 16);
        const container = view.querySelector('.related');
        if (container && related.length) {
          container.innerHTML = related.map(relatedRow).join('');
          container.querySelectorAll('.row').forEach(r => {
            r.onclick = () => go('video', r.dataset.id);
          });
        }
      }
    }).catch(() => { /* leave avatar/related empty */ });
  }
}

async function renderChannel(id) {
  const ch = await api.channel(id);
  // Piped sometimes serves a channel with an empty relatedStreams while
  // still returning name/avatar/banner. Fall back to yt-dlp so the page
  // doesn't show "No videos to show." when there clearly are some.
  let initialItems = [...(ch.relatedStreams || [])];
  let initialNext = ch.nextpage || null;
  if (!initialItems.length && ytdlpReady) {
    try {
      const r = await window.app.ytdlp.getChannelVideos(id, 30);
      if (r?.ok && Array.isArray(r.items) && r.items.length) {
        initialItems = r.items;
        // yt-dlp gives us a fixed batch — no Piped nextpage token applies.
        // Pagination via "Load more" is disabled for yt-dlp-sourced views.
        initialNext = null;
      }
    } catch { /* ignore — render whatever we have */ }
  }
  // Stateful: items grow as the user loads more pages; the active sort
  // determines render order each time.
  const state = {
    items: initialItems,
    nextpage: initialNext,
    sort: 'latest',
    loading: false,
  };

  const SORTS = [
    { key: 'latest',  label: 'Latest'  },
    { key: 'popular', label: 'Popular' },
    { key: 'oldest',  label: 'Oldest'  },
  ];

  const sortItems = (items, sort) => {
    const arr = [...items];
    if (sort === 'popular') arr.sort((a, b) => (b.views || 0) - (a.views || 0));
    else if (sort === 'oldest') arr.sort((a, b) => (a.uploaded || 0) - (b.uploaded || 0));
    else arr.sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0));
    return arr;
  };

  view.innerHTML = `
    <div class="channel-page">
      ${ch.bannerUrl ? `<div class="channel-banner"><img src="${escapeAttr(ch.bannerUrl)}" alt="" /></div>` : ''}
      <div class="channel-info">
        ${ch.avatarUrl ? `<img class="channel-avatar" src="${escapeAttr(ch.avatarUrl)}" alt="" />` : `<div class="channel-avatar"></div>`}
        <div class="channel-meta">
          <h1>${escape(ch.name || '')}</h1>
          <div class="channel-stats">${ch.subscriberCount != null ? fmtNumber(ch.subscriberCount) + ' subscribers' : ''}${state.items.length ? ' · ' + state.items.length + ' videos' : ''}</div>
          ${ch.description ? `<div class="channel-desc">${escape(ch.description)}</div>` : ''}
        </div>
      </div>
      ${state.items.length ? `
        <div class="channel-filters" role="tablist" aria-label="Sort videos">
          ${SORTS.map(s => `<button class="channel-filter ${s.key === state.sort ? 'active' : ''}" data-sort="${s.key}" role="tab" aria-selected="${s.key === state.sort}">${s.label}</button>`).join('')}
        </div>
        <div class="grid" id="channel-grid"></div>
        <div class="channel-loadmore">
          <button id="ch-load-more" class="loadmore-btn"${state.nextpage ? '' : ' hidden'}>Load more videos</button>
          <div class="loadmore-status" id="ch-load-status" aria-live="polite"></div>
        </div>
      ` : `<div class="empty">No videos to show.</div>`}
    </div>
  `;

  const gridEl = view.querySelector('#channel-grid');
  const moreBtn = view.querySelector('#ch-load-more');
  const statusEl = view.querySelector('#ch-load-status');

  const renderGrid = () => {
    if (!gridEl) return;
    gridEl.innerHTML = sortItems(state.items, state.sort).map(videoCard).join('');
    attachCardClicks();
  };
  renderGrid();

  view.querySelectorAll('.channel-filter').forEach(btn => {
    btn.onclick = () => {
      if (state.sort === btn.dataset.sort) return;
      state.sort = btn.dataset.sort;
      view.querySelectorAll('.channel-filter').forEach(b => {
        const on = b.dataset.sort === state.sort;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderGrid();
    };
  });

  if (moreBtn) {
    moreBtn.onclick = async () => {
      if (state.loading || !state.nextpage) return;
      state.loading = true;
      moreBtn.disabled = true;
      const prevLabel = moreBtn.textContent;
      moreBtn.textContent = 'Loading…';
      try {
        const next = await api.channelNext(id, state.nextpage);
        const newItems = next?.relatedStreams || [];
        state.items.push(...newItems);
        state.nextpage = next?.nextpage || null;
        renderGrid();
        if (!state.nextpage) {
          moreBtn.hidden = true;
          if (statusEl) statusEl.textContent = 'No more videos.';
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Could not load more videos.';
      } finally {
        state.loading = false;
        moreBtn.disabled = false;
        moreBtn.textContent = prevLabel;
      }
    };
  }
}

// ---------- Card templates ----------
function videoCard(item) {
  const id = videoIdFromUrl(item.url);
  return `
    <div class="card" data-id="${id}">
      <div class="thumb">
        <img src="${escapeAttr(item.thumbnail || '')}" loading="lazy" referrerpolicy="no-referrer" alt="" />
        <div class="duration">${fmtDuration(item.duration)}</div>
      </div>
      <div class="meta">
        <div class="title">${escape(item.title || '')}</div>
        <div class="sub"><span class="ch">${escape(item.uploaderName || '')}</span>${item.views != null ? '<span class="dot">·</span>' + fmtViews(item.views) : ''}</div>
      </div>
    </div>
  `;
}

// Lazy-fetch related videos from Piped for the sidebar "Up next" tab.
// Needed because the yt-dlp data path returns relatedStreams: [] (yt-dlp
// doesn't expose related videos), so without this the Up next tab is
// permanently empty whenever yt-dlp is the primary fetcher. Cached by
// video id in sessionStorage for the duration of the session.
async function fetchSidebarRelated(videoId) {
  if (!videoId) return [];
  const KEY = `sidebar-related:${videoId}`;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  let items = [];
  try {
    const piped = await api.streams(videoId);
    if (piped && Array.isArray(piped.relatedStreams)) items = piped.relatedStreams;
  } catch {}
  try { sessionStorage.setItem(KEY, JSON.stringify(items)); } catch {}
  return items;
}

// Aggregate the latest videos from the user's subscriptions for the sidebar
// "Subs" tab. Cached in sessionStorage with a 5-minute TTL so flipping tabs
// doesn't re-trigger the (expensive, parallel-fanout) channel fetches.
async function fetchSidebarSubs() {
  const CACHE_KEY = 'sidebar-subs-feed';
  const TTL_MS = 5 * 60 * 1000;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && (Date.now() - parsed.t) < TTL_MS && Array.isArray(parsed.items)) {
        return parsed.items;
      }
    }
  } catch {}

  let items = [];
  if (isLoggedIn()) {
    try {
      const feed = await api.feed();
      if (Array.isArray(feed)) items = feed;
    } catch {}
  } else {
    const subs = getLocalSubs();
    if (subs.length) {
      const all = [];
      await Promise.all(subs.map(async c => {
        try {
          const ch = await api.channel(c.id);
          for (const r of (ch.relatedStreams || []).slice(0, 4)) all.push(r);
        } catch {}
      }));
      all.sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0));
      items = all;
    }
  }

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), items }));
  } catch {}
  return items;
}

function relatedRow(item) {
  const id = videoIdFromUrl(item.url);
  return `
    <div class="row" data-id="${id}">
      <div class="thumb">
        <img src="${escapeAttr(item.thumbnail || '')}" loading="lazy" referrerpolicy="no-referrer" alt="" />
        <div class="duration">${fmtDuration(item.duration)}</div>
      </div>
      <div class="info">
        <div class="title">${escape(item.title || '')}</div>
        <div class="sub"><span class="ch">${escape(item.uploaderName || '')}</span>${item.views != null ? '<span class="dot">·</span>' + fmtViews(item.views) : ''}</div>
      </div>
    </div>
  `;
}

function attachCardClicks() {
  view.querySelectorAll('.card').forEach(c => {
    c.onclick = () => go('video', c.dataset.id);
  });
}

// Whitelist parser for video descriptions: keep only <a href> and <br>.
// Hrefs are validated as http/https URLs; everything else is collapsed to text.
// Existing <a> tags are rewritten so their visible text is the raw URL itself,
// then any leftover plain-text URLs are auto-linked.
function sanitizeDescription(rawHtml) {
  const tmpl = document.createElement('template');
  tmpl.innerHTML = String(rawHtml || '');
  const walk = (parent) => {
    [...parent.childNodes].forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); return; }
      const tag = child.tagName;
      if (tag === 'BR') { walk(child); return; }
      if (tag === 'A') {
        const href = child.getAttribute('href') || '';
        try {
          const u = new URL(href);
          if (!['http:', 'https:'].includes(u.protocol)) {
            child.replaceWith(document.createTextNode(child.textContent));
            return;
          }
          [...child.attributes].forEach(a => child.removeAttribute(a.name));
          const finalHref = u.toString();
          child.setAttribute('href', finalHref);
          child.classList.add('desc-link');
          // Show the raw URL as the visible text (instead of Piped's friendly label).
          child.textContent = finalHref;
        } catch {
          child.replaceWith(document.createTextNode(child.textContent));
          return;
        }
        return;
      }
      // Unknown element: replace with its plain text
      child.replaceWith(document.createTextNode(child.textContent));
    });
  };
  walk(tmpl.content);

  // Auto-link any plain-text URLs in remaining text nodes.
  const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
  const linkifyTextNodes = (parent) => {
    [...parent.childNodes].forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'A') return; // don't double-link
        linkifyTextNodes(child);
        return;
      }
      if (child.nodeType !== Node.TEXT_NODE) return;
      const text = child.nodeValue;
      if (!text || !URL_RE.test(text)) return;
      URL_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = URL_RE.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        try {
          const u = new URL(m[0]);
          if (['http:', 'https:'].includes(u.protocol)) {
            const a = document.createElement('a');
            a.setAttribute('href', u.toString());
            a.classList.add('desc-link');
            a.textContent = m[0];
            frag.appendChild(a);
          } else {
            frag.appendChild(document.createTextNode(m[0]));
          }
        } catch {
          frag.appendChild(document.createTextNode(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      child.replaceWith(frag);
    });
  };
  linkifyTextNodes(tmpl.content);

  return tmpl.innerHTML;
}

function parseAgo(s) {
  if (!s) return Number.MAX_SAFE_INTEGER;
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const sec = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[u] || 0;
  return n * sec;  // smaller = newer
}

function renderCommentList(items, list, sort) {
  let sorted = items.slice();
  if (sort === 'pinned') {
    sorted = sorted.filter(c => c.pinned);
    if (!sorted.length) {
      list.innerHTML = `<div class="empty" style="padding:30px">No pinned comments on this video.</div>`;
      return;
    }
  } else if (sort === 'top') sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  else if (sort === 'new') sorted.sort((a, b) => parseAgo(a.commentedTime) - parseAgo(b.commentedTime));
  else if (sort === 'replies') sorted.sort((a, b) => (b.replyCount || 0) - (a.replyCount || 0));

  list.innerHTML = sorted.slice(0, 100).map(c => `
    <div class="comment">
      ${c.thumbnail ? `<img class="comment-avatar" src="${escapeAttr(c.thumbnail)}" referrerpolicy="no-referrer" alt="" />` : `<div class="comment-avatar"></div>`}
      <div class="comment-body">
        <div class="comment-meta">
          <strong>${escape(c.author || '')}</strong>
          <span class="comment-time">${escape(c.commentedTime || '')}</span>
          ${c.pinned ? `<span class="comment-pinned">pinned</span>` : ''}
          ${c.hearted ? `<span class="comment-hearted" title="Loved by creator">♥</span>` : ''}
        </div>
        <div class="comment-text">${sanitizeDescription(c.commentText || '')}</div>
        <div class="comment-stats">
          ${c.likeCount != null ? `${fmtNumber(c.likeCount)} likes` : ''}${c.replyCount ? ` · ${c.replyCount} replies` : ''}
        </div>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('a.desc-link').forEach(a => {
    a.onclick = (ev) => {
      ev.preventDefault();
      const href = a.getAttribute('href');
      if (href) window.app.openExternal(href);
    };
  });
}

async function loadComments(videoId) {
  const list = view.querySelector('#comments-list');
  if (!list) return;
  view.dataset.commentsLoaded = '1';
  try {
    const data = await api.comments(videoId);
    const items = data?.comments || [];
    if (!items.length) {
      list.innerHTML = `<div class="empty" style="padding:30px">No comments.</div>`;
      return;
    }
    renderCommentList(items, list, 'top');

    // Wire filter pills
    view.querySelectorAll('.comment-filter').forEach(btn => {
      btn.onclick = () => {
        view.querySelectorAll('.comment-filter').forEach(b => b.classList.toggle('active', b === btn));
        renderCommentList(items, list, btn.dataset.sort);
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="empty" style="padding:30px;color:#fca5a5">Couldn't load comments.</div>`;
  }
}

function attachCustomControls(v, root, data = {}) {
  const wrap = root.querySelector('#player-wrap');
  const playBtn = root.querySelector('#cc-play');
  const muteBtn = root.querySelector('#cc-mute');
  const volSlider = root.querySelector('#cc-volume');
  const timeEl  = root.querySelector('#cc-time');
  const fsBtn   = root.querySelector('#cc-fullscreen');
  if (!wrap) return;

  const togglePlay = () => { v.paused ? v.play() : v.pause(); };
  playBtn.onclick = (e) => { e.stopPropagation(); togglePlay(); };
  v.addEventListener('click', togglePlay);
  v.addEventListener('dblclick', () => toggleFs());

  v.addEventListener('play',  () => wrap.classList.add('playing'));
  v.addEventListener('pause', () => wrap.classList.remove('playing'));

  v.addEventListener('timeupdate', () => {
    if (v.duration) {
      timeEl.textContent = `${fmtDuration(Math.floor(v.currentTime))} / ${fmtDuration(Math.floor(v.duration))}`;
    }
  });

  // Volume — restore last
  const savedVol = parseFloat(localStorage.getItem('cc-volume') || '1');
  v.volume = isFinite(savedVol) ? savedVol : 1;
  volSlider.value = v.volume;
  // HD playback uses a video-only stream + a sidecar <audio> element, so the
  // <video> itself is permanently `muted` (sound comes from the sidecar).
  // The old icon logic keyed off v.muted, so it ALWAYS showed the muted
  // speaker during HD playback even though audio was clearly playing. The
  // honest signal is "is there actually any sound" — i.e. volume 0, or, when
  // there's NO sidecar, the native muted flag. Mute is modelled as volume 0
  // (with memory) so it works identically for sidecar and direct playback —
  // player.js mirrors v.volume onto the sidecar on every volumechange.
  const isMuted = () => v.volume === 0 || (!v._audio && v.muted);
  let preMuteVol = null;
  const updateMuteIcon = () => wrap.classList.toggle('muted', isMuted());
  volSlider.oninput = () => {
    v.volume = Number(volSlider.value);
    if (!v._audio) v.muted = v.volume === 0;
    localStorage.setItem('cc-volume', String(v.volume));
    updateMuteIcon();
  };
  muteBtn.onclick = (e) => {
    e.stopPropagation();
    if (isMuted()) {
      const restore = (preMuteVol && preMuteVol > 0) ? preMuteVol : 0.5;
      v.volume = restore;
      volSlider.value = restore;
      if (!v._audio) v.muted = false;
    } else {
      preMuteVol = v.volume || 0.5;
      v.volume = 0;
      volSlider.value = 0;
      if (!v._audio) v.muted = true;
    }
    localStorage.setItem('cc-volume', String(v.volume));
    updateMuteIcon();
    updateVerticalFill();
  };
  updateMuteIcon();

  // --- Vertical volume slider on the left ---
  const volTrack = root.querySelector('#vol-track');
  const volFill  = root.querySelector('#vol-fill');
  const volInd   = root.querySelector('#vol-indicator');
  // Separate timers so wheel-hide and indicator-hide don't clobber each other.
  let indHideTimer = null;
  let volActiveHideTimer = null;

  const updateVerticalFill = () => {
    if (!volFill) return;
    const pct = (isMuted() ? 0 : v.volume) * 100;
    volFill.style.height = pct.toFixed(1) + '%';
  };
  const flashIndicator = () => {
    if (!volInd) return;
    volInd.textContent = (isMuted() ? 0 : Math.round(v.volume * 100)) + '%';
    volInd.classList.add('show');
    clearTimeout(indHideTimer);
    indHideTimer = setTimeout(() => volInd.classList.remove('show'), 900);
  };

  const setVolFromY = (clientY) => {
    if (!volTrack) return;
    const rect = volTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    v.muted = false;
    v.volume = ratio;
    volSlider.value = ratio;
    localStorage.setItem('cc-volume', String(ratio));
    updateMuteIcon();
    updateVerticalFill();
    flashIndicator();
  };
  if (volTrack) {
    let dragging = false;
    volTrack.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      wrap.classList.add('vol-active');
      setVolFromY(e.clientY);
    });
    window.addEventListener('mousemove', (e) => { if (dragging) setVolFromY(e.clientY); });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      setTimeout(() => wrap.classList.remove('vol-active'), 600);
    });
  }

  // Wheel anywhere over the player → adjust volume
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.05 : -0.05;
    v.volume = Math.max(0, Math.min(1, v.volume + step));
    if (v.volume > 0) v.muted = false;
    volSlider.value = v.volume;
    localStorage.setItem('cc-volume', String(v.volume));
    wrap.classList.add('vol-active');
    clearTimeout(volActiveHideTimer);
    volActiveHideTimer = setTimeout(() => wrap.classList.remove('vol-active'), 1200);
    updateMuteIcon();
    updateVerticalFill();
    flashIndicator();
  }, { passive: false });

  // Keep visuals in sync with any volume change source (HLS, keyboard, etc.)
  v.addEventListener('volumechange', () => { updateMuteIcon(); updateVerticalFill(); });
  updateVerticalFill();

  // Fullscreen
  const toggleFs = () => {
    if (!document.fullscreenElement) wrap.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  fsBtn.onclick = (e) => { e.stopPropagation(); toggleFs(); };

  // Keyboard shortcuts (only when not typing in an input)
  // Spacebar: tap = play/pause toggle, hold = 2x speed while held.
  let spaceHoldTimer = null;
  let spaceHeldFastForward = false;
  let spacePrevRate = 1;
  const onKey = (e) => {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (e.repeat) return;     // ignore the OS auto-repeats
      // Start a 220ms timer; if still down when it fires, switch to 2x.
      spaceHoldTimer = setTimeout(() => {
        spaceHoldTimer = null;
        spaceHeldFastForward = true;
        spacePrevRate = v.playbackRate || 1;
        v.playbackRate = 2;
        wrap.classList.add('ff-2x');
      }, 220);
    }
    else if (e.key === 'f' || e.key === 'F') { toggleFs(); }
    else if (e.key === 'm' || e.key === 'M') { muteBtn.click(); }
    else if (e.key === 'ArrowLeft' && !e.altKey)  { v.currentTime = Math.max(0, v.currentTime - 5); }
    else if (e.key === 'ArrowRight') { v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); }
  };
  const onKeyUp = (e) => {
    if (e.key !== ' ') return;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    if (spaceHoldTimer) {
      // Quick tap — toggle play/pause and never entered ff mode.
      clearTimeout(spaceHoldTimer);
      spaceHoldTimer = null;
      togglePlay();
    } else if (spaceHeldFastForward) {
      // Release after hold — restore previous rate.
      spaceHeldFastForward = false;
      v.playbackRate = spacePrevRate || 1;
      wrap.classList.remove('ff-2x');
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup',   onKeyUp);
  // Clean up listeners when video unmounts
  v.addEventListener('emptied', () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup',   onKeyUp);
  }, { once: true });

  // Side volume slider is no longer shown on hover — it only flashes when
  // the user actively scrolls the wheel (vol-active class, set above).

  // Auto-hide: show on mouse move, hide after 2.2s of no movement while playing
  let hideTimer;
  const showControls = () => {
    wrap.classList.add('controls-visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!v.paused) wrap.classList.remove('controls-visible');
    }, 2200);
  };
  wrap.addEventListener('mousemove', showControls);
  wrap.addEventListener('mouseleave', () => {
    if (!v.paused) wrap.classList.remove('controls-visible');
  });
  showControls();  // start visible

  // --- Player options popover (gear button) ---
  const optBtn   = root.querySelector('#cc-options');
  const optPanel = root.querySelector('#cc-options-panel');
  if (optBtn && optPanel) {
    const closePanel = () => optPanel.classList.remove('show');
    optBtn.onclick = (e) => {
      e.stopPropagation();
      optPanel.classList.toggle('show');
    };
    optPanel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closePanel);

    optPanel.querySelectorAll('.theme-pill[data-cc-pb]').forEach(btn => {
      btn.onclick = () => {
        optPanel.querySelectorAll('.theme-pill[data-cc-pb]').forEach(b => b.classList.toggle('active', b === btn));
        currentSettings.playbarStyle = btn.dataset.ccPb;
        applySettings(currentSettings);
        saveSettings(currentSettings);
      };
    });
    optPanel.querySelectorAll('.cc-color-pill[data-pcol]').forEach(btn => {
      btn.onclick = () => {
        optPanel.querySelectorAll('.cc-color-pill[data-pcol]').forEach(b => b.classList.toggle('active', b === btn));
        currentSettings.playbarColor = btn.dataset.pcol;
        applySettings(currentSettings);
        saveSettings(currentSettings);
      };
    });
    const setCcFill = (input) => {
      const min = Number(input.min) || 0;
      const max = Number(input.max) || 100;
      const v = Number(input.value);
      input.style.setProperty('--cc-fill', (((v - min) / (max - min)) * 100) + '%');
    };
    const wirePbH = (id, key, valEl) => {
      const input = optPanel.querySelector('#' + id);
      const val   = optPanel.querySelector('#' + valEl);
      if (!input) return;
      setCcFill(input);
      input.oninput = () => {
        const v = Number(input.value);
        val.textContent = v + 'px';
        setCcFill(input);
        currentSettings[key] = v;
        applySettings(currentSettings);
        saveSettings(currentSettings);
      };
    };
    wirePbH('cc-pb-h',  'playbarHeight',      'cc-pb-h-val');
    wirePbH('cc-pb-hh', 'playbarHeightHover', 'cc-pb-hh-val');
    const heatToggle = optPanel.querySelector('#cc-heatmap-toggle');
    if (heatToggle) {
      heatToggle.onchange = () => {
        currentSettings.showHeatmap = heatToggle.checked;
        applySettings(currentSettings);
        saveSettings(currentSettings);
      };
    }

    // ---------- Speed pills ----------
    const speedRow = optPanel.querySelector('#cc-opt-speed');
    if (speedRow) {
      const markActive = () => {
        const cur = String(v.playbackRate || 1);
        speedRow.querySelectorAll('[data-cc-speed]').forEach(b => {
          b.classList.toggle('active', b.dataset.ccSpeed === cur);
        });
      };
      markActive();
      speedRow.querySelectorAll('[data-cc-speed]').forEach(btn => {
        btn.onclick = () => {
          v.playbackRate = Number(btn.dataset.ccSpeed);
          markActive();
        };
      });
      v.addEventListener('ratechange', markActive);
    }

    // ---------- Resolution dropdown ----------
    // For HLS via hls.js: switch hls.currentLevel.
    // For progressive (muxed) streams: swap video.src to the chosen URL.
    const resDrop = optPanel.querySelector('#cc-opt-res');
    if (resDrop) {
      const resBtn   = resDrop.querySelector('.cc-dropdown-btn');
      const resLabel = resDrop.querySelector('.cc-dropdown-label');
      const resList  = resDrop.querySelector('.cc-dropdown-list');
      const closeRes = () => resDrop.classList.remove('open');
      resBtn.onclick = (e) => {
        e.stopPropagation();
        // Close the subtitles dropdown if it's open
        const ccDrop = optPanel.querySelector('#cc-opt-cc');
        if (ccDrop) ccDrop.classList.remove('open');
        resDrop.classList.toggle('open');
      };
      resList.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', closeRes);

      const renderRes = (items, getActive, onPick) => {
        if (!items.length) {
          resBtn.disabled = true;
          resLabel.textContent = 'Not available';
          resList.innerHTML = '';
          return;
        }
        resBtn.disabled = false;
        resList.innerHTML = items.map(it =>
          `<button class="cc-dropdown-item" type="button" data-cc-res="${it.id}">${escape(it.label)}</button>`
        ).join('');
        const sync = () => {
          const cur = String(getActive());
          let activeLabel = items[0]?.label || 'Auto';
          resList.querySelectorAll('[data-cc-res]').forEach(b => {
            const isActive = b.dataset.ccRes === cur;
            b.classList.toggle('active', isActive);
            if (isActive) activeLabel = b.textContent;
          });
          resLabel.textContent = activeLabel;
        };
        sync();
        resList.querySelectorAll('[data-cc-res]').forEach(btn => {
          btn.onclick = () => {
            onPick(btn.dataset.ccRes);
            sync();
            closeRes();
          };
        });
      };
      const wireHls = () => {
        const hls = v._hls;
        if (!hls) return false;
        const apply = () => {
          const items = [{ id: '-1', label: 'Auto' }].concat(
            (hls.levels || [])
              .map((lvl, i) => ({ id: String(i), label: (lvl.height ? lvl.height + 'p' : `Level ${i}`), h: lvl.height || 0 }))
              .sort((a, b) => b.h - a.h)
          );
          renderRes(items, () => hls.currentLevel, (id) => { hls.currentLevel = Number(id); });
        };
        if (hls.levels && hls.levels.length) apply();
        else hls.on(window.Hls.Events.MANIFEST_PARSED, apply);
        return true;
      };
      const wireDash = () => {
        const dash = v._dash;
        if (!dash) return false;
        const apply = () => {
          let tracks = [];
          try { tracks = dash.getTracksFor('video') || []; } catch {}
          // Each video track has multiple bitrate "qualities" — list them.
          let bitrates = [];
          try { bitrates = dash.getBitrateInfoListFor('video') || []; } catch {}
          const items = [{ id: '-1', label: 'Auto', h: 99999 }].concat(
            bitrates
              .map(b => ({ id: String(b.qualityIndex), label: (b.height ? b.height + 'p' : Math.round(b.bitrate / 1000) + 'k'), h: b.height || 0 }))
              .sort((a, b) => b.h - a.h)
          );
          renderRes(items, () => {
            try {
              const settings = dash.getSettings();
              if (settings?.streaming?.abr?.autoSwitchBitrate?.video) return -1;
              return dash.getQualityFor('video');
            } catch { return -1; }
          }, (id) => {
            const n = Number(id);
            if (n < 0) {
              dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
            } else {
              dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
              dash.setQualityFor('video', n);
            }
          });
        };
        // dash.js fires this once the manifest + initial buffers are ready.
        if (dash.isReady && dash.isReady()) apply();
        else dash.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, apply);
        return true;
      };
      const wireProgressive = () => {
        // List ALL playable streams — both video-only (paired with audio
        // sidecar at HD) and muxed (360p single-file). The picker swaps
        // the sidecar audio in/out as the user changes quality.
        const streams = (data.videoStreams || []).filter(s => s.url);
        if (!streams.length) {
          resBtn.disabled = true;
          resLabel.textContent = 'Not available';
          resList.innerHTML = '';
          return;
        }
        const items = streams.map((s, i) => ({
          id: String(i),
          label: (s.quality || 'auto') + (!s.videoOnly && s.quality ? '' : ''),
        }));
        // Initial active = whatever play() picked: highest video-only when
        // audio sidecar is available, else highest muxed.
        const initialIdx = (data.audioStream && streams.some(s => s.videoOnly))
          ? streams.findIndex(s => s.videoOnly)
          : streams.findIndex(s => !s.videoOnly);
        let activeId = String(Math.max(0, initialIdx));
        renderRes(items, () => activeId, (id) => {
          activeId = id;
          const s = streams[Number(id)];
          if (!s) return;
          const t = v.currentTime;
          const wasPlaying = !v.paused;
          if (s.videoOnly && data.audioStream) {
            playerLib.attachAudioSync(v, s.url, data.audioStream.url);
          } else {
            playerLib.detachAudioSync(v);
            v.src = s.url;
            v.currentTime = t;
            if (wasPlaying) v.play().catch(() => {});
          }
        });
      };
      // Defer slightly so hls.js / dash.js have had a chance to attach.
      setTimeout(() => {
        if (wireHls())  return;
        if (wireDash()) return;
        wireProgressive();
      }, 150);
    }

    // ---------- Subtitles ----------
    const ccDrop = optPanel.querySelector('#cc-opt-cc');
    if (ccDrop) {
      const ccBtn   = ccDrop.querySelector('.cc-dropdown-btn');
      const ccLabel = ccDrop.querySelector('.cc-dropdown-label');
      const ccList  = ccDrop.querySelector('.cc-dropdown-list');
      const subs = data.subtitles || [];
      // Sort: manual first, then auto. Within each, en first if present.
      subs.sort((a, b) => {
        if (!!a.auto !== !!b.auto) return a.auto ? 1 : -1;
        if (a.lang === 'en') return -1;
        if (b.lang === 'en') return 1;
        return (a.label || a.lang).localeCompare(b.label || b.lang);
      });
      const items = [{ key: 'off', label: 'Off' }]
        .concat(subs.map((s, i) => ({ key: String(i), label: s.label || s.lang })));
      ccList.innerHTML = items.map(it =>
        `<button class="cc-dropdown-item${it.key === 'off' ? ' active' : ''}" type="button" data-cc-cc="${it.key}">${escape(it.label)}</button>`
      ).join('');

      const closeDrop = () => ccDrop.classList.remove('open');
      const openDrop  = () => ccDrop.classList.add('open');
      ccBtn.onclick = (e) => {
        e.stopPropagation();
        ccDrop.classList.toggle('open');
      };
      ccList.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', closeDrop);

      // Custom caption overlay. Native ::cue rendering can't be repositioned
      // by the user (it lives in a closed shadow DOM), so we suppress it
      // (TextTrack.mode = 'hidden' → cues stay active and fire `cuechange`
      // but the browser draws nothing) and paint the active cue text into
      // our own absolutely-positioned, draggable box instead.
      const subBox = wrap.querySelector('#cc-subs');
      const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

      // Place the box at the user's saved normalized centre (a fraction of
      // the player's width/height). Clamped so it can never be dragged fully
      // off the video; translate(-50%,-50%) in CSS makes {x,y} mean "centre".
      const applyStoredPos = () => {
        if (!subBox) return;
        const p = currentSettings.subtitlePos || { x: 0.5, y: 0.88 };
        const x = clamp(typeof p.x === 'number' ? p.x : 0.5,  0.03, 0.97);
        const y = clamp(typeof p.y === 'number' ? p.y : 0.88, 0.05, 0.97);
        subBox.style.left = (x * 100) + '%';
        subBox.style.top  = (y * 100) + '%';
      };
      applyStoredPos();

      // VTT cue text can carry markup/voice tags (<v Bob>, <i>, …). Strip to
      // plain text + newlines; the box owns the visual styling.
      const cueText = (cue) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = ((cue && cue.text) || '').replace(/\r?\n/g, '<br>');
        return (tmp.textContent || '').trim();
      };
      const paintCues = (tt) => {
        if (!subBox) return;
        const active = tt && tt.activeCues ? Array.from(tt.activeCues) : [];
        const txt = active.map(cueText).filter(Boolean).join('\n');
        subBox.textContent = txt;
        subBox.classList.toggle('has-text', !!txt);
      };

      let activeTrack = null;   // the <track> element
      let activeTT = null;      // its TextTrack object
      let onCueChange = null;
      const detachCues = () => {
        if (activeTT && onCueChange) activeTT.removeEventListener('cuechange', onCueChange);
        onCueChange = null;
        activeTT = null;
        if (subBox) { subBox.textContent = ''; subBox.classList.remove('has-text'); }
      };

      ccList.querySelectorAll('.cc-dropdown-item').forEach(it => {
        it.onclick = async () => {
          const key = it.dataset.ccCc;
          ccList.querySelectorAll('.cc-dropdown-item').forEach(b => b.classList.toggle('active', b === it));
          ccLabel.textContent = it.textContent;
          closeDrop();
          for (const t of v.textTracks) t.mode = 'disabled';
          detachCues();
          if (activeTrack && activeTrack.parentNode) activeTrack.parentNode.removeChild(activeTrack);
          activeTrack = null;
          if (key === 'off') return;
          const sub = subs[Number(key)];
          if (!sub) return;
          try {
            let vttUrl = sub.url;
            if (window.app?.fetchText) {
              const text = await window.app.fetchText(sub.url);
              if (text) {
                const vtt = (sub.ext === 'vtt' || /WEBVTT/.test(text)) ? text : 'WEBVTT\n\n' + text;
                vttUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
              }
            }
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = sub.label || sub.lang;
            track.srclang = sub.lang || 'en';
            track.src = vttUrl;
            track.default = true;
            v.appendChild(track);
            activeTrack = track;
            track.addEventListener('load', () => {
              // 'hidden' (not 'showing') keeps cues live so `cuechange`
              // fires and activeCues populates, but the browser draws no
              // native captions — ours are the only ones on screen.
              let tt = null;
              for (const t of v.textTracks) {
                if (t.label === track.label) { t.mode = 'hidden'; tt = t; }
                else t.mode = 'disabled';
              }
              if (!tt) return;
              activeTT = tt;
              onCueChange = () => paintCues(tt);
              tt.addEventListener('cuechange', onCueChange);
              paintCues(tt); // paint immediately in case a cue is already active
            }, { once: true });
          } catch (e) {
            console.warn('Subtitle load failed:', e);
          }
        };
      });

      // ---------- Drag-to-reposition ----------
      // The whole caption box is the drag handle. Persist only on release so
      // we don't hammer the settings file on every mouse move.
      if (subBox) {
        let dragging = false;
        let startX = 0, startY = 0, baseX = 0.5, baseY = 0.88;
        const onMove = (e) => {
          if (!dragging) return;
          const r = wrap.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const nx = clamp(baseX + (e.clientX - startX) / r.width,  0.03, 0.97);
          const ny = clamp(baseY + (e.clientY - startY) / r.height, 0.05, 0.97);
          subBox.style.left = (nx * 100) + '%';
          subBox.style.top  = (ny * 100) + '%';
        };
        const onUp = () => {
          if (!dragging) return;
          dragging = false;
          subBox.classList.remove('dragging');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          const x = parseFloat(subBox.style.left) / 100;
          const y = parseFloat(subBox.style.top) / 100;
          currentSettings.subtitlePos = { x, y };
          saveSettings(currentSettings);
        };
        subBox.addEventListener('mousedown', (e) => {
          // Swallow the click so it doesn't reach the video (play/pause).
          e.preventDefault();
          e.stopPropagation();
          dragging = true;
          subBox.classList.add('dragging');
          startX = e.clientX;
          startY = e.clientY;
          const p = currentSettings.subtitlePos || { x: 0.5, y: 0.88 };
          baseX = clamp(typeof p.x === 'number' ? p.x : 0.5,  0.03, 0.97);
          baseY = clamp(typeof p.y === 'number' ? p.y : 0.88, 0.05, 0.97);
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
      }
    }
  }
}

async function downloadCurrentVideo(id) {
  if (!ytdlpReady) {
    showBanner(`
      <div class="banner-text">
        <strong>yt-dlp not installed</strong>
        <span>Install yt-dlp first (banner at the top of the page).</span>
      </div>
      <button id="dl-close" class="topnav-style-btn">Close</button>
    `, 'error');
    banner.querySelector('#dl-close').onclick = clearBanner;
    return;
  }

  showBanner(`
    <div class="banner-text">
      <strong>Downloading…</strong>
      <span id="dl-info">Starting…</span>
    </div>
    <div class="progress" style="width:240px"><div class="progress-fill" id="dl-fill"></div></div>
    <span class="progress-label" id="dl-pct">0%</span>
  `);
  const fill = banner.querySelector('#dl-fill');
  const pct  = banner.querySelector('#dl-pct');
  const info = banner.querySelector('#dl-info');

  const off = window.app.ytdlp.onDownloadProgress(({ percent, totalBytes, speed, eta }) => {
    if (fill) fill.style.width = (percent || 0) + '%';
    if (pct)  pct.textContent  = Math.floor(percent || 0) + '%';
    if (info) info.textContent = `${totalBytes || ''}${speed ? ' · ' + speed : ''}${eta ? ' · ETA ' + eta : ''}`.trim() || '…';
  });

  let result;
  try {
    result = await window.app.ytdlp.download(id, {
      includeChannel: !!currentSettings.includeChannelInFilename,
      destDir: currentSettings.downloadDir || undefined,
    });
  } catch (e) {
    result = { ok: false, error: e.message || String(e) };
  }
  off();

  if (result.ok) {
    const fname = result.filename ? result.filename.replace(/^.*[\\/]/, '') : '';
    showBanner(`
      <div class="banner-text">
        <strong>Download complete.</strong>
        <span>${escape(fname || 'Saved to your Downloads folder.')}</span>
      </div>
      <button id="dl-show" class="topnav-style-btn">Open folder</button>
      <button id="dl-close" class="topnav-style-btn" style="background:transparent">Close</button>
    `, 'success');
    banner.querySelector('#dl-show').onclick = () => {
      if (result.filename) window.app.showInFolder(result.filename);
      clearBanner();
    };
    banner.querySelector('#dl-close').onclick = clearBanner;
    setTimeout(clearBanner, 12000);
  } else {
    showBanner(`
      <div class="banner-text">
        <strong>Download failed</strong>
        <span>${escape(result.error || 'Unknown error.')}</span>
      </div>
      <button id="dl-close" class="topnav-style-btn">Close</button>
    `, 'error');
    banner.querySelector('#dl-close').onclick = clearBanner;
  }
}

function relatedLayoutIcon(mode) {
  if (mode === 'overlay') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="14" rx="2"/><line x1="3" y1="14" x2="21" y2="14"/>
    </svg>`;
  }
  if (mode === 'thumbs') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><polyline points="3 16 9 12 14 16 21 11"/>
    </svg>`;
  }
  // list (default)
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>
    <rect x="3" y="4" width="4" height="4" rx="1"/><rect x="3" y="10" width="4" height="4" rx="1"/><rect x="3" y="16" width="4" height="4" rx="1"/>
  </svg>`;
}

function showResumeBanner(position, onResume) {
  const playerWrap = view.querySelector('.player-wrap');
  if (!playerWrap) return;
  const old = playerWrap.querySelector('.resume-banner');
  if (old) old.remove();

  const banner = document.createElement('div');
  banner.className = 'resume-banner';
  banner.innerHTML = `
    <span>Continue from <strong>${fmtDuration(Math.floor(position))}</strong>?</span>
    <button class="resume-go primary">Resume</button>
    <button class="resume-no">Start over</button>
  `;
  playerWrap.appendChild(banner);

  let dismissed = false;
  const close = () => {
    if (dismissed) return;
    dismissed = true;
    banner.classList.add('fading');
    setTimeout(() => banner.remove(), 300);
  };
  banner.querySelector('.resume-go').onclick = () => { onResume(); close(); };
  banner.querySelector('.resume-no').onclick = close;
  setTimeout(close, 12000);
}

function escape(s = '') {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}
function escapeAttr(s = '') { return escape(s); }

// ============================================================
// Account modal
// ============================================================
function openModal(html, opts = {}) {
  modalBody.innerHTML = html;
  const card = modal.querySelector('.modal-card');
  card.classList.toggle('wide', !!opts.wide);
  card.classList.toggle('settings', !!opts.settings);
  modal.classList.toggle('settings-open', !!opts.settings);
  modal.classList.remove('hidden');
  // Always make sure there's a global "X" close button in the corner of the
  // card. Settings already injects its own; for everything else we add one
  // dynamically so the user always has a one-click escape route.
  if (!opts.settings && !modalBody.querySelector('.modal-close-x')) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'modal-close-x';
    x.setAttribute('aria-label', 'Close');
    x.title = 'Close (Esc)';
    x.textContent = '×';
    x.onclick = closeModal;
    modalBody.prepend(x);
  }
}
function closeModal() {
  modal.classList.add('hidden');
  const card = modal.querySelector('.modal-card');
  card.classList.remove('wide');
  card.classList.remove('settings');
  modal.classList.remove('settings-open');
  modalBody.innerHTML = '';
}
modal.querySelector('.modal-bg').onclick = closeModal;
// Belt-and-braces: any click on the modal wrapper that wasn't on the card
// itself closes the modal too. Some layouts stack the modal-bg behind the
// card and clicks land on the modal element directly — without this they
// were being absorbed and the modal stayed open.
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
});

function getDisplayName() {
  const custom = localStorage.getItem('piped-display-name');
  if (custom) return custom;
  return getUser()?.username || 'Account';
}
function setCustomDisplayName(name) {
  if (name && name.trim()) localStorage.setItem('piped-display-name', name.trim());
  else localStorage.removeItem('piped-display-name');
}

function refreshAccountBtn() {
  if (isLoggedIn()) {
    accountBtn.textContent = getDisplayName();
    accountBtn.classList.add('logged-in');
    accountBtn.title = 'Account';
  } else {
    accountBtn.textContent = 'Sign in';
    accountBtn.classList.remove('logged-in');
    accountBtn.title = 'Sign in to a Piped account';
  }
}

// Top-level auth menu. Three options, each leads to its own flow.
async function showAuthMenu() {
  const g = await window.app.google.status();
  const googleStatus = g.signedIn ? 'Signed in' : (g.hasClientId ? 'Setup done' : '');

  openModal(`
    <h2>Get your subscriptions</h2>
    <div class="modal-sub">Pick how you want to import or sync.</div>
    <div class="auth-options">
      <div class="auth-card" id="auth-google">
        <div class="auth-icon google">G</div>
        <div class="auth-text">
          <strong>Sign in with Google</strong>
          <span>Auto-imports your real YouTube subs. One-time setup.</span>
        </div>
        ${googleStatus ? `<div class="auth-status">${googleStatus}</div>` : ''}
      </div>
      <div class="auth-card" id="auth-piped">
        <div class="auth-icon piped">P</div>
        <div class="auth-text">
          <strong>Sign in to Piped</strong>
          <span>Username + password — synced across devices.</span>
        </div>
      </div>
      <div class="auth-card" id="auth-takeout">
        <div class="auth-icon takeout">↥</div>
        <div class="auth-text">
          <strong>Import from YouTube Takeout</strong>
          <span>One-time CSV/JSON import, no account needed.</span>
        </div>
      </div>
    </div>
    <div class="modal-actions"><button id="auth-cancel">Cancel</button></div>
  `, { wide: true });

  modalBody.querySelector('#auth-cancel').onclick = closeModal;
  modalBody.querySelector('#auth-google').onclick = async () => {
    const s = await window.app.google.status();
    if (!s.hasClientId || !s.hasClientSecret) showGoogleSetup();
    else if (!s.signedIn) runGoogleSignIn();
    else runGoogleImport();
  };
  modalBody.querySelector('#auth-piped').onclick = () => showLoginForm('login');
  modalBody.querySelector('#auth-takeout').onclick = () => { closeModal(); takeoutInput.click(); };
}

function showLoginForm(mode = 'login') {
  const isLogin = mode === 'login';
  openModal(`
    <h2>${isLogin ? 'Sign in to Piped' : 'Create Piped account'}</h2>
    <div class="modal-sub">Username + password only — no email, no Google. Used for synced subscriptions across devices.</div>
    <label for="m-user">Username</label>
    <input type="text" id="m-user" autocomplete="username" />
    <label for="m-pass">Password</label>
    <input type="password" id="m-pass" autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
    <div class="msg" id="m-msg" style="display:none"></div>
    <div class="modal-actions">
      <button id="m-back">Back</button>
      <button id="m-submit" class="primary">${isLogin ? 'Sign in' : 'Register'}</button>
    </div>
    <div class="toggle-row">
      ${isLogin ? `New here? <a id="m-toggle">Create an account</a>` : `Already registered? <a id="m-toggle">Sign in</a>`}
    </div>
  `);

  const u = modalBody.querySelector('#m-user');
  const p = modalBody.querySelector('#m-pass');
  const msg = modalBody.querySelector('#m-msg');
  const submit = modalBody.querySelector('#m-submit');
  u.focus();

  const showMsg = (text, kind = 'error') => {
    msg.className = 'msg ' + kind;
    msg.textContent = text;
    msg.style.display = 'block';
  };

  const submitForm = async () => {
    const username = u.value.trim();
    const password = p.value;
    if (!username || !password) { showMsg('Username and password are required.'); return; }
    submit.disabled = true;
    submit.textContent = isLogin ? 'Trying instances…' : 'Trying instances…';
    try {
      if (isLogin) await api.login(username, password);
      else await api.register(username, password);
      closeModal();
      refreshAccountBtn();
      showAccount(); // open the account panel after success
    } catch (e) {
      const raw = e.message || 'Failed.';
      // 5xx means every instance we tried was sick. Tell the user what to do
      // instead of just dumping "HTTP 526".
      if (/HTTP 5\d\d/.test(raw) || /aborted/i.test(raw) || /failed to fetch/i.test(raw)) {
        showMsg(isLogin
          ? `Couldn't reach any working Piped instance right now. ${raw}`
          : `Every Piped instance we tried is having trouble (${raw}). Try again in a minute, or switch instances from Settings.`);
      } else {
        showMsg(raw);
      }
      submit.disabled = false;
      submit.textContent = isLogin ? 'Sign in' : 'Register';
    }
  };

  modalBody.querySelector('#m-back').onclick = showAuthMenu;
  modalBody.querySelector('#m-toggle').onclick = () => showLoginForm(isLogin ? 'register' : 'login');
  submit.onclick = submitForm;
  [u, p].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') submitForm(); }));
}

// ============================================================
// Google sign-in: setup wizard, sign-in waiter, import flow
// ============================================================
function showGoogleSetup() {
  openModal(`
    <h2>Sign in with Google: setup</h2>
    <div class="modal-sub">One-time setup. You create your own OAuth client — your YouTube data flows through your Cloud project, not anyone else's.</div>
    <ol class="setup-steps">
      <li>Open <a id="link-cloud">Google Cloud Console</a> → New Project (any name).</li>
      <li>Enable the <a id="link-yt">YouTube Data API v3</a> for that project.</li>
      <li><a id="link-audience">Google Auth Platform → Audience</a> → keep status on <em>Testing</em> → scroll to <strong>Test users</strong> → add your own email.</li>
      <li><a id="link-creds">Credentials</a> → <em>Create Credentials</em> → <em>OAuth client ID</em> → type <strong>Desktop app</strong> → click Create. Google shows you a <strong>Client ID</strong> and <strong>Client Secret</strong>. Copy both.</li>
    </ol>
    <label for="cid">Client ID</label>
    <input type="text" id="cid" placeholder="...apps.googleusercontent.com" autocomplete="off" />
    <label for="csec">Client Secret</label>
    <input type="text" id="csec" placeholder="GOCSPX-..." autocomplete="off" />
    <div class="msg muted" style="font-size:11px;margin-top:6px">
      The "secret" isn't actually secret for desktop apps — Google still requires it in the request. It's stored locally only.
    </div>
    <div class="msg" id="cid-msg" style="display:none"></div>
    <div class="modal-actions">
      <button id="cid-back">Back</button>
      <button id="cid-save" class="primary">Save and sign in</button>
    </div>
  `);

  const open = (url) => () => window.app.openExternal(url);
  modalBody.querySelector('#link-cloud').onclick    = open('https://console.cloud.google.com/projectcreate');
  modalBody.querySelector('#link-yt').onclick       = open('https://console.cloud.google.com/apis/library/youtube.googleapis.com');
  modalBody.querySelector('#link-audience').onclick = open('https://console.cloud.google.com/auth/audience');
  modalBody.querySelector('#link-creds').onclick    = open('https://console.cloud.google.com/apis/credentials');

  Promise.all([
    window.app.google.getClientId(),
    window.app.google.getClientSecret(),
  ]).then(([id, sec]) => {
    if (id)  modalBody.querySelector('#cid').value  = id;
    if (sec) modalBody.querySelector('#csec').value = sec;
  });

  const cidInput  = modalBody.querySelector('#cid');
  const csecInput = modalBody.querySelector('#csec');
  const msg = modalBody.querySelector('#cid-msg');
  const showMsg = (text, kind = 'error') => {
    msg.className = 'msg ' + kind;
    msg.textContent = text;
    msg.style.display = 'block';
  };

  modalBody.querySelector('#cid-back').onclick = showAuthMenu;
  modalBody.querySelector('#cid-save').onclick = async () => {
    const id = cidInput.value.trim();
    const sec = csecInput.value.trim();
    if (!id || !sec) return showMsg('Paste both Client ID and Client Secret.');
    if (!/\.apps\.googleusercontent\.com$/.test(id)) {
      return showMsg('Client ID should end in .apps.googleusercontent.com');
    }
    const r = await window.app.google.setCredentials({ clientId: id, clientSecret: sec });
    if (!r?.ok) return showMsg(r?.error || 'Failed to save.');
    runGoogleSignIn();
  };
  cidInput.focus();
}

async function runGoogleSignIn() {
  let cancelled = false;
  openModal(`
    <h2>Complete sign-in in your browser</h2>
    <div class="modal-sub">Your default browser just opened to Google's sign-in page. Authorize Glass and come back — we'll detect it automatically.</div>
    <div style="display:flex;align-items:center;gap:14px;margin:20px 0">
      <div class="loader" style="padding:0">Waiting for browser</div>
    </div>
    <div class="msg muted" style="font-size:11px">
      First time: you may see <strong>"Google hasn't verified this app"</strong> — that's because the OAuth client is your own personal one and isn't going through Google's verification process. Click <em>Advanced</em> → <em>Go to (project) (unsafe)</em>. It's safe — this is your own Cloud project.
    </div>
    <div class="modal-actions"><button id="g-cancel">Cancel</button></div>
  `);
  modalBody.querySelector('#g-cancel').onclick = () => {
    cancelled = true;
    window.app.google.cancelSignIn();
    showAuthMenu();
  };

  const r = await window.app.google.signIn();
  if (cancelled) return;

  if (!r.ok) {
    openModal(`
      <h2>Sign-in failed</h2>
      <div class="msg error">${escape(r.error || 'unknown error')}</div>
      <div class="modal-actions">
        <button id="f-back">Back</button>
        <button id="f-retry" class="primary">Try again</button>
      </div>
    `);
    modalBody.querySelector('#f-back').onclick = showAuthMenu;
    modalBody.querySelector('#f-retry').onclick = runGoogleSignIn;
    return;
  }

  runGoogleImport();
}

async function runGoogleImport() {
  openModal(`
    <h2>Importing from YouTube</h2>
    <div class="loader" id="g-prog" style="padding:0;margin:14px 0">Fetching your subscriptions</div>
    <div class="msg muted" id="g-msg" style="display:none"></div>
    <div class="modal-actions"><button id="g-close">Close</button></div>
  `);
  const close = modalBody.querySelector('#g-close');
  close.onclick = closeModal;
  const msg = modalBody.querySelector('#g-msg');
  const prog = modalBody.querySelector('#g-prog');

  const r = await window.app.google.fetchSubs();
  if (!r.ok) {
    prog.style.display = 'none';
    msg.className = 'msg error';
    msg.textContent = r.error;
    msg.style.display = 'block';
    return;
  }
  const channels = r.subs;

  prog.textContent = `Found ${channels.length} channel${channels.length === 1 ? '' : 's'}. ${
    isLoggedIn() ? 'Sending to Piped' : 'Saving locally'
  }`;

  try {
    if (isLoggedIn()) {
      await api.importChannels(channels.map(c => c.id));
    } else {
      const existing = getLocalSubs();
      const existingIds = new Set(existing.map(c => c.id));
      const merged = [...existing];
      for (const c of channels) {
        if (!existingIds.has(c.id)) merged.push(c);
      }
      setLocalSubs(merged);
    }
    prog.style.display = 'none';
    msg.className = 'msg success';
    msg.textContent = `Imported ${channels.length} channel${channels.length === 1 ? '' : 's'} from your YouTube account.`;
    msg.style.display = 'block';
    close.textContent = 'Done';
    setTimeout(() => {
      closeModal();
      if (document.querySelector('.topnav button.active')?.dataset.route === 'subs') go('subs');
    }, 1200);
  } catch (e) {
    prog.style.display = 'none';
    msg.className = 'msg error';
    msg.textContent = e.message || 'Import failed.';
    msg.style.display = 'block';
  }
}

function showTakeoutHelp() {
  openModal(`
    <h2>Get your YouTube subscriptions</h2>
    <div class="modal-sub">Two-minute walkthrough.</div>
    <ol style="font-size:13px;line-height:1.7;padding-left:20px;margin:14px 0">
      <li>Go to <a id="open-takeout" style="color:var(--accent);cursor:pointer">takeout.google.com</a> and sign in with the Google account you use for YouTube.</li>
      <li>Click <strong>Deselect all</strong> at the top.</li>
      <li>Scroll down, check <strong>YouTube and YouTube Music</strong>.</li>
      <li>Click <strong>All YouTube data included</strong> → deselect everything except <strong>subscriptions</strong> → OK.</li>
      <li>Scroll to the bottom, click <strong>Next step</strong> → <strong>Create export</strong>.</li>
      <li>Wait a minute or two for the email, download the zip, unzip it.</li>
      <li>Inside, find <code>subscriptions.csv</code> (or <code>.json</code>) and drop it into Glass via the Import button.</li>
    </ol>
    <div class="modal-actions">
      <button id="back-login">Back</button>
      <button id="open-takeout-2" class="primary">Open takeout.google.com</button>
    </div>
  `);
  modalBody.querySelector('#back-login').onclick = () => showLoginForm('login');
  const open = () => window.app.openExternal('https://takeout.google.com/settings/takeout');
  modalBody.querySelector('#open-takeout').onclick = open;
  modalBody.querySelector('#open-takeout-2').onclick = open;
}

async function showAccount() {
  const u = getUser();
  const g = await window.app.google.status();
  const customDisplay = localStorage.getItem('piped-display-name') || '';
  openModal(`
    <h2>Account</h2>
    <div class="modal-sub">Signed in to your Piped account.</div>

    <label for="d-name">Display name <span style="font-size:10px;color:var(--muted);font-weight:400;letter-spacing:0;text-transform:none;margin-left:4px">(shown in the top bar)</span></label>
    <div class="name-row">
      <input type="text" id="d-name" value="${escapeAttr(customDisplay)}" placeholder="${escapeAttr(u?.username || 'Display name')}" maxlength="32" />
      <button id="save-name">Save</button>
    </div>

    <div class="modal-divider"></div>
    <div class="info-row"><span>Username</span><span>${escape(u?.username || '')}</span></div>
    <div class="info-row"><span>Instance</span><span>${escape(new URL(u?.instance || 'https://pipedapi.kavin.rocks').host)}</span></div>
    <div class="info-row"><span>Google</span><span>${g.signedIn ? 'connected' : 'not connected'}</span></div>
    <div class="modal-divider"></div>
    <div class="modal-actions" style="flex-direction:column;gap:8px">
      ${g.signedIn
        ? `<button id="a-resync" class="primary">Re-sync subscriptions from Google</button>
           <button id="a-google-out" class="danger">Disconnect Google</button>`
        : `<button id="a-google-in" class="primary">Connect Google account</button>`}
      <button id="a-import">Import from YouTube Takeout (file)</button>
      <button id="a-close">Close</button>
      <button id="a-logout" class="danger">Sign out of Piped</button>
    </div>
  `);

  modalBody.querySelector('#a-close').onclick = closeModal;
  modalBody.querySelector('#a-logout').onclick = () => {
    logout();
    closeModal();
    refreshAccountBtn();
    if (document.querySelector('.topnav button.active')?.dataset.route === 'subs') go('subs');
  };
  modalBody.querySelector('#a-import').onclick = () => takeoutInput.click();

  const nameInput = modalBody.querySelector('#d-name');
  const saveBtn   = modalBody.querySelector('#save-name');
  const saveName = () => {
    setCustomDisplayName(nameInput.value);
    refreshAccountBtn();
    saveBtn.textContent = 'Saved';
    setTimeout(() => { if (saveBtn) saveBtn.textContent = 'Save'; }, 1200);
  };
  saveBtn.onclick = saveName;
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
  if (g.signedIn) {
    modalBody.querySelector('#a-resync').onclick = runGoogleImport;
    modalBody.querySelector('#a-google-out').onclick = async () => {
      await window.app.google.signOut();
      showAccount();
    };
  } else {
    modalBody.querySelector('#a-google-in').onclick = async () => {
      const s = await window.app.google.status();
      if (!s.hasClientId) showGoogleSetup();
      else runGoogleSignIn();
    };
  }
}

// ---------- Takeout import flow ----------
// Works either with a Piped account (server-side import) or without one
// (saves channel IDs straight to localStorage — same as the local Subscribe button).
takeoutInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  takeoutInput.value = '';
  if (!file) return;

  const target = isLoggedIn() ? 'Piped account' : 'this device';
  openModal(`
    <h2>Importing subscriptions</h2>
    <div class="modal-sub">Reading ${escape(file.name)} → ${target}</div>
    <div class="msg muted" id="i-msg">Parsing channel list…</div>
    <div class="modal-actions"><button id="i-close">Cancel</button></div>
  `);
  modalBody.querySelector('#i-close').onclick = closeModal;
  const msg = modalBody.querySelector('#i-msg');

  try {
    const text = await file.text();
    const ids = file.name.toLowerCase().endsWith('.json')
      ? parseTakeoutJson(text)
      : parseTakeoutCsv(text);

    if (!ids.length) throw new Error('No channel IDs found in the file. Make sure you exported the YouTube subscriptions list (CSV or JSON).');

    if (isLoggedIn()) {
      msg.textContent = `Found ${ids.length} channel${ids.length === 1 ? '' : 's'}. Sending to Piped…`;
      await api.importChannels(ids);
    } else {
      msg.textContent = `Found ${ids.length} channel${ids.length === 1 ? '' : 's'}. Saving locally…`;
      const existing = getLocalSubs();
      const existingIds = new Set(existing.map(c => c.id));
      const merged = [...existing];
      let added = 0;
      for (const id of ids) {
        if (!existingIds.has(id)) {
          merged.push({ id, name: id }); // names get filled in when Subs view fetches each channel
          added++;
        }
      }
      setLocalSubs(merged);
      msg.className = 'msg success';
      msg.textContent = `Imported ${added} new channel${added === 1 ? '' : 's'} (${ids.length - added} already there). Open Subs to see them.`;
      modalBody.querySelector('#i-close').textContent = 'Done';
      if (document.querySelector('.topnav button.active')?.dataset.route === 'subs') {
        setTimeout(() => { closeModal(); go('subs'); }, 800);
      }
      return;
    }

    msg.className = 'msg success';
    msg.textContent = `Imported ${ids.length} channel${ids.length === 1 ? '' : 's'} into your account.`;
    modalBody.querySelector('#i-close').textContent = 'Done';
    if (document.querySelector('.topnav button.active')?.dataset.route === 'subs') {
      setTimeout(() => { closeModal(); go('subs'); }, 800);
    }
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message || 'Import failed.';
  }
});

// ============================================================
// Wire up
// ============================================================
navButtons.forEach(b => { b.onclick = () => go(b.dataset.route); });

search.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const q = search.value.trim();
    if (!q) return;
    const id = videoIdFromAny(q);
    if (id) {
      search.value = '';
      go('video', id);
      return;
    }
    go('search', q);
  } else if (e.key === 'Escape') {
    search.blur();
  }
});

// Global Ctrl/Cmd+K → focus and select the search box from anywhere.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    search.focus();
    search.select();
  }
});

accountBtn.onclick = () => {
  if (isLoggedIn()) showAccount();
  else showAuthMenu();
};

document.getElementById('home-btn').onclick = () => go('home');

settingsBtn.onclick = showSettings;

function showSettings() {
  const s = currentSettings;
  const themeBtns = Object.entries(THEMES).map(([key, t]) => `
    <button class="theme-pill ${s.theme === key ? 'active' : ''}" data-theme="${key}">
      <span style="background:${t.accent}"></span>${key.charAt(0).toUpperCase() + key.slice(1)}
    </button>
  `).join('');

  openModal(`
    <h2>Settings</h2>
    <div class="modal-sub">Changes apply live.</div>

    <div class="settings-body settings-tabbed">

      <nav class="settings-tabs" role="tablist" aria-label="Settings categories">
        <button class="settings-tab active" data-tab="theme" role="tab"><span class="dot"></span>Theme</button>
        <button class="settings-tab" data-tab="window" role="tab"><span class="dot"></span>Window</button>
        <button class="settings-tab" data-tab="glass" role="tab"><span class="dot"></span>Glass &amp; Opacity</button>
        <button class="settings-tab" data-tab="behavior" role="tab"><span class="dot"></span>Behavior</button>
        <button class="settings-tab" data-tab="pullout" role="tab"><span class="dot"></span>Slide-out</button>
      </nav>

      <div class="settings-panes">

        <div class="settings-pane active" data-pane="theme" role="tabpanel">
          <section class="settings-section">
            <h3><span class="dot"></span>Theme</h3>
            <div class="settings-label">Color</div>
            <div class="theme-options">${themeBtns}</div>
            <div class="settings-label">Background motion <span class="hint">(gradient only)</span></div>
            <div class="theme-options">
              <button class="theme-pill ${s.motion === 'still' ? 'active' : ''}" data-motion="still">Still</button>
              <button class="theme-pill ${s.motion === 'subtle' ? 'active' : ''}" data-motion="subtle">Subtle</button>
              <button class="theme-pill ${s.motion === 'lively' ? 'active' : ''}" data-motion="lively">Lively</button>
            </div>
            <label class="check-row">
              <input type="checkbox" id="s-glow" ${s.cardGlow ? 'checked' : ''} class="glass-check" />
              Card glow on hover
            </label>
            <div class="settings-label">Search bar shape</div>
            <div class="theme-options">
              <button class="theme-pill ${s.searchStyle === 'pill' ? 'active' : ''}" data-search="pill">Pill</button>
              <button class="theme-pill ${s.searchStyle === 'square' ? 'active' : ''}" data-search="square">Soft square</button>
            </div>

            <div class="settings-label">Subs / Shorts / History buttons</div>
            <div class="theme-options">
              <button class="theme-pill ${(s.topnavStyle || 'text') === 'text' ? 'active' : ''}" data-topnav="text">Text</button>
              <button class="theme-pill ${s.topnavStyle === 'icon' ? 'active' : ''}" data-topnav="icon">Icons only</button>
              <button class="theme-pill ${s.topnavStyle === 'both' ? 'active' : ''}" data-topnav="both">Icon + label</button>
            </div>

            <div class="settings-label" style="margin-top:14px">Up next card style</div>
            <div class="theme-options">
              <button class="theme-pill" data-rmode="list">List</button>
              <button class="theme-pill" data-rmode="overlay">Overlay</button>
              <button class="theme-pill" data-rmode="thumbs">Thumbs only</button>
            </div>

            <div class="settings-label" style="margin-top:14px">Donate button</div>
            <div id="donate-toggle-wrap">
              ${s.hideDonateButton ? `
                <button id="s-donate-show" class="theme-pill">Show donate button</button>
                <div class="hint" style="font-size:11px;color:var(--muted);margin-top:6px">Currently hidden. Click to bring it back.</div>
              ` : `
                <button id="s-donate-hide-init" class="theme-pill">Hide donate button</button>
                <div id="donate-confirm" class="donate-confirm" style="display:none">
                  <div class="hint" style="font-size:11px;color:var(--muted);line-height:1.5;margin:8px 0">
                    To hide the donate button, type the following phrase exactly:
                    <div style="font-family:monospace;color:var(--text);background:rgba(255,255,255,0.06);padding:6px 10px;border-radius:6px;margin-top:6px;user-select:all;letter-spacing:0.4px">I HATE YOU AND DONT WANT TO GIVE YOU MONEY</div>
                  </div>
                  <input type="text" id="s-donate-phrase" autocomplete="off" spellcheck="false" placeholder="Type the phrase…" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--glass-border);background:var(--glass);color:var(--text);font-family:monospace;font-size:12px;letter-spacing:0.4px;box-sizing:border-box" />
                  <div id="s-donate-phrase-msg" class="hint" style="font-size:11px;color:#fca5a5;margin-top:6px;min-height:14px"></div>
                </div>
              `}
            </div>
          </section>
        </div>

        <div class="settings-pane" data-pane="window" role="tabpanel">
          <section class="settings-section">
            <h3><span class="dot"></span>Window</h3>
            <div class="hint" style="font-size:11px;color:var(--muted);margin-bottom:14px;line-height:1.5">
              <strong style="color:var(--text)">See-through?</strong> It's a single control now — <strong style="color:var(--text)">Glass &amp; Opacity → Background</strong> (Acrylic = frosted desktop, Clear glass = sharp desktop). The old separate “Backdrop effect” was removed because it fought that setting and bled the desktop into the UI.
            </div>
            <div class="settings-label">Up next width <span class="val" id="s-relw-val">${s.relatedWidth || 380}px</span></div>
            <input type="range" id="s-relw" class="settings-slider" min="280" max="540" value="${s.relatedWidth || 380}" />

            <div class="settings-label">Comments placement</div>
            <div class="theme-options">
              <button class="theme-pill ${(s.commentsPlacement || 'auto') === 'auto' ? 'active' : ''}" data-cp="auto">Auto</button>
              <button class="theme-pill ${s.commentsPlacement === 'side' ? 'active' : ''}" data-cp="side">Side</button>
              <button class="theme-pill ${s.commentsPlacement === 'below' ? 'active' : ''}" data-cp="below">Below video</button>
            </div>

            <div class="cc-opt-section-label" style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);font-size:11px;margin-top:10px">Progress bar &amp; Most Replayed curve are configured via the gear button on the video player.</div>
          </section>
        </div>

        <div class="settings-pane" data-pane="glass" role="tabpanel">
          <section class="settings-section">
            <h3><span class="dot"></span>Glass &amp; opacity</h3>
            <div class="settings-label">Background <span class="hint">(see-through modes show your desktop in the empty space)</span></div>
            <div class="theme-options">
              <button class="theme-pill ${s.bgMode === 'gradient' ? 'active' : ''}" data-bgmode="gradient">Gradient</button>
              <button class="theme-pill ${s.bgMode === 'solid' ? 'active' : ''}" data-bgmode="solid">Solid colour</button>
              <button class="theme-pill ${s.bgMode === 'acrylic' ? 'active' : ''}" data-bgmode="acrylic" title="Windows OS acrylic — the real desktop shows FROSTED/blurred in the empty areas, UI stays solid.">Acrylic</button>
              <button class="theme-pill ${s.bgMode === 'mica' ? 'active' : ''}" data-bgmode="mica" title="Windows OS Mica — subtle desktop-wallpaper tint in the empty areas, UI stays solid.">Mica</button>
              <button class="theme-pill ${s.bgMode === 'gaussian' ? 'active' : ''}" data-bgmode="gaussian" title="Windows OS Tabbed material — another frosted desktop look in the empty areas, UI stays solid.">Gaussian</button>
              <button class="theme-pill ${s.bgMode === 'clear' ? 'active' : ''}" data-bgmode="clear" title="Transparent window — the real desktop shows SHARP in the empty areas, UI stays solid. Restart to toggle.">Clear glass</button>
            </div>
            <div id="clear-restart-note" class="settings-restart-note" style="display:none">
              This see-through background needs a restart to take effect (the window must be recreated transparent).
              <button id="clear-restart-btn" type="button">Restart now</button>
            </div>
            <div class="settings-label" id="bgopacity-label" style="margin-top:14px"><span>Background opacity <span class="hint">(fades the Gradient background — UI &amp; text stay solid)</span></span><span class="val" id="s-bgopacity-val">${typeof s.bgOpacity === 'number' ? s.bgOpacity : 100}%</span></div>
            <input type="range" id="s-bgopacity" class="settings-slider" min="0" max="100" value="${typeof s.bgOpacity === 'number' ? s.bgOpacity : 100}" />
            <div class="settings-label" id="clearop-label" style="margin-top:14px;display:none"><span>Background dim <span class="hint">(Acrylic / Clear — 0 = full desktop, higher = darker veil over the desktop; UI stays solid)</span></span><span class="val" id="s-clearop-val">${typeof s.clearSeeThrough === 'number' ? s.clearSeeThrough : 0}%</span></div>
            <input type="range" id="s-clearop" class="settings-slider" min="0" max="70" value="${typeof s.clearSeeThrough === 'number' ? s.clearSeeThrough : 0}" style="display:none" />
            <div class="settings-label" id="acrylicalpha-label" style="margin-top:14px;display:none"><span>Surface see-through <span class="hint">(Acrylic / Clear — 0 = solid cards, higher = desktop shows through the cards too)</span></span><span class="val" id="s-acrylicalpha-val">${typeof s.acrylicCardAlpha === 'number' ? s.acrylicCardAlpha : 0}%</span></div>
            <input type="range" id="s-acrylicalpha" class="settings-slider" min="0" max="75" value="${typeof s.acrylicCardAlpha === 'number' ? s.acrylicCardAlpha : 0}" style="display:none" />
            <div class="settings-label" id="acrylicblur-label" style="margin-top:14px;display:none"><span>Blur <span class="hint">(Acrylic / Clear — extra frost on the see-through cards; 0 = off)</span></span><span class="val" id="s-acrylicblur-val">${typeof s.acrylicBlur === 'number' ? s.acrylicBlur : 0}px</span></div>
            <input type="range" id="s-acrylicblur" class="settings-slider" min="0" max="40" value="${typeof s.acrylicBlur === 'number' ? s.acrylicBlur : 0}" style="display:none" />
          </section>
        </div>

        <div class="settings-pane" data-pane="behavior" role="tabpanel">
          <section class="settings-section">
            <h3><span class="dot"></span>Behavior</h3>
            <label class="check-row">
              <input type="checkbox" id="s-resume" ${s.askResume ? 'checked' : ''} class="glass-check" />
              Resume videos where you left off
            </label>
            <label class="check-row">
              <input type="checkbox" id="s-likes" ${s.showLikes ? 'checked' : ''} class="glass-check" />
              Show likes count on watch page
            </label>
            <label class="check-row">
              <input type="checkbox" id="s-hidebars" ${s.hideScrollbars ? 'checked' : ''} class="glass-check" />
              Hide scrollbars
            </label>
            <label class="check-row">
              <input type="checkbox" id="s-hidepass" ${s.hidePassButton ? 'checked' : ''} class="glass-check" />
              Hide Proton Pass button
            </label>
            <label class="check-row">
              <input type="checkbox" id="s-channelfn" ${s.includeChannelInFilename ? 'checked' : ''} class="glass-check" />
              Include channel name in download filenames
            </label>

            <div class="settings-label" style="margin-top:14px">Download folder</div>
            <div class="dl-folder-row">
              <input type="text" id="s-dldir" class="dl-folder-input" readonly placeholder="(default: Downloads / YouTube)" value="${escapeAttr(s.downloadDir || '')}" />
              <button id="s-dldir-pick" class="theme-pill">Choose…</button>
              <button id="s-dldir-reset" class="theme-pill" title="Use the default Downloads / YouTube folder">Reset</button>
            </div>
            <div class="hint" style="font-size:11px;color:var(--muted);margin-top:6px">Empty = your system Downloads folder + a "YouTube" subfolder, created on first download.</div>
          </section>
        </div>

        <div class="settings-pane" data-pane="pullout" role="tabpanel">
          <section class="settings-section">
            <h3><span class="dot"></span>Slide-out window</h3>
            <label class="check-row" style="margin-top:0">
              <input type="checkbox" id="s-pull-on" ${s.pullout?.enabled ? 'checked' : ''} class="glass-check" />
              Enable global hotkey to slide window from screen edge
            </label>
            <div id="pullout-panel" class="pullout-grid" style="${s.pullout?.enabled ? '' : 'display:none'}">
              <div>
                <div class="settings-label">Side</div>
                <div class="theme-options">
                  <button class="theme-pill ${s.pullout?.side === 'left' ? 'active' : ''}" data-side="left">◀ Left</button>
                  <button class="theme-pill ${s.pullout?.side === 'right' ? 'active' : ''}" data-side="right">Right ▶</button>
                </div>
              </div>
              <div>
                <div class="settings-label"><span>Width</span><span class="val" id="s-pull-w-val">${s.pullout?.width ?? 45}%</span></div>
                <input type="range" id="s-pull-w" class="settings-slider" min="15" max="80" value="${s.pullout?.width ?? 45}" />
              </div>
              <div>
                <div class="settings-label">Hotkey</div>
                <input type="text" id="s-pull-hk" class="hotkey-input" value="${escape(s.pullout?.hotkey || '')}" readonly placeholder="Click and press a combo" />
                <div class="hint" id="s-pull-msg" style="margin-top:6px">Default: Alt+T</div>
              </div>
            </div>
          </section>
        </div>

      </div>
    </div>

    <div class="modal-actions">
      <button id="s-reset" class="danger">Reset</button>
      <button id="s-done" class="primary">Done</button>
    </div>
    <button class="modal-close" id="s-close" aria-label="Close" title="Close (Esc)">×</button>
  `, { settings: true });

  /* Wire close FIRST so even if any later handler throws, the user can still exit. */
  const safeClose = () => closeModal();
  modalBody.querySelector('#s-done').onclick = safeClose;
  modalBody.querySelector('#s-close').onclick = safeClose;

  // --- Tab switching ---
  const tabs  = modalBody.querySelectorAll('.settings-tab');
  const panes = modalBody.querySelectorAll('.settings-pane');
  tabs.forEach(tab => {
    tab.onclick = () => {
      const id = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      panes.forEach(p => p.classList.toggle('active', p.dataset.pane === id));
    };
  });

  const update = (patch) => {
    currentSettings = { ...currentSettings, ...patch };
    applySettings(currentSettings);
    saveSettings(currentSettings);
  };

  modalBody.querySelectorAll('.theme-pill[data-theme]').forEach(btn => {
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-theme]').forEach(b => b.classList.toggle('active', b === btn));
      update({ theme: btn.dataset.theme });
    };
  });
  modalBody.querySelectorAll('.theme-pill[data-motion]').forEach(btn => {
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-motion]').forEach(b => b.classList.toggle('active', b === btn));
      update({ motion: btn.dataset.motion });
    };
  });
  modalBody.querySelector('#s-glow').onchange = (e) => update({ cardGlow: e.target.checked });
  // (The separate "Backdrop effect" material picker was removed — bgMode is
  //  the single see-through control now. Progress bar & Most Replayed
  //  handlers live on the player gear popover.)

  const setFill = (input) => {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const v = Number(input.value);
    const pct = ((v - min) / (max - min)) * 100;
    // Inline gradient — bypasses the CSS-var repaint quirk that left the
    // pink fill missing during drags at non-extreme values.
    input.style.background =
      `linear-gradient(to right, var(--accent) 0, var(--accent) ${pct}%, rgba(255,255,255,0.10) ${pct}%, rgba(255,255,255,0.10) 100%)`;
  };
  const wireSlider = (id, key, fmt) => {
    const input = modalBody.querySelector('#s-' + id);
    const val = modalBody.querySelector('#s-' + id + '-val');
    if (!input) return;
    setFill(input);
    input.oninput = () => {
      const v = Number(input.value);
      val.textContent = fmt(v);
      setFill(input);
      update({ [key]: v });
    };
  };
  // Only the background-opacity slider remains in Glass & Opacity — it
  // affects ONLY the app background layer, never the UI/text. (Blur,
  // Intensity and the whole-window opacity sliders were removed: they
  // restyled every glass surface / dimmed the entire app including text,
  // which is exactly what the user does NOT want.)
  wireSlider('bgopacity', 'bgOpacity', (v) => v + '%');

  // Background mode. Solid colour is derived from the active theme's `bg`
  // field. Acrylic/Clear reveal the tint/blur slider; both use the
  // transparent window, so switching in/out of a see-through mode needs a
  // restart (transparent is fixed at window creation) — the note offers it.
  const launchedTransparent = !!(window.app && window.app.launchedTransparent);
  const refreshBgExtras = (mode) => {
    const tintLabel = modalBody.querySelector('#bgtint-label');
    const tintInput = modalBody.querySelector('#s-bgtint');
    if (tintLabel) tintLabel.style.display = 'none';
    if (tintInput) tintInput.style.display = 'none';
    // Every see-through mode (Acrylic / Clear / Mica / Gaussian) uses the
    // transparent window, so a restart is needed whenever you cross between
    // a see-through mode and a normal (Gradient/Solid) one.
    const seeThroughModes = ['acrylic', 'clear', 'mica', 'gaussian'];
    const wantTransparent = seeThroughModes.includes(mode);
    const note = modalBody.querySelector('#clear-restart-note');
    if (note) note.style.display = (wantTransparent !== launchedTransparent) ? '' : 'none';
    // Background opacity only does anything in Gradient mode (it fades the
    // gradient layer). In Solid it'd be a same-colour no-op; in Acrylic/
    // Clear there's no painted background. So only show it for Gradient —
    // a slider that visibly does nothing reads as "broken".
    const bgoLabel = modalBody.querySelector('#bgopacity-label');
    const bgoInput = modalBody.querySelector('#s-bgopacity');
    const showBgo = (mode === 'gradient');
    if (bgoLabel) bgoLabel.style.display = showBgo ? '' : 'none';
    if (bgoInput) bgoInput.style.display = showBgo ? '' : 'none';
    // "Background dim" veil works in every see-through mode (Clear, Acrylic,
    // Mica, Gaussian) — they all share the .bg veil via the acrylic CSS.
    const coLabel = modalBody.querySelector('#clearop-label');
    const coInput = modalBody.querySelector('#s-clearop');
    const showCo = ['clear', 'acrylic', 'mica', 'gaussian'].includes(mode);
    if (coLabel) coLabel.style.display = showCo ? '' : 'none';
    if (coInput) coInput.style.display = showCo ? '' : 'none';
    // "Surface see-through" + "Blur" — same set of modes (they all share the
    // acrylic CSS via the mica/gaussian → acrylic remap in applySettings).
    const aaLabel = modalBody.querySelector('#acrylicalpha-label');
    const aaInput = modalBody.querySelector('#s-acrylicalpha');
    if (aaLabel) aaLabel.style.display = showCo ? '' : 'none';
    if (aaInput) aaInput.style.display = showCo ? '' : 'none';
    const abLabel = modalBody.querySelector('#acrylicblur-label');
    const abInput = modalBody.querySelector('#s-acrylicblur');
    if (abLabel) abLabel.style.display = showCo ? '' : 'none';
    if (abInput) abInput.style.display = showCo ? '' : 'none';
  };
  modalBody.querySelectorAll('.theme-pill[data-bgmode]').forEach(btn => {
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-bgmode]').forEach(b => b.classList.toggle('active', b === btn));
      const mode = btn.dataset.bgmode;
      update({ bgMode: mode });
      refreshBgExtras(mode);
    };
  });
  refreshBgExtras(currentSettings.bgMode);

  // Clear-glass "Surface see-through" slider. Higher = the UI cards/panels
  // get more transparent so the desktop shows through them too (0 = solid
  // UI, the default). applySettings turns clearSeeThrough into the
  // --clear-opacity surface alpha.
  const clearopInput = modalBody.querySelector('#s-clearop');
  const clearopVal   = modalBody.querySelector('#s-clearop-val');
  if (clearopInput) {
    setFill(clearopInput);
    clearopInput.oninput = () => {
      const v = Number(clearopInput.value);
      if (clearopVal) clearopVal.textContent = v + '%';
      setFill(clearopInput);
      update({ clearSeeThrough: v });
    };
  }
  // Surface see-through: card/titlebar alpha in see-through modes. 0% = solid
  // cards (current default), higher = the OS acrylic / real desktop shows
  // through the UI too. Capped at 75 in the input so text never gets eaten.
  const acrylicAlphaInput = modalBody.querySelector('#s-acrylicalpha');
  const acrylicAlphaVal   = modalBody.querySelector('#s-acrylicalpha-val');
  if (acrylicAlphaInput) {
    setFill(acrylicAlphaInput);
    acrylicAlphaInput.oninput = () => {
      const v = Number(acrylicAlphaInput.value);
      if (acrylicAlphaVal) acrylicAlphaVal.textContent = v + '%';
      setFill(acrylicAlphaInput);
      update({ acrylicCardAlpha: v });
    };
  }
  // Blur slider: extra CSS backdrop-filter blur on the translucent surfaces.
  // The scoped opt-in rule in styles.css only kicks in when this is > 0
  // (root[data-acrylic-blur="on"]), so the default "no backdrop-filter"
  // perf behavior is preserved unless the user explicitly enables it.
  const acrylicBlurInput = modalBody.querySelector('#s-acrylicblur');
  const acrylicBlurVal   = modalBody.querySelector('#s-acrylicblur-val');
  if (acrylicBlurInput) {
    setFill(acrylicBlurInput);
    acrylicBlurInput.oninput = () => {
      const v = Number(acrylicBlurInput.value);
      if (acrylicBlurVal) acrylicBlurVal.textContent = v + 'px';
      setFill(acrylicBlurInput);
      update({ acrylicBlur: v });
    };
  }
  const clearRestartBtn = modalBody.querySelector('#clear-restart-btn');
  if (clearRestartBtn) {
    clearRestartBtn.onclick = () => { if (window.app && window.app.relaunchApp) window.app.relaunchApp(); };
  }

  modalBody.querySelector('#s-resume').onchange = (e) => {
    update({ askResume: e.target.checked });
  };
  modalBody.querySelector('#s-likes').onchange = (e) => {
    update({ showLikes: e.target.checked });
  };
  modalBody.querySelector('#s-hidebars').onchange = (e) => {
    update({ hideScrollbars: e.target.checked });
  };
  modalBody.querySelector('#s-hidepass').onchange = (e) => {
    update({ hidePassButton: e.target.checked });
  };
  modalBody.querySelector('#s-channelfn').onchange = (e) => {
    update({ includeChannelInFilename: e.target.checked });
  };

  // --- Download folder picker ---
  const dlInput = modalBody.querySelector('#s-dldir');
  const dlPick  = modalBody.querySelector('#s-dldir-pick');
  const dlReset = modalBody.querySelector('#s-dldir-reset');
  if (dlPick) {
    dlPick.onclick = async () => {
      if (!window.app?.download?.pickDir) return;
      const r = await window.app.download.pickDir(currentSettings.downloadDir);
      if (r?.ok && r.path) {
        dlInput.value = r.path;
        update({ downloadDir: r.path });
      }
    };
  }
  if (dlReset) {
    dlReset.onclick = () => {
      dlInput.value = '';
      update({ downloadDir: '' });
    };
  }
  modalBody.querySelectorAll('.theme-pill[data-search]').forEach(btn => {
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-search]').forEach(b => b.classList.toggle('active', b === btn));
      update({ searchStyle: btn.dataset.search });
    };
  });
  modalBody.querySelectorAll('.theme-pill[data-topnav]').forEach(btn => {
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-topnav]').forEach(b => b.classList.toggle('active', b === btn));
      update({ topnavStyle: btn.dataset.topnav });
    };
  });

  // --- Up next card layout (Theme tab) ---
  const currentRMode = localStorage.getItem('related-mode') || 'list';
  modalBody.querySelectorAll('.theme-pill[data-rmode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.rmode === currentRMode);
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-rmode]').forEach(b => b.classList.toggle('active', b === btn));
      const mode = btn.dataset.rmode;
      localStorage.setItem('related-mode', mode);
      // Live-update if a video page is currently open.
      const relatedEl = view.querySelector('.related');
      if (relatedEl) relatedEl.dataset.mode = mode;
      const layoutBtn = view.querySelector('#related-layout');
      if (layoutBtn) {
        layoutBtn.innerHTML = relatedLayoutIcon(mode);
        layoutBtn.title = `Layout: ${mode}`;
      }
    };
  });

  // --- Donate button hide/show flow (Theme tab) ---
  // Confirming or un-hiding used to call showSettings(), which rebuilds the
  // whole modal — that yanked the user back to the top of the Theme tab and
  // disposed of every DOM node in the dialog. To them it looks like the UI
  // "moves out of the settings box". We now patch just the donate-toggle-wrap
  // in place and re-bind only its own handlers. Scroll position, the active
  // tab, and every other field stay exactly where the user left them.
  const DONATE_PHRASE = 'I HATE YOU AND DONT WANT TO GIVE YOU MONEY';
  const donateWrap = modalBody.querySelector('#donate-toggle-wrap');
  const renderDonateToggle = () => {
    if (!donateWrap) return;
    const s = currentSettings;
    donateWrap.innerHTML = s.hideDonateButton ? `
      <button id="s-donate-show" class="theme-pill">Show donate button</button>
      <div class="hint" style="font-size:11px;color:var(--muted);margin-top:6px">Currently hidden. Click to bring it back.</div>
    ` : `
      <button id="s-donate-hide-init" class="theme-pill">Hide donate button</button>
      <div id="donate-confirm" class="donate-confirm" style="display:none">
        <div class="hint" style="font-size:11px;color:var(--muted);line-height:1.5;margin:8px 0">
          To hide the donate button, type the following phrase exactly:
          <div style="font-family:monospace;color:var(--text);background:rgba(255,255,255,0.06);padding:6px 10px;border-radius:6px;margin-top:6px;user-select:all;letter-spacing:0.4px;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box">I HATE YOU AND DONT WANT TO GIVE YOU MONEY</div>
        </div>
        <input type="text" id="s-donate-phrase" autocomplete="off" spellcheck="false" placeholder="Type the phrase…" style="width:100%;max-width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--glass-border);background:var(--glass);color:var(--text);font-family:monospace;font-size:12px;letter-spacing:0.4px;box-sizing:border-box" />
        <div id="s-donate-phrase-msg" class="hint" style="font-size:11px;color:#fca5a5;margin-top:6px;min-height:14px"></div>
      </div>
    `;
    bindDonateHandlers();
  };
  function bindDonateHandlers() {
    const showBtn = modalBody.querySelector('#s-donate-show');
    if (showBtn) {
      showBtn.onclick = () => {
        update({ hideDonateButton: false });
        renderDonateToggle();
      };
    }
    const hideInit = modalBody.querySelector('#s-donate-hide-init');
    const confirm  = modalBody.querySelector('#donate-confirm');
    const phrase   = modalBody.querySelector('#s-donate-phrase');
    const phraseMsg = modalBody.querySelector('#s-donate-phrase-msg');
    if (hideInit) {
      hideInit.onclick = () => {
        confirm.style.display = 'block';
        hideInit.style.display = 'none';
        phrase.focus();
        // Browsers sometimes skip auto-scroll on hidden→shown elements; nudge
        // the confirm UI into view so the user can actually see what they're
        // about to type into.
        confirm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    }
    if (phrase) {
      const tryConfirm = () => {
        const v = phrase.value.trim();
        if (v === DONATE_PHRASE) {
          update({ hideDonateButton: true });
          renderDonateToggle();
        } else if (v.length >= DONATE_PHRASE.length) {
          phraseMsg.textContent = 'That isn\'t the phrase. Type it exactly as shown.';
        } else {
          phraseMsg.textContent = '';
        }
      };
      phrase.addEventListener('input', tryConfirm);
      phrase.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); tryConfirm(); }
      });
    }
  }
  bindDonateHandlers();
  modalBody.querySelectorAll('.theme-pill[data-cp]').forEach(btn => {
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-cp]').forEach(b => b.classList.toggle('active', b === btn));
      update({ commentsPlacement: btn.dataset.cp });
    };
  });
  const relwInput = modalBody.querySelector('#s-relw');
  const relwVal = modalBody.querySelector('#s-relw-val');
  if (relwInput) {
    setFill(relwInput);                         // same pink-fill as every other slider
    relwInput.oninput = () => {
      relwVal.textContent = relwInput.value + 'px';
      setFill(relwInput);
      update({ relatedWidth: Number(relwInput.value) });
    };
  }

  // --- Pull-out sub-panel ---
  const pullCheck = modalBody.querySelector('#s-pull-on');
  const pullPanel = modalBody.querySelector('#pullout-panel');
  const pullMsg   = modalBody.querySelector('#s-pull-msg');

  const updatePullout = (patch) => {
    const next = { ...currentSettings.pullout, ...patch };
    update({ pullout: next });
  };

  pullCheck.onchange = () => {
    pullPanel.style.display = pullCheck.checked ? '' : 'none';
    updatePullout({ enabled: pullCheck.checked });
  };

  modalBody.querySelectorAll('.theme-pill[data-side]').forEach(btn => {
    btn.onclick = () => {
      modalBody.querySelectorAll('.theme-pill[data-side]').forEach(b => b.classList.toggle('active', b === btn));
      updatePullout({ side: btn.dataset.side });
    };
  });

  const pullW = modalBody.querySelector('#s-pull-w');
  const pullWVal = modalBody.querySelector('#s-pull-w-val');
  if (pullW) {
    setFill(pullW);                             // same pink-fill as every other slider
    pullW.oninput = () => {
      pullWVal.textContent = pullW.value + '%';
      setFill(pullW);
      updatePullout({ width: Number(pullW.value) });
    };
  }

  const hk = modalBody.querySelector('#s-pull-hk');
  hk.addEventListener('focus', () => { hk.value = ''; pullMsg.textContent = 'Press your hotkey…'; });
  hk.addEventListener('blur', () => { if (!hk.value) hk.value = currentSettings.pullout.hotkey || ''; });
  hk.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    const accel = parts.join('+');
    hk.value = accel;
    updatePullout({ hotkey: accel });
    pullMsg.textContent = 'Saved.';
    hk.blur();
  });

  modalBody.querySelector('#s-done').onclick = closeModal;
  modalBody.querySelector('#s-reset').onclick = () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    applySettings(currentSettings);
    saveSettings(currentSettings);
    showSettings(); // re-render with default values
  };
}

document.getElementById('pass-btn').onclick = () => {
  window.app.openExternal('https://proton.me/pass/download');
};

// Paste your Monero subaddress between the quotes. Empty = "not configured"
// state (the XMR card shows a friendly placeholder instead of an address).
const XMR_ADDRESS = '89ijYmJ1Nn1S9fTZLs2ecUWk8vtXTigK6VfuotkGgHYa3KJPGn5ZFcnZnRpK1KGRo4P2VBzuok3xy8vE8o32xMWJKbWPubs';
const KOFI_URL    = 'https://ko-fi.com/sunblockbukkake/tip';

document.getElementById('donate-btn').onclick = showDonateMenu;

function showDonateMenu() {
  const xmrSet = !!XMR_ADDRESS;
  openModal(`
    <h2>Support Glass</h2>
    <div class="modal-sub">Pick how you'd like to chip in — every tip keeps the project going.</div>
    <div class="auth-options">
      <button class="auth-card donate-option" id="donate-kofi" type="button">
        <span class="donate-logo donate-logo-kofi">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M5 11h17a3 3 0 0 1 0 6h-1v3a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V11z" fill="#fff"/>
            <path d="M21 13h0.6a1.5 1.5 0 0 1 0 3H21v-3z" fill="#FF5E5B" opacity=".4"/>
            <path d="M13.6 19.5l-2.1-2.1c-1-1 .1-2.6 1.1-2.1.5 0 1 .5 1 1 0-.5.5-1 1-1 1-.5 2.1 1.1 1.1 2.1l-2.1 2.1z" fill="#FF5E5B"/>
          </svg>
        </span>
        <div class="auth-text">
          <strong>Ko-fi</strong>
          <span>One-tap card / PayPal donations. Opens in your browser.</span>
        </div>
        <svg class="donate-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
      <button class="auth-card donate-option" id="donate-xmr" type="button">
        <span class="donate-logo donate-logo-xmr">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle cx="16" cy="16" r="15" fill="#fff"/>
            <path d="M5 10v13h4V14.5l7 7 7-7V23h4V10l-11 11L5 10z" fill="#FF6600"/>
          </svg>
        </span>
        <div class="auth-text">
          <strong>Monero (XMR)</strong>
          <span>${xmrSet
            ? 'Private, on-chain crypto donation. Click for address + QR.'
            : 'Crypto address not configured yet — see source to add yours.'}</span>
        </div>
        <svg class="donate-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
    </div>
    <div class="modal-actions"><button id="donate-close">Close</button></div>
  `, { wide: true });

  modalBody.querySelector('#donate-close').onclick = closeModal;
  modalBody.querySelector('#donate-kofi').onclick = () => {
    window.app.openExternal(KOFI_URL);
    closeModal();
  };
  modalBody.querySelector('#donate-xmr').onclick = showXmrPanel;
}

function showXmrPanel() {
  const addr = XMR_ADDRESS;
  openModal(`
    <h2>Donate Monero (XMR)</h2>
    <div class="modal-sub">Send any amount to the address below. Monero transactions are private by default — no one (including me) can see who sent what.</div>
    ${addr ? `
      <div class="xmr-addrwrap">
        <div class="xmr-addr-label">Address</div>
        <div class="xmr-addr"><code id="xmr-addr-text">${escape(addr)}</code></div>
        <div class="xmr-addr-row">
          <button id="xmr-copy" class="primary">Copy address</button>
          <button id="xmr-uri">Open in wallet</button>
        </div>
        <div class="xmr-uri-msg" id="xmr-msg"></div>
      </div>
    ` : `
      <div class="xmr-placeholder">
        <p>No Monero address has been configured yet. The owner needs to paste their subaddress into <code>XMR_ADDRESS</code> in <code>renderer/app.js</code>.</p>
        <p style="font-size:12px;color:var(--muted)">Tip: generate a fresh subaddress in <a id="xmr-feather" href="#">Feather</a> or <a id="xmr-cake" href="#">Cake Wallet</a> labelled "Glass donations" so you can track it without losing privacy.</p>
      </div>
    `}
    <div class="modal-actions">
      <button id="xmr-back">Back</button>
      <button id="xmr-close" class="primary">Close</button>
    </div>
  `, { wide: true });

  modalBody.querySelector('#xmr-back').onclick = showDonateMenu;
  modalBody.querySelector('#xmr-close').onclick = closeModal;

  if (addr) {
    const msg = modalBody.querySelector('#xmr-msg');
    modalBody.querySelector('#xmr-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(addr);
        msg.textContent = 'Copied to clipboard.';
        msg.style.color = '#4ade80';
      } catch {
        msg.textContent = 'Couldn\'t access clipboard — please select the address manually.';
        msg.style.color = '#fca5a5';
      }
    };
    modalBody.querySelector('#xmr-uri').onclick = () => {
      // Most Monero wallets register the monero: URI scheme.
      window.app.openExternal('monero:' + addr);
    };
  } else {
    const f = modalBody.querySelector('#xmr-feather');
    const c = modalBody.querySelector('#xmr-cake');
    if (f) f.onclick = (e) => { e.preventDefault(); window.app.openExternal('https://featherwallet.org/'); };
    if (c) c.onclick = (e) => { e.preventDefault(); window.app.openExternal('https://cakewallet.com/'); };
  }
}

refreshAccountBtn();

// If the on-disk auth backup restores the session after this point (api.js's
// rehydrateAuthFromFile runs async), refresh the topnav button so the user
// sees the right state without needing to reload.
window.addEventListener('piped-auth-restored', () => {
  refreshAccountBtn();
});

// ============================================================
// yt-dlp setup
// ============================================================
function showBanner(html, kind = '') {
  banner.innerHTML = `<div class="install-banner ${kind}">${html}</div>`;
}
function clearBanner() { banner.innerHTML = ''; }

function showInstallPrompt() {
  showBanner(`
    <div class="banner-text">
      <strong>yt-dlp not installed</strong>
      <span>Required for reliable video playback — bypasses YouTube's bot-block on Piped instances. Around 17 MB, downloaded once.</span>
    </div>
    <button id="ytdlp-go">Install yt-dlp</button>
  `);
  banner.querySelector('#ytdlp-go').onclick = runInstall;
}

function showInstallProgress() {
  showBanner(`
    <div class="banner-text">
      <strong>Installing yt-dlp…</strong>
      <span id="yt-progress-line">Starting download</span>
    </div>
    <div class="progress"><div class="progress-fill" id="yt-fill"></div></div>
    <span class="progress-label" id="yt-pct">0%</span>
  `);
}

async function runInstall() {
  showInstallProgress();
  const fill = banner.querySelector('#yt-fill');
  const pct  = banner.querySelector('#yt-pct');
  const line = banner.querySelector('#yt-progress-line');

  const off = window.app.ytdlp.onInstallProgress(({ received, total }) => {
    if (total) {
      const p = Math.round(received / total * 100);
      fill.style.width = p + '%';
      pct.textContent = p + '%';
      line.textContent = `${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
    } else {
      line.textContent = `${(received / 1e6).toFixed(1)} MB`;
    }
  });

  const res = await window.app.ytdlp.install();
  off();

  if (res.ok) {
    ytdlpReady = true;
    showBanner(`
      <div class="banner-text">
        <strong>yt-dlp installed.</strong>
        <span>Video playback now uses your home IP — no more bot-block errors.</span>
      </div>
      <button id="yt-dismiss">Got it</button>
    `, 'success');
    banner.querySelector('#yt-dismiss').onclick = clearBanner;
    setTimeout(clearBanner, 6000);
  } else {
    showBanner(`
      <div class="banner-text">
        <strong>Install failed</strong>
        <span>${escape(res.error || 'unknown error')}</span>
      </div>
      <button id="yt-retry">Try again</button>
    `, 'error');
    banner.querySelector('#yt-retry').onclick = runInstall;
  }
}

async function checkYtdlp() {
  try {
    const s = await window.app.ytdlp.status();
    ytdlpReady = !!s.installed;
    if (!ytdlpReady) showInstallPrompt();
  } catch (e) {
    console.warn('yt-dlp status check failed:', e);
  }
}

// ============================================================
// Boot
// ============================================================
checkYtdlp();
// Pull the live Piped instance list in the background, then load home.
// If the index is unreachable we still have the static seed list to try.
refreshInstances().finally(() => go('home'));

// Prompt to continue last-watched video on app launch (if any progress saved).
function maybePromptResumeLast() {
  if (currentSettings.askResume === false) return;
  // Don't clobber a higher-priority banner (yt-dlp install prompt etc.)
  if (banner.firstElementChild) return;
  const last = getLastVideo();
  if (!last || !last.id) return;
  const saved = getResume(last.id);
  if (!saved || saved.position < 30) return;
  if (saved.duration && saved.position / saved.duration > 0.95) return;

  const pct = saved.duration ? Math.round(saved.position / saved.duration * 100) : 0;
  const thumbHTML = last.thumbnail
    ? `<div class="resume-thumb-wrap">
         <img src="${escapeAttr(last.thumbnail)}" referrerpolicy="no-referrer" alt="" />
         <div class="resume-thumb-progress"><div style="width:${pct}%"></div></div>
         <div class="resume-thumb-time">${fmtDuration(Math.floor(saved.position))}</div>
       </div>`
    : '';

  banner.innerHTML = `
    <div class="resume-last-banner">
      ${thumbHTML}
      <div class="resume-info">
        <div class="resume-prompt">Pick up where you left off</div>
        <div class="resume-title">${escape(last.title || 'Last video')}</div>
        <div class="resume-meta">${last.uploaderName ? escape(last.uploaderName) + ' · ' : ''}${fmtDuration(Math.floor(saved.position))}${saved.duration ? ' / ' + fmtDuration(Math.floor(saved.duration)) : ''}</div>
      </div>
      <div class="resume-actions">
        <button id="continue-last" class="primary">Continue</button>
        <button id="skip-last">Dismiss</button>
      </div>
    </div>
  `;
  banner.querySelector('#continue-last').onclick = () => {
    clearBanner();
    go('video', last.id);
  };
  banner.querySelector('#skip-last').onclick = clearBanner;
}
// Slight delay so the dashboard paints first; banner appears 600ms in.
setTimeout(maybePromptResumeLast, 600);

// ============================================================
// Watch together (PeerJS-backed P2P sync)
// ============================================================
// The watchParty singleton from ./watchparty.js handles the network layer.
// This block wires it to the existing UI: a topnav icon to open the room
// dialog, capture-phase listeners on the main player so any local play /
// pause / seek broadcasts to peers, and a tiny applier that mirrors inbound
// events back to the local <video>.

// Helper: apply an inbound event without echoing it back. The watchParty
// broadcast() short-circuits when `applyingRemote` is true, so anything we
// touch on the player during this window won't bounce back to peers.
//
// Counter-based so overlapping calls (e.g. an inner snap inside an outer
// navigation hold) keep the flag set until ALL pending timers expire,
// instead of the older single-timeout approach where the first decrement
// would flip the flag back to false mid-apply.
let wpApplyDepth = 0;
function wpApply(fn, holdMs = 350) {
  wpApplyDepth++;
  watchParty.applyingRemote = true;
  try { fn(); } catch (err) { wpLog('apply error', err); }
  setTimeout(() => {
    wpApplyDepth = Math.max(0, wpApplyDepth - 1);
    if (wpApplyDepth === 0) watchParty.applyingRemote = false;
  }, holdMs);
}

// Optional debug logging — turn on by running `localStorage.setItem('wp-debug', '1')`
// in DevTools and reloading. Off by default; zero cost when off.
const WP_DEBUG = (typeof localStorage !== 'undefined') && localStorage.getItem('wp-debug') === '1';
function wpLog(...args) { if (WP_DEBUG) console.log('[wp]', ...args); }

// Wait for the main player <video> to mount (and pick up enough metadata
// to seek). Used by remote video navigation so the time-snap happens AFTER
// the element is actually in the DOM and seekable, instead of guessing at
// a fixed timeout that's too short on slow networks.
function waitForPlayerVideo(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = document.querySelector('#player-wrap video');
      // readyState 1 = HAVE_METADATA, enough to set currentTime. We don't
      // wait for HAVE_FUTURE_DATA because that takes much longer on a
      // cold-start fetch and we'd rather seek early and let the player
      // buffer than sit waiting.
      if (v && v.readyState >= 1) return resolve(v);
      if (v && Date.now() - start > timeoutMs / 2) return resolve(v); // got the element, just not metadata
      if (Date.now() - start > timeoutMs) return resolve(v || null);
      setTimeout(tick, 80);
    };
    tick();
  });
}

// Combined "navigate + snap to time" for remote 'video' / 'state' messages.
// Holds applyingRemote across the entire flow (navigation → element mount
// → autoplay event burst → time snap) so the new video's startup events
// don't echo back to peers as a brand-new "play at t=0" broadcast — which
// is exactly the bug that was yanking other peers back to 0 on join.
async function wpApplyVideoSnap(videoId, t, paused) {
  wpLog('snap →', videoId, 't=' + t, paused ? 'paused' : 'playing');
  // Outer hold: 4 s covers go() + fetchVideoData + renderVideo + the very
  // first autoplay/play/canplay event burst on the new <video>.
  wpApply(() => go('video', videoId), 4000);
  const v = await waitForPlayerVideo(5500);
  if (!v) { wpLog('snap: no video element after wait'); return; }
  // Inner hold piggybacks on the outer one via the counter, then adds an
  // extra 1.5 s buffer in case the outer is close to expiring.
  wpApply(() => {
    if (typeof t === 'number' && isFinite(t) && t > 0) {
      try { v.currentTime = t; } catch (e) { wpLog('seek failed', e); }
    }
    if (paused) v.pause();
    else v.play().catch(() => {});
  }, 1500);
}

// The only <video> we want to mirror is the main player's — NOT the seek
// preview thumb, NOT the various inline hover previews. Filter by location.
function isMainPlayerVideo(el) {
  return el && el.tagName === 'VIDEO' && el.closest('#player-wrap') !== null;
}

// Local player events → broadcast. Capture phase because the play/pause/
// seeked events on <video> don't bubble. Every broadcast carries the
// current videoId so peers can drop messages meant for a different video
// (which happens briefly during navigation transitions).
document.addEventListener('play', (e) => {
  if (!watchParty.inRoom || watchParty.applyingRemote) return;
  if (!isMainPlayerVideo(e.target)) return;
  watchParty.broadcast({ type: 'play', videoId: currentVideoId, t: e.target.currentTime });
}, true);
document.addEventListener('pause', (e) => {
  if (!watchParty.inRoom || watchParty.applyingRemote) return;
  if (!isMainPlayerVideo(e.target)) return;
  watchParty.broadcast({ type: 'pause', videoId: currentVideoId, t: e.target.currentTime });
}, true);
document.addEventListener('seeked', (e) => {
  if (!watchParty.inRoom || watchParty.applyingRemote) return;
  if (!isMainPlayerVideo(e.target)) return;
  watchParty.broadcast({ type: 'seek', videoId: currentVideoId, t: e.target.currentTime });
}, true);

// Periodic time sync from the HOST. Guests follow if they've drifted past
// 0.75s — anything smaller and we'd thrash the sidecar audio drift loop.
setInterval(() => {
  if (!watchParty.inRoom || !watchParty.isHost) return;
  const v = document.querySelector('#player-wrap video');
  if (!v) return;
  watchParty.broadcast({ type: 'tick', videoId: currentVideoId, t: v.currentTime, paused: v.paused });
}, 3000);

// Inbound messages → mirror onto the local player.
watchParty.addEventListener('message', (e) => {
  const { data, from } = e.detail;
  if (!data || typeof data !== 'object') return;

  // Chat messages — applied independently of the player state machine.
  if (data.type === 'chat') {
    addChatMessage({
      id: data.id || chatRandomId(),
      name: String(data.name || 'Guest').slice(0, 32),
      text: String(data.text || '').slice(0, 500),
      ts: typeof data.ts === 'number' ? data.ts : Date.now(),
      own: false,
    });
    return;
  }

  if (data.type === 'hello') {
    // A guest just joined. Send them our current state so they jump straight
    // to whatever we're watching, at the right time, paused/playing matching.
    const v = document.querySelector('#player-wrap video');
    const conn = watchParty.connections.get(from);
    if (conn) {
      watchParty.send(conn, {
        type: 'state',
        videoId: currentVideoId || null,
        t: v ? v.currentTime : 0,
        paused: v ? v.paused : true,
      });
    }
    return;
  }

  if (data.type === 'state') {
    wpLog('state recv', data);
    if (data.videoId && data.videoId !== currentVideoId) {
      wpApplyVideoSnap(data.videoId, data.t, data.paused);
    } else if (data.videoId === currentVideoId) {
      // Same video; just align time + paused state.
      const v = document.querySelector('#player-wrap video');
      if (v) wpApply(() => {
        if (typeof data.t === 'number') v.currentTime = data.t;
        if (data.paused) v.pause();
        else v.play().catch(() => {});
      }, 700);
    }
    return;
  }

  if (data.type === 'video') {
    wpLog('video recv', data.id);
    if (data.id && data.id !== currentVideoId) {
      // Don't know the host's exact time yet, but assume they're at 0 (or
      // very close) since they just navigated. The next 'tick' will pull
      // everyone into proper alignment within ~3 s.
      wpApplyVideoSnap(data.id, 0, false);
    }
    return;
  }

  // The rest assume we're already on the right video. Bail if there's no
  // player visible — happens during navigation or on non-video routes.
  const v = document.querySelector('#player-wrap video');
  if (!v) { wpLog('drop ' + data.type + ' — no video element'); return; }

  // If the message carries a videoId and it doesn't match ours, drop it.
  // This guards the brief window during navigation when the two peers are
  // on different videos and a stale event from the previous video arrives.
  if (data.videoId && data.videoId !== currentVideoId) {
    wpLog('drop ' + data.type + ' — wrong video', data.videoId, '!=', currentVideoId);
    return;
  }

  if (data.type === 'play') {
    wpApply(() => {
      // Only snap currentTime when the remote is meaningfully ahead. The
      // old "snap on any 0.5 s drift" rule got triggered by a fresh joiner's
      // auto-play (their t=0 vs the host's actual time) and was rewinding
      // the host every time someone joined.
      if (typeof data.t === 'number' && data.t > 1 && Math.abs(v.currentTime - data.t) > 1.0) {
        v.currentTime = data.t;
      }
      v.play().catch(() => {});
    });
  } else if (data.type === 'pause') {
    wpApply(() => {
      v.pause();
      if (typeof data.t === 'number' && data.t > 1 && Math.abs(v.currentTime - data.t) > 1.0) {
        v.currentTime = data.t;
      }
    });
  } else if (data.type === 'seek') {
    if (typeof data.t === 'number') wpApply(() => { v.currentTime = data.t; });
  } else if (data.type === 'tick') {
    // Only snap if we've drifted noticeably AND the player is in a sane
    // state. readyState < 2 means we haven't decoded a frame yet — snapping
    // currentTime there does nothing useful, and seeking guards against
    // fighting an in-progress user seek.
    if (typeof data.t !== 'number' || v.seeking || v.readyState < 2) return;
    const drift = Math.abs(v.currentTime - data.t);
    if (drift > 0.75) wpApply(() => { v.currentTime = data.t; });
    if (data.paused && !v.paused) wpApply(() => v.pause());
    if (!data.paused && v.paused) wpApply(() => v.play().catch(() => {}));
  }
});

// Reflect room state in the topnav button. Active class + a tiny count badge.
watchParty.addEventListener('state', (e) => {
  const { inRoom, roomCode, peerCount } = e.detail;
  const btn = document.getElementById('wp-btn');
  const badge = document.getElementById('wp-badge');
  if (!btn) return;
  if (inRoom) {
    btn.classList.add('active');
    btn.title = `Watch together — Room ${roomCode} (${peerCount} other${peerCount === 1 ? '' : 's'})`;
    if (badge) { badge.textContent = String(peerCount + 1); badge.hidden = false; }
  } else {
    btn.classList.remove('active');
    btn.title = 'Watch together';
    if (badge) { badge.hidden = true; badge.textContent = ''; }
  }
  // If the room dialog is currently open, re-render it so it shows fresh
  // peer count / state without the user needing to close-and-reopen.
  if (!modal.classList.contains('hidden') && modalBody.querySelector('[data-wp-modal]')) {
    showWatchPartyMenu();
  }
});

watchParty.addEventListener('error', (e) => {
  const m = e.detail?.message;
  if (!m) return;
  // Show in the existing install-banner area — same prominence as yt-dlp
  // banners, easy to dismiss, doesn't trap focus the way a modal would.
  showBanner(`<div class="banner-text"><strong>Watch together</strong><span>${escape(m)}</span></div>`, 'error');
  setTimeout(clearBanner, 5000);
});

// Topnav button → open the dialog.
const wpBtn = document.getElementById('wp-btn');
if (wpBtn) wpBtn.onclick = showWatchPartyMenu;

function showWatchPartyMenu() {
  if (watchParty.inRoom) showWatchPartyRoom();
  else showWatchPartyStart();
}

function showWatchPartyStart() {
  // Pre-fill the name field with any previously-saved display name so
  // returning users don't have to retype. New users get an empty box with
  // a helpful placeholder.
  const savedName = localStorage.getItem('wp-name') || '';
  openModal(`
    <h2 data-wp-modal>Watch together</h2>
    <div class="modal-sub">Sync video playback with friends — share a code or join one.</div>

    <div class="wp-name-row">
      <label class="wp-field-label" for="wp-name">Your name</label>
      <input type="text" id="wp-name" class="wp-name-input" maxlength="24" placeholder="What should others see?" autocomplete="off" spellcheck="false" value="${escapeAttr(savedName)}" />
    </div>

    <div class="auth-options">
      <button class="auth-card" id="wp-start" type="button">
        <span class="auth-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/>
          </svg>
        </span>
        <div class="auth-text"><strong>Start a room</strong><span>Get a 6-character code to share.</span></div>
      </button>

      <div class="auth-card auth-card-static wp-join-card">
        <div class="auth-card-head">
          <span class="auth-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
          </span>
          <div class="auth-text"><strong>Join a room</strong><span>Enter a code someone sent you.</span></div>
        </div>
        <div class="wp-join-form">
          <input type="text" id="wp-code-input" maxlength="${ROOM_CODE_LENGTH}" placeholder="ABCDEF" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Room code" />
          <button id="wp-join-go" class="modal-btn primary">Join</button>
        </div>
      </div>
    </div>

    <div id="wp-msg" class="hint wp-msg"></div>
  `);

  const msgEl = modalBody.querySelector('#wp-msg');
  const setMsg = (text, kind = '') => {
    msgEl.textContent = text || '';
    msgEl.dataset.kind = kind;
  };

  const nameInput = modalBody.querySelector('#wp-name');
  // Persist the name as the user types so it survives modal close/re-open and
  // is what getOrCreateChatName() will return going forward.
  nameInput.addEventListener('input', () => {
    const v = nameInput.value.trim();
    if (v) localStorage.setItem('wp-name', v);
  });
  // Block name characters that mangle things on the wire (control chars,
  // newlines). Trimming is done at send time.
  const cleanName = () => nameInput.value.trim().slice(0, 24);
  const requireName = () => {
    const v = cleanName();
    if (!v) {
      setMsg('Pick a name first — that\'s what others will see in chat.', 'error');
      nameInput.focus();
      nameInput.classList.add('wp-shake');
      setTimeout(() => nameInput.classList.remove('wp-shake'), 320);
      return null;
    }
    localStorage.setItem('wp-name', v);
    return v;
  };

  modalBody.querySelector('#wp-start').onclick = async () => {
    if (!requireName()) return;
    setMsg('Creating room…', 'loading');
    modalBody.querySelector('#wp-start').disabled = true;
    modalBody.querySelector('#wp-join-go').disabled = true;
    try {
      await watchParty.create();
      showWatchPartyRoom();
    } catch (e) {
      setMsg(e.message || 'Could not start a room.', 'error');
      modalBody.querySelector('#wp-start').disabled = false;
      modalBody.querySelector('#wp-join-go').disabled = false;
    }
  };

  const codeInput = modalBody.querySelector('#wp-code-input');
  codeInput.addEventListener('input', () => {
    const cleaned = normalizeRoomCode(codeInput.value);
    if (cleaned !== codeInput.value) codeInput.value = cleaned;
  });
  codeInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      modalBody.querySelector('#wp-join-go').click();
    }
  });

  modalBody.querySelector('#wp-join-go').onclick = async () => {
    if (!requireName()) return;
    const code = normalizeRoomCode(codeInput.value);
    if (code.length !== ROOM_CODE_LENGTH) {
      setMsg(`Code should be ${ROOM_CODE_LENGTH} characters.`, 'error');
      codeInput.focus();
      return;
    }
    setMsg('Joining…', 'loading');
    modalBody.querySelector('#wp-join-go').disabled = true;
    try {
      await watchParty.join(code);
      showWatchPartyRoom();
    } catch (e) {
      setMsg(e.message || 'Could not join that room.', 'error');
      modalBody.querySelector('#wp-join-go').disabled = false;
    }
  };

  // If a saved name exists, jump straight to the code field; otherwise the
  // name field is the right starting point.
  setTimeout(() => {
    (savedName ? codeInput : nameInput).focus();
  }, 0);
}

function showWatchPartyRoom() {
  const code = watchParty.roomCode;
  const count = watchParty.peerCount;
  const total = count + 1;
  openModal(`
    <h2 data-wp-modal>Watch together</h2>
    <div class="modal-sub">${watchParty.isHost ? "You started this room." : "You joined a room."}</div>
    <div class="wp-code-block">
      <div class="wp-code-label">Room code</div>
      <div class="wp-code">${escape(code)}</div>
      <button class="modal-btn" id="wp-copy" type="button">Copy</button>
    </div>
    <div class="wp-info-row">
      <div class="wp-info-card wp-peers-card" aria-label="${total} ${total === 1 ? 'person' : 'people'} watching">
        <div class="wp-peers-top">
          <span class="wp-info-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </span>
          <strong class="wp-peers-count">${total}</strong>
        </div>
        <div class="wp-peers-label">${total === 1 ? 'PERSON' : 'PEOPLE'} WATCHING</div>
      </div>
      <div class="wp-info-card wp-tip-card">
        <span class="wp-info-icon wp-tip-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </span>
        <div class="wp-tip-text">Play, pause, seek, or switch videos — everyone follows along.</div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="modal-btn" id="wp-close" type="button">Close</button>
      <button class="modal-btn danger" id="wp-leave" type="button">Leave room</button>
    </div>
  `);

  const copyBtn = modalBody.querySelector('#wp-copy');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      const orig = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    } catch { /* clipboard may be unavailable */ }
  };
  modalBody.querySelector('#wp-close').onclick = closeModal;
  modalBody.querySelector('#wp-leave').onclick = () => {
    watchParty.leave();
    closeModal();
  };
}


// ============================================================
// Watch-together chat panel
// ============================================================
// Companion to the watchParty sync. The comments column now has a Comments
// / Chat tab bar (left side); the Chat tab shows an empty state when not
// in a room and a real message list + composer when you are. Messages
// pass through the same DataChannel relay the playback events use.

const chatMessages = [];
const MAX_CHAT_HISTORY = 200;

function getOrCreateChatName() {
  let name = localStorage.getItem('wp-name');
  if (!name) {
    name = 'Guest ' + (1000 + Math.floor(Math.random() * 9000));
    localStorage.setItem('wp-name', name);
  }
  return name;
}

function chatRandomId() {
  // Short non-cryptographic id — only used for dedupe / log keys.
  return Math.random().toString(36).slice(2, 10);
}

function chatFormatTime(ts) {
  const d = new Date(ts);
  return d.getHours() + ':' + d.getMinutes().toString().padStart(2, '0');
}

function appendChatToDom(container, msg) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (msg.own ? ' own' : '');
  // Avoid duplicate `(you)` labels by keeping the "you" tag in the meta
  // only for own messages. Escape everything that came from peers.
  const youTag = msg.own ? ' <span class="chat-msg-you">(you)</span>' : '';
  div.innerHTML = `
    <div class="chat-msg-meta">
      <span class="chat-msg-name">${escape(msg.name)}</span>${youTag}
      <span class="chat-msg-time">${chatFormatTime(msg.ts)}</span>
    </div>
    <div class="chat-msg-text">${escape(msg.text)}</div>
  `;
  container.appendChild(div);
}

function addChatMessage(msg) {
  chatMessages.push(msg);
  while (chatMessages.length > MAX_CHAT_HISTORY) chatMessages.shift();
  const container = document.querySelector('#chat-messages');
  if (container) {
    appendChatToDom(container, msg);
    container.scrollTop = container.scrollHeight;
    // Unread dot — only flash when the user isn't already looking at chat
    // and the message isn't one we just sent ourselves.
    const col = document.querySelector('.comments-col');
    if (col && col.dataset.cside !== 'chat' && !msg.own) {
      const dot = document.querySelector('#chat-tab-dot');
      if (dot) dot.hidden = false;
    }
  }
}

function refreshChatVisibility() {
  const empty = document.querySelector('#chat-empty');
  const messages = document.querySelector('#chat-messages');
  const composer = document.querySelector('#chat-composer');
  if (!empty || !messages || !composer) return;
  if (watchParty.inRoom) {
    empty.hidden = true;
    messages.hidden = false;
    composer.hidden = false;
  } else {
    empty.hidden = false;
    messages.hidden = true;
    composer.hidden = true;
  }
}

function wireChatPanel() {
  // Idempotent — call from renderVideo whenever the page innerHTML is
  // refreshed. The chatMessages array lives at module scope so history
  // survives navigation across videos within the same room session.
  const panel = view.querySelector('#chat-panel');
  if (!panel) return;
  const col = view.querySelector('.comments-col');
  const tabs = view.querySelectorAll('.comments-tab');

  // Tab switching (Comments / Chat)
  tabs.forEach(btn => {
    btn.onclick = () => {
      const target = btn.dataset.csideTarget;
      if (!col || col.dataset.cside === target) return;
      col.dataset.cside = target;
      tabs.forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (target === 'chat') {
        const dot = view.querySelector('#chat-tab-dot');
        if (dot) dot.hidden = true;
        if (watchParty.inRoom) {
          setTimeout(() => view.querySelector('#chat-input')?.focus(), 0);
        }
      }
    };
  });

  refreshChatVisibility();

  // Re-render existing history into the freshly-mounted DOM.
  const messagesEl = view.querySelector('#chat-messages');
  if (messagesEl) {
    chatMessages.forEach(m => appendChatToDom(messagesEl, m));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Open watch-party modal from empty state's CTA.
  const openBtn = view.querySelector('#chat-open-wp');
  if (openBtn) openBtn.onclick = () => showWatchPartyMenu();

  // Composer — send on Enter (Shift+Enter = newline-equivalent for plain
  // input means nothing, so we just always send on Enter).
  const input = view.querySelector('#chat-input');
  const sendBtn = view.querySelector('#chat-send');
  if (!input || !sendBtn) return;
  const sendMessage = () => {
    const text = input.value.trim();
    if (!text || !watchParty.inRoom) return;
    const msg = {
      id: chatRandomId(),
      name: getOrCreateChatName(),
      text,
      ts: Date.now(),
    };
    addChatMessage({ ...msg, own: true });
    watchParty.broadcast({ type: 'chat', id: msg.id, name: msg.name, text: msg.text, ts: msg.ts });
    input.value = '';
  };
  sendBtn.onclick = sendMessage;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });
}

// Module-level state listener so the chat panel's empty / active state
// flips correctly even when the user enters / leaves a room from
// somewhere other than a video page. Querying the DOM at fire time
// means we don't have to manage subscription lifecycles per-render.
watchParty.addEventListener('state', refreshChatVisibility);
