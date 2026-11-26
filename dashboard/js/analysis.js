/**
 * analysis.js -- Difference field calculations, energy metrics, and causality checks.
 * Authoritative checks follow Track 2's physics evaluation criteria.
 * @module analysis
 */
import { GRID, CHANNEL_COUNT, CAUSALITY, limitRadius, CHANNELS, BATTERY } from './constants.js';
import { flatIndexStep, cellCenter } from './grid.js';

/**
 * Compute difference tensor (Shocked - Normal) as a flat Float32Array.
 * Shape: [steps][6][32][36].
 * @param {Float32Array} normalRollout 
 * @param {Float32Array} shockedRollout 
 * @param {number} steps 
 * @returns {Float32Array}
 */
export function computeDifference(normalRollout, shockedRollout, steps) {
  const size = steps * CHANNEL_COUNT * GRID.ROWS * GRID.COLS;
  const diff = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    diff[i] = shockedRollout[i] - normalRollout[i];
  }
  return diff;
}

/**
 * Compute response radius (r90), energy distribution, and causality metrics per day.
 *
 * @param {Object} params
 * @param {Float32Array} params.differenceBuffer
 * @param {number} params.steps
 * @param {number} params.channelIndex
 * @param {{ rows: [number, number], cols: [number, number] }} params.shockBox
 * @returns {{ radiusMetrics: Array, causalityChecks: Object, maxGrowthRate: number }}
 */
export function analyzeCausality({ differenceBuffer, steps, channelIndex, shockBox }) {
  const radiusMetrics = [];
  let prevR90 = null;
  let maxGrowthRate = 0;

  let day1EnergyTotal = 0;
  let day1EnergyIn3 = 0;
  let lateOutsideEnergy = 0;
  let day1OutsideEnergy = 0;

  const boxCenterR = shockBox ? (shockBox.rows[0] + shockBox.rows[1]) / 2 : GRID.ROWS / 2;
  const boxCenterC = shockBox ? (shockBox.cols[0] + shockBox.cols[1]) / 2 : GRID.COLS / 2;

  let allFinite = true;
  let noTeleportPass = true;

  for (let s = 0; s < steps; s++) {
    const limit = limitRadius(s);
    let totalE = 0;
    let energyIn3 = 0;
    let energyBeyondLimit = 0;

    // Collect cell energy (delta^2) with distance from box center
    const cellList = [];

    for (let r = 0; r < GRID.ROWS; r++) {
      for (let c = 0; c < GRID.COLS; c++) {
        const val = differenceBuffer[flatIndexStep(s, channelIndex, r, c)];
        if (!Number.isFinite(val)) {
          allFinite = false;
        }

        const e = val * val;
        totalE += e;

        // Chebyshev distance from box boundaries (or Euclidean from center)
        let dist = 0;
        if (shockBox) {
          const dr = Math.max(0, shockBox.rows[0] - r, r - shockBox.rows[1]);
          const dc = Math.max(0, shockBox.cols[0] - c, c - shockBox.cols[1]);
          dist = Math.max(dr, dc);
        } else {
          dist = Math.hypot(r - boxCenterR, c - boxCenterC);
        }

        if (dist <= 3) energyIn3 += e;
        if (dist > limit) energyBeyondLimit += e;

        cellList.push({ dist, e });
      }
    }

    // Sort by distance to find r90 (radius containing 90% of total energy)
    cellList.sort((a, b) => a.dist - b.dist);
    let cum = 0;
    let r90 = 0;
    const target90 = totalE * 0.90;

    for (const item of cellList) {
      cum += item.e;
      if (cum >= target90) {
        r90 = item.dist;
        break;
      }
    }

    let growthRate = 0;
    if (prevR90 !== null) {
      growthRate = r90 - prevR90;
      if (growthRate > maxGrowthRate) maxGrowthRate = growthRate;
    }
    prevR90 = r90;

    if (totalE > 0 && (energyBeyondLimit / totalE) >= CAUSALITY.NO_TELEPORT_MAX_BEYOND_FRAC) {
      noTeleportPass = false;
    }

    if (s === 0) {
      day1EnergyTotal = totalE;
      day1EnergyIn3 = energyIn3;
      day1OutsideEnergy = totalE - energyIn3;
    }

    if (s >= Math.min(3, steps - 1)) {
      lateOutsideEnergy = Math.max(lateOutsideEnergy, totalE - energyIn3);
    }

    radiusMetrics.push({
      day: s,
      r90: parseFloat(r90.toFixed(2)),
      totalEnergy: totalE,
      energyIn3Fraction: totalE > 0 ? (energyIn3 / totalE) : 1,
      limitRadius: limit,
      growthRate: parseFloat(growthRate.toFixed(2))
    });
  }

  // Causality chips
  const localized = day1EnergyTotal === 0 || (day1EnergyIn3 / day1EnergyTotal) >= CAUSALITY.LOCALIZED_MIN_ENERGY_FRAC;
  const noTeleport = noTeleportPass;
  const propagates = day1EnergyTotal === 0 || (lateOutsideEnergy >= day1OutsideEnergy * CAUSALITY.PROPAGATES_LATE_RATIO);
  const stable = allFinite && maxGrowthRate <= CAUSALITY.R90_MAX_GROWTH_PER_DAY;

  return {
    radiusMetrics,
    causalityChecks: {
      localized,
      noTeleport,
      propagates,
      stable
    },
    maxGrowthRate
  };
}
