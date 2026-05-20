// Builds assets/icon.ico (multi-size) and assets/icon.png from assets/icon.svg.
// Idempotent — skips if outputs exist and are newer than the SVG, unless FORCE=1.

const fs = require('fs');
const path = require('path');

async function main() {
  const root   = path.join(__dirname, '..');
  const svg    = path.join(root, 'assets', 'icon.svg');
  const ico    = path.join(root, 'assets', 'icon.ico');
  const png    = path.join(root, 'assets', 'icon.png');

  if (!fs.existsSync(svg)) {
    console.error('Missing assets/icon.svg');
    process.exit(1);
  }

  if (!process.env.FORCE && fs.existsSync(ico) && fs.existsSync(png)) {
    const svgT = fs.statSync(svg).mtimeMs;
    const icoT = fs.statSync(ico).mtimeMs;
    if (icoT >= svgT) {
      console.log('[build-icon] up-to-date, skipping (FORCE=1 to rebuild).');
      return;
    }
  }

  // Lazy-require so a fresh clone without sharp installed still loads main.js.
  let sharp, toIco;
  try {
    sharp = require('sharp');
    toIco = require('to-ico');
  } catch (e) {
    console.warn('[build-icon] sharp / to-ico not installed — run `npm install` and try again.');
    return;
  }

  // Windows uses 16/20/24/32/40/48 in the taskbar/Alt-Tab depending on DPI
  // and 96/256 for large/Explorer. Cover them all so no size is upscaled.
  const sizes = [16, 24, 32, 40, 48, 64, 96, 128, 256];
  const svgBuf = fs.readFileSync(svg);

  // Render the SVG ONCE at a large master resolution (crisp vector raster),
  // then downscale each icon size from that with the high-quality Lanczos
  // kernel. Small taskbar sizes additionally get a mild sharpen so the play
  // mark and rounded edge stay defined instead of going soft.
  const MASTER = 1024;
  const master = await sharp(svgBuf, { density: Math.round(MASTER * 96 / 256) })
    .resize(MASTER, MASTER, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const pngs = await Promise.all(sizes.map(async size => {
    let pipe = sharp(master).resize(size, size, {
      kernel: sharp.kernel.lanczos3,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
    if (size <= 64) {
      // sigma scales with how hard we downscaled — stronger crispening for
      // the tiniest frames where softness is most visible.
      pipe = pipe.sharpen({ sigma: size <= 32 ? 0.8 : 0.5 });
    }
    return pipe.png({ compressionLevel: 9 }).toBuffer();
  }));

  const icoBuf = await toIco(pngs);
  fs.writeFileSync(ico, icoBuf);

  // 256-px PNG fallback (Electron uses this on some surfaces).
  await sharp(master)
    .resize(256, 256, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(png);

  console.log(`[build-icon] wrote ${path.relative(root, ico)} and ${path.relative(root, png)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
