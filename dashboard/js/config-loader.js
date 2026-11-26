/**
 * config-loader.js -- Load and merge config.json + config.local.json.
 * config.local.json is optional (gitignored); its values override config.json.
 * @module config-loader
 */

/**
 * @typedef {Object} AppConfig
 * @property {string}  apiBase       - e.g. "http://localhost:8000"
 * @property {string}  mode          - "mock" | "live"
 * @property {string}  transport     - "lists" | "base64"
 * @property {string}  doyConvention - "default" (or future custom)
 * @property {number}  maxSteps      - Maximum forecast steps (default 14, up to 30)
 * @property {Object}  endpoints     - { health, simulate, presets, meta }
 * @property {string}  [maptilerKey] - Optional MapTiler API key
 */

/**
 * Load configuration from config.json, optionally overridden by config.local.json.
 * Both files are fetched relative to the document root (dashboard/).
 * @returns {Promise<AppConfig>}
 */
export async function loadConfig() {
  const base = await fetchJSON('config.json');
  if (!base) {
    throw new Error('Failed to load config.json. Ensure the file exists in dashboard/.');
  }

  // config.local.json is optional; 404 is silently ignored
  const local = await fetchJSON('config.local.json');

  const merged = { ...base, ...(local || {}) };

  // Merge nested endpoints
  if (base.endpoints && local && local.endpoints) {
    merged.endpoints = { ...base.endpoints, ...local.endpoints };
  }

  // Validate required fields
  if (!merged.apiBase) merged.apiBase = 'http://localhost:8000';
  if (!merged.mode) merged.mode = 'mock';
  if (!merged.transport) merged.transport = 'lists';
  if (!merged.doyConvention) merged.doyConvention = 'default';
  if (!merged.maxSteps || merged.maxSteps < 1) merged.maxSteps = 14;
  if (merged.maxSteps > 30) merged.maxSteps = 30;
  if (!merged.endpoints) {
    merged.endpoints = { health: '/health', simulate: '/simulate', presets: '/presets', meta: '/meta' };
  }

  return Object.freeze(merged);
}

/**
 * Fetch a JSON file, returning null on any error (including 404).
 * @param {string} path - Relative path from document root
 * @returns {Promise<Object|null>}
 */
async function fetchJSON(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
