# SiteDeck — GitHub repo traffic feature design

> **Handoff note (2026-06-20):** This spec was authored in a separate "Questions to
> Claude" session and dropped here so work can continue *inside the SiteDeck repo*.
> It is self-contained — no prior chat context is needed.
>
> **First action for the SiteDeck session:** confirm the **data model A vs B**
> decision (see *Open decision* below) with the owner, then run
> `superpowers:writing-plans` to expand this spec into a checkbox plan under
> `docs/superpowers/plans/2026-06-20-github-traffic.md`, then implement with
> `superpowers:subagent-driven-development`. Pure logic is TDD (matches CONTRIBUTING).

## Goal

Add a **Repos** view to SiteDeck that pulls each of the owner's GitHub repositories'
**traffic** (views / clones / referrers / popular paths) and tracks it over time,
alongside the existing GA4 / Performance / Search Console / GEO tabs — so "all my
sites *and* all my repos" live on one local screen.

## Why this fits SiteDeck (context for the implementer)

- GitHub is just a **fifth data source**. It mirrors the existing per-source module
  shape almost exactly:
  - **API client** → mirror `src/gsc.ts` (direct `fetch` + bearer token, no SDK —
    keeps SiteDeck dependency-light; do **not** add Octokit).
  - **Daily accumulation** → mirror `src/insights-store.ts` + `src/insights.ts`
    (the "measure once a day while the app runs" engine, persisted locally).
  - **Key/secret** → mirror the PSI key path: a token in `~/.sitedeck/config.json`,
    read via a `settings.ts` getter.
- **Auth is trivial here** because SiteDeck is **local + single-user + the owner's
  own repos**. No OAuth App, no GitHub App install, no multi-tenant token storage,
  no PIPA surface — the token sits next to the existing Google `credentials.json` /
  `token.json` under the same local-only trust model.

## The one real constraint: GitHub's 14-day window

GitHub's traffic API only returns the **trailing 14 days**. SiteDeck's existing
daily-accumulation store is exactly the workaround — snapshot daily into
`~/.sitedeck/github.json` and keep history beyond 14 days.

**Better than PSI:** PSI is a point-in-time score, so a day the app was closed is
lost forever. GitHub returns a **14-day window every call**, so if SiteDeck is
offline for up to ~13 days the next launch **backfills** the missed days. This
dictates the one real difference from the PSI store: **the store is keyed by
calendar date and upserted**, not appended-per-run (see *Data model*).
Caveat to surface in UI: offline > 14 consecutive days = a permanent gap.

## Open decision — data model A vs B (resolve before planning)

SiteDeck's other tabs are **site-centric** (everything hangs off a GA4 property's
web-stream URL; `gsc.ts:matchSites` maps GA4 → GSC by host). GitHub traffic is
**repo-centric** (`owner/repo`), which does not auto-attach to a GA4 property.

- **Model A — separate "Repos" tab (RECOMMENDED MVP).** Repos listed explicitly in
  `config.json`; their own tab keyed by `owner/repo`. Lowest friction, additive
  like PSI/GSC already are, doesn't touch the GA4 model. **This spec is written for
  Model A.**
- **Model B — unified per-site row.** Show GitHub columns next to GA4 metrics on the
  same row. More "SiteDeck-native", but needs a repo↔site mapping. **Feasible by
  reuse:** auto-match a repo's `homepage` host to a GA4 web-stream host with the
  existing `gsc.ts` `normalizeHost` / `matchSites` — *if* repos have `homepage` set.
  See *Model B variant* at the end.

**Recommendation:** ship Model A; key the store by `owner/repo` so Model B can layer
on later without a migration.

## Scope (Model A MVP)

- **Metrics accumulated daily (clean per-day integers):** views, unique views,
  clones, unique clones — per repo, per calendar day.
- **Live 14-day snapshot (not accumulated):** top-10 referrers, top-10 popular paths.
- **Repos:** taken from `githubRepos: ["owner/repo", …]` in `~/.sitedeck/config.json`.
- **Cadence:** automatic daily run while the app/server is running + a manual
  "측정 / measure now" button. No OS-level scheduling (same as Performance).
- **History:** persisted locally at `~/.sitedeck/github.json`, retention 90 days/repo.

### Non-goals (this iteration)

- Auto-discovering repos via `GET /user/repos` (explicit list only for now).
- Org repos where the token lacks Administration:Read (they simply error → `—`).
- Accumulating referrers/paths history (live snapshot only; sets churn daily).
- Model B mapping/unified row (documented as a variant; not built yet).
- OS-scheduled runs while the app is closed.

## Prerequisite (one-time)

Create a **fine-grained personal access token**:
github.com → Settings → Developer settings → **Fine-grained tokens** → Generate new:
- **Repository access:** only the repos to track.
- **Repository permissions → Administration: _Read-only_** (this is the permission
  the traffic API requires — confirmed against GitHub REST docs).

Save it locally (never committed), alongside the repo list:

```json
// ~/.sitedeck/config.json
{ "psiApiKey": "…", "githubToken": "github_pat_…", "githubRepos": ["writingdeveloper/SiteDeck"] }
```

(A classic PAT with the `repo` scope also works but is far broader — prefer
fine-grained. Env overrides `SITEDECK_GITHUB_TOKEN` / `SITEDECK_GITHUB_REPOS` mirror
the PSI key's `SITEDECK_PSI_KEY` convention.)

## Architecture

New modules (mirroring the PSI triad `psi.ts` / `insights-store.ts` / `insights.ts`):

- `src/github.ts` — API client (mirror `gsc.ts`). `ghRequest(token, url)` with
  timeout + non-2xx → throw; `fetchRepoTraffic(token, owner, repo)` →
  `{ views: DayCount[], clones: DayCount[], referrers, paths }`; pure parsers
  `parseViews` / `parseClones` / `parseReferrers` / `parsePaths`.
- `src/github-store.ts` — JSON store at `~/.sitedeck/github.json` (mirror
  `insights-store.ts`, **but date-keyed upsert**): `upsertDays`, `putSnapshot`,
  `summarize`, `loadStore` / `saveStore` (reuse `writeJsonAtomic` from `atomic.ts`,
  and the corrupt-file → `.bak` recovery already in `insights-store.ts:loadStore`).
- `src/github-runner.ts` — in-memory state + scheduler (mirror `insights.ts`):
  `initGithub`, `getGithubState`, `measureNow`, `startGithubScheduler` (reuse
  `shouldMeasure` from `insights-store.ts`; one in-flight run via a `measuring`
  flag; per-repo failures → `errors[]`, never abort the run).
- `src/config.ts` (extend) — add `GITHUB_STORE_PATH`, `GITHUB_INTERVAL_MS` (24 h),
  `GITHUB_RETENTION_DAYS` (90), `GITHUB_CONCURRENCY` (2).
- `src/settings.ts` (extend) — `getGithubToken(): string | null` and
  `getGithubRepos(): string[]` (env → `config.json` → null/[]), next to
  `getPsiApiKey`.
- `src/server.ts` (extend) — add `GET /api/github` + `POST /api/github/measure`;
  call `initGithub()` and `startGithubScheduler()` at startup (next to the insights
  wiring).
- `public/` — new **Repos** tab in `index.html` + render in `app.js` + styles;
  add i18n keys to all five `public/locales/*.json`.

## Data model

`~/.sitedeck/github.json`:

```json
{
  "version": 1,
  "lastRunAt": "2026-06-20T09:00:00Z",
  "byRepo": {
    "writingdeveloper/SiteDeck": {
      "displayName": "SiteDeck",
      "days": {
        "2026-06-19": { "views": 42, "uniqueViews": 8, "clones": 3, "uniqueClones": 2 }
      },
      "referrers": [{ "referrer": "github.com", "count": 30, "uniques": 10 }],
      "paths": [{ "path": "/writingdeveloper/SiteDeck", "title": "SiteDeck", "count": 50, "uniques": 12 }],
      "snapshotAt": "2026-06-20T09:00:00Z"
    }
  }
}
```

- `days` is a **date-keyed map** → each run upserts by `YYYY-MM-DD` so re-runs and
  backfills are idempotent (no double-counting — this is the key contract to test).
- Retention: drop `days` older than `GITHUB_RETENTION_DAYS` (90).
- `referrers` / `paths` are **replaced wholesale** each run (live 14-day snapshot).

## GitHub API

All requests: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`, `User-Agent: SiteDeck`, `AbortSignal.timeout(10_000)`.

- `GET /repos/{owner}/{repo}/traffic/views?per=day`
  → `{ count, uniques, views: [{ timestamp, count, uniques }] }`
- `GET /repos/{owner}/{repo}/traffic/clones?per=day`
  → `{ count, uniques, clones: [{ timestamp, count, uniques }] }`
- `GET /repos/{owner}/{repo}/traffic/popular/referrers`
  → `[{ referrer, count, uniques }]` (top 10)
- `GET /repos/{owner}/{repo}/traffic/popular/paths`
  → `[{ path, title, count, uniques }]` (top 10)

Requires **Administration: Read**. Single-user scale → ~4 calls/repo/day, far under
the 5,000/hr authenticated primary rate limit ("free, within quota", as elsewhere).

## API

- `GET /api/github` →
  ```json
  {
    "configured": true,
    "isMeasuring": false,
    "lastRunAt": "2026-06-20T09:00:00Z",
    "repos": [
      { "fullName": "writingdeveloper/SiteDeck", "displayName": "SiteDeck",
        "totals14d": { "views": 420, "uniqueViews": 80, "clones": 30, "uniqueClones": 20 },
        "trend": [12, 18, 9, 22],
        "referrers": [{ "referrer": "github.com", "count": 30, "uniques": 10 }],
        "paths": [{ "path": "/…", "title": "…", "count": 50, "uniques": 12 }],
        "snapshotAt": "2026-06-20T09:00:00Z" }
    ],
    "errors": []
  }
  ```
  - `configured: false` when no token → UI shows the PAT setup hint.
- `POST /api/github/measure` → background run:
  `{ started: true }` or `{ started: false, reason: "already-running" | "not-configured" }`.

## UI

- Add **Repos** to the existing header tab bar (트래픽 | 성능 | … | **Repos**).
- Table: `레포 | 조회수(14d) | 순방문 | 클론(14d) | 순클론 | 추세 | 갱신`.
  - Trend = daily-views sparkline (reuse the existing sparkline helper).
  - Row expand → top-10 **referrers** + **popular paths**, labeled "최근 14일".
  - States: not-configured (PAT + repo-list setup steps), measuring (progress),
    empty, and **token-expired/insufficient-permission** (reconnect hint, like GSC's
    `—` fallback).

## Testing (TDD for pure logic)

- `github.ts` parsers: views/clones response → day arrays + totals (incl. empty);
  referrers/paths parse.
- `github-store.ts`: **upsert idempotency** (same day twice → one entry, latest
  wins), **backfill merge** (overlapping 14-day windows union correctly), retention
  drop, summarize/trend extraction.
- staleness: reuse/verify `shouldMeasure`.
- Live verify against the owner's real repos once wired.

## Error handling

- No token → `/api/github` returns `configured:false`; tab shows setup steps.
- `401` / `403` (expired or missing Administration:Read) → repo error entry +
  reconnect hint; other repos continue.
- `404` (no access / renamed repo) → error entry, skip.
- `403` + `X-RateLimit-Remaining: 0` → back off; surface in `errors[]`.
- Corrupt `github.json` → rename to `.bak`, start fresh (reuse `loadStore` pattern).

## Defaults (tunable constants)

- Interval: 24 h · Retention: 90 days/repo · Concurrency: 2 · `per=day`.

## Model B variant (future — unified per-site row)

To merge GitHub into the GA4 site rows instead of a separate tab:

- Reuse `gsc.ts` `normalizeHost`/`matchSites`: match each repo's GitHub `homepage`
  host (from `GET /repos/{owner}/{repo}`) to a GA4 web-stream host. Matched repos add
  GitHub columns to that site's row; unmatched repos fall back to the Repos tab.
- Depends on repos having `homepage` set. Keep the store keyed by `owner/repo` so
  this is purely a presentation/join layer added later — no data migration.
