/**
 * diagnostics.js -- Parse and render server diagnostics.
 * Handles the optional "diagnostics" field from /simulate responses.
 * @module diagnostics
 */

/**
 * Parse a diagnostics payload from the server.
 * @param {any} raw - The diagnostics field from the response (may be null, array, or object)
 * @returns {{ entries: Array|null, modelBadges: Array|null, fallbackFired: boolean, raw: any }}
 */
export function parseDiagnostics(raw) {
  if (!raw) return { entries: null, modelBadges: null, fallbackFired: false, raw: null };

  let entries = null;
  let modelBadges = null;
  let fallbackFired = false;

  if (Array.isArray(raw)) {
    // Expected: array of { step, stage, event, detail, model? }
    entries = raw.map((item, i) => {
      if (typeof item !== 'object' || item === null) {
        return { step: i, stage: '?', event: '?', detail: String(item) };
      }
      return {
        step: item.step ?? i,
        stage: item.stage ?? '',
        event: item.event ?? '',
        detail: item.detail ?? '',
        model: item.model ?? null,
      };
    });

    // Extract model badges (which model served each step)
    const badgeMap = new Map();
    for (const e of entries) {
      if (e.model && e.step !== undefined) {
        badgeMap.set(e.step, e.model);
      }
    }
    if (badgeMap.size > 0) {
      modelBadges = [];
      for (const [step, model] of badgeMap) {
        modelBadges.push({ step, model });
      }
      modelBadges.sort((a, b) => a.step - b.step);
    }

    // Check for fallback events
    fallbackFired = entries.some(e =>
      e.event === 'fallback' ||
      e.model === 'persistence' ||
      e.model === 'ridge' ||
      (typeof e.detail === 'string' && e.detail.toLowerCase().includes('fallback'))
    );
  }

  return { entries, modelBadges, fallbackFired, raw };
}

/**
 * Render diagnostics into a panel container.
 * @param {HTMLElement} container
 * @param {{ normal: any, shocked: any }} diagnosticsData
 */
export function renderDiagnosticsPanel(container, diagnosticsData) {
  container.innerHTML = '';

  if (!diagnosticsData) {
    container.innerHTML = '<p class="text-label" style="padding:8px;">No diagnostics available for this run.</p>';
    return;
  }

  for (const [label, raw] of [['Normal run', diagnosticsData.normal], ['Shocked run', diagnosticsData.shocked]]) {
    const parsed = parseDiagnostics(raw);
    const section = document.createElement('div');
    section.style.marginBottom = '12px';

    const heading = document.createElement('div');
    heading.className = 'text-label';
    heading.style.padding = '4px 0';
    heading.textContent = label;
    section.appendChild(heading);

    if (parsed.fallbackFired) {
      const chip = document.createElement('span');
      chip.className = 'chip chip--warning';
      chip.textContent = 'Fallback fired';
      section.appendChild(chip);
    }

    if (parsed.entries) {
      const table = document.createElement('table');
      table.className = 'diag-table';
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:10px;';

      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Step</th><th>Stage</th><th>Event</th><th>Detail</th><th>Model</th></tr>';
      thead.querySelectorAll('th').forEach(th => {
        th.style.cssText = 'text-align:left;padding:2px 4px;border-bottom:1px solid var(--border);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);';
      });
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const e of parsed.entries) {
        const tr = document.createElement('tr');
        const isFallback = e.model === 'persistence' || e.model === 'ridge' || e.event === 'fallback';
        if (isFallback) tr.style.color = 'var(--warning)';
        tr.innerHTML = `
          <td class="text-mono" style="padding:2px 4px;">${e.step}</td>
          <td style="padding:2px 4px;">${escapeHTML(e.stage)}</td>
          <td style="padding:2px 4px;">${escapeHTML(e.event)}</td>
          <td style="padding:2px 4px;max-width:120px;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(String(e.detail))}</td>
          <td style="padding:2px 4px;">${e.model ? `<span class="badge badge--model">${escapeHTML(e.model)}</span>` : ''}</td>
        `;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      section.appendChild(table);
    } else if (parsed.raw) {
      // Raw JSON fallback
      const pre = document.createElement('pre');
      pre.className = 'text-mono';
      pre.style.cssText = 'padding:4px 8px;background:var(--surface);border-radius:2px;overflow:auto;max-height:200px;font-size:10px;white-space:pre-wrap;';
      pre.textContent = JSON.stringify(parsed.raw, null, 2);
      section.appendChild(pre);
    } else {
      const p = document.createElement('p');
      p.className = 'text-label';
      p.textContent = 'No diagnostics in response.';
      section.appendChild(p);
    }

    container.appendChild(section);
  }
}

/**
 * Render model badges on the timeline.
 * @param {HTMLElement} container - The timeline badge container
 * @param {Array<{step:number, model:string}>|null} badges
 */
export function renderModelBadges(container, badges) {
  container.innerHTML = '';
  if (!badges || badges.length === 0) return;
  for (const { step, model } of badges) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--model';
    badge.textContent = model;
    badge.title = `Step ${step}: served by ${model}`;
    badge.dataset.step = step;
    container.appendChild(badge);
  }
}

/** Escape HTML entities. */
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
