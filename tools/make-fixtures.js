'use strict';
// Generates synthetic test clips into test/fixtures/ (git-ignored). Every clip is a lavfi test pattern with
// the frame number burned in, so frame pairing can be checked by eye. No real media is ever read.
//   node tools/make-fixtures.js [--force] [--uhd]
// HEVC encoder: hevc_amf (AMD GPU) when it actually works on this PC, otherwise libx265 (software).
// Force one with VIDEO_COMPARE_ENCODER=hevc_amf|libx265. --uhd adds two 4K 10-bit clips (only used to measure memory).
const fs = require('node:fs');
const path = require('node:path');
const { getTools, run } = require('../src/main/ffmpeg-tools');

const OUT = path.resolve(__dirname, '..', 'test', 'fixtures');
const FONT = "fontfile='C\\:/Windows/Fonts/consola.ttf'";
const FRAMES = 360; // 6 s at 60 fps

const source = (rate, w = 1280, h = 720) =>
  `testsrc2=size=${w}x${h}:rate=${rate},drawtext=${FONT}:text='%{n}':x=30:y=30:fontsize=${Math.round(h / 10)}:fontcolor=white:box=1:boxcolor=black@0.6`;
const audio = (secs) => ['-f', 'lavfi', '-t', String(secs), '-i', 'sine=frequency=440:sample_rate=48000'];
const aac = ['-c:a', 'aac', '-b:a', '128k'];

/** HEVC encode arguments for the chosen encoder. */
function hevcArgs(encoder, { tenBit = false, tag = 'hvc1', qp = 22 } = {}) {
  const t = tag ? ['-tag:v', tag] : [];
  if (encoder === 'libx265') return ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', String(qp), '-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p', '-x265-params', 'log-level=error', ...t];
  return ['-c:v', 'hevc_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(qp), '-qp_p', String(qp), '-pix_fmt', tenBit ? 'p010le' : 'nv12', ...(tenBit ? ['-profile:v', 'main10'] : []), ...t];
}

/** name -> ffmpeg args (after the leading -hide_banner -loglevel error -y) */
function clips(enc, { uhd }) {
  const hevc = (o) => hevcArgs(enc, o);
  const set = {
    'ref60.mp4': ['-f', 'lavfi', '-i', source(60), ...audio(6), '-frames:v', FRAMES, ...hevc({}), ...aac],
    // Same 360 frames stamped at 59.98 fps: the retime case. Audio is left at true speed.
    'retime5998.mp4': ['-f', 'lavfi', '-i', source('2999/50'), ...audio(6), '-frames:v', FRAMES, ...hevc({}), ...aac],
    // Larger + sharpened: the "upscaled" case (resolution mismatch).
    'up1440.mp4': ['-f', 'lavfi', '-i', source(60), ...audio(6), '-frames:v', FRAMES, '-vf', 'scale=2560:1440:flags=lanczos,unsharp=5:5:0.8', ...hevc({}), ...aac],
    // Frames 100-104 removed but timestamps kept: a 5-frame hole (irregular, resample case).
    'dropped60.mp4': ['-f', 'lavfi', '-i', source(60), ...audio(6), '-frames:v', FRAMES, '-vf', "select='not(between(n,100,104))'", '-fps_mode', 'passthrough', ...hevc({}), ...aac],
    // Audio timestamps start 150 ms late.
    'avoffset60.mp4': ['-f', 'lavfi', '-i', source(60), '-itsoffset', '0.15', ...audio(6), '-frames:v', FRAMES, ...hevc({}), ...aac],
    // Frames 200-203 replaced by a copy of 199: timestamps are perfect, the picture is frozen.
    'frozen60.mp4': ['-f', 'lavfi', '-i', source(60), ...audio(6), '-frames:v', FRAMES,
      '-filter_complex', '[0:v]split[a][b];[a][b]freezeframes=first=200:last=203:replace=199[v]', '-map', '[v]', '-map', '1:a', ...hevc({}), ...aac],
    // libx264 with B-frames in Matroska (1 ms time base): must NOT raise false timing alarms.
    'h264bframes60.mkv': ['-f', 'lavfi', '-i', source(60), ...audio(6), '-frames:v', FRAMES, '-c:v', 'libx264', '-crf', '20', '-bf', '3', '-pix_fmt', 'yuv420p', ...aac],
    // 90 s pair at 60 vs 59.98 fps, 5400 frames each: the drift (~1.7 frames by the end) is only visible
    // on a long clip, so this is what proves conforming end to end in the running app.
    'long60.mp4': ['-f', 'lavfi', '-i', source(60, 640, 360), '-frames:v', 5400, ...hevc({})],
    'long5998.mp4': ['-f', 'lavfi', '-i', source('2999/50', 640, 360), '-frames:v', 5400, ...hevc({})],
    // hev1-tagged HEVC (ffmpeg's default MP4 tag) rather than hvc1.
    'hev1tag60.mp4': ['-f', 'lavfi', '-i', source(60), ...audio(6), '-frames:v', FRAMES, ...hevc({ tag: 'hev1' }), ...aac],
  };
  if (uhd) {
    // Two 4K 10-bit clips: the realistic worst case for decoder/GPU memory, used to measure idle/suspend cost.
    set['uhd60.mp4'] = ['-f', 'lavfi', '-i', source(60, 3840, 2160), '-frames:v', 240, ...hevc({ tenBit: true, qp: 24 })];
    set['uhd5998.mp4'] = ['-f', 'lavfi', '-i', source('2999/50', 3840, 2160), '-frames:v', 240, ...hevc({ tenBit: true, qp: 24 })];
  }
  return set;
}

/**
 * "Listed by ffmpeg" is not "works on this PC" (hevc_amf is listed everywhere but needs an AMD GPU): probe by encoding
 * 2 frames. The probe must be 720p: AMD's HEVC encoder rejects tiny frames (e.g. 320x240 fails Init), which would make
 * a working AMD GPU look unusable.
 */
async function chooseEncoder(tools) {
  const forced = process.env.VIDEO_COMPARE_ENCODER;
  const order = [tools.hasHevcAmf && 'hevc_amf', tools.hasLibx265 && 'libx265'].filter(Boolean);
  if (forced && order.includes(forced)) return forced;
  for (const enc of order) {
    const r = await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-frames:v', '2', ...hevcArgs(enc), '-f', 'null', '-']);
    if (r.code === 0) return enc;
  }
  return null;
}

async function main() {
  const force = process.argv.includes('--force');
  const tools = await getTools();
  if (!tools.ffmpeg) throw new Error('ffmpeg not found. Install it with: winget install --id Gyan.FFmpeg -e');
  const enc = await chooseEncoder(tools);
  if (!enc) throw new Error(`No working HEVC encoder (need libx265 or a usable hevc_amf). ffmpeg: ${tools.ffmpeg}. Install the full build: winget install --id Gyan.FFmpeg -e`);
  console.log(`encoder: ${enc}`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, args] of Object.entries(clips(enc, { uhd: process.argv.includes('--uhd') }))) {
    const dest = path.join(OUT, name);
    if (fs.existsSync(dest) && !force) { console.log(`skip  ${name}`); continue; }
    const r = await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args.map(String), dest]);
    if (r.code !== 0) throw new Error(`${name} failed:\n${r.stderr}`);
    console.log(`made  ${name}  ${(fs.statSync(dest).size / 1e6).toFixed(2)} MB`);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
