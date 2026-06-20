# GitHub Repo Traffic (Repos tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Repos** tab to SiteDeck that pulls each configured GitHub repo's traffic (views / clones / referrers / popular paths), accumulates clean per-day integers locally beyond GitHub's 14-day window, and shows it alongside the GA4 / Performance / GSC / GEO tabs.

**Architecture:** Model A (separate, repo-centric tab). A new per-source module triad mirrors the PSI triad: `github.ts` (REST client + pure parsers, mirrors `gsc.ts`), `github-store.ts` (a **date-keyed, upserted** JSON store at `~/.sitedeck/github.json`, mirrors `insights-store.ts`), `github-runner.ts` (in-memory state + daily scheduler, mirrors `insights.ts`). Token + repo list live in `~/.sitedeck/config.json` (env-overridable), read via `settings.ts` getters. Two endpoints (`GET /api/github`, `POST /api/github/measure`) and a new front-end tab. No new npm dependency (no Octokit — direct `fetch` + bearer PAT).

**Tech Stack:** Node 20 + TypeScript (ESM, `tsx`/esbuild), vitest, global `fetch` + `AbortSignal.timeout`, plain-JS front-end. Source spec: `docs/superpowers/specs/2026-06-20-github-traffic-design.md`.

**Key contract (test this hardest):** the store's `days` is a date-keyed map; each run **upserts by `YYYY-MM-DD`** so re-runs and overlapping 14-day windows (backfill) are idempotent — never double-counted.

---

## File structure

**Create:**
- `src/github.ts` — REST client + pure parsers. Responsibility: talk to GitHub's traffic API and turn raw responses into clean typed values. Mirrors `src/gsc.ts`.
- `src/github.test.ts` — parser + client (stubbed-fetch) tests.
- `src/github-store.ts` — date-keyed upsert store. Responsibility: accumulate per-day integers, replace the live referrers/paths snapshot, summarize for the API, persist atomically. Mirrors `src/insights-store.ts`.
- `src/github-store.test.ts` — upsert idempotency / backfill / retention / summarize / persistence tests.
- `src/github-runner.ts` — in-memory state + scheduler. Responsibility: run a measurement (one in-flight), accumulate per repo, expose state, schedule the daily tick. Mirrors `src/insights.ts`.

**Modify:**
- `src/config.ts` — add `GITHUB_STORE_PATH`, `GITHUB_INTERVAL_MS`, `GITHUB_RETENTION_DAYS`, `GITHUB_CONCURRENCY`, `GITHUB_TREND_LENGTH`.
- `src/settings.ts` — extend `Settings` + `mergeSettings`; add `getGithubToken()` / `getGithubRepos()`.
- `src/settings.test.ts` — cover the new merge + getters.
- `src/server.ts` — add `GET /api/github` + `POST /api/github/measure`; wire `initGithub()` + `startGithubScheduler()` at startup.
- `public/index.html` — Repos tab button + `view-repos` section.
- `public/app.js` — `repos` UI module (render / load / measure / poll / row-expand) + tab wiring + filter + state.
- `public/locales/{en,ko,es,zh,ja}.json` — new i18n keys.

**Conventions to follow (already in the repo):** strict TS with `noUncheckedIndexedAccess` (index access is `T | undefined` — narrow or `as T` with care); tests are `src/**/*.test.ts` (vitest); pure logic is TDD; the stubbed-fetch test helper pattern is in `src/gsc.test.ts` / `src/onpage.test.ts`; store tests use `mkdtemp(tmpdir())` (see `src/insights-store.test.ts`).

---

### Task 1: Config constants

**Files:**
- Modify: `src/config.ts` (append next to the `INSIGHTS_*` block, after line ~52)

- [ ] **Step 1: Add the constants**

Append to `src/config.ts`:

```ts
/** GitHub repo-traffic config (mirrors the PSI/insights constants). */
export const GITHUB_STORE_PATH = path.join(CONFIG_DIR, 'github.json');
export const GITHUB_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GITHUB_RETENTION_DAYS = 90;
export const GITHUB_CONCURRENCY = 2;
export const GITHUB_TREND_LENGTH = 30;
```

(`path` and `CONFIG_DIR` are already imported/defined in `config.ts`.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(github): add repo-traffic config constants"
```

---

### Task 2: Settings — token + repo list

**Files:**
- Modify: `src/settings.ts`
- Test: `src/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/settings.test.ts` (import `mergeSettings` if not already imported at the top):

```ts
describe('mergeSettings — github', () => {
  it('keeps a trimmed token and a string-only repo list', () => {
    const s = mergeSettings({}, { githubToken: '  tok  ', githubRepos: ['o/r', '', 'a/b'] as unknown as string[] });
    expect(s.githubToken).toBe('tok');
    expect(s.githubRepos).toEqual(['o/r', 'a/b']);
  });

  it('clears the token when an empty string is patched in', () => {
    const s = mergeSettings({ githubToken: 'tok' }, { githubToken: '   ' });
    expect(s.githubToken).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/settings.test.ts`
Expected: FAIL — `mergeSettings` ignores `githubToken` / `githubRepos` (props are `undefined`).

- [ ] **Step 3: Extend `Settings` + `mergeSettings`**

In `src/settings.ts`, extend the interface:

```ts
export interface Settings {
  language?: Language;
  psiApiKey?: string;
  githubToken?: string;
  githubRepos?: string[];
}
```

In `mergeSettings`, before the final `return next;`, add:

```ts
  if (patch.githubToken !== undefined) {
    const trimmed = patch.githubToken.trim();
    if (trimmed) next.githubToken = trimmed;
    else delete next.githubToken;
  }
  if (patch.githubRepos !== undefined && Array.isArray(patch.githubRepos)) {
    const repos = patch.githubRepos.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim());
    if (repos.length) next.githubRepos = repos;
    else delete next.githubRepos;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the getters**

Append to `src/settings.ts` (mirrors `getPsiApiKey`):

```ts
/** GitHub PAT: SITEDECK_GITHUB_TOKEN env, else githubToken in config.json, else null. */
export function getGithubToken(): string | null {
  if (process.env.SITEDECK_GITHUB_TOKEN) return process.env.SITEDECK_GITHUB_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { githubToken?: unknown };
    return typeof cfg.githubToken === 'string' && cfg.githubToken ? cfg.githubToken : null;
  } catch {
    return null;
  }
}

/** Repo list: SITEDECK_GITHUB_REPOS (comma-separated) env, else githubRepos in config.json, else []. */
export function getGithubRepos(): string[] {
  const env = process.env.SITEDECK_GITHUB_REPOS;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { githubRepos?: unknown };
    return Array.isArray(cfg.githubRepos) ? cfg.githubRepos.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  } catch {
    return [];
  }
}
```

(`readFileSync` and `CONFIG_JSON_PATH` are already imported in `settings.ts`.)

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/settings.ts src/settings.test.ts
git commit -m "feat(github): read githubToken + githubRepos from settings/env"
```

---

### Task 3: `github.ts` — pure response parsers

**Files:**
- Create: `src/github.ts`
- Test: `src/github.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/github.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseViews, parseClones, parseReferrers, parsePaths } from './github';

describe('parseViews / parseClones', () => {
  it('maps the daily timestamp to a YYYY-MM-DD date and reads count/uniques', () => {
    expect(parseViews({ views: [{ timestamp: '2026-06-19T00:00:00Z', count: 42, uniques: 8 }] })).toEqual([
      { date: '2026-06-19', views: 42, uniqueViews: 8 },
    ]);
    expect(parseClones({ clones: [{ timestamp: '2026-06-19T00:00:00Z', count: 3, uniques: 2 }] })).toEqual([
      { date: '2026-06-19', clones: 3, uniqueClones: 2 },
    ]);
  });

  it('returns an empty array for a missing/empty payload and skips rows with no timestamp', () => {
    expect(parseViews({})).toEqual([]);
    expect(parseViews({ views: [{ count: 1 }] })).toEqual([]);
    expect(parseClones(null)).toEqual([]);
  });
});

describe('parseReferrers / parsePaths', () => {
  it('normalizes referrer and path rows and drops empties', () => {
    expect(parseReferrers([{ referrer: 'github.com', count: 30, uniques: 10 }, { count: 1 }])).toEqual([
      { referrer: 'github.com', count: 30, uniques: 10 },
    ]);
    expect(parsePaths([{ path: '/x', title: 'X', count: 50, uniques: 12 }])).toEqual([
      { path: '/x', title: 'X', count: 50, uniques: 12 },
    ]);
    expect(parseReferrers(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/github.test.ts`
Expected: FAIL — cannot import `./github` (module does not exist).

- [ ] **Step 3: Write `src/github.ts` (types + parsers)**

Create `src/github.ts`:

```ts
// GitHub repo-traffic client. Direct REST + bearer PAT (no Octokit) to keep
// SiteDeck dependency-light — mirrors src/gsc.ts.

export interface DayViews {
  date: string;
  views: number;
  uniqueViews: number;
}
export interface DayClones {
  date: string;
  clones: number;
  uniqueClones: number;
}
export interface Referrer {
  referrer: string;
  count: number;
  uniques: number;
}
export interface PathStat {
  path: string;
  title: string;
  count: number;
  uniques: number;
}
export interface RepoTraffic {
  views: DayViews[];
  clones: DayClones[];
  referrers: Referrer[];
  paths: PathStat[];
}

function rows(body: unknown, key: string): { timestamp?: unknown; count?: unknown; uniques?: unknown }[] {
  const arr = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(arr) ? (arr as { timestamp?: unknown; count?: unknown; uniques?: unknown }[]) : [];
}

/** Per-day views from GET /traffic/views?per=day. */
export function parseViews(body: unknown): DayViews[] {
  return rows(body, 'views')
    .filter((r) => typeof r.timestamp === 'string')
    .map((r) => ({ date: (r.timestamp as string).slice(0, 10), views: Number(r.count ?? 0), uniqueViews: Number(r.uniques ?? 0) }));
}

/** Per-day clones from GET /traffic/clones?per=day. */
export function parseClones(body: unknown): DayClones[] {
  return rows(body, 'clones')
    .filter((r) => typeof r.timestamp === 'string')
    .map((r) => ({ date: (r.timestamp as string).slice(0, 10), clones: Number(r.count ?? 0), uniqueClones: Number(r.uniques ?? 0) }));
}

/** Top-10 referrers from GET /traffic/popular/referrers. */
export function parseReferrers(body: unknown): Referrer[] {
  return (Array.isArray(body) ? body : [])
    .map((r) => ({ referrer: String(r?.referrer ?? ''), count: Number(r?.count ?? 0), uniques: Number(r?.uniques ?? 0) }))
    .filter((r) => r.referrer);
}

/** Top-10 popular paths from GET /traffic/popular/paths. */
export function parsePaths(body: unknown): PathStat[] {
  return (Array.isArray(body) ? body : [])
    .map((p) => ({ path: String(p?.path ?? ''), title: String(p?.title ?? ''), count: Number(p?.count ?? 0), uniques: Number(p?.uniques ?? 0) }))
    .filter((p) => p.path);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/github.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat(github): pure parsers for the traffic API responses (TDD)"
```

---

### Task 4: `github.ts` — REST client (`ghRequest` + `fetchRepoTraffic`)

**Files:**
- Modify: `src/github.ts`
- Modify: `src/github.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the top of `src/github.test.ts` (replace the existing import line and add the helper):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseViews, parseClones, parseReferrers, parsePaths, fetchRepoTraffic } from './github';

afterEach(() => vi.unstubAllGlobals());

function stubGh(byUrl: (url: string) => unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', (input: unknown) =>
    Promise.resolve({ ok, status, statusText: 'x', json: async () => byUrl(String(input)) } as unknown as Response),
  );
}
```

Then append:

```ts
describe('fetchRepoTraffic', () => {
  it('fetches and parses all four traffic endpoints', async () => {
    stubGh((url) => {
      if (url.includes('/views')) return { views: [{ timestamp: '2026-06-19T00:00:00Z', count: 42, uniques: 8 }] };
      if (url.includes('/clones')) return { clones: [{ timestamp: '2026-06-19T00:00:00Z', count: 3, uniques: 2 }] };
      if (url.includes('/referrers')) return [{ referrer: 'github.com', count: 30, uniques: 10 }];
      if (url.includes('/paths')) return [{ path: '/x', title: 'X', count: 50, uniques: 12 }];
      return {};
    });
    const t = await fetchRepoTraffic('tok', 'writingdeveloper', 'SiteDeck');
    expect(t.views).toEqual([{ date: '2026-06-19', views: 42, uniqueViews: 8 }]);
    expect(t.clones).toEqual([{ date: '2026-06-19', clones: 3, uniqueClones: 2 }]);
    expect(t.referrers[0]?.referrer).toBe('github.com');
    expect(t.paths[0]?.path).toBe('/x');
  });

  it('throws on a non-ok response (so the runner records a per-repo error)', async () => {
    stubGh(() => ({}), false, 403);
    await expect(fetchRepoTraffic('tok', 'o', 'r')).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/github.test.ts`
Expected: FAIL — `fetchRepoTraffic` is not exported.

- [ ] **Step 3: Add the client to `src/github.ts`**

Append to `src/github.ts`:

```ts
const API = 'https://api.github.com';

async function ghRequest(token: string, url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'SiteDeck',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** All four traffic endpoints for one repo. Requires the PAT's Administration: Read. */
export async function fetchRepoTraffic(token: string, owner: string, repo: string): Promise<RepoTraffic> {
  const base = `${API}/repos/${owner}/${repo}/traffic`;
  const [views, clones, referrers, paths] = await Promise.all([
    ghRequest(token, `${base}/views?per=day`),
    ghRequest(token, `${base}/clones?per=day`),
    ghRequest(token, `${base}/popular/referrers`),
    ghRequest(token, `${base}/popular/paths`),
  ]);
  return { views: parseViews(views), clones: parseClones(clones), referrers: parseReferrers(referrers), paths: parsePaths(paths) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/github.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat(github): REST client fetchRepoTraffic over the 4 traffic endpoints"
```

---

### Task 5: `github-store.ts` — date-keyed upsert store

**Files:**
- Create: `src/github-store.ts`
- Test: `src/github-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/github-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyStore, upsertDays, putSnapshot, summarize, saveStore, loadStore } from './github-store';

describe('upsertDays', () => {
  it('is idempotent for the same day — latest wins, no duplicate entry', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 10, uniqueViews: 4 }], [], 90, 't1');
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 12, uniqueViews: 5 }], [], 90, 't2');
    expect(s.byRepo['o/r']?.days['2026-06-19']).toEqual({ views: 12, uniqueViews: 5, clones: 0, uniqueClones: 0 });
    expect(Object.keys(s.byRepo['o/r']?.days ?? {})).toHaveLength(1);
    expect(s.lastRunAt).toBe('t2');
  });

  it('merges overlapping 14-day windows (backfill) into a union of dates', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-10', views: 1, uniqueViews: 1 }, { date: '2026-06-11', views: 2, uniqueViews: 1 }], [], 90, 't1');
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-11', views: 2, uniqueViews: 1 }, { date: '2026-06-12', views: 3, uniqueViews: 1 }], [], 90, 't2');
    expect(Object.keys(s.byRepo['o/r']?.days ?? {}).sort()).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
  });

  it('merges views and clones for the same day', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 10, uniqueViews: 4 }], [{ date: '2026-06-19', clones: 3, uniqueClones: 2 }], 90, 't1');
    expect(s.byRepo['o/r']?.days['2026-06-19']).toEqual({ views: 10, uniqueViews: 4, clones: 3, uniqueClones: 2 });
  });

  it('keeps only the newest `retention` days', () => {
    let s = emptyStore();
    const days = ['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'].map((date, i) => ({ date, views: i, uniqueViews: 0 }));
    s = upsertDays(s, 'o/r', 'r', days, [], 2, 't1');
    expect(Object.keys(s.byRepo['o/r']?.days ?? {}).sort()).toEqual(['2026-06-12', '2026-06-13']);
  });
});

describe('putSnapshot', () => {
  it('replaces referrers/paths wholesale and stamps snapshotAt', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 1, uniqueViews: 1 }], [], 90, 't1');
    s = putSnapshot(s, 'o/r', 'r', [{ referrer: 'github.com', count: 5, uniques: 2 }], [{ path: '/x', title: 'X', count: 9, uniques: 3 }], 't2');
    expect(s.byRepo['o/r']?.referrers[0]?.referrer).toBe('github.com');
    expect(s.byRepo['o/r']?.paths[0]?.path).toBe('/x');
    expect(s.byRepo['o/r']?.snapshotAt).toBe('t2');
  });
});

describe('summarize', () => {
  it('totals the last 14 days and builds a daily-views trend', () => {
    let s = emptyStore();
    const days = Array.from({ length: 3 }, (_, i) => ({ date: `2026-06-1${i}`, views: (i + 1) * 10, uniqueViews: i + 1 }));
    s = upsertDays(s, 'o/r', 'r', days, [], 90, 't1');
    const sum = summarize(s, 30)[0];
    expect(sum?.fullName).toBe('o/r');
    expect(sum?.totals14d).toEqual({ views: 60, uniqueViews: 6, clones: 0, uniqueClones: 0 });
    expect(sum?.trend).toEqual([10, 20, 30]);
  });
});

describe('saveStore / loadStore', () => {
  it('round-trips a store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sitedeck-gh-'));
    try {
      const file = path.join(dir, 'nested', 'github.json');
      const store = upsertDays(emptyStore(), 'o/r', 'r', [{ date: '2026-06-19', views: 1, uniqueViews: 1 }], [], 90, 't1');
      await saveStore(file, store);
      expect(await loadStore(file)).toEqual(store);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/github-store.test.ts`
Expected: FAIL — cannot import `./github-store`.

- [ ] **Step 3: Write `src/github-store.ts`**

Create `src/github-store.ts`:

```ts
import { readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeJsonAtomic } from './atomic';
import type { DayViews, DayClones, Referrer, PathStat } from './github';

export interface DayCount {
  views: number;
  uniqueViews: number;
  clones: number;
  uniqueClones: number;
}
export interface RepoEntry {
  displayName: string;
  days: Record<string, DayCount>;
  referrers: Referrer[];
  paths: PathStat[];
  snapshotAt: string | null;
}
export interface GithubStore {
  version: number;
  lastRunAt: string | null;
  byRepo: Record<string, RepoEntry>;
}
export interface RepoSummary {
  fullName: string;
  displayName: string;
  totals14d: DayCount;
  trend: number[];
  referrers: Referrer[];
  paths: PathStat[];
  snapshotAt: string | null;
}

const ZERO: DayCount = { views: 0, uniqueViews: 0, clones: 0, uniqueClones: 0 };

export function emptyStore(): GithubStore {
  return { version: 1, lastRunAt: null, byRepo: {} };
}

/**
 * Upsert per-day views/clones into a repo by calendar date. Re-runs and overlapping
 * 14-day windows are idempotent (the latest value for a date wins — never summed),
 * so backfilling after the app was offline (<14 days) merges cleanly. Keeps only the
 * newest `retention` calendar days.
 */
export function upsertDays(
  store: GithubStore,
  fullName: string,
  displayName: string,
  views: DayViews[],
  clones: DayClones[],
  retention: number,
  ts: string,
): GithubStore {
  const prev = store.byRepo[fullName];
  const days: Record<string, DayCount> = { ...(prev?.days ?? {}) };
  for (const v of views) {
    days[v.date] = { ...(days[v.date] ?? ZERO), views: v.views, uniqueViews: v.uniqueViews };
  }
  for (const c of clones) {
    days[c.date] = { ...(days[c.date] ?? ZERO), clones: c.clones, uniqueClones: c.uniqueClones };
  }
  const trimmed: Record<string, DayCount> = {};
  for (const date of Object.keys(days).sort().slice(-retention)) {
    trimmed[date] = days[date] as DayCount;
  }
  return {
    ...store,
    lastRunAt: ts,
    byRepo: {
      ...store.byRepo,
      [fullName]: {
        displayName,
        days: trimmed,
        referrers: prev?.referrers ?? [],
        paths: prev?.paths ?? [],
        snapshotAt: prev?.snapshotAt ?? null,
      },
    },
  };
}

/** Replace the live 14-day referrers/paths snapshot for a repo (not accumulated). */
export function putSnapshot(
  store: GithubStore,
  fullName: string,
  displayName: string,
  referrers: Referrer[],
  paths: PathStat[],
  snapshotAt: string,
): GithubStore {
  const prev = store.byRepo[fullName] ?? { displayName, days: {}, referrers: [], paths: [], snapshotAt: null };
  return { ...store, byRepo: { ...store.byRepo, [fullName]: { ...prev, displayName, referrers, paths, snapshotAt } } };
}

export function summarize(store: GithubStore, trendLength: number): RepoSummary[] {
  return Object.entries(store.byRepo).map(([fullName, entry]) => {
    const dates = Object.keys(entry.days).sort();
    const totals14d = dates.slice(-14).reduce<DayCount>((acc, d) => {
      const day = entry.days[d] as DayCount;
      return {
        views: acc.views + day.views,
        uniqueViews: acc.uniqueViews + day.uniqueViews,
        clones: acc.clones + day.clones,
        uniqueClones: acc.uniqueClones + day.uniqueClones,
      };
    }, { ...ZERO });
    const trend = dates.slice(-trendLength).map((d) => (entry.days[d] as DayCount).views);
    return { fullName, displayName: entry.displayName, totals14d, trend, referrers: entry.referrers, paths: entry.paths, snapshotAt: entry.snapshotAt };
  });
}

export async function loadStore(filePath: string): Promise<GithubStore> {
  if (!existsSync(filePath)) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as GithubStore;
    if (parsed && typeof parsed === 'object' && parsed.byRepo) return parsed;
    throw new Error('bad shape');
  } catch {
    await rename(filePath, `${filePath}.bak`).catch(() => {});
    return emptyStore();
  }
}

export async function saveStore(filePath: string, store: GithubStore): Promise<void> {
  await writeJsonAtomic(filePath, store);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/github-store.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/github-store.ts src/github-store.test.ts
git commit -m "feat(github): date-keyed upsert store with backfill + retention (TDD)"
```

---

### Task 6: `github-runner.ts` — state + daily scheduler

**Files:**
- Create: `src/github-runner.ts`

(No new unit test — this is the integration layer; it reuses `shouldMeasure` (already tested) and is verified end-to-end in Task 9. Mirrors `src/insights.ts` exactly, including its private `mapLimit`.)

- [ ] **Step 1: Write `src/github-runner.ts`**

Create `src/github-runner.ts`:

```ts
import { GITHUB_STORE_PATH, GITHUB_INTERVAL_MS, GITHUB_CONCURRENCY, GITHUB_RETENTION_DAYS, GITHUB_TREND_LENGTH } from './config';
import { getGithubToken, getGithubRepos } from './settings';
import { fetchRepoTraffic } from './github';
import { shouldMeasure } from './insights-store';
import { type GithubStore, emptyStore, loadStore, saveStore, upsertDays, putSnapshot, summarize } from './github-store';

let store: GithubStore = emptyStore();
let measuring = false;
let lastErrors: { repo: string; message: string }[] = [];

export async function initGithub(): Promise<void> {
  store = await loadStore(GITHUB_STORE_PATH);
}

export function getGithubState() {
  return {
    configured: getGithubToken() !== null,
    isMeasuring: measuring,
    lastRunAt: store.lastRunAt,
    repos: summarize(store, GITHUB_TREND_LENGTH),
    errors: lastErrors,
  };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function runMeasurement(): Promise<void> {
  const token = getGithubToken();
  // Guard here (not only in measureNow) so the scheduler tick can never race a second run.
  if (!token || measuring) return;
  measuring = true;
  lastErrors = [];
  try {
    const repos = getGithubRepos();
    await mapLimit(repos, GITHUB_CONCURRENCY, async (fullName) => {
      const [owner, repo] = fullName.split('/');
      if (!owner || !repo) {
        lastErrors.push({ repo: fullName, message: 'invalid repo (expected owner/repo)' });
        return;
      }
      try {
        const traffic = await fetchRepoTraffic(token, owner, repo);
        const ts = new Date().toISOString();
        store = upsertDays(store, fullName, repo, traffic.views, traffic.clones, GITHUB_RETENTION_DAYS, ts);
        store = putSnapshot(store, fullName, repo, traffic.referrers, traffic.paths, ts);
      } catch (err) {
        lastErrors.push({ repo: fullName, message: err instanceof Error ? err.message : String(err) });
      }
    });
    await saveStore(GITHUB_STORE_PATH, store);
  } catch (err) {
    lastErrors.push({ repo: '(run)', message: err instanceof Error ? err.message : String(err) });
  } finally {
    measuring = false;
  }
}

export function measureNow(): { started: boolean; reason?: string } {
  if (getGithubToken() === null) return { started: false, reason: 'not-configured' };
  if (measuring) return { started: false, reason: 'already-running' };
  void runMeasurement();
  return { started: true };
}

export function startGithubScheduler(): void {
  const tick = () => {
    if (shouldMeasure(store.lastRunAt, Date.now(), GITHUB_INTERVAL_MS)) void runMeasurement();
  };
  tick();
  setInterval(tick, GITHUB_INTERVAL_MS).unref();
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/github-runner.ts
git commit -m "feat(github): daily measurement runner + scheduler (mirrors insights)"
```

---

### Task 7: Server endpoints + startup wiring

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add the import**

In `src/server.ts`, next to the insights import (`import { getInsightsState, initInsights, measureNow, startInsightsScheduler } from './insights';`), add — aliasing `measureNow` so it doesn't collide with the insights one:

```ts
import {
  getGithubState,
  initGithub,
  measureNow as measureGithubNow,
  startGithubScheduler,
} from './github-runner';
```

- [ ] **Step 2: Add the two endpoints**

In `src/server.ts`, immediately after the `'/api/insights/measure'` handler block (it ends around line 248 with its `return;`), add:

```ts
  if (url.pathname === '/api/github') {
    try {
      json(res, 200, getGithubState());
    } catch (err) {
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/github/measure' && req.method === 'POST') {
    try {
      json(res, 200, measureGithubNow());
    } catch (err) {
      json(res, 500, errorBody(err));
    }
    return;
  }
```

- [ ] **Step 3: Wire startup**

In `src/server.ts`, find the insights startup wiring inside the `listenWithFallback(...).then(...)` block:

```ts
    void initInsights()
      .then(startInsightsScheduler)
      .catch((err) => console.error('insights init failed:', err));
```

Add directly after it:

```ts
    void initGithub()
      .then(startGithubScheduler)
      .catch((err) => console.error('github init failed:', err));
```

- [ ] **Step 4: Verify the endpoints respond**

Run (PowerShell-friendly; uses a spare port and the loopback Host guard):

```bash
PORT=4599 SITEDECK_NO_OPEN=1 npx tsx src/server.ts > /tmp/sd_gh.log 2>&1 &
sleep 3
curl -s -H "Host: 127.0.0.1:4599" http://127.0.0.1:4599/api/github
curl -s -X POST -H "Host: 127.0.0.1:4599" http://127.0.0.1:4599/api/github/measure
# stop it: find the PID on 4599 and kill (Windows: Get-NetTCPConnection -LocalPort 4599)
```

Expected: `/api/github` returns `{"configured":false,...,"repos":[],"errors":[]}` when no token is set (or `configured:true` if you've added one); `/api/github/measure` returns `{"started":false,"reason":"not-configured"}` with no token, or `{"started":true}` with one.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/server.ts
git commit -m "feat(github): add GET /api/github + POST /api/github/measure + startup wiring"
```

---

### Task 8: Front-end Repos tab

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/locales/en.json`, `ko.json`, `es.json`, `zh.json`, `ja.json`

- [ ] **Step 1: Add the tab button + view in `public/index.html`**

In the `<nav class="tabs">`, add the Repos button after the GEO button (before Settings):

```html
        <button class="tab" id="tab-repos" role="tab" aria-selected="false" aria-controls="view-repos" data-view="repos" type="button" data-i18n="tab.repos">Repos</button>
```

Add the view section before `<section id="view-settings" ...>`:

```html
      <section id="view-repos" role="tabpanel" aria-labelledby="tab-repos" hidden>
        <div class="controls">
          <button id="repos-measure" type="button" data-i18n="btn.measureNow">Measure now</button>
        </div>
        <div id="repos-status" class="status" role="status" aria-live="polite" hidden></div>
        <table id="repos-table" hidden>
          <thead>
            <tr>
              <th scope="col" data-i18n="col.repo">Repo</th>
              <th class="num" scope="col" data-i18n="col.views14d">Views (14d)</th>
              <th class="num" scope="col" data-i18n="col.uniqueViews">Uniq. views</th>
              <th class="num" scope="col" data-i18n="col.clones14d">Clones (14d)</th>
              <th class="num" scope="col" data-i18n="col.uniqueClones">Uniq. clones</th>
              <th scope="col" data-i18n="col.trend">Trend</th>
              <th scope="col" data-i18n="col.updatedAt">Updated</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <div class="meta" id="repos-meta"></div>
      </section>
```

- [ ] **Step 2: Add the `repos` UI module to `public/app.js`**

Add `github: null` to the `state` object literal (next to `onpage: null`):

```js
const state = { data: null, insights: null, onpage: null, github: null, filter: "", sortKey: "activeUsers", sortDir: "desc" };
```

Add this block before `const settings = {` (mirrors the `insights` block):

```js
// --- Repos tab: GitHub repo traffic (accumulated daily, polled while measuring) ---
const repos = {
  status: document.getElementById("repos-status"),
  table: document.getElementById("repos-table"),
  tbody: document.querySelector("#repos-table tbody"),
  meta: document.getElementById("repos-meta"),
  measure: document.getElementById("repos-measure"),
};
let reposTimer = null;

function repoDetail(label, items, render) {
  if (!items || !items.length) return "";
  return `<div class="repo-detail"><b>${label}</b> <span class="muted">(${t("repos.last14d")})</span><ul>${items.map(render).join("")}</ul></div>`;
}

function renderRepos(data) {
  repos.measure.disabled = Boolean(data.isMeasuring);
  if (data.isMeasuring) repos.measure.setAttribute("aria-busy", "true");
  else repos.measure.removeAttribute("aria-busy");
  if (!data.configured) {
    repos.table.hidden = true;
    repos.tbody.innerHTML = "";
    repos.status.hidden = false;
    repos.status.className = "status warn";
    repos.status.innerHTML = `${t("repos.notConfigured")} <a href="#" class="link-settings">${t("link.openSettings")}</a>`;
    return;
  }
  const list = data.repos ?? [];
  repos.table.hidden = list.length === 0;
  repos.status.hidden = list.length > 0 && !data.isMeasuring;
  if (data.isMeasuring) {
    repos.status.hidden = false;
    repos.status.className = "status info";
    repos.status.textContent = t("repos.measuring");
  } else if (list.length === 0) {
    repos.status.className = "status info";
    repos.status.textContent = t("repos.empty");
  }
  const rows = list
    .filter((r) => matchesFilter(r.displayName, state.filter))
    .map((r) => {
      const tt = r.totals14d ?? {};
      const detail =
        repoDetail(t("repos.referrers"), r.referrers, (x) => `<li>${escapeHtml(x.referrer)} <span class="muted">${fmtNum(x.count)}</span></li>`) +
        repoDetail(t("repos.paths"), r.paths, (x) => `<li>${escapeHtml(x.title || x.path)} <span class="muted">${fmtNum(x.count)}</span></li>`);
      return `<tr class="repo-row" tabindex="0">
        <td class="name">${siteLink(r.displayName, `https://github.com/${r.fullName}`)}</td>
        <td class="num">${fmtNum(tt.views)}</td>
        <td class="num">${fmtNum(tt.uniqueViews)}</td>
        <td class="num">${fmtNum(tt.clones)}</td>
        <td class="num">${fmtNum(tt.uniqueClones)}</td>
        <td class="spark-cell" title="${escapeHtml(trendTip(r.trend))}">${sparkline(r.trend, `${r.displayName} ${t("col.trend")}`)}</td>
        <td class="top">${fmtWhen(r.snapshotAt)}</td>
      </tr>${detail ? `<tr class="repo-detail-row" hidden><td colspan="7">${detail}</td></tr>` : ""}`;
    })
    .join("");
  repos.tbody.innerHTML = rows || (list.length && state.filter ? noMatchRow(7) : "");
  repos.meta.textContent = data.lastRunAt
    ? `${t("insights.lastMeasured", { when: fmtWhen(data.lastRunAt) })}${data.errors?.length ? t("insights.errorsSuffix", { count: data.errors.length }) : ""}`
    : "";
}

function stopReposPolling() {
  if (reposTimer) {
    clearInterval(reposTimer);
    reposTimer = null;
  }
}

async function loadRepos() {
  if (!repos.tbody.children.length && repos.status.hidden) {
    repos.status.hidden = false;
    repos.status.className = "status info";
    repos.status.textContent = t("status.loading");
  }
  try {
    const res = await fetch("/api/github");
    const data = await res.json();
    state.github = data;
    renderRepos(data);
    if (data.isMeasuring && !reposTimer) reposTimer = setInterval(loadRepos, 4000);
    else if (!data.isMeasuring) stopReposPolling();
  } catch (err) {
    repos.status.hidden = false;
    repos.status.className = "status error";
    repos.status.textContent = escapeHtml(err?.message ?? String(err));
  }
}

// Expand/collapse a repo row to reveal its 14-day referrers + popular paths.
repos.tbody.addEventListener("click", (e) => {
  const row = e.target.closest && e.target.closest(".repo-row");
  if (!row) return;
  const detail = row.nextElementSibling;
  if (detail && detail.classList.contains("repo-detail-row")) detail.hidden = !detail.hidden;
});
repos.tbody.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("repo-row")) {
    e.preventDefault();
    const detail = e.target.nextElementSibling;
    if (detail && detail.classList.contains("repo-detail-row")) detail.hidden = !detail.hidden;
  }
});

repos.measure.addEventListener("click", async () => {
  repos.measure.disabled = true;
  repos.measure.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/github/measure", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadRepos();
  } catch (err) {
    repos.status.hidden = false;
    repos.status.className = "status error";
    repos.status.textContent = err?.message ?? String(err);
    repos.measure.disabled = false;
    repos.measure.removeAttribute("aria-busy");
  }
});
```

- [ ] **Step 3: Wire the tab into `views`, `activateTab`, and the search filter**

In `public/app.js`, add `repos` to the `views` object:

```js
const views = {
  traffic: document.getElementById("view-traffic"),
  performance: document.getElementById("view-performance"),
  geo: document.getElementById("view-geo"),
  repos: document.getElementById("view-repos"),
};
```

In `activateTab(view)`, add the hidden toggle (next to the others) and the load/stop wiring:

```js
  views.repos.hidden = view !== "repos";
```
and, next to `if (view === "geo") loadOnpage();`:
```js
  if (view === "repos") loadRepos();
  else stopReposPolling();
```

In the search-filter `els.search` input handler, add:

```js
  if (!views.repos.hidden && state.github) renderRepos(state.github);
```

- [ ] **Step 4: Add the i18n keys to all five locales**

Add these keys to **each** `public/locales/*.json` (anchor the `col.*` keys after `col.geoScore`, `tab.repos` after `tab.geo`, the `repos.*`/`settings.github*` keys near the other `repos`/settings entries). Use the exact per-language values below.

`en.json`:
```json
  "tab.repos": "Repos",
  "col.repo": "Repo",
  "col.views14d": "Views (14d)",
  "col.uniqueViews": "Uniq. views",
  "col.clones14d": "Clones (14d)",
  "col.uniqueClones": "Uniq. clones",
  "col.updatedAt": "Updated",
  "repos.notConfigured": "Add a GitHub token and repo list in Settings to start.",
  "repos.measuring": "Measuring…",
  "repos.empty": "No data yet. Press “Measure now” to start.",
  "repos.referrers": "Referrers",
  "repos.paths": "Popular paths",
  "repos.last14d": "last 14 days",
  "settings.githubLabel": "GitHub traffic",
  "settings.githubMissing": "Set githubToken + githubRepos in ~/.sitedeck/config.json.",
```

`ko.json`:
```json
  "tab.repos": "Repos",
  "col.repo": "레포",
  "col.views14d": "조회수(14d)",
  "col.uniqueViews": "순방문",
  "col.clones14d": "클론(14d)",
  "col.uniqueClones": "순클론",
  "col.updatedAt": "갱신",
  "repos.notConfigured": "설정에서 GitHub 토큰과 레포 목록을 추가하면 시작할 수 있습니다.",
  "repos.measuring": "측정 중…",
  "repos.empty": "데이터가 없습니다. \"지금 측정\"을 눌러 시작하세요.",
  "repos.referrers": "참조 출처",
  "repos.paths": "인기 경로",
  "repos.last14d": "최근 14일",
  "settings.githubLabel": "GitHub 트래픽",
  "settings.githubMissing": "~/.sitedeck/config.json에 githubToken + githubRepos를 설정하세요.",
```

`es.json`:
```json
  "tab.repos": "Repos",
  "col.repo": "Repo",
  "col.views14d": "Vistas (14d)",
  "col.uniqueViews": "Únicas",
  "col.clones14d": "Clones (14d)",
  "col.uniqueClones": "Únicos",
  "col.updatedAt": "Actualizado",
  "repos.notConfigured": "Añade un token de GitHub y la lista de repos en Ajustes para empezar.",
  "repos.measuring": "Midiendo…",
  "repos.empty": "Sin datos aún. Pulsa «Medir ahora» para empezar.",
  "repos.referrers": "Referencias",
  "repos.paths": "Rutas populares",
  "repos.last14d": "últimos 14 días",
  "settings.githubLabel": "Tráfico de GitHub",
  "settings.githubMissing": "Configura githubToken + githubRepos en ~/.sitedeck/config.json.",
```

`zh.json`:
```json
  "tab.repos": "Repos",
  "col.repo": "仓库",
  "col.views14d": "浏览(14天)",
  "col.uniqueViews": "独立访客",
  "col.clones14d": "克隆(14天)",
  "col.uniqueClones": "独立克隆",
  "col.updatedAt": "更新",
  "repos.notConfigured": "在设置中添加 GitHub 令牌和仓库列表即可开始。",
  "repos.measuring": "测量中…",
  "repos.empty": "暂无数据。点击\"立即测量\"开始。",
  "repos.referrers": "来源",
  "repos.paths": "热门路径",
  "repos.last14d": "最近 14 天",
  "settings.githubLabel": "GitHub 流量",
  "settings.githubMissing": "在 ~/.sitedeck/config.json 中设置 githubToken + githubRepos。",
```

`ja.json`:
```json
  "tab.repos": "Repos",
  "col.repo": "リポジトリ",
  "col.views14d": "閲覧(14日)",
  "col.uniqueViews": "ユニーク閲覧",
  "col.clones14d": "クローン(14日)",
  "col.uniqueClones": "ユニーククローン",
  "col.updatedAt": "更新",
  "repos.notConfigured": "設定で GitHub トークンとリポジトリ一覧を追加すると開始できます。",
  "repos.measuring": "測定中…",
  "repos.empty": "データがありません。「今すぐ測定」を押して開始してください。",
  "repos.referrers": "参照元",
  "repos.paths": "人気のパス",
  "repos.last14d": "過去 14 日",
  "settings.githubLabel": "GitHub トラフィック",
  "settings.githubMissing": "~/.sitedeck/config.json に githubToken + githubRepos を設定してください。",
```

- [ ] **Step 5: Verify statically**

Run each:
```bash
for f in public/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "ok $f"; done
node --check public/app.js
npx vitest run
```
Expected: all 5 JSON `ok`, `app.js` parses, and the suite is green — including the i18n parity + key-usage tests (every `data-i18n` / `t("…")` key used above now resolves in `en.json` and exists in all five locales).

- [ ] **Step 6: Commit**

```bash
git add public/
git commit -m "feat(github): add the Repos tab (table + row-expand + i18n)"
```

---

### Task 9: Live verification + docs

**Files:**
- Modify: `README.md` (add a "GitHub traffic (Repos tab)" section)

- [ ] **Step 1: Configure a real token + repo (one-time, local only)**

Create a **fine-grained PAT** (github.com → Settings → Developer settings → Fine-grained tokens): repository access = the repos to track, **Repository permissions → Administration: Read-only**. Add to `~/.sitedeck/config.json` (never commit it):

```json
{ "psiApiKey": "…", "githubToken": "github_pat_…", "githubRepos": ["writingdeveloper/SiteDeck"] }
```

- [ ] **Step 2: Run a live measurement and confirm real data**

```bash
PORT=4599 SITEDECK_NO_OPEN=1 npx tsx src/server.ts > /tmp/sd_gh.log 2>&1 &
sleep 3
curl -s -X POST -H "Host: 127.0.0.1:4599" http://127.0.0.1:4599/api/github/measure   # {"started":true}
sleep 5
curl -s -H "Host: 127.0.0.1:4599" http://127.0.0.1:4599/api/github
# stop the server (Windows: Get-NetTCPConnection -LocalPort 4599 | kill the OwningProcess)
```
Expected: `configured:true`, a `repos[]` entry with non-zero `totals14d`, a `trend`, real `referrers`/`paths`, and `errors:[]`. Confirm `~/.sitedeck/github.json` now exists and its `byRepo.<repo>.days` is keyed by `YYYY-MM-DD`.

- [ ] **Step 3: Confirm idempotency against the live store**

Re-run the measure call from Step 2 and re-`GET /api/github`. Expected: `totals14d` is **unchanged** (same day upserted, not summed) — this is the core contract, now verified against real data.

- [ ] **Step 4: Browser QA (user-perspective)**

Open `http://127.0.0.1:<port>`, click the **Repos** tab. Confirm: the table shows each repo with views/clones/uniques + a trend sparkline + updated time; clicking a row expands its referrers + popular paths ("최근 14일"); "Measure now" shows the measuring state and refreshes; with no token the tab shows the setup hint; check the console for errors.

- [ ] **Step 5: Document it**

Add a section to `README.md` (after the "On-page checks (GEO tab)" section): what the Repos tab shows, the **fine-grained PAT with Administration: Read** prerequisite, the `githubToken` + `githubRepos` config keys (+ `SITEDECK_GITHUB_TOKEN` / `SITEDECK_GITHUB_REPOS` env overrides), the **14-day window → local daily accumulation** behavior, and the caveat that **offline > 14 consecutive days leaves a permanent gap**.

- [ ] **Step 6: Final check + commit**

Run: `npm run typecheck` and `npx vitest run` (both green), then:

```bash
git add README.md
git commit -m "docs(github): document the Repos tab + fine-grained PAT setup"
```

---

## Self-review (done while writing — notes for the implementer)

- **Spec coverage:** scope metrics (views/uniqueViews/clones/uniqueClones per day) → Task 5 `DayCount` + `upsertDays`; live referrers/paths snapshot → `putSnapshot`; repos from config → Task 2 `getGithubRepos`; daily + manual cadence → Task 6 scheduler + `measureNow`; 90-day retention → `GITHUB_RETENTION_DAYS` + the `slice(-retention)` in `upsertDays`; the date-keyed-upsert **backfill/idempotency contract** → Task 5 tests (the spec's "key contract to test"); GitHub API headers/endpoints → Task 4; `/api/github` + `/api/github/measure` shapes → Tasks 6–7; UI table + row-expand + states → Task 8; error handling (no token → `configured:false`; per-repo 401/403/404 → `errors[]`, never abort; corrupt store → `.bak`) → Tasks 5–6; fine-grained PAT prerequisite → Task 9. **Non-goals** (auto-discover repos, referrers history, Model B, OS scheduling) are intentionally not built.
- **Type consistency:** `DayViews`/`DayClones`/`Referrer`/`PathStat`/`RepoTraffic` defined in `github.ts` (Task 3) and imported by `github-store.ts` (Task 5); `DayCount`/`RepoEntry`/`GithubStore`/`RepoSummary` defined in `github-store.ts`; runner (Task 6) consumes `upsertDays(store, fullName, repo, traffic.views, traffic.clones, retention, ts)` and `putSnapshot(store, fullName, repo, referrers, paths, ts)` exactly as declared; `getGithubState().repos` is `RepoSummary[]` and the front-end reads `r.fullName/displayName/totals14d/trend/referrers/paths/snapshotAt` — all present on `RepoSummary`.
- **No placeholders:** every code step is complete; all five locales carry literal translated strings (no "translate later").
- **`noUncheckedIndexedAccess`:** index accesses in `upsertDays`/`summarize` are guarded (`?? ZERO`) or cast (`as DayCount`) after a known `Object.keys` iteration, matching the repo's existing style (`insights-store.ts`).
- **Reuse:** `shouldMeasure`, `writeJsonAtomic`, the `.bak` recovery shape, `siteLink`/`sparkline`/`fmtNum`/`fmtWhen`/`trendTip`/`matchesFilter`/`noMatchRow` are all reused, not re-implemented.

## Open follow-ups (out of scope, noted)

- Three near-identical concurrency helpers now exist (`insights.ts:mapLimit`, `onpage.ts:mapPool`, `github-runner.ts:mapLimit`). A future cleanup could extract one shared `src/pool.ts`; left duplicated here to keep `github-runner.ts` a faithful mirror of `insights.ts`.
- Model B (unified per-site row via `gsc.ts` `normalizeHost`/`matchSites` on each repo's `homepage`) is a presentation/join layer that can be added later with no store migration, because the store is keyed by `owner/repo`.
