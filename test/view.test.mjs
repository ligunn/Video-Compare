import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/renderer/view.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const RECT = { x: 100, y: 50, w: 1000, h: 500 };
const W = 3840, H = 2160;

test('contentSize picks the largest video', () => {
  assert.deepEqual(V.contentSize([{ w: 1920, h: 1080 }, { w: 3840, h: 2160 }, { w: 1280, h: 720 }]), { W: 3840, H: 2160 });
  assert.deepEqual(V.contentSize([]), { W: 0, H: 0 });
});

test('fit: the picture centre is at the rect centre and the edges land inside the rect', () => {
  const v = { zoom: 1, cx: 0.5, cy: 0.5 };
  const [u, w] = V.uvAt(v, RECT, RECT.x + RECT.w / 2, RECT.y + RECT.h / 2, W, H);
  close(u, 0.5); close(w, 0.5);
  // 16:9 in a 2:1 rect is height-limited: full height, pillarboxed sides
  const [u0, v0] = V.uvAt(v, RECT, RECT.x + RECT.w / 2, RECT.y, W, H);
  close(v0, 0, 1e-9); close(u0, 0.5);
  const [ul] = V.uvAt(v, RECT, RECT.x, RECT.y + RECT.h / 2, W, H);
  assert.ok(ul < 0, 'left edge of rect is outside the picture (pillarbox)');
});

test('zoomAt keeps the picture point under the cursor fixed', () => {
  let view = { zoom: 1, cx: 0.5, cy: 0.5 };
  const px = RECT.x + 700, py = RECT.y + 120;
  view = V.zoomAt(view, RECT, RECT.x + 500, RECT.y + 250, 3, W, H); // zoom in somewhere first
  const before = V.uvAt(view, RECT, px, py, W, H);
  const after = V.uvAt(V.zoomAt(view, RECT, px, py, 2.5, W, H), RECT, px, py, W, H);
  close(before[0], after[0], 1e-9); close(before[1], after[1], 1e-9);
});

test('zoom is clamped to [fit, 32 device px per content px]', () => {
  const s0 = V.fitScale(RECT, W, H);
  let v = V.zoomAt({ zoom: 1, cx: 0.5, cy: 0.5 }, RECT, 500, 300, 1e6, W, H);
  close(v.zoom, 32 / s0, 1e-6);
  v = V.zoomAt(v, RECT, 500, 300, 1e-9, W, H);
  assert.deepEqual(v, { zoom: 1, cx: 0.5, cy: 0.5 }, 'zooming out to fit recentres');
});

test('panBy moves the picture with the cursor and clamps to the picture', () => {
  let v = V.zoomAt({ zoom: 1, cx: 0.5, cy: 0.5 }, RECT, 600, 300, 4, W, H);
  const s = V.scaleOf(RECT, W, H, v.zoom);
  const p = V.panBy(v, 100, 0, RECT, W, H);
  close(p.cx, v.cx - 100 / (W * s), 1e-9);
  const far = V.panBy(v, -1e9, 1e9, RECT, W, H);
  assert.equal(far.cx, 1); assert.equal(far.cy, 0);
});

test('oneToOneZoom shows content pixels 1:1 with device pixels', () => {
  const z = V.oneToOneZoom(RECT, W, H);
  close(V.scaleOf(RECT, W, H, z), 1, 1e-9);
  assert.equal(V.oneToOneZoom({ x: 0, y: 0, w: 8000, h: 5000 }, W, H), 1, 'never below fit');
});

test('minifying: a 4K texture on a 1000px-wide fit view is minified; a 720p one is not', () => {
  const s = V.scaleOf(RECT, W, H, 1);
  assert.equal(V.minifying(3840, W, s), true);
  assert.equal(V.minifying(1280, W, 1), false);
});

test('gridPanes tiles without overlap for 2, 3 and 4 videos', () => {
  const two = V.gridPanes(2, 1000, 500);
  assert.deepEqual(two.map(p => [p.x, p.w]), [[0, 500], [500, 500]]);
  assert.equal(V.gridPanes(3, 900, 300).length, 3);
  const four = V.gridPanes(4, 1000, 600);
  assert.deepEqual(four.map(p => [p.x, p.y]), [[0, 0], [500, 0], [0, 300], [500, 300]]);
  assert.deepEqual(V.gridPanes(0, 100, 100), []);
});

test('wipe strips: N videos have N-1 boundaries and tile the width', () => {
  assert.deepEqual(V.defaultBounds(2), [0.5]);
  assert.deepEqual(V.defaultBounds(4), [0.25, 0.5, 0.75]);
  assert.deepEqual(V.wipeStrips([0.25, 0.75], 1000), [{ x0: 0, x1: 250 }, { x0: 250, x1: 750 }, { x0: 750, x1: 1000 }]);
});

test('boundary picking and dragging keeps order and a minimum strip width', () => {
  const b = [0.3, 0.7];
  assert.equal(V.nearestBoundary(b, 305, 1000, 12), 0);
  assert.equal(V.nearestBoundary(b, 500, 1000, 12), -1);
  const approx = (got, want) => { assert.equal(got.length, want.length); got.forEach((g, i) => close(g, want[i], 1e-12)); };
  approx(V.moveBoundary(b, 0, 0.9), [0.68, 0.7]);   // can't cross the next boundary
  approx(V.moveBoundary(b, 1, -1), [0.3, 0.32]);    // can't cross the previous one
  approx(V.moveBoundary([0.5], 0, 5), [0.98]);      // can't leave the picture
});
