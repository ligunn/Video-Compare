// Pure layout / zoom / pan maths. No DOM, no GL: unit-tested in Node.
//
// Coordinates: rects are in device pixels with a TOP-LEFT origin. "Content space" is W x H, the size of
// the largest video; every video is mapped onto the same normalized picture [0,1]^2 so the same
// region lines up across files of different resolution. view = { zoom, cx, cy }: zoom 1 = fit the
// content in the rect, (cx, cy) = the normalized picture point shown at the rect's centre.

export const MAX_DEVICE_PX_PER_CONTENT_PX = 32;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Content space = the largest video by area (its native pixels are what "1:1" means). */
export function contentSize(videos) {
  let W = 0, H = 0;
  for (const v of videos) if (v.w * v.h > W * H) { W = v.w; H = v.h; }
  return { W, H };
}

export function gridPanes(n, cw, ch, gap = 0) {
  if (n <= 0) return [];
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = (cw - gap * (cols - 1)) / cols, h = (ch - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({ x: (i % cols) * (w + gap), y: Math.floor(i / cols) * (h + gap), w, h }));
}

export const fitScale = (rect, W, H) => Math.min(rect.w / W, rect.h / H);
export const scaleOf = (rect, W, H, zoom) => fitScale(rect, W, H) * zoom;
/** Normalized picture units per device pixel, for the shader. */
export const invScale = (rect, W, H, zoom) => { const s = scaleOf(rect, W, H, zoom); return [1 / (W * s), 1 / (H * s)]; };

export function clampView(v) {
  if (v.zoom <= 1) return { zoom: 1, cx: 0.5, cy: 0.5 };
  return { zoom: v.zoom, cx: clamp(v.cx, 0, 1), cy: clamp(v.cy, 0, 1) };
}

/** Normalized picture coordinate under device pixel (px, py) inside rect. */
export function uvAt(view, rect, px, py, W, H) {
  const s = scaleOf(rect, W, H, view.zoom);
  return [view.cx + (px - (rect.x + rect.w / 2)) / (W * s), view.cy + (py - (rect.y + rect.h / 2)) / (H * s)];
}

/** Zoom by `factor`, keeping the picture point under the cursor fixed. */
export function zoomAt(view, rect, px, py, factor, W, H) {
  const s0 = fitScale(rect, W, H);
  const zoom = clamp(view.zoom * factor, 1, Math.max(1, MAX_DEVICE_PX_PER_CONTENT_PX / s0));
  const [u, v] = uvAt(view, rect, px, py, W, H);
  const s = s0 * zoom;
  return clampView({ zoom, cx: u - (px - (rect.x + rect.w / 2)) / (W * s), cy: v - (py - (rect.y + rect.h / 2)) / (H * s) });
}

export function panBy(view, dxPx, dyPx, rect, W, H) {
  const s = scaleOf(rect, W, H, view.zoom);
  return clampView({ zoom: view.zoom, cx: view.cx - dxPx / (W * s), cy: view.cy - dyPx / (H * s) });
}

/** Zoom that shows content pixels 1:1 with device pixels (never below fit). */
export const oneToOneZoom = (rect, W, H) => Math.max(1, 1 / fitScale(rect, W, H));

/** True when one device pixel covers more than one texel of this video (needs mipmaps to look right). */
export const minifying = (videoW, W, scale) => (videoW / W) / scale > 1;

/** Vertical wipe strips for N videos from N-1 sorted boundary fractions. */
export function wipeStrips(bounds, cw) {
  const edges = [0, ...bounds.map(b => b * cw), cw];
  return edges.slice(0, -1).map((x0, i) => ({ x0, x1: edges[i + 1] }));
}

export function defaultBounds(n) {
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => (i + 1) / n);
}

/** Index of the wipe boundary within tolPx of x, or -1. */
export function nearestBoundary(bounds, x, cw, tolPx) {
  let best = -1, bd = tolPx;
  bounds.forEach((b, i) => { const d = Math.abs(b * cw - x); if (d <= bd) { bd = d; best = i; } });
  return best;
}

/** Move boundary i to fraction f, keeping order and a minimum strip width. */
export function moveBoundary(bounds, i, f, minGap = 0.02) {
  const lo = i > 0 ? bounds[i - 1] + minGap : minGap;
  const hi = i < bounds.length - 1 ? bounds[i + 1] - minGap : 1 - minGap;
  const out = bounds.slice();
  out[i] = clamp(f, lo, Math.max(lo, hi));
  return out;
}
