/**
 * ripple.js -- Shock ripple overlay, drawn from the model's own response.
 *
 * For each forecast day it takes the shocked-minus-normal field returned by the server, measures how far the
 * response reaches exactly the way the organisers' causality check does (energy summed over all six channels in
 * units of channel std, Euclidean distance in grid cells from the shocked box, radius holding 90 % of the energy),
 * and draws that reach as a circle around the shock on the map. Next to it, dashed, is the speed limit the kit allows on that day:
 * 3 + 8 x (day) cells beyond the box. Nothing here is simulated in the browser: no model output, no ripple.
 * @module ripple
 */
import { GRID, CHANNELS, CHANNEL_COUNT } from './constants.js';
import { rowToLat, colToLon } from './grid.js';

let canvas = null;
let ctx = null;
let map = null;
let enabled = true;
let visible = false;          // only in the Difference view, after a shocked run
let data = null;              // { box, radii: [steps], limits: [steps], share: [steps] }
let day = 0;
let anim = { from: 0, to: 0, t0: 0 };
let pulseT0 = 0;
const ANIM_MS = 520;

export function initRipple(targetCanvas, mapInstance) {
  canvas = targetCanvas;
  ctx = canvas.getContext('2d');
  map = mapInstance;
  const resize = () => {
    const c = map.getContainer();
    canvas.width = c.clientWidth;
    canvas.height = c.clientHeight;
  };
  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(loop);
}

/**
 * Measure the model's response reach for every day.
 * @param {{ differenceBuffer: Float32Array, steps: number, shockBox: {rows:number[], cols:number[], latMin:number, latMax:number, lonMin:number, lonMax:number}|null, channelStds: number[]|null }} p
 */
export function setRippleData({ differenceBuffer, steps, shockBox, channelStds }) {
  if (!differenceBuffer || !shockBox) { data = null; return; }
  const R = GRID.ROWS, C = GRID.COLS, N = R * C;
  const stds = CHANNELS.map((ch, i) => (channelStds && channelStds[i] > 0) ? channelStds[i] : ch.approxStd);
  const [r0, r1] = shockBox.rows, [c0, c1] = shockBox.cols;
  const dist = new Float32Array(N);
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    dist[r * C + c] = Math.hypot(Math.max(0, r0 - r, r - r1), Math.max(0, c0 - c, c - c1));
  }
  const order = Array.from(dist.keys()).sort((a, b) => dist[a] - dist[b]);
  const radii = [], limits = [], totals = [];
  for (let s = 0; s < steps; s++) {
    const e = new Float64Array(N);
    let tot = 0;
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      for (let i = 0; i < N; i++) {
        const v = differenceBuffer[s * CHANNEL_COUNT * N + ch * N + i];
        if (!Number.isFinite(v)) continue;
        const z = v / stds[ch];
        e[i] += z * z;
      }
    }
    for (let i = 0; i < N; i++) tot += e[i];
    let cum = 0, r90 = 0;
    if (tot > 0) {
      for (const i of order) { cum += e[i]; if (cum >= 0.9 * tot) { r90 = dist[i]; break; } }
    }
    radii.push(r90);
    limits.push(3 + 8 * (s + 1));
    totals.push(tot);
  }
  data = { box: shockBox, radii, limits, totals };
  anim = { from: 0, to: radii[Math.min(day, steps - 1)] || 0, t0: performance.now() };
  pulseT0 = performance.now();
}

export function setRippleDay(d) {
  if (d === day) return;
  const prev = data ? (data.radii[Math.min(day, data.radii.length - 1)] || 0) : 0;
  day = d;
  if (!data) return;
  anim = { from: currentRadius(prev), to: data.radii[Math.min(d, data.radii.length - 1)] || 0, t0: performance.now() };
  pulseT0 = performance.now();
}

export function setRippleVisible(v) { visible = v; }
export function toggleRipple(on) { enabled = on; }

/** Response reach (cells beyond the box) per day, for panels. */
export function getRippleSummary() { return data ? { radii: data.radii.slice(), limits: data.limits.slice() } : null; }

function currentRadius(fallback) {
  const t = Math.min(1, (performance.now() - anim.t0) / ANIM_MS);
  const k = 1 - Math.pow(1 - t, 3);
  return Number.isFinite(anim.from) ? anim.from + (anim.to - anim.from) * k : fallback;
}

/**
 * Circle around the shock centre. Its radius is half the box's larger side plus `d`, so the ring sits `d` cells
 * beyond the shocked box: the same reach the organisers measure, drawn as a circle.
 */
function contour(box, d) {
  const la0 = rowToLat(box.rows[0]) - 0.5, la1 = rowToLat(box.rows[1]) + 0.5;
  const lo0 = colToLon(box.cols[0]) - 0.5, lo1 = colToLon(box.cols[1]) + 0.5;
  const cx = (lo0 + lo1) / 2, cy = (la0 + la1) / 2;
  const R = Math.max(la1 - la0, lo1 - lo0) / 2 + d;
  const pts = [];
  for (let i = 0; i < 72; i++) {
    const a = (2 * Math.PI * i) / 72;
    const lat = Math.max(-85, Math.min(85, cy + R * Math.sin(a)));
    pts.push(map.project([cx + R * Math.cos(a), lat]));
  }
  return pts;
}

function path(pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

function loop() {
  requestAnimationFrame(loop);
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!enabled || !visible || !data) return;
  const s = Math.min(day, data.radii.length - 1);
  if (!(data.totals[s] > 0)) return;           // null shock: identical runs, nothing spreads
  const box = data.box;
  const r = currentRadius(data.radii[s]);
  const lim = data.limits[s];

  // speed limit allowed by the kit on this day (once it is wider than the whole domain, only the label shows it)
  if (lim <= 36) {
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(232, 236, 244, 0.55)';
  path(contour(box, lim));
  ctx.stroke();
  ctx.restore();
  }

  // earlier days: the trail of the ripple
  for (let k = 0; k < s; k++) {
    ctx.lineWidth = 1;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = `rgba(255, 122, 47, ${0.18 + 0.4 * (k / Math.max(1, s))})`;
    path(contour(box, data.radii[k]));
    ctx.stroke();
  }

  // today's measured reach: glowing contour, softly filled
  const pts = contour(box, r);
  ctx.save();
  path(pts);
  ctx.fillStyle = 'rgba(255, 122, 47, 0.09)';
  ctx.fill();
  ctx.shadowColor = 'rgba(255, 138, 76, 0.9)';
  ctx.shadowBlur = 14;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ff7a2f';
  ctx.stroke();
  ctx.restore();

  // one pulse travelling outward from the box to today's reach after each day change
  const pt = (performance.now() - pulseT0) / 900;
  if (pt < 1) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255, 210, 140, ${0.8 * (1 - pt)})`;
    path(contour(box, Math.max(0.2, r * pt)));
    ctx.stroke();
  }

  // label just inside the contour's western edge (the top often sits under the floating toolbar)
  const left = pts.reduce((a, p) => (p.x < a.x ? p : a), pts[0]);
  const text = `Day ${s} · reach ${data.radii[s].toFixed(1)} cells (≈${Math.round(data.radii[s] * 111)} km) · limit ${lim}`;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 18;
  const x = Math.max(8, Math.min(canvas.width - w - 8, left.x + 12)), y = Math.max(8, Math.min(canvas.height - 30, left.y - 11));
  ctx.fillStyle = 'rgba(14, 18, 26, 0.78)';
  ctx.strokeStyle = 'rgba(255, 150, 80, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, 22, 11); else ctx.rect(x, y, w, 22);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffd9b0';
  ctx.fillText(text, x + 9, y + 15);
}
