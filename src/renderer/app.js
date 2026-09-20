import { Compositor } from './gl.js';
import { Engine, indexAt } from './engine.js';
import * as V from './view.js';
import { renderHealth } from './health.js';

const vc = window.vc;
const $ = id => document.getElementById(id);
const stage = $('stage'), canvas = $('gl'), overlay = $('overlay');
const letter = i => String.fromCharCode(65 + i);
const cleanErr = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const stem = n => n.replace(/\.[^.]+$/, '').replace(/[^\w.\- ()]+/g, '_');
const fmtTime = t => { const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
const fmtFps = x => `${+x.toFixed(3)} fps`;

const state = {
  clips: [],                 // analysis payloads from the main process (+ deep-scan state)
  plan: null, conform: true, refPref: null,
  mode: 'side', filter: 'bilinear',
  view: { zoom: 1, cx: 0.5, cy: 0.5 },
  bounds: [0.5], flip: 0, diffIdx: 1, gain: 4, diffMode: 'heat',
  health: false, dirty: true,
  suspended: null,           // {frame, audible, offsets} while decoders + GPU context are released
};
const engine = new Engine();
let comp = null;
let loopRunning = false;
let layout = { panes: [], passes: [], W: 1, H: 1, cw: 1, ch: 1, dpr: 1 };
let busyDepth = 0;

// ---------------------------------------------------------------------------------------------- UI helpers
function busy(text) {
  busyDepth = text ? busyDepth + 1 : Math.max(0, busyDepth - 1);
  $('busy').hidden = busyDepth === 0 && !text;
  if (text) $('busy-text').textContent = text;
}
function busyText(text) { $('busy-text').textContent = text; }
let toastTimer = 0;
function toast(msg, { err = false, action = null, ms = 6000 } = {}) {
  const t = $('toast');
  t.replaceChildren(document.createTextNode(msg));
  if (action) { const a = document.createElement('a'); a.textContent = action.label; a.addEventListener('click', action.run); t.append(a); }
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? Math.max(ms, 10000) : ms);
}
const markDirty = () => { state.dirty = true; };

// ---------------------------------------------------------------------------------------------- loading
async function openFiles(paths) {
  if (!paths || !paths.length) return;
  busy(`Analyzing ${paths.length} file${paths.length > 1 ? 's' : ''}…`);
  try {
    const results = await Promise.allSettled(paths.map(p => vc.analyze(p)));
    for (const r of results) {
      if (r.status === 'fulfilled') state.clips.push({ ...r.value, deep: undefined, deepPct: 0 });
      else toast(cleanErr(r.reason), { err: true });
    }
    await rebuild();
  } finally { busy(null); }
}

async function removeClip(i) {
  const [gone] = state.clips.splice(i, 1);
  if (gone) vc.release(gone.id);
  state.refPref = null;
  await rebuild();
}

async function replan() {
  state.plan = await vc.plan({ ids: state.clips.map(c => c.id), referenceIndex: state.refPref, enabled: state.conform });
}

/** (Re)create the playback engine for the current set of clips. */
async function rebuild() {
  if (state.suspended) { state.suspended = null; await comp.reacquire(); startLoop(); } // adding/removing a video wakes the app
  if (!state.clips.length) {
    engine.dispose(); state.plan = null;
    comp.ensure(0); refreshAll(); markDirty(); return;
  }
  await replan();
  try {
    await engine.load(state.clips);
  } catch (e) {
    const bad = e.clipId && state.clips.find(c => c.id === e.clipId);
    const hevcHint = bad && bad.info.video.codec === 'hevc'
      ? ' H.265 needs hardware HEVC decoding: update your graphics driver, or install "HEVC Video Extensions" from the Microsoft Store. H.264 files are not affected.' : '';
    toast(cleanErr(e) + hevcHint, { err: true });
    if (e.clipId) { // drop only the clip that failed to decode and carry on with the rest
      const i = state.clips.findIndex(c => c.id === e.clipId);
      if (i >= 0) { const [gone] = state.clips.splice(i, 1); vc.release(gone.id); return rebuild(); }
    }
    return;
  }
  engine.applyPlan(state.plan);
  engine.setAudible(engine.audible != null && state.clips[engine.audible] && state.clips[engine.audible].info.audio ? engine.audible : null); // new elements start muted
  comp.ensure(state.clips.length);
  state.bounds = V.defaultBounds(state.clips.length);
  state.flip = clamp(state.flip, 0, state.clips.length - 1);
  state.diffIdx = state.diffIdx === state.plan.referenceIndex || state.diffIdx >= state.clips.length ? (state.plan.referenceIndex === 0 ? 1 : 0) : state.diffIdx;
  if (state.clips.length < 2 && state.mode !== 'side' && state.mode !== 'flip') state.mode = 'side';
  refreshAll();
  await engine.seekFrame(0);
  markDirty();
}

/** Conform settings changed: re-plan without reloading the videos. */
async function reconform() {
  await replan();
  engine.applyPlan(state.plan);
  refreshAll();
  await engine.seekFrame(engine.frame);
  markDirty();
}

// ---------------------------------------------------------------------------------------------- layout & drawing
const contentDims = () => V.contentSize(engine.clips.map(c => ({ w: c.w, h: c.h })));

function computeLayout(cw, ch, dpr) {
  const n = engine.clips.length;
  const { W, H } = contentDims();
  const out = { panes: [], passes: [], W, H, cw, ch, dpr };
  if (!n || !W) return out;
  const vids = engine.clips.map(c => ({ w: c.w, h: c.h }));
  const { zoom, cx, cy } = state.view;
  // While a video is being added/removed, state (dividers, flip/diff picks, reference) lags the engine by a moment.
  // Derive every index from the CURRENT clip count so a stale one can never point past the end.
  const bounds = state.bounds.length === n - 1 ? state.bounds : V.defaultBounds(n);
  const flip = Math.min(state.flip, n - 1);
  const ref = Math.min(engine.ref, n - 1);
  const other = state.diffIdx < n && state.diffIdx !== ref ? state.diffIdx : (ref === 0 ? Math.min(1, n - 1) : 0);
  Object.assign(out, { bounds, flip, ref, other });
  const single = (i, rect, pane) => ({
    kind: 'single', rect, pane, tex: [i], center: [cx, cy], invScale: V.invScale(pane, W, H, zoom),
    filter: state.filter, minify: [V.minifying(vids[i].w, W, V.scaleOf(pane, W, H, zoom))],
  });
  const whole = { x: 0, y: 0, w: cw, h: ch };
  let mode = state.mode;
  if (n < 2 && (mode === 'wipe' || mode === 'diff')) mode = 'side';
  if (mode === 'side') {
    out.panes = V.gridPanes(n, cw, ch, Math.round(4 * dpr));
    out.passes = out.panes.map((p, i) => single(i, p, p));
  } else if (mode === 'wipe') {
    out.panes = [whole];
    out.strips = V.wipeStrips(bounds, cw);
    out.passes = out.strips.map((s, i) => single(i, { x: s.x0, y: 0, w: s.x1 - s.x0, h: ch }, whole));
  } else if (mode === 'flip') {
    out.panes = [whole];
    out.passes = [single(flip, whole, whole)];
  } else {
    out.panes = [whole];
    const a = ref, b = other;
    const s = V.scaleOf(whole, W, H, zoom);
    out.passes = [{
      kind: 'diff', rect: whole, pane: whole, tex: [a, b], center: [cx, cy], invScale: V.invScale(whole, W, H, zoom), filter: state.filter,
      minify: [V.minifying(vids[a].w, W, s), V.minifying(vids[b].w, W, s)], gain: state.gain, diffMode: state.diffMode,
    }];
  }
  out.mode = mode;
  return out;
}

/** Recompute the layout for the stage's current size (also used by overlay/hit-testing so they never go stale). */
function currentLayout() {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(stage.clientWidth * dpr)), ch = Math.max(1, Math.round(stage.clientHeight * dpr));
  return computeLayout(cw, ch, dpr);
}

function render() {
  if (!comp) return;
  const prev = layout;
  layout = currentLayout();
  comp.resize(layout.cw, layout.ch);
  comp.draw(layout.passes);
  if (prev.cw !== layout.cw || prev.ch !== layout.ch || prev.mode !== layout.mode) updateOverlay();
  updateZoomText();
}

function startLoop() { if (!loopRunning) { loopRunning = true; requestAnimationFrame(frameLoop); } }

function frameLoop() {
  if (state.suspended) { loopRunning = false; return; } // no per-frame wake-ups while suspended
  requestAnimationFrame(frameLoop);
  let dirty = state.dirty;
  for (const c of engine.clips) {
    if (c.dirty) { if (comp.upload(c.i, c.el)) dirty = true; c.dirty = false; }
  }
  if (dirty) { state.dirty = false; render(); }
}

function paneAt(x, y) {
  return layout.panes.find(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) || layout.panes[0] || { x: 0, y: 0, w: layout.cw, h: layout.ch };
}

function updateZoomText() {
  if (!layout.W) { $('zoomtext').textContent = ''; return; }
  const pane = layout.panes[0] || { x: 0, y: 0, w: layout.cw, h: layout.ch };
  $('zoomtext').textContent = `${Math.round(V.scaleOf(pane, layout.W, layout.H, state.view.zoom) * 100)}%`;
}

// ---------------------------------------------------------------------------------------------- overlay (labels, wipe handles)
function makeLabel(i, x, y, maxW) {
  const c = state.clips[i], entry = state.plan && state.plan.videos[i];
  const d = document.createElement('div');
  d.className = 'label';
  d.style.left = `${x + 8}px`; d.style.top = `${y + 8}px`;
  if (maxW) d.style.maxWidth = `${Math.max(120, maxW - 16)}px`;
  const b = document.createElement('span'); b.className = 'badge'; b.textContent = letter(i); b.style.background = `var(--c${i % 6})`;
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name;
  const meta = document.createElement('span'); meta.className = 'meta';
  meta.textContent = `${c.info.video.width}×${c.info.video.height} · ${fmtFps(c.rate)}`;
  d.append(b, nm, meta);
  if (entry && entry.adjusted) {
    const adj = document.createElement('span'); adj.className = 'meta warn';
    adj.textContent = entry.mode === 'retime' ? `retimed ${entry.slope > 1 ? '+' : ''}${((entry.slope - 1) * 100).toFixed(3)}%` : 'resampled';
    d.append(adj);
  }
  return d;
}

function updateOverlay() {
  overlay.replaceChildren();
  layout = currentLayout();
  if (!state.clips.length || !layout.W || engine.clips.length !== state.clips.length) return; // mid-rebuild: refreshAll() redraws when they agree
  const dpr = layout.dpr, mode = layout.mode;
  if (mode === 'side') layout.panes.forEach((p, i) => overlay.append(makeLabel(i, p.x / dpr, p.y / dpr, p.w / dpr)));
  else if (mode === 'wipe') {
    layout.strips.forEach((s, i) => overlay.append(makeLabel(i, s.x0 / dpr, 0, (s.x1 - s.x0) / dpr)));
    layout.bounds.forEach(b => { const h = document.createElement('div'); h.className = 'handle'; h.style.left = `${(b * layout.cw) / dpr}px`; overlay.append(h); });
  } else if (mode === 'flip') {
    overlay.append(makeLabel(layout.flip, 0, 0, layout.cw / dpr));
  } else {
    const d = makeLabel(layout.other, 0, 0, layout.cw / dpr);
    const nm = d.querySelector('.nm'); nm.textContent = `Difference: ${letter(layout.ref)} vs ${letter(layout.other)}`;
    overlay.append(d);
  }
}

// ---------------------------------------------------------------------------------------------- top bar / banner / panels
function refreshAll() {
  const has = state.clips.length > 0;
  $('empty').hidden = has;
  renderSlots(); renderBanner(); renderAudioSelect(); renderDiffSelect(); refreshHealth(); renderScrubMarks();
  document.querySelectorAll('#modes button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
    b.disabled = state.clips.length < 2 && (b.dataset.mode === 'wipe' || b.dataset.mode === 'diff');
  });
  $('diffbar').hidden = !(state.mode === 'diff' && state.clips.length > 1);
  $('exp-conform').disabled = !(state.plan && state.plan.videos.some(v => v.adjusted));
  const asleep = !!state.suspended;
  $('suspended').hidden = !asleep;
  $('btn-suspend').textContent = asleep ? 'Resume' : 'Suspend';
  $('btn-suspend').disabled = !has;
  $('btn-suspend').classList.toggle('on', asleep);
  document.querySelectorAll('#transport button, #modes button').forEach(b => { if (asleep) b.disabled = true; else if (b.dataset.mode == null) b.disabled = false; });
  document.title = asleep ? 'Video Compare (suspended)' : 'Video Compare';
  updateOverlay();
  updateTransport();
  notifyState();
}

/** Tell the main process what the taskbar buttons should show. */
function notifyState() { vc.state({ hasVideos: state.clips.length > 0, playing: engine.playing, suspended: !!state.suspended }); }

// ---------------------------------------------------------------------------------------------- suspend / resume
/** Pause, drop every <video> (their hardware decoders) and the WebGL context. Files, plan, position and view are kept in memory only. */
async function suspend() {
  if (state.suspended || !state.clips.length || !comp) return;
  busy('Suspending…');
  try {
    await engine.pause();
    state.suspended = { frame: engine.frame, audible: engine.audible, offsets: engine.clips.map(c => c.offsetFrames) };
    engine.dispose();
    await comp.release();
    refreshAll();
  } finally { busy(null); }
}

async function resume() {
  const s = state.suspended;
  if (!s) return;
  busy('Resuming…');
  try {
    await comp.reacquire();
    await engine.load(state.clips);
    engine.applyPlan(state.plan);
    engine.clips.forEach((c, i) => { c.offsetFrames = s.offsets[i] || 0; c.offset = c.offsetFrames * c.dt; });
    engine.setAudible(s.audible);
    comp.ensure(state.clips.length);
    state.suspended = null;
    startLoop();
    refreshAll();
    await engine.seekFrame(s.frame);
    markDirty();
  } catch (e) {
    engine.dispose();
    toast(`Could not resume: ${cleanErr(e)}`, { err: true });
    refreshAll();
  } finally { busy(null); }
}
const toggleSuspend = () => (state.suspended ? resume() : suspend());

function renderSlots() {
  const box = $('slots'); box.replaceChildren();
  state.clips.forEach((c, i) => {
    const entry = state.plan && state.plan.videos[i];
    const s = document.createElement('div'); s.className = 'slot'; s.title = c.path;
    const b = document.createElement('span'); b.className = 'badge'; b.textContent = letter(i); b.style.background = `var(--c${i % 6})`;
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = c.name;
    s.append(b, nm);
    if (entry) {
      const tag = document.createElement('span');
      tag.className = 'tag ' + (entry.adjusted ? 'adj' : entry.role === 'reference' && state.clips.length > 1 ? 'ref' : '');
      tag.textContent = entry.adjusted ? (entry.mode === 'retime' ? 'retimed' : 'resampled') : entry.role === 'reference' && state.clips.length > 1 ? 'reference' : '';
      if (tag.textContent) s.append(tag);
    }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.title = 'Remove'; x.addEventListener('click', () => removeClip(i));
    s.append(x);
    box.append(s);
  });
}

function renderBanner() {
  const b = $('banner'); b.replaceChildren();
  if (!state.clips.length || !state.plan) { b.hidden = true; return; }
  const note = (sev, text) => { const n = document.createElement('div'); n.className = 'note ' + sev; const d = document.createElement('span'); d.className = 'dot'; n.append(d, document.createTextNode(text)); return n; };
  const lines = [];
  state.plan.videos.forEach(v => { if (v.adjusted) v.reasons.forEach(r => lines.push([v.severity, r])); });
  state.plan.videos.forEach(v => { if (!v.adjusted) v.reasons.forEach(r => lines.push([v.severity, r])); });
  state.plan.notices.forEach(n => lines.push([n.severity, n.text]));
  const many = state.clips.length > 1;
  if (many && !lines.length) lines.push(['ok', `Frame rates match (${fmtFps(state.clips[state.plan.referenceIndex].rate)}) and the files line up frame for frame: no conforming needed.`]);
  if (!many) lines.push(['info', 'Add a second video to start comparing.']);
  lines.forEach(([sev, text]) => b.append(note(sev, text)));
  if (many) {
    const ctl = note('info', ''); ctl.className = 'note';
    ctl.replaceChildren();
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = state.conform; cb.id = 'chk-conform';
    cb.addEventListener('change', () => { state.conform = cb.checked; reconform(); });
    const lab = document.createElement('label'); lab.htmlFor = 'chk-conform'; lab.append(cb, document.createTextNode(' Auto-conform frame rate / timing'));
    const refSel = document.createElement('select'); refSel.id = 'sel-ref'; refSel.title = 'The video whose timeline the others are lined up to';
    state.clips.forEach((c, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${letter(i)} · ${c.name}`; refSel.append(o); });
    refSel.value = String(state.plan.referenceIndex);
    refSel.addEventListener('change', () => { state.refPref = Number(refSel.value); reconform(); });
    const rl = document.createElement('label'); rl.append('Reference ', refSel);
    ctl.append(lab, rl);
    ctl.style.gap = '18px';
    b.append(ctl);
  }
  b.hidden = false;
}

function renderAudioSelect() {
  const sel = $('sel-audio'); sel.replaceChildren();
  const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); };
  opt('', 'Muted');
  state.clips.forEach((c, i) => { if (c.info.audio) opt(String(i), `${letter(i)} · ${c.name}`); });
  sel.value = engine.audible == null ? '' : String(engine.audible);
  if (sel.value !== (engine.audible == null ? '' : String(engine.audible))) { sel.value = ''; engine.setAudible(null); }
}

function renderDiffSelect() {
  const sel = $('sel-diff'); sel.replaceChildren();
  state.clips.forEach((c, i) => {
    if (i === engine.ref) return;
    const o = document.createElement('option'); o.value = String(i); o.textContent = `${letter(engine.ref)} vs ${letter(i)} · ${c.name}`; sel.append(o);
  });
  sel.value = String(state.diffIdx);
}

function refreshHealth() {
  $('health').hidden = !state.health;
  $('btn-health').classList.toggle('on', state.health);
  if (state.health) renderHealth($('health'), { clips: state.clips, onDeepScan: deepScan, onDeepScanAll: () => state.clips.forEach((_, i) => deepScan(i)) });
  markDirty();
}

function setMode(m) {
  if (state.clips.length < 2 && (m === 'wipe' || m === 'diff')) return;
  state.mode = m;
  if (m === 'diff' && (state.diffIdx === engine.ref || state.diffIdx >= state.clips.length)) state.diffIdx = engine.ref === 0 ? 1 : 0;
  refreshAll(); markDirty();
}

// ---------------------------------------------------------------------------------------------- transport
function updateTransport(s = engine.snapshot()) {
  if (state.suspended) return; // keep showing where you were
  const ref = engine.refClip;
  if (!ref) { $('timecode').textContent = '0:00.000'; $('framecount').textContent = '0 / 0'; $('syncstat').textContent = ''; $('scrub-thumb').style.left = '0%'; $('scrub-fill').style.width = '0%'; return; }
  $('timecode').textContent = fmtTime(s.T - ref.first);
  $('framecount').textContent = `${s.frame + 1} / ${s.frameCount}`;
  const frac = s.frameCount > 1 ? s.frame / (s.frameCount - 1) : 0;
  $('scrub-thumb').style.left = `${frac * 100}%`; $('scrub-fill').style.width = `${frac * 100}%`;
  $('t-play').textContent = s.playing ? '❚❚' : '▶';
  const off = s.clips.filter(c => c.i !== engine.ref && Math.abs(c.idx - c.wantIdx) > (s.playing ? 1 : 0));
  const st = $('syncstat');
  if (state.clips.length < 2) st.textContent = '';
  else if (off.length) { st.textContent = off.map(c => `${letter(c.i)} ${c.idx - c.wantIdx > 0 ? '+' : ''}${c.idx - c.wantIdx}f`).join('  ') + ' off'; st.className = 'mono bad'; }
  else { st.textContent = s.playing ? 'in sync (±1f)' : 'pair locked'; st.className = 'mono'; }
}

function renderScrubMarks() {
  const box = $('scrub-marks'); box.replaceChildren();
  const ref = engine.refClip;
  if (!ref || ref.last <= ref.first) return;
  const span = ref.last - ref.first;
  state.clips.forEach((c, i) => {
    const ec = engine.clips[i];
    if (!ec) return;
    for (const m of c.markers.slice(0, 400)) {
      const T = ref.first + (m.t - ec.first - ec.offset) / ec.slope;
      const f = (T - ref.first) / span;
      if (f < 0 || f > 1) continue;
      const d = document.createElement('div'); d.className = 'mark'; d.style.left = `${f * 100}%`; d.style.background = `var(--c${i % 6})`; d.title = `${letter(i)}: ${m.label}`;
      box.append(d);
    }
  });
}

engine.addEventListener('frame', e => { updateTransport(e.detail); markDirty(); });
engine.addEventListener('playstate', () => { updateTransport(); notifyState(); });

const scrub = $('scrub');
function scrubTo(e) {
  const r = scrub.getBoundingClientRect();
  const f = clamp((e.clientX - r.left) / r.width, 0, 1);
  engine.seekFrame(f * Math.max(0, engine.frameCount - 1));
}
scrub.addEventListener('pointerdown', async e => {
  if (!engine.clips.length) return;
  scrub.setPointerCapture(e.pointerId);
  if (engine.playing) await engine.pause();
  scrubTo(e);
  const move = ev => scrubTo(ev);
  const up = () => { scrub.removeEventListener('pointermove', move); scrub.removeEventListener('pointerup', up); };
  scrub.addEventListener('pointermove', move); scrub.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------------------------------------- pointer interaction
let drag = null;
const devPos = e => { const r = canvas.getBoundingClientRect(); const k = canvas.width / r.width; return [(e.clientX - r.left) * k, (e.clientY - r.top) * k, k]; };

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !engine.clips.length) return;
  const [x, y, k] = devPos(e);
  if (layout.mode === 'wipe') {
    let i = V.nearestBoundary(state.bounds, x, layout.cw, 14 * k);
    if (i < 0 && state.view.zoom <= 1) i = V.nearestBoundary(state.bounds, x, layout.cw, Infinity);
    if (i >= 0) { drag = { type: 'wipe', idx: i }; capture(e); moveWipe(x); return; }
  }
  if (state.view.zoom > 1) { drag = { type: 'pan', last: [x, y], rect: paneAt(x, y) }; capture(e); stage.classList.add('dragging'); }
});
const capture = e => { try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone: the drag still works without capture */ } };
canvas.addEventListener('pointermove', e => {
  const [x, y, k] = devPos(e);
  if (drag && drag.type === 'wipe') { moveWipe(x); return; }
  if (drag && drag.type === 'pan') {
    state.view = V.panBy(state.view, x - drag.last[0], y - drag.last[1], drag.rect, layout.W, layout.H);
    drag.last = [x, y]; markDirty(); return;
  }
  stage.classList.toggle('resize', layout.mode === 'wipe' && V.nearestBoundary(state.bounds, x, layout.cw, 14 * k) >= 0);
  stage.classList.toggle('grab', state.view.zoom > 1);
});
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

function moveWipe(x) {
  state.bounds = V.moveBoundary(state.bounds, drag.idx, x / layout.cw);
  updateOverlay(); markDirty();
}

canvas.addEventListener('wheel', e => {
  if (!engine.clips.length) return;
  e.preventDefault();
  const [x, y] = devPos(e);
  const f = Math.exp(-e.deltaY * 0.0015 * (e.ctrlKey ? 4 : 1));
  state.view = V.zoomAt(state.view, paneAt(x, y), x, y, f, layout.W, layout.H);
  markDirty();
}, { passive: false });

canvas.addEventListener('dblclick', e => {
  if (!engine.clips.length) return;
  const [x, y] = devPos(e);
  const pane = paneAt(x, y);
  if (state.view.zoom > 1.05) state.view = { zoom: 1, cx: 0.5, cy: 0.5 };
  else state.view = V.zoomAt(state.view, pane, x, y, V.oneToOneZoom(pane, layout.W, layout.H) / state.view.zoom, layout.W, layout.H);
  markDirty();
});

function zoomFit() { state.view = { zoom: 1, cx: 0.5, cy: 0.5 }; markDirty(); }
function zoomOneToOne() {
  const pane = layout.panes[0]; if (!pane) return;
  state.view = V.zoomAt(state.view, pane, pane.x + pane.w / 2, pane.y + pane.h / 2, V.oneToOneZoom(pane, layout.W, layout.H) / state.view.zoom, layout.W, layout.H);
  markDirty();
}
function zoomBy(f) { const p = layout.panes[0]; if (p) { state.view = V.zoomAt(state.view, p, p.x + p.w / 2, p.y + p.h / 2, f, layout.W, layout.H); markDirty(); } }

new ResizeObserver(() => { markDirty(); }).observe(stage);

// ---------------------------------------------------------------------------------------------- keyboard & buttons
function activeFollower() {
  if (state.mode === 'flip' && state.flip !== engine.ref) return state.flip;
  if (state.mode === 'diff') return state.diffIdx;
  return state.clips.findIndex((_, i) => i !== engine.ref);
}
async function nudge(delta) {
  const i = activeFollower();
  if (i < 0) return;
  await engine.nudge(i, delta);
  const c = engine.clips[i];
  toast(`${letter(i)} shifted ${c.offsetFrames > 0 ? '+' : ''}${c.offsetFrames} frame${Math.abs(c.offsetFrames) === 1 ? '' : 's'} relative to ${letter(engine.ref)}.`, { ms: 2500 });
  renderScrubMarks(); markDirty();
}
function cycleAudio() {
  const withAudio = state.clips.map((c, i) => c.info.audio ? i : -1).filter(i => i >= 0);
  if (!withAudio.length) return toast('None of these files has an audio track.', { ms: 2500 });
  const order = [null, ...withAudio];
  const next = order[(order.indexOf(engine.audible) + 1) % order.length];
  engine.setAudible(next); renderAudioSelect();
  toast(next == null ? 'Audio muted' : `Audio: ${letter(next)}`, { ms: 1800 });
}

window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.target instanceof HTMLSelectElement && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const k = e.key;
  if (e.ctrlKey && (k === 'o' || k === 'O')) { e.preventDefault(); pickFiles(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (k === 's' || k === 'S') { toggleSuspend(); return; }
  if (state.suspended) return; // everything else needs live decoders
  const step = e.shiftKey ? 10 : 1;
  if (k === ' ') { e.preventDefault(); engine.togglePlay(); }
  else if (k === 'ArrowRight' || k === '.') { e.preventDefault(); if (engine.playing) engine.pause(); engine.step(step); }
  else if (k === 'ArrowLeft' || k === ',') { e.preventDefault(); if (engine.playing) engine.pause(); engine.step(-step); }
  else if (k === 'Home') engine.seekFrame(0);
  else if (k === 'End') engine.seekFrame(engine.frameCount - 1);
  else if (k === 'ArrowUp') { e.preventDefault(); cycleSpeed(1); }
  else if (k === 'ArrowDown') { e.preventDefault(); cycleSpeed(-1); }
  else if (k === '1') setMode('side');
  else if (k === '2') setMode('wipe');
  else if (k === '3') setMode('flip');
  else if (k === '4') setMode('diff');
  else if (k === 'Tab' && state.mode === 'flip') { e.preventDefault(); state.flip = (state.flip + (e.shiftKey ? state.clips.length - 1 : 1)) % state.clips.length; updateOverlay(); markDirty(); }
  else if (state.mode === 'flip' && /^[a-fA-F]$/.test(k) && k.toUpperCase().charCodeAt(0) - 65 < state.clips.length) { state.flip = k.toUpperCase().charCodeAt(0) - 65; updateOverlay(); markDirty(); }
  else if (k === 'm' || k === 'M') cycleAudio();
  else if (k === 'h' || k === 'H') { state.health = !state.health; refreshHealth(); }
  else if (k === 'c' || k === 'C') { if (state.clips.length > 1) { state.conform = !state.conform; reconform(); toast(`Frame-rate conforming ${state.conform ? 'on' : 'off'}`, { ms: 1800 }); } }
  else if (k === '0') zoomFit();
  else if (k === '=' || k === '+') zoomBy(1.4);
  else if (k === '-' || k === '_') zoomBy(1 / 1.4);
  else if (k === '[') nudge(-1);
  else if (k === ']') nudge(1);
  else if (k === '?' || k === '/') toggleHelp();
  else if (k === 'Escape') { $('menu-export').hidden = true; closeHelp(); }
});

const speeds = [0.1, 0.25, 0.5, 1, 2];
function cycleSpeed(d) {
  const i = clamp(speeds.indexOf(engine.speed) + d, 0, speeds.length - 1);
  $('sel-speed').value = String(speeds[i]); engine.setSpeed(speeds[i]);
}

function helpCard() {
  const rows = [['Space', 'Play / pause'], ['← →  (Shift ×10)', 'Step one frame'], ['Home / End', 'First / last frame'], ['1 2 3 4', 'Side by side · Wipe · Flip · Difference'],
    ['Tab / A B C', 'Flip: switch video'], ['Wheel / drag', 'Zoom at cursor / pan (all videos together)'], ['0  ·  double-click', 'Fit  ·  toggle 1:1'], ['[  ]', 'Nudge the other video ∓1 frame (fix a trim)'],
    ['M', 'Cycle audio'], ['C', 'Conforming on/off'], ['H', 'File health'], ['S', 'Suspend / resume (frees decoders + GPU memory)'], ['↑ ↓', 'Speed'], ['Ctrl+O', 'Open videos']];
  const wrap = document.createElement('div'); wrap.className = 'help'; wrap.id = 'help';
  const card = document.createElement('div'); card.className = 'card';
  const h = document.createElement('h3'); h.textContent = 'Keyboard & mouse'; card.append(h);
  const t = document.createElement('table');
  rows.forEach(([a, b]) => { const tr = document.createElement('tr'); const k = document.createElement('td'); const kb = document.createElement('kbd'); kb.textContent = a; k.append(kb); const d = document.createElement('td'); d.textContent = b; tr.append(k, d); t.append(tr); });
  card.append(t);
  wrap.append(card);
  wrap.addEventListener('click', closeHelp);
  return wrap;
}
function toggleHelp() { $('help') ? closeHelp() : stage.append(helpCard()); }
function closeHelp() { const h = $('help'); if (h) h.remove(); }

async function pickFiles() { const paths = await vc.openDialog(); if (paths && paths.length) openFiles(paths); }
$('btn-add').addEventListener('click', pickFiles);
$('btn-open').addEventListener('click', pickFiles);
$('modes').addEventListener('click', e => { const b = e.target.closest('button[data-mode]'); if (b && !b.disabled) setMode(b.dataset.mode); });
$('sel-filter').addEventListener('change', e => { state.filter = e.target.value; markDirty(); });
$('sel-audio').addEventListener('change', e => engine.setAudible(e.target.value === '' ? null : Number(e.target.value)));
$('sel-speed').addEventListener('change', e => engine.setSpeed(Number(e.target.value)));
$('sel-diff').addEventListener('change', e => { state.diffIdx = Number(e.target.value); updateOverlay(); markDirty(); });
$('rng-gain').addEventListener('input', e => { state.gain = Number(e.target.value); $('out-gain').textContent = `${state.gain}×`; markDirty(); });
$('diffmode').addEventListener('click', e => { const b = e.target.closest('button[data-dm]'); if (!b) return; state.diffMode = b.dataset.dm; syncDiffMode(); markDirty(); });
const syncDiffMode = () => document.querySelectorAll('#diffmode button').forEach(b => b.classList.toggle('active', b.dataset.dm === state.diffMode));
syncDiffMode();
$('btn-health').addEventListener('click', () => { state.health = !state.health; refreshHealth(); });
$('btn-suspend').addEventListener('click', toggleSuspend);
$('btn-resume').addEventListener('click', resume);

// Commands from the taskbar buttons, jump list and Start Menu shortcuts (see main/commands.js)
vc.onCommand(cmd => {
  if (cmd === 'suspend') suspend();
  else if (cmd === 'resume') resume();
  else if (cmd === 'toggle-suspend') toggleSuspend();
  else if (state.suspended) return;
  else if (cmd === 'toggle-play') engine.togglePlay();
  else if (cmd === 'step-back') { if (engine.playing) engine.pause(); engine.step(-1); }
  else if (cmd === 'step-forward') { if (engine.playing) engine.pause(); engine.step(1); }
});
$('t-play').addEventListener('click', () => engine.togglePlay());
$('t-back').addEventListener('click', () => { if (engine.playing) engine.pause(); engine.step(-1); });
$('t-fwd').addEventListener('click', () => { if (engine.playing) engine.pause(); engine.step(1); });
$('t-start').addEventListener('click', () => engine.seekFrame(0));
$('t-end').addEventListener('click', () => engine.seekFrame(engine.frameCount - 1));
$('z-fit').addEventListener('click', zoomFit);
$('z-one').addEventListener('click', zoomOneToOne);

const menu = $('menu-export');
$('btn-export').addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', e => {
  menu.hidden = true;
  const b = e.target.closest && e.target.closest('button');
  if (b) b.blur(); // otherwise Space would re-activate the focused button as well as toggling playback
});
document.addEventListener('change', e => { if (e.target instanceof HTMLSelectElement) e.target.blur(); });

// Drag & drop (paths are extracted in the preload, where webUtils is available)
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); stage.classList.add('dropping'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, () => stage.classList.remove('dropping')));
vc.onDropFiles(openFiles);
vc.onOpenFiles(openFiles);

// ---------------------------------------------------------------------------------------------- exports
const blobBytes = cv => new Promise((res, rej) => cv.toBlob(async b => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('Could not encode PNG'))), 'image/png'));

async function exportFrames() {
  menu.hidden = true;
  if (!engine.clips.length) return;
  busy('Capturing frames…');
  try {
    await engine.pause();
    await engine.seekFrame(engine.frame);
    for (const c of engine.clips) { comp.upload(c.i, c.el); c.dirty = false; }
    const f = String(engine.frame).padStart(6, '0');
    const files = [];
    for (const c of engine.clips) {
      const cv = document.createElement('canvas'); cv.width = c.el.videoWidth; cv.height = c.el.videoHeight;
      cv.getContext('2d').drawImage(c.el, 0, 0);
      files.push({ name: `${stem(state.clips[c.i].name)}_${letter(c.i)}_f${f}.png`, data: await blobBytes(cv) });
    }
    render();
    files.push({ name: `compare_${layout.mode}_f${f}.png`, data: await blobBytes(canvas) }); // toBlob snapshots synchronously after draw
    busyText('Choose where to save…');
    const res = await vc.savePngs(files);
    if (res && !res.canceled) toast(`Saved ${res.count} PNG${res.count > 1 ? 's' : ''}.`, { action: { label: 'Show in folder', run: () => vc.reveal(res.first) } });
  } catch (e) { toast(cleanErr(e), { err: true }); } finally { busy(null); }
}

async function exportConformed() {
  menu.hidden = true;
  if (!state.plan) return;
  const targets = state.plan.videos.filter(v => v.adjusted);
  if (!targets.length) return toast('Nothing to conform: no video needed adjusting.');
  await engine.pause();
  for (const v of targets) {
    busy(`Exporting ${letter(v.index)}…`);
    try {
      const res = await vc.exportConformed({ ids: state.clips.map(c => c.id), referenceIndex: state.plan.referenceIndex, enabled: state.conform, followerIndex: v.index });
      if (res.canceled) continue;
      toast(`${letter(v.index)} saved: ${res.frames} frames at ${fmtFps(res.rate)}${res.lossless ? ' (lossless: only timestamps rewritten)' : ` (re-encoded to H.265 with ${res.encoder})`}${res.regular ? '' : ' — timing still irregular'}.`,
        { action: { label: 'Show in folder', run: () => vc.reveal(res.dest) }, ms: 12000 });
    } catch (e) { toast(cleanErr(e), { err: true }); } finally { busy(null); }
  }
}
$('exp-frames').addEventListener('click', exportFrames);
$('exp-conform').addEventListener('click', exportConformed);

// ---------------------------------------------------------------------------------------------- deep scan
async function deepScan(i) {
  const c = state.clips[i];
  if (!c || c.deep === 'running') return;
  c.deep = 'running'; c.deepPct = 0; refreshHealth();
  try {
    const r = await vc.deepScan(c.id);
    c.health = c.health.filter(x => x.group !== 'Content').concat(r.rows);
    c.markers = c.markers.filter(m => m.kind !== 'repeat').concat(r.markers);
    c.deep = 'done';
  } catch (e) { c.deep = undefined; toast(cleanErr(e), { err: true }); }
  refreshHealth(); renderScrubMarks();
}

let lastPct = -1;
vc.onProgress(m => {
  if (m.kind === 'deepscan') {
    const c = state.clips.find(x => x.id === m.id);
    if (c) { c.deepPct = m.pct; const p = Math.round(m.pct * 100); if (p !== lastPct && state.health) { lastPct = p; refreshHealth(); } }
  } else if (m.kind === 'export') busyText(`Exporting… ${Math.round(m.pct * 100)}%`);
});

// ---------------------------------------------------------------------------------------------- boot
async function boot() {
  try { comp = new Compositor(canvas); }
  catch (e) { toast(cleanErr(e), { err: true }); return; }
  comp.addEventListener('restored', () => { engine.clips.forEach(c => { c.dirty = true; }); comp.ensure(engine.clips.length); markDirty(); });
  const tools = await vc.tools();
  if (!tools.ffprobe) toast('ffprobe was not found, so files cannot be analysed. Install FFmpeg (winget install --id Gyan.FFmpeg -e) and restart the app, or set VIDEO_COMPARE_FFMPEG_DIR.', { err: true });
  refreshAll();
  startLoop();
  vc.ready();
}

if (new URLSearchParams(location.search).has('test')) {
  window.__vc = { state, engine, openFiles, removeClip, reconform, setMode, suspend, resume, toggleSuspend, render, get layout() { return layout; }, get comp() { return comp; }, V, indexAt, updateTransport, deepScan, exportFrames, exportConformed, refreshHealth, zoomOneToOne, zoomFit, nudge };
}
boot();
