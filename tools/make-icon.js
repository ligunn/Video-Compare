'use strict';
// Regenerates assets/icon.png and assets/icon.ico (deterministic, no dependencies): node tools/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { appIconPng, appIconIco, glyphPng, GLYPHS, raster } = require('../src/main/icons');

const dir = path.resolve(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), appIconPng(256));
fs.writeFileSync(path.join(dir, 'icon.ico'), appIconIco());
console.log('wrote assets/icon.png and assets/icon.ico');
if (process.argv.includes('--preview')) {
  // contact sheet of the taskbar glyphs on a mid-grey, for eyeballing
  const names = Object.keys(GLYPHS), S = 96, W = S * names.length, out = Buffer.alloc(W * S * 4);
  names.forEach((n, i) => {
    const px = raster(S, (x, y) => { const d = GLYPHS[n](x, y); return d < 0 ? [242, 245, 250, 1] : d < 0.06 ? [16, 19, 26, 0.6] : [0, 0, 0, 0]; });
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const s = (y * S + x) * 4, o = (y * W + i * S + x) * 4, a = px[s + 3] / 255;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(px[s + c] * a + 70 * (1 - a));
      out[o + 3] = 255;
    }
  });
  fs.writeFileSync(path.join(process.argv[process.argv.indexOf('--preview') + 1] || 'glyphs.png'), require('../src/main/icons').encodePng(W, S, out));
}
