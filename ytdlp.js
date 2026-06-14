// yt-dlp manager (main process).
// - Stores yt-dlp.exe in Electron's userData dir (so the app folder stays clean).
// - Downloads on demand from the official GitHub releases.
// - Runs `yt-dlp -j` and returns parsed JSON.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { app } = require('electron');

const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const MIN_VALID_SIZE = 1_000_000; // 1 MB — anything smaller is a redirect/HTML page

// Lives next to main.js in the project folder, not in %APPDATA%, so it's
// visible alongside the rest of the app and easy to update / replace.
function binPath() {
  return path.join(__dirname, 'yt-dlp.exe');
}

function isInstalled() {
  try {
    const p = binPath();
    return fs.existsSync(p) && fs.statSync(p).size > MIN_VALID_SIZE;
  } catch {
    return false;
  }
}

// Recursive HTTPS GET that follows up to 5 redirects.
function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'youtube-glass/0.1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return get(next, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function install(onProgress) {
  const dest = binPath();
  const tmp = dest + '.partial';
  // Make sure userData exists (Electron creates it lazily).
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const res = await get(RELEASE_URL);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let received = 0;

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    res.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress({ received, total });
    });
    res.on('error', reject);
    file.on('error', reject);
    file.on('finish', () => file.close(resolve));
    res.pipe(file);
  });

  // Sanity check
  const size = fs.statSync(tmp).size;
  if (size < MIN_VALID_SIZE) {
    fs.unlinkSync(tmp);
    throw new Error(`Downloaded file too small (${size} bytes) — looks like an error page.`);
  }

  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(tmp, dest);
  return dest;
}

function getVideo(videoId) {
  return new Promise((resolve, reject) => {
    if (!isInstalled()) return reject(new Error('yt-dlp not installed'));
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    execFile(
      binPath(),
      [
        '-j',                    // single-line JSON dump
        '--no-playlist',
        '--no-warnings',
        '--no-call-home',
        '--ignore-config',       // don't pick up user's yt-dlp config that might break things
        '--extractor-retries', '3',
        // No --extractor-args override — let yt-dlp pick the player_client
        // combo that currently works against YouTube. The combo it ships with
        // tracks YouTube's changes far better than a hardcoded list. (Verified:
        // forcing web_safari/ios/tv to try to get an adaptive HLS manifest just
        // fails with "Requested format is not available" — those clients are
        // bot-blocked / need PO tokens. The default gives progressive URLs.)
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // execFile gives us a process error; the actually useful message
          // is usually on stderr.
          const tail = (stderr || '').trim().split('\n').slice(-3).join(' ');
          return reject(new Error(tail || err.message));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('Failed to parse yt-dlp output: ' + e.message));
        }
      }
    );
  });
}

// List a channel's recent uploads via yt-dlp. Used as a fallback when the
// Piped instance returns an empty relatedStreams for a channel (Piped's
// extractor occasionally breaks for specific channels while yt-dlp keeps
// working). Returns items shaped to match Piped's relatedStreams entries
// so the renderer can drop them in without conversion logic.
//
// Flat-playlist is used because we only need card-level metadata (id,
// title, thumbnail, duration). The trade-off: yt-dlp doesn't populate
// view_count / uploader / timestamp in flat mode, so those fields come
// back as null/empty — the renderer treats missing values gracefully.
function getChannelVideos(channelId, limit) {
  return new Promise((resolve, reject) => {
    if (!isInstalled()) return reject(new Error('yt-dlp not installed'));
    const url = `https://www.youtube.com/channel/${channelId}/videos`;
    const n = Math.max(1, Math.min(100, Number(limit) || 30));
    execFile(
      binPath(),
      [
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--no-call-home',
        '--ignore-config',
        '--playlist-end', String(n),
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || '').trim().split('\n').slice(-3).join(' ');
          return reject(new Error(tail || err.message));
        }
        try {
          const data = JSON.parse(stdout);
          const entries = data.entries || [];
          const items = entries
            .filter(v => v && v.id)
            .map(v => {
              const thumb = (v.thumbnails && v.thumbnails.length)
                ? v.thumbnails[v.thumbnails.length - 1].url
                : `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
              return {
                url: `/watch?v=${v.id}`,
                title: v.title || '',
                thumbnail: thumb,
                duration: typeof v.duration === 'number' ? Math.round(v.duration) : 0,
                uploaderName: v.uploader || data.uploader || data.channel || '',
                views: typeof v.view_count === 'number' ? v.view_count : null,
                uploaded: typeof v.timestamp === 'number' ? v.timestamp * 1000 : 0,
              };
            });
          resolve(items);
        } catch (e) {
          reject(new Error('Failed to parse yt-dlp output: ' + e.message));
        }
      }
    );
  });
}

// Fetch a video's autoplay "mix" (the RD<id> radio playlist) via yt-dlp, as a
// related-videos source for the sidebar "Up next" tab. This works over the
// local IP even when Piped's /streams (and its relatedStreams) is bot-blocked
// by YouTube. Entry[0] is the video itself, so it's filtered out.
function getRelated(videoId, limit) {
  return new Promise((resolve, reject) => {
    if (!isInstalled()) return reject(new Error('yt-dlp not installed'));
    const url = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    const n = Math.max(1, Math.min(40, Number(limit) || 20));
    execFile(
      binPath(),
      [
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--no-call-home',
        '--ignore-config',
        '--playlist-end', String(n + 1), // +1: the first mix entry is this video
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || '').trim().split('\n').slice(-3).join(' ');
          return reject(new Error(tail || err.message));
        }
        try {
          const data = JSON.parse(stdout);
          const entries = (data.entries || []).filter(v => v && v.id && v.id !== videoId);
          const items = entries.map(v => {
            const thumb = (v.thumbnails && v.thumbnails.length)
              ? v.thumbnails[v.thumbnails.length - 1].url
              : `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
            return {
              url: `/watch?v=${v.id}`,
              title: v.title || '',
              thumbnail: thumb,
              duration: typeof v.duration === 'number' ? Math.round(v.duration) : 0,
              uploaderName: v.uploader || v.channel || '',
              views: typeof v.view_count === 'number' ? v.view_count : null,
              uploaded: typeof v.timestamp === 'number' ? v.timestamp * 1000 : 0,
            };
          });
          resolve(items);
        } catch (e) {
          reject(new Error('Failed to parse yt-dlp output: ' + e.message));
        }
      }
    );
  });
}

// Spawn yt-dlp to download a video. Streams progress back via onProgress
// (called with { percent, totalBytes, speed, eta } when yt-dlp prints
// progress lines). Returns a promise that resolves with the final filename.
function downloadVideo(videoId, opts, onProgress) {
  return new Promise((resolve, reject) => {
    if (!isInstalled()) return reject(new Error('yt-dlp not installed'));
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    // Default: a YouTube subfolder inside the user's Downloads dir. Created on
    // demand so first-run downloads don't fail with ENOENT.
    const defaultDir = path.join(app.getPath('downloads'), 'YouTube');
    const destDir = (opts && opts.destDir) || defaultDir;
    try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* ignore */ }
    const includeChannel = !!(opts && opts.includeChannel);
    const channelSubfolder = !!(opts && opts.channelSubfolder);
    // Per-channel subfolder takes precedence: the folder already conveys the
    // channel, so the filename stays clean (no redundant "[Channel]" prefix).
    // yt-dlp creates the %(uploader)s directory on demand.
    const template = channelSubfolder
      ? path.join(destDir, '%(uploader)s', '%(title)s.%(ext)s')
      : includeChannel
        ? path.join(destDir, '[%(uploader)s] %(title)s.%(ext)s')
        : path.join(destDir, '%(title)s.%(ext)s');

    // With ffmpeg available we can fetch separate video + audio streams and
    // merge them — YouTube's single-file (muxed) formats top out around 360p,
    // so this is the difference between a 360p download and a real 1080p one.
    // Prefer AVC (H.264) video + AAC audio so the merge is a clean container
    // copy (no slow re-encode) and the result plays in everything. Without
    // ffmpeg, fall back to the best single muxed file (the old behaviour).
    const ffmpegLocation = opts && opts.ffmpegLocation;
    const args = [
      '-o', template,
      '--no-playlist',
      '--no-warnings',
      '--no-call-home',
      '--newline',
      '--progress',
    ];
    if (ffmpegLocation) {
      args.push(
        '-f', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegLocation,
      );
    } else {
      args.push('-f', 'best[ext=mp4]/best'); // single muxed file; no ffmpeg required
    }
    args.push(url);

    let lastFile = '';
    let stderrBuf = '';
    const proc = spawn(binPath(), args, { windowsHide: true });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => {
      // [download]  37.5% of   42.18MiB at  4.21MiB/s ETA 00:06
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        const dest = line.match(/^\[download\] Destination:\s*(.+)$/);
        if (dest) lastFile = dest[1];
        // When video+audio are merged, the final file is named on the Merger
        // line, not the per-stream Destination lines (which are temp fragments).
        const merge = line.match(/Merging formats into "(.+)"/);
        if (merge) lastFile = merge[1];
        const m = line.match(/\[download\]\s+(\d+\.?\d*)%(?:\s+of\s+~?\s*([\d\.]+\w+))?(?:\s+at\s+([\d\.]+\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);
        if (m && onProgress) {
          onProgress({
            percent: parseFloat(m[1]),
            totalBytes: m[2] || '',
            speed: m[3] || '',
            eta: m[4] || '',
          });
        }
      }
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve({ filename: lastFile, destDir });
      // Pull a useful line out of stderr (ERROR: <message>) — fall back to last
      // few lines if there's no obvious error.
      const lines = stderrBuf.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const errLine = lines.find(l => /^ERROR/i.test(l)) || lines.slice(-2).join(' — ');
      reject(new Error(errLine || `yt-dlp exited with code ${code}`));
    });
  });
}

// ----------------------------------------------------------------------------
// YouTube sidebar recommendations (HTML scrape of `ytInitialData`).
//
// The autoplay mix (RD<id>) is a narrow source — basically a song-radio queue
// for that one video. The "Up next" sidebar YouTube shows on a watch page is
// the algorithm's full anonymous-user recommendation list (typically ~20 items
// of varied content). That list is embedded in the watch page's HTML as
// `ytInitialData` JSON, under
//   contents.twoColumnWatchNextResults.secondaryResults.secondaryResults.results
// Each entry is a `compactVideoRenderer` (or a `compactRadioRenderer` for the
// mix entry, which we skip). We scrape that and return the formatted list — so
// "Up next" in Glass matches what YouTube actually serves on the watch page.
// ----------------------------------------------------------------------------

// HTTPS GET that follows redirects and buffers the body as a UTF-8 string.
// Chrome-shaped User-Agent + a baked CONSENT cookie so YouTube doesn't punt us
// to the EU consent interstitial.
function fetchText(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'CONSENT=YES+1; SOCS=CAI;',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchText(next, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
  });
}

// YouTube text nodes come in two shapes: { simpleText } or { runs: [{text}] }.
function ytText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return String(node.simpleText);
  if (Array.isArray(node.runs)) return node.runs.map(r => (r && r.text) || '').join('');
  return '';
}
function ytBestThumbnail(t) {
  if (!t || !Array.isArray(t.thumbnails) || !t.thumbnails.length) return '';
  // Pick the highest-resolution candidate.
  const best = t.thumbnails.reduce((a, b) => ((b && b.width) || 0) > ((a && a.width) || 0) ? b : a);
  return (best && best.url) || '';
}
// "12:34" → 754 seconds; "1:02:03" → 3723 seconds.
function ytParseDuration(s) {
  if (!s) return 0;
  const parts = String(s).split(':').map(p => parseInt(p, 10));
  if (parts.some(n => isNaN(n))) return 0;
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return total;
}
// "1.2M views" → 1200000; "23K views" → 23000; "812 views" → 812.
function ytParseViews(s) {
  if (!s) return null;
  const m = String(s).match(/([\d,.]+)\s*([KMB])?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 };
  if (m[2]) n *= (mult[m[2].toUpperCase()] || 1);
  return Math.round(n);
}

function getRecommendations(videoId, limit) {
  return new Promise(async (resolve, reject) => {
    if (!videoId) return reject(new Error('No video id'));
    const n = Math.max(1, Math.min(40, Number(limit) || 20));
    try {
      // bpctr + has_verified bypass YouTube's age-confirmation interstitial on
      // age-gated videos so we still get a populated watch page back.
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1`;
      const html = await fetchText(url);
      // ytInitialData lives inside a <script> on the watch page. Format has
      // shifted a few times — try the patterns YT has used recently.
      const patterns = [
        /var\s+ytInitialData\s*=\s*(\{[\s\S]+?\})\s*;\s*<\/script>/,
        /window\["ytInitialData"\]\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var|window|<\/script>)/,
        /ytInitialData"\s*\]\s*=\s*(\{[\s\S]+?\})\s*;/,
      ];
      let data = null;
      for (const re of patterns) {
        const m = html.match(re);
        if (!m) continue;
        try { data = JSON.parse(m[1]); break; } catch { /* try next pattern */ }
      }
      if (!data) return resolve([]);
      const results =
        (((((data.contents || {}).twoColumnWatchNextResults || {})
          .secondaryResults || {}).secondaryResults || {}).results) || [];
      // YouTube moved from compactVideoRenderer to a newer lockupViewModel
      // structure. Collect both. Each top-level entry is usually an
      // itemSectionRenderer wrapping a contents[] of items.
      const compacts = [];
      const lockups = [];
      const collectFromContainer = (arr) => {
        for (const c of arr) {
          if (!c) continue;
          if (c.compactVideoRenderer) compacts.push(c.compactVideoRenderer);
          else if (c.lockupViewModel) lockups.push(c.lockupViewModel);
          // reelShelfRenderer (Shorts), continuationItemRenderer, ad slots: skip.
        }
      };
      for (const r of results) {
        if (!r) continue;
        if (r.compactVideoRenderer) compacts.push(r.compactVideoRenderer);
        else if (r.lockupViewModel) lockups.push(r.lockupViewModel);
        else if (r.itemSectionRenderer && Array.isArray(r.itemSectionRenderer.contents)) {
          collectFromContainer(r.itemSectionRenderer.contents);
        }
      }
      const items = [];
      // compactVideoRenderer items (older format)
      for (const v of compacts) {
        if (!v.videoId || v.videoId === videoId) continue;
        items.push({
          url: `/watch?v=${v.videoId}`,
          title: ytText(v.title),
          thumbnail: ytBestThumbnail(v.thumbnail) || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          duration: ytParseDuration(ytText(v.lengthText)),
          uploaderName: ytText(v.longBylineText || v.shortBylineText),
          views: ytParseViews(ytText(v.viewCountText || v.shortViewCountText)),
          uploaded: 0,
        });
        if (items.length >= n) break;
      }
      // lockupViewModel items (newer format).
      for (const lvm of lockups) {
        if (items.length >= n) break;
        // Only videos — skip playlists / shows / mixes.
        if (lvm.contentType && lvm.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue;
        const vid = lvm.contentId;
        if (!vid || vid === videoId) continue;
        const lmvm = (lvm.metadata && lvm.metadata.lockupMetadataViewModel) || {};
        const title = (lmvm.title && lmvm.title.content) || '';
        // Thumbnail: contentImage.thumbnailViewModel.image.sources[]
        const sources = (((lvm.contentImage || {}).thumbnailViewModel || {}).image || {}).sources || [];
        let thumbnail = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
        if (sources.length) {
          const best = sources.reduce((a, b) => ((b && b.width) || 0) > ((a && a.width) || 0) ? b : a);
          if (best && best.url) thumbnail = best.url;
        }
        // Duration: thumbnailBottomOverlayViewModel.badges[].thumbnailBadgeViewModel.text
        // (older youtube responses also use thumbnailOverlayBadgeViewModel.thumbnailBadges)
        let duration = 0;
        const overlays = ((lvm.contentImage || {}).thumbnailViewModel || {}).overlays || [];
        for (const ov of overlays) {
          const ctn = ov.thumbnailBottomOverlayViewModel || ov.thumbnailOverlayBadgeViewModel || {};
          const badges = ctn.badges || ctn.thumbnailBadges || [];
          for (const b of badges) {
            const txt = (((b && b.thumbnailBadgeViewModel) || {}).text) || '';
            const t = String(txt).trim();
            if (t && /^\d+(:\d+){1,2}$/.test(t)) { duration = ytParseDuration(t); break; }
          }
          if (duration) break;
        }
        // Uploader name + view count + age: metadataRows[]
        const rows = (((lmvm.metadata || {}).contentMetadataViewModel || {}).metadataRows) || [];
        let uploaderName = '';
        let viewsText = '';
        for (const row of rows) {
          const parts = row.metadataParts || [];
          for (const p of parts) {
            const t = (p.text && p.text.content) || '';
            if (!t) continue;
            if (/views?$|views?\b/i.test(t)) { if (!viewsText) viewsText = t; }
            else if (/ ago$/i.test(t)) { /* upload-age string, skip */ }
            else if (!uploaderName) uploaderName = t;
          }
        }
        items.push({
          url: `/watch?v=${vid}`,
          title,
          thumbnail,
          duration,
          uploaderName,
          views: ytParseViews(viewsText),
          uploaded: 0,
        });
      }
      resolve(items);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { binPath, isInstalled, install, getVideo, getChannelVideos, getRelated, getRecommendations, downloadVideo };
