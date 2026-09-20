'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { analyzeYdif, repeatRows, scanRepeats } = require('../src/main/deepscan');

const times = n => Array.from({ length: n }, (_, i) => i / 60);
const moving = (n, v = 1.5) => Array.from({ length: n }, (_, i) => v + ((i * 7) % 5) * 0.05);

test('a run of repeated frames inside moving content is found, sized and located', () => {
  const y = moving(360);
  for (let i = 200; i <= 203; i++) y[i] = 0.01;
  const r = analyzeYdif(y, times(360));
  assert.equal(r.repeated, 4);
  assert.equal(r.runs, 1);
  assert.equal(r.longestRun, 4);
  assert.ok(Math.abs(r.events[0].t - 199 / 60) < 1e-9);
});

test('a clean moving clip has no repeats', () => {
  const r = analyzeYdif(moving(300), times(300));
  assert.equal(r.repeated, 0);
  assert.equal(r.fraction, 0);
});

test('a genuinely static scene is NOT judged (no motion to compare against)', () => {
  const r = analyzeYdif(Array(300).fill(0.02), times(300));
  assert.equal(r.repeated, 0);
  assert.equal(r.judged, 0);
  assert.equal(repeatRows(r, 60)[0].severity, 'info');
});

test('30 fps content in a 60 fps container: every 2nd frame repeats, and the pattern is recognised', () => {
  const y = moving(300);
  for (let i = 2; i < 300; i += 2) y[i] = 0.01;
  const r = analyzeYdif(y, times(300));
  assert.ok(Math.abs(r.fraction - 0.5) < 0.02, `fraction ${r.fraction}`);
  assert.equal(r.period, 2);
  const rows = repeatRows(r, 60);
  const eff = rows.find(x => x.id === 'uniquerate');
  assert.ok(eff, 'effective-rate row present');
  assert.match(eff.value, /≈30\.\d fps/);
});

test('a single isolated repeat is a warning, not a failure', () => {
  const y = moving(300); y[100] = 0.01;
  const row = repeatRows(analyzeYdif(y, times(300)), 60)[0];
  assert.equal(row.severity, 'warn');
});

test('a long freeze is a failure', () => {
  const y = moving(300);
  for (let i = 100; i < 110; i++) y[i] = 0.01;
  assert.equal(repeatRows(analyzeYdif(y, times(300)), 60)[0].severity, 'bad');
});

test('empty and tiny inputs do not throw', () => {
  assert.equal(analyzeYdif([], []).repeated, 0);
  assert.equal(analyzeYdif([0], [0]).repeated, 0);
});

test('integration: real ffmpeg finds the frozen frames in frozen60 and nothing in ref60', async () => {
  const FX = path.resolve(__dirname, 'fixtures');
  if (!fs.existsSync(path.join(FX, 'frozen60.mp4')) || !fs.existsSync(path.join(FX, 'ref60.mp4'))) {
    execFileSync(process.execPath, [path.resolve(__dirname, '..', 'tools', 'make-fixtures.js')], { stdio: 'inherit' });
  }
  const frozen = await scanRepeats(path.join(FX, 'frozen60.mp4'), { durationSec: 6 });
  assert.equal(frozen.frames, 360);
  assert.equal(frozen.repeated, 4, JSON.stringify(frozen));
  assert.equal(frozen.longestRun, 4);
  assert.ok(Math.abs(frozen.events[0].t - 199 / 60) < 0.01, `t=${frozen.events[0].t}`);
  const clean = await scanRepeats(path.join(FX, 'ref60.mp4'), { durationSec: 6 });
  assert.equal(clean.repeated, 0, JSON.stringify(clean));
});
