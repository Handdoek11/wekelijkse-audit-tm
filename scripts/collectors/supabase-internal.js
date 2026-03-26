import { createClient } from "@supabase/supabase-js";
import { getDateRange } from "../utils/date-helpers.js";
import { logger } from "../utils/logger.js";

const CTX = "internal";

/**
 * TalkMark pricing per plan (monthly, in EUR).
 * Source of truth from TalkMark-Mapping.
 */
const PLAN_PRICES = {
  trial: 0,
  basis: 9.99,
  pro: 19.99,
  business: 49.99,
};

/**
 * @typedef {Object} InternalResult
 * @property {number|null} mrr
 * @property {number|null} churn_rate
 * @property {number|null} new_signups
 * @property {number|null} active_users
 */

/**
 * Query internal Supabase tables for SaaS metrics.
 *
 * TalkMark schema:
 * - `subscriptions` with columns: user_id, status (active|trialing|trial|past_due|cancelled),
 *    plan_id (trial|basis|pro|business), current_period_end, trial_ends_at,
 *    mollie_customer_id, mollie_subscription_id
 * - `auth.users` (built-in Supabase auth) with: created_at, last_sign_in_at
 * - `usage` with: user_id, month (YYYY-MM), minutes_transcribed, summaries_generated
 *
 * Payment is via Mollie (not Stripe). MRR is calculated from plan_id prices.
 *
 * @returns {Promise<InternalResult>}
 */
export default async function collectSupabaseInternal() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error("Missing env vars (SUPABASE_URL, SUPABASE_SERVICE_KEY)");
  }

  logger.info("Fetching internal SaaS metrics...", CTX);

  // Service role key bypasses RLS
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { startDate } = getDateRange(7);

  const [mrr, churn, signups, active] = await Promise.allSettled([
    fetchMRR(supabase),
    fetchChurnRate(supabase, startDate),
    fetchNewSignups(supabase, startDate),
    fetchActiveUsers(supabase, startDate),
  ]);

  const result = {
    mrr: unwrap(mrr, "MRR"),
    churn_rate: unwrap(churn, "churn rate"),
    new_signups: unwrap(signups, "signups"),
    active_users: unwrap(active, "active users"),
  };

  logger.info(`Collected: MRR=${result.mrr ?? "?"}, churn=${result.churn_rate ?? "?"}%`, CTX);
  return result;
}

/**
 * Calculate MRR from active subscriptions using plan_id-based pricing.
 * TalkMark uses Mollie for payments — there is no `amount` column,
 * so we derive revenue from the plan_id.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<number>}
 */
async function fetchMRR(supabase) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan_id")
    .eq("status", "active");

  if (error) throw new Error(`MRR query failed: ${error.message}`);

  return (data ?? []).reduce((sum, row) => {
    const price = PLAN_PRICES[row.plan_id] ?? 0;
    return sum + price;
  }, 0);
}

/**
 * Churn rate: subscriptions cancelled in period / active at start of period * 100.
 * Uses status = 'cancelled' with current_period_end in the date range.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} startDate  YYYY-MM-DD
 * @returns {Promise<number>}
 */
async function fetchChurnRate(supabase, startDate) {
  // Count subscriptions that became cancelled in this period
  const { count: cancelled, error: e1 } = await supabase
    .from("subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("status", "cancelled")
    .gte("current_period_end", startDate);

  if (e1) throw new Error(`Churn cancelled query failed: ${e1.message}`);

  // Active at start of period ≈ currently active + recently cancelled
  const { count: currentActive, error: e2 } = await supabase
    .from("subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");

  if (e2) throw new Error(`Churn active query failed: ${e2.message}`);

  const baseCount = (currentActive ?? 0) + (cancelled ?? 0);
  if (baseCount === 0) return 0;

  return Math.round(((cancelled ?? 0) / baseCount) * 10000) / 100;
}

/**
 * Count of users created in the last 7 days.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} startDate
 * @returns {Promise<number>}
 */
async function fetchNewSignups(supabase, startDate) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw new Error(`Signups query failed: ${error.message}`);

  const start = new Date(startDate).getTime();
  return (data?.users ?? []).filter(
    (u) => new Date(u.created_at).getTime() >= start
  ).length;
}

/**
 * Count of users who signed in during the last 7 days.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} startDate
 * @returns {Promise<number>}
 */
async function fetchActiveUsers(supabase, startDate) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw new Error(`Active users query failed: ${error.message}`);

  const start = new Date(startDate).getTime();
  return (data?.users ?? []).filter(
    (u) => u.last_sign_in_at && new Date(u.last_sign_in_at).getTime() >= start
  ).length;
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
