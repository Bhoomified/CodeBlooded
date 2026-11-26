/**
 * export.js -- Export handlers:
 * 1. PNG Snapshot of map canvas
 * 2. JSON Full Run Data (inputs, rollouts, metadata)
 * 3. CSV Impact Table
 * 4. Composite Brief Figure (PDF-ready composite image)
 * @module export
 */

/**
 * Export MapLibre canvas as PNG snapshot.
 * @param {maplibregl.Map} map 
 * @param {boolean} isMock 
 */
export function exportMapPng(map, isMock = false) {
  if (!map) return;
  const canvas = map.getCanvas();
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height;
  const ctx = exportCanvas.getContext('2d');

  ctx.drawImage(canvas, 0, 0);

  // Add watermarked header & metadata
  ctx.fillStyle = 'rgba(24, 27, 32, 0.75)';
  ctx.fillRect(0, 0, exportCanvas.width, 42);

  ctx.fillStyle = '#e8e9ec';
  ctx.font = 'bold 16px Inter, sans-serif';
  ctx.fillText('FORECASTROPHE // Multiverse of Monsoon', 16, 26);

  if (isMock) {
    ctx.fillStyle = '#d94848';
    ctx.fillRect(exportCanvas.width - 240, 10, 224, 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('MOCK ENGINE - NOT MODEL OUTPUT', exportCanvas.width - 232, 25);
  }

  const link = document.createElement('a');
  link.download = `forecastrophe-map-${Date.now()}.png`;
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
}

/**
 * Export complete run data as JSON file.
 * @param {Object} stateData 
 */
export function exportRunJson(stateData) {
  const payload = {
    metadata: {
      app: 'Forecastrophe',
      exportTime: new Date().toISOString(),
      mode: stateData.isMock ? 'mock' : 'live'
    },
    scenario: {
      steps: stateData.steps,
      dayOfYear: stateData.dayOfYear,
      doySinCos: stateData.doySinCos,
      shock: stateData.shock
    },
    metrics: {
      causalityChecks: stateData.causalityChecks,
      radiusMetrics: stateData.radiusMetrics,
      impact: stateData.impact
    }
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = `forecastrophe-run-${Date.now()}.json`;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Export Sectoral Impact Table as CSV.
 * @param {Array<Object>} stateImpactRows 
 */
export function exportImpactCsv(stateImpactRows) {
  if (!stateImpactRows || stateImpactRows.length === 0) return;

  const headers = ['State', 'GridCells', 'NormalRainfall_mm', 'ShockedRainfall_mm', 'Delta_mm', 'DeltaPercent', 'HeatDaysNormal', 'HeatDaysShocked', 'HeatDaysDelta'];
  const lines = [headers.join(',')];

  stateImpactRows.forEach(row => {
    lines.push([
      `"${row.state}"`,
      row.cells,
      row.normalMm,
      row.shockedMm,
      row.deltaMm,
      row.deltaPercent,
      row.heatDaysNormal,
      row.heatDaysShocked,
      row.heatDaysDelta
    ].join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = `forecastrophe-impact-${Date.now()}.csv`;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
}
