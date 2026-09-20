'use strict';
// Integration: real ffprobe against synthetic clips (generated on demand by tools/make-fixtures.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { analyzeFile } = require('../src/main/analyzer');
const { planConform } = require('../src/main/conform');

const FX = path.resolve(__dirname, 'fixtures');
const fx = n => path.join(FX, n);
const rows = a => Object.fromEntries(a.health.map(r => [r.id, r]));

test.before(() => {
  const need = ['ref60.mp4', 'retime5998.mp4', 'up1440.mp4', 'dropped60.mp4', 'avoffset60.mp4', 'frozen60.mp4', 'h264bframes60.mkv', 'hev1tag60.mp4'];
  if (need.some(n => !fs.existsSync(fx(n)))) execFileSync(process.execPath, [path.resolve(__dirname, '..', 'tools', 'make-fixtures.js')], { stdio: 'inherit' });
});

test('healthy reference: constant 60 fps, nothing flagged bad or warn', async () => {
  const a = await analyzeFile(fx('ref60.mp4'));
  assert.equal(a.timeline.frames, 360);
  assert.equal(a.timeline.regular, true);
  assert.ok(Math.abs(a.rate - 60) < 0.005);
  assert.deepEqual(a.health.filter(r => r.severity === 'bad' || r.severity === 'warn'), []);
  assert.equal(rows(a).container.value, 'MP4');
  assert.equal(a.framePts.length, 360);
});

test('AAC encoder priming is not reported as an A/V offset', async () => {
  const r = rows(await analyzeFile(fx('ref60.mp4')));
  assert.match(r.avstart.value, /^\+0\.0 ms$/);
  assert.equal(r.avstart.severity, 'ok');
});

test('59.98 fps file measures 59.98, not the quantised 60', async () => {
  const a = await analyzeFile(fx('retime5998.mp4'));
  assert.ok(Math.abs(a.rate - 59.98) < 0.005, `rate ${a.rate}`);
  assert.equal(a.timeline.regular, true);
  assert.equal(a.timeline.frames, 360);
});

test('dropped frames are found, sized, and located', async () => {
  const a = await analyzeFile(fx('dropped60.mp4'));
  assert.equal(a.timeline.regular, false);
  assert.equal(a.timeline.gaps.count, 1);
  assert.equal(a.timeline.gaps.missingFrames, 5);
  assert.ok(Math.abs(a.timeline.gaps.events[0].t - 99 / 60) < 1e-3, 'gap follows frame 99');
  assert.equal(rows(a).gaps.severity, 'bad');
  assert.equal(a.markers.length, 1);
  assert.equal(a.markers[0].kind, 'gap');
});

test('a late audio track shows as a start offset', async () => {
  const r = rows(await analyzeFile(fx('avoffset60.mp4')));
  const ms = parseFloat(r.avstart.value);
  assert.ok(ms > 100 && ms < 160, `offset ${ms}`);
  assert.equal(r.avstart.severity, 'bad');
});

test('H.264 with B-frames in Matroska (1 ms time base) raises no false alarms', async () => {
  const a = await analyzeFile(fx('h264bframes60.mkv'));
  assert.equal(a.timeline.regular, true);
  assert.deepEqual(a.health.filter(r => r.severity === 'bad' || r.severity === 'warn'), []);
  assert.equal(rows(a).container.value, 'Matroska');
});

test('hev1-tagged HEVC is reported with its tag', async () => {
  const r = rows(await analyzeFile(fx('hev1tag60.mp4')));
  assert.match(r.codec.value, /hev1/);
});

test('plan: 60 vs 59.98 file -> retime; vs dropped -> resample; vs upscale -> none + resolution note', async () => {
  const ref = await analyzeFile(fx('ref60.mp4'));
  const p1 = planConform([ref, await analyzeFile(fx('retime5998.mp4'))]);
  assert.equal(p1.videos[1].mode, 'retime');
  assert.ok(Math.abs(p1.videos[1].slope - 60 / 59.98) < 1e-4);
  const p2 = planConform([ref, await analyzeFile(fx('dropped60.mp4'))]);
  assert.equal(p2.videos[1].mode, 'resample');
  const p3 = planConform([ref, await analyzeFile(fx('up1440.mp4'))]);
  assert.equal(p3.videos[1].mode, 'none');
  assert.ok(p3.notices.some(n => /Resolutions differ/.test(n.text)));
});

test('missing files fail with a clear message', async () => {
  await assert.rejects(analyzeFile(fx('nope.mp4')), /File not found/);
});
