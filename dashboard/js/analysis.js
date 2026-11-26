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

/**
 * The organisers' four causality checks, computed exactly as the kit's scoring.causality_checks does:
 * response energy summed over all six channels in units of channel std, "near" = the box grown by
 * 3 cells (4-neighbour steps), teleport radius = 3 + 8*(k+1) cells (Euclidean, to the nearest box cell).
 *
 * @param {Object} params
 * @param {Float32Array} params.differenceBuffer - shocked minus normal, [steps][6][32][36]
 * @param {number} params.steps
 * @param {{ rows: [number, number], cols: [number, number] } | null} params.shockBox
 * @param {number[] | null} [params.channelStds] - from presets/meta.json; falls back to approxStd
 * @returns {{ localized: boolean, noTeleport: boolean, propagates: boolean, stable: boolean,
 *            nearFracDay1: number, farFracMax: number, maxStdRatio: number }}
 */
export function kitCausalityChecks({ differenceBuffer, steps, shockBox, channelStds = null }) {
  const R = GRID.ROWS, C = GRID.COLS, N = R * C;
  const DILATE = 3, SPEED = 8, LOCAL_MIN = 0.60, STABLE_MAX = 5.0;
  const stds = CHANNELS.map((ch, i) => (channelStds && channelStds[i] > 0) ? channelStds[i] : ch.approxStd);

  // Energy per day and cell, plus the largest |delta| in stds
  const energy = [];
  let finite = true;
  let maxStdRatio = 0;
  for (let s = 0; s < steps; s++) {
    const e = new Float64Array(N);
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      for (let i = 0; i < N; i++) {
        const v = differenceBuffer[s * CHANNEL_COUNT * N + ch * N + i];
        if (!Number.isFinite(v)) { finite = false; continue; }
        const z = v / stds[ch];
        e[i] += z * z;
        if (Math.abs(z) > maxStdRatio) maxStdRatio = Math.abs(z);
      }
    }
    energy.push(e);
  }
  const stable = finite && maxStdRatio <= STABLE_MAX;

  // No box (null shock): nothing to localise or propagate
  if (!shockBox) {
    return { localized: true, noTeleport: true, propagates: true, stable, nearFracDay1: 1, farFracMax: 0, maxStdRatio };
  }

  // Box mask, its 3-cell neighbourhood and each cell's distance to the nearest box cell
  const [r0, r1] = shockBox.rows, [c0, c1] = shockBox.cols;
  let near = new Uint8Array(N);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) near[r * C + c] = 1;
  for (let k = 0; k < DILATE; k++) {
    const o = near.slice();
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (!near[r * C + c]) continue;
      if (r > 0) o[(r - 1) * C + c] = 1;
      if (r < R - 1) o[(r + 1) * C + c] = 1;
      if (c > 0) o[r * C + c - 1] = 1;
      if (c < C - 1) o[r * C + c + 1] = 1;
    }
    near = o;
  }
  const dist = new Float64Array(N);
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const dr = Math.max(0, r0 - r, r - r1), dc = Math.max(0, c0 - c, c - c1);
    dist[r * C + c] = Math.hypot(dr, dc);
  }

  const sum = (e, pick) => { let t = 0; for (let i = 0; i < N; i++) if (pick(i)) t += e[i]; return t; };
  const tot1 = sum(energy[0], () => true);
  const nearFracDay1 = tot1 > 0 ? sum(energy[0], i => near[i]) / tot1 : 0;
  const localized = tot1 > 0 && nearFracDay1 >= LOCAL_MIN;

  const outE = energy.map(e => sum(e, i => !near[i]));
  const late = steps >= 8 ? (outE[3] + outE[4] + outE[5] + outE[6] + outE[7]) / 5 : outE[steps - 1];
  const maxTotal = Math.max(...energy.map(e => sum(e, () => true)), 1e-12);
  const grows = late > 1.5 * outE[0] + 1e-12 && late > 0.02 * maxTotal;

  let farFracMax = 0;
  energy.forEach((e, k) => {
    const lim = DILATE + SPEED * (k + 1);
    const frac = sum(e, i => dist[i] > lim) / Math.max(sum(e, () => true), 1e-12);
    if (frac > farFracMax) farFracMax = frac;
  });
  const noTeleport = farFracMax < 0.05;

  return { localized, noTeleport, propagates: grows && noTeleport, stable, nearFracDay1, farFracMax, maxStdRatio };
}
