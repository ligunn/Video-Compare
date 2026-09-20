'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { parseCommand, createRouter, APP_ID } = require('../src/main/commands');
const { createTaskbar } = require('../src/main/taskbar');
const icons = require('../src/main/icons');
const { killAll, run } = require('../src/main/ffmpeg-tools');

test('parseCommand finds control flags anywhere on the command line and ignores files', () => {
  assert.equal(parseCommand(['C:\\app', '--quit']), 'quit');
  assert.equal(parseCommand(['--suspend']), 'suspend');
  assert.equal(parseCommand(['x.mp4', '--toggle-play', 'y.mp4']), 'toggle-play');
  assert.equal(parseCommand(['--toggle-suspend']), 'toggle-suspend');
  assert.equal(parseCommand(['a.mp4', 'b.mp4']), null);
  assert.equal(parseCommand([]), null);
  assert.equal(parseCommand(['--constructor', '--__proto__', '--toString']), null, 'inherited object keys are not commands');
});

test('router: quit quits; renderer commands are delivered; unknown commands and a missing window are refused', () => {
  const sent = []; let quit = 0;
  const win = { isDestroyed: () => false, webContents: { send: (ch, c) => sent.push([ch, c]) } };
  const r = createRouter({ getWindow: () => win, quit: () => quit++ });
  assert.equal(r.run('quit'), true); assert.equal(quit, 1);
  for (const c of ['toggle-play', 'step-back', 'step-forward', 'suspend', 'resume', 'toggle-suspend']) assert.equal(r.run(c), true, c);
  assert.deepEqual(sent.map(s => s[1]), ['toggle-play', 'step-back', 'step-forward', 'suspend', 'resume', 'toggle-suspend']);
  assert.ok(sent.every(s => s[0] === 'vc:command'));
  assert.equal(r.run('rm -rf'), false);
  assert.equal(createRouter({ getWindow: () => null, quit() {} }).run('suspend'), false);
  assert.equal(createRouter({ getWindow: () => ({ isDestroyed: () => true }), quit() {} }).run('suspend'), false);
});

test('taskbar buttons follow the app state (glyph, tooltip, enabled)', () => {
  const app = { isPackaged: false, getAppPath: () => 'C:\\proj', setUserTasks: () => true };
  const tb = createTaskbar({ app, nativeImage: { createFromBuffer: b => b.toString('base64') }, getWindow: () => null, run() {} }); // the "image" is its own bytes
  const idle = tb.buttonsFor({ hasVideos: false, playing: false, suspended: false });
  assert.equal(idle.length, 4);
  assert.ok(idle.every(b => b.flags.includes('disabled')), 'nothing to control with no videos');

  const paused = tb.buttonsFor({ hasVideos: true, playing: false, suspended: false });
  assert.deepEqual(paused.map(b => b.tooltip.split(':')[0]), ['Previous frame', 'Play', 'Next frame', 'Suspend']);
  assert.ok(paused.every(b => b.flags.length === 0));

  const playing = tb.buttonsFor({ hasVideos: true, playing: true, suspended: false });
  assert.equal(playing[1].tooltip, 'Pause');
  assert.notEqual(playing[1].icon, paused[1].icon, 'Play and Pause show different glyphs');
  assert.equal(playing[0].icon, paused[0].icon, 'while unrelated buttons keep theirs');

  const asleep = tb.buttonsFor({ hasVideos: true, playing: false, suspended: true });
  assert.match(asleep[3].tooltip, /^Resume/);
  assert.ok(asleep[0].flags.includes('disabled') && asleep[1].flags.includes('disabled') && asleep[2].flags.includes('disabled'), 'transport disabled while suspended');
  assert.equal(asleep[3].flags.length, 0, 'but Resume stays clickable');
  assert.notEqual(asleep[3].icon, paused[3].icon, 'Suspend and Resume show different glyphs');

  const clicks = []; const tb2 = createTaskbar({ app, nativeImage: { createFromBuffer: () => ({}) }, getWindow: () => null, run: c => clicks.push(c) });
  tb2.buttonsFor({ hasVideos: true, playing: false, suspended: false }).forEach(b => b.click());
  assert.deepEqual(clicks, ['step-back', 'toggle-play', 'step-forward', 'toggle-suspend']);
});

test('jump-list tasks launch control commands with the app path when running unpackaged', () => {
  let tasks;
  const app = { isPackaged: false, getAppPath: () => 'C:\\proj dir', setUserTasks: t => { tasks = t; return true; } };
  const tb = createTaskbar({ app, nativeImage: {}, getWindow: () => null, run() {} });
  if (process.platform === 'win32') {
    assert.equal(tb.setTasks(), true);
    assert.deepEqual(tasks.map(t => t.arguments), ['"C:\\proj dir" --toggle-play', '"C:\\proj dir" --suspend', '"C:\\proj dir" --resume', '"C:\\proj dir" --quit']);
    assert.ok(tasks.every(t => t.iconPath.endsWith('icon.ico') && t.program === process.execPath));
  }
  assert.match(APP_ID, /^[\w.-]+$/, 'AppUserModelID is a legal identifier');
});

// ---- icons ---------------------------------------------------------------------------------------------------------
function readChunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const chunks = []; let o = 8;
  while (o < png.length) {
    const len = png.readUInt32BE(o), type = png.toString('ascii', o + 4, o + 8), data = png.subarray(o + 8, o + 8 + len);
    chunks.push({ type, data, crc: png.readUInt32BE(o + 8 + len), body: png.subarray(o + 4, o + 8 + len) });
    o += 12 + len;
  }
  return chunks;
}
function decodePng(png) {
  const ch = readChunks(png);
  const ihdr = ch.find(c => c.type === 'IHDR').data;
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
  const raw = zlib.inflateSync(Buffer.concat(ch.filter(c => c.type === 'IDAT').map(c => c.data)));
  assert.equal(raw.length, h * (1 + 4 * w), 'decompressed size matches RGBA rows');
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) { assert.equal(raw[y * (1 + 4 * w)], 0); raw.copy(px, y * w * 4, y * (1 + 4 * w) + 1, (y + 1) * (1 + 4 * w)); }
  return { w, h, px, ch };
}
const alphaAt = (img, x, y) => img.px[(y * img.w + x) * 4 + 3];

test('PNG encoder output has valid CRCs and decodes back to the right size', () => {
  const img = decodePng(icons.appIconPng(64));
  assert.equal(img.w, 64); assert.equal(img.h, 64);
  for (const c of img.ch) {
    let crc = 0xffffffff;
    for (const b of c.body) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    assert.equal((crc ^ 0xffffffff) >>> 0, c.crc, `${c.type} CRC`);
  }
});

test('app icon: rounded (transparent corners), opaque centre, blue left / orange right', () => {
  const img = decodePng(icons.appIconPng(128));
  assert.equal(alphaAt(img, 0, 0), 0, 'corner is transparent');
  assert.equal(alphaAt(img, 64, 64), 255, 'centre is opaque');
  const at = (x, y) => [...img.px.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 3)];
  const left = at(35, 40), right = at(95, 40);
  assert.ok(left[2] > left[0] && left[2] > 200, `left is blue ${left}`);
  assert.ok(right[0] > 200 && right[2] < 120, `right is orange ${right}`);
});

test('ICO container: 7 sizes, valid directory, each image is a real PNG of the stated size', () => {
  const ico = icons.appIconIco();
  assert.equal(ico.readUInt16LE(2), 1, 'type = icon');
  const n = ico.readUInt16LE(4);
  assert.equal(n, icons.ICO_SIZES.length);
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16, size = ico[e] || 256, bytes = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
    assert.equal(size, icons.ICO_SIZES[i]);
    assert.ok(off + bytes <= ico.length);
    const img = decodePng(ico.subarray(off, off + bytes));
    assert.equal(img.w, size); assert.equal(img.h, size);
  }
});

test('every taskbar glyph draws something, on a transparent background, and glyphs differ from each other', () => {
  const seen = new Map();
  for (const name of Object.keys(icons.GLYPHS)) {
    const img = decodePng(icons.glyphPng(name, 32));
    const opaque = [...Array(32 * 32).keys()].filter(i => img.px[i * 4 + 3] === 255).length;
    assert.ok(opaque > 40, `${name} has body (${opaque})`);
    assert.equal(alphaAt(img, 0, 0), 0, `${name} corner transparent`);
    seen.set(name, img.px.toString('base64'));
  }
  assert.equal(new Set(seen.values()).size, seen.size, 'all glyphs are distinct');
  assert.throws(() => icons.glyphPng('nope'), /Unknown glyph/);
});

test('killAll terminates children started through run() (no orphaned ffmpeg after Quit)', async () => {
  const p = run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise(r => setTimeout(r, 400));
  const t0 = Date.now();
  killAll();
  const res = await p;
  assert.ok(Date.now() - t0 < 5000, 'the 60 s child did not run to completion');
  assert.notEqual(res.code, 0);
});
