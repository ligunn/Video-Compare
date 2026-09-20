'use strict';
// Content-level "deep scan": finds repeated (frozen / duplicated) frames, which are invisible to the
// timestamp analysis because the timestamps of a duplicated frame are perfectly regular.
//
// Method: decode at 320px grey, take signalstats YDIF (mean absolute luma difference to the previous
// frame). A frame is REPEATED if its YDIF is tiny relative to the motion around it, so a genuinely
// static scene (low YDIF everywhere) is not flagged, but a repeat inside moving content is.
const { getTools, run } = require('./ffmpeg-tools');

const WINDOW = 15;          // frames either side used to judge "local motion"
const MIN_MOTION = 0.3;     // local motion (p90 YDIF, 0-255 scale) below this = static content, don't judge
const REL = 0.1;            // repeated if YDIF < REL * local motion ...
const ABS_FLOOR = 0.05;     // ... or below this absolute floor
const MAX_EVENTS = 200;

function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

/**
 * @param {number[]} ydif per-frame difference to the previous frame (index 0 is ignored)
 * @param {number[]} times per-frame presentation time (s)
 */
function analyzeYdif(ydif, times) {
  const n = ydif.length;
  const repeated = new Uint8Array(n);
  let judged = 0;
  for (let i = 1; i < n; i++) {
    const lo = Math.max(1, i - WINDOW), hi = Math.min(n - 1, i + WINDOW);
    const win = ydif.slice(lo, hi + 1).sort((a, b) => a - b);
    const motion = percentile(win, 0.9);
    if (motion <= MIN_MOTION) continue;
    judged++;
    if (ydif[i] < Math.max(ABS_FLOOR, REL * motion)) repeated[i] = 1;
  }
  const events = [], starts = [];
  let count = 0, longest = 0, runs = 0;
  for (let i = 1; i < n;) {
    if (!repeated[i]) { i++; continue; }
    let j = i;
    while (j < n && repeated[j]) j++;
    const len = j - i;
    count += len; runs++; longest = Math.max(longest, len); starts.push(i);
    if (events.length < MAX_EVENTS) events.push({ t: times[i - 1] ?? times[i], frames: len });
    i = j;
  }
  // Periodic pattern? (e.g. 30 fps content in a 60 fps file repeats every 2nd frame)
  let period = 0;
  if (starts.length >= 8) {
    const gaps = new Map();
    for (let k = 1; k < starts.length; k++) gaps.set(starts[k] - starts[k - 1], (gaps.get(starts[k] - starts[k - 1]) || 0) + 1);
    const [g, c] = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0];
    if (c / (starts.length - 1) >= 0.7) period = g;
  }
  return { frames: n, judged, repeated: count, fraction: n > 1 ? count / (n - 1) : 0, runs, longestRun: longest, period, events };
}

/** Rows to merge into the health table. */
function repeatRows(r, rate) {
  const bad = r.longestRun >= 3 || r.fraction > 0.02;
  const rows = [{
    group: 'Content', id: 'repeats', label: 'Repeated frames',
    value: r.judged === 0 ? 'static content: not judged' : r.repeated ? `${r.repeated} (${(r.fraction * 100).toFixed(1)}%) in ${r.runs} run${r.runs > 1 ? 's' : ''} · longest ${r.longestRun}` : 'none',
    severity: r.judged === 0 ? 'info' : r.repeated ? (bad ? 'bad' : 'warn') : 'ok',
    detail: r.repeated ? 'Near-identical consecutive frames inside moving content: a freeze, a stall, or frame-rate conversion by duplication.' : '',
  }];
  if (r.period && r.fraction > 0.1) {
    rows.push({
      group: 'Content', id: 'uniquerate', label: 'Effective unique frame rate',
      value: `≈${(rate * (1 - r.fraction)).toFixed(1)} fps (every ${r.period}${['st', 'nd', 'rd'][r.period - 1] || 'th'} frame repeats)`, severity: 'warn',
      detail: 'The container rate is higher than the rate at which the picture actually changes.',
    });
  }
  return rows;
}

async function scanRepeats(file, { durationSec, onProgress, signal } = {}) {
  const tools = await getTools();
  if (!tools.ffmpeg) throw new Error('ffmpeg not found.');
  const ydif = [], times = [];
  let t = NaN;
  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:2', '-hwaccel', 'auto', '-i', file,
    '-map', '0:v:0', '-an', '-vf', 'scale=320:-2:flags=area,format=gray,signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF:file=-',
    '-f', 'null', '-',
  ];
  const r = await run(tools.ffmpeg, args, {
    signal,
    onStdoutLine: line => {
      let m;
      if ((m = /pts_time:([-\d.]+)/.exec(line))) t = Number(m[1]);
      else if ((m = /lavfi\.signalstats\.YDIF=([\d.]+)/.exec(line))) { ydif.push(Number(m[1])); times.push(t); }
    },
    onStderrLine: line => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && onProgress && durationSec) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / durationSec));
    },
  });
  if (r.code !== 0 && !ydif.length) throw new Error(`Deep scan failed: ${r.stderr.trim().split('\n').pop() || 'exit ' + r.code}`);
  if (onProgress) onProgress(1);
  return analyzeYdif(ydif, times);
}

module.exports = { analyzeYdif, repeatRows, scanRepeats };
