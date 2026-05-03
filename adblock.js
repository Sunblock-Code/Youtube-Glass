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

let stats = { blocked: 0, allowed: 0 };

function shouldBlock(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (AD_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return true;
    if (AD_PATTERNS.some(p => p.test(url))) return true;
  } catch {}
  return false;
}

function setupAdblock(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    if (shouldBlock(details.url)) {
      stats.blocked++;
      cb({ cancel: true });
    } else {
      stats.allowed++;
      cb({});
    }
  });
}

module.exports = { setupAdblock, stats };
