'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planConform, crossChecks, snapRate } = require('../src/main/conform');
const { fakeAnalysis } = require('./helpers');

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('59.98 vs 60 with the same frame count is RETIMED, keeping every frame (the headline case)', () => {
  const plan = planConform([fakeAnalysis({ fps: 60 }), fakeAnalysis({ fps: 59.98 })]);
  const b = plan.videos[1];
  assert.equal(plan.referenceIndex, 0);
  assert.equal(b.mode, 'retime');
  assert.equal(b.adjusted, true);
  close(b.slope, 60 / 59.98, 1e-5);
  assert.match(b.reasons[0], /Retimed/);
  assert.equal(plan.videos[0].adjusted, false);
});

test('identical rates need no adjustment', () => {
  const plan = planConform([fakeAnalysis({ fps: 60 }), fakeAnalysis({ fps: 60 })]);
  assert.equal(plan.videos[1].mode, 'none');
  assert.equal(plan.videos[1].adjusted, false);
  assert.equal(plan.videos[1].slope, 1);
});

test('59.94 vs 60 (both "standard") is still conformed, and the follower is the second file', () => {
  const plan = planConform([fakeAnalysis({ fps: 60 }), fakeAnalysis({ fps: 60000 / 1001 })]);
  assert.equal(plan.videos[1].mode, 'retime');
  close(plan.videos[1].slope, 60 / (60000 / 1001), 1e-5);
});

test('irregular follower (dropped frames) is RESAMPLED by timestamp, never index-paired', () => {
  const plan = planConform([fakeAnalysis({ n: 365 }), fakeAnalysis({ n: 365, gapAt: 100, gapLen: 5 })]);
  const b = plan.videos[1];
  assert.equal(b.mode, 'resample');
  assert.equal(b.slope, 1);
  assert.equal(b.severity, 'warn');
  assert.match(b.reasons[0], /5 frames missing/);
});

test('same span but fewer frames at a lower uniform rate (frames were dropped) is RESAMPLED', () => {
  // 6.0 s each: 360 frames @ 60 vs 357 frames @ 59.5
  const plan = planConform([fakeAnalysis({ n: 360, fps: 60 }), fakeAnalysis({ n: 357, fps: 59.5 })]);
  assert.equal(plan.videos[1].mode, 'resample');
  assert.match(plan.videos[1].reasons[0], /dropped/);
});

test('count and duration both different: resample from the first frame and warn about the trim', () => {
  const plan = planConform([fakeAnalysis({ n: 360, fps: 60 }), fakeAnalysis({ n: 300, fps: 59.98 })]);
  assert.equal(plan.videos[1].mode, 'resample');
  assert.match(plan.videos[1].reasons[0], /both frame count/);
});

test('a rate gap beyond ±0.5 fps is called out as possibly-not-the-same-footage', () => {
  const plan = planConform([fakeAnalysis({ fps: 60 }), fakeAnalysis({ fps: 50 })]);
  assert.ok(plan.videos[1].reasons.some(r => /outside the ±0.5 fps/.test(r)));
  assert.equal(plan.videos[1].severity, 'warn');
});

test('the reference is the file with clean timestamps, not simply the first one', () => {
  const plan = planConform([fakeAnalysis({ n: 365, gapAt: 100, gapLen: 5 }), fakeAnalysis({ n: 365 })]);
  assert.equal(plan.referenceIndex, 1);
  assert.equal(plan.videos[0].role, 'follower');
  assert.equal(plan.videos[0].mode, 'resample');
  assert.equal(plan.videos[1].role, 'reference');
});

test('an explicit reference choice is honoured', () => {
  const plan = planConform([fakeAnalysis({ fps: 60 }), fakeAnalysis({ fps: 59.98 })], { referenceIndex: 1 });
  assert.equal(plan.referenceIndex, 1);
  assert.equal(plan.videos[0].mode, 'retime');
  close(plan.videos[0].slope, 59.98 / 60, 1e-5);
});

test('conforming switched off leaves every follower on raw timestamps', () => {
  const plan = planConform([fakeAnalysis({ fps: 60 }), fakeAnalysis({ fps: 59.98 })], { enabled: false });
  assert.equal(plan.videos[1].mode, 'none');
  assert.equal(plan.videos[1].slope, 1);
  assert.equal(plan.videos[1].adjusted, false);
});

test('N-way: three videos each conformed to one reference', () => {
  const plan = planConform([fakeAnalysis({ fps: 60 }), fakeAnalysis({ fps: 59.98 }), fakeAnalysis({ fps: 60 })]);
  assert.deepEqual(plan.videos.map(v => v.mode), ['none', 'retime', 'none']);
});

test('no clean video at all warns that there is no trustworthy clock', () => {
  const plan = planConform([fakeAnalysis({ n: 365, gapAt: 50, gapLen: 3 }), fakeAnalysis({ n: 365, gapAt: 100, gapLen: 5 })]);
  assert.equal(plan.referenceIndex, 0);
  assert.ok(plan.notices.some(n => /trustworthy reference clock/.test(n.text)));
});

test('cross-checks: resolution info, colour-range warning, aspect warning', () => {
  const a = fakeAnalysis({});
  const b = fakeAnalysis({ video: { width: 2560, height: 1440, colorRange: 'pc' } });
  const c = fakeAnalysis({ video: { width: 1000, height: 1000 } });
  const notes = crossChecks([a, b]);
  assert.ok(notes.some(n => n.severity === 'info' && /Resolutions differ/.test(n.text)));
  assert.ok(notes.some(n => n.severity === 'warn' && /Colour tags differ/.test(n.text)));
  assert.ok(!notes.some(n => /Aspect/.test(n.text)), 'same aspect, no warning');
  assert.ok(crossChecks([a, c]).some(n => /Aspect ratios differ/.test(n.text)));
});

test('snapRate maps measured rates onto broadcast rationals, or 1/1000 otherwise', () => {
  assert.deepEqual(snapRate(59.9401), { num: 60000, den: 1001, value: 60000 / 1001 });
  assert.deepEqual(snapRate(60.0004), { num: 60, den: 1, value: 60 });
  assert.deepEqual(snapRate(23.9762), { num: 24000, den: 1001, value: 24000 / 1001 });
  const odd = snapRate(59.98);
  assert.equal(odd.den, 1000); assert.equal(odd.num, 59980);
});
