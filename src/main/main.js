'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createMediaServer } = require('./media-server');
const { analyzeFile } = require('./analyzer');
const { planConform } = require('./conform');
const { getTools, killAll } = require('./ffmpeg-tools');
const { exportConformed, suggestName } = require('./exporter');
const { scanRepeats, repeatRows } = require('./deepscan');
const { APP_ID, parseCommand, createRouter } = require('./commands');
const { createTaskbar } = require('./taskbar');
const shortcuts = require('./shortcuts');

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'ts', 'm2ts'];
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const testMode = argv.includes('--selftest');
const installMode = argv.includes('--install-shortcuts'), removeMode = argv.includes('--remove-shortcuts');
const command = parseCommand(argv);                 // --quit / --suspend / --resume / --toggle-*
const cliFiles = argv.filter(a => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isFile()).map(a => path.resolve(a));
const fileArgs = list => list.filter(a => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isFile()).map(a => path.resolve(a));

if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // must precede any window: groups the taskbar icon

if (testMode) {
  // A self-test must be invisible to a real running instance: its own profile (so no shared cache locks and,
  // with the lock skipped below, no way to reach the user's window), and no modal error boxes on their desktop.
  const profile = path.join(require('node:os').tmpdir(), 'video-compare-selftest'); // one fixed folder, wiped each run: no litter
  fs.rmSync(profile, { recursive: true, force: true });
  app.setPath('userData', profile);
  process.on('uncaughtException', e => { console.log(`FAIL  uncaught exception in main process — ${e && e.stack || e}`); app.exit(1); });
}

const media = createMediaServer();
const analyses = new Map();   // id -> analysis (kept here so the page never has to send big arrays back)
let win = null;
let rendererReady = false;
let queuedFiles = [...cliFiles];
let exportAbort = null;

// Test seam (only with --selftest): skip native dialogs and write into this folder instead.
const testDir = testMode ? process.env.VC_TEST_SAVE_DIR || path.join(__dirname, '..', '..', 'test', 'out', 'exports') : null;

const router = createRouter({ getWindow: () => win, quit: () => { if (exportAbort) exportAbort.abort(); app.quit(); } });
const taskbar = createTaskbar({ app, nativeImage, getWindow: () => win, run: cmd => router.run(cmd) });

// One window; a second launch (Explorer, a shortcut, a jump-list task) hands its command line to the first.
const gotLock = testMode || installMode || removeMode || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv2) => {
  const args = argv2.slice(app.isPackaged ? 1 : 2);
  const cmd = parseCommand(args);
  if (cmd) { router.run(cmd); return; }     // control commands must not steal focus or pop the window up
  const files = fileArgs(args);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  if (files.length) sendFiles(files);
});

function sendFiles(files) {
  if (win && rendererReady) win.webContents.send('vc:open-files', files);
  else queuedFiles.push(...files);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560, height: 940, minWidth: 980, minHeight: 620, backgroundColor: '#0d0f13', title: 'Video Compare', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.on('show', () => taskbar.update({}));   // the taskbar button only exists once the window is shown
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F5') win.webContents.reload();
  });
  win.on('closed', () => { win = null; rendererReady = false; });
  return win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: testMode ? { test: '1' } : {} });
}

// ---------------------------------------------------------------------------------------------- IPC
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const asPath = p => { need(typeof p === 'string' && p.length > 0 && p.length < 4096, 'Invalid path.'); return path.resolve(p); };

// The page reports {hasVideos, playing, suspended}; the taskbar buttons follow.
ipcMain.on('vc:state', (_e, s) => {
  if (!s || typeof s !== 'object') return;
  taskbar.update({ hasVideos: !!s.hasVideos, playing: !!s.playing, suspended: !!s.suspended });
});

ipcMain.handle('vc:renderer-ready', () => {
  rendererReady = true;
  if (queuedFiles.length) { win.webContents.send('vc:open-files', queuedFiles); queuedFiles = []; }
});

ipcMain.handle('vc:tools', async () => {
  const t = await getTools();
  return { ffmpeg: t.ffmpeg, ffprobe: t.ffprobe, hasHevcAmf: t.hasHevcAmf, version: t.version, vendor: t.vendor };
});

ipcMain.handle('vc:open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose videos to compare', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('vc:analyze', async (_e, p) => {
  const a = await analyzeFile(asPath(p));
  const { id, url } = media.register(a.path);
  analyses.set(id, { ...a, id, url });
  return { ...a, id, url };
});

ipcMain.handle('vc:release', (_e, id) => { analyses.delete(id); media.release(id); });

function planFor(ids, referenceIndex, enabled) {
  need(Array.isArray(ids) && ids.length > 0 && ids.length <= 16, 'Invalid selection.');
  const list = ids.map(id => { const a = analyses.get(id); need(a, 'Unknown video.'); return a; });
  return { list, plan: planConform(list, { referenceIndex: Number.isInteger(referenceIndex) ? referenceIndex : null, enabled: enabled !== false }) };
}

ipcMain.handle('vc:plan', (_e, o) => planFor(o.ids, o.referenceIndex, o.enabled).plan);

ipcMain.handle('vc:deepscan', async (_e, id) => {
  const a = analyses.get(id);
  need(a, 'Unknown video.');
  let last = -1;
  const r = await scanRepeats(a.path, {
    durationSec: a.timeline.spanSec,
    onProgress: pct => { const q = Math.round(pct * 100); if (q !== last && win) { last = q; win.webContents.send('vc:progress', { kind: 'deepscan', id, pct }); } },
  });
  return { rows: repeatRows(r, a.rate), markers: r.events.map(e => ({ t: e.t, kind: 'repeat', label: `${e.frames} repeated frame${e.frames > 1 ? 's' : ''}` })), summary: { repeated: r.repeated, fraction: r.fraction } };
});

ipcMain.handle('vc:export-conform', async (_e, o) => {
  const { list, plan } = planFor(o.ids, o.referenceIndex, o.enabled);
  need(Number.isInteger(o.followerIndex) && plan.videos[o.followerIndex], 'Invalid video.');
  const entry = plan.videos[o.followerIndex];
  need(entry.adjusted, 'This video needs no conforming.');
  const src = list[o.followerIndex], ref = list[plan.referenceIndex];
  const r = testDir ? { canceled: false, filePath: path.join(testDir, suggestName(src.name)) } : await dialog.showSaveDialog(win, {
    title: 'Save conformed copy', defaultPath: path.join(path.dirname(src.path), suggestName(src.name)),
    filters: [{ name: 'MP4 / Matroska', extensions: ['mp4', 'mkv'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  exportAbort = new AbortController();
  try {
    return await exportConformed({
      src, ref, entry, dest: r.filePath, signal: exportAbort.signal,
      onProgress: pct => win && win.webContents.send('vc:progress', { kind: 'export', pct }),
    });
  } finally { exportAbort = null; }
});
ipcMain.handle('vc:cancel-export', () => { if (exportAbort) exportAbort.abort(); });

ipcMain.handle('vc:save-pngs', async (_e, files) => {
  need(Array.isArray(files) && files.length > 0 && files.length <= 64, 'Nothing to save.');
  const r = testDir ? { canceled: false, filePaths: [testDir] } : await dialog.showOpenDialog(win, { title: 'Choose a folder for the PNG files', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  let first = null;
  for (const f of files) {
    need(f && typeof f.name === 'string' && f.data && f.data.byteLength > 0, 'Invalid file.');
    const safe = path.basename(f.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/(\.png)?$/i, '.png');
    const dest = path.join(r.filePaths[0], safe);
    fs.writeFileSync(dest, Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength));
    first = first || dest;
  }
  return { canceled: false, count: files.length, first };
});

ipcMain.handle('vc:reveal', (_e, p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(path.resolve(p)); });

// ---------------------------------------------------------------------------------------------- lifecycle
if (gotLock) {
  app.whenReady().then(async () => {
    if (installMode || removeMode) {                        // one-shot: (re)create or delete the shortcuts, then exit
      const results = installMode ? shortcuts.install({ app, shell }) : shortcuts.remove({ app });
      console.log(JSON.stringify(results, null, 2));
      app.exit(results.every(r => r.ok) ? 0 : 1);
      return;
    }
    if (command && !testMode) { app.exit(0); return; }      // "Stop"/"Suspend" with nothing running: nothing to do, no window
    await media.start();
    await createWindow();
    taskbar.setTasks();
    if (testMode) require('./selftest').run({ app, win, media, argv, testDir, taskbar, router });
  });
}
app.on('window-all-closed', () => { media.close(); app.quit(); });
app.on('will-quit', killAll);   // never leave an orphaned ffmpeg (deep scan / export) behind
