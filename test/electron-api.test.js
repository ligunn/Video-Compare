'use strict';
// Guards against calling an Electron method that does not exist (e.g. win.setThumbnailButtons instead of
// setThumbarButtons): unit tests with fake windows cannot see that, and it only fails at run time in the real app.
// Every `win.x(`, `app.x(`, `shell.x(` ... call in the main-process sources must exist in Electron's own typings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.resolve(__dirname, '..', 'src', 'main');
const DTS = fs.readFileSync(path.resolve(__dirname, '..', 'node_modules', 'electron', 'electron.d.ts'), 'utf8');
// objects that are Electron objects in the main-process sources (not Node's `app`-named locals elsewhere)
const RECEIVERS = ['win', 'app', 'shell', 'dialog', 'nativeImage', 'ipcMain', 'Menu', 'BrowserWindow', 'win\\.webContents'];

test('every Electron method called from src/main exists in electron.d.ts', () => {
  const missing = [];
  for (const file of fs.readdirSync(MAIN).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(MAIN, file), 'utf8');
    const re = new RegExp(`\\b(${RECEIVERS.join('|')})\\.(\\w+)\\(`, 'g');
    for (const m of src.matchAll(re)) {
      const name = m[2];
      if (!new RegExp(`\\b${name}\\(`).test(DTS)) missing.push(`${file}: ${m[1]}.${name}()`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'these are not Electron APIs');
});

test('the guard would have caught the real bug', () => {
  assert.ok(!/\bsetThumbnailButtons\(/.test(DTS), 'the wrong name is absent from the typings');
  assert.ok(/\bsetThumbarButtons\(/.test(DTS), 'the right name is present');
  // and prove the scan itself is sensitive: the buggy call, run through the same regex, is flagged
  const buggy = 'win.setThumbnailButtons(buttons);';
  const m = new RegExp(`\\b(${RECEIVERS.join('|')})\\.(\\w+)\\(`).exec(buggy);
  assert.equal(m[2], 'setThumbnailButtons');
  assert.ok(!new RegExp(`\\b${m[2]}\\(`).test(DTS));
});
