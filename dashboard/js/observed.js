/**
 * observed.js -- Truth comparison module: handles observed reanalysis fields,
 * latitude-weighted RMSE computation vs persistence, and training badge management.
 * @module observed
 */
import { GRID, CHANNEL_COUNT, CHANNELS } from './constants.js';
import { flatIndexStep, cosLatWeights } from './grid.js';

/**
 * Compute latitude-weighted Root Mean Square Error (RMSE) for a channel between prediction and truth.
 * Weights are proportional to cos(latitude).
 *
 * @param {Float32Array} predBuffer 
 * @param {Float32Array} truthBuffer 
 * @param {number} step 
 * @param {number} ch 
 * @returns {number}
 */
export function latWeightedRmse(predBuffer, truthBuffer, step, ch) {
  const weights = cosLatWeights();
  let weightedErrorSum = 0;
  let weightSum = 0;

  for (let r = 0; r < GRID.ROWS; r++) {
    const w = weights[r];
    for (let c = 0; c < GRID.COLS; c++) {
      const diff = predBuffer[flatIndexStep(step, ch, r, c)] - truthBuffer[flatIndexStep(step, ch, r, c)];
      weightedErrorSum += w * (diff * diff);
      weightSum += w;
    }
  }

  return Math.sqrt(weightedErrorSum / weightSum);
}

/**
 * Compute model vs persistence error-growth across forecast steps.
 * @param {Float32Array} modelRollout 
 * @param {Float32Array} truthRollout 
 * @param {number[][][]} initStates - [3][6][32][36]
 * @param {number} steps 
 * @returns {Array<{ day: number, channels: Object }>}
 */
export function computeObservedMetrics(modelRollout, truthRollout, initStates, steps) {
  // Construct persistence buffer (repeats last input day [2])
  const lastInput = initStates[initStates.length - 1];
  const persistBuffer = new Float32Array(steps * CHANNEL_COUNT * GRID.TOTAL_CELLS);
  for (let s = 0; s < steps; s++) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      for (let r = 0; r < GRID.ROWS; r++) {
        for (let c = 0; c < GRID.COLS; c++) {
          persistBuffer[flatIndexStep(s, ch, r, c)] = lastInput[ch][r][c];
        }
      }
    }
  }

  const series = [];
  for (let s = 0; s < steps; s++) {
    const chMetrics = {};
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const modelRmse = latWeightedRmse(modelRollout, truthRollout, s, ch);
      const persistRmse = latWeightedRmse(persistBuffer, truthRollout, s, ch);
      chMetrics[CHANNELS[ch].key] = {
        model: parseFloat(modelRmse.toFixed(3)),
        persistence: parseFloat(persistRmse.toFixed(3))
      };
    }
    series.push({ day: s, metrics: chMetrics });
  }

  return series;
}
