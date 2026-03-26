import { getGoogleAccessToken } from "../utils/google-auth.js";
import { logger } from "../utils/logger.js";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const CTX = "ga4";

/**
 * @typedef {Object} GA4Result
 * @property {number|null} ga4_sessions
 * @property {number|null} ga4_users
 * @property {number|null} ga4_bounce_rate
 * @property {number|null} ga4_pageviews
 * @property {Object|null} ga4_top_channels
 */

/**
 * Collect GA4 analytics for the past 7 days.
 * @returns {Promise<GA4Result>}
 */
export default async function collectGA4() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const propertyId = process.env.GA4_PROPERTY_ID;

  if (!email || !privateKey || !propertyId) {
    throw new Error("Missing GA4 env vars (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GA4_PROPERTY_ID)");
  }

  logger.info("Fetching GA4 report...", CTX);

  const token = await getGoogleAccessToken(email, privateKey, SCOPE);

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
        dimensions: [{ name: "sessionDefaultChannelGrouping" }],
        metrics: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "bounceRate" },
          { name: "screenPageViews" },
        ],
        returnPropertyQuota: true,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GA4 API ${res.status}: ${body}`);
  }

  const data = await res.json();

  if (data.propertyQuota) {
    const remaining = data.propertyQuota.tokensPerDay?.remaining;
    logger.debug(`Quota remaining: ${remaining} tokens/day`, CTX);
  }

  // GA4 runReport returns rows per dimension, no totals field — aggregate manually
  let ga4_sessions = 0;
  let ga4_users = 0;
  let ga4_bounce_rate = 0;
  let ga4_pageviews = 0;
  const ga4_top_channels = {};

  for (const row of data.rows ?? []) {
    const channel = row.dimensionValues?.[0]?.value ?? "Unknown";
    const sessions = parseInt(row.metricValues?.[0]?.value ?? "0", 10);
    const users = parseInt(row.metricValues?.[1]?.value ?? "0", 10);
    const pageviews = parseInt(row.metricValues?.[3]?.value ?? "0", 10);

    ga4_sessions += sessions;
    ga4_users += users;
    ga4_pageviews += pageviews;
    ga4_top_channels[channel] = sessions;
  }

  // Bounce rate: weighted average across channels
  if (ga4_sessions > 0) {
    let weightedBounce = 0;
    for (const row of data.rows ?? []) {
      const sessions = parseInt(row.metricValues?.[0]?.value ?? "0", 10);
      const bounce = parseFloat(row.metricValues?.[2]?.value ?? "0");
      weightedBounce += bounce * sessions;
    }
    ga4_bounce_rate = weightedBounce / ga4_sessions;
  }

  logger.info(`Collected: ${ga4_sessions} sessions, ${ga4_users} users`, CTX);

  return {
    ga4_sessions,
    ga4_users,
    ga4_bounce_rate: Math.round(ga4_bounce_rate * 100) / 100,
    ga4_pageviews,
    ga4_top_channels,
  };
}
