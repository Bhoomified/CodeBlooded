/**
 * constants.js -- Central registry of grid, channel, and threshold constants.
 * Every magic number in the codebase lives here.
 * @module constants
 */

/* ------------------------------------------------------------------ */
/*  Grid geometry                                                      */
/* ------------------------------------------------------------------ */

/** 32 lat rows x 36 lon cols, 1-degree cells, south-to-north order. */
export const GRID = Object.freeze({
  ROWS: 32,
  COLS: 36,
  LAT_MIN: 6.5,
  LAT_MAX: 37.5,
  LON_MIN: 65.5,
  LON_MAX: 100.5,
  CELL_SIZE: 1.0,
  TOTAL_CELLS: 32 * 36,   // 1152
});

export const CHANNEL_COUNT = 6;
export const INPUT_DAYS = 3;

/* ------------------------------------------------------------------ */
/*  Channel metadata (wire order)                                      */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} ChannelMeta
 * @property {number}   index
 * @property {string}   key            - Short key (t2m, tp, u10, v10, msl, tcwv)
 * @property {string}   name           - Human label
 * @property {string}   unit           - Physical unit string
 * @property {string}   scaleType      - 'sequential' | 'diverging'
 * @property {string}   scaleKey       - Key into colour.SCALES
 * @property {number[]} defaultRange   - [min, max] for the legend
 * @property {number[]} validityGate   - Hard-reject outside this range
 * @property {number[]} clampLimits    - Flag when value sits exactly here
 * @property {number[]} physicalEnvelope - Full physical range
 * @property {number}   approxStd      - Approximate 1-sigma (fallback if /meta absent)
 * @property {Object}   shockRange     - {min, max} additive delta range for the UI
 */
export const CHANNELS = Object.freeze([
  {
    index: 0, key: 't2m', name: '2m Temperature', unit: 'K',
    scaleType: 'sequential', scaleKey: 'warm',
    defaultRange: [270, 320],
    validityGate: [233.15, 333.15],
    clampLimits: [234, 332],
    physicalEnvelope: [200, 350],
    approxStd: 8.0,
    shockRange: { min: -15, max: 15 },
  },
  {
    index: 1, key: 'tp', name: 'Total Precipitation', unit: 'mm/day',
    scaleType: 'sequential', scaleKey: 'rain',
    defaultRange: [0, 50],
    validityGate: [0, Infinity],
    clampLimits: [0, 800],
    physicalEnvelope: [0, 800],
    approxStd: 15.0,
    shockRange: { min: -50, max: 100 },
  },
  {
    index: 2, key: 'u10', name: '10m U-Wind', unit: 'm/s',
    scaleType: 'diverging', scaleKey: 'wind',
    defaultRange: [-15, 15],
    validityGate: [-Infinity, Infinity],
    clampLimits: [-60, 60],
    physicalEnvelope: [-60, 60],
    approxStd: 5.0,
    shockRange: { min: -20, max: 20, percentMin: -100, percentMax: 100 },
  },
  {
    index: 3, key: 'v10', name: '10m V-Wind', unit: 'm/s',
    scaleType: 'diverging', scaleKey: 'wind',
    defaultRange: [-15, 15],
    validityGate: [-Infinity, Infinity],
    clampLimits: [-60, 60],
    physicalEnvelope: [-60, 60],
    approxStd: 5.0,
    shockRange: { min: -20, max: 20, percentMin: -100, percentMax: 100 },
  },
  {
    index: 4, key: 'msl', name: 'Mean Sea Level Pressure', unit: 'Pa',
    scaleType: 'sequential', scaleKey: 'pressure',
    defaultRange: [95000, 103000],
    validityGate: [-Infinity, Infinity],
    clampLimits: [85000, 110000],
    physicalEnvelope: [85000, 110000],
    approxStd: 500.0,
    shockRange: { min: -5000, max: 5000 },
  },
  {
    index: 5, key: 'tcwv', name: 'Total Column Water Vapour', unit: 'kg/m\u00B2',
    scaleType: 'sequential', scaleKey: 'moisture',
    defaultRange: [0, 70],
    validityGate: [0, Infinity],
    clampLimits: [0, 120],
    physicalEnvelope: [0, 120],
    approxStd: 15.0,
    shockRange: { min: -30, max: 60 },
  },
]);

/** Derived channels (computed client-side from wire channels). */
export const DERIVED_CHANNELS = Object.freeze([
  {
    key: 'wind_speed', name: 'Wind Speed', unit: 'm/s',
    scaleType: 'sequential', scaleKey: 'windspeed',
    defaultRange: [0, 25],
  },
]);

/** Look up a channel by key (returns wire channel or derived). */
export function channelByKey(key) {
  return CHANNELS.find(c => c.key === key) ||
         DERIVED_CHANNELS.find(c => c.key === key) || null;
}

/* ------------------------------------------------------------------ */
/*  Spatial thresholds                                                 */
/* ------------------------------------------------------------------ */

/** Cells within this distance of the domain border are "edge band". */
export const EDGE_BAND_CELLS = 3;

/** Maximum r90 growth per forecast day. */
export const MAX_SPREAD_CELLS_PER_DAY = 8;

/* ------------------------------------------------------------------ */
/*  Timing                                                             */
/* ------------------------------------------------------------------ */

export const HEALTH_POLL_READY_MS    = 5000;
export const HEALTH_POLL_LOADING_MS  = 2000;
export const HEALTH_LOADING_TIMEOUT_MS = 120000;
export const INFERENCE_WARNING_MS    = 5000;
export const SIMULATE_TIMEOUT_MS     = 15000;
export const MOCK_LATENCY_MIN_MS     = 150;
export const MOCK_LATENCY_MAX_MS     = 400;

/* ------------------------------------------------------------------ */
/*  Impact thresholds                                                  */
/* ------------------------------------------------------------------ */

/** Heat risk: daily mean t2m above this (K). */
export const HEAT_RISK_THRESHOLD_K = 308;

/** Heavy rain layer: cells with tp above this (mm/day). */
export const HEAVY_RAIN_THRESHOLD = 10;

/* ------------------------------------------------------------------ */
/*  Validation and diagnostics                                         */
/* ------------------------------------------------------------------ */

/** Max acceptable |difference| for null-shock test. */
export const NULL_SHOCK_EPSILON = 1e-3;

/** Causality check numeric thresholds. */
export const CAUSALITY = Object.freeze({
  /** >= 60 % of day-1 energy within 3 cells of shock box. */
  LOCALIZED_MIN_ENERGY_FRAC: 0.60,
  /** < 5 % of energy beyond the limit line each day. */
  NO_TELEPORT_MAX_BEYOND_FRAC: 0.05,
  /** Late outside-energy > 1.5x its day-1 value. */
  PROPAGATES_LATE_RATIO: 1.5,
  /** r90 must not grow more than 8 cells/day. */
  R90_MAX_GROWTH_PER_DAY: 8,
  /** Stable: response magnitude never above 5 channel stds. */
  STABLE_MAX_STD_RATIO: 5,
});

/** Blur monitor: flag when spatial std ratio falls below this. */
export const BLUR_RATIO_THRESHOLD = 0.4;

/** Physics battery thresholds. */
export const BATTERY = Object.freeze({
  NULL_MAX_DIFF_STD: 1e-3,
  LINEARITY_ENERGY_RATIO_MIN: 0.20,
  LINEARITY_ENERGY_RATIO_MAX: 0.35,
  SYMMETRY_CORRELATION_MAX: -0.80,
});

/** Ensemble default member count. */
export const ENSEMBLE_MEMBERS = 5;

/* ------------------------------------------------------------------ */
/*  Map defaults                                                       */
/* ------------------------------------------------------------------ */

export const MAP_DEFAULTS = Object.freeze({
  CENTER: [82.5, 22.0],   // [lon, lat] centre of India
  ZOOM: 4.2,
  PITCH: 45,
  BEARING: 0,
  MAX_ZOOM: 8,
  MIN_ZOOM: 3,
});

/**
 * Extrusion height scaling factors (data units -> visual metres).
 * Tuned so columns are visible at default zoom without dwarfing the map.
 */
export const EXTRUSION_SCALE = Object.freeze({
  t2m: 300,
  tp: 2000,
  u10: 5000,
  v10: 5000,
  msl: 0.5,
  tcwv: 3000,
  wind_speed: 5000,
  difference: 10000,
});

/**
 * Physical limit radius at forecast day k (0-indexed):
 * limitCells(k) = 3 + 8 * (k + 1)
 */
export function limitRadius(k) {
  return 3 + MAX_SPREAD_CELLS_PER_DAY * (k + 1);
}
