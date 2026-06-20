# SiteDeck

**English** · [한국어](README.ko.md) · [Español](README.es.md) · [中文](README.zh.md) · [日本語](README.ja.md)

[![CI](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local dashboard that summarizes the key metrics of **all your Google Analytics 4 (GA4)
properties on a single screen** — no more opening each property one by one.

- **Metrics** — active users, sessions, key events (with period-over-period Δ% ▲▼), top page, top channel, and a daily trend sparkline
- **Periods** — 7 / 28 / 90-day toggle, sortable columns
- **Auth** — OAuth 2.0 loopback: sign in once with your Google account and every GA4 property you can access is collected automatically
- **Cost** — free, within the GA API quota

## Requirements

- Node.js ≥ 20 (developed on v22)

## Install

```bash
npm install
```

## Google Cloud setup (one-time, ~5 min)

1. Create a new project in the [Google Cloud Console](https://console.cloud.google.com).
2. Enable the **Google Analytics Admin API**, **Google Analytics Data API**, and **Google Search Console API**.
3. Configure the OAuth consent screen: **External**, and add yourself as a **test user**.
4. Create credentials → **OAuth client ID** → **Desktop app** → download the JSON.
5. Save it as `credentials.json` in **`~/.sitedeck/`** (create the folder if it doesn't exist; git-ignored). See [`credentials.json.example`](credentials.json.example) for the format. _(When running from source, a `credentials.json` in the project root is also picked up.)_

## Run

```bash
npm start        # http://localhost:4317
```

On first launch you sign in with Google once; the refresh token is stored only in `~/.sitedeck/token.json`.

## Performance (PageSpeed)

The **Performance** tab tracks each site's Lighthouse scores (Performance, Accessibility,
Best Practices, SEO) via the PageSpeed Insights API — measured automatically once a day
while the app is running, plus a manual **측정** (measure now) button. Scores are stored
locally in `~/.sitedeck/insights.json`, and the URLs are derived automatically from each
GA4 property's web data stream.

To enable it, add a PageSpeed Insights API key:

1. In the same GCP project, enable the **PageSpeed Insights API**.
2. Create an **API key** (APIs & Services → Credentials → Create credentials → API key).
3. Save it to `~/.sitedeck/config.json`:
   ```json
   { "psiApiKey": "YOUR_API_KEY" }
   ```
   (or set the `SITEDECK_PSI_KEY` environment variable).

## Search (Search Console)

The **Traffic** tab shows each site's Google Search performance — **Impressions**,
**Clicks**, and **average Position** — pulled from Search Console over the selected
period. It reuses the same Google sign-in (no extra key), so all it needs is:

1. The **Google Search Console API** enabled in your GCP project (setup step 2 above).
2. The Search Console scope granted. New sign-ins request it automatically; if you
   upgraded from an older version, **Settings → Reconnect** grants it once.
3. The site verified in [Search Console](https://search.google.com/search-console).
   A **Domain** property (`sc-domain:example.com`) also covers its subdomains; a
   URL-prefix property matches that exact host. Properties without a matching
   verified site simply show `—`.

Search Console data lags ~2–3 days, so the most recent days of a short period may
read low. This is best-effort: if the API/scope/verification isn't in place, the
columns show `—` and the rest of the dashboard is unaffected.

## Desktop app (Electron)

Run it as a native desktop window instead of in the browser:

```bash
npm run electron
```

Google sign-in opens in your default browser (Google blocks OAuth inside embedded webviews); after authenticating, refresh the app.

### Building an installer

```bash
npm run dist          # build an installer into release/
```

The desktop build **auto-updates** from GitHub Releases (via `electron-updater`). To publish a
release that installed apps will update to:

```bash
npm version patch                 # bump the version + create a tag
GH_TOKEN=<token> npm run release  # build + publish to GitHub Releases
```

Or push a `v*` tag and let the [release workflow](.github/workflows/release.yml) build and publish it.

> For a packaged/installed app, place `credentials.json` in `~/.sitedeck/` (the project root is only checked when run from source).

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Run the dashboard server |
| `npm run dev` | Restart on file changes |
| `npm run electron` | Run as a desktop (Electron) window |
| `npm run dist` | Package a desktop installer |
| `npm run release` | Build + publish a release to GitHub |
| `npm test` | Unit tests (vitest) |
| `npm run typecheck` | Type checking |

## Project structure

```
src/
  config.ts    constants, local paths, OAuth scope
  server.ts    HTTP server (/ dashboard, /api/summary, OAuth callback)
  periods.ts   period → current/previous date-range math
  auth.ts      OAuth loopback + token cache
  ga.ts        Admin property listing + Data API runReport
  summary.ts   per-site summary + Δ% assembly
public/        dashboard front-end (HTML/CSS/JS, dark theme)
electron/      desktop wrapper (Electron main + auto-updater)
```

## How it works

- For each property, the current and previous periods are fetched with parallel `runReport` calls; properties are collected in parallel too.
- Only complete days are counted (today, which is partial, is excluded).
- `credentials.json` and the token (`~/.sitedeck/token.json`) stay on your machine and are never committed.
- Only the read-only `analytics.readonly` scope is requested.

## Contributing

PRs welcome. Please ensure `npm run typecheck` and `npm test` pass. Pure logic is written test-first (TDD).

## License

[MIT](LICENSE) © Si Hyeong Lee
