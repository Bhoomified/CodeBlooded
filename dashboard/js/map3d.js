/**
 * map3d.js -- MapLibre GL 3D fill-extrusion grid renderer.
 * Renders 1,152 grid cells as extruded columns whose height and colour encode data.
 * @module map3d
 */
import { GRID, MAP_DEFAULTS, EXTRUSION_SCALE, channelByKey, HEAVY_RAIN_THRESHOLD } from './constants.js';
import { cellBounds, cellCenter, buildGridGeoJSON, flatIndexStep, flatIndex } from './grid.js';
import { getColorScale } from './colour.js';

let map = null;
let gridSource = null;
let baseGeoJSON = null;
let currentStyle = 'dark';
let hoveredCell = null;
let pinnedCell = null;

/**
 * Initialize MapLibre GL Map.
 * @param {Object} options
 * @param {HTMLElement|string} options.container
 * @param {string} [options.maptilerKey]
 * @param {Function} options.onCellClick
 * @param {Function} options.onCellHover
 * @returns {Promise<maplibregl.Map>}
 */
export async function initMap({ container, maptilerKey, onCellClick, onCellHover }) {
  baseGeoJSON = buildGridGeoJSON();

  // Determine style URL or fallback style definition
  const fallbackStyle = {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#181b20' }
      }
    ]
  };

  let styleUrl = fallbackStyle;
  if (maptilerKey) {
    styleUrl = `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${maptilerKey}`;
  }

  // Ensure maplibregl is globally available from vendor
  if (typeof window.maplibregl === 'undefined') {
    console.warn('MapLibre GL not loaded from vendor.');
  }

  map = new window.maplibregl.Map({
    container,
    style: styleUrl,
    center: MAP_DEFAULTS.CENTER,
    zoom: MAP_DEFAULTS.ZOOM,
    pitch: MAP_DEFAULTS.PITCH,
    bearing: MAP_DEFAULTS.BEARING,
    minZoom: MAP_DEFAULTS.MIN_ZOOM,
    maxZoom: MAP_DEFAULTS.MAX_ZOOM,
    attributionControl: false
  });

  map.addControl(new window.maplibregl.NavigationControl({ showCompass: true }), 'top-right');

  // Handle tile load errors gracefully by falling back to neutral dark
  map.on('error', (e) => {
    if (e.error && (e.error.status === 401 || e.error.status === 403 || e.error.message?.includes('fetch'))) {
      if (currentStyle !== 'fallback') {
        currentStyle = 'fallback';
        map.setStyle(fallbackStyle);
      }
    }
  });

  return new Promise((resolve) => {
    map.on('load', () => {
      setupLayers();
      setupInteractions(onCellClick, onCellHover);
      resolve(map);
    });
  });
}

function setupLayers() {
  // Hide default basemap boundary/label layers so local India outline takes priority
  const layers = map.getStyle().layers || [];
  for (const layer of layers) {
    if (layer.id.includes('admin') || layer.id.includes('boundary') || layer.id.includes('border')) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  }

  // Add grid GeoJSON source
  map.addSource('forecast-grid', {
    type: 'geojson',
    data: baseGeoJSON
  });
  gridSource = map.getSource('forecast-grid');

  // Fill extrusion layer for 3D cells
  map.addLayer({
    id: 'forecast-cells',
    type: 'fill-extrusion',
    source: 'forecast-grid',
    paint: {
      'fill-extrusion-color': ['get', 'color'],
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.88,
      'fill-extrusion-height-transition': { duration: 180 }
    }
  });

  // Edge band indicator line / subtle border
  map.addLayer({
    id: 'forecast-cells-lines',
    type: 'line',
    source: 'forecast-grid',
    paint: {
      'line-color': [
        'case',
        ['==', ['get', 'edge'], 1],
        'rgba(212, 154, 62, 0.45)', // subtle amber for domain edge band
        'rgba(42, 45, 53, 0.6)'
      ],
      'line-width': ['case', ['==', ['get', 'edge'], 1], 1.5, 0.5]
    }
  });

  // Shock box highlight source & layer
  map.addSource('shock-box', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'shock-box-fill',
    type: 'fill',
    source: 'shock-box',
    paint: {
      'fill-color': '#d49a3e',
      'fill-opacity': 0.25
    }
  });

  map.addLayer({
    id: 'shock-box-outline',
    type: 'line',
    source: 'shock-box',
    paint: {
      'line-color': '#d49a3e',
      'line-width': 2,
      'line-dasharray': [2, 1]
    }
  });

  // Heavy rain highlight layer
  map.addSource('heavy-rain', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'heavy-rain-lines',
    type: 'line',
    source: 'heavy-rain',
    paint: {
      'line-color': '#4a8fd4',
      'line-width': 2
    }
  });
}

/**
 * Add India and state boundary layers from GeoJSON objects.
 * @param {Object} indiaGeoJSON 
 * @param {Object} statesGeoJSON 
 */
export function setBoundaries(indiaGeoJSON, statesGeoJSON) {
  if (!map || !map.isStyleLoaded()) return;

  if (indiaGeoJSON && !map.getSource('india-boundary')) {
    map.addSource('india-boundary', { type: 'geojson', data: indiaGeoJSON });
    map.addLayer({
      id: 'india-outline',
      type: 'line',
      source: 'india-boundary',
      paint: {
        'line-color': '#e8e9ec',
        'line-width': 1.8,
        'line-opacity': 0.85
      }
    }, 'forecast-cells');
  }

  if (statesGeoJSON && !map.getSource('states-boundary')) {
    map.addSource('states-boundary', { type: 'geojson', data: statesGeoJSON });
    map.addLayer({
      id: 'states-outline',
      type: 'line',
      source: 'states-boundary',
      paint: {
        'line-color': '#686d78',
        'line-width': 0.8,
        'line-dasharray': [2, 2],
        'line-opacity': 0.6
      }
    }, 'forecast-cells');
  }
}

/**
 * Update the 3D grid heights and colors for the current view.
 * @param {Object} params
 * @param {Float32Array} params.buffer - Rollout flat buffer or difference buffer
 * @param {number} params.step - Forecast day index (0..steps-1)
 * @param {string} params.channelKey - 't2m', 'tp', etc.
 * @param {boolean} [params.isDifference=false]
 * @param {boolean} [params.isFlat=false]
 * @param {Float32Array} [params.orography] - Optional orography for Relief mode
 */
export function updateGridDisplay({ buffer, step, channelKey, isDifference = false, isFlat = false, orography = null }) {
  if (!gridSource || !baseGeoJSON) return;

  const chMeta = channelByKey(channelKey);
  const chIdx = chMeta ? chMeta.index : 0;
  const colorScale = getColorScale(channelKey, isDifference);
  const range = chMeta ? chMeta.defaultRange : [0, 1];
  const scaleMult = EXTRUSION_SCALE[channelKey] || 1000;

  const features = baseGeoJSON.features;
  const heavyRainFeatures = [];

  for (let r = 0; r < GRID.ROWS; r++) {
    for (let c = 0; c < GRID.COLS; c++) {
      const featIdx = r * GRID.COLS + c;
      const feat = features[featIdx];

      let val = 0;
      if (channelKey === 'wind_speed') {
        const u = buffer[flatIndexStep(step, 2, r, c)];
        const v = buffer[flatIndexStep(step, 3, r, c)];
        val = Math.sqrt(u * u + v * v);
      } else {
        val = buffer[flatIndexStep(step, chIdx, r, c)];
      }

      // Height logic
      let h = 0;
      if (!isFlat) {
        if (orography) {
          h = Math.max(0, orography[r * GRID.COLS + c]);
        } else if (isDifference) {
          h = Math.abs(val) * (EXTRUSION_SCALE.difference || 8000);
        } else {
          const normH = Math.max(0, val - (chMeta?.scaleType === 'diverging' ? 0 : range[0]));
          h = normH * scaleMult;
        }
      }

      feat.properties.value = val;
      feat.properties.height = h;
      feat.properties.color = colorScale(val, range);

      if (channelKey === 'tp' && val >= HEAVY_RAIN_THRESHOLD) {
        heavyRainFeatures.push(feat);
      }
    }
  }

  gridSource.setData(baseGeoJSON);

  // Update heavy rain outline layer
  const rainSrc = map.getSource('heavy-rain');
  if (rainSrc) {
    rainSrc.setData({ type: 'FeatureCollection', features: heavyRainFeatures });
  }
}

/**
 * Update the visual shock box overlay on the map.
 * @param {{ latMin: number, latMax: number, lonMin: number, lonMax: number } | null} bounds 
 */
export function setShockBox(bounds) {
  if (!map) return;
  const src = map.getSource('shock-box');
  if (!src) return;

  if (!bounds) {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const { latMin, latMax, lonMin, lonMax } = bounds;
  const polygon = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lonMin, latMin],
        [lonMax, latMin],
        [lonMax, latMax],
        [lonMin, latMax],
        [lonMin, latMin]
      ]]
    }
  };

  src.setData({ type: 'FeatureCollection', features: [polygon] });
}

function setupInteractions(onCellClick, onCellHover) {
  map.on('mousemove', 'forecast-cells', (e) => {
    if (e.features && e.features.length > 0) {
      map.getCanvas().style.cursor = 'pointer';
      const props = e.features[0].properties;
      hoveredCell = { row: props.row, col: props.col, lat: props.lat, lon: props.lon, value: props.value };
      if (onCellHover) onCellHover(hoveredCell, e.point);
    }
  });

  map.on('mouseleave', 'forecast-cells', () => {
    map.getCanvas().style.cursor = '';
    hoveredCell = null;
    if (onCellHover) onCellHover(null, null);
  });

  map.on('click', 'forecast-cells', (e) => {
    if (e.features && e.features.length > 0) {
      const props = e.features[0].properties;
      pinnedCell = { row: props.row, col: props.col, lat: props.lat, lon: props.lon };
      if (onCellClick) onCellClick(pinnedCell);
    }
  });
}

export function resetView() {
  if (!map) return;
  map.easeTo({
    center: MAP_DEFAULTS.CENTER,
    zoom: MAP_DEFAULTS.ZOOM,
    pitch: MAP_DEFAULTS.PITCH,
    bearing: MAP_DEFAULTS.BEARING,
    duration: 600
  });
}

export function getMapInstance() {
  return map;
}
