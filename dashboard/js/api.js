/**
 * api.js -- API client: health, simulate, presets, meta, file upload.
 * In mock mode, dynamically imports mock-engine.js.
 * In live mode, the mock module is never loaded.
 * @module api
 */
import { CHANNEL_COUNT, GRID, SIMULATE_TIMEOUT_MS, HEALTH_POLL_READY_MS,
         HEALTH_POLL_LOADING_MS, HEALTH_LOADING_TIMEOUT_MS,
         INFERENCE_WARNING_MS, INPUT_DAYS } from './constants.js';
import { computeDoySinCos } from './doy.js';

/** @type {import('./mock/mock-engine.js')|null} */
let mockEngine = null;

/** Resolved health polling method: 'POST' or 'GET'. */
let healthMethod = 'POST';

/**
 * Initialise the API layer.
 * @param {import('./state.js').Store} store
 * @param {import('./config-loader.js').AppConfig} config
 * @returns {Object} API methods
 */
export async function initApi(store, config) {
  if (config.mode === 'mock') {
    const mod = await import('../mock/mock-engine.js');
    mockEngine = mod;
    if (typeof mod.init === 'function') mod.init(config);
  }

  let healthTimer = null;
  let loadingStart = null;
  let currentAbort = null;

  /* ---------------------------------------------------------------- */
  /*  Health polling                                                    */
  /* ---------------------------------------------------------------- */

  async function checkHealth() {
    const url = `${config.apiBase}${config.endpoints.health}`;
    try {
      let res;
      if (config.mode === 'mock') {
        const data = await mockEngine.health();
        res = { ok: true, status: 200, json: async () => data };
      } else {
        // Try POST first; on 405, fall back to GET
        try {
          res = await fetch(url, { method: healthMethod, signal: AbortSignal.timeout(5000) });
          if (res.status === 405 && healthMethod === 'POST') {
            healthMethod = 'GET';
            res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
          }
        } catch (err) {
          throw err;
        }
      }

      if (!res.ok) throw new Error(`Health returned ${res.status}`);
      const data = await res.json();

      const status = data.status || 'unknown';
      if (status === 'loading') {
        if (!loadingStart) loadingStart = Date.now();
      } else {
        loadingStart = null;
      }

      store.set('health', {
        status,
        modelName: data.model_name || null,
        reason: data.reason || data.detail || null,
        lastCheck: new Date(),
        elapsedLoading: loadingStart ? Date.now() - loadingStart : 0,
        healthMethod,
      });
      store.emit('health:update', store.get('health'));

      // Schedule next poll
      const interval = status === 'loading' ? HEALTH_POLL_LOADING_MS : HEALTH_POLL_READY_MS;
      healthTimer = setTimeout(checkHealth, interval);
    } catch (err) {
      loadingStart = null;
      store.set('health', {
        status: 'error',
        modelName: null,
        reason: err.message || 'Connection failed',
        lastCheck: new Date(),
        elapsedLoading: 0,
        healthMethod,
      });
      store.emit('health:update', store.get('health'));
      healthTimer = setTimeout(checkHealth, HEALTH_POLL_READY_MS);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Simulate                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Run a single simulation request.
   * @param {number[][][]} initStates - [3][6][32][36] nested arrays
   * @param {[number,number]} doySinCos
   * @param {number} steps
   * @param {number[][][]|null} perturbation - [6][32][36] or null
   * @param {AbortSignal} [signal]
   * @returns {Promise<{rollout: Float32Array, inferenceMs: number, diagnostics: any}>}
   */
  async function simulate(initStates, doySinCos, steps, perturbation, signal) {
    const body = {
      init_states: initStates,
      doy_sincos: doySinCos,
      steps,
      perturbation: perturbation || null,
    };

    if (config.transport === 'base64') {
      throw new Error('base64 transport not yet implemented. Waiting for format specification from the backend team.');
    }

    const start = performance.now();

    let data;
    if (config.mode === 'mock') {
      data = await mockEngine.simulate(body, signal);
    } else {
      const url = `${config.apiBase}${config.endpoints.simulate}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(SIMULATE_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 422) {
          throw new ApiError(text || 'Invalid request (422)', 422);
        }
        throw new ApiError(
          `Server error (${res.status}). ${text ? text : 'Check server logs.'}`,
          res.status
        );
      }

      data = await res.json();
    }

    const inferenceMs = data.inference_ms ?? (performance.now() - start);

    // Validate response shape
    const rolloutNested = data.rollout;
    if (!Array.isArray(rolloutNested) || rolloutNested.length !== steps) {
      throw new ApiError(`Invalid rollout shape: expected ${steps} steps, got ${rolloutNested?.length}`, 0);
    }

    // Flatten to Float32Array [steps][6][32][36]
    const totalFloats = steps * CHANNEL_COUNT * GRID.ROWS * GRID.COLS;
    const flat = new Float32Array(totalFloats);
    let idx = 0;
    for (let s = 0; s < steps; s++) {
      if (!Array.isArray(rolloutNested[s]) || rolloutNested[s].length !== CHANNEL_COUNT) {
        throw new ApiError(`Step ${s}: expected ${CHANNEL_COUNT} channels, got ${rolloutNested[s]?.length}`, 0);
      }
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        if (!Array.isArray(rolloutNested[s][ch]) || rolloutNested[s][ch].length !== GRID.ROWS) {
          throw new ApiError(`Step ${s} ch ${ch}: expected ${GRID.ROWS} rows, got ${rolloutNested[s][ch]?.length}`, 0);
        }
        for (let r = 0; r < GRID.ROWS; r++) {
          if (!Array.isArray(rolloutNested[s][ch][r]) || rolloutNested[s][ch][r].length !== GRID.COLS) {
            throw new ApiError(`Step ${s} ch ${ch} row ${r}: expected ${GRID.COLS} cols`, 0);
          }
          for (let c = 0; c < GRID.COLS; c++) {
            const val = rolloutNested[s][ch][r][c];
            if (!Number.isFinite(val)) {
              throw new ApiError(`Non-finite value at step ${s}, ch ${ch}, row ${r}, col ${c}: ${val}`, 0);
            }
            flat[idx++] = val;
          }
        }
      }
    }

    return {
      rollout: flat,
      inferenceMs,
      diagnostics: data.diagnostics || null,
    };
  }

  /**
   * Run normal and shocked simulations sequentially.
   * @param {Object} params
   * @param {number[][][]} params.initStates
   * @param {[number,number]} params.doySinCos
   * @param {number} params.steps
   * @param {number[][][]|null} params.perturbation
   * @returns {Promise<{normal, shocked}>}
   */
  async function runSimulation({ initStates, doySinCos, steps, perturbation }) {
    // Abort any in-flight request
    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    store.set('runProgress', { running: true, phase: 'normal', label: 'Run 1 of 2: normal' });
    store.emit('run:progress', store.get('runProgress'));

    let normalResult, shockedResult;

    try {
      // Run 1: normal (no perturbation)
      normalResult = await simulate(initStates, doySinCos, steps, null, signal);

      store.set('runProgress', { running: true, phase: 'shocked', label: 'Run 2 of 2: shocked' });
      store.emit('run:progress', store.get('runProgress'));

      // Run 2: shocked
      shockedResult = await simulate(initStates, doySinCos, steps, perturbation, signal);

      store.set('runProgress', { running: false, phase: null, label: '' });
      currentAbort = null;

      return {
        normal: normalResult,
        shocked: shockedResult,
      };
    } catch (err) {
      store.set('runProgress', { running: false, phase: null, label: '' });
      currentAbort = null;
      throw err;
    }
  }

  /** Cancel any in-flight simulation. */
  function abortSimulation() {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
    store.set('runProgress', { running: false, phase: null, label: '' });
  }

  /* ---------------------------------------------------------------- */
  /*  Presets and meta                                                  */
  /* ---------------------------------------------------------------- */

  async function getPresets() {
    if (config.mode === 'mock') {
      return mockEngine.getPresets ? mockEngine.getPresets() : [];
    }
    const url = `${config.apiBase}${config.endpoints.presets}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return [];
      if (!res.ok) return [];
      return await res.json();
    } catch { return []; }
  }

  async function getPreset(id) {
    if (config.mode === 'mock') {
      return mockEngine.getPreset ? mockEngine.getPreset(id) : null;
    }
    const url = `${config.apiBase}${config.endpoints.presets}/${id}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async function getMeta() {
    if (config.mode === 'mock') {
      return mockEngine.getMeta ? mockEngine.getMeta() : null;
    }
    const url = `${config.apiBase}${config.endpoints.meta}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /* ---------------------------------------------------------------- */
  /*  File upload adapter                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Load initial state from a user-uploaded JSON file.
   * Expected shape: { init_states: [3][6][32][36], doy_sincos: [sin, cos] }
   * @param {File} file
   * @returns {Promise<{initStates: number[][][][], doySinCos: [number,number]}>}
   */
  async function loadInitStateFromFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.init_states || !data.doy_sincos) {
      throw new Error('File must contain init_states and doy_sincos fields.');
    }

    // Validate shape
    const is = data.init_states;
    if (!Array.isArray(is) || is.length !== INPUT_DAYS) {
      throw new Error(`init_states must have ${INPUT_DAYS} days, got ${is?.length}`);
    }
    for (let d = 0; d < INPUT_DAYS; d++) {
      if (!Array.isArray(is[d]) || is[d].length !== CHANNEL_COUNT) {
        throw new Error(`Day ${d}: expected ${CHANNEL_COUNT} channels`);
      }
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        if (!Array.isArray(is[d][ch]) || is[d][ch].length !== GRID.ROWS) {
          throw new Error(`Day ${d} ch ${ch}: expected ${GRID.ROWS} rows`);
        }
        for (let r = 0; r < GRID.ROWS; r++) {
          if (!Array.isArray(is[d][ch][r]) || is[d][ch][r].length !== GRID.COLS) {
            throw new Error(`Day ${d} ch ${ch} row ${r}: expected ${GRID.COLS} cols`);
          }
        }
      }
    }

    const ds = data.doy_sincos;
    if (!Array.isArray(ds) || ds.length !== 2 || !Number.isFinite(ds[0]) || !Number.isFinite(ds[1])) {
      throw new Error('doy_sincos must be [sin, cos] with finite numbers.');
    }

    return { initStates: data.init_states, doySinCos: data.doy_sincos };
  }

  /* ---------------------------------------------------------------- */
  /*  Boot                                                              */
  /* ---------------------------------------------------------------- */

  // Start health polling
  checkHealth();

  return {
    checkHealth,
    simulate,
    runSimulation,
    abortSimulation,
    getPresets,
    getPreset,
    getMeta,
    loadInitStateFromFile,
    get mockEngine() { return mockEngine; },
  };
}

/** Custom error with HTTP status. */
export class ApiError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
