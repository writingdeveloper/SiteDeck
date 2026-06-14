# SiteDeck

**English** · [한국어](README.ko.md)

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
2. Enable the **Google Analytics Admin API** and **Google Analytics Data API**.
3. Configure the OAuth consent screen: **External**, and add yourself as a **test user**.
4. Create credentials → **OAuth client ID** → **Desktop app** → download the JSON.
5. Save it as `credentials.json` in the project root (git-ignored). See [`credentials.json.example`](credentials.json.example) for the format.

## Run

```bash
npm start        # http://localhost:4317
```

On first launch you sign in with Google once; the refresh token is stored only in `~/.sitedeck/token.json`.

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
