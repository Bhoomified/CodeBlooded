/**
 * doy.js -- Day-of-year computation.
 * Verbatim port of the kit's contract.doy_sincos(day).
 * No hardcoded dates; no year references.
 * @module doy
 */

const TWO_PI = 2 * Math.PI;
const DAYS_IN_YEAR = 365;

/**
 * Compute [sin, cos] encoding for a day-of-year.
 * Default convention: sin(2*pi*doy/365), cos(2*pi*doy/365).
 * @param {number} dayOfYear - Integer 1..365 (or 366)
 * @returns {[number, number]} [sin, cos]
 */
export function computeDoySinCos(dayOfYear) {
  const angle = TWO_PI * dayOfYear / DAYS_IN_YEAR;
  return [Math.sin(angle), Math.cos(angle)];
}

/**
 * Compute doy_sincos for a forecast step.
 * Forecast day k uses dayOfYear + k.
 * @param {number} baseDoy - DOY of the last input day
 * @param {number} step    - Forecast step (0 = last input, 1..N = forecast)
 * @returns {[number, number]}
 */
export function forecastDoySinCos(baseDoy, step) {
  return computeDoySinCos(((baseDoy + step - 1) % DAYS_IN_YEAR) + 1);
}

/* ------------------------------------------------------------------ */
/*  Month/day <-> DOY conversion (non-leap year, no year reference)    */
/* ------------------------------------------------------------------ */

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Cumulative days before each month (0-indexed). */
const CUM_DAYS = (() => {
  const a = [0];
  for (let i = 0; i < 12; i++) a.push(a[i] + MONTH_DAYS[i]);
  return a;
})();

/**
 * Day-of-year (1-based) to { month, day, label }.
 * @param {number} doy - 1..365
 * @returns {{ month: number, day: number, label: string }}
 */
export function dayOfYearToMonthDay(doy) {
  const d = Math.max(1, Math.min(365, Math.round(doy)));
  let m = 0;
  while (m < 11 && d > CUM_DAYS[m + 1]) m++;
  const day = d - CUM_DAYS[m];
  return { month: m + 1, day, label: `${day} ${MONTH_NAMES[m]}` };
}

/**
 * Month (1-12) and day (1-31) to day-of-year (1-based).
 * @param {number} month
 * @param {number} day
 * @returns {number}
 */
export function monthDayToDayOfYear(month, day) {
  const m = Math.max(1, Math.min(12, month));
  const d = Math.max(1, Math.min(MONTH_DAYS[m - 1], day));
  return CUM_DAYS[m - 1] + d;
}

/**
 * Format a DOY for display: "15 Jul (DOY 196)".
 * @param {number} doy
 * @returns {string}
 */
export function formatDoy(doy) {
  const { label } = dayOfYearToMonthDay(doy);
  return `${label} (DOY ${doy})`;
}
