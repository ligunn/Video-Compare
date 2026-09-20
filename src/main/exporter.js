'use strict';
// "Save conformed copy": writes the follower re-timed onto the reference's frame rate.
//   retime   -> LOSSLESS remux. Only timestamps are rewritten (-c copy), so every encoded frame is
//               bit-identical to the source and there is no generation loss.
//   resample -> must duplicate/drop frames, which cannot be done on a stream copy, so it re-encodes to HEVC at
//               a high quality: hevc_amf (AMD GPU, fast) when it works, otherwise libx265 (software, works
//               everywhere). Never AV1. Set VIDEO_COMPARE_ENCODER=hevc_amf|libx265 to force one.
const fs = require('node:fs');
const path = require('node:path');
const { getTools, run } = require('./ffmpeg-tools');
const { snapRate } = require('./conform');
const { analyzeFile } = require('./analyzer');

const RESAMPLE_QP = 16;    // hevc_amf constant QP
const RESAMPLE_CRF = 16;   // libx265 constant rate factor

/**
 * Encoders to try, in order. "Compiled into this ffmpeg" is not "works on this PC": every full build lists
 * hevc_amf, but it only runs on AMD GPUs, so libx265 stays behind it as the fallback.
 */
function encoderOrder(tools, forced = process.env.VIDEO_COMPARE_ENCODER) {
  const all = [];
  if (tools.hasHevcAmf) all.push('hevc_amf');
  if (tools.hasLibx265) all.push('libx265');
  return forced && all.includes(forced) ? [forced] : all;
}

function encodeArgs(encoder, { tenBit, isMp4 }) {
  const tag = isMp4 ? ['-tag:v', 'hvc1'] : [];
  if (encoder === 'libx265') {
    return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(RESAMPLE_CRF), '-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p', '-x265-params', 'log-level=error', ...tag];
  }
  return ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(RESAMPLE_QP), '-qp_p', String(RESAMPLE_QP),
    '-pix_fmt', tenBit ? 'p010le' : 'nv12', ...(tenBit ? ['-profile:v', 'main10'] : []), ...tag];
}

function suggestName(srcName) {
  const p = path.parse(srcName);
  return `${p.name}.conformed${p.ext.toLowerCase() === '.mkv' ? '.mkv' : '.mp4'}`;
}

/** mp4 track timescale that divides evenly into the target frame duration and is >= 15360. */
function timescaleFor(rate) {
  return rate.num * Math.ceil(15360 / rate.num);
}

function colourArgs(v) {
  const a = [];
  const add = (flag, val) => { if (val && val !== 'unknown' && val !== 'unspecified') a.push(flag, val); };
  add('-color_range', v.colorRange); add('-colorspace', v.colorSpace); add('-color_primaries', v.colorPrimaries); add('-color_trc', v.colorTransfer);
  return a;
}

/** Pure: builds the ffmpeg argument list. Unit-tested without running ffmpeg. */
function buildArgs({ src, ref, entry, dest, encoder = 'hevc_amf' }) {
  const rate = snapRate(ref.rate);
  const ext = path.extname(dest).toLowerCase();
  const isMp4 = ext === '.mp4' || ext === '.mov' || ext === '.m4v';
  const v = src.info.video;
  const head = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
  const maps = ['-map', '0:v:0', '-map', '0:a?'];

  if (entry.mode === 'retime') {
    // itsscale multiplies input timestamps. B frame n sits at n/rB; we want n/rA, so scale by rB/rA = 1/slope.
    return [...head, '-itsscale:v', (1 / entry.slope).toPrecision(15), '-i', src.path, ...maps, '-c', 'copy',
      ...(isMp4 ? ['-video_track_timescale', String(timescaleFor(rate)), '-movflags', '+faststart'] : []), dest];
  }
  if (entry.mode === 'resample') {
    return [...head, '-i', src.path, ...maps,
      '-vf', `fps=fps=${rate.num}/${rate.den}:round=near`,
      ...encodeArgs(encoder, { tenBit: v.bitDepth > 8, isMp4 }),
      ...colourArgs(v), '-c:a', 'copy', ...(isMp4 ? ['-movflags', '+faststart'] : []), dest];
  }
  throw new Error('This video needs no conforming.');
}

/**
 * @returns {Promise<{dest:string, mode:string, lossless:boolean, encoder:string|null, frames:number, rate:number, regular:boolean}>}
 */
async function exportConformed({ src, ref, entry, dest, onProgress, signal }, deps = { getTools, run }) {
  const { getTools: getToolsFn, run: runFn } = deps;   // injectable so tests can simulate an encoder failing
  const tools = await getToolsFn();
  if (!tools.ffmpeg) throw new Error('ffmpeg not found. Install FFmpeg (`winget install --id Gyan.FFmpeg -e`) and restart the app.');
  const order = entry.mode === 'resample' ? encoderOrder(tools) : [null]; // a retime is a stream copy: no encoder
  if (!order.length) throw new Error('Re-encoding needs an ffmpeg build with libx265 or hevc_amf. Install the full build (`winget install --id Gyan.FFmpeg -e`) or set VIDEO_COMPARE_FFMPEG_DIR.');
  if (path.resolve(dest) === path.resolve(src.path)) throw new Error('Refusing to overwrite the source file.');
  const dur = src.timeline.spanSec;
  let used = null, failure = '';
  for (const encoder of order) {
    const r = await runFn(tools.ffmpeg, buildArgs({ src, ref, entry, dest, ...(encoder ? { encoder } : {}) }), {
      signal,
      onStdoutLine: line => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onProgress && dur) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / dur));
      },
    });
    if (r.code === 0) { used = encoder; failure = ''; break; }
    failure = r.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`;
    fs.rmSync(dest, { force: true });        // drop the partial file, then try the next encoder
    if (signal && signal.aborted) break;
  }
  if (failure) throw new Error(`ffmpeg failed${order.length > 1 ? ` (tried ${order.join(', ')})` : ''}: ${failure}`);
  if (onProgress) onProgress(1);
  const out = await analyzeFile(dest); // verify what was actually written, not what we asked for
  return { dest, mode: entry.mode, lossless: entry.mode === 'retime', encoder: used, frames: out.timeline.frames, rate: out.rate, regular: out.timeline.regular };
}

module.exports = { exportConformed, buildArgs, encoderOrder, suggestName, timescaleFor };
