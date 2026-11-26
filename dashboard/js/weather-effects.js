/**
 * weather-effects.js -- Localized atmospheric weather animations.
 * Only triggers rain, clouds, storms, and solar effects in the exact regions
 * where the shock is applied or where extreme weather anomalies occur.
 * Does NOT rain all over the screen.
 * @module weatherEffects
 */
import { GRID } from './constants.js';
import { flatIndexStep, latToRow, lonToCol } from './grid.js';

let canvas = null;
let ctx = null;
let mapInstance = null;
let animationId = null;

let currentBuffer = null;
let currentStep = 0;
let currentChannel = 't2m';
let currentMode = 'normal';
let currentShockBox = null;

// Localized particle pools
const MAX_LOCAL_RAIN = 350;
let localRainDrops = [];
let lightningTimer = 0;
let lightningAlpha = 0;
let solarPulse = 0;

let windEnabled = false;
let weatherFxEnabled = true;

// Active storm/rain cells tracked dynamically
let activeShockZones = [];
let indiaGeoJSON = null;
let statesGeoJSON = null;

export function setWeatherBoundaries(indiaData, statesData) {
  indiaGeoJSON = indiaData;
  statesGeoJSON = statesData;
}

export function initWeatherEffects(targetCanvas, map) {
  canvas = targetCanvas;
  ctx = canvas.getContext('2d');
  mapInstance = map;

  resize();
  window.addEventListener('resize', resize);
  mapInstance.on('render', onMapRender);

  initLocalParticles();
  startLoop();
}

function resize() {
  if (!canvas || !mapInstance) return;
  const container = mapInstance.getContainer();
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}

function initLocalParticles() {
  localRainDrops = [];
  for (let i = 0; i < MAX_LOCAL_RAIN; i++) {
    localRainDrops.push({
      relX: Math.random(),
      relY: Math.random(),
      speed: 6 + Math.random() * 8,
      len: 8 + Math.random() * 12,
      alpha: 0.4 + Math.random() * 0.4
    });
  }
}

export function updateWeatherState({ buffer, step, channelKey, mode, shockBox = null }) {
  currentBuffer = buffer;
  currentStep = step;
  currentChannel = channelKey;
  currentMode = mode;
  if (shockBox) currentShockBox = shockBox;
}

export function setWeatherShockBox(box) {
  currentShockBox = box;
}

export function toggleWindOverlay(show) {
  windEnabled = show;
}

export function toggleWeatherFx(show) {
  weatherFxEnabled = show;
}

function onMapRender() {
  if (!animationId) startLoop();
}

function startLoop() {
  if (!animationId) animationId = requestAnimationFrame(loop);
}

function loop() {
  if (!ctx || !canvas || !mapInstance) {
    animationId = requestAnimationFrame(loop);
    return;
  }

  // Clear canvas transparently
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Always draw brilliant India and State borders directly on top of the map
  drawSubcontinentBoundaries();

  if (weatherFxEnabled && currentBuffer) {
    findActiveWeatherZones();
    renderLocalizedEffects();
  }

  animationId = requestAnimationFrame(loop);
}

function drawSubcontinentBoundaries() {
  if (!ctx || !mapInstance) return;

  // 1. Draw state outlines: professional clean slate-silver with subtle dashed structure
  if (statesGeoJSON && statesGeoJSON.features) {
    ctx.save();
    ctx.strokeStyle = 'rgba(215, 225, 238, 0.65)'; // refined silver-white
    ctx.lineWidth = 1.0;
    ctx.setLineDash([3, 2]);

    for (const feat of statesGeoJSON.features) {
      drawGeometryCoords(feat.geometry);
    }
    ctx.restore();

    // Draw clean, professional state typography labels
    drawStateLabels();
  }

  // 2. Draw national India border: crisp, clean white border with subtle dark contrast halo
  if (indiaGeoJSON && indiaGeoJSON.features) {
    ctx.save();
    // Subtle dark halo underneath for high contrast over satellite & white clouds
    ctx.strokeStyle = 'rgba(15, 18, 24, 0.75)';
    ctx.lineWidth = 3.2;
    for (const feat of indiaGeoJSON.features) {
      drawGeometryCoords(feat.geometry);
    }

    // Crisp national boundary line
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    for (const feat of indiaGeoJSON.features) {
      drawGeometryCoords(feat.geometry);
    }
    ctx.restore();
  }
}

/** Pre-calculated representative label centroids for each state */
const STATE_CENTROIDS = {
  'Andhra Pradesh': [79.90, 15.9],
  'Arunachal Pradesh': [94.6, 28.0],
  'Assam': [92.5, 26.1],
  'Bihar': [85.7, 25.8],
  'Chhattisgarh': [82.0, 21.3],
  'Delhi': [77.1, 28.6],
  'Goa': [74.0, 15.3],
  'Gujarat': [71.2, 22.4],
  'Haryana': [76.3, 29.2],
  'Himachal Pradesh': [77.3, 31.8],
  'Jammu and Kashmir': [75.8, 33.7],
  'Jharkhand': [85.6, 23.6],
  'Karnataka': [75.8, 14.8],
  'Kerala': [76.3, 10.4],
  'Madhya Pradesh': [78.3, 23.5],
  'Maharashtra': [75.7, 19.3],
  'Manipur': [93.8, 24.7],
  'Meghalaya': [91.4, 25.5],
  'Mizoram': [92.8, 23.2],
  'Nagaland': [94.4, 26.0],
  'Orissa': [84.5, 20.4],
  'Punjab': [75.4, 31.0],
  'Rajasthan': [73.8, 26.4],
  'Sikkim': [88.5, 27.6],
  'Tamil Nadu': [78.4, 11.0],
  'Tripura': [91.8, 23.8],
  'Uttar Pradesh': [80.5, 26.8],
  'Uttaranchal': [79.2, 30.1],
  'West Bengal': [87.9, 23.2]
};

function drawStateLabels() {
  const zoom = mapInstance.getZoom ? mapInstance.getZoom() : 4.5;
  if (zoom < 3.8) return; // Hide labels when zoomed out too far

  ctx.save();
  ctx.font = '500 10px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const [name, [lon, lat]] of Object.entries(STATE_CENTROIDS)) {
    const pt = mapInstance.project([lon, lat]);

    // Check if within visible viewport
    if (pt.x < 10 || pt.x > canvas.width - 10 || pt.y < 10 || pt.y > canvas.height - 10) continue;

    // Dark text shadow/halo for maximum readability over light or dark basemaps
    ctx.fillStyle = 'rgba(12, 14, 18, 0.85)';
    ctx.fillText(name, pt.x + 1, pt.y + 1);

    // Clean, crisp typography
    ctx.fillStyle = '#f0f3f8';
    ctx.fillText(name, pt.x, pt.y);
  }
  ctx.restore();
}

function drawGeometryCoords(geom) {
  if (!geom || !geom.coordinates) return;
  const type = geom.type;

  ctx.beginPath();
  if (type === 'Polygon') {
    for (const ring of geom.coordinates) {
      drawRing(ring);
    }
  } else if (type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      for (const ring of poly) {
        drawRing(ring);
      }
    }
  }
  ctx.stroke();
}

function drawRing(ring) {
  for (let i = 0; i < ring.length; i++) {
    const pt = mapInstance.project(ring[i]);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
}

/** Scan grid to find the exact bounding box of the shock or active localized extremes */
function findActiveWeatherZones() {
  activeShockZones = [];

  // 1. If user set an explicit shock box, prioritize that section
  if (currentShockBox && currentShockBox.latMin !== undefined) {
    activeShockZones.push({
      latMin: currentShockBox.latMin,
      latMax: currentShockBox.latMax,
      lonMin: currentShockBox.lonMin,
      lonMax: currentShockBox.lonMax,
      isExplicitShock: true
    });
    return;
  }

  // 2. Otherwise find localized hotspots/heavy rain patches (not the entire screen)
  for (let r = 0; r < GRID.ROWS; r += 3) {
    for (let c = 0; c < GRID.COLS; c += 3) {
      const tp = currentBuffer[flatIndexStep(currentStep, 1, r, c)] || 0;
      const t2m = currentBuffer[flatIndexStep(currentStep, 0, r, c)] || 300;
      const u = currentBuffer[flatIndexStep(currentStep, 2, r, c)] || 0;
      const v = currentBuffer[flatIndexStep(currentStep, 3, r, c)] || 0;
      const ws = Math.sqrt(u * u + v * v);

      if (tp > 25.0 || ws > 18.0 || t2m > 313.0) {
        const lat = GRID.LAT_MIN + r;
        const lon = GRID.LON_MIN + c;
        activeShockZones.push({
          latMin: lat - 1.5,
          latMax: lat + 1.5,
          lonMin: lon - 1.5,
          lonMax: lon + 1.5,
          heavyRain: tp > 25.0,
          storm: ws > 18.0,
          heatwave: t2m > 313.0
        });
        if (activeShockZones.length >= 3) return; // limit to small localized sections
      }
    }
  }
}

function renderLocalizedEffects() {
  if (activeShockZones.length === 0) return;

  for (const zone of activeShockZones) {
    // Project geographical bounding corners to 2D canvas coordinates
    const p1 = mapInstance.project([zone.lonMin, zone.latMax]); // Top-left
    const p2 = mapInstance.project([zone.lonMax, zone.latMin]); // Bottom-right

    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);

    const w = maxX - minX;
    const h = maxY - minY;

    // Check if zone is visible in viewport
    if (maxX < 0 || minX > canvas.width || maxY < 0 || minY > canvas.height) continue;

    ctx.save();
    // Clip strictly to the shock region so rain/clouds never spill outside
    ctx.beginPath();
    ctx.rect(minX - 10, minY - 10, w + 20, h + 20);
    ctx.clip();

    // 1. Localized Cloud Formation directly above the shock section
    drawLocalizedCloud(minX, minY, w, h);

    // 2. Localized Falling Rain only within this box
    drawLocalizedRain(minX, minY, w, h);

    // 3. Storm lightning flash inside this section
    drawLocalizedStorm(minX, minY, w, h);

    // 4. Solar heat pulse if temperature shock
    drawLocalizedSunHeat(minX, minY, w, h);

    ctx.restore();

    // Glowing border around the active weather section
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(minX, minY, w, h);
    ctx.setLineDash([]);
  }
}

function drawLocalizedRain(x, y, w, h) {
  ctx.strokeStyle = 'rgba(140, 210, 255, 0.85)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();

  for (let i = 0; i < localRainDrops.length; i++) {
    const d = localRainDrops[i];
    d.relY += (d.speed / Math.max(80, h));
    if (d.relY > 1.0) {
      d.relY = 0;
      d.relX = Math.random();
    }

    const rx = x + d.relX * w;
    const ry = y + d.relY * h;

    ctx.moveTo(rx, ry);
    ctx.lineTo(rx - 2, ry + d.len);
  }
  ctx.stroke();
}

function drawLocalizedCloud(x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 4;
  const rad = Math.max(w, h) * 0.45;

  const grad = ctx.createRadialGradient(cx, cy, 5, cx, cy, rad);
  grad.addColorStop(0, 'rgba(220, 230, 245, 0.45)');
  grad.addColorStop(0.6, 'rgba(180, 200, 225, 0.25)');
  grad.addColorStop(1, 'rgba(180, 200, 225, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fill();
}

function drawLocalizedStorm(x, y, w, h) {
  lightningTimer++;
  if (lightningAlpha > 0) {
    ctx.fillStyle = `rgba(230, 245, 255, ${lightningAlpha * 0.4})`;
    ctx.fillRect(x, y, w, h);
    lightningAlpha *= 0.82;
    if (lightningAlpha < 0.05) lightningAlpha = 0;
  } else if (lightningTimer > 90 && Math.random() < 0.3) {
    lightningAlpha = 0.9;
    lightningTimer = 0;
  }
}

function drawLocalizedSunHeat(x, y, w, h) {
  solarPulse += 0.03;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = Math.max(w, h) * (0.35 + Math.sin(solarPulse) * 0.05);

  const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, rad);
  grad.addColorStop(0, 'rgba(255, 180, 50, 0.25)');
  grad.addColorStop(0.8, 'rgba(255, 100, 20, 0.08)');
  grad.addColorStop(1, 'rgba(255, 100, 20, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fill();
}
