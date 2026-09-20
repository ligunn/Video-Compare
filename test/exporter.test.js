'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { exportConformed, buildArgs, encoderOrder, suggestName, timescaleFor } = require('../src/main/exporter');
const { analyzeFile } = require('../src/main/analyzer');
const { planConform } = require('../src/main/conform');
const { getTools, run } = require('../src/main/ffmpeg-tools');

const FX = path.resolve(__dirname, 'fixtures');
const fx = n => path.join(FX, n);
let tmp;

test.before(() => {
  if (!fs.existsSync(fx('ref60.mp4')) || !fs.existsSync(fx('retime5998.mp4')) || !fs.existsSync(fx('dropped60.mp4'))) {
    execFileSync(process.execPath, [path.resolve(__dirname, '..', 'tools', 'make-fixtures.js')], { stdio: 'inherit' });
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-export-'));
});
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

async function frameHashes(file) {
  const { ffmpeg } = await getTools();
  const r = await run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']);
  return r.stdout.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
}

test('buildArgs: retime is a stream copy with scaled timestamps, resample re-encodes with hevc_amf', () => {
  const src = { path: 'in.mp4', info: { video: { bitDepth: 8, colorRange: 'tv', colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709' } }, timeline: { spanSec: 6 } };
  const ref = { rate: 60 };
  const a = buildArgs({ src, ref, entry: { mode: 'retime', slope: 60 / 59.98 }, dest: 'out.mp4' });
  assert.ok(a.includes('copy') && !a.includes('hevc_amf'));
  assert.ok(Math.abs(Number(a[a.indexOf('-itsscale:v') + 1]) - 59.98 / 60) < 1e-9);
  assert.equal(a[a.indexOf('-video_track_timescale') + 1], '15360');
  const b = buildArgs({ src, ref, entry: { mode: 'resample', slope: 1 }, dest: 'out.mp4' });
  assert.ok(b.includes('hevc_amf'));
  assert.ok(!b.includes('libsvtav1') && !b.some(x => /av1/i.test(x)), 'never AV1');
  assert.equal(b[b.indexOf('-vf') + 1], 'fps=fps=60/1:round=near');
  assert.throws(() => buildArgs({ src, ref, entry: { mode: 'none' }, dest: 'x.mp4' }), /needs no conforming/);
});

test('buildArgs: 10-bit sources stay 10-bit; mkv output skips mp4-only options', () => {
  const src = { path: 'in.mkv', info: { video: { bitDepth: 10, colorRange: '', colorSpace: '', colorPrimaries: '', colorTransfer: '' } }, timeline: { spanSec: 6 } };
  const b = buildArgs({ src, ref: { rate: 60000 / 1001 }, entry: { mode: 'resample', slope: 1 }, dest: 'out.mkv' });
  assert.equal(b[b.indexOf('-pix_fmt') + 1], 'p010le');
  assert.ok(b.includes('main10'));
  assert.ok(!b.includes('-movflags') && !b.includes('hvc1'));
  assert.equal(b[b.indexOf('-vf') + 1], 'fps=fps=60000/1001:round=near');
  const r = buildArgs({ src, ref: { rate: 60 }, entry: { mode: 'retime', slope: 1.0003 }, dest: 'out.mkv' });
  assert.ok(!r.includes('-video_track_timescale'));
});

test('buildArgs: libx265 fallback is HEVC too (hvc1, source bit depth, no AMF flags, never AV1)', () => {
  const src = { path: 'in.mp4', info: { video: { bitDepth: 10, colorRange: 'tv', colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709' } }, timeline: { spanSec: 6 } };
  const a = buildArgs({ src, ref: { rate: 60 }, entry: { mode: 'resample', slope: 1 }, dest: 'out.mp4', encoder: 'libx265' });
  assert.equal(a[a.indexOf('-c:v') + 1], 'libx265');
  assert.equal(a[a.indexOf('-pix_fmt') + 1], 'yuv420p10le');
  assert.ok(a.includes('-crf') && a.includes('hvc1'));
  assert.ok(!a.some(x => /amf|qp_i|av1/i.test(x)));
  const eight = buildArgs({ src: { ...src, info: { video: { ...src.info.video, bitDepth: 8 } } }, ref: { rate: 60 }, entry: { mode: 'resample', slope: 1 }, dest: 'o.mp4', encoder: 'libx265' });
  assert.equal(eight[eight.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('encoderOrder: AMF first, libx265 as the fallback; a forced choice is honoured; none available -> empty', () => {
  const both = { hasHevcAmf: true, hasLibx265: true };
  // null (not undefined): undefined would fall through to the VIDEO_COMPARE_ENCODER default and depend on the environment
  assert.deepEqual(encoderOrder(both, null), ['hevc_amf', 'libx265']);
  assert.deepEqual(encoderOrder(both, 'libx265'), ['libx265']);
  assert.deepEqual(encoderOrder(both, 'hevc_amf'), ['hevc_amf']);
  assert.deepEqual(encoderOrder({ hasHevcAmf: false, hasLibx265: true }, null), ['libx265']);
  assert.deepEqual(encoderOrder({ hasHevcAmf: false, hasLibx265: true }, 'hevc_amf'), ['libx265'], 'forcing an unavailable encoder is ignored');
  assert.deepEqual(encoderOrder({ hasHevcAmf: false, hasLibx265: false }, null), []);
});

test('timescaleFor keeps whole ticks per frame', () => {
  assert.equal(timescaleFor({ num: 60, den: 1 }), 15360);            // 256 ticks/frame
  assert.equal(timescaleFor({ num: 60000, den: 1001 }), 60000);      // 1001 ticks/frame
  assert.equal(timescaleFor({ num: 24000, den: 1001 }), 24000);
});

test('suggestName keeps mkv, otherwise mp4, and never equals the source', () => {
  assert.equal(suggestName('clip.MOV'), 'clip.conformed.mp4');
  assert.equal(suggestName('clip.mkv'), 'clip.conformed.mkv');
});

test('RETIME export is lossless: identical decoded frames, now exactly 60 fps', async () => {
  const ref = await analyzeFile(fx('ref60.mp4'));
  const src = await analyzeFile(fx('retime5998.mp4'));
  const plan = planConform([ref, src]);
  assert.equal(plan.videos[1].mode, 'retime');
  const dest = path.join(tmp, 'retimed.mp4');
  const progress = [];
  const res = await exportConformed({ src, ref, entry: plan.videos[1], dest, onProgress: p => progress.push(p) });
  assert.equal(res.lossless, true);
  assert.equal(res.frames, 360);
  assert.ok(Math.abs(res.rate - 60) < 0.005, `rate ${res.rate}`);
  assert.equal(res.regular, true);
  assert.deepEqual(await frameHashes(dest), await frameHashes(fx('retime5998.mp4')), 'every frame bit-identical to the source');
  assert.equal(progress.at(-1), 1);
  // and it now conforms to the reference with nothing left to fix
  const again = planConform([ref, await analyzeFile(dest)]);
  assert.equal(again.videos[1].mode, 'none');
});

test('RESAMPLE export fills the gap with repeated frames and lands on a constant 60 fps timeline', async () => {
  const ref = await analyzeFile(fx('ref60.mp4'));
  const src = await analyzeFile(fx('dropped60.mp4'));
  const plan = planConform([ref, src]);
  assert.equal(plan.videos[1].mode, 'resample');
  const dest = path.join(tmp, 'resampled.mp4');
  const res = await exportConformed({ src, ref, entry: plan.videos[1], dest });
  assert.equal(res.lossless, false);
  assert.equal(res.regular, true, 'no gaps left');
  assert.equal(res.frames, 365, '360 kept + 5 filled');
  assert.ok(Math.abs(res.rate - 60) < 0.005);
  const out = await analyzeFile(dest);
  assert.match(out.info.video.tag, /hvc1/);
  assert.equal(out.info.video.codec, 'hevc');
});

test('RESAMPLE export falls back to libx265 when hevc_amf fails at run time (any PC without an AMD GPU)', async () => {
  const ref = await analyzeFile(fx('ref60.mp4'));
  const src = await analyzeFile(fx('dropped60.mp4'));
  const entry = planConform([ref, src]).videos[1];
  const tools = await getTools();
  const tried = [];
  const flaky = (cmd, args, opts) => {
    const enc = args[args.indexOf('-c:v') + 1];
    tried.push(enc);
    return enc === 'hevc_amf' ? Promise.resolve({ code: 1, stdout: '', stderr: 'DLL amfrt64.dll failed to open' }) : run(cmd, args, opts);
  };
  const saved = process.env.VIDEO_COMPARE_ENCODER; delete process.env.VIDEO_COMPARE_ENCODER;
  try {
    const dest = path.join(tmp, 'fallback.mp4');
    const res = await exportConformed({ src, ref, entry, dest }, { getTools: async () => ({ ...tools, hasHevcAmf: true, hasLibx265: true }), run: flaky });
    assert.deepEqual(tried, ['hevc_amf', 'libx265'], 'tried AMF first, then fell back');
    assert.equal(res.encoder, 'libx265');
    assert.equal(res.frames, 365); assert.equal(res.regular, true);
    const out = await analyzeFile(dest);
    assert.equal(out.info.video.codec, 'hevc'); assert.match(out.info.video.tag, /hvc1/);
    // and when EVERY encoder fails the error says what was tried, and no partial file is left behind
    const dead = path.join(tmp, 'dead.mp4');
    await assert.rejects(exportConformed({ src, ref, entry, dest: dead }, { getTools: async () => ({ ...tools, hasHevcAmf: true, hasLibx265: true }), run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }), /tried hevc_amf, libx265.*boom/);
    assert.equal(fs.existsSync(dead), false);
  } finally { if (saved !== undefined) process.env.VIDEO_COMPARE_ENCODER = saved; }
});

test('RESAMPLE export with libx265 forced (real encode) gives the same clean result', async () => {
  if (!(await getTools()).hasLibx265) return;
  const ref = await analyzeFile(fx('ref60.mp4'));
  const src = await analyzeFile(fx('dropped60.mp4'));
  const entry = planConform([ref, src]).videos[1];
  const saved = process.env.VIDEO_COMPARE_ENCODER; process.env.VIDEO_COMPARE_ENCODER = 'libx265';
  try {
    const res = await exportConformed({ src, ref, entry, dest: path.join(tmp, 'x265.mp4') });
    assert.equal(res.encoder, 'libx265'); assert.equal(res.frames, 365); assert.equal(res.regular, true);
    assert.ok(Math.abs(res.rate - 60) < 0.005);
  } finally { if (saved === undefined) delete process.env.VIDEO_COMPARE_ENCODER; else process.env.VIDEO_COMPARE_ENCODER = saved; }
});

test('exporting over the source is refused', async () => {
  const ref = await analyzeFile(fx('ref60.mp4'));
  const src = await analyzeFile(fx('retime5998.mp4'));
  await assert.rejects(exportConformed({ src, ref, entry: { mode: 'retime', slope: 1.0003 }, dest: fx('retime5998.mp4') }), /overwrite the source/);
});
