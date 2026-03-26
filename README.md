# TalkMark Weekly Audit Pipeline

Automated weekly collection of SaaS metrics from four sources, stored in Supabase and visualized in a Chart.js dashboard.

```
Monday 9 AM UTC
     │
     ▼
┌─ GitHub Actions ──────────────────────────────────┐
│                                                    │
│  ┌──────────┐ ┌───────────┐ ┌─────────┐ ┌──────┐ │
│  │   GA4    │ │Google Play│ │App Store│ │Supa- │ │
│  │ Data API │ │ GCS + API │ │Connect  │ │base  │ │
│  └────┬─────┘ └─────┬─────┘ └────┬────┘ └──┬───┘ │
│       └──────────────┼───────────┼──────────┘     │
│                      ▼                             │
│              weekly_metrics table                   │
└────────────────────────────────────────────────────┘
                       │
                       ▼
              Dashboard (Chart.js)
              hosted on GitHub Pages
```

## Data Sources

| Source | Metrics | Auth |
|---|---|---|
| **GA4 Data API** | Sessions, users, bounce rate, pageviews, channels | Google Service Account (RS256 JWT) |
| **Google Play** | Downloads (GCS CSV), ratings (GCS CSV), crashes (Reporting API) | Google Service Account |
| **App Store Connect** | Downloads (Sales Reports), ratings (Customer Reviews), crashes (Analytics Reports) | API Key (ES256 JWT) |
| **Supabase Internal** | MRR, churn rate, new signups, active users | Service Role Key |

## Prerequisites

- **Node.js 20+**
- **Supabase** project: `uznutxihifijmlgrfime` (already configured)
- **Google Cloud** project: `talkmark-4342d`
  - Service account: `claude-analytics-service@talkmark-4342d.iam.gserviceaccount.com`
  - GA4 Data API enabled, property ID: `509380524`
  - Cloud Storage API enabled (for Play GCS CSV exports)
  - Viewer access in GA4 property
  - Read access in Play Console (Setup > API access)
- **App Store Connect** API key (Issuer: `9723f96c-...`, Key: `VL56V55DN9`)
  - Create an **ONGOING** Analytics Reports request immediately — takes 1-2 days to initialize
- **Billing**: Mollie (not Stripe). MRR is calculated from plan_id prices in code.

## Setup

### 1. Database

Run the migration in your Supabase SQL Editor:

```sql
-- Copy contents of supabase/migrations/001_create_weekly_metrics.sql
```

### 2. Environment

Copy `.env.example` to `.env` and fill in all values. See the file for documentation on each variable.

### 3. Test locally

```bash
npm install

# Dry run — prints collected data without inserting
npm run collect:dry-run

# Full run — collects and inserts into Supabase
npm run collect
```

### 4. GitHub Actions

Add all environment variables from `.env.example` as **repository secrets** in GitHub (Settings > Secrets and variables > Actions).

The workflow runs automatically every Monday at 9 AM UTC. You can also trigger it manually from the Actions tab.

### 5. Dashboard

1. Supabase URL and anon key are already configured in `dashboard/index.html`.
2. Enable GitHub Pages on the `main` branch with `/dashboard` as the source folder.
3. The dashboard is now live and fetches fresh data on every page load.

## Project Structure

```
├── .github/workflows/weekly-audit.yml  # Cron + manual trigger
├── dashboard/index.html                # Self-contained Chart.js dashboard
├── scripts/
│   ├── collect-all.js                  # Orchestrator (parallel collectors, upsert)
│   ├── collectors/
│   │   ├── ga4.js                      # GA4 Data API
│   │   ├── google-play.js              # Play GCS CSVs + Reporting API
│   │   ├── app-store.js                # ASC Sales, Reviews, Analytics
│   │   └── supabase-internal.js        # MRR, churn, signups, active users
│   └── utils/
│       ├── google-auth.js              # Google OAuth2 JWT (RS256, cached)
│       ├── apple-auth.js               # Apple ES256 JWT
│       ├── date-helpers.js             # Week start, date ranges, formatting
│       └── logger.js                   # Structured logging
├── supabase/migrations/                # SQL schema
├── .env.example                        # All required env vars documented
└── package.json
```

## Data Availability Delays

| Source | Delay | Notes |
|---|---|---|
| GA4 | Near real-time | — |
| Google Play GCS CSV | 2-3 days | Falls back to previous month on 1st-3rd |
| Apple Sales Reports | Next day ~8 AM PT | 404 for dates not yet available |
| Apple Analytics Reports | 1-2 days | Requires ONGOING request to be set up first |

## Error Handling

- Each collector runs independently via `Promise.allSettled`. One failing collector does not stop the others.
- Partial data (some `null` columns) is inserted rather than losing all data.
- The pipeline exits with code 1 only if **all four** collectors fail.
- On failure, a GitHub Issue is automatically created with a link to the run logs.

## TalkMark-specifieke configuratie

De `supabase-internal.js` collector is afgestemd op het TalkMark schema:
- **Subscriptions** tabel met `plan_id` (trial/basis/pro/business) en `status` (active/trialing/cancelled/past_due)
- **MRR** wordt berekend op basis van plan-prijzen: Basis €9.99, Pro €19.99, Business €49.99
- **Betalingen** lopen via **Mollie** (niet Stripe)
- **iOS in-app purchases** via RevenueCat (apart, niet meegenomen in MRR-berekening)

## Nog op te zoeken / in te vullen

| Item | Waar te vinden | Status |
|---|---|---|
| `PLAY_GCS_BUCKET` | Play Console > Download reports > Copy Cloud Storage URI | TODO |
| `ASC_VENDOR_NUMBER` | App Store Connect > Sales and Trends (bovenaan) | TODO |
| `ASC_PRIVATE_KEY` | Ophalen uit CodeMagic secrets (`$APP_STORE_CONNECT_PRIVATE_KEY`) | TODO |
| `ASC_APP_ID` | App Store Connect > App Information > Apple ID (numeriek) | TODO |
