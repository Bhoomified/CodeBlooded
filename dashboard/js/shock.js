/**
 * shock.js -- Shock Painter logic.
 * Handles drag-box selection, grid snapping, 3 shock modes (additive, percent, multiplier),
 * physical clipping preview, edge band detection, and perturbation tensor generation.
 * @module shock
 */
import { GRID, CHANNEL_COUNT, EDGE_BAND_CELLS, CHANNELS, channelByKey } from './constants.js';
import { latToRow, lonToCol, rowToLat, colToLon, flatIndex, isEdgeBand } from './grid.js';

let presetsData = null;

/**
 * Load declarative presets from shock-presets.json.
 */
export async function loadShockPresets() {
  try {
    const res = await fetch('js/shock-presets.json');
    if (res.ok) {
      presetsData = await res.json();
      return presetsData.presets || [];
    }
  } catch (e) {
    console.warn('Failed to load shock-presets.json', e);
  }
  return [];
}

/**
 * Snap raw lat/lon bounding box to grid cells using the kit's rule (contract.box_mask):
 * a cell is in the box when its centre lies inside [min, max]. So "8-20 N, 82-94 E" covers
 * centres 8.5-19.5 N and 82.5-93.5 E, the same cells the organisers' warm_ocean shock uses.
 * A box smaller than one cell falls back to the nearest cell.
 * @param {{ latMin: number, latMax: number, lonMin: number, lonMax: number }} rawBounds 
 */
export function snapToGrid(rawBounds) {
  const la0 = Math.min(rawBounds.latMin, rawBounds.latMax), la1 = Math.max(rawBounds.latMin, rawBounds.latMax);
  const lo0 = Math.min(rawBounds.lonMin, rawBounds.lonMax), lo1 = Math.max(rawBounds.lonMin, rawBounds.lonMax);
  const clampR = (r) => Math.max(0, Math.min(GRID.ROWS - 1, r));
  const clampC = (c) => Math.max(0, Math.min(GRID.COLS - 1, c));
  let rMin = clampR(Math.ceil((la0 - GRID.LAT_MIN) / GRID.CELL_SIZE - 1e-9));
  let rMax = clampR(Math.floor((la1 - GRID.LAT_MIN) / GRID.CELL_SIZE + 1e-9));
  let cMin = clampC(Math.ceil((lo0 - GRID.LON_MIN) / GRID.CELL_SIZE - 1e-9));
  let cMax = clampC(Math.floor((lo1 - GRID.LON_MIN) / GRID.CELL_SIZE + 1e-9));
  if (rMin > rMax) { rMin = rMax = latToRow((la0 + la1) / 2); }
  if (cMin > cMax) { cMin = cMax = lonToCol((lo0 + lo1) / 2); }

  return {
    latMin: rowToLat(rMin) - 0.5,
    latMax: rowToLat(rMax) + 0.5,
    lonMin: colToLon(cMin) - 0.5,
    lonMax: colToLon(cMax) + 0.5,
    rows: [rMin, rMax],
    cols: [cMin, cMax]
  };
}

/**
 * Check if the shock box overlaps the 3-cell domain edge band.
 * @param {[number, number]} rowRange 
 * @param {[number, number]} colRange 
 * @returns {boolean}
 */
export function checkEdgeBandOverlap(rowRange, colRange) {
  const [r0, r1] = rowRange;
  const [c0, c1] = colRange;
  return (
    r0 < EDGE_BAND_CELLS || r1 >= GRID.ROWS - EDGE_BAND_CELLS ||
    c0 < EDGE_BAND_CELLS || c1 >= GRID.COLS - EDGE_BAND_CELLS
  );
}

/**
 * Build the [6][32][36] perturbation nested array.
 * Converts percent and multiplier modes to additive deltas using init_states[-1].
 * Clips effective shock to physical envelope and counts clipped cells.
 *
 * @param {Object} options
 * @param {{ rows: [number, number], cols: [number, number] } | null} options.box
 * @param {Array<{ index: number, mode: 'additive'|'percent'|'multiplier', value: number }>} options.channels
 * @param {number[][][]} options.lastInputDay - [6][32][36]
 * @param {boolean} [options.softEdge=false]
 * @returns {{ perturbation: number[][][], clippedCount: number, edgeBandWarn: boolean }}
 */
export function buildPerturbationTensor({ box, channels, lastInputDay, softEdge = false }) {
  // Empty perturbation tensor [6][32][36]
  const tensor = [];
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const chData = [];
    for (let r = 0; r < GRID.ROWS; r++) {
      chData.push(new Array(GRID.COLS).fill(0));
    }
    tensor.push(chData);
  }

  if (!box || !channels || channels.length === 0) {
    return { perturbation: tensor, clippedCount: 0, edgeBandWarn: false };
  }

  const [r0, r1] = box.rows;
  const [c0, c1] = box.cols;
  const edgeBandWarn = checkEdgeBandOverlap(box.rows, box.cols);

  let clippedCount = 0;

  for (const chConf of channels) {
    const chMeta = CHANNELS[chConf.index];
    if (!chMeta) continue;

    const [envMin, envMax] = chMeta.physicalEnvelope;

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const baseVal = lastInputDay ? lastInputDay[chConf.index][r][c] : 0;
        let delta = 0;

        if (chConf.mode === 'percent') {
          delta = (chConf.value / 100) * baseVal;
        } else if (chConf.mode === 'multiplier') {
          delta = (chConf.value - 1) * baseVal;
        } else {
          delta = Number(chConf.value) || 0;
        }

        // Soft edge attenuation if selected
        if (softEdge) {
          const distToEdge = Math.min(r - r0, r1 - r, c - c0, c1 - c);
          if (distToEdge === 0) delta *= 0.5;
        }

        // Envelope clipping preview
        const targetVal = baseVal + delta;
        if (targetVal < envMin) {
          delta = envMin - baseVal;
          clippedCount++;
        } else if (targetVal > envMax) {
          delta = envMax - baseVal;
          clippedCount++;
        }

        tensor[chConf.index][r][c] = delta;
      }
    }
  }

  return { perturbation: tensor, clippedCount, edgeBandWarn };
}

/**
 * Generate a random "Judge Shock" preset within sane physical boundaries.
 */
export function generateRandomJudgeShock() {
  const r0 = Math.floor(Math.random() * (GRID.ROWS - 10)) + 2;
  const rSpan = Math.floor(Math.random() * 6) + 3;
  const c0 = Math.floor(Math.random() * (GRID.COLS - 10)) + 2;
  const cSpan = Math.floor(Math.random() * 6) + 3;

  const chIndex = Math.floor(Math.random() * CHANNEL_COUNT);
  const ch = CHANNELS[chIndex];
  const delta = (Math.random() * 0.6 + 0.2) * (ch.shockRange.max - ch.shockRange.min) + ch.shockRange.min;

  return {
    label: `Random Shock: ${ch.name}`,
    box: {
      latMin: rowToLat(r0) - 0.5,
      latMax: rowToLat(Math.min(GRID.ROWS - 1, r0 + rSpan)) + 0.5,
      lonMin: colToLon(c0) - 0.5,
      lonMax: colToLon(Math.min(GRID.COLS - 1, c0 + cSpan)) + 0.5,
      rows: [r0, Math.min(GRID.ROWS - 1, r0 + rSpan)],
      cols: [c0, Math.min(GRID.COLS - 1, c0 + cSpan)]
    },
    channels: [{ index: chIndex, mode: 'additive', value: parseFloat(delta.toFixed(1)) }],
    softEdge: false
  };
}
