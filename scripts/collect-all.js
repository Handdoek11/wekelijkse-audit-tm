import { createClient } from "@supabase/supabase-js";
import { getToday } from "./utils/date-helpers.js";
import { logger } from "./utils/logger.js";
import collectGA4 from "./collectors/ga4.js";
import collectGooglePlay from "./collectors/google-play.js";
import collectAppStore from "./collectors/app-store.js";
import collectSupabaseInternal from "./collectors/supabase-internal.js";

const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const weekStart = getToday();
  logger.info(`Collecting metrics for week starting ${weekStart}`);

  // Run all four collectors in parallel — each failure is isolated
  const results = await Promise.allSettled([
    collectGA4(),
    collectGooglePlay(),
    collectAppStore(),
    collectSupabaseInternal(),
  ]);

  const [ga4, play, apple, internal] = results.map((r, i) => {
    const names = ["GA4", "Google Play", "App Store", "Supabase Internal"];
    if (r.status === "fulfilled") {
      logger.info(`${names[i]}: OK`, "orchestrator");
      return r.value;
    }
    logger.error(`${names[i]}: FAILED — ${r.reason?.message ?? r.reason}`, "orchestrator");
    return null;
  });

  // Check if all collectors failed
  if (!ga4 && !play && !apple && !internal) {
    logger.error("All collectors failed. Aborting.", "orchestrator");
    process.exit(1);
  }

  // Merge results into a single row
  const row = {
    date: weekStart,
    ...(ga4 ?? {}),
    ...(play ?? {}),
    ...(apple ?? {}),
    ...(internal ?? {}),
  };

  if (DRY_RUN) {
    logger.info("DRY RUN — collected data (not inserted):", "orchestrator");
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  // Upsert into Supabase (idempotent on date)
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { error } = await supabase
    .from("weekly_metrics")
    .upsert(row, { onConflict: "date" });

  if (error) {
    logger.error(`Supabase upsert failed: ${error.message}`, "orchestrator");
    process.exit(1);
  }

  logger.info(`Successfully stored metrics for week ${weekStart}`, "orchestrator");
}

main().catch((err) => {
  logger.error(`Unhandled error: ${err.message}`, "orchestrator");
  process.exit(1);
});
