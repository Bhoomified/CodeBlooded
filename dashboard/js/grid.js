/**
 * grid.js -- Grid geometry utilities.
 * 32 rows (south-to-north, row 0 = 6.5 N), 36 columns (west-to-east, col 0 = 65.5 E).
 * @module grid
 */
import { GRID, CHANNEL_COUNT, EDGE_BAND_CELLS } from './constants.js';

/* ------------------------------------------------------------------ */
/*  Coordinate conversions                                             */
/* ------------------------------------------------------------------ */

/** Row index -> latitude of cell centre. Row 0 = LAT_MIN (south). */
export function rowToLat(row) {
  return GRID.LAT_MIN + row * GRID.CELL_SIZE;
}

/** Column index -> longitude of cell centre. Col 0 = LON_MIN (west). */
export function colToLon(col) {
  return GRID.LON_MIN + col * GRID.CELL_SIZE;
}

/** Latitude -> nearest row index (clamped to [0, ROWS-1]). */
export function latToRow(lat) {
  return Math.max(0, Math.min(GRID.ROWS - 1, Math.round(lat - GRID.LAT_MIN)));
}

/** Longitude -> nearest column index (clamped to [0, COLS-1]). */
export function lonToCol(lon) {
  return Math.max(0, Math.min(GRID.COLS - 1, Math.round(lon - GRID.LON_MIN)));
}

/** Cell centre as { lat, lon }. */
export function cellCenter(row, col) {
  return { lat: rowToLat(row), lon: colToLon(col) };
}

/**
 * Cell bounding polygon as a closed ring of [lon, lat] pairs (5 points).
 * Suitable for GeoJSON Polygon coordinates.
 */
export function cellBounds(row, col) {
  const lat = rowToLat(row);
  const lon = colToLon(col);
  const h = GRID.CELL_SIZE / 2;
  return [
    [lon - h, lat - h],
    [lon + h, lat - h],
    [lon + h, lat + h],
    [lon - h, lat + h],
    [lon - h, lat - h],
  ];
}

/* ------------------------------------------------------------------ */
/*  Flat-array indexing                                                 */
/* ------------------------------------------------------------------ */

/** Index into a flat [C][R][COL] buffer (single step). */
export function flatIndex(channel, row, col) {
  return channel * GRID.ROWS * GRID.COLS + row * GRID.COLS + col;
}

/** Index into a flat [steps][C][R][COL] buffer (multi-step rollout). */
export function flatIndexStep(step, channel, row, col) {
  const cellsPerChannel = GRID.ROWS * GRID.COLS;
  const cellsPerStep = CHANNEL_COUNT * cellsPerChannel;
  return step * cellsPerStep + channel * cellsPerChannel + row * GRID.COLS + col;
}

/** Number of floats in one step slice: CHANNEL_COUNT * ROWS * COLS. */
export const STEP_SIZE = CHANNEL_COUNT * GRID.ROWS * GRID.COLS;

/** Number of floats in one channel slice: ROWS * COLS. */
export const CHANNEL_SIZE = GRID.ROWS * GRID.COLS;

/* ------------------------------------------------------------------ */
/*  Edge band                                                          */
/* ------------------------------------------------------------------ */

/** True if the cell is within EDGE_BAND_CELLS of the domain border. */
export function isEdgeBand(row, col) {
  return (
    row < EDGE_BAND_CELLS || row >= GRID.ROWS - EDGE_BAND_CELLS ||
    col < EDGE_BAND_CELLS || col >= GRID.COLS - EDGE_BAND_CELLS
  );
}

/* ------------------------------------------------------------------ */
/*  GeoJSON grid                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a GeoJSON FeatureCollection of all 1,152 grid cells.
 * Each Feature has properties { row, col, lat, lon, value, height, edge }.
 * The value and height are initialised to 0 and updated at render time.
 */
export function buildGridGeoJSON() {
  const features = new Array(GRID.TOTAL_CELLS);
  let i = 0;
  for (let r = 0; r < GRID.ROWS; r++) {
    for (let c = 0; c < GRID.COLS; c++) {
      const center = cellCenter(r, c);
      features[i++] = {
        type: 'Feature',
        properties: {
          row: r, col: c,
          lat: center.lat, lon: center.lon,
          value: 0, height: 0, color: '#333333',
          edge: isEdgeBand(r, c) ? 1 : 0,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [cellBounds(r, c)],
        },
      };
    }
  }
  return { type: 'FeatureCollection', features };
}

/* ------------------------------------------------------------------ */
/*  Latitude weights                                                   */
/* ------------------------------------------------------------------ */

/**
 * Cosine-of-latitude weights for latitude-weighted metrics (e.g., RMSE).
 * @returns {Float32Array} Length ROWS, weights proportional to cos(lat).
 */
export function cosLatWeights() {
  const w = new Float32Array(GRID.ROWS);
  const d2r = Math.PI / 180;
  for (let r = 0; r < GRID.ROWS; r++) {
    w[r] = Math.cos(rowToLat(r) * d2r);
  }
  return w;
}

/* ------------------------------------------------------------------ */
/*  Point-in-polygon (winding number)                                  */
/* ------------------------------------------------------------------ */

/**
 * Winding-number point-in-polygon test.
 * @param {{ lat: number, lon: number }} pt
 * @param {number[][]} ring - Array of [lon, lat] pairs (closed)
 * @returns {boolean}
 */
export function pointInPolygon(pt, ring) {
  let w = 0;
  const px = pt.lon, py = pt.lat;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const y1 = ring[i][1], y2 = ring[i + 1][1];
    if (y1 <= py) {
      if (y2 > py) {
        const cp = (ring[i + 1][0] - ring[i][0]) * (py - y1)
                 - (px - ring[i][0]) * (y2 - y1);
        if (cp > 0) w++;
      }
    } else {
      if (y2 <= py) {
        const cp = (ring[i + 1][0] - ring[i][0]) * (py - y1)
                 - (px - ring[i][0]) * (y2 - y1);
        if (cp < 0) w--;
      }
    }
  }
  return w !== 0;
}

/* ------------------------------------------------------------------ */
/*  Land mask and state assignments                                    */
/* ------------------------------------------------------------------ */

/**
 * Extract all polygon rings from a GeoJSON structure.
 * @param {Object} geojson - Feature, FeatureCollection, or Geometry
 * @returns {number[][][]} Array of rings, each ring is [[lon,lat], ...]
 */
export function extractPolygons(geojson) {
  const rings = [];
  (function walk(obj) {
    if (!obj) return;
    if (obj.type === 'FeatureCollection') (obj.features || []).forEach(walk);
    else if (obj.type === 'Feature') walk(obj.geometry);
    else if (obj.type === 'Polygon') rings.push(...(obj.coordinates || []));
    else if (obj.type === 'MultiPolygon') {
      for (const poly of (obj.coordinates || [])) rings.push(...poly);
    }
  })(geojson);
  return rings;
}

/**
 * Build a land mask from a GeoJSON outline of India.
 * @param {Object} geojson - India outline GeoJSON
 * @returns {Uint8Array} Length ROWS*COLS, 1 = land, 0 = sea/outside
 */
export function buildLandMask(geojson) {
  const mask = new Uint8Array(GRID.ROWS * GRID.COLS);
  const rings = extractPolygons(geojson);
  for (let r = 0; r < GRID.ROWS; r++) {
    for (let c = 0; c < GRID.COLS; c++) {
      const pt = cellCenter(r, c);
      for (const ring of rings) {
        if (pointInPolygon(pt, ring)) {
          mask[r * GRID.COLS + c] = 1;
          break;
        }
      }
    }
  }
  return mask;
}

/**
 * Assign each grid cell to a state index.
 * @param {Object} statesGeoJSON - GeoJSON FeatureCollection of states
 * @returns {{ assignments: Int8Array, names: string[] }}
 *   assignments: ROWS*COLS, -1 = unassigned, >= 0 = state index
 *   names: state name per index
 */
export function buildStateAssignments(statesGeoJSON) {
  const assignments = new Int8Array(GRID.ROWS * GRID.COLS).fill(-1);
  const names = [];
  if (!statesGeoJSON || !statesGeoJSON.features) return { assignments, names };

  const states = statesGeoJSON.features.map((f, idx) => {
    const name = f.properties.name || f.properties.NAME || f.properties.st_nm || `State ${idx}`;
    names.push(name);
    return { rings: extractPolygons({ type: 'Feature', geometry: f.geometry }) };
  });

  for (let r = 0; r < GRID.ROWS; r++) {
    for (let c = 0; c < GRID.COLS; c++) {
      const pt = cellCenter(r, c);
      for (let s = 0; s < states.length; s++) {
        let found = false;
        for (const ring of states[s].rings) {
          if (pointInPolygon(pt, ring)) { found = true; break; }
        }
        if (found) { assignments[r * GRID.COLS + c] = s; break; }
      }
    }
  }
  return { assignments, names };
}
