/**
 * Returns the Monday of the current week as YYYY-MM-DD (UTC).
 * @returns {string}
 */
export function getWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return formatDate(monday);
}

/**
 * Returns { startDate, endDate } for the last `daysBack` days (UTC), ending yesterday.
 * @param {number} daysBack
 * @returns {{ startDate: string, endDate: string }}
 */
export function getDateRange(daysBack = 7) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end.getTime() - (daysBack - 1) * 86_400_000);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

/**
 * Returns YYYYMMDD for Apple Sales Reports.
 * @param {Date} date
 * @returns {string}
 */
export function formatDateForApple(date) {
  return formatDate(date).replace(/-/g, "");
}

/**
 * Returns YYYYMM for GCS CSV file paths.
 * @param {Date} date
 * @returns {string}
 */
export function getGCSMonthPath(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

/**
 * Returns a Date for the first day of the previous month (UTC).
 * @param {Date} date
 * @returns {Date}
 */
export function getPreviousMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
}

/**
 * @param {Date} date
 * @returns {string} YYYY-MM-DD
 */
export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns an array of Date objects for the last N days ending yesterday (UTC).
 * @param {number} days
 * @returns {Date[]}
 */
export function getLastNDays(days = 7) {
  const result = [];
  const now = new Date();
  for (let i = days; i >= 1; i--) {
    result.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)));
  }
  return result;
}
