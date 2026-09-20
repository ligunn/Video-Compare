// Synchronised playback of N <video> elements.
//
// The REFERENCE clip is the master clock. Every other clip is mapped onto it with
//     media_i(T) = first_i + (T - first_ref) * slope_i + offset_i
// (slope 1 = play by real timestamps; slope = fps_ref / fps_i = "retime", i.e. every frame is kept and
// frame N stays paired with frame N). Paused, pairs are exact (each element is seeked to the frame
// and the seek is confirmed by a presented frame). Playing, followers are steered to the master with
// small playback-rate corrections and only hard-seeked when they fall far behind.

const EPS = 1e-6;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Index of the frame shown at time t: the largest i with pts[i] <= t. */
export function indexAt(pts, t) {
  let lo = 0, hi = pts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid] <= t + EPS) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Media time of `clip` that corresponds to reference time T. */
export function mediaAt(clip, ref, T) {
  return clip.first + (T - ref.first) * clip.slope + clip.offset;
}

function seekClip(c, t) {
  return new Promise(resolve => {
    const v = c.el;
    if (v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - t) < 1e-4) { c.dirty = true; resolve(); return; }
    let settled = false;
    const hard = setTimeout(() => finish(), 2500);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      v.removeEventListener('seeked', onSeeked);
      c.dirty = true;
      resolve();
    }
    function onSeeked() {
      // 'seeked' means the frame is decoded; wait for one presented frame so a texture upload sees it.
      let got = false;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { got = true; finish(); });
      setTimeout(() => { if (!got) finish(); }, 120);
    }
    v.addEventListener('seeked', onSeeked, { once: true });
    v.currentTime = t;
  });
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.clips = [];
    this.ref = 0;
    this.frame = 0;
    this.playing = false;
    this.speed = 1;
    this.audible = null;
    this._pending = null;
    this._draining = null;
    this._raf = 0;
    this._lastControl = 0;
  }

  get refClip() { return this.clips[this.ref]; }
  get frameCount() { return this.refClip ? this.refClip.pts.length : 0; }

  /** @param {Array<{id:string,url:string,name:string,framePts:Float64Array,timeline:{medianDt:number}}>} list */
  async load(list) {
    this.dispose();
    this.clips = list.map((a, i) => this._makeClip(a, i));
    await Promise.all(this.clips.map(c => new Promise((resolve, reject) => {
      const fail = msg => reject(Object.assign(new Error(`${c.name}: ${msg}`), { clipId: c.id }));
      const t = setTimeout(() => fail('timed out waiting for the video to load.'), 20000);
      c.el.addEventListener('loadeddata', () => { clearTimeout(t); c.w = c.el.videoWidth; c.h = c.el.videoHeight; resolve(); }, { once: true });
      c.el.addEventListener('error', () => {
        clearTimeout(t);
        fail(`Chromium could not decode this file (${c.el.error && c.el.error.message ? c.el.error.message : 'unsupported codec or container'}).`);
      }, { once: true });
    })));
    this.frame = 0;
  }

  _makeClip(a, i) {
    const el = document.createElement('video');
    el.crossOrigin = 'anonymous'; el.muted = true; el.preload = 'auto'; el.playsInline = true;
    el.disablePictureInPicture = true; el.className = 'engine-video';
    el.src = a.url;
    document.body.appendChild(el);
    const pts = a.framePts;
    const c = { i, id: a.id, name: a.name, el, pts, first: pts[0], last: pts[pts.length - 1], dt: a.timeline.medianDt,
      slope: 1, mode: 'none', offsetFrames: 0, offset: 0, dirty: true, shownTime: pts[0], w: 0, h: 0 };
    const tick = (_now, md) => {
      c.shownTime = md.mediaTime; c.dirty = true;
      if (this.playing && c === this.refClip) this._emitFrame();
      el.requestVideoFrameCallback(tick);
    };
    el.requestVideoFrameCallback(tick);
    return c;
  }

  applyPlan(plan) {
    this.ref = plan.referenceIndex;
    plan.videos.forEach((p, i) => { const c = this.clips[i]; if (c) { c.slope = p.slope; c.mode = p.mode; } });
    this.frame = clamp(this.frame, 0, Math.max(0, this.frameCount - 1));
  }

  /** Shift clip i by whole frames of its own (manual alignment for trims the timestamps can't reveal). */
  async nudge(i, frames) {
    const c = this.clips[i];
    if (!c || c === this.refClip) return;
    c.offsetFrames += frames;
    c.offset = c.offsetFrames * c.dt;
    await this.seekFrame(this.frame);
  }

  // ---- seeking -------------------------------------------------------------------------------------
  /** Seek every clip to the pair for reference frame k. Rapid calls coalesce to the latest. */
  seekFrame(k) {
    this._pending = clamp(Math.round(k), 0, Math.max(0, this.frameCount - 1));
    if (!this._draining) {
      this._draining = (async () => {
        while (this._pending !== null) {
          const target = this._pending; this._pending = null;
          await this._seekOnce(target);
        }
        this._draining = null;
      })();
    }
    return this._draining;
  }

  async _seekOnce(k) {
    const ref = this.refClip;
    if (!ref) return;
    const T = ref.pts[k];
    await Promise.all(this.clips.map(c => {
      // Aim a quarter frame past the frame's timestamp so we land inside its display interval.
      const target = (c === ref ? T : mediaAt(c, ref, T)) + 0.25 * c.dt;
      const dur = Number.isFinite(c.el.duration) ? c.el.duration - 1e-3 : Infinity;
      return seekClip(c, clamp(target, 0, dur));
    }));
    this.frame = k;
    this._emitFrame();
  }

  step(delta) { return this.seekFrame((this._pending ?? this.frame) + delta); }

  // ---- playback ------------------------------------------------------------------------------------
  async play() {
    if (this.playing || !this.clips.length) return;
    if (this.frame >= this.frameCount - 1) await this.seekFrame(0);
    await this.seekFrame(this.frame);
    this.playing = true;
    const ref = this.refClip;
    this._control(ref.el.currentTime, true);
    await Promise.all(this.clips.map(c => c.el.play().catch(() => {})));
    this._lastControl = 0;
    this._raf = requestAnimationFrame(this._loop);
    this.dispatchEvent(new Event('playstate'));
  }

  async pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this.clips.forEach(c => c.el.pause());
    // Snap to an exact pair: playing left each element somewhere inside its own frame interval.
    await this.seekFrame(indexAt(this.refClip.pts, this.refClip.el.currentTime));
    this.dispatchEvent(new Event('playstate'));
  }

  togglePlay() { return this.playing ? this.pause() : this.play(); }

  setSpeed(x) {
    this.speed = x;
    if (this.playing) this._control(this.refClip.el.currentTime, true);
  }

  _loop = (ts) => {
    if (!this.playing) return;
    const ref = this.refClip;
    const T = ref.el.currentTime;
    if (ts - this._lastControl > 100) { this._lastControl = ts; this._control(T, false); }
    if (ref.el.ended || T >= ref.last + ref.dt * 0.75) { this._finish(); return; }
    this._raf = requestAnimationFrame(this._loop);
  };

  /** Steer every follower toward the master. err > 0 means the follower is ahead of where it should be. */
  _control(T, force) {
    const ref = this.refClip;
    for (const c of this.clips) {
      if (c === ref) { if (force || Math.abs(c.el.playbackRate - this.speed) > 1e-6) c.el.playbackRate = this.speed; continue; }
      const err = c.el.currentTime - mediaAt(c, ref, T);
      if (Math.abs(err) > 0.2) {
        c.el.currentTime = mediaAt(c, ref, T) + 0.03 * c.slope * this.speed;
        continue;
      }
      const correction = clamp(err * 1.2, -0.04, 0.04);
      c.el.playbackRate = clamp(c.slope * this.speed * (1 - correction), 0.0625, 16);
    }
  }

  async _finish() {
    this.playing = false;
    this.clips.forEach(c => c.el.pause());
    await this.seekFrame(this.frameCount - 1);
    this.dispatchEvent(new Event('playstate'));
  }

  // ---- audio ---------------------------------------------------------------------------------------
  setAudible(i) {
    this.audible = i;
    this.clips.forEach(c => { c.el.muted = c.i !== i; c.el.volume = 1; });
  }

  // ---- state ---------------------------------------------------------------------------------------
  _emitFrame() { this.dispatchEvent(new CustomEvent('frame', { detail: this.snapshot() })); }

  /** What each clip is actually showing right now, as frame indices in its own timeline. */
  snapshot() {
    const ref = this.refClip;
    const refShown = ref ? (this.playing ? indexAt(ref.pts, ref.shownTime) : this.frame) : 0;
    return {
      frame: refShown, frameCount: this.frameCount, T: ref ? ref.pts[refShown] : 0, playing: this.playing, speed: this.speed,
      clips: this.clips.map(c => ({
        i: c.i, shownTime: c.shownTime, idx: indexAt(c.pts, c.shownTime), mode: c.mode, slope: c.slope, offsetFrames: c.offsetFrames,
        // the frame of this clip that SHOULD pair with the reference frame on screen
        wantIdx: c === ref ? refShown : indexAt(c.pts, mediaAt(c, ref, ref.pts[refShown]) + 0.25 * c.dt),
      })),
    };
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.playing = false;
    for (const c of this.clips) { c.el.pause(); c.el.removeAttribute('src'); c.el.load(); c.el.remove(); }
    this.clips = [];
    this._pending = null;
  }
}
