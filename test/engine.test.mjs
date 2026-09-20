import test from 'node:test';
import assert from 'node:assert/strict';
import { indexAt, mediaAt } from '../src/renderer/engine.js';

const pts = (n, dt, first = 0) => Float64Array.from({ length: n }, (_, i) => first + i * dt);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('indexAt returns the frame being shown at time t', () => {
  const p = pts(360, 1 / 60);
  assert.equal(indexAt(p, 0), 0);
  assert.equal(indexAt(p, 1 / 60), 1);
  assert.equal(indexAt(p, 1 / 60 - 1e-4), 0, 'just before frame 1 still shows frame 0');
  assert.equal(indexAt(p, 100 / 60 + 0.004), 100);
  assert.equal(indexAt(p, 1e9), 359);
  assert.equal(indexAt(p, -5), 0);
});

test('indexAt copes with irregular timestamps (gaps)', () => {
  const p = Float64Array.from([0, 1, 2, 3, 8, 9]);
  assert.equal(indexAt(p, 5), 3, 'holds the last frame through a gap');
  assert.equal(indexAt(p, 8), 4);
});

test('retime mapping: frame k of a 59.98 clip lands exactly on frame k of the 60 clip', () => {
  const A = { first: 0, slope: 1, offset: 0, pts: pts(360, 1 / 60) };
  const B = { first: 0, slope: 60 / 59.98, offset: 0, pts: pts(360, 1 / 59.98) };
  // reference time of frame k is k/60; B should be showing ITS frame k there
  for (const k of [0, 1, 100, 250, 359]) {
    const t = mediaAt(B, A, A.pts[k]);
    close(t, k / 59.98, 1e-9);
    assert.equal(indexAt(B.pts, t + 0.25 / 59.98), k, `pairing at k=${k}`);
  }
});

test('WITHOUT retime the same pair drifts a whole frame apart within seconds (why conforming exists)', () => {
  const A = { first: 0, slope: 1, offset: 0, pts: pts(3600, 1 / 60) };
  const B = { first: 0, slope: 1, offset: 0, pts: pts(3600, 1 / 59.98) };
  const k = 3599;
  assert.ok(indexAt(B.pts, mediaAt(B, A, A.pts[k]) + 0.25 / 59.98) < k, 'B lags A by frame 3599');
});

test('resample mapping pairs by timestamp across a gap, holding the frame', () => {
  const A = { first: 0, slope: 1, offset: 0, pts: pts(365, 1 / 60) };
  const bp = Array.from({ length: 365 }, (_, i) => i).filter(i => i < 100 || i > 104).map(i => i / 60);
  const B = { first: 0, slope: 1, offset: 0, pts: Float64Array.from(bp) };
  assert.equal(indexAt(B.pts, mediaAt(B, A, A.pts[99]) + 0.004), 99);
  assert.equal(indexAt(B.pts, mediaAt(B, A, A.pts[102]) + 0.004), 99, 'A frame 102 shows B frame 99 held through the gap');
  assert.equal(indexAt(B.pts, mediaAt(B, A, A.pts[105]) + 0.004), 100, 'A frame 105 pairs with B frame 100 (the burned-in "105")');
});

test('manual offset shifts a follower by whole frames of its own', () => {
  const A = { first: 0, slope: 1, offset: 0, pts: pts(100, 1 / 60) };
  const B = { first: 0, slope: 1, offset: 2 / 60, pts: pts(100, 1 / 60) };
  assert.equal(indexAt(B.pts, mediaAt(B, A, A.pts[10]) + 0.004), 12);
});

test('start offsets are absorbed: first frame pairs with first frame', () => {
  const A = { first: 0, slope: 1, offset: 0, pts: pts(100, 1 / 60, 0) };
  const B = { first: 1.4, slope: 1, offset: 0, pts: pts(100, 1 / 60, 1.4) };
  assert.equal(indexAt(B.pts, mediaAt(B, A, A.pts[0]) + 0.004), 0);
  assert.equal(indexAt(B.pts, mediaAt(B, A, A.pts[50]) + 0.004), 50);
});
