// Generates public/hero-orbit.jpg: the abstract "event energy" image that sits
// inside the landing hero's rotating sphere. Procedural and seeded, so the asset
// is Plansphere's own and reproducible: `node scripts/generate-hero-orbit.mjs`.
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SIZE = 1020;
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/hero-orbit.jpg");

let seed = 20260926;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const beams = Array.from({ length: 9 }, (_, i) => {
  const originX = 510 + (rnd() - 0.5) * 220;
  const angle = -52 + i * 13 + (rnd() - 0.5) * 6;
  const spread = 4 + rnd() * 7;
  const len = 1500;
  const a1 = ((angle - spread / 2) * Math.PI) / 180;
  const a2 = ((angle + spread / 2) * Math.PI) / 180;
  const pts = [
    [originX, -40],
    [originX + Math.sin(a1) * len, -40 + Math.cos(a1) * len],
    [originX + Math.sin(a2) * len, -40 + Math.cos(a2) * len],
  ]
    .map((p) => p.map((n) => n.toFixed(1)).join(","))
    .join(" ");
  return `<polygon points="${pts}" fill="url(#beam)" opacity="${(0.28 + rnd() * 0.4).toFixed(2)}"/>`;
});

const bokeh = Array.from({ length: 70 }, () => {
  const x = rnd() * SIZE;
  const y = 380 + rnd() * 640;
  const r = 8 + Math.pow(rnd(), 2.2) * 70;
  const o = 0.1 + rnd() * 0.5;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#fff" opacity="${o.toFixed(2)}"/>`;
});

const crowd = Array.from({ length: 46 }, () => {
  const x = rnd() * SIZE;
  const h = 40 + rnd() * 120;
  return `<ellipse cx="${x.toFixed(1)}" cy="${(SIZE - h / 3).toFixed(1)}" rx="${(22 + rnd() * 26).toFixed(1)}" ry="${h.toFixed(1)}" fill="#000" opacity="0.85"/>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2330"/>
      <stop offset="0.55" stop-color="#0a0d12"/>
      <stop offset="1" stop-color="#000"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.95"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.32" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="soft2" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="haze" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="40"/></filter>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  <g filter="url(#haze)"><ellipse cx="510" cy="330" rx="420" ry="260" fill="url(#glow)"/></g>
  <g filter="url(#soft2)">${beams.join("")}</g>
  <g filter="url(#soft)">${bokeh.join("")}</g>
  <g filter="url(#soft2)">${crowd.join("")}</g>
</svg>`;

await sharp(Buffer.from(svg)).jpeg({ quality: 84, mozjpeg: true }).toFile(out);
console.log("wrote", out);
