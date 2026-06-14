# Page Insights (PageSpeed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Performance tab that periodically measures each site's Lighthouse scores (Performance/Accessibility/Best Practices/SEO, mobile) via the PageSpeed Insights API and tracks them over time.

**Architecture:** A new insights service runs inside the existing local server: it derives site URLs from GA4 data streams, calls PSI per URL with limited concurrency, and persists score history to `~/.sitedeck/insights.json`. A daily in-app scheduler (plus a manual trigger) drives measurements. Two new JSON endpoints feed a new "성능" tab in the dashboard.

**Tech Stack:** Node + TypeScript (ESM), global `fetch`, vitest. PSI v5 REST (API key). Reuses existing OAuth client + `@google-analytics/admin`.

**Spec:** `docs/superpowers/specs/2026-06-13-page-insights-design.md`

---

### Task 1: Config — PSI key resolution + insights constants

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the readFileSync import**

In `src/config.ts`, change the fs import line:

```ts
import { existsSync, readFileSync } from 'node:fs';
```

- [ ] **Step 2: Append insights constants + key resolver at the end of `src/config.ts`**

```ts
/** PageSpeed Insights / performance-tracking config. */
export const CONFIG_JSON_PATH = path.join(CONFIG_DIR, 'config.json');
export const INSIGHTS_PATH = path.join(CONFIG_DIR, 'insights.json');
export const INSIGHTS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const INSIGHTS_CONCURRENCY = 2;
export const INSIGHTS_RETENTION = 90;
export const INSIGHTS_TREND_LENGTH = 30;

/** PSI API key: env SITEDECK_PSI_KEY, else psiApiKey in ~/.sitedeck/config.json, else null. */
export function getPsiApiKey(): string | null {
  if (process.env.SITEDECK_PSI_KEY) return process.env.SITEDECK_PSI_KEY;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { psiApiKey?: unknown };
    return typeof cfg.psiApiKey === 'string' && cfg.psiApiKey ? cfg.psiApiKey : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "Add PSI key resolution and insights config constants"
```

---

### Task 2: PSI score parsing (TDD)

**Files:**
- Create: `src/psi.ts`
- Test: `src/psi.test.ts`

- [ ] **Step 1: Write the failing test** — `src/psi.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parsePsiScores } from './psi';

describe('parsePsiScores', () => {
  it('converts 0–1 category scores to 0–100 integers', () => {
    const resp = {
      lighthouseResult: {
        categories: {
          performance: { score: 0.87 },
          accessibility: { score: 0.95 },
          'best-practices': { score: 0.92 },
          seo: { score: 1 },
        },
      },
    };
    expect(parsePsiScores(resp)).toEqual({
      performance: 87,
      accessibility: 95,
      bestPractices: 92,
      seo: 100,
    });
  });

  it('returns null for missing categories', () => {
    expect(parsePsiScores({ lighthouseResult: { categories: {} } })).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
    });
  });

  it('returns all null for a malformed response', () => {
    expect(parsePsiScores({})).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- psi`
Expected: FAIL — "Cannot find module './psi'".

- [ ] **Step 3: Write the minimal implementation** — `src/psi.ts`

```ts
export interface PsiScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

interface PsiResponse {
  lighthouseResult?: { categories?: Record<string, { score?: number | null }> };
}

export function parsePsiScores(response: unknown): PsiScores {
  const categories = (response as PsiResponse)?.lighthouseResult?.categories ?? {};
  const score = (key: string): number | null => {
    const raw = categories[key]?.score;
    return typeof raw === 'number' ? Math.round(raw * 100) : null;
  };
  return {
    performance: score('performance'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
    seo: score('seo'),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- psi`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/psi.ts src/psi.test.ts
git commit -m "Add PSI score parsing (TDD)"
```

---

### Task 3: PSI fetch (network)

**Files:**
- Modify: `src/psi.ts`

- [ ] **Step 1: Append `fetchPsiScores` to `src/psi.ts`**

```ts
/** Call PageSpeed Insights v5 (mobile, 4 categories) for a URL and return parsed scores. */
export async function fetchPsiScores(apiKey: string, url: string): Promise<PsiScores> {
  const params = new URLSearchParams({ url, strategy: 'mobile', key: apiKey });
  for (const c of ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']) {
    params.append('category', c);
  }
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`);
  if (!res.ok) {
    throw new Error(`PSI ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  }
  return parsePsiScores(await res.json());
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/psi.ts
git commit -m "Add PSI fetch via PageSpeed Insights v5"
```

---

### Task 4: Insights store — pure transforms (TDD)

**Files:**
- Create: `src/insights-store.ts`
- Test: `src/insights-store.test.ts`

- [ ] **Step 1: Write the failing test** — `src/insights-store.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { emptyStore, appendMeasurement, shouldMeasure, summarize } from './insights-store';

const m = (ts: string, p: number) => ({
  ts,
  performance: p,
  accessibility: 90,
  bestPractices: 90,
  seo: 90,
});

describe('appendMeasurement', () => {
  it('adds a measurement and sets lastRunAt + displayName', () => {
    const s = appendMeasurement(emptyStore(), 'https://a/', 'A', m('2026-06-13T00:00:00Z', 80), 90);
    expect(s.byUrl['https://a/']?.history).toHaveLength(1);
    expect(s.byUrl['https://a/']?.displayName).toBe('A');
    expect(s.lastRunAt).toBe('2026-06-13T00:00:00Z');
  });

  it('trims history to the retention cap, keeping the newest', () => {
    let s = emptyStore();
    for (let i = 0; i < 5; i++) {
      s = appendMeasurement(s, 'https://a/', 'A', m(`2026-06-1${i}T00:00:00Z`, i), 3);
    }
    const hist = s.byUrl['https://a/']?.history ?? [];
    expect(hist.map((x) => x.performance)).toEqual([2, 3, 4]);
  });
});

describe('shouldMeasure', () => {
  const now = Date.parse('2026-06-13T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  it('is true when never measured', () => expect(shouldMeasure(null, now, day)).toBe(true));
  it('is false within the interval', () =>
    expect(shouldMeasure('2026-06-13T06:00:00Z', now, day)).toBe(false));
  it('is true once the interval elapsed', () =>
    expect(shouldMeasure('2026-06-12T06:00:00Z', now, day)).toBe(true));
});

describe('summarize', () => {
  it('returns latest measurement and performance trend per url', () => {
    let s = emptyStore();
    s = appendMeasurement(s, 'https://a/', 'A', m('t1', 70), 90);
    s = appendMeasurement(s, 'https://a/', 'A', m('t2', 75), 90);
    const site = summarize(s, 30)[0];
    expect(site?.url).toBe('https://a/');
    expect(site?.latest?.performance).toBe(75);
    expect(site?.trend).toEqual([70, 75]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- insights-store`
Expected: FAIL — "Cannot find module './insights-store'".

- [ ] **Step 3: Write the minimal implementation** — `src/insights-store.ts`

```ts
import type { PsiScores } from './psi';

export interface Measurement extends PsiScores {
  ts: string;
}
export interface UrlEntry {
  displayName: string;
  history: Measurement[];
}
export interface InsightsStore {
  version: number;
  lastRunAt: string | null;
  byUrl: Record<string, UrlEntry>;
}
export interface InsightsSite {
  url: string;
  displayName: string;
  latest: Measurement | null;
  trend: number[];
}

export function emptyStore(): InsightsStore {
  return { version: 1, lastRunAt: null, byUrl: {} };
}

export function appendMeasurement(
  store: InsightsStore,
  url: string,
  displayName: string,
  measurement: Measurement,
  retention: number,
): InsightsStore {
  const prev = store.byUrl[url]?.history ?? [];
  const history = [...prev, measurement].slice(-retention);
  return {
    ...store,
    lastRunAt: measurement.ts,
    byUrl: { ...store.byUrl, [url]: { displayName, history } },
  };
}

export function shouldMeasure(lastRunAt: string | null, nowMs: number, intervalMs: number): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  return Number.isNaN(last) || nowMs - last >= intervalMs;
}

export function summarize(store: InsightsStore, trendLength: number): InsightsSite[] {
  return Object.entries(store.byUrl).map(([url, entry]) => ({
    url,
    displayName: entry.displayName,
    latest: entry.history[entry.history.length - 1] ?? null,
    trend: entry.history.slice(-trendLength).map((measurement) => measurement.performance ?? 0),
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- insights-store`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add src/insights-store.ts src/insights-store.test.ts
git commit -m "Add insights store pure transforms (TDD)"
```

---

### Task 5: Insights store — load/save (IO)

**Files:**
- Modify: `src/insights-store.ts`

- [ ] **Step 1: Add imports at the top of `src/insights-store.ts`**

```ts
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
```

(Keep the existing `import type { PsiScores } from './psi';` line.)

- [ ] **Step 2: Append load/save at the end of `src/insights-store.ts`**

```ts
export async function loadStore(filePath: string): Promise<InsightsStore> {
  if (!existsSync(filePath)) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as InsightsStore;
    if (parsed && typeof parsed === 'object' && parsed.byUrl) return parsed;
    throw new Error('bad shape');
  } catch {
    await rename(filePath, `${filePath}.bak`).catch(() => {});
    return emptyStore();
  }
}

export async function saveStore(filePath: string, store: InsightsStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2));
}
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm test -- insights-store`
Expected: no type errors; existing tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add src/insights-store.ts
git commit -m "Add insights store load/save with corrupt-file recovery"
```

---

### Task 6: GA — derive site URLs from data streams

**Files:**
- Modify: `src/ga.ts`

- [ ] **Step 1: Append `SiteUrl` + `listSiteUrls` to `src/ga.ts`**

```ts
export interface SiteUrl {
  propertyId: string;
  displayName: string;
  url: string;
}

/** Each property's first web data stream URL (defaultUri). Non-web properties are skipped. */
export async function listSiteUrls(auth: OAuth2Client): Promise<SiteUrl[]> {
  const props = await listProperties(auth);
  const client = admin(auth);
  const out: SiteUrl[] = [];
  await Promise.all(
    props.map(async (p) => {
      const [streams] = await client.listDataStreams({ parent: `properties/${p.propertyId}` });
      const url = streams.find((s) => s.webStreamData?.defaultUri)?.webStreamData?.defaultUri;
      if (url) out.push({ propertyId: p.propertyId, displayName: p.displayName, url });
    }),
  );
  return out;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ga.ts
git commit -m "Add listSiteUrls (property → web data stream URL)"
```

---

### Task 7: Insights service (orchestration)

**Files:**
- Create: `src/insights.ts`

- [ ] **Step 1: Create `src/insights.ts`**

```ts
import {
  CONFIG_JSON_PATH,
  INSIGHTS_PATH,
  INSIGHTS_INTERVAL_MS,
  INSIGHTS_CONCURRENCY,
  INSIGHTS_RETENTION,
  INSIGHTS_TREND_LENGTH,
  getPsiApiKey,
} from './config';
import { getClient } from './auth';
import { listSiteUrls } from './ga';
import { fetchPsiScores } from './psi';
import {
  type InsightsStore,
  emptyStore,
  loadStore,
  saveStore,
  appendMeasurement,
  shouldMeasure,
  summarize,
} from './insights-store';

void CONFIG_JSON_PATH; // referenced for docs; key is read via getPsiApiKey()

let store: InsightsStore = emptyStore();
let measuring = false;
let lastErrors: { url: string; message: string }[] = [];

export async function initInsights(): Promise<void> {
  store = await loadStore(INSIGHTS_PATH);
}

export function getInsightsState() {
  return {
    configured: getPsiApiKey() !== null,
    isMeasuring: measuring,
    lastRunAt: store.lastRunAt,
    sites: summarize(store, INSIGHTS_TREND_LENGTH),
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
  const apiKey = getPsiApiKey();
  if (!apiKey) return;
  measuring = true;
  lastErrors = [];
  try {
    const auth = await getClient();
    const sites = await listSiteUrls(auth);
    await mapLimit(sites, INSIGHTS_CONCURRENCY, async (site) => {
      try {
        const scores = await fetchPsiScores(apiKey, site.url);
        store = appendMeasurement(
          store,
          site.url,
          site.displayName,
          { ts: new Date().toISOString(), ...scores },
          INSIGHTS_RETENTION,
        );
      } catch (err) {
        lastErrors.push({ url: site.url, message: err instanceof Error ? err.message : String(err) });
      }
    });
    await saveStore(INSIGHTS_PATH, store);
  } finally {
    measuring = false;
  }
}

export function measureNow(): { started: boolean; reason?: string } {
  if (getPsiApiKey() === null) return { started: false, reason: 'not-configured' };
  if (measuring) return { started: false, reason: 'already-running' };
  void runMeasurement();
  return { started: true };
}

export function startInsightsScheduler(): void {
  const tick = () => {
    if (shouldMeasure(store.lastRunAt, Date.now(), INSIGHTS_INTERVAL_MS)) void runMeasurement();
  };
  tick();
  setInterval(tick, INSIGHTS_INTERVAL_MS);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/insights.ts
git commit -m "Add insights orchestration service (scheduler + measurement run)"
```

---

### Task 8: Server routes + startup wiring

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add the import** (next to the other `./` imports in `src/server.ts`)

```ts
import { getInsightsState, initInsights, measureNow, startInsightsScheduler } from './insights';
```

- [ ] **Step 2: Add the two routes** — inside the request handler, right after the `/api/summary` block:

```ts
  if (url.pathname === '/api/insights') {
    try {
      json(res, 200, getInsightsState());
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === '/api/insights/measure' && req.method === 'POST') {
    json(res, 200, measureNow());
    return;
  }
```

- [ ] **Step 3: Start insights on listen** — replace the `server.listen(...)` block:

```ts
server.listen(PORT, () => {
  console.log(`SiteDeck → http://localhost:${PORT}`);
  void initInsights().then(startInsightsScheduler);
  if (!process.env.SITEDECK_NO_OPEN) {
    void open(`http://localhost:${PORT}`);
  }
});
```

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: no type errors; all existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "Wire insights endpoints and scheduler into the server"
```

---

### Task 9: UI — Traffic / Performance tabs + insights table

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/style.css`

- [ ] **Step 1: Add the tab bar + insights view to `public/index.html`**

Wrap the existing GA `<table id="table">` + `<div id="meta">` in a `<section id="view-traffic">`, and add the tab bar before it and a new performance section after it. Inside `<main>`:

```html
      <nav class="tabs">
        <button class="tab active" data-view="traffic" type="button">트래픽</button>
        <button class="tab" data-view="performance" type="button">성능</button>
      </nav>

      <section id="view-traffic">
        <!-- existing #status, #table, #meta stay here -->
      </section>

      <section id="view-performance" hidden>
        <div class="controls">
          <button id="measure" type="button">지금 측정</button>
        </div>
        <div id="insights-status" class="status" hidden></div>
        <table id="insights-table" hidden>
          <thead>
            <tr>
              <th>사이트</th>
              <th class="num">성능</th>
              <th class="num">접근성</th>
              <th class="num">모범사례</th>
              <th class="num">SEO</th>
              <th>측정 시각</th>
              <th>추세</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <div class="meta" id="insights-meta"></div>
      </section>
```

- [ ] **Step 2: Add tab + score styles to `public/style.css`**

```css
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.tab {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
}
.tab.active {
  color: var(--text);
  border-color: var(--accent);
}
.score {
  display: inline-block;
  min-width: 34px;
  text-align: center;
  padding: 2px 6px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.score.good { color: var(--up); background: rgba(63, 185, 80, 0.12); }
.score.avg { color: var(--warn); background: rgba(210, 153, 34, 0.12); }
.score.poor { color: var(--down); background: rgba(248, 81, 73, 0.12); }
.score.na { color: var(--muted); }
```

- [ ] **Step 3: Add tab switching + insights rendering to `public/app.js`** (append at the end)

```js
const tabs = document.querySelectorAll(".tab");
const views = {
  traffic: document.getElementById("view-traffic"),
  performance: document.getElementById("view-performance"),
};
const insights = {
  status: document.getElementById("insights-status"),
  table: document.getElementById("insights-table"),
  tbody: document.querySelector("#insights-table tbody"),
  meta: document.getElementById("insights-meta"),
  measure: document.getElementById("measure"),
};
let insightsTimer = null;

function scoreCell(v) {
  if (v === null || v === undefined) return '<span class="score na">—</span>';
  const cls = v >= 90 ? "good" : v >= 50 ? "avg" : "poor";
  return `<span class="score ${cls}">${v}</span>`;
}

function renderInsights(data) {
  if (!data.configured) {
    insights.table.hidden = true;
    insights.tbody.innerHTML = "";
    insights.status.hidden = false;
    insights.status.className = "status warn";
    insights.status.innerHTML =
      "PageSpeed API 키가 설정되지 않았습니다. <code>~/.sitedeck/config.json</code>의 <code>psiApiKey</code>를 설정하세요.";
    return;
  }
  const sites = data.sites ?? [];
  insights.table.hidden = sites.length === 0;
  insights.status.hidden = sites.length > 0 && !data.isMeasuring;
  if (data.isMeasuring) {
    insights.status.hidden = false;
    insights.status.className = "status info";
    insights.status.textContent = "측정 중…";
  } else if (sites.length === 0) {
    insights.status.className = "status info";
    insights.status.textContent = "아직 측정 결과가 없습니다. ‘지금 측정’을 눌러 시작하세요.";
  }
  insights.tbody.innerHTML = sites
    .map((s) => {
      const l = s.latest ?? {};
      const when = l.ts ? new Date(l.ts).toLocaleString("ko-KR") : "—";
      return `<tr>
        <td class="name">${escapeHtml(s.displayName)}</td>
        <td class="num">${scoreCell(l.performance)}</td>
        <td class="num">${scoreCell(l.accessibility)}</td>
        <td class="num">${scoreCell(l.bestPractices)}</td>
        <td class="num">${scoreCell(l.seo)}</td>
        <td class="top">${when}</td>
        <td class="spark-cell">${sparkline(s.trend)}</td>
      </tr>`;
    })
    .join("");
  const errNote = data.errors?.length ? ` · ${data.errors.length}개 오류` : "";
  insights.meta.textContent = data.lastRunAt
    ? `마지막 측정 ${new Date(data.lastRunAt).toLocaleString("ko-KR")}${errNote}`
    : "";
}

async function loadInsights() {
  try {
    const res = await fetch("/api/insights");
    const data = await res.json();
    renderInsights(data);
    if (data.isMeasuring && !insightsTimer) {
      insightsTimer = setInterval(loadInsights, 4000);
    } else if (!data.isMeasuring && insightsTimer) {
      clearInterval(insightsTimer);
      insightsTimer = null;
    }
  } catch (err) {
    insights.status.hidden = false;
    insights.status.className = "status error";
    insights.status.textContent = `불러오기 실패: ${escapeHtml(err?.message ?? String(err))}`;
  }
}

insights.measure.addEventListener("click", async () => {
  await fetch("/api/insights/measure", { method: "POST" });
  loadInsights();
});

tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    const view = tab.dataset.view;
    views.traffic.hidden = view !== "traffic";
    views.performance.hidden = view !== "performance";
    if (view === "performance") loadInsights();
  }),
);
```

- [ ] **Step 4: Manually verify the shell** — run `npm start`, open the dashboard, click the **성능** tab. With no key it should show the "API 키 미설정" hint; the **트래픽** tab still works. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "Add Performance tab UI (insights table, score badges, measure button)"
```

---

### Task 10: GCP — enable PSI API + create API key + configure

**Files:**
- Create (local, not committed): `~/.sitedeck/config.json`

- [ ] **Step 1: Enable the PageSpeed Insights API** in the `sitedeck-499322` GCP project (Google Cloud Console → APIs & Services → enable "PageSpeed Insights API"). Can be done via browser automation.

- [ ] **Step 2: Create an API key** (APIs & Services → Credentials → Create credentials → API key). Optionally restrict it to the PageSpeed Insights API.

- [ ] **Step 3: Write the key to `~/.sitedeck/config.json`**

```json
{ "psiApiKey": "<the-api-key>" }
```

- [ ] **Step 4: Sanity-check the key** (replace URL/key):

```bash
curl "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://example.com&strategy=mobile&category=PERFORMANCE&key=<KEY>"
```
Expected: JSON with `lighthouseResult.categories.performance.score`.

---

### Task 11: Live end-to-end verification

- [ ] **Step 1: Start the server** — `npm start` (token cached from prior GA auth).

- [ ] **Step 2: Open the 성능 tab** and click **지금 측정**. Expect "측정 중…", then after a minute or two a row per site with colored 0–100 score badges, last-measured time, and a trend cell.

- [ ] **Step 3: Confirm persistence** — verify `~/.sitedeck/insights.json` exists and contains `byUrl` history. Restart the server and confirm scores load immediately on the 성능 tab.

- [ ] **Step 4: Confirm the API directly**

```bash
curl http://localhost:4317/api/insights
```
Expected: `configured:true`, `sites[]` with `latest` scores.

- [ ] **Step 5: Stop the server.**

---

### Task 12: Docs

**Files:**
- Modify: `README.md`, `README.ko.md`, `.gitignore`

- [ ] **Step 1: Ensure local config is ignored** — confirm `.gitignore` covers `config.json` is NOT needed (the file lives in `~/.sitedeck`, outside the repo). No change required; verify `git status` is clean of any key file.

- [ ] **Step 2: Add a "Performance (PageSpeed)" section** to `README.md` and `README.ko.md` describing: enabling the PSI API + API key, placing it in `~/.sitedeck/config.json`, and the daily/manual measurement behavior.

- [ ] **Step 3: Commit**

```bash
git add README.md README.ko.md
git commit -m "Document the Performance (PageSpeed) tab and PSI key setup"
```

---

## Self-Review

**Spec coverage:** scores parsing (T2), PSI fetch mobile/4-cat (T3), local history + retention (T4/T5), URL derivation from data streams (T6), daily scheduler + manual + single-flight (T7), `/api/insights` + `/measure` (T8), Traffic/Performance tabs + colored badges + sparkline + states (T9), PSI key config + `configured:false` path (T1/T9), prerequisite key setup (T10), live verification + persistence (T11), docs (T12). All spec sections map to tasks.

**Type consistency:** `PsiScores` (psi.ts) is reused by `Measurement` (insights-store.ts) and spread into measurements in insights.ts. `summarize` returns `InsightsSite[]`; the UI reads `latest.{performance,accessibility,bestPractices,seo}`, `trend`, `displayName`, `lastRunAt`, `isMeasuring`, `configured`, `errors` — all present in `getInsightsState()`. `getPsiApiKey`, `INSIGHTS_*`, `CONFIG_JSON_PATH` defined in T1 and consumed in T7. `listSiteUrls`/`SiteUrl` defined in T6, consumed in T7.

**No placeholders:** every code step contains complete code; commands have expected output.
