
import type { QualityReason, QualityResult, QualityScores, QualityStatus } from '../../types';

/** quality-gate-matlab/cameraPresets.json, verbatim. Keep in sync. */
export const CAMERA_PRESETS: Record<string, { focusThreshold: number; illuminationThreshold: number }> = {
  default: { focusThreshold: 0.17, illuminationThreshold: 0.4 },
  mobile_lens: { focusThreshold: 0.12, illuminationThreshold: 0.3 },
};

export function presetFor(cameraDeviceId: string): string {
  return Object.prototype.hasOwnProperty.call(CAMERA_PRESETS, cameraDeviceId) ? cameraDeviceId : 'default';
}

export interface GrayImage {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/** rgb2gray on uint8 input: MATLAB's exact weights, rounded back to uint8. */
export function toGray(data: Uint8Array | Uint16Array, width: number, height: number, channels: number, depth = 8): GrayImage {
  const n = width * height;
  const pixels = new Uint8Array(n);
  const scale = depth === 16 ? 1 / 257 : 1;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    let v: number;
    if (channels >= 3) {
      v = 0.298936021293775 * data[o] + 0.587043074451121 * data[o + 1] + 0.114020904255103 * data[o + 2];
    } else {
      v = data[o];
    }
    v = Math.round(v * scale);
    pixels[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return { pixels, width, height };
}

/** var(x(:)) with MATLAB's default N-1 normalisation, from running sums. */
function sampleVariance(sum: number, sumSq: number, n: number): number {
  if (n < 2) return 0;
  return (sumSq - (sum * sum) / n) / (n - 1);
}

// ── assessFocus.m ───────────────────────────────────────────────────────────
// fspecial('laplacian', 0.2), imfilter(..., 'replicate'), var, min(1, v/70).
export function assessFocus({ pixels, width: W, height: H }: GrayImage): number {
  const a = 0.2;
  const corner = a / (a + 1);
  const edge = (1 - a) / (a + 1);
  const center = -4 / (a + 1);
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < H; y++) {
    const ym = (y > 0 ? y - 1 : 0) * W;
    const y0 = y * W;
    const yp = (y < H - 1 ? y + 1 : H - 1) * W;
    for (let x = 0; x < W; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < W - 1 ? x + 1 : W - 1;
      const v =
        corner * (pixels[ym + xm] + pixels[ym + xp] + pixels[yp + xm] + pixels[yp + xp]) +
        edge * (pixels[ym + x] + pixels[y0 + xm] + pixels[y0 + xp] + pixels[yp + x]) +
        center * pixels[y0 + x];
      sum += v;
      sumSq += v * v;
    }
  }
  return Math.min(1, sampleVariance(sum, sumSq, W * H) / 70);
}

// ── assessIllumination.m ────────────────────────────────────────────────────
export function assessIllumination({ pixels }: GrayImage): number {
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) sum += pixels[i];
  const mu = sum / pixels.length;
  return Math.max(0, 1 - Math.abs(mu - 100) / 100);
}


let stackBuf: Int32Array | null = null;
function sharedStack(n: number): Int32Array {
  if (!stackBuf || stackBuf.length < n) stackBuf = new Int32Array(n);
  return stackBuf;
}


function flood8(mask: Uint8Array, visited: Uint8Array, W: number, H: number, start: number, mark: number, onlyVisited: number): number {
  const stack = sharedStack(W * H);
  let top = 0;
  stack[top++] = start;
  visited[start] = mark;
  let area = 0;
  while (top > 0) {
    const idx = stack[--top];
    area += 1;
    const x = idx % W;
    const y = (idx - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        const j = ny * W + nx;
        if (mask[j] && visited[j] === onlyVisited) {
          visited[j] = mark;
          stack[top++] = j;
        }
      }
    }
  }
  return area;
}


function components8(mask: Uint8Array, W: number, H: number, minArea?: number): number {
  const n = W * H;
  const visited = new Uint8Array(n); // 0 = unseen, 1 = kept, 2 = removed
  let largest = 0;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || visited[start]) continue;
    const area = flood8(mask, visited, W, H, start, 1, 0);
    if (minArea !== undefined && area < minArea) {
      flood8(mask, visited, W, H, start, 2, 1);
    }
    if (area > largest) largest = area;
  }
  if (minArea !== undefined) {
    for (let i = 0; i < n; i++) if (visited[i] === 2) mask[i] = 0;
  }
  return largest;
}

/** imfill(bw, 'holes'): background not 4-connected to the border becomes foreground. */
function fillHoles(bw: Uint8Array, W: number, H: number): Uint8Array {
  const n = W * H;
  const reach = new Uint8Array(n);
  const stack = sharedStack(n);
  let top = 0;
  const seed = (i: number) => {
    if (!bw[i] && !reach[i]) { reach[i] = 1; stack[top++] = i; }
  };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (top > 0) {
    const i = stack[--top];
    const x = i % W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (i >= W) seed(i - W);
    if (i < n - W) seed(i + W);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = reach[i] ? 0 : 1;
  return out;
}

// ── assessFOV.m ─────────────────────────────────────────────────────────────
export function assessFOV({ pixels, width: W, height: H }: GrayImage): { score: number; coveragePercent: number } {
  const n = W * H;
  const bw = new Uint8Array(n);
  for (let i = 0; i < n; i++) bw[i] = pixels[i] > 15 ? 1 : 0;
  const filled = fillHoles(bw, W, H);
  const largest = components8(filled, W, H);
  const coveragePercent = largest / n;
  return { coveragePercent, score: Math.min(1, coveragePercent / 0.6) };
}

// ── Morphology helpers for the occlusion score ─────────────────────────────


function dilateDisk(mask: Uint8Array, W: number, H: number, r: number, target: 0 | 1): Uint8Array {
  const cap = Math.min(255, r + 1);
  const hd = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let d = cap;
    for (let x = 0; x < W; x++) {
      d = mask[row + x] === target ? 0 : Math.min(cap, d + 1);
      hd[row + x] = d;
    }
    d = cap;
    for (let x = W - 1; x >= 0; x--) {
      d = mask[row + x] === target ? 0 : Math.min(cap, d + 1);
      if (d < hd[row + x]) hd[row + x] = d;
    }
  }
  const r2 = r * r;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      for (let yy = y0; yy <= y1; yy++) {
        const h = hd[yy * W + x];
        const dy = yy - y;
        if (h * h + dy * dy <= r2) { out[y * W + x] = 1; break; }
      }
    }
  }
  return out;
}

/** imclose(bw, disk(r)) = erode(dilate(bw)); erosion = NOT dilate(background). */
function closeDisk(bw: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const dilated = dilateDisk(bw, W, H, r, 1);
  const bgGrown = dilateDisk(dilated, W, H, r, 0);
  const closed = new Uint8Array(W * H);
  for (let i = 0; i < closed.length; i++) closed[i] = dilated[i] && !bgGrown[i] ? 1 : 0;
  return closed;
}

/** bwconvhull(bw): the convex hull of all foreground pixels, rasterised. */
function convexHullMask(bw: Uint8Array, W: number, H: number): Uint8Array {

  const pts: [number, number][] = [];
  for (let y = 0; y < H; y++) {
    let lo = -1;
    let hi = -1;
    const row = y * W;
    for (let x = 0; x < W; x++) if (bw[row + x]) { lo = x; break; }
    if (lo < 0) continue;
    for (let x = W - 1; x >= lo; x--) if (bw[row + x]) { hi = x; break; }
    pts.push([lo - 0.5, y - 0.5], [lo - 0.5, y + 0.5], [hi + 0.5, y - 0.5], [hi + 0.5, y + 0.5]);
  }
  const out = new Uint8Array(W * H);
  if (pts.length < 3) return out;

  // Andrew's monotone chain.
  pts.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));

  // Scanline fill: a pixel is inside when its centre is inside the polygon.
  for (let y = 0; y < H; y++) {
    const xs: number[] = [];
    for (let i = 0; i < hull.length; i++) {
      const [x1, y1] = hull[i];
      const [x2, y2] = hull[(i + 1) % hull.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    if (xs.length < 2) continue;
    const from = Math.max(0, Math.ceil(Math.min(...xs)));
    const to = Math.min(W - 1, Math.floor(Math.max(...xs)));
    for (let x = from; x <= to; x++) out[y * W + x] = 1;
  }
  return out;
}

// ── assessGlareMotionOcclusion.m ────────────────────────────────────────────
export function assessGlareMotionOcclusion(img: GrayImage, diskRadius = 7): { glareScore: number; motionScore: number; occlusionScore: number } {
  const { pixels, width: W, height: H } = img;
  const n = W * H;

  // Glare: centre ROI gray(r1:r2, c1:c2), 1-based and inclusive in MATLAB.
  const r1 = Math.max(1, Math.round(0.25 * H)) - 1;
  const r2 = Math.max(1, Math.round(0.75 * H)) - 1;
  const c1 = Math.max(1, Math.round(0.25 * W)) - 1;
  const c2 = Math.max(1, Math.round(0.75 * W)) - 1;
  let saturated = 0;
  let roi = 0;
  for (let y = r1; y <= r2; y++) {
    for (let x = c1; x <= c2; x++) {
      roi += 1;
      if (pixels[y * W + x] > 250) saturated += 1;
    }
  }
  const glareScore = roi > 0 ? saturated / roi : 0;

  // Motion: imfilter with [1 -1] and [1; -1], 'replicate' -> out = g(p) - g(next).
  let sH = 0, sqH = 0, sV = 0, sqV = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const below = (y < H - 1 ? y + 1 : y) * W;
    for (let x = 0; x < W; x++) {
      const g = pixels[row + x];
      const dh = g - pixels[row + (x < W - 1 ? x + 1 : x)];
      const dv = g - pixels[below + x];
      sH += dh; sqH += dh * dh;
      sV += dv; sqV += dv * dv;
    }
  }
  const varH = sampleVariance(sH, sqH, n);
  const varV = sampleVariance(sV, sqV, n);
  const denom = Math.max(varH, varV);
  const motionScore = denom < 1e-10 ? 0 : Math.abs(varH - varV) / denom;

  // Occlusion: dark (<20) pixels inside the convex hull of the cleaned bright region.
  let bright: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) bright[i] = pixels[i] > 7 ? 1 : 0;
  bright = closeDisk(bright, W, H, diskRadius);
  components8(bright, W, H, Math.round(0.01 * n)); // bwareaopen, in place
  let any = false;
  for (let i = 0; i < n; i++) if (bright[i]) { any = true; break; }
  let occlusionScore = 0;
  if (any) {
    const disc = convexHullMask(bright, W, H);
    let area = 0;
    let dark = 0;
    for (let i = 0; i < n; i++) {
      if (disc[i]) {
        area += 1;
        if (pixels[i] < 20) dark += 1;
      }
    }
    occlusionScore = area === 0 ? 0 : dark / area;
  }
  return { glareScore, motionScore, occlusionScore };
}

// ── qualityGateMain.m ───────────────────────────────────────────────────────
export function runQualityGateOnGray(img: GrayImage, cameraDeviceId: string, opts: { diskRadius?: number } = {}): QualityResult {
  const presetName = presetFor(cameraDeviceId);
  const preset = CAMERA_PRESETS[presetName];

  const focus = assessFocus(img);
  const illumination = assessIllumination(img);
  const fov = assessFOV(img);
  const gmo = assessGlareMotionOcclusion(img, opts.diskRadius ?? 7);

  const scores: QualityScores = {
    focusScore: focus,
    illuminationScore: illumination,
    fovScore: fov.score,
    coveragePercent: fov.coveragePercent,
    glareScore: gmo.glareScore,
    motionScore: gmo.motionScore,
    occlusionScore: gmo.occlusionScore,
  };
  const compositeScore = (focus + illumination + fov.score) / 3;

  let status: QualityStatus;
  let reason: QualityReason | null = null;
  if (fov.coveragePercent < 0.5) { status = 'retake'; reason = 'insufficient_fov'; }
  else if (gmo.glareScore > 0.3) { status = 'retake'; reason = 'glare'; }
  else if (gmo.motionScore > 0.3) { status = 'retake'; reason = 'motion_artifact'; }
  else if (illumination < preset.illuminationThreshold) { status = 'retake'; reason = 'low_illumination'; }
  else if (focus < preset.focusThreshold) { status = 'retake'; reason = 'blur'; }
  else if (gmo.occlusionScore > 0.18) { status = 'retake'; reason = 'eyelash_occlusion'; }
  else if (compositeScore < 0.7) { status = 'borderline'; }
  else { status = 'pass'; }

  return { status, reason, scores, compositeScore, preset: presetName, analysedAt: `${img.width}x${img.height}` };
}
