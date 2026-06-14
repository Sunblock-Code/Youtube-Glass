// ffmpeg manager (main process).
// - Downloads a static ffmpeg/ffprobe build ON DEMAND (the first time the user
//   asks for an HD download / HD remux), so the app folder stays lean until
//   ffmpeg is actually needed — same philosophy as ytdlp.js.
// - Binaries live next to main.js (alongside yt-dlp.exe). They are gitignored
//   and excluded from the packaged build; never commit them.

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execFile } = require('child_process');

// BtbN's FFmpeg-Builds: fully static (single .exe, no external DLLs), Windows
// x64, rolling `latest` tag. We use the LGPL variant — smaller than the GPL
// build and carries everything we need (mp4/m4a demux+mux for stream-copy
// merges, plus the built-in AAC encoder). We never transcode video, so the
// GPL-only encoders aren't needed. (yt-dlp's own mirror only ships GPL.)
const ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip';
const MIN_VALID_SIZE = 10_000_000; // a real ffmpeg.exe is ~80 MB; anything tiny is an error page

function dir()       { return __dirname; }
function binPath()   { return path.join(__dirname, 'ffmpeg.exe'); }
function probePath() { return path.join(__dirname, 'ffprobe.exe'); }

function isInstalled() {
  try {
    return fs.existsSync(binPath()) && fs.statSync(binPath()).size > MIN_VALID_SIZE;
  } catch {
    return false;
  }
}

// Recursive HTTPS GET that follows up to 5 redirects (GitHub asset URLs bounce
// through a CDN).
function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'youtube-glass/0.1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(new URL(res.headers.location, url).toString(), depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

// Depth-first search for a file by name (the zip nests the binaries under
// ffmpeg-master-latest-win64-gpl/bin/).
function findFile(root, name) {
  const stack = [root];
  const want = name.toLowerCase();
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === want) return full;
    }
  }
  return null;
}

async function install(onProgress) {
  const tag = `yt-glass-ffmpeg-${process.pid}`;
  const tmpZip = path.join(os.tmpdir(), tag + '.zip');
  const tmpDir = path.join(os.tmpdir(), tag);

  // 1. Download the archive (with progress).
  const res = await get(ZIP_URL);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let received = 0;
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpZip);
    res.on('data', (c) => { received += c.length; if (onProgress) onProgress({ received, total }); });
    res.on('error', reject);
    file.on('error', reject);
    file.on('finish', () => file.close(resolve));
    res.pipe(file);
  });

  // 2. Extract. PowerShell's Expand-Archive ships with Windows, so this needs
  //    no extra npm dependency / native unzip lib.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(tmpDir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(tmpZip)} -DestinationPath ${JSON.stringify(tmpDir)} -Force`,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err) => err ? reject(err) : resolve());
  });

  // 3. Lift ffmpeg.exe (+ ffprobe.exe) out of the nested bin/ folder.
  const srcFfmpeg = findFile(tmpDir, 'ffmpeg.exe');
  if (!srcFfmpeg) throw new Error('ffmpeg.exe not found in downloaded archive');
  fs.copyFileSync(srcFfmpeg, binPath());
  const srcProbe = findFile(tmpDir, 'ffprobe.exe');
  if (srcProbe) fs.copyFileSync(srcProbe, probePath());

  // 4. Clean up temp.
  try { fs.unlinkSync(tmpZip); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  if (!isInstalled()) throw new Error('ffmpeg install verification failed');
  return binPath();
}

// Ensure ffmpeg is present, downloading it once if needed. De-dupes concurrent
// callers onto a single download. Returns the directory holding ffmpeg.exe (to
// hand to yt-dlp's --ffmpeg-location), or null if it couldn't be obtained.
let _installing = null;
async function ensure(onProgress) {
  if (isInstalled()) return dir();
  if (!_installing) {
    _installing = install(onProgress).finally(() => { _installing = null; });
  }
  await _installing;
  return isInstalled() ? dir() : null;
}

module.exports = { dir, binPath, probePath, isInstalled, install, ensure };
