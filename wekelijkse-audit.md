# Automated weekly SaaS audit for TalkMark: the complete architecture

**GitHub Actions orchestrating four API collectors that write to a Supabase table, served by a client-side Chart.js dashboard, is the most practical architecture for a solo founder.** This approach costs $0, handles all four data sources within generous execution limits, and avoids the reliability gotchas of Supabase pg_cron. The alternatives — Inngest for durable execution or Metabase for zero-code dashboards — are strong runners-up depending on your priorities.

What follows is a deep technical guide covering every component: scheduling and orchestration, authenticating with each API from Deno/TypeScript, the real limitations you'll hit, dashboard generation options, and a concrete implementation path.

---

## The orchestration layer: why GitHub Actions beats pg_cron

Supabase's pg_cron → pg_net → Edge Function pipeline is the official way to schedule recurring work, but it has sharp edges that matter for a multi-API collection job. **Edge Functions have a 400-second wall-clock time limit on paid plans, with a 150-second request/idle timeout across all tiers** — if an Edge Function doesn't send a response within 150 seconds, the client receives a 504 Gateway Timeout. The 200-millisecond CPU time limit per request sounds alarming but excludes async I/O (all your `fetch()` calls), so it's rarely the binding constraint. The real problems are structural: pg_net fires HTTP requests as fire-and-forget with **no built-in retry if the Edge Function fails**, response data is stored in unlogged tables (lost on crash), and free-tier projects pause after one week of inactivity — which would silently break a weekly cron job.

If you still want to use pg_cron, here's the exact SQL:

```sql
-- Store secrets in Supabase Vault
SELECT vault.create_secret('https://your-project.supabase.co', 'project_url');
SELECT vault.create_secret('YOUR_SERVICE_ROLE_KEY', 'service_key');

-- Schedule weekly Monday 9 AM UTC
SELECT cron.schedule(
  'weekly-audit',
  '0 9 * * 1',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
           || '/functions/v1/collect-weekly-data',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_key')
    ),
    body := concat('{"time":"', now(), '"}')::jsonb
  ) AS request_id;
  $$
);
```

**GitHub Actions is the better choice** for this specific workload. You get a **6-hour execution limit** (vs. 400 seconds), full Node.js with any npm package, built-in encrypted secrets management, and it costs exactly $0 for a weekly job consuming ~10 minutes of the 2,000 free monthly minutes on private repos. The main caveat: scheduled workflows can be delayed 5–20 minutes during peak load (irrelevant for weekly jobs) and are disabled after 60 days of repository inactivity.

```yaml
name: Weekly TalkMark Audit
on:
  schedule:
    - cron: '0 9 * * 1'  # Monday 9 AM UTC
  workflow_dispatch: {}    # Manual trigger for testing

jobs:
  collect:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: node scripts/collect-all.js
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
          GOOGLE_PRIVATE_KEY: ${{ secrets.GOOGLE_PRIVATE_KEY }}
          GOOGLE_SERVICE_ACCOUNT_EMAIL: ${{ secrets.GOOGLE_SA_EMAIL }}
          GA4_PROPERTY_ID: ${{ secrets.GA4_PROPERTY_ID }}
          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          ASC_PRIVATE_KEY: ${{ secrets.ASC_PRIVATE_KEY }}
```

**Inngest** deserves mention as the reliability-optimized alternative. Its killer feature is **durable, per-step execution**: if your App Store Connect API call fails, only that step retries — not the entire function. It supports timezone-aware cron, has an excellent TypeScript SDK, and is free for 50,000 runs/month. The trade-off is deploying an app to a serverless platform (Vercel or Netlify) to host the Inngest functions.

| Criteria | GitHub Actions | Supabase pg_cron | Inngest |
|---|---|---|---|
| **Cost** | $0 | $0 (free) / $25/mo (Pro) | $0 |
| **Execution limit** | 6 hours | 150s idle / 400s wall-clock (Pro) | Platform-dependent |
| **Step-level retries** | No (manual) | No | Yes (automatic) |
| **Setup effort** | YAML + script | SQL + Edge Function | SDK + serverless deploy |
| **Failure handling** | Manual try/catch | Fire-and-forget | Automatic per-step |

---

## Authenticating with Google APIs from Deno and TypeScript

Both GA4 and Google Play APIs use the same authentication flow: create a JWT signed with an RSA private key, exchange it for an OAuth2 access token, then call the API. **The `jose` library is the only reliable choice for JWT signing in Deno** — the `googleapis` npm package has known compatibility issues with Supabase Edge Runtime, and `google-auth-library` has recurring Deno compatibility problems — notably dependency conflicts (e.g., `gcp-metadata` pulling in breaking transitive dependencies) and unresolvable top-level await errors. These issues resurface unpredictably across Deno and library versions.

The shared authentication function works for both services:

```typescript
import { SignJWT, importPKCS8 } from "jose"; // or "npm:jose@5"

async function getGoogleAccessToken(
  email: string, privateKey: string, scope: string
): Promise<string> {
  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "RS256");
  const jwt = await new SignJWT({
    iss: email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token failed: ${JSON.stringify(data)}`);
  return data.access_token;
}
```

### GA4 Data API: sessions, users, bounce rate, and acquisition

The GA4 Data API v1beta endpoint accepts a JSON body specifying date ranges, dimensions, and metrics. Call it at `POST https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport` with scope `https://www.googleapis.com/auth/analytics.readonly`. The service account email must be added as a **Viewer** in GA4 Admin → Property Access Management.

Key metric names: `sessions`, `activeUsers`, `newUsers`, `bounceRate`, `screenPageViews`, `averageSessionDuration`. Key dimensions for acquisition: `sessionSource`, `sessionMedium`, `sessionDefaultChannelGrouping`. Rate limits are token-based — **200,000 tokens per property per day** on standard properties, with simple queries costing 5–10 tokens each. Add `"returnPropertyQuota": true` to monitor usage.

```typescript
async function fetchGA4Report(accessToken: string, propertyId: string) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        dimensions: [{ name: "sessionDefaultChannelGrouping" }],
        metrics: [
          { name: "sessions" }, { name: "activeUsers" },
          { name: "bounceRate" }, { name: "screenPageViews" },
        ],
      }),
    }
  );
  return res.json();
}
```

### Google Play: the API fragmentation problem

Google Play's data access is split across **three separate systems** with significant gaps between them, and this is the single most frustrating integration in the stack.

The **Google Play Developer API v3** covers reviews (with text and ratings) but not download counts, aggregate ratings, or DAU. The **Play Developer Reporting API** covers Android Vitals (crash rates, ANR rates) but not installs or engagement. **Download counts, aggregate star ratings, and DAU are only available through Google Cloud Storage CSV exports** — monthly files that Google deposits into a GCS bucket linked to your Play Console account.

| Data point | REST API available? | How to access |
|---|---|---|
| Reviews (text + rating) | ✅ Developer API v3 | `GET /androidpublisher/v3/applications/{pkg}/reviews` |
| Crash rate, ANR rate | ✅ Reporting API | `POST /v1beta1/apps/{pkg}/crashRateMetricSet:query` |
| Download/install counts | ❌ | GCS CSV: `stats/installs/installs_{pkg}_{YYYYMM}_overview.csv` |
| Aggregate star rating | ❌ | GCS CSV: `stats/ratings/ratings_{pkg}_{YYYYMM}_overview.csv` |
| DAU/MAU | ❌ | Not available programmatically at all |

The GCS CSV files are **UTF-16 LE encoded** and have a 2–3 day data delay. Access them via `https://storage.googleapis.com/storage/v1/b/{bucket}/o/{path}?alt=media` with scope `https://www.googleapis.com/auth/devstorage.read_only`. Find your bucket ID in Play Console → Download reports → Copy Cloud Storage URI. The service account must be granted read permissions in Play Console → Setup → API access.

---

## App Store Connect: ES256 JWT and the multi-step analytics dance

Apple's API uses **ES256 (ECDSA P-256) JWT authentication** — different from Google's RS256. Generate an API key in App Store Connect → Users and Access → Integrations → Keys. You'll get an Issuer ID, Key ID, and a .p8 private key file that **can only be downloaded once**.

Critical Deno compatibility note: **the `jsonwebtoken` npm package does NOT work** for ES256 in Deno due to a known curve-naming bug (Deno reports `p256` instead of `prime256v1`). Once again, **`jose` is the correct library**:

```typescript
import { SignJWT, importPKCS8 } from "jose";

async function generateAppStoreToken(
  issuerId: string, keyId: string, privateKey: string
): Promise<string> {
  const key = await importPKCS8(privateKey, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
    .setIssuer(issuerId)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt()
    .setExpirationTime("20m")  // Apple maximum
    .sign(key);
}
```

Apple provides three data systems. **Sales and Trends** (`GET /v1/salesReports`) returns next-day download and revenue data as gzip-compressed TSV — the simplest path to download numbers. **Analytics Reports** (introduced v3.4, March 2024) provides crash data, sessions, and engagement metrics but requires a **multi-step process**: create a report request → list reports → get instances → get segment URLs → download data. The first request takes **1–2 days to generate**, so set up the `ONGOING` report request immediately. **Customer Reviews** (`GET /v1/apps/{id}/customerReviews`) gives individual ratings in JSON — you must compute averages yourself.

For the Sales and Trends response, use Deno's built-in `DecompressionStream`:

```typescript
async function fetchSalesReport(token: string, vendorNumber: string, date: string) {
  const params = new URLSearchParams({
    "filter[reportType]": "SALES",
    "filter[reportSubType]": "SUMMARY",
    "filter[frequency]": "DAILY",
    "filter[vendorNumber]": vendorNumber,
    "filter[reportDate]": date,
  });
  const res = await fetch(
    `https://api.appstoreconnect.apple.com/v1/salesReports?${params}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/a-gzip" } }
  );
  const blob = await res.blob();
  const decompressed = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).text();
}
```

Rate limits are approximately **3,600 requests/hour** with an undocumented ~300/minute soft cap. Data availability: Sales and Trends by ~8 AM Pacific next day; Analytics Reports daily after initial 1–2 day setup; reviews in near real-time.

---

## The dashboard: a single HTML file is all you need to start

Four approaches were evaluated, and the winner is clear for a bootstrapped solo founder.

**Storing generated HTML in Supabase Storage does not work.** Supabase forces `text/plain` content type on HTML files as a security measure against deceptive webpages — even if you set the mimetype metadata to `text/html`. This is an intentional platform-wide restriction, not a bug. A Custom Domain add-on exists but applies to the API endpoint, not to Storage bucket URLs specifically. Workarounds (e.g., a CloudFront proxy) add complexity that defeats the purpose. This is a dealbreaker that eliminates what would otherwise be the simplest option.

**A client-side Chart.js page fetching from Supabase's PostgREST API is the fastest path to a working dashboard.** Store your weekly metrics in a `weekly_metrics` table, set up a public-read RLS policy, and host a single HTML file on GitHub Pages or Cloudflare Pages. Total cost: $0. Total setup: ~2 hours. The page fetches fresh data on every load via `https://your-project.supabase.co/rest/v1/weekly_metrics?apikey=YOUR_ANON_KEY&order=week_start.desc`.

```sql
-- Supabase table for aggregated metrics
CREATE TABLE weekly_metrics (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  mrr NUMERIC, churn_rate NUMERIC, new_signups INT, active_users INT,
  ga4_sessions INT, ga4_bounce_rate NUMERIC, ga4_users INT,
  android_downloads INT, android_rating NUMERIC, android_crashes INT,
  ios_downloads INT, ios_rating NUMERIC, ios_crashes INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Public read access (note: this makes ALL rows readable by anyone with the anon key,
-- which is exposed in your client-side code. Fine for non-sensitive KPI data,
-- but do not store anything confidential in this table.)
ALTER TABLE weekly_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON weekly_metrics FOR SELECT USING (true);
```

For polish without coding, **self-hosted Metabase** connected directly to your Supabase PostgreSQL is the strongest alternative. It provides a visual query builder, professional-looking dashboards, scheduled email reports, and runs in a single Docker container on a **$5–10/month VPS**. Grafana is overkill for business metrics — it excels at infrastructure monitoring but requires more configuration for KPI-style dashboards.

If you want a custom-designed dashboard with full control, **Astro + Netlify with weekly deploy hooks** is the best middle ground. The Edge Function triggers a Netlify build hook URL after writing data, Astro fetches from Supabase at build time, and Netlify serves the static site. Zero runtime costs, version-controlled design, and full CSS/charting freedom.

| Approach | Setup time | Cost | Best for |
|---|---|---|---|
| Chart.js + PostgREST fetch | 1–2 hours | $0 | Getting started fast |
| Astro + deploy hooks | 3–5 hours | $0 | Custom design, long-term |
| Self-hosted Metabase | 1–2 hours | $5–10/mo | Zero-code dashboards |

---

## Open-source tools worth knowing about

**Metabase** (47k GitHub stars, AGPL) remains the gold standard for self-hosted BI. It connects natively to PostgreSQL, has a no-code query builder, and the open-source edition includes all core features without watermarks. Docker setup is a one-liner. **Chartbrew** is a lighter alternative with native Supabase support and SQL-based chart building, but starting with v4 it switched to a Functional Source License (FSL-1.1-MIT) — not truly open-source, though each version auto-converts to MIT after two years. It also requires Node.js + Redis + a database — heavier than Metabase's single container.

For free admin dashboard templates to use with Approach C, **Tabler** (39k stars, MIT license) and **Flowbite Admin Dashboard** (Tailwind + ApexCharts) provide professional-quality layouts you can strip down to just the chart panels you need. **PlainAdmin** offers a clean Bootstrap 5 template with Chart.js already integrated.

Two non-open-source tools deserve mention for the SaaS metrics use case specifically: **ChartMogul** is free for companies under $120K ARR and provides purpose-built MRR, churn, and cohort tracking — but it integrates with Stripe, not Mollie. Since **TalkMark uses Mollie for billing**, ChartMogul is not a direct fit. **ProfitWell** (now Paddle) is free forever for core subscription metrics but also lacks a Mollie integration. For TalkMark, MRR must be calculated from the `subscriptions` table using plan-based pricing (Basis €9.99, Pro €19.99, Business €49.99).

---

## Recommended implementation path

The most practical architecture for a solo founder combines GitHub Actions for orchestration, Supabase for data storage, and a simple Chart.js dashboard:

**Week 1**: Set up the data layer. Create the `weekly_metrics` table in Supabase. Configure service accounts for Google (one service account works for both GA4 and Play Console) and generate an App Store Connect API key. Create the `ONGOING` Analytics Reports request in App Store Connect immediately — it takes 1–2 days to initialize.

**Week 2**: Build the collection script. Write a single `collect-all.js` Node.js script that sequentially calls GA4, fetches Play Console GCS CSV exports, queries App Store Connect Sales and Trends, reads Supabase subscription data via SQL, and inserts one row into `weekly_metrics`. Test it locally. Note that **DAU from Google Play is not available programmatically** — accept this gap or add a manual input step.

**Week 3**: Wire up automation and dashboard. Commit the GitHub Actions workflow YAML. Build a single HTML page using a template like PlainAdmin with Chart.js, fetching from the PostgREST API. Deploy to GitHub Pages. Verify the full pipeline runs end-to-end on the next Monday.

**Future upgrades**: If you outgrow the single HTML file, migrate to Astro for a polished multi-page dashboard. If you want per-step retries and better observability, swap GitHub Actions for Inngest. If you're tired of maintaining the collection script, note that ChartMogul and ProfitWell do not integrate with Mollie — the custom MRR calculation from the `subscriptions` table remains necessary.

The entire system runs on free tiers across every service, takes roughly **15–20 hours of focused development**, and once running, requires near-zero maintenance for a weekly audit cadence.