'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTimeline, analyzeAudioTimeline, fitRate, parseRational } = require('../src/main/timeline');

const TB_MP4 = { num: 1, den: 15360 };
const TB_MKV = { num: 1, den: 1000 };

/** Build packets in decode order. `ticksPerFrame` may be fractional; timestamps are rounded like a muxer would. */
function cfr(n, ticksPerFrame, { reorder = false, size = 1000, keyEvery = 30 } = {}) {
  const pts = [], dts = [], sizes = [], flags = [];
  const order = [];
  if (reorder) { for (let g = 0; g < n; g += 3) { order.push(g); if (g + 2 < n) order.push(g + 2); if (g + 1 < n) order.push(g + 1); } }
  else for (let i = 0; i < n; i++) order.push(i);
  order.forEach((frame, decodeIdx) => {
    pts.push(Math.round(frame * ticksPerFrame));
    dts.push(Math.round((decodeIdx - (reorder ? 2 : 0)) * ticksPerFrame));
    sizes.push(size);
    flags.push(frame % keyEvery === 0 ? 'K_' : '__');
  });
  return { pts, dts, size: sizes, flags };
}

test('parseRational handles fractions, integers and N/A', () => {
  assert.equal(parseRational('60000/1001').value, 60000 / 1001);
  assert.equal(parseRational('30').value, 30);
  assert.equal(parseRational('0/0'), null);
  assert.equal(parseRational('N/A'), null);
});

test('clean 60fps CFR stream is regular', () => {
  const r = analyzeTimeline(cfr(360, 256), TB_MP4);
  assert.equal(r.frames, 360);
  assert.equal(r.irregular, false);
  assert.equal(r.gaps.count, 0);
  assert.equal(r.bursts.count, 0);
  assert.equal(r.dts.nonMonotonic, 0);
  assert.ok(Math.abs(r.rateFit - 60) < 0.005);
  assert.equal(r.first, 0);
});

test('B-frame reordering with negative DTS start is not an error', () => {
  const r = analyzeTimeline(cfr(360, 256, { reorder: true }), TB_MP4);
  assert.equal(r.irregular, false);
  assert.equal(r.dts.negativeStart, true);
  assert.equal(r.dts.nonMonotonic, 0);
  assert.equal(r.dts.ptsBeforeDts, 0);
});

test('a hole in the timeline is reported as a gap with the right missing-frame count', () => {
  const pk = cfr(360, 256);
  const cut = (arr) => { arr.splice(100, 5); return arr; };
  Object.keys(pk).forEach(k => cut(pk[k]));
  const r = analyzeTimeline(pk, TB_MP4);
  assert.equal(r.frames, 355);
  assert.equal(r.gaps.count, 1);
  assert.equal(r.gaps.missingFrames, 5);
  assert.equal(r.gaps.maxFrames, 5);
  assert.ok(Math.abs(r.gaps.events[0].t - 99 * 256 / 15360) < 1e-9, 'event is anchored at the last good frame');
  assert.equal(r.irregular, true);
});

test('an extra frame squeezed between two others is reported as a burst', () => {
  const pk = cfr(360, 256);
  pk.pts.splice(51, 0, Math.round(50.3 * 256)); pk.dts.splice(51, 0, Math.round(50.3 * 256));
  pk.size.splice(51, 0, 1000); pk.flags.splice(51, 0, '__');
  const r = analyzeTimeline(pk, TB_MP4);
  assert.equal(r.bursts.count, 1);
  assert.equal(r.irregular, true);
});

test('duplicate PTS is counted and flagged', () => {
  const pk = cfr(100, 256);
  pk.pts[40] = pk.pts[39];
  const r = analyzeTimeline(pk, TB_MP4);
  assert.equal(r.dupPts, 1);
  assert.equal(r.irregular, true);
});

test('non-monotonic DTS is counted', () => {
  const pk = cfr(100, 256);
  pk.dts[10] = pk.dts[9];
  const r = analyzeTimeline(pk, TB_MP4);
  assert.equal(r.dts.nonMonotonic, 1);
  assert.equal(r.irregular, true);
});

test('Matroska-style leading run of N/A DTS is a start-up lag, not a fault; N/A mid-stream is', () => {
  const lag = cfr(100, 256);
  lag.dts[0] = NaN; lag.dts[1] = NaN;
  const r = analyzeTimeline(lag, TB_MP4);
  assert.equal(r.dts.startupMissing, 2);
  assert.equal(r.dts.missing, 0);
  assert.equal(r.irregular, false);

  const hole = cfr(100, 256);
  hole.dts[50] = NaN;
  const h = analyzeTimeline(hole, TB_MP4);
  assert.equal(h.dts.missing, 1);
  assert.equal(h.dts.startupMissing, 0);
  assert.equal(h.irregular, false, 'DTS holes do not make the picture cadence irregular by themselves');

  const long = cfr(100, 256);
  for (let i = 0; i < 40; i++) long.dts[i] = NaN;
  assert.ok(analyzeTimeline(long, TB_MP4).dts.missing > 0, 'a start-up run longer than any legal reorder depth is not benign');
});

test('missing PTS is counted', () => {
  const pk = cfr(100, 256);
  pk.pts[5] = NaN;
  const r = analyzeTimeline(pk, TB_MP4);
  assert.equal(r.missingPts, 1);
  assert.equal(r.frames, 99);
  assert.equal(r.irregular, true);
});

test('Matroska 1ms rounding of 59.94fps is NOT flagged as jitter (healthy file, coarse time base)', () => {
  const r = analyzeTimeline(cfr(600, 1000 / (60000 / 1001)), TB_MKV);
  assert.equal(r.jitter.count, 0);
  assert.equal(r.gaps.count, 0);
  assert.equal(r.bursts.count, 0);
  assert.equal(r.irregular, false);
  assert.ok(Math.abs(r.rateFit - 59.94) < 0.01, `rateFit ${r.rateFit}`);
});

test('240fps on a 1ms time base (4/5ms intervals) is healthy: the tick-size tolerance floor matters here', () => {
  const r = analyzeTimeline(cfr(2400, 1000 / 240), TB_MKV);
  assert.equal(r.jitter.count, 0);
  assert.equal(r.irregular, false);
});

test('rateFit tells 59.98 from 60 where the median interval cannot (quantisation)', () => {
  const a = analyzeTimeline(cfr(360, 15360 / 60), TB_MP4);
  const b = analyzeTimeline(cfr(360, 15360 / 59.98), TB_MP4);
  // both medians collapse onto 256 ticks -> 60.0; the fit still separates them
  assert.ok(Math.abs(b.rateMedian - 60) < 0.01, 'median is quantised to 60');
  assert.ok(Math.abs(a.rateFit - 60) < 0.005, `A fit ${a.rateFit}`);
  assert.ok(Math.abs(b.rateFit - 59.98) < 0.005, `B fit ${b.rateFit}`);
});

test('rateFit on a 1ms time base still separates 59.98 from 60 over a short clip', () => {
  const a = analyzeTimeline(cfr(240, 1000 / 60), TB_MKV);
  const b = analyzeTimeline(cfr(240, 1000 / 59.98), TB_MKV);
  assert.ok(Math.abs(a.rateFit - 60) < 0.01, `A fit ${a.rateFit}`);
  assert.ok(Math.abs(b.rateFit - 59.98) < 0.01, `B fit ${b.rateFit}`);
  assert.ok(a.rateFit - b.rateFit > 0.01);
});

test('fitRate returns NaN for degenerate input', () => {
  assert.ok(Number.isNaN(fitRate(new Float64Array([1]))));
  assert.ok(Number.isNaN(fitRate(new Float64Array([]))));
});

test('GOP and bitrate stats: 30-frame GOPs, constant size, peak equals average', () => {
  const r = analyzeTimeline(cfr(360, 256, { size: 12500 }), TB_MP4);
  assert.equal(r.gop.keyCount, 12);
  assert.equal(r.gop.minLen, 30);
  assert.equal(r.gop.maxLen, 30);
  // 60 frames/s * 12500 B * 8 = 6 Mb/s
  assert.ok(Math.abs(r.bitrate.avgBps - 6e6) / 6e6 < 0.01, `avg ${r.bitrate.avgBps}`);
  assert.ok(Math.abs(r.bitrate.peakToAvg - 1) < 0.05);
});

test('bitrate peak detects a burst second', () => {
  const pk = cfr(360, 256, { size: 1000 });
  for (let i = 120; i < 180; i++) pk.size[i] = 10000; // one second at 10x
  const r = analyzeTimeline(pk, TB_MP4);
  assert.ok(r.bitrate.peakToAvg > 2, `peakToAvg ${r.bitrate.peakToAvg}`);
});

test('corrupt/discard packet flags are counted', () => {
  const pk = cfr(50, 256);
  pk.flags[7] = '_C'; pk.flags[8] = 'KD';
  const r = analyzeTimeline(pk, TB_MP4);
  assert.equal(r.badPackets, 2);
});

test('empty and single-packet inputs do not throw', () => {
  assert.equal(analyzeTimeline({ pts: [], dts: [], size: [], flags: [] }, TB_MP4).regular, false);
  const one = analyzeTimeline({ pts: [0], dts: [0], size: [1], flags: ['K_'] }, TB_MP4);
  assert.equal(one.regular, false);
});

test('audio: contiguous packets have no discontinuities', () => {
  const dur = 1024, n = 200, pts = [], d = [];
  for (let i = 0; i < n; i++) { pts.push(i * dur); d.push(dur); }
  const a = analyzeAudioTimeline({ pts, dur: d }, { num: 1, den: 48000 });
  assert.equal(a.discontinuities, 0);
  assert.ok(Math.abs(a.spanSec - n * dur / 48000) < 1e-9);
});

test('audio: a dropped packet is a discontinuity of the right size', () => {
  const dur = 1024, pts = [], d = [];
  for (let i = 0; i < 100; i++) { if (i === 50) continue; pts.push(i * dur); d.push(dur); }
  const a = analyzeAudioTimeline({ pts, dur: d }, { num: 1, den: 48000 });
  assert.equal(a.discontinuities, 1);
  assert.ok(Math.abs(a.maxGapMs - 1024 / 48) < 0.01, `gap ${a.maxGapMs}`);
});
