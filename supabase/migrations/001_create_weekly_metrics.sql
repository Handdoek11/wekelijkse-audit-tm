CREATE TABLE IF NOT EXISTS weekly_metrics (
  id              SERIAL PRIMARY KEY,
  week_start      DATE NOT NULL UNIQUE,

  -- GA4 Web Analytics
  ga4_sessions      INT,
  ga4_users         INT,
  ga4_bounce_rate   NUMERIC(5,2),
  ga4_pageviews     INT,
  ga4_top_channels  JSONB,

  -- Google Play (Android)
  android_downloads         INT,
  android_rating            NUMERIC(3,2),
  android_crashes           INT,
  android_reviews_snapshot  JSONB,

  -- App Store (iOS)
  ios_downloads     INT,
  ios_rating        NUMERIC(3,2),
  ios_crashes       INT,
  ios_reviews_count INT,

  -- Internal SaaS Metrics
  mrr             NUMERIC(10,2),
  churn_rate      NUMERIC(5,2),
  new_signups     INT,
  active_users    INT,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Public read-only access via anon key.
-- Note: all data in this table is readable by anyone with the anon key,
-- which is embedded in the client-side dashboard. Only store non-sensitive KPI data here.
ALTER TABLE weekly_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access"
  ON weekly_metrics
  FOR SELECT
  USING (true);

-- Service role (used by the collection script) bypasses RLS,
-- so no INSERT/UPDATE policy is needed.

-- Reuse existing update_updated_at_column() function from TalkMark database
CREATE TRIGGER weekly_metrics_updated_at
  BEFORE UPDATE ON weekly_metrics
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
