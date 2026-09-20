// WebGL2 compositor. Draws "passes" computed elsewhere (see view.js); knows nothing about layout.
// A pass = { kind: 'single'|'diff', rect, pane, tex:[i] | [i,j], center:[x,y], invScale:[x,y],
//            filter:'nearest'|'bilinear'|'bicubic', minify:[bool,...], gain?, diffMode? }
//   rect = region that receives pixels (scissor);  pane = rectangle the picture is laid out in.
// All rects are device pixels, TOP-LEFT origin.

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
uniform vec4 uPane;      // x, y, w, h in device px, GL (bottom-left) origin
uniform vec2 uCenter;    // normalized picture coordinate at the pane centre
uniform vec2 uInvScale;  // normalized picture units per device px
out vec4 o;
const vec4 BG = vec4(0.055, 0.06, 0.07, 1.0);

vec2 picUV() {
  vec2 d = gl_FragCoord.xy - (uPane.xy + uPane.zw * 0.5);
  return uCenter + vec2(d.x, -d.y) * uInvScale;
}
bool outside(vec2 uv) { return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0; }

// Catmull-Rom weights for the taps at -1, 0, +1, +2
vec4 catrom(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
vec4 bicubic(sampler2D t, vec2 uv) {
  ivec2 sz = textureSize(t, 0);
  vec2 p = uv * vec2(sz) - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec4 wx = catrom(f.x), wy = catrom(f.y);
  vec4 sum = vec4(0.0);
  for (int y = -1; y <= 2; y++)
    for (int x = -1; x <= 2; x++)
      sum += texelFetch(t, clamp(i + ivec2(x, y), ivec2(0), sz - 1), 0) * wx[x + 1] * wy[y + 1];
  return clamp(sum, 0.0, 1.0);
}
`;

const FS_SINGLE = HEAD + `
uniform sampler2D uTexA;
uniform int uBicubicA;
void main() {
  vec2 uv = picUV();
  if (outside(uv)) { o = BG; return; }
  vec4 c = uBicubicA == 1 ? bicubic(uTexA, uv) : texture(uTexA, uv);
  o = vec4(c.rgb, 1.0);
}`;

const FS_DIFF = HEAD + `
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform int uBicubicA;
uniform int uBicubicB;
uniform float uGain;
uniform int uDiffMode;   // 0 = amplified absolute difference, 1 = heatmap
vec3 heat(float m) {
  m = clamp(m, 0.0, 1.0) * 6.0;
  vec3 c0 = vec3(0.0, 0.0, 0.05), c1 = vec3(0.0, 0.2, 0.9), c2 = vec3(0.0, 0.8, 0.8), c3 = vec3(0.1, 0.9, 0.2),
       c4 = vec3(1.0, 0.9, 0.0), c5 = vec3(1.0, 0.2, 0.0), c6 = vec3(1.0);
  if (m < 1.0) return mix(c0, c1, m);
  if (m < 2.0) return mix(c1, c2, m - 1.0);
  if (m < 3.0) return mix(c2, c3, m - 2.0);
  if (m < 4.0) return mix(c3, c4, m - 3.0);
  if (m < 5.0) return mix(c4, c5, m - 4.0);
  return mix(c5, c6, m - 5.0);
}
void main() {
  vec2 uv = picUV();
  if (outside(uv)) { o = BG; return; }
  vec3 a = (uBicubicA == 1 ? bicubic(uTexA, uv) : texture(uTexA, uv)).rgb;
  vec3 b = (uBicubicB == 1 ? bicubic(uTexB, uv) : texture(uTexB, uv)).rgb;
  vec3 d = abs(a - b) * uGain;
  o = vec4(uDiffMode == 1 ? heat(max(d.r, max(d.g, d.b))) : clamp(d, 0.0, 1.0), 1.0);
}`;

export class Compositor extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this._init(); this.dispatchEvent(new Event('restored')); });
    this._init();
  }

  _init() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this environment.');
    this.gl = gl;
    this.single = this._program(VS, FS_SINGLE, ['uPane', 'uCenter', 'uInvScale', 'uTexA', 'uBicubicA']);
    this.diff = this._program(VS, FS_DIFF, ['uPane', 'uCenter', 'uInvScale', 'uTexA', 'uTexB', 'uBicubicA', 'uBicubicB', 'uGain', 'uDiffMode']);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.tex = [];
  }

  _program(vsSrc, fsSrc, uniforms) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
    const u = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
    return { id: p, u };
  }

  /** Give the GPU everything back (used by Suspend): textures, programs and the drawing buffer go with the context. */
  async release() {
    const gl = this.gl;
    this._loseExt = gl && gl.getExtension('WEBGL_lose_context');
    this.tex = [];
    if (!this._loseExt || this.lost) return;
    const lost = new Promise(res => this.canvas.addEventListener('webglcontextlost', res, { once: true }));
    this._loseExt.loseContext();
    await lost;
    this.canvas.width = 1; this.canvas.height = 1;
  }

  /** Bring the context back after release(); resolves once programs are rebuilt. */
  reacquire() {
    if (!this.lost || !this._loseExt) return Promise.resolve();
    return new Promise(res => { this.addEventListener('restored', res, { once: true }); this._loseExt.restoreContext(); });
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** Make sure textures 0..n-1 exist; drops extras. */
  ensure(n) {
    const gl = this.gl;
    while (this.tex.length < n) {
      const id = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, id);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex.push({ id, w: 0, h: 0, valid: false, mipsFresh: false, min: 0, mag: 0 });
    }
    while (this.tex.length > n) gl.deleteTexture(this.tex.pop().id);
  }

  /** Upload the video's current frame into texture i. */
  upload(i, video) {
    const gl = this.gl, t = this.tex[i];
    if (!t || video.readyState < 2 || !video.videoWidth) return false;
    gl.bindTexture(gl.TEXTURE_2D, t.id);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    t.w = video.videoWidth; t.h = video.videoHeight; t.valid = true; t.mipsFresh = false;
    return true;
  }

  _bind(unit, i, filter, minify) {
    const gl = this.gl, t = this.tex[i];
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.id);
    const mag = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    let min = mag;
    if (filter !== 'nearest' && minify) {
      if (!t.mipsFresh) { gl.generateMipmap(gl.TEXTURE_2D); t.mipsFresh = true; }
      min = gl.LINEAR_MIPMAP_LINEAR;
    }
    if (t.mag !== mag) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag); t.mag = mag; }
    if (t.min !== min) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min); t.min = min; }
  }

  draw(passes) {
    const gl = this.gl;
    if (!gl || this.lost) return;
    const H = this.canvas.height;
    gl.viewport(0, 0, this.canvas.width, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.055, 0.06, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    for (const p of passes) {
      if (p.tex.some(i => !this.tex[i] || !this.tex[i].valid)) continue;
      const prog = p.kind === 'diff' ? this.diff : this.single;
      gl.useProgram(prog.id);
      gl.scissor(Math.round(p.rect.x), H - Math.round(p.rect.y + p.rect.h), Math.max(0, Math.round(p.rect.w)), Math.max(0, Math.round(p.rect.h)));
      gl.uniform4f(prog.u.uPane, p.pane.x, H - (p.pane.y + p.pane.h), p.pane.w, p.pane.h);
      gl.uniform2f(prog.u.uCenter, p.center[0], p.center[1]);
      gl.uniform2f(prog.u.uInvScale, p.invScale[0], p.invScale[1]);
      const bic = k => (p.filter === 'bicubic' && !p.minify[k] ? 1 : 0);
      this._bind(0, p.tex[0], p.filter, p.minify[0]);
      gl.uniform1i(prog.u.uTexA, 0);
      gl.uniform1i(prog.u.uBicubicA, bic(0));
      if (p.kind === 'diff') {
        this._bind(1, p.tex[1], p.filter, p.minify[1]);
        gl.uniform1i(prog.u.uTexB, 1);
        gl.uniform1i(prog.u.uBicubicB, bic(1));
        gl.uniform1f(prog.u.uGain, p.gain);
        gl.uniform1i(prog.u.uDiffMode, p.diffMode === 'heat' ? 1 : 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Read one drawn pixel (device px, top-left origin). Call in the same task as draw(). */
  readPixel(x, y) {
    const gl = this.gl, px = new Uint8Array(4);
    gl.readPixels(Math.round(x), this.canvas.height - 1 - Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  }
}
