# SiteDeck — Page Insights (PageSpeed) feature design

## Goal

Add a **Performance** view to SiteDeck that periodically measures each site's
PageSpeed Insights (Lighthouse) scores and tracks them over time, alongside the
existing GA4 traffic dashboard.

## Scope (approved)

- **Scores**: Lighthouse 4 categories — Performance, Accessibility, Best Practices,
  SEO (0–100), **mobile** strategy.
- **URLs**: auto-derived from each GA4 property's web data stream URL
  (Admin API `webStreamData.defaultUri`).
- **Cadence**: automatic measurement while the app/server is running (daily),
  plus a manual "측정" (measure now) button. No OS-level scheduling.
- **History**: persisted locally so scores can be trended over time.

### Non-goals (this iteration)

- Desktop strategy (mobile only for now).
- OS-scheduled measurement when the app is closed.
- Per-audit detail / opportunities / Core Web Vitals field data.
- Alerting on score regressions.
- Multiple web streams per property → only the **first** web stream's URL is used.

## Prerequisite (one-time)

Enable the **PageSpeed Insights API** and create an **API key** in the existing
`sitedeck-499322` GCP project. The key is stored locally only (see Config) and
never committed. (Can be done via browser automation.)

## Architecture

New modules:

- `src/psi.ts` — `fetchPsiScores(apiKey, url)`: calls PSI v5 `runPagespeed`
  (mobile, 4 categories) and returns `{ performance, accessibility,
  bestPractices, seo }` as 0–100 integers (null per missing category).
- `src/insights-store.ts` — JSON-file store at `~/.sitedeck/insights.json`:
  append a measurement, read latest + history per URL, trim to the retention cap.
  Pure transforms over an in-memory object + thin load/save.
- `src/scheduler.ts` — on server start, run an initial measurement if data is
  stale (older than the interval), then `setInterval` to re-measure. A single
  in-flight run at a time.
- `src/config.ts` (extend) — resolve the PSI API key (`SITEDECK_PSI_KEY` env →
  `~/.sitedeck/config.json` `psiApiKey`); add `INSIGHTS_PATH`, `CONFIG_JSON_PATH`,
  interval, concurrency, and retention constants.
- `src/ga.ts` (extend) — `listSiteUrls(auth)`: for each property, fetch its first
  web data stream `defaultUri` via Admin API; returns
  `{ propertyId, displayName, url }[]` (properties with no web stream are skipped).

## Data model

`~/.sitedeck/insights.json`:

```json
{
  "version": 1,
  "lastRunAt": "2026-06-13T09:00:00Z",
  "byUrl": {
    "https://example.com/": {
      "displayName": "Example",
      "history": [
        { "ts": "2026-06-13T09:00:00Z", "performance": 87, "accessibility": 95, "bestPractices": 92, "seo": 100 }
      ]
    }
  }
}
```

- History trimmed to the most recent `INSIGHTS_RETENTION` (default 90) entries per URL.

`~/.sitedeck/config.json` (user-local, outside repo, never committed):

```json
{ "psiApiKey": "..." }
```

## PSI API

- `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url={url}&strategy=mobile&category=PERFORMANCE&category=ACCESSIBILITY&category=BEST_PRACTICES&category=SEO&key={key}`
- Parse `lighthouseResult.categories.{performance|accessibility|best-practices|seo}.score`
  (0–1) → `Math.round(score * 100)`.
- ~15–30 s per URL. Measured with limited concurrency (default 2) — gentle and
  well within quota (25k/day with key).

## Scheduler behavior

- On server start: load the store; if `lastRunAt` is missing or older than
  `INSIGHTS_INTERVAL` (24 h), trigger a measurement run (non-blocking).
- `setInterval(INSIGHTS_INTERVAL)` re-checks and re-measures.
- One run at a time via an `isMeasuring` flag; a manual trigger while running is
  rejected with `reason: "already-running"`.
- A run: get site URLs (from GA, cached for the session) → measure each (limited
  concurrency) → append results → save. Per-URL failures become an `errors[]`
  entry and do not abort the run.

## API

- `GET /api/insights` →
  ```json
  {
    "configured": true,
    "isMeasuring": false,
    "lastRunAt": "2026-06-13T09:00:00Z",
    "sites": [
      { "url": "https://example.com/", "displayName": "Example",
        "latest": { "ts": "…", "performance": 87, "accessibility": 95, "bestPractices": 92, "seo": 100 },
        "trend": [87, 88, 90] }
    ],
    "errors": []
  }
  ```
  - `configured: false` when no PSI key → UI shows a setup hint.
- `POST /api/insights/measure` → starts a background run:
  `{ started: true }` or `{ started: false, reason: "already-running" | "not-configured" }`.

## UI

- Add a tab bar to the dashboard header: **트래픽** (existing GA table) | **성능** (insights).
- Performance tab table: `사이트 | 성능 | 접근성 | 모범사례 | SEO | 측정 시각 | 추세`.
  - Scores as 0–100 badges colored by Lighthouse thresholds: **≥90 green, 50–89
    orange, <50 red**; missing → "—".
  - Trend = performance-score sparkline (reuse the existing sparkline helper).
  - "지금 측정" button → POST measure → poll `/api/insights` until `isMeasuring`
    clears, then refresh.
  - States: not-configured (setup hint), measuring (progress), empty, error.

## Testing (TDD for pure logic)

- `psi.ts` score parsing: response object → scores, including missing categories.
- `insights-store.ts`: append, trim to retention, latest, trend extraction.
- staleness check: `lastRunAt` + interval + now → should-measure boolean.
- GA `listSiteUrls` and PSI calls verified live against the real account.

## Error handling

- No PSI key → `/api/insights` returns `configured:false`; tab shows setup steps.
- PSI per-URL failure → recorded in `errors[]`; other URLs continue.
- Property without a web data stream → excluded from insights.
- Corrupt `insights.json` → start fresh (rename the bad file to `.bak`).

## Defaults (tunable constants)

- Strategy: mobile · Interval: 24 h · Concurrency: 2 · Retention: 90 entries/URL.
