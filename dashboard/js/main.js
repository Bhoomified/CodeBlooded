/**
 * main.js -- Main application orchestrator for Forecastrophe.
 * Wires state store, API, MapLibre 3D map, wind particles, shock painter,
 * inspector tabs, timeline playback, keyboard shortcuts, and export.
 * @module main
 */
import { loadConfig } from './config-loader.js';
import { createStore } from './state.js';
import { initApi } from './api.js';
import { computeDoySinCos, formatDoy, dayOfYearToMonthDay } from './doy.js';
import { CHANNELS, channelByKey, DERIVED_CHANNELS, NULL_SHOCK_EPSILON } from './constants.js';
import { initMap, updateGridDisplay, setShockBox, setBoundaries, resetView } from './map3d.js';
import { initWind, setWindData, toggleWind } from './wind.js';
import { buildLandMask, buildStateAssignments, flatIndexStep } from './grid.js';
import { loadShockPresets, snapToGrid, buildPerturbationTensor, generateRandomJudgeShock } from './shock.js';
import { computeDifference, analyzeCausality } from './analysis.js';
import { computeBlurMetrics } from './blur.js';
import { computeImpacts } from './impact.js';
import { renderRadiusChart, renderSeriesChart, renderStateImpactBars } from './charts.js';
import { renderDiagnosticsPanel, renderModelBadges } from './diagnostics.js';
import { runPhysicsBattery, cancelBattery } from './battery.js';
import { exportMapPng, exportRunJson, exportImpactCsv } from './export.js';
import { renderLegend } from './colour.js';

let store = null;
let api = null;
let config = null;
let mapInstance = null;
let landMask = null;
let stateAssignments = null;
let presetsList = [];

let isPlaying = false;
let playInterval = null;

window.addEventListener('DOMContentLoaded', async () => {
  try {
    config = await loadConfig();
    store = createStore();

    // Mode badge
    const badge = document.getElementById('badge-mode');
    if (config.mode === 'mock') {
      badge.style.display = 'inline-flex';
      badge.textContent = 'MOCK ENGINE - NOT MODEL OUTPUT';
    } else {
      badge.style.display = 'none';
    }

    // Initialize API client
    api = await initApi(store, config);

    // Initial state store defaults
    store.set('currentDay', 0);
    store.set('steps', 14);
    store.set('dayOfYear', 196); // mid-July monsoon
    store.set('doySinCos', computeDoySinCos(196));
    store.set('selectedChannel', 't2m');
    store.set('viewMode', 'difference'); // default to multiverse difference
    store.set('isFlat', false);
    store.set('windEnabled', false);

    // Initialize map
    const mapContainer = document.getElementById('map');
    mapInstance = await initMap({
      container: mapContainer,
      maptilerKey: config.maptilerKey,
      onCellClick: handleCellPinned,
      onCellHover: handleCellHover
    });

    // Initialize wind overlay
    const windCanvas = document.getElementById('wind-canvas');
    initWind(windCanvas, mapInstance);

    // Load boundaries & land mask
    loadBoundariesAndMask();

    // Load presets
    presetsList = await loadShockPresets();
    populatePresetsDropdown(presetsList);

    // Wire UI events
    setupUIEvents();
    setupHealthListener();

    // Load initial mock or default state
    await loadInitialPreset('monsoon_july');

    // Run first baseline simulation
    document.getElementById('btn-run').click();

  } catch (err) {
    console.error('Bootstrap error:', err);
    showErrorNotification('Application failed to initialize: ' + err.message);
  }
});

async function loadBoundariesAndMask() {
  try {
    const [indRes, stRes] = await Promise.all([
      fetch('assets/india.geojson'),
      fetch('assets/states.geojson')
    ]);

    if (indRes.ok && stRes.ok) {
      const indiaGeoJSON = await indRes.json();
      const statesGeoJSON = await stRes.json();

      setBoundaries(indiaGeoJSON, statesGeoJSON);
      landMask = buildLandMask(indiaGeoJSON);
      stateAssignments = buildStateAssignments(statesGeoJSON);
    }
  } catch (e) {
    console.warn('GeoJSON boundary load error, using default mask', e);
  }
}

async function loadInitialPreset(id) {
  const data = await api.getPreset(id);
  if (data) {
    store.set('initStates', data.init_states);
    store.set('doySinCos', data.doy_sincos);
    updateDoyDisplay(store.get('dayOfYear'));
  }
}

function setupHealthListener() {
  const dot = document.getElementById('health-dot');
  const label = document.getElementById('health-status-text');

  store.subscribe('health:update', (h) => {
    if (!h) return;
    dot.className = `health-dot health-dot--${h.status}`;
    if (h.status === 'ready') {
      label.textContent = `${h.modelName || 'Ready'}`;
      document.getElementById('btn-run').disabled = false;
    } else if (h.status === 'loading') {
      const elapsedSec = Math.round(h.elapsedLoading / 1000);
      label.textContent = `Loading (${elapsedSec}s/120s): ${h.reason || 'warming up'}`;
      document.getElementById('btn-run').disabled = true;
    } else {
      label.textContent = `Offline: ${h.reason || 'check connection'}`;
      document.getElementById('btn-run').disabled = true;
    }
  });
}

function setupUIEvents() {
  // Run button
  const runBtn = document.getElementById('btn-run');
  runBtn.addEventListener('click', handleRunSimulation);

  // Steps slider
  const stepsSlider = document.getElementById('slider-steps');
  const stepsVal = document.getElementById('val-steps');
  stepsSlider.max = config.maxSteps || 14;
  stepsSlider.value = store.get('steps');
  stepsVal.textContent = stepsSlider.value;
  stepsSlider.addEventListener('input', (e) => {
    const s = parseInt(e.target.value, 10);
    store.set('steps', s);
    stepsVal.textContent = s;
    updateScenarioSummary();
  });

  // Timeline slider
  const timelineSlider = document.getElementById('slider-timeline');
  timelineSlider.addEventListener('input', (e) => {
    const d = parseInt(e.target.value, 10);
    setForecastDay(d);
  });

  // Timeline controls
  document.getElementById('btn-prev-day').addEventListener('click', () => {
    setForecastDay(Math.max(0, store.get('currentDay') - 1));
  });
  document.getElementById('btn-next-day').addEventListener('click', () => {
    setForecastDay(Math.min(store.get('steps') - 1, store.get('currentDay') + 1));
  });
  document.getElementById('btn-play-pause').addEventListener('click', togglePlayback);

  // Channel dropdown
  const chSelect = document.getElementById('select-channel');
  chSelect.addEventListener('change', (e) => {
    store.set('selectedChannel', e.target.value);
    updateDisplay();
  });

  // View mode radios (Prime, Multiverse, Difference)
  document.querySelectorAll('input[name="view-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      store.set('viewMode', e.target.value);
      updateDisplay();
    });
  });

  // 2D/3D flat toggle
  document.getElementById('toggle-flat').addEventListener('change', (e) => {
    store.set('isFlat', e.target.checked);
    updateDisplay();
  });

  // Wind toggle
  document.getElementById('toggle-wind').addEventListener('change', (e) => {
    const on = e.target.checked;
    store.set('windEnabled', on);
    toggleWind(on);
  });

  // Reset view
  document.getElementById('btn-reset-view').addEventListener('click', resetView);

  // Preset selector
  document.getElementById('select-preset').addEventListener('change', (e) => {
    applyPreset(e.target.value);
  });

  // Judge shock randomizer
  document.getElementById('btn-judge-shock').addEventListener('click', () => {
    const shock = generateRandomJudgeShock();
    applyCustomShock(shock);
  });

  // Preset shock buttons
  document.getElementById('btn-null-shock').addEventListener('click', () => {
    applyPreset('null');
  });

  // Shock magnitude inputs
  ['input-lat-min', 'input-lat-max', 'input-lon-min', 'input-lon-max', 'input-shock-mag', 'select-shock-mode', 'select-shock-ch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', handleCustomShockInput);
  });

  // Inspector tabs
  document.querySelectorAll('.tab-bar__tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-bar__tab').forEach(t => t.classList.remove('tab-bar__tab--active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
      tab.classList.add('tab-bar__tab--active');
      const pane = document.getElementById(`pane-${tab.dataset.tab}`);
      if (pane) pane.style.display = 'block';
    });
  });

  // Battery run button
  document.getElementById('btn-run-battery')?.addEventListener('click', async () => {
    const container = document.getElementById('battery-results');
    container.innerHTML = '<p class="text-mono text-label">Running physics battery tests sequentially...</p>';
    const results = await runPhysicsBattery(api, {
      initStates: store.get('initStates'),
      doySinCos: store.get('doySinCos'),
      steps: 3
    }, (prog) => {
      container.innerHTML = `<p class="text-mono text-label">Running (${prog.index + 1}/${prog.total}): ${prog.label}...</p>`;
    });

    container.innerHTML = results.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);" class="text-mono">
        <div>
          <div style="font-weight:600;font-size:11px;">${r.name}</div>
          <div style="color:var(--text-dim);font-size:9px;">${r.description}</div>
        </div>
        <div style="text-align:right;">
          <span class="badge ${r.pass ? 'badge--pass' : 'badge--fail'}">${r.pass ? 'PASS' : 'FAIL'}</span>
          <div style="font-size:9px;color:var(--text-secondary);">${r.value} (${r.threshold})</div>
        </div>
      </div>
    `).join('');
  });

  // Export buttons
  document.getElementById('btn-export-png').addEventListener('click', () => {
    exportMapPng(mapInstance, config.mode === 'mock');
  });

  document.getElementById('btn-export-json').addEventListener('click', () => {
    exportRunJson(store.snapshot());
  });

  document.getElementById('btn-export-csv').addEventListener('click', () => {
    const impacts = store.get('impact');
    if (impacts) exportImpactCsv(impacts.rainfall.states);
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlayback();
    } else if (e.key === 'ArrowRight') {
      setForecastDay(Math.min(store.get('steps') - 1, store.get('currentDay') + 1));
    } else if (e.key === 'ArrowLeft') {
      setForecastDay(Math.max(0, store.get('currentDay') - 1));
    } else if (e.key.toLowerCase() === 'd') {
      store.set('viewMode', 'difference');
      document.querySelector('input[name="view-mode"][value="difference"]').checked = true;
      updateDisplay();
    } else if (e.key.toLowerCase() === 's') {
      store.set('viewMode', 'shocked');
      document.querySelector('input[name="view-mode"][value="shocked"]').checked = true;
      updateDisplay();
    } else if (e.key.toLowerCase() === 'p') {
      document.body.classList.toggle('presentation');
      setTimeout(() => mapInstance.resize(), 200);
    }
  });
}

function updateDoyDisplay(doy) {
  const lbl = document.getElementById('val-doy');
  if (lbl) lbl.textContent = formatDoy(doy);
}

function populatePresetsDropdown(presets) {
  const sel = document.getElementById('select-preset');
  sel.innerHTML = '<option value="">-- Choose Shock Preset --</option>';
  presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = `${p.label} (${p.description})`;
    sel.appendChild(opt);
  });
}

function applyPreset(key) {
  const p = presetsList.find(item => item.key === key);
  if (!p) {
    if (key === 'null') {
      applyCustomShock({ box: null, channels: [], label: 'Null Shock (Control)' });
    }
    return;
  }

  let box = null;
  if (p.box) {
    box = snapToGrid(p.box);
    document.getElementById('input-lat-min').value = p.box.latMin;
    document.getElementById('input-lat-max').value = p.box.latMax;
    document.getElementById('input-lon-min').value = p.box.lonMin;
    document.getElementById('input-lon-max').value = p.box.lonMax;
  }

  if (p.channels && p.channels[0]) {
    document.getElementById('select-shock-ch').value = p.channels[0].index;
    document.getElementById('select-shock-mode').value = p.channels[0].mode || 'additive';
    document.getElementById('input-shock-mag').value = p.channels[0].value;
  }

  applyCustomShock({
    box,
    channels: p.channels,
    label: p.label,
    softEdge: p.softEdge
  });
}

function handleCustomShockInput() {
  const latMin = parseFloat(document.getElementById('input-lat-min').value);
  const latMax = parseFloat(document.getElementById('input-lat-max').value);
  const lonMin = parseFloat(document.getElementById('input-lon-min').value);
  const lonMax = parseFloat(document.getElementById('input-lon-max').value);

  const chIdx = parseInt(document.getElementById('select-shock-ch').value, 10);
  const mode = document.getElementById('select-shock-mode').value;
  const val = parseFloat(document.getElementById('input-shock-mag').value);

  if (Number.isFinite(latMin) && Number.isFinite(latMax) && Number.isFinite(lonMin) && Number.isFinite(lonMax)) {
    const box = snapToGrid({ latMin, latMax, lonMin, lonMax });
    applyCustomShock({
      box,
      channels: [{ index: chIdx, mode, value: val }],
      label: `Custom: ${CHANNELS[chIdx].name} (${val})`
    });
  }
}

function applyCustomShock(shockDef) {
  store.set('shock', shockDef);
  setShockBox(shockDef.box);
  updateScenarioSummary();

  // Edge band warning check
  const warnEl = document.getElementById('shock-edge-warning');
  if (shockDef.box && checkEdgeBandOverlap(shockDef.box.rows, shockDef.box.cols)) {
    warnEl.style.display = 'block';
    warnEl.textContent = 'Shock box overlaps 3-cell domain border; reliability is lower near edges.';
  } else {
    warnEl.style.display = 'none';
  }
}

function updateScenarioSummary() {
  const summaryEl = document.getElementById('scenario-summary-text');
  const steps = store.get('steps');
  const doy = store.get('dayOfYear');
  const shock = store.get('shock');
  const shockLabel = shock ? shock.label : 'Null shock';

  summaryEl.textContent = `Forecast: ${steps} days from ${formatDoy(doy)} | Shock: ${shockLabel}`;
}

async function handleRunSimulation() {
  const runBtn = document.getElementById('btn-run');
  const progressEl = document.getElementById('run-progress-label');
  runBtn.disabled = true;

  try {
    const steps = store.get('steps');
    const initStates = store.get('initStates');
    const doySinCos = store.get('doySinCos');
    const shock = store.get('shock');

    let perturbation = null;
    if (shock && shock.box && shock.channels && shock.channels.length > 0) {
      const lastDay = initStates[initStates.length - 1];
      const res = buildPerturbationTensor({
        box: shock.box,
        channels: shock.channels,
        lastInputDay: lastDay,
        softEdge: shock.softEdge
      });
      perturbation = res.perturbation;

      if (res.clippedCount > 0) {
        showErrorNotification(`Clipping alert: ${res.clippedCount} cells clipped to physical envelope.`);
      }
    }

    progressEl.textContent = 'Simulating normal rollout...';
    const { normal, shocked } = await api.runSimulation({
      initStates,
      doySinCos,
      steps,
      perturbation
    });

    progressEl.textContent = 'Computing multiverse difference...';

    // Store rollouts
    store.set('normalRollout', normal.rollout);
    store.set('shockedRollout', shocked.rollout);
    const diff = computeDifference(normal.rollout, shocked.rollout, steps);
    store.set('difference', diff);

    // Update latency gauge
    updateLatencyBar(normal.inferenceMs, shocked.inferenceMs);

    // Diagnostics
    renderDiagnosticsPanel(document.getElementById('diagnostics-container'), {
      normal: normal.diagnostics,
      shocked: shocked.diagnostics
    });

    // Causality Analysis
    const chMeta = channelByKey(store.get('selectedChannel'));
    const chIdx = chMeta ? chMeta.index : 0;
    const causality = analyzeCausality({
      differenceBuffer: diff,
      steps,
      channelIndex: chIdx,
      shockBox: shock?.box
    });
    store.set('causality', causality);
    renderCausalityChips(causality.causalityChecks);
    renderRadiusChart(document.getElementById('radius-chart-container'), causality.radiusMetrics);

    // Blur Monitor
    const blurResults = computeBlurMetrics(normal.rollout, steps);
    renderBlurTable(blurResults);

    // Impact Analysis
    if (landMask && stateAssignments) {
      const impacts = computeImpacts({
        normalRollout: normal.rollout,
        shockedRollout: shocked.rollout,
        steps,
        landMask,
        stateData: stateAssignments
      });
      store.set('impact', impacts);
      renderImpacts(impacts);
    }

    // Set timeline range
    const timelineSlider = document.getElementById('slider-timeline');
    timelineSlider.max = steps - 1;
    setForecastDay(0);

    progressEl.textContent = 'Complete';
    setTimeout(() => { progressEl.textContent = ''; }, 3000);

  } catch (err) {
    console.error('Simulation error:', err);
    showErrorNotification(err.message || 'Simulation failed.');
    progressEl.textContent = 'Error';
  } finally {
    runBtn.disabled = false;
  }
}

function updateLatencyBar(normMs, shockMs) {
  const lbl = document.getElementById('latency-label');
  const bar = document.getElementById('latency-bar-fill');
  const total = Math.round(normMs + shockMs);
  lbl.textContent = `${total} ms`;

  const pct = Math.min(100, (total / 5000) * 100);
  bar.style.width = `${pct}%`;
  bar.style.backgroundColor = total > 5000 ? 'var(--error)' : 'var(--accent)';
}

function renderCausalityChips(checks) {
  const container = document.getElementById('causality-chips');
  container.innerHTML = `
    <span class="chip ${checks.localized ? 'chip--pass' : 'chip--fail'}">Localized: ${checks.localized ? 'PASS' : 'FAIL'}</span>
    <span class="chip ${checks.noTeleport ? 'chip--pass' : 'chip--fail'}">No Teleport: ${checks.noTeleport ? 'PASS' : 'FAIL'}</span>
    <span class="chip ${checks.propagates ? 'chip--pass' : 'chip--fail'}">Propagates: ${checks.propagates ? 'PASS' : 'FAIL'}</span>
    <span class="chip ${checks.stable ? 'chip--pass' : 'chip--fail'}">Stable: ${checks.stable ? 'PASS' : 'FAIL'}</span>
  `;
}

function renderBlurTable(blurData) {
  const container = document.getElementById('blur-table-container');
  if (!container || !blurData || blurData.length === 0) return;

  const dayLast = blurData[blurData.length - 1];
  container.innerHTML = `
    <div style="font-size:10px;margin-bottom:6px;" class="text-mono">Spatial STD Ratio (Day ${dayLast.day} vs Day 0):</div>
    ${dayLast.channels.map(c => `
      <div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);" class="text-mono">
        <span style="${c.flagged ? 'color:var(--warning);font-weight:600;' : ''}">${c.name}</span>
        <span style="${c.flagged ? 'color:var(--warning);font-weight:600;' : 'color:var(--text-secondary);'}">${c.ratio}x ${c.flagged ? '[BLUR ALERT]' : ''}</span>
      </div>
    `).join('')}
  `;
}

function renderImpacts(impacts) {
  const nat = impacts.rainfall.national;
  document.getElementById('val-national-deficit').textContent = `${nat.deltaMm > 0 ? '+' : ''}${nat.deltaMm} mm (${nat.deltaPercent}%)`;
  renderStateImpactBars(document.getElementById('state-impact-bars'), impacts.rainfall.states);
}

function setForecastDay(day) {
  store.set('currentDay', day);
  document.getElementById('slider-timeline').value = day;
  document.getElementById('val-timeline-day').textContent = `Day ${day}`;
  updateDisplay();
}

function togglePlayback() {
  isPlaying = !isPlaying;
  const btn = document.getElementById('btn-play-pause');
  btn.textContent = isPlaying ? 'Pause' : 'Play';

  if (isPlaying) {
    playInterval = setInterval(() => {
      const cur = store.get('currentDay');
      const max = store.get('steps') - 1;
      setForecastDay(cur >= max ? 0 : cur + 1);
    }, 400);
  } else {
    clearInterval(playInterval);
    playInterval = null;
  }
}

function updateDisplay() {
  const mode = store.get('viewMode');
  const step = store.get('currentDay');
  const chKey = store.get('selectedChannel');
  const isFlat = store.get('isFlat');

  let buffer = null;
  let isDiff = false;

  if (mode === 'normal') {
    buffer = store.get('normalRollout');
  } else if (mode === 'shocked') {
    buffer = store.get('shockedRollout');
  } else {
    buffer = store.get('difference');
    isDiff = true;
  }

  if (buffer) {
    updateGridDisplay({
      buffer,
      step,
      channelKey: chKey,
      isDifference: isDiff,
      isFlat
    });

    // Feed wind layer
    if (store.get('windEnabled')) {
      setWindData(buffer, step);
    }

    // Update legend
    const legendContainer = document.getElementById('legend-container');
    const chMeta = channelByKey(chKey);
    renderLegend(legendContainer, chKey, isDiff, chMeta ? chMeta.defaultRange : [0, 1]);
  }
}

function handleCellHover(cell, point) {
  const tooltip = document.getElementById('map-tooltip');
  if (!cell || !point) {
    tooltip.style.display = 'none';
    return;
  }

  tooltip.style.display = 'block';
  tooltip.style.left = `${point.x + 12}px`;
  tooltip.style.top = `${point.y + 12}px`;
  tooltip.innerHTML = `
    <div style="font-weight:600;margin-bottom:2px;">Cell [${cell.row}, ${cell.col}]</div>
    <div style="color:var(--text-secondary);font-size:10px;">${cell.lat.toFixed(1)}°N, ${cell.lon.toFixed(1)}°E</div>
    <div style="margin-top:4px;color:var(--accent);font-family:var(--font-mono);">${cell.value.toFixed(2)}</div>
  `;
}

function handleCellPinned(cell) {
  const norm = store.get('normalRollout');
  const shock = store.get('shockedRollout');
  const steps = store.get('steps');
  const chMeta = channelByKey(store.get('selectedChannel'));
  const chIdx = chMeta ? chMeta.index : 0;

  if (norm && shock) {
    const normSeries = [];
    const shockSeries = [];
    for (let s = 0; s < steps; s++) {
      normSeries.push(norm[flatIndexStep(s, chIdx, cell.row, cell.col)]);
      shockSeries.push(shock[flatIndexStep(s, chIdx, cell.row, cell.col)]);
    }

    document.getElementById('pinned-cell-title').textContent = `Cell (${cell.lat.toFixed(1)}°N, ${cell.lon.toFixed(1)}°E)`;
    renderSeriesChart(document.getElementById('series-chart-container'), {
      normalSeries: normSeries,
      shockedSeries: shockSeries,
      unit: chMeta.unit
    });
  }
}

function showErrorNotification(msg) {
  const notif = document.getElementById('notification-toast');
  notif.textContent = msg;
  notif.style.display = 'block';
  setTimeout(() => { notif.style.display = 'none'; }, 6000);
}
