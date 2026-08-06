// Boot script — runs synchronously in <head> BEFORE the stylesheet paints
// and before app.js (which is a deferred ES module) gets a chance to run.
// Reads pre-resolved theme + sign-in values that the preload script wrote
// to window.app, and applies them to the document so the very first frame
// renders in the user's chosen theme + with the right login label.
//
// This file lives in renderer/ and is loaded via <script src="boot.js">
// instead of an inline script because the page CSP is `script-src 'self'`
// which blocks inline JS.
(function () {
  const a = window.app;
  if (!a) return;

  const root = document.documentElement;

  // 1. Theme palette → CSS custom properties
  const t = a.initialTheme;
  if (t) {
    root.style.setProperty('--accent',      t.accent);
    root.style.setProperty('--accent-soft', t.accentSoft);
    root.style.setProperty('--blob-1',      t.blob1);
    root.style.setProperty('--blob-2',      t.blob2);
    root.style.setProperty('--blob-3',      t.blob3);
    root.style.setProperty('--bg-solid',    t.bg || '#0a0612');
  }

  // 2. Boot-time HTML data-* attrs the stylesheet keys off
  const attrs = a.initialAttrs;
  if (attrs) {
    if (attrs.bgmode)   root.dataset.bgmode   = attrs.bgmode;
    if (attrs.frost)    root.dataset.frost    = attrs.frost;
    if (attrs.material) root.dataset.material = attrs.material;
    if (attrs.motion)   root.dataset.motion   = attrs.motion;
  }

  // 3. Account button label — runs once the element exists. We schedule it
  // via DOMContentLoaded since this script runs in <head> before <body>.
  // Live localStorage is the freshest source for the custom topnav name on
  // a normal launch (it persists across runs); fall back to the preload-
  // resolved value (state-file mirror / auth username) if it's absent.
  let custom = '';
  try { custom = (localStorage.getItem('piped-display-name') || '').trim(); } catch (e) {}
  const name = custom || a.initialDisplayName;
  if (name) {
    document.addEventListener('DOMContentLoaded', function () {
      const btn = document.getElementById('account-btn');
      if (!btn) return;
      btn.textContent = name;
      btn.classList.add('logged-in');
      btn.title = 'Account';
    }, { once: true });
  }
})();
