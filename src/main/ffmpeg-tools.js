'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const children = new Set();

/** Kill every process started through run(): on Windows children do not die with their parent. */
function killAll() {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  children.clear();
}

/** Run a process, collecting stdout/stderr. Never uses a shell; args are passed as an array. */
function run(cmd, args, { onStdoutLine, onStderrLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, signal });
    children.add(child);
    child.on('close', () => children.delete(child));
    let out = '', err = '', outBuf = '', errBuf = '';
    const feed = (buf, chunk, cb) => {
      buf += chunk;
      let i;
      while ((i = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1);
        cb(line);
      }
      return buf;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      if (onStdoutLine) outBuf = feed(outBuf, d, onStdoutLine); else out += d;
    });
    child.stderr.on('data', d => {
      if (onStderrLine) errBuf = feed(errBuf, d, onStderrLine);
      err += d;
      if (err.length > 1 << 20) err = err.slice(-(1 << 19));
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: out, stderr: err }));
  });
}

let toolsPromise = null;

/** Where `winget install Gyan.FFmpeg` puts things: a Links dir (on PATH after the next sign-in) and the package folder. */
function wingetDirs() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const dirs = [path.join(local, 'Microsoft', 'WinGet', 'Links')];
  const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const p of fs.readdirSync(pkgs)) {
      if (!/^Gyan\.FFmpeg/i.test(p)) continue;
      for (const sub of fs.readdirSync(path.join(pkgs, p))) dirs.push(path.join(pkgs, p, sub, 'bin'));
    }
  } catch { /* winget packages folder not present */ }
  return dirs;
}

function candidateDirs() {
  const dirs = [];
  if (process.env.VIDEO_COMPARE_FFMPEG_DIR) dirs.push(process.env.VIDEO_COMPARE_FFMPEG_DIR);
  const home = os.homedir();
  dirs.push(
    ...wingetDirs(),
    path.join(home, 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'),
    'C:\\ffmpeg\\bin',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
  );
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) dirs.push(d);
  return [...new Set(dirs.map(d => path.resolve(d)))];
}

/**
 * Locate ffmpeg + ffprobe. Some ffmpeg builds on PATH are stripped-down vendor builds with no libx265 or
 * hevc_amf, so score every candidate and prefer a full build.
 * @returns {Promise<{ffmpeg:string|null, ffprobe:string|null, hasHevcAmf:boolean, hasLibx265:boolean, version:string, vendor:boolean}>}
 */
function getTools() {
  if (!toolsPromise) toolsPromise = (async () => {
    const found = [];
    for (const dir of candidateDirs()) {
      const ffmpeg = path.join(dir, 'ffmpeg.exe'), ffprobe = path.join(dir, 'ffprobe.exe');
      if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) found.push({ ffmpeg, ffprobe });
    }
    let best = null;
    for (const c of found) {
      try {
        const enc = await run(c.ffmpeg, ['-hide_banner', '-encoders']);
        const ver = await run(c.ffmpeg, ['-hide_banner', '-version']);
        const hasHevcAmf = /\bhevc_amf\b/.test(enc.stdout);
        const hasLibx265 = /\blibx265\b/.test(enc.stdout);
        const vendor = !hasLibx265 && !hasHevcAmf; // a build that cannot encode HEVC at all is not a "full" build
        const score = (hasHevcAmf ? 4 : 0) + (hasLibx265 ? 2 : 0) + (vendor ? 0 : 1);
        if (!best || score > best.score) best = { ...c, hasHevcAmf, hasLibx265, vendor, version: (ver.stdout.split('\n')[0] || '').trim(), score };
      } catch { /* unusable candidate */ }
    }
    return best || { ffmpeg: null, ffprobe: null, hasHevcAmf: false, hasLibx265: false, version: '', vendor: false, score: -1 };
  })();
  return toolsPromise;
}

function resetToolsCache() { toolsPromise = null; }

async function needTools() {
  const t = await getTools();
  if (!t.ffprobe) throw new Error('ffprobe not found. Install FFmpeg (`winget install --id Gyan.FFmpeg -e`) and restart the app, or set VIDEO_COMPARE_FFMPEG_DIR to the folder containing ffmpeg.exe and ffprobe.exe.');
  return t;
}

/** ffprobe -show_format -show_streams as JSON. */
async function probeStreams(file) {
  const t = await needTools();
  const r = await run(t.ffprobe, ['-v', 'error', '-hide_banner', '-of', 'json', '-show_format', '-show_streams', '-i', path.resolve(file)]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.trim().split('\n').pop() || 'exit ' + r.code}`);
  return JSON.parse(r.stdout);
}

/**
 * Stream every packet of one stream as compact key=value lines (order-independent parsing),
 * into parallel arrays. Packets arrive in decode order.
 */
async function probePackets(file, selector) {
  const t = await needTools();
  const pk = { pts: [], dts: [], dur: [], size: [], flags: [] };
  const num = v => (v === undefined || v === 'N/A' ? NaN : Number(v));
  const r = await run(t.ffprobe, [
    '-v', 'error', '-hide_banner', '-select_streams', selector,
    '-show_entries', 'packet=pts,dts,duration,size,flags', '-of', 'compact=p=0',
    '-i', path.resolve(file),
  ], {
    onStdoutLine: line => {
      if (!line) return;
      const f = {};
      for (const kv of line.split('|')) { const i = kv.indexOf('='); if (i > 0) f[kv.slice(0, i)] = kv.slice(i + 1); }
      pk.pts.push(num(f.pts)); pk.dts.push(num(f.dts)); pk.dur.push(num(f.duration));
      pk.size.push(num(f.size)); pk.flags.push(f.flags || '');
    },
  });
  if (r.code !== 0) throw new Error(`ffprobe packet scan failed: ${r.stderr.trim().split('\n').pop() || 'exit ' + r.code}`);
  return pk;
}

module.exports = { run, killAll, getTools, resetToolsCache, needTools, probeStreams, probePackets, candidateDirs };
