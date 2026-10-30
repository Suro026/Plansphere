/**
 * Generates every icon the site declares from one SVG source.
 *
 *   node scripts/generate-icons.mjs
 *
 * Writes to public/: icon.svg, icon-32.png, icon-192.png, icon-512.png,
 * icon-maskable-512.png (safe-zone padded), apple-icon.png (180),
 * favicon.ico (PNG-in-ICO, 32 px). Uses sharp, which Next already ships.
 */

import { writeFileSync } from "node:fs";
import sharp from "sharp";

const BG = "#161826";
const ACCENT = "#9184d9";
const INK = "#e9e9ed";

/**
 * The mark: a rounded dark tile, a blurple ticket with a perforation, and the
 * F cut-out — "one pass" in a glyph. Drawn at 512 and rasterised down.
 */
const mark = (padding = 0) => {
  const s = 512;
  const p = padding;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" rx="${p ? 0 : 112}" fill="${BG}"/>
  <g transform="translate(${p} ${p}) scale(${(s - 2 * p) / s})">
    <!-- ticket -->
    <path d="M118 176c0-17.7 14.3-32 32-32h212c17.7 0 32 14.3 32 32v44a36 36 0 0 0 0 72v44c0 17.7-14.3 32-32 32H150c-17.7 0-32-14.3-32-32v-44a36 36 0 0 0 0-72z" fill="${ACCENT}"/>
    <!-- perforation -->
    <line x1="318" y1="160" x2="318" y2="352" stroke="${BG}" stroke-width="10" stroke-dasharray="14 14" stroke-linecap="round"/>
    <!-- F -->
    <path d="M172 200h108v30h-74v34h62v30h-62v52h-34z" fill="${BG}"/>
    <!-- QR hint -->
    <g fill="${INK}" opacity="0.9">
      <rect x="338" y="200" width="14" height="14" rx="3"/><rect x="358" y="200" width="14" height="14" rx="3"/><rect x="378" y="200" width="14" height="14" rx="3"/>
      <rect x="338" y="220" width="14" height="14" rx="3"/><rect x="378" y="220" width="14" height="14" rx="3"/>
      <rect x="338" y="240" width="14" height="14" rx="3"/><rect x="358" y="240" width="14" height="14" rx="3"/><rect x="378" y="240" width="14" height="14" rx="3"/>
      <rect x="338" y="272" width="14" height="14" rx="3"/><rect x="378" y="272" width="14" height="14" rx="3"/>
      <rect x="358" y="292" width="14" height="14" rx="3"/><rect x="338" y="312" width="14" height="14" rx="3"/><rect x="378" y="312" width="14" height="14" rx="3"/>
    </g>
  </g>
</svg>`;
};

const out = (name) => new URL(`../public/${name}`, import.meta.url);

const svg = Buffer.from(mark());
writeFileSync(out("icon.svg"), svg);

const png = async (size, name, source = svg) => {
  const buf = await sharp(source).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(out(name), buf);
  return buf;
};

const icon32 = await png(32, "icon-32.png");
await png(192, "icon-192.png");
await png(512, "icon-512.png");
await png(180, "apple-icon.png");
// Maskable: the mark inside the 80% safe zone on a solid ground.
await png(512, "icon-maskable-512.png", Buffer.from(mark(64)));

// favicon.ico: an ICO directory with one PNG entry (supported everywhere modern).
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // count
ico.writeUInt8(32, 6); // width
ico.writeUInt8(32, 7); // height
ico.writeUInt8(0, 8); // palette
ico.writeUInt8(0, 9); // reserved
ico.writeUInt16LE(1, 10); // planes
ico.writeUInt16LE(32, 12); // bpp
ico.writeUInt32LE(icon32.length, 14); // size
ico.writeUInt32LE(22, 18); // offset
writeFileSync(out("favicon.ico"), Buffer.concat([ico, icon32]));

console.log("icons written: icon.svg icon-32.png icon-192.png icon-512.png icon-maskable-512.png apple-icon.png favicon.ico");
