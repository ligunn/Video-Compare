'use strict';
const { analyzeTimeline } = require('../src/main/timeline');
const { effectiveRate } = require('../src/main/analyzer');

const TB_MP4 = { num: 1, den: 15360 };

/** Packets in decode order for a constant-rate stream, with muxer-style rounding of timestamps. */
function cfrPackets(n, ticksPerFrame, { keyEvery = 30, size = 1000 } = {}) {
  const pts = [], dts = [], sizes = [], flags = [];
  for (let i = 0; i < n; i++) {
    pts.push(Math.round(i * ticksPerFrame)); dts.push(Math.round(i * ticksPerFrame));
    sizes.push(size); flags.push(i % keyEvery === 0 ? 'K_' : '__');
  }
  return { pts, dts, size: sizes, flags };
}

/** A minimal stand-in for analyzeFile()'s result, built from a synthetic timeline. */
function fakeAnalysis({ n = 360, fps = 60, tb = TB_MP4, gapAt = null, gapLen = 0, video = {}, audio = null } = {}) {
  const pk = cfrPackets(n, tb.den / (tb.num * fps));
  if (gapAt != null) for (const k of Object.keys(pk)) pk[k].splice(gapAt, gapLen);
  const timeline = analyzeTimeline(pk, tb);
  const info = {
    file: { name: 'x.mp4', durationSec: timeline.spanSec },
    video: { width: 1280, height: 720, rotation: 0, bitDepth: 8, colorRange: 'tv', colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709', rFrameRate: null, ...video },
    audio,
  };
  const { framePts, ...tlSummary } = timeline;
  return { info, timeline: tlSummary, framePts, rate: effectiveRate(info, timeline) };
}

module.exports = { TB_MP4, cfrPackets, fakeAnalysis };
