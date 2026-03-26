import { generateAppStoreToken } from "../utils/apple-auth.js";
import { getLastNDays, formatDateForApple } from "../utils/date-helpers.js";
import { logger } from "../utils/logger.js";

const BASE = "https://api.appstoreconnect.apple.com";
const CTX = "asc";

/**
 * @typedef {Object} AppStoreResult
 * @property {number|null} ios_downloads
 * @property {number|null} ios_rating
 * @property {number|null} ios_crashes
 * @property {number|null} ios_reviews_count
 */

/**
 * Collect App Store Connect metrics: downloads, ratings, crashes.
 * @returns {Promise<AppStoreResult>}
 */
export default async function collectAppStore() {
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyId = process.env.ASC_KEY_ID;
  const privateKey = process.env.ASC_PRIVATE_KEY;
  const vendorNumber = process.env.ASC_VENDOR_NUMBER;
  const appId = process.env.ASC_APP_ID;

  if (!issuerId || !keyId || !privateKey || !vendorNumber || !appId) {
    throw new Error("Missing App Store Connect env vars (ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY, ASC_VENDOR_NUMBER, ASC_APP_ID)");
  }

  logger.info("Fetching App Store Connect metrics...", CTX);

  // Generate a fresh token for each batch (20 min expiry)
  const token = await generateAppStoreToken(issuerId, keyId, privateKey);

  const [downloads, reviews, crashes] = await Promise.allSettled([
    fetchDownloads(token, vendorNumber),
    fetchReviews(token, appId),
    fetchCrashes(token, appId),
  ]);

  const result = {
    ios_downloads: unwrap(downloads, "downloads"),
    ios_rating: unwrap(reviews, "reviews")?.avgRating ?? null,
    ios_reviews_count: unwrap(reviews, "reviews")?.count ?? null,
    ios_crashes: unwrap(crashes, "crashes"),
  };

  logger.info(`Collected: ${result.ios_downloads ?? "?"} downloads, ${result.ios_rating ?? "?"} rating`, CTX);
  return result;
}

/**
 * Fetch daily Sales Reports for the last 7 days, sum units.
 * @param {string} token
 * @param {string} vendorNumber
 * @returns {Promise<number>}
 */
async function fetchDownloads(token, vendorNumber) {
  const days = getLastNDays(1);
  let totalUnits = 0;

  for (const day of days) {
    const dateStr = formatDateForApple(day);
    const params = new URLSearchParams({
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[frequency]": "DAILY",
      "filter[vendorNumber]": vendorNumber,
      "filter[reportDate]": dateStr,
    });

    const res = await fetch(`${BASE}/v1/salesReports?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/a-gzip",
      },
    });

    if (res.status === 404 || res.status === 400) {
      // Report not yet available for this date (data delay, typically 1-2 days)
      logger.debug(`Sales report not available for ${dateStr} (${res.status})`, CTX);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sales API ${res.status} for ${dateStr}: ${body}`);
    }

    const tsv = await decompressGzip(res);
    const units = parseSalesUnits(tsv);
    totalUnits += units;
  }

  return totalUnits;
}

/**
 * Fetch recent customer reviews and compute average rating.
 * @param {string} token
 * @param {string} appId
 * @returns {Promise<{ avgRating: number, count: number }>}
 */
async function fetchReviews(token, appId) {
  let url = `${BASE}/v1/apps/${appId}/customerReviews?sort=-createdDate&limit=200`;
  const ratings = [];

  // Paginate up to 3 pages (600 reviews max) for a representative average
  for (let page = 0; page < 3 && url; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Reviews API ${res.status}: ${body}`);
    }

    const data = await res.json();
    for (const review of data.data ?? []) {
      const rating = review.attributes?.rating;
      if (rating != null) ratings.push(rating);
    }

    url = data.links?.next ?? null;
  }

  if (ratings.length === 0) {
    return { avgRating: 0, count: 0 };
  }

  const avg = ratings.reduce((s, r) => s + r, 0) / ratings.length;
  return {
    avgRating: Math.round(avg * 100) / 100,
    count: ratings.length,
  };
}

/**
 * Fetch crash data from Analytics Reports (ONGOING report request).
 * @param {string} token
 * @param {string} appId
 * @returns {Promise<number|null>}
 */
async function fetchCrashes(token, appId) {
  // Step 1: Find the ONGOING analytics report request
  // The analyticsReportRequests endpoint requires going through the app relationship
  const reqRes = await fetch(
    `${BASE}/v1/apps/${appId}/analyticsReportRequests?filter[accessType]=ONGOING`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!reqRes.ok) {
    const body = await reqRes.text();
    throw new Error(`Analytics Report Requests API ${reqRes.status}: ${body}`);
  }

  const reqData = await reqRes.json();
  const reportRequest = reqData.data?.[0];
  if (!reportRequest) {
    logger.warn(
      "No ONGOING analytics report request found. Create one in App Store Connect > Analytics > Reports.",
      CTX
    );
    return null;
  }

  // Step 2: List reports for this request
  const reportsUrl = reportRequest.relationships?.reports?.links?.related;
  if (!reportsUrl) {
    logger.warn("No reports link found on report request", CTX);
    return null;
  }

  const reportsRes = await fetch(reportsUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!reportsRes.ok) return null;

  const reportsData = await reportsRes.json();
  const crashReport = (reportsData.data ?? []).find(
    (r) => r.attributes?.category === "APP_CRASHES"
  );

  if (!crashReport) {
    logger.warn("No APP_CRASHES report found in analytics reports", CTX);
    return null;
  }

  // Step 3: Get report instances (daily segments)
  const instancesUrl = crashReport.relationships?.instances?.links?.related;
  if (!instancesUrl) return null;

  const instRes = await fetch(`${instancesUrl}?limit=7`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!instRes.ok) return null;

  const instData = await instRes.json();
  let totalCrashes = 0;

  // Step 4: For each instance, fetch segment data
  for (const instance of instData.data ?? []) {
    const segUrl = instance.relationships?.segments?.links?.related;
    if (!segUrl) continue;

    const segRes = await fetch(segUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!segRes.ok) continue;

    const segData = await segRes.json();
    for (const seg of segData.data ?? []) {
      const downloadUrl = seg.attributes?.url;
      if (!downloadUrl) continue;

      const dataRes = await fetch(downloadUrl);
      if (!dataRes.ok) continue;

      const text = await dataRes.text();
      // CSV format: parse and sum crash counts
      const lines = text.trim().split("\n").slice(1); // skip header
      for (const line of lines) {
        const cols = line.split("\t");
        const count = parseInt(cols[cols.length - 1], 10);
        if (!isNaN(count)) totalCrashes += count;
      }
    }
  }

  return totalCrashes;
}

/**
 * Decompress a gzip response (Apple Sales Reports).
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function decompressGzip(res) {
  const blob = await res.blob();
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Parse Apple Sales Report TSV and sum units.
 * @param {string} tsv
 * @returns {number}
 */
function parseSalesUnits(tsv) {
  const lines = tsv.trim().split("\n");
  if (lines.length < 2) return 0;

  const header = lines[0].split("\t");
  const unitsIdx = header.findIndex((h) => h.trim() === "Units");
  if (unitsIdx === -1) return 0;

  let total = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    total += parseInt(cols[unitsIdx], 10) || 0;
  }
  return total;
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
