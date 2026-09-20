'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { probeStreams, probePackets } = require('./ffmpeg-tools');
const { parseRational, analyzeTimeline, analyzeAudioTimeline } = require('./timeline');

const num = v => (v === undefined || v === null || v === 'N/A' || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function bitDepthOf(s) {
  const raw = num(s.bits_per_raw_sample);
  if (raw) return raw;
  const m = /(\d+)(?:le|be)?$/.exec(s.pix_fmt || '');
  if (m && [9, 10, 12, 14, 16].includes(Number(m[1]))) return Number(m[1]);
  if (/^p0(10|12|16)/.test(s.pix_fmt || '')) return Number(/^p0(\d\d)/.exec(s.pix_fmt)[1]);
  return 8;
}

function levelText(codec, level) {
  if (level == null || level < 0) return '';
  if (codec === 'hevc') return `L${(level / 30).toFixed(1)}`;
  if (codec === 'h264') return `L${(level / 10).toFixed(1)}`;
  return `L${level}`;
}

/** Reduce ffprobe JSON to only the fields this app uses. */
function normalizeProbe(json, file) {
  const streams = json.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('No video stream found in this file.');
  const a = streams.find(s => s.codec_type === 'audio') || null;
  const fmt = json.format || {};
  const rot = (v.side_data_list || []).find(d => d.rotation !== undefined);
  const sar = /^(\d+):(\d+)$/.exec(v.sample_aspect_ratio || '');
  const info = {
    file: {
      path: file, name: path.basename(file), sizeBytes: num(fmt.size) ?? (fs.existsSync(file) ? fs.statSync(file).size : null),
      container: fmt.format_name || '', durationSec: num(fmt.duration), bitRate: num(fmt.bit_rate), encoder: (fmt.tags && (fmt.tags.encoder || fmt.tags.ENCODER)) || '',
    },
    video: {
      index: v.index, codec: v.codec_name, profile: v.profile || '', level: levelText(v.codec_name, num(v.level)), tag: v.codec_tag_string || '',
      pixFmt: v.pix_fmt || '', bitDepth: bitDepthOf(v), width: v.width, height: v.height,
      sar: sar && Number(sar[2]) ? Number(sar[1]) / Number(sar[2]) : 1,
      rotation: rot ? Number(rot.rotation) : 0,
      fieldOrder: v.field_order || 'unknown',
      colorRange: v.color_range || '', colorSpace: v.color_space || '', colorTransfer: v.color_transfer || '', colorPrimaries: v.color_primaries || '',
      rFrameRate: parseRational(v.r_frame_rate), avgFrameRate: parseRational(v.avg_frame_rate),
      timeBase: parseRational(v.time_base) || { num: 1, den: 1000 },
      nbFrames: num(v.nb_frames), durationSec: num(v.duration), startTime: num(v.start_time), bitRate: num(v.bit_rate),
    },
    audio: a && {
      index: a.index, codec: a.codec_name, sampleRate: num(a.sample_rate), channels: a.channels, layout: a.channel_layout || '',
      bitRate: num(a.bit_rate), startTime: num(a.start_time), durationSec: num(a.duration), timeBase: parseRational(a.time_base) || { num: 1, den: a.sample_rate || 48000 },
    },
  };
  return info;
}

/**
 * The rate to treat this stream as running at.
 * - regular stream: the least-squares fit, snapped to the container's nominal rate when they agree
 *   (so 60000/1001 reads as exactly 59.94005994 rather than 59.9401 +/- noise);
 * - irregular stream: gaps wreck the linear fit, so use the nominal rate if it matches the cadence.
 */
function effectiveRate(info, tl) {
  const nominal = info.video.rFrameRate && info.video.rFrameRate.value;
  if (tl.regular && Number.isFinite(tl.rateFit)) {
    if (nominal && Math.abs(tl.rateFit - nominal) < Math.max(0.01, 2e-4 * nominal)) return nominal;
    return tl.rateFit;
  }
  if (nominal && Number.isFinite(tl.rateMedian) && Math.abs(nominal - tl.rateMedian) / nominal < 0.01) return nominal;
  return Number.isFinite(tl.rateMedian) ? tl.rateMedian : (nominal || NaN);
}

// ---- formatting helpers ------------------------------------------------------------------------
const f3 = x => (Number.isFinite(x) ? String(+x.toFixed(3)) : 'n/a');
const fmtRate = x => (Number.isFinite(x) ? `${(+x.toFixed(3)).toString()} fps` : 'n/a');
const fmtMbps = bps => (Number.isFinite(bps) ? `${(bps / 1e6).toFixed(2)} Mb/s` : 'n/a');
const fmtBytes = b => (b == null ? 'n/a' : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GiB` : `${(b / 2 ** 20).toFixed(1)} MiB`);
const fmtT = s => { if (!Number.isFinite(s)) return 'n/a'; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
const row = (group, id, label, value, severity = 'ok', detail = '') => ({ group, id, label, value, severity, detail });

/** ffprobe reports "mov,mp4,m4a,3gp,3g2,mj2" for the whole ISO-BMFF family; say which one this file is. */
function containerLabel(formatName, fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  if (/matroska/.test(formatName)) return ext === '.webm' ? 'WebM' : 'Matroska';
  if (/mov|mp4/.test(formatName)) return { '.mp4': 'MP4', '.m4v': 'MP4', '.mov': 'QuickTime', '.m4a': 'M4A' }[ext] || 'MP4 / QuickTime';
  if (/mpegts/.test(formatName)) return 'MPEG-TS';
  return formatName.split(',')[0] || 'unknown';
}

function colourText(v) {
  const bits = [v.colorSpace, v.colorTransfer, v.colorPrimaries].filter(Boolean);
  const range = v.colorRange || '';
  if (!bits.length && !range) return 'untagged';
  return `${bits.join(' / ') || 'matrix untagged'}${range ? ` · ${range === 'tv' ? 'limited' : range === 'pc' ? 'full' : range}` : ''}`;
}

/** Build the per-file health table. Severity: ok < info < warn < bad. */
function buildHealth(info, tl, atl, rate) {
  const v = info.video, rows = [];
  const w = v.width, h = v.height;
  const G = { S: 'Stream', T: 'Timing', X: 'Structure', A: 'Audio' };

  // -- Stream ------------------------------------------------------------------------------------
  rows.push(row(G.S, 'container', 'Container', containerLabel(info.file.container, info.file.name)));
  rows.push(row(G.S, 'codec', 'Codec', `${(v.codec || '').toUpperCase()}${v.profile ? ' ' + v.profile : ''}${v.level ? ' @ ' + v.level : ''}${v.tag && !v.tag.startsWith('[') ? ` (${v.tag})` : ''}`));
  rows.push(row(G.S, 'pixfmt', 'Pixel format', `${v.pixFmt} (${v.bitDepth}-bit)`));
  const sarNote = Math.abs(v.sar - 1) > 0.005;
  rows.push(row(G.S, 'res', 'Resolution', `${w}×${h}${sarNote ? ` (SAR ${f3(v.sar)})` : ''}${v.rotation ? ` rot ${v.rotation}°` : ''}`, sarNote || v.rotation ? 'info' : 'ok',
    sarNote ? 'Non-square pixels: the app shows the frame at its stored size and does not apply SAR.' : ''));
  rows.push(row(G.S, 'scan', 'Scan', v.fieldOrder === 'progressive' || v.fieldOrder === 'unknown' ? 'progressive' : `interlaced (${v.fieldOrder})`,
    v.fieldOrder !== 'progressive' && v.fieldOrder !== 'unknown' ? 'warn' : 'ok', 'Interlaced sources show combing unless deinterlaced.'));
  rows.push(row(G.S, 'colour', 'Colour', colourText(v), colourText(v) === 'untagged' ? 'info' : 'ok',
    colourText(v) === 'untagged' ? 'No colour tags: players guess BT.709 (HD) or BT.601 (SD).' : ''));
  rows.push(row(G.S, 'size', 'File size', fmtBytes(info.file.sizeBytes)));

  // -- Timing ------------------------------------------------------------------------------------
  const nominal = v.rFrameRate && v.rFrameRate.value;
  const rateDiff = nominal && tl.regular ? Math.abs(nominal - rate) : 0;
  rows.push(row(G.T, 'rate', 'Frame rate', `${fmtRate(rate)}${tl.regular ? '' : ' (nominal)'}`, rateDiff > 0.01 ? 'info' : 'ok',
    rateDiff > 0.01 ? `Container says ${f3(nominal)} fps but the timestamps measure ${f3(tl.rateFit)} fps.` : ''));
  rows.push(row(G.T, 'cadence', 'Cadence', tl.regular ? 'constant' : 'irregular', tl.regular ? 'ok' : 'bad',
    tl.regular ? '' : 'Timestamps are not evenly spaced: gaps, bursts, duplicates or out-of-order timing were found (see below).'));
  const expected = Number.isFinite(info.file.durationSec) && rate ? Math.round(info.file.durationSec * rate) : null;
  const headerMismatch = v.nbFrames != null && Math.abs(v.nbFrames - tl.frames) > 1;
  rows.push(row(G.T, 'frames', 'Frames', `${tl.frames}${v.nbFrames != null ? ` (header ${v.nbFrames})` : ''}${expected != null ? ` · expected ≈${expected}` : ''}`,
    headerMismatch ? 'warn' : 'ok', headerMismatch ? 'The header frame count disagrees with the frames actually present: file may be truncated or damaged.' : ''));
  const contDur = info.file.durationSec, vidDur = tl.spanSec;
  const durOff = Number.isFinite(contDur) ? Math.abs(contDur - vidDur) : 0;
  rows.push(row(G.T, 'duration', 'Duration', `${f3(vidDur)} s${Number.isFinite(contDur) ? ` (container ${f3(contDur)} s)` : ''}`,
    durOff > Math.max(0.1, 3 / rate) ? 'warn' : 'ok', durOff > Math.max(0.1, 3 / rate) ? 'Container and video-stream durations disagree.' : ''));
  rows.push(row(G.T, 'gaps', 'Timing gaps (dropped frames)', tl.gaps.count ? `${tl.gaps.count} gap${tl.gaps.count > 1 ? 's' : ''} · ${tl.gaps.missingFrames} frames missing · longest ${tl.gaps.maxFrames}` : 'none',
    tl.gaps.count ? 'bad' : 'ok', tl.gaps.count ? `First at ${fmtT(tl.gaps.events[0].t)}. The picture holds during a gap, which reads as a stutter.` : ''));
  rows.push(row(G.T, 'bursts', 'Timing bursts (extra frames)', tl.bursts.count ? `${tl.bursts.count} frame${tl.bursts.count > 1 ? 's' : ''} closer than half an interval` : 'none',
    tl.bursts.count ? 'bad' : 'ok', tl.bursts.count ? `First at ${fmtT(tl.bursts.events[0].t)}.` : ''));
  rows.push(row(G.T, 'jitter', 'Frame-time jitter', tl.jitter.count ? `${tl.jitter.count} uneven intervals · σ ${tl.jitter.stdevMs.toFixed(2)} ms` : `σ ${tl.jitter.stdevMs.toFixed(2)} ms`,
    tl.jitter.count > Math.max(2, 0.01 * tl.frames) ? 'warn' : 'ok'));
  rows.push(row(G.T, 'duppts', 'Duplicate timestamps', tl.dupPts ? String(tl.dupPts) : 'none', tl.dupPts ? 'bad' : 'ok'));
  const dtsBad = tl.dts.nonMonotonic > 0 || tl.dts.ptsBeforeDts > 0;
  rows.push(row(G.T, 'dts', 'Decode timestamps (DTS)',
    !tl.dts.present ? 'not stored' : dtsBad ? `${tl.dts.nonMonotonic} non-monotonic${tl.dts.ptsBeforeDts ? ` · ${tl.dts.ptsBeforeDts} with PTS<DTS` : ''}` : 'monotonic',
    dtsBad ? 'bad' : !tl.dts.present ? 'info' : 'ok',
    dtsBad ? 'Out-of-order or repeated DTS breaks seeking and can cause players to drop or repeat frames.' : ''));
  const missing = tl.missingPts + (tl.dts.present ? tl.dts.missing : 0);
  rows.push(row(G.T, 'missingts', 'Missing timestamps', missing ? `${tl.missingPts} PTS · ${tl.dts.missing} DTS` : 'none', missing ? 'bad' : 'ok'));

  // -- Structure ---------------------------------------------------------------------------------
  rows.push(row(G.X, 'gop', 'Keyframes', tl.gop.keyCount > 1 ? `${tl.gop.keyCount} · GOP avg ${tl.gop.meanLen.toFixed(1)} (${tl.gop.minLen}–${tl.gop.maxLen})` : `${tl.gop.keyCount}`,
    tl.gop.keyCount <= 1 && tl.frames > 300 ? 'info' : 'ok', tl.gop.keyCount <= 1 && tl.frames > 300 ? 'A single keyframe makes seeking slow.' : ''));
  const bitrate = tl.bitrate.avgBps;
  rows.push(row(G.X, 'bitrate', 'Video bitrate', `${fmtMbps(bitrate)} avg${Number.isFinite(tl.bitrate.peakBps) && tl.bitrate.peakBps ? ` · peak ${fmtMbps(tl.bitrate.peakBps)} (×${tl.bitrate.peakToAvg.toFixed(2)})` : ''}`));
  const bpp = w && h && rate ? bitrate / (w * h * rate) : NaN;
  rows.push(row(G.X, 'bpp', 'Bits / pixel / frame', Number.isFinite(bpp) ? bpp.toFixed(4) : 'n/a', 'ok', 'A rough efficiency figure: more bits per pixel is not automatically better.'));
  rows.push(row(G.X, 'bad', 'Corrupt / discarded packets', tl.badPackets ? String(tl.badPackets) : 'none', tl.badPackets ? 'bad' : 'ok'));

  // -- Audio -------------------------------------------------------------------------------------
  const au = info.audio;
  if (!au) {
    rows.push(row(G.A, 'audio', 'Audio track', 'none', 'info'));
  } else {
    rows.push(row(G.A, 'audio', 'Audio track', `${(au.codec || '').toUpperCase()} · ${au.sampleRate ? au.sampleRate / 1000 + ' kHz' : ''} · ${au.channels || '?'} ch${au.bitRate ? ' · ' + Math.round(au.bitRate / 1000) + ' kb/s' : ''}`));
    // Use the container's own start_time (edit-list aware): the raw first audio packet is often the
    // encoder-priming packet (AAC: -1024 samples = -21 ms) that players never present. Precision is
    // therefore about one audio frame (~21 ms for AAC at 48 kHz).
    const vStart = v.startTime ?? tl.first;
    const aStart = au.startTime ?? Math.max(0, atl.first);
    const offMs = (aStart - vStart) * 1000;
    const offSev = Math.abs(offMs) > 100 ? 'bad' : Math.abs(offMs) > 45 ? 'warn' : 'ok';
    rows.push(row(G.A, 'avstart', 'A/V start offset', `${offMs >= 0 ? '+' : ''}${offMs.toFixed(1)} ms`, offSev,
      offSev !== 'ok' ? `Audio starts ${Math.abs(offMs).toFixed(0)} ms ${offMs > 0 ? 'after' : 'before'} the video. Beyond ~45 ms lip-sync is noticeable. (Precision ≈ one audio frame.)` : ''));
    // End-to-end comparison isolates drift/trim mismatch from the start offset above.
    const endMs = atl.present ? (atl.last - (tl.last + tl.medianDt)) * 1000 : 0;
    const dSev = Math.abs(endMs) > 500 ? 'bad' : Math.abs(endMs) > 200 ? 'warn' : 'ok';
    rows.push(row(G.A, 'avend', 'A/V end offset', `${endMs >= 0 ? '+' : ''}${endMs.toFixed(0)} ms`, dSev,
      dSev !== 'ok' ? 'Audio and video end at different times: drift, or one stream was trimmed differently.' : ''));
    rows.push(row(G.A, 'audiogaps', 'Audio discontinuities', atl.discontinuities ? `${atl.discontinuities} · largest ${atl.maxGapMs.toFixed(1)} ms` : 'none', atl.discontinuities ? 'bad' : 'ok',
      atl.discontinuities ? 'Holes or overlaps in the audio timeline cause clicks and gradual A/V drift.' : ''));
  }
  return rows;
}

/** Marks for the scrubber: where the trouble is. */
function buildMarkers(tl) {
  const m = [];
  for (const e of tl.gaps.events) m.push({ t: e.t, kind: 'gap', label: `${e.frames} frame${e.frames > 1 ? 's' : ''} missing` });
  for (const e of tl.bursts.events) m.push({ t: e.t, kind: 'burst', label: 'extra frame' });
  return m.sort((a, b) => a.t - b.t);
}

async function analyzeFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const json = await probeStreams(abs);
  const info = normalizeProbe(json, abs);
  const [vpk, apk] = await Promise.all([
    probePackets(abs, String(info.video.index)),
    info.audio ? probePackets(abs, String(info.audio.index)) : Promise.resolve(null),
  ]);
  const tl = analyzeTimeline(vpk, info.video.timeBase);
  if (tl.frames < 2) throw new Error('This file has fewer than two decodable video frames.');
  const atl = apk ? analyzeAudioTimeline(apk, info.audio.timeBase) : { present: false, first: NaN, last: NaN, spanSec: 0, discontinuities: 0, maxGapMs: 0, events: [] };
  const rate = effectiveRate(info, tl);
  const framePts = tl.framePts;
  const { framePts: _drop, ...tlSummary } = tl;
  return { path: abs, name: path.basename(abs), info, rate, timeline: tlSummary, audioTimeline: atl, framePts, health: buildHealth(info, tl, atl, rate), markers: buildMarkers(tl) };
}

module.exports = { analyzeFile, normalizeProbe, effectiveRate, buildHealth, buildMarkers, fmtT, f3 };
