/**
 * wind.js -- Canvas particle overlay synced to MapLibre camera.
 * Advects particles using u10/v10 wind fields.
 * Respects prefers-reduced-motion and limits particle count to 2,000.
 * @module wind
 */
import { GRID } from './constants.js';
import { flatIndexStep, cellCenter, latToRow, lonToCol } from './grid.js';

let canvas = null;
let ctx = null;
let mapInstance = null;
let animationId = null;
let enabled = false;
let currentBuffer = null;
let currentStep = 0;

const MAX_PARTICLES = 1500;
const PARTICLE_LIFETIME = 60;
const SPEED_FACTOR = 0.08;

let particles = [];

/**
 * Initialize wind canvas layer.
 * @param {HTMLCanvasElement} targetCanvas 
 * @param {maplibregl.Map} map 
 */
export function initWind(targetCanvas, map) {
  canvas = targetCanvas;
  ctx = canvas.getContext('2d');
  mapInstance = map;

  resize();
  window.addEventListener('resize', resize);
  mapInstance.on('render', onMapRender);

  // Check prefers-reduced-motion
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    enabled = false;
  }
}

function resize() {
  if (!canvas || !mapInstance) return;
  const container = mapInstance.getContainer();
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  initParticles();
}

function initParticles() {
  particles = [];
  for (let i = 0; i < MAX_PARTICLES; i++) {
    particles.push(createParticle());
  }
}

function createParticle() {
  return {
    lon: GRID.LON_MIN + Math.random() * (GRID.LON_MAX - GRID.LON_MIN),
    lat: GRID.LAT_MIN + Math.random() * (GRID.LAT_MAX - GRID.LAT_MIN),
    age: Math.floor(Math.random() * PARTICLE_LIFETIME)
  };
}

export function setWindData(buffer, step) {
  currentBuffer = buffer;
  currentStep = step;
}

export function toggleWind(show) {
  enabled = show;
  if (enabled) {
    if (!animationId) loop();
  } else {
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
}

function onMapRender() {
  if (enabled && !animationId) {
    loop();
  }
}

function loop() {
  if (!enabled || !ctx || !mapInstance || !currentBuffer) {
    animationId = null;
    return;
  }

  // Fading trail effect
  ctx.fillStyle = 'rgba(24, 27, 32, 0.12)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(212, 154, 62, 0.55)'; // amber wind strands
  ctx.lineWidth = 1.2;
  ctx.beginPath();

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.age++;

    if (p.age >= PARTICLE_LIFETIME || p.lat < GRID.LAT_MIN || p.lat > GRID.LAT_MAX || p.lon < GRID.LON_MIN || p.lon > GRID.LON_MAX) {
      particles[i] = createParticle();
      continue;
    }

    const row = latToRow(p.lat);
    const col = lonToCol(p.lon);

    // Read u10 and v10 from buffer
    const u = currentBuffer[flatIndexStep(currentStep, 2, row, col)] || 0;
    const v = currentBuffer[flatIndexStep(currentStep, 3, row, col)] || 0;

    const startPos = mapInstance.project([p.lon, p.lat]);

    // Move particle in lat/lon
    p.lon += u * SPEED_FACTOR * 0.05;
    p.lat += v * SPEED_FACTOR * 0.05;

    const endPos = mapInstance.project([p.lon, p.lat]);

    if (startPos.x >= 0 && startPos.x <= canvas.width && startPos.y >= 0 && startPos.y <= canvas.height) {
      ctx.moveTo(startPos.x, startPos.y);
      ctx.lineTo(endPos.x, endPos.y);
    }
  }

  ctx.stroke();
  animationId = requestAnimationFrame(loop);
}
