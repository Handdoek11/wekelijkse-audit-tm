import { getGoogleAccessToken } from "../utils/google-auth.js";
import { getGCSMonthPath, getPreviousMonth, getLastNDays } from "../utils/date-helpers.js";
import { logger } from "../utils/logger.js";

const STORAGE_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const REPORTING_SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting";
const CTX = "play";

/**
 * @typedef {Object} GooglePlayResult
 * @property {number|null} android_downloads
 * @property {number|null} android_rating
 * @property {number|null} android_crashes
 * @property {Object|null} android_reviews_snapshot
 */

/**
 * Collect Google Play metrics: downloads (GCS CSV), ratings (GCS CSV), crashes (Reporting API).
 * @returns {Promise<GooglePlayResult>}
 */
export default async function collectGooglePlay() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const bucket = process.env.PLAY_GCS_BUCKET;
  const packageName = process.env.PLAY_PACKAGE_NAME;

  if (!email || !privateKey || !bucket || !packageName) {
    throw new Error("Missing Google Play env vars (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, PLAY_GCS_BUCKET, PLAY_PACKAGE_NAME)");
  }

  logger.info("Fetching Google Play metrics...", CTX);

  const [downloads, rating, crashes] = await Promise.allSettled([
    fetchDownloads(email, privateKey, bucket, packageName),
    fetchRating(email, privateKey, bucket, packageName),
    fetchCrashes(email, privateKey, packageName),
  ]);

  const result = {
    android_downloads: unwrap(downloads, "downloads"),
    android_rating: unwrap(rating, "rating"),
    android_crashes: unwrap(crashes, "crashes"),
    android_reviews_snapshot: null, // reviews could be added later via Developer API v3
  };

  logger.info(`Collected: ${result.android_downloads ?? "?"} downloads, ${result.android_rating ?? "?"} rating`, CTX);
  return result;
}

/**
 * Fetch install counts from GCS CSV export.
 * @param {string} email
 * @param {string} privateKey
 * @param {string} bucket
 * @param {string} packageName
 * @returns {Promise<number>}
 */
async function fetchDownloads(email, privateKey, bucket, packageName) {
  const token = await getGoogleAccessToken(email, privateKey, STORAGE_SCOPE);
  const csv = await fetchGCSCsv(token, bucket, packageName, "installs", "installs");
  const rows = parseUTF16CSV(csv);

  // Sum "Daily Device Installs" for the last 7 available days
  const header = rows[0];
  const installIdx = header.findIndex((h) => h.includes("Daily Device Installs"));
  if (installIdx === -1) {
    throw new Error("Column 'Daily Device Installs' not found in installs CSV");
  }

  const dataRows = rows.slice(1).filter((r) => r.length > installIdx);
  const lastDay = dataRows.slice(-1);
  return lastDay.reduce((sum, row) => sum + (parseInt(row[installIdx], 10) || 0), 0);
}

/**
 * Fetch aggregate rating from GCS CSV export.
 * @param {string} email
 * @param {string} privateKey
 * @param {string} bucket
 * @param {string} packageName
 * @returns {Promise<number>}
 */
async function fetchRating(email, privateKey, bucket, packageName) {
  const token = await getGoogleAccessToken(email, privateKey, STORAGE_SCOPE);
  const csv = await fetchGCSCsv(token, bucket, packageName, "ratings", "ratings");
  const rows = parseUTF16CSV(csv);

  const header = rows[0];
  const ratingIdx = header.findIndex((h) => h.includes("Total Average Rating"));
  if (ratingIdx === -1) {
    throw new Error("Column 'Total Average Rating' not found in ratings CSV");
  }

  const dataRows = rows.slice(1).filter((r) => r.length > ratingIdx);
  const lastRow = dataRows[dataRows.length - 1];
  return parseFloat(lastRow[ratingIdx]) || 0;
}

/**
 * Fetch crash count from Play Developer Reporting API.
 * @param {string} email
 * @param {string} privateKey
 * @param {string} packageName
 * @returns {Promise<number>}
 */
async function fetchCrashes(email, privateKey, packageName) {
  const token = await getGoogleAccessToken(email, privateKey, REPORTING_SCOPE);

  const now = new Date();
  const endDate = {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate() - 1,
  };
  const startDate = {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate() - 1,
  };

  const res = await fetch(
    `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${packageName}/crashRateMetricSet:query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timelineSpec: {
          aggregationPeriod: "DAILY",
          startTime: { ...startDate, hours: 0 },
          endTime: { ...endDate, hours: 0 },
        },
        metrics: ["distinctUsers"],
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Play Reporting API ${res.status}: ${body}`);
  }

  const data = await res.json();
  let total = 0;
  for (const row of data.rows ?? []) {
    for (const metric of row.metrics ?? []) {
      total += parseInt(metric.decimalValue?.value ?? "0", 10);
    }
  }
  return total;
}

/**
 * Fetch a GCS CSV file. Tries current month first, falls back to previous month.
 * @param {string} token
 * @param {string} bucket
 * @param {string} packageName
 * @param {string} category  e.g., "installs" or "ratings"
 * @param {string} prefix    e.g., "installs" or "ratings"
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchGCSCsv(token, bucket, packageName, category, prefix) {
  const now = new Date();
  const currentMonth = getGCSMonthPath(now);
  const path = `stats/${category}/${prefix}_${packageName}_${currentMonth}_overview.csv`;

  let res = await fetchGCSObject(token, bucket, path);

  // Fall back to previous month if current month's file doesn't exist yet
  if (res.status === 404) {
    const prev = getPreviousMonth(now);
    const prevMonth = getGCSMonthPath(prev);
    const prevPath = `stats/${category}/${prefix}_${packageName}_${prevMonth}_overview.csv`;
    logger.warn(`Current month CSV not found, trying previous month`, CTX);
    res = await fetchGCSObject(token, bucket, prevPath);
  }

  if (!res.ok) {
    throw new Error(`GCS fetch failed (${res.status}) for ${category}`);
  }

  return res.arrayBuffer();
}

/**
 * @param {string} token
 * @param {string} bucket
 * @param {string} objectPath
 * @returns {Promise<Response>}
 */
async function fetchGCSObject(token, bucket, objectPath) {
  const encoded = encodeURIComponent(objectPath);
  return fetch(
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encoded}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

/**
 * Parse a UTF-16 LE encoded CSV (tab-separated) into rows of string arrays.
 * @param {ArrayBuffer} buffer
 * @returns {string[][]}
 */
function parseUTF16CSV(buffer) {
  const text = new TextDecoder("utf-16le").decode(buffer);
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("\t"));
}

/**
 * @template T
 * @param {PromiseSettledResult<T>} result
 * @param {string} label
 * @returns {T|null}
 */
function unwrap(result, label) {
  if (result.status === "fulfilled") return result.value;
  logger.error(`Failed to fetch ${label}: ${result.reason?.message ?? result.reason}`, CTX);
  return null;
}
