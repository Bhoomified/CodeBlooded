/**
 * mock-engine.js -- In-browser mock of the backend API.
 * Generates plausible seasonal base fields and rolls forward with
 * simple advection + diffusion. Loaded ONLY when config.mode === "mock".
 *
 * This is NOT model output. All results carry a prominent badge.
 * @module mock-engine
 */

const ROWS = 32, COLS = 36, CH = 6;
const CELL_COUNT = ROWS * COLS;

/* ------------------------------------------------------------------ */
/*  Fault injection state (mock-only dev controls)                     */
/* ------------------------------------------------------------------ */

const faults = {
  healthLoading: false,
  healthLoadingReason: 'Warming up model weights',
  healthError: false,
  healthErrorReason: 'GPU out of memory',
  error422: false,
  error422Message: 'Invalid doy_sincos: values must be in [-1, 1]',
  slowResponse: false,
  slowMs: 6000,
  injectNaN: false,
  nanStep: 0, nanChannel: 0, nanRow: 16, nanCol: 18,
  injectFallback: false,
  fallbackSteps: [3, 7],
  serverDown: false,
};

export function getFaultState() { return { ...faults }; }
export function setFault(key, value) { if (key in faults) faults[key] = value; }

/* ------------------------------------------------------------------ */
/*  Serialization queue (server processes one at a time)               */
/* ------------------------------------------------------------------ */

let queue = Promise.resolve();

function enqueue(fn) {
  const task = queue.then(fn, fn);
  queue = task.catch(() => {});
  return task;
}

/* ------------------------------------------------------------------ */
/*  Seeded PRNG (xoshiro128**)                                        */
/* ------------------------------------------------------------------ */

function xoshiro128ss(a, b, c, d) {
  return function () {
    const t = b << 9;
    let r = a * 5; r = ((r << 7) | (r >>> 25)) * 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
    d = (d << 11) | (d >>> 21);
    return (r >>> 0) / 4294967296;
  };
}

function seededRNG(seed) {
  let s = seed | 0;
  const h = () => { s = Math.imul(s ^ (s >>> 16), 0x45d9f3b); s = Math.imul(s ^ (s >>> 16), 0x45d9f3b); return (s ^ (s >>> 16)) >>> 0; };
  return xoshiro128ss(h(), h(), h(), h());
}

/* ------------------------------------------------------------------ */
/*  Seasonal climatology                                               */
/* ------------------------------------------------------------------ */

function generateClimatology(doySinCos) {
  const [sinDoy, cosDoy] = doySinCos;
  const isMonsoon = sinDoy > 0.5;
  const fields = new Float32Array(CH * CELL_COUNT);

  for (let r = 0; r < ROWS; r++) {
    const lat = 6.5 + r;
    const latFrac = r / (ROWS - 1);
    for (let c = 0; c < COLS; c++) {
      const lon = 65.5 + c;
      const lonFrac = c / (COLS - 1);
      const idx = r * COLS + c;

      // t2m: warm south, cold north, slight seasonal shift
      const t2mBase = 303 - latFrac * 20 + sinDoy * 3;
      // Higher terrain effect in northern rows
      const terrainCool = latFrac > 0.75 ? (latFrac - 0.75) * 40 : 0;
      fields[0 * CELL_COUNT + idx] = t2mBase - terrainCool;

      // tp: monsoon rain band (~10-22 N during monsoon), near zero otherwise
      const inRainBand = lat >= 10 && lat <= 25 && lon >= 72 && lon <= 92;
      const rainBase = isMonsoon && inRainBand ? 15 + 10 * Math.sin((lat - 10) / 15 * Math.PI) : 1;
      fields[1 * CELL_COUNT + idx] = Math.max(0, rainBase + (isMonsoon ? 5 * (1 - lonFrac) : 0));

      // u10: westerlies shift with monsoon
      const u10Base = isMonsoon ? 5 - latFrac * 3 : -2 + latFrac * 4;
      fields[2 * CELL_COUNT + idx] = u10Base;

      // v10: southerlies during monsoon over Arabian Sea
      const v10Base = isMonsoon && lon < 78 ? 4 - latFrac * 2 : -1 + latFrac * 1.5;
      fields[3 * CELL_COUNT + idx] = v10Base;

      // msl: lower pressure in heated regions
      const mslBase = 101325 - latFrac * 500 + cosDoy * 200;
      fields[4 * CELL_COUNT + idx] = mslBase;

      // tcwv: more moisture in tropics and during monsoon
      const tcwvBase = 50 - latFrac * 30 + (isMonsoon ? 15 : 0);
      fields[5 * CELL_COUNT + idx] = Math.max(0, tcwvBase);
    }
  }
  return fields;
}

/* ------------------------------------------------------------------ */
/*  Advection + diffusion step                                         */
/* ------------------------------------------------------------------ */

function advectDiffuse(prev, climatology, stepIndex) {
  const next = new Float32Array(prev.length);
  const relaxRate = 0.02;

  for (let ch = 0; ch < CH; ch++) {
    const chOff = ch * CELL_COUNT;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = chOff + r * COLS + c;

        // Simple 3x3 diffusion (average of neighbours)
        let sum = 0, count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
              sum += prev[chOff + nr * COLS + nc];
              count++;
            }
          }
        }
        const diffused = sum / count;

        // Simple advection: shift by u10/v10 (very simplified)
        const u = prev[2 * CELL_COUNT + r * COLS + c];
        const v = prev[3 * CELL_COUNT + r * COLS + c];
        const srcR = Math.max(0, Math.min(ROWS - 1, Math.round(r - v * 0.05)));
        const srcC = Math.max(0, Math.min(COLS - 1, Math.round(c - u * 0.05)));
        const advected = prev[chOff + srcR * COLS + srcC];

        // Blend: 70% diffused (locality), 20% advected, 10% relaxation to climatology
        const blended = 0.7 * diffused + 0.2 * advected + 0.1 * prev[idx];
        const relaxed = blended + relaxRate * (climatology[idx] - blended);

        next[idx] = relaxed;
      }
    }

    // Post-process clamps
    if (ch === 0) { // t2m
      for (let i = chOff; i < chOff + CELL_COUNT; i++) {
        next[i] = Math.max(233.15, Math.min(333.15, next[i]));
      }
    }
    if (ch === 1) { // tp
      for (let i = chOff; i < chOff + CELL_COUNT; i++) {
        next[i] = Math.max(0, Math.min(800, next[i]));
      }
    }
  }
  return next;
}

/* ------------------------------------------------------------------ */
/*  API surface                                                        */
/* ------------------------------------------------------------------ */

let _config = null;
export function init(config) { _config = config; }

export function health() {
  return enqueue(async () => {
    if (faults.serverDown) throw new Error('Mock server is down (fault injected)');
    if (faults.healthLoading) {
      return { status: 'loading', model_name: 'mock-engine (not the model)', reason: faults.healthLoadingReason };
    }
    if (faults.healthError) {
      return { status: 'error', model_name: 'mock-engine (not the model)', reason: faults.healthErrorReason };
    }
    return { status: 'ready', model_name: 'mock-engine (not the model)' };
  });
}

export function simulate(body, signal) {
  return enqueue(async () => {
    if (faults.serverDown) throw new Error('Mock server is down (fault injected)');
    if (faults.error422) {
      const err = new Error(faults.error422Message);
      err.status = 422;
      throw err;
    }

    const { init_states, doy_sincos, steps, perturbation } = body;

    // Build initial field from last input day
    const lastDay = init_states[init_states.length - 1];
    let current = new Float32Array(CH * CELL_COUNT);
    for (let ch = 0; ch < CH; ch++) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          current[ch * CELL_COUNT + r * COLS + c] = lastDay[ch][r][c];
        }
      }
    }

    // Apply perturbation to the initial field
    if (perturbation) {
      for (let ch = 0; ch < CH; ch++) {
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            current[ch * CELL_COUNT + r * COLS + c] += perturbation[ch][r][c];
          }
        }
      }
    }

    const climatology = generateClimatology(doy_sincos);

    // Roll forward
    const rollout = [];
    for (let s = 0; s < steps; s++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

      current = advectDiffuse(current, climatology, s);

      // Inject NaN fault
      if (faults.injectNaN && s === faults.nanStep) {
        current[faults.nanChannel * CELL_COUNT + faults.nanRow * COLS + faults.nanCol] = NaN;
      }

      // Convert to nested array [6][32][36]
      const stepData = [];
      for (let ch = 0; ch < CH; ch++) {
        const chData = [];
        for (let r = 0; r < ROWS; r++) {
          const row = [];
          for (let c = 0; c < COLS; c++) {
            row.push(current[ch * CELL_COUNT + r * COLS + c]);
          }
          chData.push(row);
        }
        stepData.push(chData);
      }
      rollout.push(stepData);
    }

    // Build diagnostics
    const diagnostics = [];
    for (let s = 0; s < steps; s++) {
      const entry = { step: s, stage: 'mock', event: 'rollout', detail: `Step ${s} computed` };
      // Inject fallback events
      if (faults.injectFallback && faults.fallbackSteps.includes(s)) {
        entry.event = 'fallback';
        entry.model = 'persistence';
        entry.detail = `Fallback triggered at step ${s} (fault injected)`;
      } else if (s % 5 === 0) {
        entry.model = 'cnn';
      }
      diagnostics.push(entry);
    }

    // Simulate latency
    const latency = faults.slowResponse
      ? faults.slowMs
      : (Math.random() * (400 - 150) + 150);
    await new Promise(resolve => setTimeout(resolve, latency));

    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    return {
      rollout,
      inference_ms: latency,
      diagnostics,
    };
  });
}

/**
 * Generate mock initial states: [3][6][32][36].
 * @param {number} dayOfYear
 * @returns {{ init_states: number[][][][], doy_sincos: [number, number] }}
 */
export function generateInitialState(dayOfYear) {
  const doy = dayOfYear || 196;  // Mid-July default (monsoon)
  const sinVal = Math.sin(2 * Math.PI * doy / 365);
  const cosVal = Math.cos(2 * Math.PI * doy / 365);
  const doy_sincos = [sinVal, cosVal];

  const clim = generateClimatology(doy_sincos);
  const rng = seededRNG(doy);

  const init_states = [];
  for (let d = 0; d < 3; d++) {
    const dayData = [];
    for (let ch = 0; ch < CH; ch++) {
      const chData = [];
      for (let r = 0; r < ROWS; r++) {
        const row = [];
        for (let c = 0; c < COLS; c++) {
          const base = clim[ch * CELL_COUNT + r * COLS + c];
          // Add small random perturbation for realism across days
          const noise = (rng() - 0.5) * 2 * [2, 3, 1, 1, 100, 3][ch];
          let val = base + noise * (1 + d * 0.1);
          if (ch === 1) val = Math.max(0, val);
          row.push(val);
        }
        chData.push(row);
      }
      dayData.push(chData);
    }
    init_states.push(dayData);
  }

  return { init_states, doy_sincos };
}

/** Mock presets list. */
export function getPresets() {
  return [
    { id: 'monsoon_july', label: 'Mid-July Monsoon (DOY 196)' },
    { id: 'winter_jan', label: 'Winter January (DOY 15)' },
    { id: 'premonsoon_may', label: 'Pre-monsoon May (DOY 135)' },
  ];
}

/** Mock preset data. */
export function getPreset(id) {
  const doyMap = { monsoon_july: 196, winter_jan: 15, premonsoon_may: 135 };
  const doy = doyMap[id] || 196;
  return generateInitialState(doy);
}

/** Mock /meta endpoint. */
export function getMeta() {
  // Generate simple land/sea mask and orography
  const landMask = [];
  const orography = [];
  for (let r = 0; r < ROWS; r++) {
    const lat = 6.5 + r;
    const landRow = [], oroRow = [];
    for (let c = 0; c < COLS; c++) {
      const lon = 65.5 + c;
      // Very rough India land mask
      const isLand = lon >= 68 && lon <= 97 && lat >= 8 && lat <= 36 &&
                     !(lon < 72 && lat < 20) &&   // Arabian Sea
                     !(lon > 88 && lat < 15) &&   // Bay of Bengal south
                     !(lon < 70 && lat > 25);      // Pakistan/ocean
      landRow.push(isLand ? 1 : 0);
      // Rough orography: Himalayas in north, Western Ghats along west coast
      let elev = 0;
      if (isLand) {
        if (lat > 30) elev = 2000 + (lat - 30) * 1500;  // Himalayas
        if (lat > 28 && lon > 76 && lon < 82) elev = Math.max(elev, 1000);  // Indo-Gangetic hills
        if (lon >= 73 && lon <= 76 && lat >= 10 && lat <= 20) elev = 800;  // Western Ghats
      }
      oroRow.push(elev);
    }
    landMask.push(landRow);
    orography.push(oroRow);
  }

  return {
    land_sea_mask: landMask,
    orography_m: orography,
    channel_stds: [8.0, 15.0, 5.0, 5.0, 500.0, 15.0],
  };
}
