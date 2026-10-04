'use strict';


const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PRESETS_PATH = path.join(__dirname, '..', 'quality-gate-matlab', 'cameraPresets.json');

const RGB2GRAY = [0.298936021293775, 0.587043074451121, 0.114020904255103];


const DISK7_HALF_WIDTHS = [4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 4];


async function loadGrayscale(input) {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = info.width * info.height;
  const px = new Uint8Array(n);
  const ch = info.channels;
  if (ch < 3) {
    for (let i = 0, j = 0; i < n; i += 1, j += ch) px[i] = data[j];
  } else {
    const [a, b, c] = RGB2GRAY;
    for (let i = 0, j = 0; i < n; i += 1, j += ch) {

      const g = a * data[j] + b * data[j + 1] + c * data[j + 2];
      px[i] = g >= 255 ? 255 : Math.round(g);
    }
  }
  return { g: px, W: info.width, H: info.height };
}


class RunningVariance {
  constructor() { this.n = 0; this.mean = 0; this.m2 = 0; }
  push(x) {
    this.n += 1;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
  }
  get value() { return this.n < 2 ? 0 : this.m2 / (this.n - 1); }
}


function assessFocus({ g, W, H }) {
  const alpha = 0.2;
  const k1 = alpha / (alpha + 1);
  const k2 = (1 - alpha) / (alpha + 1);
  const k0 = -4 / (alpha + 1);
  const rv = new RunningVariance();
  for (let y = 0; y < H; y++) {
    const ym = (y > 0 ? y - 1 : 0) * W, y0 = y * W, yp = (y < H - 1 ? y + 1 : H - 1) * W;
    for (let x = 0; x < W; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
      rv.push(
        k1 * g[ym + xm] + k2 * g[ym + x] + k1 * g[ym + xp] +
        k2 * g[y0 + xm] + k0 * g[y0 + x] + k2 * g[y0 + xp] +
        k1 * g[yp + xm] + k2 * g[yp + x] + k1 * g[yp + xp]);
    }
  }
  return { score: Math.min(1, rv.value / 70) };
}


function assessIllumination({ g }) {
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const mu = sum / g.length;
  return { score: Math.max(0, 1 - Math.abs(mu - 100) / 100) };
}


function labelComponents(mask, W, H, conn) {
  const labels = new Int32Array(W * H);
  const areas = [0];
  const stack = new Int32Array(W * H);
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    next += 1;
    let sp = 0, area = 0;
    stack[sp++] = start;
    labels[start] = next;
    while (sp) {
      const idx = stack[--sp];
      area += 1;
      const x = idx % W, y = (idx - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (conn === 4 && dx && dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (mask[j] && !labels[j]) { labels[j] = next; stack[sp++] = j; }
        }
      }
    }
    areas.push(area);
  }
  return { labels, areas };
}


function assessFOV({ g, W, H }) {
  const n = W * H;
  const bw = new Uint8Array(n);
  for (let i = 0; i < n; i++) bw[i] = g[i] > 15 ? 1 : 0;


  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (i) => { if (!bw[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (sp) {
    const i = stack[--sp];
    const x = i % W, y = (i - x) / W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (y > 0) seed(i - W);
    if (y < H - 1) seed(i + W);
  }
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) filled[i] = outside[i] ? 0 : 1;

  const { areas } = labelComponents(filled, W, H, 8);
  let largest = 0;
  for (let k = 1; k < areas.length; k++) if (areas[k] > largest) largest = areas[k];
  const coveragePercent = largest / n;
  return { coveragePercent, score: Math.min(1, coveragePercent / 0.6) };
}


function rowPrefix(mask, W, H) {
  const P = new Int32Array(H * (W + 1));
  for (let y = 0; y < H; y++) {
    const base = y * (W + 1);
    let s = 0;
    for (let x = 0; x < W; x++) { s += mask[y * W + x]; P[base + x + 1] = s; }
  }
  return P;
}


function morph(mask, W, H, halfWidths, erode) {
  const P = rowPrefix(mask, W, H);
  const r = (halfWidths.length - 1) / 2;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = erode ? 1 : 0;
      for (let k = 0; k < halfWidths.length; k++) {
        const yy = y + k - r;
        const w = halfWidths[k];
        if (yy < 0 || yy >= H) {
          if (!erode) continue;   // dilation: outside is 0, contributes nothing
          continue;               // erosion: outside is 1, never erodes
        }
        const x0 = x - w < 0 ? 0 : x - w;
        const x1 = x + w > W - 1 ? W - 1 : x + w;
        const base = yy * (W + 1);
        const ones = P[base + x1 + 1] - P[base + x0];
        if (erode) {
          if (ones < x1 - x0 + 1) { v = 0; break; }
        } else if (ones > 0) { v = 1; break; }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}


function imclose(mask, W, H, halfWidths) {
  const r = (halfWidths.length - 1) / 2;
  const pr = Math.max(r, ...halfWidths);
  const PW = W + 2 * pr, PH = H + 2 * pr;
  const padded = new Uint8Array(PW * PH);
  for (let y = 0; y < H; y++) padded.set(mask.subarray(y * W, y * W + W), (y + pr) * PW + pr);
  const closed = morph(morph(padded, PW, PH, halfWidths, false), PW, PH, halfWidths, true);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) out.set(closed.subarray((y + pr) * PW + pr, (y + pr) * PW + pr + W), y * W);
  return out;
}

/** Andrew's monotone chain; points as [x, y]. Returns hull, counter-clockwise. */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function convexHullMask(mask, W, H) {
  const points = [];
  for (let y = 0; y < H; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (lo < 0) lo = x; hi = x; }
    if (lo < 0) continue;
    for (const x of lo === hi ? [lo] : [lo, hi]) {
      points.push([x - 0.5, y], [x + 0.5, y], [x, y - 0.5], [x, y + 0.5]);
    }
  }
  const out = new Uint8Array(W * H);
  if (!points.length) return out;
  const hull = convexHull(points);
  const m = hull.length;
  for (let y = 0; y < H; y++) {
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < m; i++) {
      const [ax, ay] = hull[i];
      const [bx, by] = hull[(i + 1) % m];
      if ((ay <= y && by >= y) || (by <= y && ay >= y)) {
        if (ay === by) {
          xl = Math.min(xl, ax, bx); xr = Math.max(xr, ax, bx);
        } else {
          const xi = ax + (y - ay) * (bx - ax) / (by - ay);
          xl = Math.min(xl, xi); xr = Math.max(xr, xi);
        }
      }
    }
    if (xl > xr) continue;
    const c0 = Math.max(0, Math.ceil(xl - 1e-9));
    const c1 = Math.min(W - 1, Math.floor(xr + 1e-9));
    for (let x = c0; x <= c1; x++) out[y * W + x] = 1;
  }
  return out;
}

/** assessGlareMotionOcclusion.m, line for line. */
function assessGlareMotionOcclusion({ g, W, H }) {
  const n = W * H;

  // Glare: centerROI = gray(r1:r2, c1:c2), 1-based and INCLUSIVE.
  const r1 = Math.round(0.25 * H), r2 = Math.round(0.75 * H);
  const c1 = Math.round(0.25 * W), c2 = Math.round(0.75 * W);
  let sat = 0, roi = 0;
  for (let y = r1 - 1; y <= r2 - 1; y++) {
    for (let x = c1 - 1; x <= c2 - 1; x++) {
      roi += 1;
      if (g[y * W + x] > 250) sat += 1;
    }
  }
  const glareScore = roi ? sat / roi : 0;

  const rvH = new RunningVariance(), rvV = new RunningVariance();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      rvH.push(g[i] - g[x < W - 1 ? i + 1 : i]);
      rvV.push(g[i] - g[y < H - 1 ? i + W : i]);
    }
  }
  const varH = rvH.value, varV = rvV.value;
  const denom = Math.max(varH, varV);
  const motionScore = denom < 1e-10 ? 0 : Math.abs(varH - varV) / denom;

  let bright = new Uint8Array(n);
  for (let i = 0; i < n; i++) bright[i] = g[i] > 7 ? 1 : 0;
  bright = imclose(bright, W, H, DISK7_HALF_WIDTHS);
  const minArea = Math.round(0.01 * n);
  const { labels, areas } = labelComponents(bright, W, H, 8);
  let any = false;
  for (let i = 0; i < n; i++) {
    const keep = bright[i] && areas[labels[i]] >= minArea;
    bright[i] = keep ? 1 : 0;
    if (keep) any = true;
  }
  let occlusionScore = 0;
  if (any) {
    const disc = convexHullMask(bright, W, H);
    let discArea = 0, darkIn = 0;
    for (let i = 0; i < n; i++) {
      if (disc[i]) { discArea += 1; if (g[i] < 20) darkIn += 1; }
    }
    occlusionScore = discArea ? darkIn / discArea : 0;
  }
  return { glareScore, motionScore, occlusionScore };
}

/** qualityGateMain.m's getPresetOrDefault, reading the same cameraPresets.json. */
function presetFor(cameraDeviceId) {
  const presets = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
  return Object.prototype.hasOwnProperty.call(presets, cameraDeviceId)
    ? presets[cameraDeviceId] : presets.default;
}


async function runQualityGateFallback(input, cameraDeviceId = 'unknown') {
  const img = await loadGrayscale(input);
  const preset = presetFor(cameraDeviceId);

  const focus = assessFocus(img);
  const illumination = assessIllumination(img);
  const fov = assessFOV(img);
  const gmo = assessGlareMotionOcclusion(img);

  const scores = {
    focusScore: focus.score,
    illuminationScore: illumination.score,
    fovScore: fov.score,
    coveragePercent: fov.coveragePercent,
    glareScore: gmo.glareScore,
    motionScore: gmo.motionScore,
    occlusionScore: gmo.occlusionScore,
  };
  const compositeScore = (focus.score + illumination.score + fov.score) / 3;

  // qualityGateMain.m's decision chain, same order, same thresholds.
  let status = 'pass', reason = null;
  if (fov.coveragePercent < 0.5) { status = 'retake'; reason = 'insufficient_fov'; }
  else if (gmo.glareScore > 0.3) { status = 'retake'; reason = 'glare'; }
  else if (gmo.motionScore > 0.3) { status = 'retake'; reason = 'motion_artifact'; }
  else if (illumination.score < preset.illuminationThreshold) { status = 'retake'; reason = 'low_illumination'; }
  else if (focus.score < preset.focusThreshold) { status = 'retake'; reason = 'blur'; }
  else if (gmo.occlusionScore > 0.18) { status = 'retake'; reason = 'eyelash_occlusion'; }
  else if (compositeScore < 0.7) { status = 'borderline'; }

  return { status, reason, scores, compositeScore };
}

module.exports = { runQualityGateFallback };
