/**
 * blur.js -- Blur monitor: computes spatial standard deviation of each channel per day
 * relative to day 1 of the normal run. Highlights channels whose ratio drops below 0.4.
 * @module blur
 */
import { GRID, CHANNEL_COUNT, CHANNELS, BLUR_RATIO_THRESHOLD } from './constants.js';
import { flatIndexStep } from './grid.js';

/**
 * Compute spatial standard deviation of a 2D channel slice.
 * @param {Float32Array} buffer 
 * @param {number} step 
 * @param {number} ch 
 * @returns {number}
 */
export function spatialStd(buffer, step, ch) {
  const n = GRID.TOTAL_CELLS;
  let sum = 0;
  for (let r = 0; r < GRID.ROWS; r++) {
    for (let c = 0; c < GRID.COLS; c++) {
      sum += buffer[flatIndexStep(step, ch, r, c)];
    }
  }
  const mean = sum / n;
  let varSum = 0;
  for (let r = 0; r < GRID.ROWS; r++) {
    for (let c = 0; c < GRID.COLS; c++) {
      const diff = buffer[flatIndexStep(step, ch, r, c)] - mean;
      varSum += diff * diff;
    }
  }
  return Math.sqrt(varSum / n);
}

/**
 * Compute blur metrics across all steps for a rollout.
 * @param {Float32Array} normalRollout 
 * @param {number} steps 
 * @returns {Array<{ day: number, channels: Array<{ key: string, name: string, std: number, ratio: number, flagged: boolean }> }>}
 */
export function computeBlurMetrics(normalRollout, steps) {
  const results = [];
  const baseStds = [];

  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    baseStds.push(spatialStd(normalRollout, 0, ch) || 1e-5);
  }

  for (let s = 0; s < steps; s++) {
    const chResults = [];
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const curStd = spatialStd(normalRollout, s, ch);
      const ratio = curStd / baseStds[ch];
      chResults.push({
        key: CHANNELS[ch].key,
        name: CHANNELS[ch].name,
        std: parseFloat(curStd.toFixed(2)),
        ratio: parseFloat(ratio.toFixed(2)),
        flagged: ratio < BLUR_RATIO_THRESHOLD
      });
    }
    results.push({ day: s, channels: chResults });
  }

  return results;
}
