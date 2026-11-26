/**
 * impact.js -- Sectoral impact metrics:
 * 1. Monsoon Rainfall Deficit: Cumulative tp difference (shocked - normal) aggregated by state and nationally.
 * 2. Heat Risk: Count of days with daily-mean t2m > 308 K per land cell and state.
 * @module impact
 */
import { GRID, HEAT_RISK_THRESHOLD_K } from './constants.js';
import { flatIndexStep } from './grid.js';

/**
 * Compute monsoon deficit and heat risk impacts.
 *
 * @param {Object} params
 * @param {Float32Array} params.normalRollout
 * @param {Float32Array} params.shockedRollout
 * @param {number} params.steps
 * @param {Uint8Array} params.landMask - [32*36]
 * @param {{ assignments: Int8Array, names: string[] }} params.stateData
 * @returns {Object}
 */
export function computeImpacts({ normalRollout, shockedRollout, steps, landMask, stateData }) {
  const { assignments, names } = stateData;
  const numStates = names.length;

  const stateTpNormal = new Float64Array(numStates);
  const stateTpShocked = new Float64Array(numStates);
  const stateCellCount = new Int32Array(numStates);

  const stateHeatDaysNormal = new Float64Array(numStates);
  const stateHeatDaysShocked = new Float64Array(numStates);

  let nationalTpNormal = 0;
  let nationalTpShocked = 0;
  let totalLandCells = 0;

  // Grid heat days count [32*36]
  const cellHeatDaysNormal = new Int16Array(GRID.TOTAL_CELLS);
  const cellHeatDaysShocked = new Int16Array(GRID.TOTAL_CELLS);

  for (let r = 0; r < GRID.ROWS; r++) {
    for (let c = 0; c < GRID.COLS; c++) {
      const idx = r * GRID.COLS + c;
      const isLand = landMask[idx] === 1;
      const stIdx = assignments[idx];

      if (isLand) {
        totalLandCells++;
        if (stIdx >= 0) stateCellCount[stIdx]++;
      }

      let cellTpNormSum = 0;
      let cellTpShockSum = 0;

      for (let s = 0; s < steps; s++) {
        // tp (channel 1)
        const tpN = normalRollout[flatIndexStep(s, 1, r, c)];
        const tpS = shockedRollout[flatIndexStep(s, 1, r, c)];
        cellTpNormSum += tpN;
        cellTpShockSum += tpS;

        // t2m (channel 0)
        const t2mN = normalRollout[flatIndexStep(s, 0, r, c)];
        const t2mS = shockedRollout[flatIndexStep(s, 0, r, c)];

        if (t2mN > HEAT_RISK_THRESHOLD_K) cellHeatDaysNormal[idx]++;
        if (t2mS > HEAT_RISK_THRESHOLD_K) cellHeatDaysShocked[idx]++;
      }

      if (isLand) {
        nationalTpNormal += cellTpNormSum;
        nationalTpShocked += cellTpShockSum;

        if (stIdx >= 0) {
          stateTpNormal[stIdx] += cellTpNormSum;
          stateTpShocked[stIdx] += cellTpShockSum;
          stateHeatDaysNormal[stIdx] += cellHeatDaysNormal[idx];
          stateHeatDaysShocked[stIdx] += cellHeatDaysShocked[idx];
        }
      }
    }
  }

  // Compile state ranking list for rainfall deficit
  const stateDeficits = [];
  for (let i = 0; i < numStates; i++) {
    if (stateCellCount[i] > 0) {
      const avgNorm = stateTpNormal[i] / stateCellCount[i];
      const avgShock = stateTpShocked[i] / stateCellCount[i];
      const diff = avgShock - avgNorm;
      const pct = avgNorm > 0 ? (diff / avgNorm) * 100 : 0;

      const avgHeatNorm = stateHeatDaysNormal[i] / stateCellCount[i];
      const avgHeatShock = stateHeatDaysShocked[i] / stateCellCount[i];

      stateDeficits.push({
        state: names[i],
        cells: stateCellCount[i],
        normalMm: parseFloat(avgNorm.toFixed(1)),
        shockedMm: parseFloat(avgShock.toFixed(1)),
        deltaMm: parseFloat(diff.toFixed(1)),
        deltaPercent: parseFloat(pct.toFixed(1)),
        heatDaysNormal: parseFloat(avgHeatNorm.toFixed(1)),
        heatDaysShocked: parseFloat(avgHeatShock.toFixed(1)),
        heatDaysDelta: parseFloat((avgHeatShock - avgHeatNorm).toFixed(1))
      });
    }
  }

  // Sort descending by highest negative deficit
  stateDeficits.sort((a, b) => a.deltaMm - b.deltaMm);

  const nationalAvgNorm = totalLandCells > 0 ? nationalTpNormal / totalLandCells : 0;
  const nationalAvgShock = totalLandCells > 0 ? nationalTpShocked / totalLandCells : 0;
  const nationalDeltaMm = nationalAvgShock - nationalAvgNorm;
  const nationalDeltaPct = nationalAvgNorm > 0 ? (nationalDeltaMm / nationalAvgNorm) * 100 : 0;

  return {
    rainfall: {
      national: {
        normalMm: parseFloat(nationalAvgNorm.toFixed(1)),
        shockedMm: parseFloat(nationalAvgShock.toFixed(1)),
        deltaMm: parseFloat(nationalDeltaMm.toFixed(1)),
        deltaPercent: parseFloat(nationalDeltaPct.toFixed(1))
      },
      states: stateDeficits
    },
    heatRisk: {
      cellHeatDaysNormal,
      cellHeatDaysShocked
    }
  };
}
