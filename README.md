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

## On-page checks (GEO tab)

The **GEO** tab audits each site's homepage for on-page SEO and AI-search readiness
— free, no key needed. On open it fetches each homepage and checks for a non-empty
`<title>`, a meta description, a canonical URL, Open Graph tags, **JSON-LD
structured data**, and a **`/llms.txt`** file (the emerging AI-crawler standard),
with an X/6 readiness score. **Check now** re-runs the audit; the URLs come from
each GA4 property's web data stream.

It reads the **served HTML**, so signals injected later by client-side JavaScript
(common on single-page apps) can read as missing even when they're present after
render. A homepage that fails to load shows its error inline and never blocks the
other sites.

## GitHub traffic (Repos tab)

The **Repos** tab tracks each configured GitHub repository's traffic — **views**,
**unique views**, **clones**, **unique clones** (14-day totals + a daily trend),
plus its top **referrers** and **popular paths** (expand a row). GitHub's traffic
API only returns the **trailing 14 days**, so SiteDeck snapshots it once a day into
`~/.sitedeck/github.json` (keyed by calendar date, retention 90 days) to keep
history — and **backfills** any missed days on the next launch. Offline for **more
than 14 consecutive days** leaves a permanent gap.

### Creating the token

The traffic API is admin-only, so it needs a token. Use a **fine-grained personal access
token** — it can be limited to the repos you actually watch, unlike a classic token, whose
`repo` scope grants full read/write to everything you can reach.

1. Open **https://github.com/settings/personal-access-tokens/new**
   (github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens).
2. **Token name** — anything, e.g. `sitedeck`.
3. **Expiration** — fine-grained tokens *must* expire (1 year max). Note the date: when it
   lapses, collection stops silently (see *When the token expires* below).
4. **Repository access** — pick one:
   - **Only select repositories** (recommended) — choose the repos you want on the deck.
   - **All repositories** — every repo shows up in SiteDeck's picker, so you can add more
     later without re-issuing. The trade-off: one token then carries admin-read over every
     private repo you own, and SiteDeck stores it as plain text in `~/.sitedeck/config.json`.
5. **Permissions → Repository permissions → Administration: _Read-only_**. That single
   permission is what the traffic endpoints require. (*Metadata: Read-only* is added
   automatically and is what lets the repo picker list your repos.) Leave everything else
   at *No access*.
6. **Generate token** and copy it — GitHub shows it exactly once.
7. Paste it into **Settings → GitHub token** and press **Save**. It takes effect
   immediately, no restart.

Choosing *All repositories* does **not** by itself put every repo on the deck — SiteDeck
only measures what's in the repo list (next section). It just makes everything available
to pick.

### Rotating and revoking

**Clear** (next to the token field) removes the stored token; the Repos tab keeps the
history it already collected and simply stops updating. To rotate, generate a new token,
Save it over the old one, then delete the old one at
**https://github.com/settings/tokens?type=beta**. Saving a new token does not revoke the
old one — revoke it on GitHub.

### When the token expires

An expired or revoked token fails every request with `401 Bad credentials`, which the
Repos tab shows as a per-repo error row. Nothing else breaks — previously collected
history stays, and the daily run resumes once you save a valid token. Because GitHub's
traffic API only serves the trailing **14 days**, an expired token that goes unnoticed for
longer than that leaves a permanent hole in the history, so it is worth acting on the
error rows when they appear.

### Choosing repos

Press **Choose…** next to *GitHub repos*: SiteDeck asks GitHub which
repos that token can administer and shows them as a searchable checklist (newest push
first, archived ones omitted since they collect no traffic). The list *is* the token's
scope — grant the token more repos and more appear. You can also type `owner/repo`
entries by hand, comma-separated; hand-typed entries the picker can't see are kept when
you apply a selection.

### Where the settings live

Both values sit in `~/.sitedeck/config.json` (mode 0600, never commit it), so you can also
write them there directly:

```json
{ "psiApiKey": "…", "githubToken": "github_pat_…", "githubRepos": ["writingdeveloper/SiteDeck"] }
```

Env overrides `SITEDECK_GITHUB_TOKEN` / `SITEDECK_GITHUB_REPOS` mirror the PSI key —
when either is set it wins over the file, and Settings says so and locks that field.

Measurement runs automatically once a day while the app is open, plus a manual
**Measure now** button. With no token the tab links you to Settings; with a token but no
repos it says so; a repo the token can't read shows an error row and the others continue.

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
| `node scripts/audit-gate.mjs` | Dependency audit gate (high/critical, with dated waivers) |

### Dependency audit

CI fails on any high or critical advisory. When one has no safe fix — a patched version that
breaks a consumer, or an upstream that hasn't published yet — it can be waived in
`scripts/audit-gate.mjs` with a reason and an `until` date, rather than lowering the bar for
everything. The gate then fails on anything un-waived, and fails again once a waiver expires,
so an accepted risk stays a decision on the record instead of a check nobody looks at.

npm's headline count is larger than the advisory count: it counts every package along the
chain, so a single advisory deep in a dependency inflates every parent. The gate reports both.

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
