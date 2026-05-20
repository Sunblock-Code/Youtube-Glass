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
        // tracks YouTube's changes far better than a hardcoded list.
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
    const template = includeChannel
      ? path.join(destDir, '[%(uploader)s] %(title)s.%(ext)s')
      : path.join(destDir, '%(title)s.%(ext)s');

    const args = [
      '-o', template,
      '--no-playlist',
      '--no-warnings',
      '--no-call-home',
      '--newline',
      '--progress',
      '-f', 'best[ext=mp4]/best',  // single muxed file; no ffmpeg required
      url,
    ];

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

module.exports = { binPath, isInstalled, install, getVideo, getChannelVideos, downloadVideo };
