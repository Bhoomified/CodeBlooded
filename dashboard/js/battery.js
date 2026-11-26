/**
 * battery.js -- Physics battery: automated suite of 6 physical checks
 * run sequentially through /simulate with progress and cancel support.
 * @module battery
 */
import { BATTERY, NULL_SHOCK_EPSILON } from './constants.js';
import { buildPerturbationTensor } from './shock.js';
import { computeDifference, analyzeCausality } from './analysis.js';

let isCancelled = false;

export function cancelBattery() {
  isCancelled = true;
}

/**
 * Run all 6 battery tests sequentially.
 *
 * @param {Object} api 
 * @param {Object} baseParams - { initStates, doySinCos, steps }
 * @param {Function} onProgress - receives { testIndex, label, status }
 * @returns {Promise<Array<{ id: string, name: string, description: string, value: string, threshold: string, pass: boolean }>>}
 */
export async function runPhysicsBattery(api, baseParams, onProgress) {
  isCancelled = false;
  const results = [];
  const { initStates, doySinCos, steps } = baseParams;
  const lastDay = initStates[initStates.length - 1];

  const tests = [
    {
      id: 'null_shock',
      name: '1. Null Shock Determinism',
      description: 'Zero perturbation must produce difference below 1e-3',
      run: async () => {
        const { normal, shocked } = await api.runSimulation({ initStates, doySinCos, steps: 3, perturbation: null });
        const diff = computeDifference(normal.rollout, shocked.rollout, 3);
        let maxDiff = 0;
        for (let i = 0; i < diff.length; i++) {
          const d = Math.abs(diff[i]);
          if (d > maxDiff) maxDiff = d;
        }
        return {
          value: maxDiff.toExponential(2),
          threshold: `< ${NULL_SHOCK_EPSILON}`,
          pass: maxDiff <= NULL_SHOCK_EPSILON
        };
      }
    },
    {
      id: 'warm_ocean',
      name: '2. Warm Bay Response',
      description: 't2m & tcwv rise inside Bay of Bengal box on Day 1',
      run: async () => {
        const box = { rows: [8, 20], cols: [15, 27] };
        const { perturbation } = buildPerturbationTensor({
          box,
          channels: [{ index: 0, mode: 'additive', value: 3 }],
          lastInputDay: lastDay
        });
        const { normal, shocked } = await api.runSimulation({ initStates, doySinCos, steps: 2, perturbation });
        const diff = computeDifference(normal.rollout, shocked.rollout, 2);
        const { radiusMetrics } = analyzeCausality({ differenceBuffer: diff, steps: 2, channelIndex: 0, shockBox: box });
        const day1In3 = radiusMetrics[0].energyIn3Fraction;
        return {
          value: `${(day1In3 * 100).toFixed(1)}% local`,
          threshold: '>= 60%',
          pass: day1In3 >= 0.60
        };
      }
    },
    {
      id: 'monsoon_stall',
      name: '3. Monsoon Stall Wind Drop',
      description: 'u10 wind speed drops inside Arabian Sea box on Day 1',
      run: async () => {
        const box = { rows: [8, 22], cols: [1, 11] };
        const { perturbation } = buildPerturbationTensor({
          box,
          channels: [{ index: 2, mode: 'percent', value: -40 }],
          lastInputDay: lastDay
        });
        const { normal, shocked } = await api.runSimulation({ initStates, doySinCos, steps: 2, perturbation });
        const diff = computeDifference(normal.rollout, shocked.rollout, 2);
        const { radiusMetrics } = analyzeCausality({ differenceBuffer: diff, steps: 2, channelIndex: 2, shockBox: box });
        const day1Local = radiusMetrics[0].energyIn3Fraction;
        return {
          value: `${(day1Local * 100).toFixed(1)}% in box`,
          threshold: '>= 60%',
          pass: day1Local >= 0.60
        };
      }
    },
    {
      id: 'linearity',
      name: '4. Shock Linearity Ratio',
      description: 'Half-magnitude shock produces 20-35% energy ratio',
      run: async () => {
        const box = { rows: [8, 20], cols: [15, 27] };
        const full = buildPerturbationTensor({ box, channels: [{ index: 0, mode: 'additive', value: 3 }], lastInputDay: lastDay });
        const half = buildPerturbationTensor({ box, channels: [{ index: 0, mode: 'additive', value: 1.5 }], lastInputDay: lastDay });

        const rFull = await api.runSimulation({ initStates, doySinCos, steps: 1, perturbation: full.perturbation });
        const rHalf = await api.runSimulation({ initStates, doySinCos, steps: 1, perturbation: half.perturbation });

        const dFull = computeDifference(rFull.normal.rollout, rFull.shocked.rollout, 1);
        const dHalf = computeDifference(rHalf.normal.rollout, rHalf.shocked.rollout, 1);

        let eFull = 0, eHalf = 0;
        for (let i = 0; i < dFull.length; i++) {
          eFull += dFull[i] * dFull[i];
          eHalf += dHalf[i] * dHalf[i];
        }
        const ratio = eFull > 0 ? eHalf / eFull : 0;
        return {
          value: ratio.toFixed(2),
          threshold: `${BATTERY.LINEARITY_ENERGY_RATIO_MIN} - ${BATTERY.LINEARITY_ENERGY_RATIO_MAX}`,
          pass: ratio >= BATTERY.LINEARITY_ENERGY_RATIO_MIN && ratio <= BATTERY.LINEARITY_ENERGY_RATIO_MAX
        };
      }
    },
    {
      id: 'symmetry',
      name: '5. Perturbation Symmetry',
      description: '+3 K vs -3 K response correlation below -0.8',
      run: async () => {
        const box = { rows: [8, 20], cols: [15, 27] };
        const pos = buildPerturbationTensor({ box, channels: [{ index: 0, mode: 'additive', value: 3 }], lastInputDay: lastDay });
        const neg = buildPerturbationTensor({ box, channels: [{ index: 0, mode: 'additive', value: -3 }], lastInputDay: lastDay });

        const rPos = await api.runSimulation({ initStates, doySinCos, steps: 1, perturbation: pos.perturbation });
        const rNeg = await api.runSimulation({ initStates, doySinCos, steps: 1, perturbation: neg.perturbation });

        const dPos = computeDifference(rPos.normal.rollout, rPos.shocked.rollout, 1);
        const dNeg = computeDifference(rNeg.normal.rollout, rNeg.shocked.rollout, 1);

        let dot = 0, nPos = 0, nNeg = 0;
        for (let i = 0; i < dPos.length; i++) {
          dot += dPos[i] * dNeg[i];
          nPos += dPos[i] * dPos[i];
          nNeg += dNeg[i] * dNeg[i];
        }
        const denom = Math.sqrt(nPos * nNeg);
        const corr = denom > 0 ? dot / denom : 0;
        return {
          value: corr.toFixed(2),
          threshold: `< ${BATTERY.SYMMETRY_CORRELATION_MAX}`,
          pass: corr <= BATTERY.SYMMETRY_CORRELATION_MAX
        };
      }
    },
    {
      id: 'local_low',
      name: '6. Low Pressure Moistening',
      description: '-500 Pa MSL over Bay causes moisture/rain rise by Day 2',
      run: async () => {
        const box = { rows: [10, 18], cols: [17, 25] };
        const { perturbation } = buildPerturbationTensor({
          box,
          channels: [{ index: 4, mode: 'additive', value: -500 }],
          lastInputDay: lastDay
        });
        const { normal, shocked } = await api.runSimulation({ initStates, doySinCos, steps: 2, perturbation });
        const diff = computeDifference(normal.rollout, shocked.rollout, 2);
        const { radiusMetrics } = analyzeCausality({ differenceBuffer: diff, steps: 2, channelIndex: 5, shockBox: box });
        const stable = radiusMetrics[1].r90 <= radiusMetrics[1].limitRadius;
        return {
          value: `r90: ${radiusMetrics[1].r90}`,
          threshold: `<= ${radiusMetrics[1].limitRadius}`,
          pass: stable
        };
      }
    }
  ];

  for (let i = 0; i < tests.length; i++) {
    if (isCancelled) break;
    const t = tests[i];
    if (onProgress) onProgress({ index: i, total: tests.length, label: t.name, running: true });

    try {
      const outcome = await t.run();
      results.push({
        id: t.id,
        name: t.name,
        description: t.description,
        value: outcome.value,
        threshold: outcome.threshold,
        pass: outcome.pass
      });
    } catch (e) {
      results.push({
        id: t.id,
        name: t.name,
        description: t.description,
        value: 'Error',
        threshold: '',
        pass: false
      });
    }
  }

  return results;
}
