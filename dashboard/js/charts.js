/**
 * charts.js -- Hand-rolled SVG chart primitives:
 * 1. Response Radius Growth Chart (with theoretical limit line)
 * 2. Pinned Cell Time-Series Chart
 * 3. Latency History Bar Chart
 * 4. State Rainfall Deficit Horizontal Bar Chart
 * 5. Small Multiple Difference Snapshots (Days 1, 3, 6, 10)
 * @module charts
 */

/**
 * Render Response Radius (r90) by forecast day as an interactive SVG chart.
 * @param {HTMLElement} container 
 * @param {Array<{ day: number, r90: number, limitRadius: number, growthRate: number }>} data 
 */
export function renderRadiusChart(container, data) {
  if (!container || !data || data.length === 0) return;
  const w = container.clientWidth || 300;
  const h = 180;
  const pad = { top: 20, right: 20, bottom: 30, left: 35 };

  const maxDay = data.length - 1;
  const maxR = Math.max(...data.map(d => Math.max(d.r90, d.limitRadius)), 40);

  const x = (d) => pad.left + (d / (maxDay || 1)) * (w - pad.left - pad.right);
  const y = (r) => h - pad.bottom - (r / maxR) * (h - pad.top - pad.bottom);

  let limitPath = '';
  let r90Path = '';

  data.forEach((d, i) => {
    const px = x(d.day);
    const pyLim = y(d.limitRadius);
    const pyR = y(d.r90);

    limitPath += (i === 0 ? `M ${px} ${pyLim}` : ` L ${px} ${pyLim}`);
    r90Path += (i === 0 ? `M ${px} ${pyR}` : ` L ${px} ${pyR}`);
  });

  container.innerHTML = `
    <svg width="${w}" height="${h}" style="overflow:visible;font-family:var(--font-mono);font-size:9px;">
      <!-- Grid lines -->
      <line x1="${pad.left}" y1="${y(0)}" x2="${w - pad.right}" y2="${y(0)}" stroke="var(--border)" />
      <line x1="${pad.left}" y1="${y(maxR / 2)}" x2="${w - pad.right}" y2="${y(maxR / 2)}" stroke="var(--border)" stroke-dasharray="2,2" />
      <line x1="${pad.left}" y1="${y(maxR)}" x2="${w - pad.right}" y2="${y(maxR)}" stroke="var(--border)" stroke-dasharray="2,2" />

      <!-- Y Axis labels -->
      <text x="${pad.left - 6}" y="${y(0)}" text-anchor="end" fill="var(--text-dim)">0</text>
      <text x="${pad.left - 6}" y="${y(maxR / 2)}" text-anchor="end" fill="var(--text-dim)">${Math.round(maxR / 2)}</text>
      <text x="${pad.left - 6}" y="${y(maxR)}" text-anchor="end" fill="var(--text-dim)">${Math.round(maxR)}</text>

      <!-- Limit Line (Theoretical 3 + 8*(k+1)) -->
      <path d="${limitPath}" fill="none" stroke="var(--text-dim)" stroke-width="1.5" stroke-dasharray="3,3" />

      <!-- r90 Curve -->
      <path d="${r90Path}" fill="none" stroke="var(--accent)" stroke-width="2" />

      <!-- Data Dots -->
      ${data.map(d => `
        <circle cx="${x(d.day)}" cy="${y(d.r90)}" r="3" fill="var(--accent)" />
      `).join('')}

      <!-- X Axis Labels -->
      ${data.map((d, i) => i % 2 === 0 ? `
        <text x="${x(d.day)}" y="${h - 8}" text-anchor="middle" fill="var(--text-secondary)">D${d.day}</text>
      ` : '').join('')}
    </svg>
    <div style="display:flex;justify-content:space-between;padding:4px 8px;font-size:10px;" class="text-mono">
      <span style="color:var(--accent);">— Measured r90</span>
      <span style="color:var(--text-dim);">--- Physical Limit</span>
    </div>
  `;
}

/**
 * Render Pinned Cell Time-Series Chart.
 * @param {HTMLElement} container 
 * @param {Object} params
 * @param {number[]} params.normalSeries
 * @param {number[]} params.shockedSeries
 * @param {string} params.unit
 */
export function renderSeriesChart(container, { normalSeries, shockedSeries, unit }) {
  if (!container || !normalSeries) return;
  const w = container.clientWidth || 300;
  const h = 150;
  const pad = { top: 15, right: 15, bottom: 25, left: 35 };

  const allVals = [...normalSeries, ...shockedSeries];
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const span = maxV - minV || 1;

  const x = (i) => pad.left + (i / (normalSeries.length - 1 || 1)) * (w - pad.left - pad.right);
  const y = (v) => h - pad.bottom - ((v - minV) / span) * (h - pad.top - pad.bottom);

  let normPath = '';
  let shockPath = '';

  normalSeries.forEach((v, i) => {
    normPath += (i === 0 ? `M ${x(i)} ${y(v)}` : ` L ${x(i)} ${y(v)}`);
  });

  shockedSeries.forEach((v, i) => {
    shockPath += (i === 0 ? `M ${x(i)} ${y(v)}` : ` L ${x(i)} ${y(v)}`);
  });

  container.innerHTML = `
    <svg width="${w}" height="${h}" style="overflow:visible;font-family:var(--font-mono);font-size:9px;">
      <line x1="${pad.left}" y1="${h - pad.bottom}" x2="${w - pad.right}" y2="${h - pad.bottom}" stroke="var(--border)" />
      <text x="${pad.left - 4}" y="${y(minV)}" text-anchor="end" fill="var(--text-dim)">${minV.toFixed(1)}</text>
      <text x="${pad.left - 4}" y="${y(maxV)}" text-anchor="end" fill="var(--text-dim)">${maxV.toFixed(1)}</text>

      <path d="${normPath}" fill="none" stroke="#4a8fd4" stroke-width="1.8" />
      <path d="${shockPath}" fill="none" stroke="var(--accent)" stroke-width="2" />

      ${normalSeries.map((v, i) => i % 3 === 0 ? `
        <text x="${x(i)}" y="${h - 6}" text-anchor="middle" fill="var(--text-secondary)">D${i}</text>
      ` : '').join('')}
    </svg>
    <div style="display:flex;gap:12px;padding:2px 8px;font-size:10px;" class="text-mono">
      <span style="color:#4a8fd4;">— Prime (${unit})</span>
      <span style="color:var(--accent);">— Shocked (${unit})</span>
    </div>
  `;
}

/**
 * Render State Rainfall Deficit horizontal bar chart.
 * @param {HTMLElement} container 
 * @param {Array<{ state: string, deltaMm: number, deltaPercent: number }>} stateData 
 */
export function renderStateImpactBars(container, stateData) {
  if (!container || !stateData) return;
  const topStates = stateData.slice(0, 10);

  container.innerHTML = topStates.map(st => {
    const isNeg = st.deltaMm < 0;
    const barWidth = Math.min(100, Math.abs(st.deltaMm) * 4);
    const color = isNeg ? 'var(--error)' : 'var(--success)';

    return `
      <div style="margin-bottom:6px;font-size:10px;" class="text-mono">
        <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
          <span style="color:var(--text-primary);">${st.state}</span>
          <span style="color:${color};">${st.deltaMm > 0 ? '+' : ''}${st.deltaMm} mm (${st.deltaPercent}%)</span>
        </div>
        <div style="height:6px;background:var(--surface);border-radius:2px;overflow:hidden;">
          <div style="width:${barWidth}%;height:100%;background:${color};"></div>
        </div>
      </div>
    `;
  }).join('');
}
