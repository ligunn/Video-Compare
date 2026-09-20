'use strict';
// Procedural icons with no image dependencies: the app icon (PNG + multi-size ICO) and the glyphs for the
// taskbar thumbnail buttons. Shapes are signed-distance functions, anti-aliased by supersampling.
const zlib = require('node:zlib');

// ---- PNG / ICO encoding ----------------------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Buffer} rgba straight-alpha RGBA, w*h*4 bytes */
function encodePng(w, h, rgba) {
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); // filter byte 0 at the row start
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Windows ICO container holding PNG images (supported since Vista). */
function encodeIco(images /* [{size, png}] */) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images.map(i => i.png)]);
}

// ---- rasteriser ------------------------------------------------------------------------------------------
/** colorAt(x, y) in unit coordinates -> [r, g, b, a(0..1)] */
function raster(size, colorAt, ss = 4) {
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = colorAt((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
      r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
    }
    const o = (py * size + px) * 4, n = ss * ss;
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round((a / n) * 255); }
  }
  return out;
}

const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
/** Convex polygon, either winding: max over edges of the distance past each edge's outward normal. */
function sdPoly(x, y, pts) {
  const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length, cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
  let d = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    let nx = b[1] - a[1], ny = a[0] - b[0];
    const len = Math.hypot(nx, ny); nx /= len; ny /= len;
    if (nx * (cx - a[0]) + ny * (cy - a[1]) > 0) { nx = -nx; ny = -ny; }
    d = Math.max(d, nx * (x - a[0]) + ny * (y - a[1]));
  }
  return d;
}
const sdRing = (x, y, cx, cy, r, th) => Math.abs(sdCircle(x, y, cx, cy, r)) - th / 2;

// ---- the app icon: a wipe compare (two picture halves, a divider and a handle) ---------------------------------
const BG = [16, 19, 26], BLUE = [90, 169, 255], ORANGE = [255, 159, 67], WHITE = [246, 248, 252];

function appIconColor(x, y) {
  if (sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return [0, 0, 0, 0];
  const inPanel = sdRoundRect(x, y, 0.5, 0.5, 0.36, 0.36, 0.09) < 0;
  if (!inPanel) return [...BG, 1];
  if (sdCircle(x, y, 0.5, 0.5, 0.115) < 0) {
    const chevron = sdPoly(x, y, [[0.452, 0.5], [0.482, 0.468], [0.482, 0.532]]) < 0 || sdPoly(x, y, [[0.548, 0.5], [0.518, 0.468], [0.518, 0.532]]) < 0;
    return [...(chevron ? BG : WHITE), 1];
  }
  if (Math.abs(x - 0.5) < 0.013) return [...WHITE, 1];
  return [...(x < 0.5 ? BLUE : ORANGE), 1];
}

// ---- thumbnail-button glyphs ---------------------------------------------------------------------------------------
const TRI_PLAY = [[0.30, 0.20], [0.30, 0.80], [0.80, 0.50]];
const bar = (x, y, x0, x1, y0, y1) => sdRoundRect(x, y, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0.02);

const GLYPHS = {
  play: (x, y) => sdPoly(x, y, TRI_PLAY),
  pause: (x, y) => Math.min(bar(x, y, 0.25, 0.42, 0.2, 0.8), bar(x, y, 0.58, 0.75, 0.2, 0.8)),
  next: (x, y) => Math.min(sdPoly(x, y, [[0.20, 0.22], [0.20, 0.78], [0.62, 0.50]]), bar(x, y, 0.68, 0.80, 0.22, 0.78)),
  prev: (x, y) => GLYPHS.next(1 - x, y),
  // power symbol: ring with a gap at the top and a stroke through it
  suspend: (x, y) => {
    const ring = sdRing(x, y, 0.5, 0.56, 0.27, 0.10);
    const gap = Math.abs(x - 0.5) < 0.11 && y < 0.56;
    return Math.min(gap ? 1 : ring, bar(x, y, 0.455, 0.545, 0.12, 0.54));
  },
  // ring with a play triangle: "bring it back"
  resume: (x, y) => Math.min(sdRing(x, y, 0.5, 0.5, 0.36, 0.09), sdPoly(x, y, [[0.42, 0.33], [0.42, 0.67], [0.69, 0.50]])),
};

function glyphColor(name) {
  const sd = GLYPHS[name];
  if (!sd) throw new Error(`Unknown glyph "${name}"`);
  return (x, y) => {
    const d = sd(x, y);
    if (d < 0) return [242, 245, 250, 1];
    if (d < 0.06) return [16, 19, 26, 0.6]; // dark halo so the glyph reads on light and dark taskbars
    return [0, 0, 0, 0];
  };
}

const glyphPng = (name, size = 32) => encodePng(size, size, raster(size, glyphColor(name)));
const appIconPng = (size = 256) => encodePng(size, size, raster(size, appIconColor, size >= 64 ? 3 : 4));
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const appIconIco = () => encodeIco(ICO_SIZES.map(size => ({ size, png: appIconPng(size) })));

module.exports = { encodePng, encodeIco, raster, glyphPng, appIconPng, appIconIco, GLYPHS, ICO_SIZES };
