// Lightweight uBO-style request blocking. Not a full Adblock Plus engine —
// a curated domain blocklist + a few URL patterns covers the common ad/tracker
// surface. Edit AD_DOMAINS / AD_PATTERNS to extend.

const AD_DOMAINS = [
  // Google ads / analytics
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'adservice.google.com',
  'pagead2.googlesyndication.com',
  'static.doubleclick.net',
  'stats.g.doubleclick.net',
  // Generic ad networks
  'scorecardresearch.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'quantserve.com',
  'moatads.com',
  'serving-sys.com',
  'adsrvr.org',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  '3lift.com',
  'bidswitch.net',
  // Trackers
  'connect.facebook.net',
  'facebook.net',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'fullstory.com',
  'mouseflow.com',
  'newrelic.com',
  'bugsnag.com',
];

const AD_PATTERNS = [
  /\/pagead\//i,
  /\/adservice/i,
  /\/doubleclick/i,
  /[?&]ad_type=/i,
  /\/ptracking\b/i,
  /\/api\/stats\/ads\b/i,
  /\/api\/stats\/qoe\b/i,
  /\/youtubei\/v1\/log_event/i,
];

let stats = { blocked: 0, allowed: 0, unproxied: 0 };

function shouldBlock(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (AD_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return true;
    if (AD_PATTERNS.some(p => p.test(url))) return true;
  } catch {}
  return false;
}

// Piped serves every thumbnail and channel avatar through its own image
// proxy: https://<proxy-host>/<path>?host=<original-host>&<yt-params>. When
// an instance's image proxy is down or overloaded (502s) ALL images break —
// even though the assets on YouTube's CDN are reachable directly. Rewrite
// proxied image requests back to their origin host so images survive a dead
// proxy. Scoped strictly to image CDNs (ytimg/ggpht/googleusercontent) so the
// video path (yt-dlp → direct googlevideo) is never touched. The rebuilt URL
// carries no `host=` param, so it can't match again — no redirect loop.
const IMG_HOSTS = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com)$/i;

function unproxyImageUrl(rawUrl) {
  // Fast path: skip URL parsing for the >99% of requests with no host param.
  if (rawUrl.indexOf('host=') === -1) return null;
  try {
    const u = new URL(rawUrl);
    const host = u.searchParams.get('host');
    if (!host || !IMG_HOSTS.test(host)) return null;
    u.searchParams.delete('host');
    const qs = u.searchParams.toString();
    return `https://${host}${u.pathname}${qs ? '?' + qs : ''}`;
  } catch {}
  return null;
}

function setupAdblock(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    if (shouldBlock(details.url)) {
      stats.blocked++;
      return cb({ cancel: true });
    }
    const direct = unproxyImageUrl(details.url);
    if (direct) {
      stats.unproxied++;
      return cb({ redirectURL: direct });
    }
    stats.allowed++;
    cb({});
  });
}

module.exports = { setupAdblock, stats };
