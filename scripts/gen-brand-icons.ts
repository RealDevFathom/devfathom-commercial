/**
 * Generates all DevFathom brand raster assets from the master SVG mark.
 * Run: bun run scripts/gen-brand-icons.ts
 *
 * Uses `sharp` (already present via Next) to rasterize the SVG, and writes
 * a PNG-in-ICO favicon. Re-run any time the mark changes.
 */
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const pub = (...p: string[]) => join(ROOT, 'public', ...p);

// The DevFathom chevron mark — connected forward chevron of rounded "bead"
// blocks + a detached node, drawn in the design's 34 33 148 166 viewBox.
const MARK = (fill: string, nodeFill: string) => `
  <path d="M116 57 L155 97 L110 137 L75 175" fill="none" stroke="${fill}" stroke-width="22" stroke-linejoin="round" stroke-linecap="round"/>
  <rect x="98" y="39" width="38" height="36" rx="12" fill="${fill}"/>
  <rect x="135" y="77" width="41" height="41" rx="13" fill="${fill}"/>
  <rect x="90" y="118" width="41" height="38" rx="13" fill="${fill}"/>
  <rect x="56" y="156" width="37" height="37" rx="12" fill="${fill}"/>
  <rect x="40" y="81" width="35" height="34" rx="11" fill="${nodeFill}"/>`;

// Mark centred inside a 256 tile — Paper chevron with the Brass node.
const MARK_IN_TILE = `<svg x="60" y="48" width="136" height="160" viewBox="34 33 148 166">${MARK('#F7F5EF', '#BC8850')}</svg>`;

// Rounded "app-icon" tile — Abyss field, Paper mark, Brass node (transparent corners).
const markSvg = `<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="8" width="240" height="240" rx="56" fill="#0C2E2C"/>
  <rect x="9" y="9" width="238" height="238" rx="55" fill="none" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="2"/>${MARK_IN_TILE}
</svg>`;

// Full-bleed opaque tile — for Apple touch icon (no transparent corners).
const appleSvg = `<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="256" height="256" fill="#0C2E2C"/>${MARK_IN_TILE}
</svg>`;

// Flat single-colour silhouette (logo asset variants) — the chevron mark alone.
const flat = (color: string) =>
  `<svg width="256" height="256" viewBox="34 33 148 166" fill="none" xmlns="http://www.w3.org/2000/svg">${MARK(color, color)}</svg>`;

async function png(svg: string, size: number) {
  return sharp(Buffer.from(svg)).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

/** Wrap a 32×32 PNG as a PNG-compressed .ico (supported by modern browsers). */
function pngToIco(pngBuf: Buffer, size = 32): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size % 256, 0); // width (0 => 256)
  entry.writeUInt8(size % 256, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // size of image data
  entry.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([header, entry, pngBuf]);
}

async function main() {
  // SVG sources
  await writeFile(pub('favicon.svg'), markSvg);
  await writeFile(pub('images', 'icon.svg'), markSvg);
  await writeFile(pub('images', 'logo-mark.svg'), markSvg);
  await writeFile(pub('images', 'logo-orange.svg'), markSvg); // legacy name, now DevFathom mark
  await writeFile(pub('images', 'logo-dark.svg'), flat('#0C2E2C'));
  await writeFile(pub('images', 'logo-white.svg'), flat('#FFFFFF'));

  // Web favicons (transparent corners)
  await writeFile(pub('favicon-16x16.png'), await png(markSvg, 16));
  await writeFile(pub('favicon-32x32.png'), await png(markSvg, 32));
  await writeFile(pub('favicon-192x192.png'), await png(markSvg, 192));
  await writeFile(pub('favicon.png'), await png(markSvg, 512));

  // App / store icons
  await writeFile(pub('images', 'icon-orange.png'), await png(markSvg, 512)); // legacy name
  await writeFile(pub('images', 'icon-dark.png'), await png(appleSvg, 512));

  // Apple touch icon (opaque)
  await writeFile(pub('apple-touch-icon.png'), await png(appleSvg, 180));

  // .ico (PNG-in-ICO @ 32)
  await writeFile(pub('favicon.ico'), pngToIco(await png(markSvg, 32), 32));

  console.log('✓ DevFathom brand icons generated');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
