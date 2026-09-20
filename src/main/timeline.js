'use strict';
// Pure timestamp/packet analysis. No I/O, no Electron: everything here is unit-tested with
// synthetic packet arrays. Times are seconds; raw pts/dts are integers in the stream time base.

/** Parse "60000/1001" or "30" into {num, den, value}; returns null for N/A or 0/0. */
function parseRational(s) {
  if (s == null || s === 'N/A') return null;
  const [n, d = '1'] = String(s).split('/');
  const num = Number(n), den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return { num, den, value: num / den };
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return NaN;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/**
 * Least-squares frame rate: slope of timestamp vs frame index. The median interval quantises
 * (59.98fps on a 1/15360 time base is 256 ticks with an occasional 257, so the median says 60.0)
 * and endpoints are noisy on coarse time bases; the fit over every frame is accurate to ~0.001fps.
 * Only meaningful for gap-free streams, since a gap breaks the index<->time linearity.
 */
function fitRate(framePts) {
  const m = framePts.length;
  if (m < 2) return NaN;
  const xm = (m - 1) / 2;
  let ym = 0;
  for (let i = 0; i < m; i++) ym += framePts[i];
  ym /= m;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) {
    const dx = i - xm;
    sxy += dx * (framePts[i] - ym);
    sxx += dx * dx;
  }
  return sxy > 0 ? sxx / sxy : NaN;
}

const MAX_EVENTS = 200;
const MAX_DTS_STARTUP_LAG = 32; // > the largest legal reorder depth (16 for H.264/HEVC)

/**
 * @param {{pts:number[], dts:number[], size:number[], flags:string[]}} pk packets in DECODE order;
 *        pts/dts use NaN for "N/A".
 * @param {{num:number, den:number}} tb  stream time base (seconds per tick = num/den)
 */
function analyzeTimeline(pk, tb) {
  const tick = tb.num / tb.den;
  const n = pk.pts.length;
  const out = {
    packets: n, frames: 0, first: NaN, last: NaN, spanSec: 0, medianDt: NaN,
    rateMedian: NaN, rateMean: NaN, rateFit: NaN, framePts: new Float64Array(0),
    gaps: { count: 0, missingFrames: 0, maxFrames: 0, events: [] },
    bursts: { count: 0, events: [] },
    jitter: { count: 0, stdevMs: 0 },
    dupPts: 0,
    dts: { present: false, nonMonotonic: 0, missing: 0, startupMissing: 0, ptsBeforeDts: 0, negativeStart: false, events: [] },
    missingPts: 0,
    gop: { keyCount: 0, meanLen: NaN, minLen: NaN, maxLen: NaN },
    bitrate: { avgBps: 0, peakBps: 0, minBps: 0, p95Bps: 0, peakToAvg: NaN, meanFrameBytes: NaN, maxFrameBytes: 0, meanKeyBytes: NaN },
    badPackets: 0, irregular: false, regular: true,
  };
  if (!n) { out.regular = false; return out; }

  // --- presentation-order timeline -------------------------------------------------------
  const ptsSec = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(pk.pts[i])) ptsSec.push(pk.pts[i] * tick); else out.missingPts++;
  }
  const framePts = Float64Array.from(ptsSec).sort();
  out.framePts = framePts;
  out.frames = framePts.length;
  if (framePts.length < 2) { out.regular = false; return out; }
  out.first = framePts[0];
  out.last = framePts[framePts.length - 1];

  const dts = new Float64Array(framePts.length - 1);
  for (let i = 1; i < framePts.length; i++) dts[i - 1] = framePts[i] - framePts[i - 1];
  const positive = Array.from(dts).filter(d => d > tick * 0.5).sort((a, b) => a - b);
  out.dupPts = dts.length - positive.length;
  const med = median(positive);
  out.medianDt = med;
  out.rateMedian = 1 / med;
  out.spanSec = out.last - out.first + med;
  out.rateMean = (framePts.length - 1) / (out.last - out.first);
  out.rateFit = fitRate(framePts);

  // --- pacing: classify every interval against the median cadence --------------------------
  const tol = Math.max(0.12 * med, 2 * tick);
  let devSq = 0, devN = 0;
  for (let i = 0; i < dts.length; i++) {
    const d = dts[i], t = framePts[i + 1];
    if (d > 1.5 * med) {
      const miss = Math.max(1, Math.round(d / med) - 1);
      out.gaps.count++; out.gaps.missingFrames += miss;
      out.gaps.maxFrames = Math.max(out.gaps.maxFrames, miss);
      if (out.gaps.events.length < MAX_EVENTS) out.gaps.events.push({ t: framePts[i], frames: miss });
    } else if (d < 0.5 * med) {
      out.bursts.count++;
      if (out.bursts.events.length < MAX_EVENTS) out.bursts.events.push({ t });
    } else if (Math.abs(d - med) > tol) {
      out.jitter.count++;
    }
    if (d <= 1.5 * med && d >= 0.5 * med) { devSq += (d - med) * (d - med); devN++; }
  }
  out.jitter.stdevMs = devN ? Math.sqrt(devSq / devN) * 1000 : 0;

  // --- DTS sanity (decode order) -------------------------------------------------------------
  // Containers that store no DTS (Matroska) get it derived by ffmpeg after a start-up lag equal to the
  // B-frame reorder depth, so a short leading run of N/A is normal. N/A after that is a real fault.
  let dtsSeen = 0, prev = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = pk.dts[i];
    if (!Number.isFinite(d)) {
      if (dtsSeen === 0 && i < MAX_DTS_STARTUP_LAG) out.dts.startupMissing++; else out.dts.missing++;
      continue;
    }
    dtsSeen++;
    if (d <= prev) {
      out.dts.nonMonotonic++;
      if (out.dts.events.length < MAX_EVENTS) out.dts.events.push({ index: i, t: d * tick });
    }
    prev = d;
    if (Number.isFinite(pk.pts[i]) && pk.pts[i] < d) out.dts.ptsBeforeDts++;
  }
  out.dts.present = dtsSeen > 0;
  const firstDts = pk.dts.find(Number.isFinite);
  out.dts.negativeStart = firstDts !== undefined && firstDts < 0;

  // --- GOP structure ------------------------------------------------------------------------
  const keys = [];
  for (let i = 0; i < n; i++) if (pk.flags[i] && pk.flags[i].includes('K')) keys.push(i);
  out.gop.keyCount = keys.length;
  if (keys.length > 1) {
    const lens = [];
    for (let i = 1; i < keys.length; i++) lens.push(keys[i] - keys[i - 1]);
    out.gop.meanLen = lens.reduce((a, b) => a + b, 0) / lens.length;
    out.gop.minLen = Math.min(...lens);
    out.gop.maxLen = Math.max(...lens);
  }

  // --- bitrate ------------------------------------------------------------------------------
  let total = 0, maxBytes = 0, keyBytes = 0, keyN = 0;
  const bins = new Map();
  for (let i = 0; i < n; i++) {
    const s = Number.isFinite(pk.size[i]) ? pk.size[i] : 0;
    total += s; maxBytes = Math.max(maxBytes, s);
    if (pk.flags[i] && pk.flags[i].includes('K')) { keyBytes += s; keyN++; }
    if (pk.flags[i] && /[CD]/.test(pk.flags[i].replace('K', ''))) out.badPackets++;
    if (Number.isFinite(pk.pts[i])) {
      const b = Math.floor(pk.pts[i] * tick - out.first);
      bins.set(b, (bins.get(b) || 0) + s * 8);
    }
  }
  out.bitrate.avgBps = out.spanSec > 0 ? (total * 8) / out.spanSec : 0;
  out.bitrate.meanFrameBytes = total / n;
  out.bitrate.maxFrameBytes = maxBytes;
  out.bitrate.meanKeyBytes = keyN ? keyBytes / keyN : NaN;
  // Whole seconds only, so a short tail bin doesn't masquerade as a low-bitrate second.
  const wholeBins = [...bins.entries()].filter(([b]) => b >= 0 && b < Math.floor(out.spanSec)).map(([, v]) => v).sort((a, b) => a - b);
  if (wholeBins.length) {
    out.bitrate.minBps = wholeBins[0];
    out.bitrate.peakBps = wholeBins[wholeBins.length - 1];
    out.bitrate.p95Bps = percentile(wholeBins, 0.95);
    out.bitrate.peakToAvg = out.bitrate.avgBps ? out.bitrate.peakBps / out.bitrate.avgBps : NaN;
  }

  out.irregular = out.gaps.count > 0 || out.bursts.count > 0 || out.dupPts > 0 ||
    out.dts.nonMonotonic > 0 || out.missingPts > 0 || out.jitter.count > Math.max(2, 0.01 * dts.length);
  out.regular = !out.irregular;
  return out;
}

/**
 * Audio continuity + A/V alignment. Audio packets should tile the timeline with no holes.
 * @returns {{present:boolean, first:number, last:number, spanSec:number, discontinuities:number, maxGapMs:number, events:object[]}}
 */
function analyzeAudioTimeline(pk, tb) {
  const tick = tb.num / tb.den;
  const items = [];
  for (let i = 0; i < pk.pts.length; i++) {
    if (Number.isFinite(pk.pts[i])) items.push({ t: pk.pts[i] * tick, d: Number.isFinite(pk.dur[i]) ? pk.dur[i] * tick : NaN });
  }
  items.sort((a, b) => a.t - b.t);
  const res = { present: items.length > 0, first: NaN, last: NaN, spanSec: 0, discontinuities: 0, maxGapMs: 0, events: [] };
  if (!items.length) return res;
  res.first = items[0].t;
  const lastItem = items[items.length - 1];
  res.last = lastItem.t + (Number.isFinite(lastItem.d) ? lastItem.d : 0);
  res.spanSec = res.last - res.first;
  for (let i = 1; i < items.length; i++) {
    const p = items[i - 1];
    if (!Number.isFinite(p.d)) continue;
    const gap = items[i].t - (p.t + p.d);
    // Tolerate up to half a packet of slop (sample-count rounding, edit lists).
    if (Math.abs(gap) > Math.max(0.0005, p.d * 0.5)) {
      res.discontinuities++;
      res.maxGapMs = Math.max(res.maxGapMs, Math.abs(gap) * 1000);
      if (res.events.length < MAX_EVENTS) res.events.push({ t: p.t, gapMs: gap * 1000 });
    }
  }
  return res;
}

module.exports = { parseRational, analyzeTimeline, analyzeAudioTimeline, fitRate, median, percentile };
