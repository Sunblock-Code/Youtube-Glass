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

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const svgBuf = fs.readFileSync(svg);

  const pngs = await Promise.all(sizes.map(size =>
    sharp(svgBuf, { density: Math.max(150, size * 2) })
      .resize(size, size)
      .png()
      .toBuffer()
  ));

  const icoBuf = await toIco(pngs);
  fs.writeFileSync(ico, icoBuf);

  // 256-px PNG fallback (Electron uses this on some surfaces).
  await sharp(svgBuf, { density: 600 })
    .resize(256, 256)
    .png()
    .toFile(png);

  console.log(`[build-icon] wrote ${path.relative(root, ico)} and ${path.relative(root, png)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
