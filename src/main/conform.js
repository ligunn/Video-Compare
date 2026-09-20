'use strict';
// Decides how to line the videos up. Pure: takes analyses, returns a plan. No I/O.
//
// Assumption (from the brief): the files are versions of the SAME footage, frame rates within
// ~0.5 fps of each other, and one of them (the reference) has clean, monotonic timestamps.
//
// The plan gives every follower a linear map from the reference clock T to its own media time:
//     media_i(T) = first_i + (T - first_ref) * slope_i + offset
// slope 1 = play by real timestamps ("none"/"resample"); slope = fps_ref/fps_i = "retime".

const STANDARD_RATES = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1], [60000, 1001], [60, 1], [120000, 1001], [120, 1]];

/** Nearest broadcast-standard rate within 0.02%, else the measured rate to 1/1000 fps. */
function snapRate(fps) {
  for (const [num, den] of STANDARD_RATES) {
    if (Math.abs(fps - num / den) / (num / den) < 2e-4) return { num, den, value: num / den };
  }
  return { num: Math.round(fps * 1000), den: 1000, value: Math.round(fps * 1000) / 1000 };
}

const letter = i => String.fromCharCode(65 + i);
const fmt = x => String(+x.toFixed(3));
const RATE_TOLERANCE = 0.5;         // fps: the brief's stated assumption
const SAME_RATE = 0.004;            // fps: below this the rates are the same, not "different"
const FRAME_SLACK = 2;              // frames of count/duration slop before we call it "missing"

function describeIrregularity(tl) {
  const parts = [];
  if (tl.gaps.count) parts.push(`${tl.gaps.count} timing gap${tl.gaps.count > 1 ? 's' : ''} (${tl.gaps.missingFrames} frame${tl.gaps.missingFrames > 1 ? 's' : ''} missing, first at ${fmt(tl.gaps.events[0].t)} s)`);
  if (tl.bursts.count) parts.push(`${tl.bursts.count} extra frame${tl.bursts.count > 1 ? 's' : ''} squeezed between others`);
  if (tl.dupPts) parts.push(`${tl.dupPts} duplicate timestamp${tl.dupPts > 1 ? 's' : ''}`);
  if (tl.dts.nonMonotonic) parts.push(`${tl.dts.nonMonotonic} non-monotonic DTS`);
  if (tl.missingPts) parts.push(`${tl.missingPts} missing PTS`);
  if (!parts.length) parts.push('uneven frame timing');
  return parts.join(', ');
}

/**
 * @param {Array<{rate:number, timeline:object, info:object, framePts:Float64Array}>} vids  (>= 1)
 * @param {{referenceIndex?:number|null, enabled?:boolean}} [opts]
 */
function planConform(vids, opts = {}) {
  const enabled = opts.enabled !== false;
  let ref = Number.isInteger(opts.referenceIndex) ? opts.referenceIndex : vids.findIndex(v => v.timeline.regular);
  if (ref < 0) ref = 0;
  const A = vids[ref];
  const notices = [];
  if (!A.timeline.regular && !Number.isInteger(opts.referenceIndex)) {
    notices.push({ severity: 'warn', text: 'No video has clean timestamps, so there is no trustworthy reference clock. Using the first video as the reference; pairing may drift.' });
  }

  const videos = vids.map((B, i) => {
    const base = { index: i, role: i === ref ? 'reference' : 'follower', mode: 'none', adjusted: false, slope: 1, reasons: [], severity: 'ok' };
    if (i === ref) return base;
    const L = `${letter(i)}`, R = letter(ref);
    const rA = A.rate, rB = B.rate;
    const nA = A.timeline.frames, nB = B.timeline.frames;
    const durA = A.timeline.spanSec, durB = B.timeline.spanSec;
    const sameRate = Math.abs(rA - rB) < SAME_RATE;
    const countClose = Math.abs(nA - nB) <= FRAME_SLACK;
    const durClose = Math.abs(durA - durB) <= FRAME_SLACK / rA;

    if (Math.abs(rA - rB) > RATE_TOLERANCE) {
      base.severity = 'warn';
      base.reasons.push(`${L} runs at ${fmt(rB)} fps vs ${R} at ${fmt(rA)} fps: outside the ±${RATE_TOLERANCE} fps this tool assumes, so these may not be the same footage.`);
    }

    if (!enabled) { base.reasons.push('Frame-rate conforming is switched off: playing by raw timestamps.'); return base; }

    if (!B.timeline.regular) {
      base.mode = 'resample'; base.adjusted = true; base.severity = 'warn';
      base.reasons.unshift(`${L} has irregular timing: ${describeIrregularity(B.timeline)}. Pairing by timestamp against ${R}'s clock, so the picture holds through gaps instead of shifting every later frame.`);
      return base;
    }
    if (!A.timeline.regular) {
      base.severity = 'warn';
      base.reasons.push(`${R} (the reference) also has irregular timing: ${describeIrregularity(A.timeline)}.`);
    }

    if (sameRate) {
      if (!countClose) {
        base.severity = 'warn';
        base.reasons.push(`${L} has ${nB} frames vs ${R}'s ${nA} at the same rate: different length or trim. Paired from the first frame.`);
      }
      return base; // identical rate: nothing to conform
    }

    if (countClose) {
      base.mode = 'retime'; base.adjusted = true; base.slope = rA / rB;
      base.reasons.unshift(`${L} is ${fmt(rB)} fps vs ${R} at ${fmt(rA)} fps with the same frame count (${nB}). Retimed by ${base.slope > 1 ? '+' : ''}${((base.slope - 1) * 100).toFixed(3)}%: every frame kept, frame N stays paired with frame N.`);
    } else if (durClose) {
      base.mode = 'resample'; base.adjusted = true; base.severity = 'warn';
      base.reasons.unshift(`${L} has ${nB} frames vs ${R}'s ${nA} over the same ${fmt(durA)} s (${fmt(rB)} vs ${fmt(rA)} fps): frames were ${nB < nA ? 'dropped' : 'duplicated'}. Pairing by timestamp.`);
    } else {
      base.mode = 'resample'; base.adjusted = true; base.severity = 'warn';
      base.reasons.unshift(`${L} differs from ${R} in both frame count (${nB} vs ${nA}) and duration (${fmt(durB)} s vs ${fmt(durA)} s). Pairing by timestamp from the first frame; check the trim.`);
    }
    return base;
  });

  return { referenceIndex: ref, enabled, videos, notices: [...notices, ...crossChecks(vids)] };
}

/** Cross-file differences worth knowing about that are not timing. */
function crossChecks(vids) {
  const out = [];
  if (vids.length < 2) return out;
  const v0 = vids[0].info.video;
  const same = (f) => vids.every(v => f(v.info.video) === f(v0));
  const list = (f) => vids.map((v, i) => `${letter(i)} ${f(v.info.video)}`).join(' · ');

  if (!same(v => `${v.width}x${v.height}`)) out.push({ severity: 'info', text: `Resolutions differ (${list(v => `${v.width}×${v.height}`)}). All are mapped onto the same picture area; the smaller one is scaled up with the chosen filter.` });
  const aspect = v => v.width / v.height;
  if (vids.some(v => Math.abs(aspect(v.info.video) / aspect(v0) - 1) > 0.005)) out.push({ severity: 'warn', text: `Aspect ratios differ (${list(v => (v.width / v.height).toFixed(3))}). One may be cropped or stretched, so the same region will not line up.` });
  if (!same(v => `${v.colorRange}|${v.colorSpace}|${v.colorTransfer}|${v.colorPrimaries}`)) out.push({ severity: 'warn', text: `Colour tags differ (${list(v => `${v.colorSpace || 'untagged'}${v.colorRange ? ' ' + (v.colorRange === 'tv' ? 'limited' : v.colorRange === 'pc' ? 'full' : v.colorRange) : ''}`)}). Levels or colour can look different for reasons unrelated to quality.` });
  if (!same(v => v.bitDepth)) out.push({ severity: 'info', text: `Bit depth differs (${list(v => v.bitDepth + '-bit')}). Shown through an 8-bit display path either way.` });
  if (!same(v => v.rotation)) out.push({ severity: 'warn', text: `Rotation metadata differs (${list(v => v.rotation + '°')}).` });
  const hasAudio = vids.map(v => !!v.info.audio);
  if (hasAudio.some(a => a !== hasAudio[0])) out.push({ severity: 'info', text: `Audio presence differs (${vids.map((v, i) => `${letter(i)} ${v.info.audio ? 'has audio' : 'silent'}`).join(' · ')}).` });
  const durs = vids.map(v => v.timeline.spanSec);
  if (Math.max(...durs) - Math.min(...durs) > 1) out.push({ severity: 'warn', text: `Durations differ by ${(Math.max(...durs) - Math.min(...durs)).toFixed(2)} s (${vids.map((v, i) => `${letter(i)} ${fmt(v.timeline.spanSec)} s`).join(' · ')}): one may be trimmed.` });
  return out;
}

module.exports = { planConform, crossChecks, snapRate, describeIrregularity, letter };
