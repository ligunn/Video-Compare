'use strict';
// End-to-end self-test: drives the REAL running app (real Chromium decode, real WebGL) through scenarios
// on synthetic fixtures, checks frame pairing by comparing the burned-in frame-number pixels of the two
// videos (independent of the app's own mapping logic), and writes screenshots to test/out/.
// Run: npm run selftest        Exit code 0 = every check passed.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'out');
const FX = n => path.join(ROOT, 'test', 'fixtures', n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** `electron . --selftest --launch-check a.mp4 b.mp4`: are files given on the command line opened automatically? */
async function launchCheck({ app, win, argv }) {
  const expected = argv.filter(a => !a.startsWith('--') && fs.existsSync(a)).map(a => path.basename(a));
  const ev = js => win.webContents.executeJavaScript(js, true);
  let names = [];
  for (let i = 0; i < 150; i++) {
    names = await ev('(window.__vc && window.__vc.state.clips.map(c => c.name)) || []').catch(() => []);
    if (names.length >= expected.length && (await ev('window.__vc.engine.clips.length')) === expected.length) break;
    await sleep(100);
  }
  const ok = expected.length > 0 && names.join() === expected.join();
  console.log(`${ok ? 'PASS' : 'FAIL'}  command-line files open automatically  — expected ${expected.length}, opened ${names.length}`);
  app.exit(ok ? 0 : 1);
}

/** Whole-app cost: CPU % and working set summed over every Electron process (browser, GPU, renderer, utility). */
async function sampleCost(app, ms = 3000) {
  app.getAppMetrics();                       // resets the CPU counters
  await sleep(ms);
  const m = app.getAppMetrics();
  const sum = f => m.reduce((t, p) => t + f(p), 0);
  return {
    cpuPct: +sum(p => p.cpu.percentCPUUsage).toFixed(1),
    memMB: Math.round(sum(p => p.memory.workingSetSize) / 1024),
    procs: m.length,
    byType: Object.fromEntries(m.map(p => [p.type + (p.name ? ':' + p.name : ''), `${p.cpu.percentCPUUsage.toFixed(1)}% ${Math.round(p.memory.workingSetSize / 1024)}MB`])),
  };
}

/** `electron . --selftest --measure`: resource use in each app state. Needs `npm run fixtures -- --uhd` first. */
async function measure({ app, win, argv }) {
  const ev = js => win.webContents.executeJavaScript(js, true);
  for (let i = 0; i < 100 && !(await ev('!!(window.__vc && window.__vc.comp)')); i++) await sleep(100);
  const rows = [];
  const take = async label => { const c = await sampleCost(app); rows.push({ label, ...c }); console.log(`${label.padEnd(44)} CPU ${String(c.cpuPct).padStart(5)}%   RAM ${String(c.memMB).padStart(5)} MB   ${JSON.stringify(c.byType)}`); };
  await sleep(1500);
  await take('empty (no videos)');
  await ev(`window.__vc.openFiles(${JSON.stringify(['uhd60.mp4', 'uhd5998.mp4'].map(FX))})`);
  await ev('window.__vc.engine.seekFrame(60)'); await sleep(500);
  await take('2x 4K10 loaded, paused');
  await ev('window.__vc.engine.play()'); await sleep(500);
  await take('2x 4K10 playing');
  await ev('window.__vc.engine.pause()'); await sleep(500);
  win.minimize(); await sleep(800);
  await take('2x 4K10 paused, window minimized');
  win.restore(); await sleep(500);
  if (await ev('typeof window.__vc.suspend === "function"')) {
    await ev('window.__vc.suspend()'); await sleep(1500);
    await take('SUSPENDED (1.5 s after)');
    await sleep(6000);
    await take('SUSPENDED (8 s after: is release just lazy?)');
    if (argv.includes('--experiment-reload')) {
      await win.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { test: '1' } });
      await sleep(2500);
      await take('SUSPENDED + page reloaded (whole document torn down)');
    } else {
      await ev('window.__vc.resume()'); await sleep(2500);
      await take('resumed, paused');
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(rows, null, 2));
  app.exit(0);
}

async function run({ app, win, testDir, argv, taskbar, router }) {
  if (argv.includes('--launch-check')) return launchCheck({ app, win, argv });
  if (argv.includes('--measure')) return measure({ app, win, argv });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const saveDir = testDir || path.join(OUT, 'exports');
  fs.mkdirSync(saveDir, { recursive: true });
  const results = [], consoleErrors = [];
  const t0 = Date.now();
  const watchdog = setTimeout(() => { console.error('SELFTEST TIMEOUT'); app.exit(2); }, 240000);

  win.webContents.on('console-message', (...a) => {
    const d = a[0] && typeof a[0].message === 'string' ? a[0] : { level: a[1], message: a[2] };
    const lvl = typeof d.level === 'number' ? d.level : ({ error: 3, warning: 2 }[d.level] || 0);
    if (lvl >= 3) consoleErrors.push(String(d.message).slice(0, 300));
  });

  const ev = js => win.webContents.executeJavaScript(js, true);
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
  // capturePage can return the previous compositor frame, so let the window settle first.
  const shot = async name => { await sleep(350); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); };
  const seek = k => ev(`window.__vc.engine.seekFrame(${k})`);
  const snap = () => ev('window.__vc.engine.snapshot()');
  const open = async files => ev(`window.__vc.openFiles(${JSON.stringify(files.map(FX))})`);
  const clear = () => ev('(async()=>{ while (window.__vc.state.clips.length) await window.__vc.removeClip(0); })()');

  try {
    // in-page helper: mean abs luma difference of the burned-in frame-number region between two clips
    await ev(`(() => {
      window.__rd = (i, j) => {
        const cs = window.__vc.engine.clips;
        const read = c => { const cv = document.createElement('canvas'); cv.width = c.w; cv.height = c.h; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(c.el, 0, 0);
          const rw = Math.floor(c.w * 0.25), rh = Math.floor(c.h * 0.25); return { d: g.getImageData(0, 0, rw, rh).data, rw, rh }; };
        const a = read(cs[i]), b = read(cs[j]); const N = 80, M = 30; let sum = 0;
        for (let x = 0; x < N; x++) for (let y = 0; y < M; y++) {
          const at = r => { const px = Math.floor((x + 0.5) / N * r.rw), py = Math.floor((y + 0.5) / M * r.rh); const o = (py * r.rw + px) * 4; return (r.d[o] + r.d[o + 1] + r.d[o + 2]) / 3; };
          sum += Math.abs(at(a) - at(b));
        }
        return sum / (N * M);
      };
      // mean of max(R,G,B) over the central picture area of the difference view (dense readback, same task as the draw)
      window.__diffMean = () => {
        const v = window.__vc; v.state.diffMode = 'abs'; v.state.gain = 8; v.render();
        const gl = v.comp.gl, W = gl.canvas.width, H = gl.canvas.height;
        const x0 = Math.floor(W * 0.3), y0 = Math.floor(H * 0.2), w = Math.floor(W * 0.4), h = Math.floor(H * 0.6);
        const px = new Uint8Array(w * h * 4); gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s = 0; for (let i = 0; i < px.length; i += 4) s += Math.max(px[i], px[i + 1], px[i + 2]);
        return s / (w * h);
      };
    })()`);

    // wait for the app to boot
    for (let i = 0; i < 100 && !(await ev('!!(window.__vc && window.__vc.comp)')); i++) await sleep(100);
    check('app boots with WebGL2 compositor', await ev('!!(window.__vc && window.__vc.comp)'));
    const tools = await ev('window.vc.tools()');
    check('ffprobe + ffmpeg (full build with an HEVC encoder) found', tools.ffprobe && tools.ffmpeg && (tools.hasHevcAmf || tools.hasLibx265) && !tools.vendor, tools.version);

    // ------------------------------------------------------------------ A. retime pair (59.98 vs 60), short clips
    await open(['ref60.mp4', 'retime5998.mp4']);
    let st = await ev('({ n: window.__vc.state.clips.length, plan: window.__vc.state.plan, banner: document.getElementById("banner").innerText })');
    check('two videos loaded', st.n === 2);
    check('plan: B is RETIMED to A', st.plan.videos[1].mode === 'retime' && Math.abs(st.plan.videos[1].slope - 60 / 59.98) < 1e-4, `slope ${st.plan.videos[1].slope}`);
    check('banner tells the user what was adjusted', /Retimed/.test(st.banner) && /59\.98/.test(st.banner), st.banner.split('\n')[0]);
    await seek(0);
    await shot('01-side-by-side-retime');

    let worst = 0, bestNudged = Infinity;
    for (const k of [0, 1, 100, 250, 359]) {
      await seek(k);
      const s = await snap();
      const d = await ev('window.__rd(0, 1)');
      worst = Math.max(worst, d);
      check(`retime frame ${k}: both videos show frame ${k}`, s.clips[0].idx === k && s.clips[1].idx === k, `A#${s.clips[0].idx} B#${s.clips[1].idx}, number-region diff ${d.toFixed(2)}`);
    }
    await ev('window.__vc.nudge(1)'); await seek(100);
    const nudged = await ev('window.__rd(0, 1)');
    await ev('window.__vc.nudge(-1)'); await seek(100);
    const aligned = await ev('window.__rd(0, 1)');
    check('pixel check can tell a 1-frame misalignment (negative control)', nudged > aligned * 3 && nudged > 3, `aligned ${aligned.toFixed(2)} vs nudged ${nudged.toFixed(2)}`);
    check('aligned pairs are pixel-consistent on the burned-in number', worst < 3, `worst ${worst.toFixed(2)}`);

    // ------------------------------------------------------------------ B. long pair: drift proves conforming
    await clear();
    await open(['long60.mp4', 'long5998.mp4']);
    st = await ev('({ plan: window.__vc.state.plan })');
    check('long pair: retime chosen', st.plan.videos[1].mode === 'retime');
    await seek(5000);
    let s = await snap(); let d = await ev('window.__rd(0, 1)');
    check('conform ON: frame 5000 pairs with frame 5000 (90 s in)', s.clips[1].idx === 5000, `B#${s.clips[1].idx}, diff ${d.toFixed(2)}`);
    const onDiff = d;
    await ev('(async()=>{ window.__vc.state.conform = false; await window.__vc.reconform(); })()');
    await seek(5000);
    s = await snap(); d = await ev('window.__rd(0, 1)');
    check('conform OFF: the same frame is mis-paired by ~2 frames (this is the bug conforming fixes)', s.clips[1].idx < 5000 && s.clips[1].idx >= 4996 && d > onDiff * 3, `B#${s.clips[1].idx}, diff ${d.toFixed(2)} vs ${onDiff.toFixed(2)}`);
    await ev('(async()=>{ window.__vc.state.conform = true; await window.__vc.reconform(); })()');
    await seek(5399);
    s = await snap(); d = await ev('window.__rd(0, 1)');
    check('conform back ON: last frame pairs exactly', s.clips[1].idx === 5399 && d < 3, `B#${s.clips[1].idx}, diff ${d.toFixed(2)}`);

    // ------------------------------------------------------------------ C. real-time playback stays in sync
    await seek(2000);
    const f0 = (await snap()).frame;
    await ev('window.__vc.engine.play()');
    const drifts = [];
    for (let i = 0; i < 12; i++) { await sleep(250); const p = await snap(); drifts.push(Math.abs(p.clips[1].idx - p.clips[1].wantIdx)); }
    const played = (await snap()).frame - f0;
    await ev('window.__vc.engine.pause()');
    await sleep(400);
    s = await snap(); d = await ev('window.__rd(0, 1)');
    check('playback advances at ~real time (3 s @ 60 fps ≈ 180 frames)', played > 140 && played < 220, `${played} frames`);
    check('during playback the pair stays within ±1 frame', Math.max(...drifts) <= 1, `max drift ${Math.max(...drifts)}f`);
    check('after pause the pair is snapped exact', s.clips[0].idx === s.clips[1].idx && d < 3, `A#${s.clips[0].idx} B#${s.clips[1].idx}, diff ${d.toFixed(2)}`);

    // ------------------------------------------------------------------ D. views on the short pair
    await clear();
    await open(['ref60.mp4', 'up1440.mp4']);
    await seek(100);
    await ev('window.__vc.setMode("wipe")'); await sleep(200); await shot('02-wipe');
    check('wipe mode draws a handle', (await ev('document.querySelectorAll(".handle").length')) === 1);
    await ev('window.__vc.setMode("flip")'); await sleep(200); await shot('03-flip-A');
    await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }))'); await sleep(200); await shot('04-flip-B');
    check('Tab flips to the other video', (await ev('window.__vc.state.flip')) === 1);
    await ev('window.__vc.setMode("diff")'); await sleep(300); await shot('05-difference');
    const upDiff = await ev('window.__diffMean()');
    check('difference view of original vs sharpened upscale is visibly non-zero', upDiff > 3, `mean ${upDiff.toFixed(2)}`);
    await ev('window.__vc.setMode("side")');
    await ev('(()=>{ document.getElementById("sel-filter").value = "nearest"; document.getElementById("sel-filter").dispatchEvent(new Event("change")); window.__vc.zoomOneToOne(); })()');
    await sleep(300); await shot('06-1to1-nearest');
    check('1:1 zoom reaches 100% of the largest video', /^100%$/.test(await ev('document.getElementById("zoomtext").textContent')), await ev('document.getElementById("zoomtext").textContent'));
    await ev('(()=>{ document.getElementById("sel-filter").value = "bicubic"; document.getElementById("sel-filter").dispatchEvent(new Event("change")); })()');
    await sleep(200); await shot('07-1to1-bicubic');
    await ev('window.__vc.zoomFit()');

    // difference sanity: identical-content pair must be much darker than the sharpened one
    // shader zero-point: the same file against itself must be exactly black
    await clear();
    await open(['ref60.mp4', 'ref60.mp4']);
    await seek(100); await ev('window.__vc.setMode("diff")'); await sleep(300);
    const selfDiff = await ev('window.__diffMean()');
    check('difference view of a file against itself is black (shader zero point)', selfDiff < 0.05, `mean ${selfDiff.toFixed(3)}`);
    await clear();
    await open(['ref60.mp4', 'retime5998.mp4']);
    await seek(100); await ev('window.__vc.setMode("diff")'); await sleep(300);
    const sameDiff = await ev('window.__diffMean()');
    // Compression noise between two encodes depends on the encoder (libx265 is noisier than AMD's), so this is a
    // ratio, not an absolute: the sharpened pair must be clearly brighter than the near-identical pair.
    check('two encodes of the same picture differ clearly less than original-vs-sharpened', sameDiff < upDiff * 0.75, `${sameDiff.toFixed(2)} vs ${upDiff.toFixed(2)}`);
    await ev('window.__vc.setMode("side")');

    // ------------------------------------------------------------------ E. resample pairing (dropped frames)
    await clear();
    await open(['ref60.mp4', 'dropped60.mp4']);
    st = await ev('({ plan: window.__vc.state.plan, banner: document.getElementById("banner").innerText })');
    check('dropped-frame file is RESAMPLED by timestamp', st.plan.videos[1].mode === 'resample');
    check('banner names the 5 missing frames', /5 frames missing/.test(st.banner));
    await seek(99); s = await snap(); let d99 = await ev('window.__rd(0, 1)');
    await seek(105); s = await snap(); const d105 = await ev('window.__rd(0, 1)');
    check('after the gap, frame 105 pairs with the frame that says 105 (not index 105)', s.clips[1].idx === 100 && d105 < 3, `B#${s.clips[1].idx}, diff ${d105.toFixed(2)}`);
    await seek(102); s = await snap();
    check('inside the gap the picture holds the last good frame', s.clips[1].idx === 99, `B#${s.clips[1].idx}`);
    await shot('08-resample-gap');
    check('scrubber marks the gap', (await ev('document.querySelectorAll(".mark").length')) === 1);

    // ------------------------------------------------------------------ F. health panel + deep scan
    await ev('(()=>{ window.__vc.state.health = true; window.__vc.refreshHealth(); })()');
    await sleep(200);
    const hp = await ev('document.getElementById("health").innerText');
    check('health panel reports the dropped frames', /5 frames missing/.test(hp) && /Timing gaps/.test(hp));
    await shot('09-health');
    await clear();
    await open(['ref60.mp4', 'frozen60.mp4']);
    await ev('window.__vc.deepScan(1)');
    for (let i = 0; i < 100 && (await ev('window.__vc.state.clips[1].deep')) !== 'done'; i++) await sleep(200);
    const rep = await ev('window.__vc.state.clips[1].health.find(r => r.id === "repeats")');
    check('deep scan finds the 4 frozen frames', rep && /4 \(/.test(rep.value) && rep.severity === 'bad', rep && rep.value);
    check('deep scan adds a scrubber mark', (await ev('document.querySelectorAll(".mark").length')) >= 1);
    await sleep(200); await shot('10-health-deepscan');

    // ------------------------------------------------------------------ G. exports
    await clear();
    await open(['ref60.mp4', 'retime5998.mp4']);
    await seek(100);
    await ev('window.__vc.exportFrames()');
    for (let i = 0; i < 50 && fs.readdirSync(saveDir).filter(f => f.endsWith('.png')).length < 3; i++) await sleep(100);
    const pngs = fs.readdirSync(saveDir).filter(f => f.endsWith('.png'));
    check('PNG export wrote both frames and the composite', pngs.length === 3 && pngs.some(f => f.startsWith('compare_')), pngs.join(', '));
    const dims = pngs.map(f => { const b = fs.readFileSync(path.join(saveDir, f)); return { f, sig: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: b.length }; });
    check('exported PNGs are real images at native video resolution', pngs.length === 3 && dims.every(d => d.sig === 'PNG' && d.size > 5000) &&
      dims.filter(d => !d.f.startsWith('compare_')).every(d => d.w === 1280 && d.h === 720), JSON.stringify(dims.map(d => `${d.w}x${d.h}`)));
    const conf = await ev('window.vc.exportConformed({ ids: window.__vc.state.clips.map(c => c.id), referenceIndex: 0, enabled: true, followerIndex: 1 })');
    check('conformed copy: lossless retime to 60 fps, 360 frames', conf.lossless && conf.frames === 360 && Math.abs(conf.rate - 60) < 0.005 && conf.regular, JSON.stringify({ frames: conf.frames, rate: conf.rate }));

    // ------------------------------------------------------------------ G2. mouse + keyboard
    await clear();
    await open(['ref60.mp4', 'up1440.mp4']);
    await seek(10);
    const key = (k, extra = {}) => ev(`window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ key: k, bubbles: true, ...extra })}))`);
    const settle = async () => { for (let i = 0; i < 50; i++) { await sleep(60); if (!(await ev('!!window.__vc.engine._draining'))) break; } await sleep(150); };
    await key('ArrowRight'); await settle();
    check('→ steps one frame', (await snap()).frame === 11);
    await key('ArrowRight', { shiftKey: true }); await settle();
    check('Shift+→ steps ten frames', (await snap()).frame === 21);
    await key('ArrowLeft'); await settle();
    check('← steps back one frame', (await snap()).frame === 20);
    await key('Home'); await settle();
    check('Home goes to the first frame', (await snap()).frame === 0);
    await key('End'); await settle();
    check('End goes to the last frame', (await snap()).frame === 359);
    await key('Home'); await settle();
    await key(' '); await sleep(700);
    check('Space starts playback', await ev('window.__vc.engine.playing'));
    await key(' '); await settle();
    check('Space pauses and snaps to an exact pair', !(await ev('window.__vc.engine.playing')) && (await snap()).clips.every(c => c.idx === c.wantIdx));
    await key('3'); await key('b'); await sleep(150);
    check('keys 3 then B select flip mode and video B', (await ev('window.__vc.state.mode + window.__vc.state.flip')) === 'flip1');
    await key('2'); await key('1'); await sleep(100);
    check('key 1 selects side by side', (await ev('window.__vc.state.mode')) === 'side');
    await key('m'); await sleep(100);
    check('M cycles audio to video A', (await ev('window.__vc.engine.audible')) === 0);
    await key('m'); await key('m'); await sleep(100);
    check('M cycles back to muted', (await ev('window.__vc.engine.audible')) === null);
    await ev('(() => { window.__vc.state.health = false; window.__vc.refreshHealth(); })()');
    await key('h'); await sleep(200);
    const opened = !(await ev('document.getElementById("health").hidden'));
    await key('h'); await sleep(200);
    check('H opens then closes the health panel', opened && (await ev('document.getElementById("health").hidden')));
    await key('[');  await settle();
    check('[ nudges the other video by one frame (manual trim fix)', (await snap()).clips[1].offsetFrames === -1);
    await key(']'); await settle();

    const mouse = `(() => { const c = document.getElementById("gl"), r = c.getBoundingClientRect();
      const P = (t, x, y, extra = {}) => c.dispatchEvent(new PointerEvent(t, { clientX: r.left + x * r.width, clientY: r.top + y * r.height, pointerId: 7, button: 0, bubbles: true, cancelable: true, ...extra }));
      window.__mouse = { P, r, wheel: (x, y, dy) => c.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + x * r.width, clientY: r.top + y * r.height, deltaY: dy, bubbles: true, cancelable: true })),
        dbl: (x, y) => c.dispatchEvent(new MouseEvent("dblclick", { clientX: r.left + x * r.width, clientY: r.top + y * r.height, bubbles: true })) }; })()`;
    await ev(mouse);
    await ev('window.__vc.setMode("wipe")'); await sleep(200);
    await ev('window.__mouse.P("pointerdown", 0.5, 0.5); window.__mouse.P("pointermove", 0.3, 0.5); window.__mouse.P("pointerup", 0.3, 0.5)');
    const b0 = await ev('window.__vc.state.bounds[0]');
    check('dragging the wipe handle moves it', Math.abs(b0 - 0.3) < 0.02, `bound ${b0.toFixed(3)}`);
    await ev('window.__vc.setMode("side")'); await sleep(200);
    await ev('window.__mouse.wheel(0.25, 0.5, -600)'); await sleep(150);
    const z1 = await ev('window.__vc.state.view.zoom');
    check('mouse wheel zooms in', z1 > 1.5, `zoom ${z1.toFixed(2)}`);
    const cx0 = await ev('window.__vc.state.view.cx');
    await ev('window.__mouse.P("pointerdown", 0.25, 0.5); window.__mouse.P("pointermove", 0.15, 0.5); window.__mouse.P("pointerup", 0.15, 0.5)');
    const cx1 = await ev('window.__vc.state.view.cx');
    check('dragging pans the picture (all panes move together)', cx1 > cx0, `cx ${cx0.toFixed(3)} -> ${cx1.toFixed(3)}`);
    await sleep(200); await shot('11-zoomed-panned');
    await key('0'); await sleep(100);
    check('0 returns to fit', (await ev('window.__vc.state.view.zoom')) === 1);
    await ev('window.__mouse.dbl(0.25, 0.5)'); await sleep(150);
    check('double-click jumps to 1:1', (await ev('document.getElementById("zoomtext").textContent')) === '100%');
    await ev('window.__mouse.dbl(0.25, 0.5)'); await sleep(100);
    check('double-click again returns to fit', (await ev('window.__vc.state.view.zoom')) === 1);

    // ------------------------------------------------------------------ G3. three videos (N-way)
    await clear();
    await open(['ref60.mp4', 'retime5998.mp4', 'up1440.mp4']);
    st = await ev('({ n: window.__vc.state.clips.length, modes: window.__vc.state.plan.videos.map(v => v.mode), panes: window.__vc.layout.panes.length })');
    check('three videos load; only the 59.98 one is conformed', st.n === 3 && st.modes.join() === 'none,retime,none' && st.panes === 3, st.modes.join());
    await seek(200);
    s = await snap();
    const dAB = await ev('window.__rd(0, 1)'), dAC = await ev('window.__rd(0, 2)');
    check('all three show frame 200 and the burned-in numbers agree', s.clips.every(c => c.idx === 200) && dAB < 3 && dAC < 8, `A-B ${dAB.toFixed(2)}, A-C ${dAC.toFixed(2)}`);
    await shot('12-three-way-side');
    await ev('window.__vc.setMode("wipe")'); await sleep(250);
    check('three-way wipe has two handles', (await ev('document.querySelectorAll(".handle").length')) === 2);
    await shot('13-three-way-wipe');
    await ev('window.__vc.setMode("diff")'); await sleep(250);
    check('difference picker lists the other two videos', (await ev('document.getElementById("sel-diff").options.length')) === 2);
    await ev('window.__vc.setMode("flip")');
    for (const i of [1, 2, 0]) { await key('Tab'); await sleep(80); }
    check('Tab cycles A→B→C→A in flip mode', (await ev('window.__vc.state.flip')) === 0);
    await ev('window.__vc.setMode("side")');
    await ev('window.__vc.removeClip(1)'); await sleep(600);
    st = await ev('({ n: window.__vc.state.clips.length, modes: window.__vc.state.plan.videos.map(v => v.mode) })');
    check('removing a video re-plans the rest', st.n === 2 && st.modes.join() === 'none,none', st.modes.join());

    // ------------------------------------------------------------------ G4. suspend / resume + taskbar commands
    await clear();
    await open(['ref60.mp4', 'retime5998.mp4']);
    await ev('window.__vc.setMode("wipe")');
    await ev('window.__vc.state.bounds = [0.35]; window.__vc.engine.setAudible(1)');
    await ev(mouse); await sleep(100);
    await ev('window.__mouse.wheel(0.5, 0.5, -500)'); await sleep(150);
    await seek(100);
    await ev('window.__vc.nudge(1)'); await settle();          // manual +1 frame on B (activeFollower in wipe mode = B)
    const before = await ev('({ mode: window.__vc.state.mode, bound: window.__vc.state.bounds[0], view: { ...window.__vc.state.view }, frame: window.__vc.engine.frame, audible: window.__vc.engine.audible, off: window.__vc.engine.clips[1].offsetFrames })');
    check('pre-suspend state set up (wipe, zoomed, audio B, offset +1, frame 100)', before.mode === 'wipe' && before.view.zoom > 1.5 && before.audible === 1 && before.off === 1 && before.frame === 100, JSON.stringify(before));
    await sleep(300);
    check('taskbar: thumbnail buttons installed (Prev / Play / Next / Suspend)', taskbar.status.thumbnail === true && taskbar.status.buttons.length === 4 && taskbar.status.buttons[1] === 'Play', taskbar.status.buttons.join(' | '));
    check('taskbar: jump-list tasks installed', taskbar.status.tasks === true);

    check('router delivers "toggle-play" to the page', router.run('toggle-play') === true);
    await sleep(700);
    check('  ... and playback starts', await ev('window.__vc.engine.playing'));
    await sleep(200);
    check('  ... and the taskbar button flips to Pause', taskbar.status.buttons[1] === 'Pause', taskbar.status.buttons[1]);
    router.run('toggle-play'); await sleep(900);
    check('  ... toggling again pauses', !(await ev('window.__vc.engine.playing')));
    const paused100 = (await snap()).frame;

    router.run('suspend');
    for (let i = 0; i < 50 && !(await ev('!!window.__vc.state.suspended')); i++) await sleep(100);
    await sleep(500);
    check('suspend: every <video> element is gone (decoders released)', (await ev('document.querySelectorAll("video").length')) === 0);
    check('suspend: engine holds no clips, WebGL context released', (await ev('window.__vc.engine.clips.length')) === 0 && (await ev('window.__vc.comp.lost === true')));
    check('suspend: overlay shown, title says suspended, button reads Resume', (await ev('!document.getElementById("suspended").hidden && document.title === "Video Compare (suspended)" && document.getElementById("btn-suspend").textContent === "Resume"')));
    check('suspend: place is remembered in memory', await ev(`window.__vc.state.suspended.frame === ${paused100}`), `frame ${paused100}`);
    check('suspend: taskbar buttons reflect it (Resume enabled, transport disabled)', /^Resume/.test(taskbar.status.buttons[3]) && /disabled/.test(taskbar.status.buttons[1]) && !/disabled/.test(taskbar.status.buttons[3]), taskbar.status.buttons.join(' | '));
    await key(' '); await sleep(200);
    check('suspend: keys other than S are ignored', !(await ev('window.__vc.engine.playing')) && (await ev('window.__vc.engine.clips.length')) === 0);
    await shot('14-suspended');

    router.run('toggle-suspend');
    for (let i = 0; i < 100 && (await ev('!!window.__vc.state.suspended')); i++) await sleep(100);
    await sleep(800);
    const after = await ev('({ mode: window.__vc.state.mode, bound: window.__vc.state.bounds[0], view: { ...window.__vc.state.view }, frame: window.__vc.engine.frame, audible: window.__vc.engine.audible, off: window.__vc.engine.clips.length ? window.__vc.engine.clips[1].offsetFrames : null, n: window.__vc.engine.clips.length, muted: window.__vc.engine.clips.map(c => c.el.muted) })');
    check('resume: both videos reloaded', after.n === 2);
    check('resume: view mode, divider position and zoom/pan are exactly as left', after.mode === before.mode && after.bound === before.bound && after.view.zoom === before.view.zoom && after.view.cx === before.view.cx && after.view.cy === before.view.cy, JSON.stringify(after.view));
    check('resume: same frame, audio on B, manual offset kept', after.frame === paused100 && after.audible === 1 && after.off === 1 && after.muted.join() === 'true,false', `frame ${after.frame}, offset ${after.off}, muted ${after.muted}`);
    s = await snap();
    check('resume: the pair is exact again (B is shown one frame ahead by the manual offset)', s.clips[0].idx === paused100 && s.clips[1].idx === paused100 + 1 && s.clips[1].idx === s.clips[1].wantIdx, `A#${s.clips[0].idx} B#${s.clips[1].idx}`);
    const paint = await ev('(() => { const v = window.__vc; v.render(); const p = v.layout; const r = p.panes[0]; const px = v.comp.readPixel(r.x + r.w * 0.3, r.y + r.h * 0.5); return px[0] + px[1] + px[2]; })()');
    check('resume: WebGL context is back and painting real pixels', paint > 40, `pixel sum ${paint}`);
    check('resume: overlay gone, button reads Suspend, title restored', await ev('document.getElementById("suspended").hidden && document.title === "Video Compare" && document.getElementById("btn-suspend").textContent === "Suspend"'));
    const f1 = (await snap()).frame;
    await key(' '); await sleep(1200); await key(' '); await settle();
    check('resume: playback works again', (await snap()).frame > f1 + 30, `${f1} -> ${(await snap()).frame}`);
    await sleep(300);
    check('resume: taskbar buttons re-enabled', taskbar.status.buttons.every(b => !/disabled/.test(b)), taskbar.status.buttons.join(' | '));

    // S toggles, and adding a video while suspended wakes the app instead of leaving it half-alive
    await key('s'); await sleep(900);
    check('S key suspends', await ev('!!window.__vc.state.suspended'));
    await open(['ref60.mp4', 'retime5998.mp4', 'up1440.mp4']);
    st = await ev('({ asleep: !!window.__vc.state.suspended, n: window.__vc.state.clips.length, live: window.__vc.engine.clips.length })');
    check('opening files while suspended wakes the app and loads them', !st.asleep && st.live === st.n && st.n === 5, JSON.stringify(st));
    await ev('window.__vc.suspend()'); await sleep(600);
    await ev('window.__vc.removeClip(0)'); await sleep(800);
    check('removing a video while suspended also wakes it', await ev('!window.__vc.state.suspended && window.__vc.engine.clips.length === 4'));
    await ev('window.__vc.suspend()'); await sleep(600);
    await ev('window.__vc.resume()'); await sleep(1200);
    check('suspend/resume with 4 videos loaded restores all of them', await ev('!window.__vc.state.suspended && window.__vc.engine.clips.length === 4'));
    await ev('window.__vc.suspend()'); await sleep(500);
    check('the app can still be resumed by clicking Resume', await ev('(async () => { document.getElementById("btn-resume").click(); await new Promise(r => setTimeout(r, 1500)); return !window.__vc.state.suspended && window.__vc.engine.clips.length === 4; })()'));

    // ------------------------------------------------------------------ H. audio + codec matrix
    await clear();
    await open(['ref60.mp4', 'h264bframes60.mkv']);
    await ev('window.__vc.engine.setAudible(1)');
    check('audio can be switched to the second video', (await ev('window.__vc.engine.clips.map(c => c.el.muted)')).join() === 'true,false');
    await ev('window.__vc.engine.setAudible(null)');
    st = await ev('({ n: window.__vc.state.clips.length, modes: window.__vc.state.plan.videos.map(v => v.mode) })');
    check('HEVC MP4 vs H.264 MKV(B-frames) load together with no adjustment needed', st.n === 2 && st.modes.join() === 'none,none', st.modes.join());
    await clear();
    await open(['hev1tag60.mp4', 'ref60.mp4']);
    check('hev1-tagged HEVC decodes', (await ev('window.__vc.state.clips.length')) === 2);
    await seek(50);
    check('hev1 clip paints real pixels', (await ev('(() => { const v = window.__vc; v.render(); const p = v.comp.readPixel(v.layout.panes[0].x + v.layout.panes[0].w / 2, v.layout.panes[0].y + v.layout.panes[0].h / 2); return p[0] + p[1] + p[2]; })()')) > 30);
    await clear();
    check('removing all videos returns to the empty state', await ev('!document.getElementById("empty").hidden'));

    check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('self-test ran to completion', false, e && e.stack || e);
  }

  clearTimeout(watchdog);
  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(OUT, 'selftest.json'), JSON.stringify({ seconds: (Date.now() - t0) / 1000, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  console.log(`\nSELFTEST ${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length}/${results.length} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  app.exit(failed.length ? 1 : 0);
}

module.exports = { run };
