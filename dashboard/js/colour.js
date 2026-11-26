/**
 * colour.js -- Perceptually uniform colour scales and legend rendering.
 * Uses OKLCH colour space for interpolation.
 * @module colour
 */
import { CHANNELS, DERIVED_CHANNELS, HEAVY_RAIN_THRESHOLD } from './constants.js';

/* ================================================================== */
/*  OKLCH <-> sRGB conversion                                         */
/* ================================================================== */

/** @param {number} L  Lightness [0,1]
 *  @param {number} C  Chroma [0,~0.37]
 *  @param {number} H  Hue [0,360]
 *  @returns {number[]} [r,g,b] each in [0,1], may be out-of-gamut */
function oklchToLinearRGB(L, C, H) {
  const hRad = H * Math.PI / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  // OKLAB -> LMS (approximate cube roots)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  // LMS -> linear sRGB
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function gammaEncode(x) {
  if (x >= 0.0031308) return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return 12.92 * x;
}

function clampByte(x) {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

/** OKLCH -> CSS hex string. Clamps to sRGB gamut. */
function oklchToHex(L, C, H) {
  const [lr, lg, lb] = oklchToLinearRGB(L, C, H);
  const r = clampByte(gammaEncode(lr));
  const g = clampByte(gammaEncode(lg));
  const b = clampByte(gammaEncode(lb));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** OKLCH -> CSS rgba string (with alpha). */
function oklchToRGBA(L, C, H, a = 1) {
  const [lr, lg, lb] = oklchToLinearRGB(L, C, H);
  return `rgba(${clampByte(gammaEncode(lr))},${clampByte(gammaEncode(lg))},${clampByte(gammaEncode(lb))},${a})`;
}

/* ================================================================== */
/*  Scale builders                                                     */
/* ================================================================== */

/**
 * Build a sequential colour scale from OKLCH stops.
 * @param {Array<[number,number,number]>} stops - [[L,C,H], ...] evenly spaced
 * @returns {function(number): string} maps t in [0,1] -> hex colour
 */
function buildSequential(stops) {
  const n = stops.length - 1;
  return function (t) {
    const tc = Math.max(0, Math.min(1, t));
    const idx = tc * n;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n);
    const f = idx - lo;
    const L = stops[lo][0] + f * (stops[hi][0] - stops[lo][0]);
    const C = stops[lo][1] + f * (stops[hi][1] - stops[lo][1]);
    // Hue interpolation (shortest arc)
    let dH = stops[hi][2] - stops[lo][2];
    if (dH > 180) dH -= 360;
    if (dH < -180) dH += 360;
    const H = stops[lo][2] + f * dH;
    return oklchToHex(L, C, (H + 360) % 360);
  };
}

/**
 * Build a diverging colour scale (goes through near-white at centre).
 * @param {Array<[number,number,number]>} negStops - stops for negative half (most negative first)
 * @param {Array<[number,number,number]>} posStops - stops for positive half (least positive first)
 * @returns {function(number): string} maps t in [0,1] -> hex, centre at 0.5
 */
function buildDiverging(negStops, posStops) {
  const negScale = buildSequential(negStops);
  const posScale = buildSequential(posStops);
  return function (t) {
    const tc = Math.max(0, Math.min(1, t));
    if (tc <= 0.5) return negScale(1 - tc * 2);  // 0->1 maps to most-neg->centre
    return posScale((tc - 0.5) * 2);               // 0->1 maps to centre->most-pos
  };
}

/* ================================================================== */
/*  Pre-defined scales (OKLCH stops)                                   */
/* ================================================================== */

/**
 * All scales. Each maps t in [0,1] to a hex colour string.
 * Sequential: 0 = low, 1 = high.
 * Diverging: 0.5 = centre (zero), 0 = max negative, 1 = max positive.
 */
export const SCALES = {
  /** Temperature: cream -> amber -> red-brown */
  warm: buildSequential([
    [0.92, 0.03, 90],   // pale cream
    [0.80, 0.10, 75],   // warm buff
    [0.68, 0.16, 55],   // amber
    [0.55, 0.18, 35],   // orange-red
    [0.40, 0.14, 25],   // dark brick
    [0.28, 0.08, 20],   // deep brown
  ]),

  /** Precipitation: near-white -> sky blue -> deep blue */
  rain: buildSequential([
    [0.97, 0.01, 240],  // near-white
    [0.85, 0.07, 240],  // pale blue
    [0.72, 0.12, 250],  // sky blue
    [0.56, 0.14, 255],  // blue
    [0.40, 0.12, 265],  // deep blue
    [0.25, 0.08, 270],  // navy
  ]),

  /** Wind (diverging): blue <- white -> red */
  wind: buildDiverging(
    [
      [0.95, 0.01, 260],  // centre (white)
      [0.75, 0.10, 255],  // pale blue
      [0.55, 0.15, 250],  // blue
      [0.35, 0.12, 260],  // deep blue
    ],
    [
      [0.95, 0.01, 30],   // centre (white)
      [0.75, 0.10, 35],   // pale coral
      [0.55, 0.16, 25],   // red
      [0.35, 0.12, 20],   // deep red
    ]
  ),

  /** Pressure: grey-blue -> teal */
  pressure: buildSequential([
    [0.30, 0.03, 250],  // dark blue-grey
    [0.45, 0.06, 220],  // slate
    [0.58, 0.10, 195],  // blue-teal
    [0.70, 0.12, 180],  // teal
    [0.82, 0.08, 170],  // pale teal
    [0.92, 0.03, 165],  // near-white teal
  ]),

  /** Moisture: tan -> green -> blue */
  moisture: buildSequential([
    [0.90, 0.04, 85],   // pale tan
    [0.78, 0.08, 100],  // tan-green
    [0.65, 0.12, 140],  // green
    [0.52, 0.12, 170],  // teal
    [0.40, 0.10, 240],  // blue
    [0.28, 0.08, 260],  // deep blue
  ]),

  /** Wind speed: white -> yellow -> red */
  windspeed: buildSequential([
    [0.95, 0.01, 90],   // white
    [0.85, 0.12, 95],   // pale yellow
    [0.75, 0.17, 75],   // yellow-orange
    [0.60, 0.19, 50],   // orange
    [0.45, 0.17, 30],   // red-orange
    [0.32, 0.12, 20],   // dark red
  ]),

  /** Difference (diverging): blue <- white -> red (wider gamut) */
  difference: buildDiverging(
    [
      [0.97, 0.00, 260],
      [0.80, 0.12, 255],
      [0.60, 0.17, 250],
      [0.38, 0.14, 260],
    ],
    [
      [0.97, 0.00, 30],
      [0.80, 0.12, 35],
      [0.60, 0.17, 25],
      [0.38, 0.14, 15],
    ]
  ),
};

/* ================================================================== */
/*  Public API                                                         */
/* ================================================================== */

/**
 * Get the colour scale function for a channel.
 * @param {string}  channelKey   - e.g. 't2m', 'wind_speed', etc.
 * @param {boolean} isDifference - If true, use the diverging difference scale
 * @returns {function(value: number, range: [number,number]): string}
 *   Maps a physical value + range to a CSS colour string.
 */
export function getColorScale(channelKey, isDifference = false) {
  if (isDifference) {
    const scale = SCALES.difference;
    return (value, range) => {
      const [lo, hi] = range;
      const maxAbs = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      const t = (value + maxAbs) / (2 * maxAbs);
      return scale(t);
    };
  }

  const ch = CHANNELS.find(c => c.key === channelKey) ||
             DERIVED_CHANNELS.find(c => c.key === channelKey);
  const scaleKey = ch ? ch.scaleKey : 'warm';
  const scale = SCALES[scaleKey] || SCALES.warm;
  const isDiv = ch && ch.scaleType === 'diverging';

  return (value, range) => {
    const [lo, hi] = range;
    if (isDiv) {
      const maxAbs = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      const t = (value + maxAbs) / (2 * maxAbs);
      return scale(t);
    }
    const span = hi - lo || 1;
    const t = (value - lo) / span;
    return scale(t);
  };
}

/**
 * Render a colour legend into a container element.
 * @param {HTMLElement} container
 * @param {string}  channelKey
 * @param {boolean} isDifference
 * @param {[number,number]} range - [min, max]
 * @param {Object}  [opts]
 * @param {number}  [opts.width=200]
 * @param {number}  [opts.height=14]
 * @param {number}  [opts.ticks=5]
 * @param {string}  [opts.unit]
 */
export function renderLegend(container, channelKey, isDifference, range, opts = {}) {
  const { width = 200, height = 14, ticks = 5 } = opts;
  const ch = CHANNELS.find(c => c.key === channelKey) ||
             DERIVED_CHANNELS.find(c => c.key === channelKey);
  const unit = opts.unit || (ch ? ch.unit : '');
  const colorFn = getColorScale(channelKey, isDifference);

  container.innerHTML = '';

  // Gradient bar via canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.borderRadius = '2px';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Colour legend for ${ch ? ch.name : channelKey}`);

  const ctx = canvas.getContext('2d');
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    const val = range[0] + t * (range[1] - range[0]);
    ctx.fillStyle = colorFn(val, range);
    ctx.fillRect(x, 0, 1, height);
  }

  // Heavy rain threshold mark
  if (channelKey === 'tp' && !isDifference) {
    const thr = HEAVY_RAIN_THRESHOLD;
    if (thr >= range[0] && thr <= range[1]) {
      const x = ((thr - range[0]) / (range[1] - range[0])) * width;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  container.appendChild(canvas);

  // Tick labels
  const tickRow = document.createElement('div');
  tickRow.className = 'legend-ticks';
  tickRow.style.cssText = `display:flex;justify-content:space-between;width:${width}px;`;
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const val = range[0] + t * (range[1] - range[0]);
    const lbl = document.createElement('span');
    lbl.className = 'text-mono text-label';
    lbl.textContent = formatValue(val, channelKey);
    tickRow.appendChild(lbl);
  }
  container.appendChild(tickRow);

  // Unit label
  if (unit) {
    const unitEl = document.createElement('span');
    unitEl.className = 'text-label';
    unitEl.textContent = unit;
    unitEl.style.marginLeft = '4px';
    container.appendChild(unitEl);
  }
}

/**
 * Format a numeric value for display, respecting channel precision.
 * @param {number} val
 * @param {string} [channelKey]
 * @returns {string}
 */
export function formatValue(val, channelKey) {
  if (!Number.isFinite(val)) return 'N/A';
  if (channelKey === 'msl') return (val / 100).toFixed(0);  // Pa -> hPa display
  if (channelKey === 'tp' || channelKey === 'tcwv') return val.toFixed(1);
  if (Math.abs(val) >= 1000) return val.toFixed(0);
  if (Math.abs(val) >= 10) return val.toFixed(1);
  return val.toFixed(2);
}
