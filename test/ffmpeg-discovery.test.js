'use strict';
// A fresh `winget install Gyan.FFmpeg` puts ffmpeg under %LOCALAPPDATA%\Microsoft\WinGet\{Links,Packages}, and the
// current terminal/app session may not have that on PATH yet. The app must find it anyway.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidateDirs } = require('../src/main/ffmpeg-tools');

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('winget install locations are searched even when they are not on PATH', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-winget-'));
  try {
    const pkg = path.join(local, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(local, 'Microsoft', 'WinGet', 'Packages', 'Some.OtherPackage_x', 'bin'), { recursive: true });
    const dirs = withEnv({ LOCALAPPDATA: local, PATH: '' }, () => candidateDirs());
    assert.ok(dirs.includes(path.join(local, 'Microsoft', 'WinGet', 'Links')), 'WinGet Links dir');
    assert.ok(dirs.includes(path.join(pkg, 'bin')), 'the Gyan.FFmpeg package bin dir');
    assert.ok(!dirs.some(d => d.includes('Some.OtherPackage')), 'unrelated packages are not searched');
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});

test('an explicit VIDEO_COMPARE_FFMPEG_DIR wins over everything else', () => {
  const dirs = withEnv({ VIDEO_COMPARE_FFMPEG_DIR: 'C:\\custom\\ffmpeg\\bin' }, () => candidateDirs());
  assert.equal(dirs[0], path.resolve('C:\\custom\\ffmpeg\\bin'));
});

test('no candidate list entry is ever a bare relative path', () => {
  assert.ok(candidateDirs().every(d => path.isAbsolute(d)));
});
