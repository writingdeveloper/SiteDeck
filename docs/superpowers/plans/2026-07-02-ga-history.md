# GA 일별 히스토리 저장 + 활용 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA4 일별 지표를 `~/.sitedeck/ga-history.json`에 누적 저장하고, 드로어 히스토리·주간대비(WoW)·추세 기반 전략·버크 복사 WoW 라인으로 활용한다.

**Architecture:** `/api/summary` 실행 시 속성별 90일 일별 시리즈를 백필(upsert). 파생값(주간 시리즈·WoW·연속 하락)은 스토어에서 계산하는 순수 함수. 요약에 compact digest를 실어 전략·복사가 드로어 없이 동작하고, `/api/site-detail`에 주간 시리즈를 실어 드로어가 차트를 그린다.

**Tech Stack:** ESM TS(GA4 Data API), vitest, `store-io`, 바닐라 JS, `public/strategy.js`, i18n ×5.

**참고:** github-store.ts의 `isoMinusDays`/`calendarDays`/upsert-trim 패턴을 미러. `deltaPct`는 `src/summary.ts`에서 import. `DayMetrics`/`HistoryDigest`는 `ga-store.ts`가 소유(ga.ts·summary.ts가 type import). `t()`는 미스 키를 en→키 폴백하므로 신규 i18n 키는 5개 로케일 전부에.

---

## Task 1: 스토어 + 파생 함수 (`src/ga-store.ts`) + config 상수

**Files:**
- Create: `src/ga-store.ts`
- Create: `src/ga-store.test.ts`
- Modify: `src/config.ts` (끝에 상수 추가)

- [ ] **Step 1: config 상수 추가** — `src/config.ts` 끝

```ts
/** GA daily-history store (mirrors the PSI/GitHub history constants). */
export const GA_HISTORY_STORE_PATH = path.join(CONFIG_DIR, 'ga-history.json');
export const GA_HISTORY_RETENTION_DAYS = 365;
export const GA_HISTORY_FETCH_DAYS = 90;
export const GA_HISTORY_WEEKS = 12;
```

- [ ] **Step 2: 실패하는 테스트 작성** — `src/ga-store.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  emptyGaHistory, upsertDailyMetrics, weeklySeries, wow, consecutiveDeclineWeeks, historyDigest,
} from './ga-store';

const M = (activeUsers: number, sessions = 0, keyEvents = 0, aiSessions = 0) => ({ activeUsers, sessions, keyEvents, aiSessions });
// n consecutive days ending at `end` (YYYY-MM-DD), each with activeUsers=values[i].
function daysStore(propertyId: string, end: string, values: number[]) {
  let store = emptyGaHistory();
  const series = values.map((v, i) => {
    const d = new Date(Date.parse(`${end}T00:00:00Z`) - (values.length - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date: d, metrics: M(v) };
  });
  store = upsertDailyMetrics(store, propertyId, series, 400);
  return store;
}

describe('upsertDailyMetrics', () => {
  it('merges by date (latest wins) and trims to retention', () => {
    let s = emptyGaHistory();
    s = upsertDailyMetrics(s, '1', [{ date: '2026-01-01', metrics: M(5) }, { date: '2026-01-02', metrics: M(6) }], 400);
    s = upsertDailyMetrics(s, '1', [{ date: '2026-01-02', metrics: M(9) }], 400); // overwrite
    expect(s.byProperty['1'].days['2026-01-02']).toEqual(M(9));
    expect(Object.keys(s.byProperty['1'].days)).toHaveLength(2);
  });
  it('keeps only the newest `retention` days', () => {
    let s = emptyGaHistory();
    const many = Array.from({ length: 10 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, metrics: M(i) }));
    s = upsertDailyMetrics(s, '1', many, 3);
    expect(Object.keys(s.byProperty['1'].days).sort()).toEqual(['2026-01-08', '2026-01-09', '2026-01-10']);
  });
});

describe('weeklySeries', () => {
  it('sums into 7-day buckets ending at the latest day (oldest→newest)', () => {
    // 14 days: first week all 1 (sum 7), second week all 2 (sum 14).
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(1), ...Array(7).fill(2)]);
    expect(weeklySeries(s, '1', 'activeUsers', 2)).toEqual([7, 14]);
  });
  it('zero-fills weeks with no data', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(3)]); // only the latest week has data
    expect(weeklySeries(s, '1', 'activeUsers', 2)).toEqual([0, 21]);
  });
});

describe('wow', () => {
  it('compares the latest 7 days vs the previous 7', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(10), ...Array(7).fill(5)]); // prev 70, cur 35
    expect(wow(s, '1', 'activeUsers')).toEqual({ current: 35, previous: 70, deltaPct: -50 });
  });
  it('returns deltaPct null when the previous week is zero', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(0), ...Array(7).fill(5)]);
    expect(wow(s, '1', 'activeUsers').deltaPct).toBeNull();
  });
});

describe('consecutiveDeclineWeeks', () => {
  it('counts trailing weeks each below the prior week', () => {
    // weekly sums (oldest→newest): 70,70,63,49,35 → last three decline (70→63→49→35)
    const s = daysStore('1', '2026-03-07', [
      ...Array(7).fill(10), ...Array(7).fill(10), ...Array(7).fill(9), ...Array(7).fill(7), ...Array(7).fill(5),
    ]);
    expect(consecutiveDeclineWeeks(s, '1', 'activeUsers')).toBe(3);
  });
  it('returns 0 with fewer than two weeks or no volume', () => {
    expect(consecutiveDeclineWeeks(daysStore('1', '2026-03-07', [1, 2, 3]), '1', 'activeUsers')).toBe(0);
    expect(consecutiveDeclineWeeks(emptyGaHistory(), 'x', 'activeUsers')).toBe(0);
  });
});

describe('historyDigest', () => {
  it('returns null for a property with no days', () => {
    expect(historyDigest(emptyGaHistory(), 'x')).toBeNull();
  });
  it('exposes per-metric WoW deltaPct and activeUsers declineWeeks', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(10), ...Array(7).fill(5)]);
    const d = historyDigest(s, '1');
    expect(d?.wow.activeUsers).toBe(-50);
    expect(typeof d?.declineWeeks).toBe('number');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/ga-store.test.ts`
Expected: FAIL — `Cannot find module './ga-store'`

- [ ] **Step 4: `src/ga-store.ts` 구현**

```ts
import { loadJsonStore, saveJsonStore } from './store-io';
import { deltaPct } from './summary';

export interface DayMetrics {
  activeUsers: number;
  sessions: number;
  keyEvents: number;
  aiSessions: number;
}
export type MetricKey = keyof DayMetrics;

export interface GaHistory {
  version: number;
  byProperty: Record<string, { days: Record<string, DayMetrics> }>;
}
export interface HistoryDigest {
  wow: Record<MetricKey, number | null>;
  declineWeeks: number;
}

const ZERO: DayMetrics = { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 };
const MS_PER_DAY = 86_400_000;

export function emptyGaHistory(): GaHistory {
  return { version: 1, byProperty: {} };
}

/** YYYY-MM-DD `n` days before `dateStr` (UTC). */
function isoMinusDays(dateStr: string, n: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - n * MS_PER_DAY).toISOString().slice(0, 10);
}
/** Every YYYY-MM-DD from `start` to `end` inclusive (UTC). */
function calendarDays(start: string, end: string): string[] {
  const out: string[] = [];
  const endT = Date.parse(`${end}T00:00:00Z`);
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= endT; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Merge a daily series into a property by calendar date (latest value wins),
 *  keeping only the newest `retentionDays` days. */
export function upsertDailyMetrics(
  store: GaHistory,
  propertyId: string,
  series: { date: string; metrics: DayMetrics }[],
  retentionDays: number,
): GaHistory {
  const prev = store.byProperty[propertyId];
  const days: Record<string, DayMetrics> = { ...(prev?.days ?? {}) };
  for (const row of series) days[row.date] = row.metrics;
  const trimmed: Record<string, DayMetrics> = {};
  for (const date of Object.keys(days).sort().slice(-retentionDays)) trimmed[date] = days[date] as DayMetrics;
  return { ...store, byProperty: { ...store.byProperty, [propertyId]: { days: trimmed } } };
}

/** Contiguous daily values of `metric` for the last `count` calendar days ending at
 *  the property's latest stored date (missing days = 0), oldest→newest. */
function dailyWindow(store: GaHistory, propertyId: string, metric: MetricKey, count: number): number[] {
  const days = store.byProperty[propertyId]?.days ?? {};
  const dates = Object.keys(days).sort();
  const last = dates[dates.length - 1];
  if (!last) return [];
  return calendarDays(isoMinusDays(last, count - 1), last).map((d) => (days[d] ?? ZERO)[metric]);
}

/** Weekly sums for the last `weeks` complete 7-day buckets, oldest→newest. */
export function weeklySeries(store: GaHistory, propertyId: string, metric: MetricKey, weeks: number): number[] {
  const daily = dailyWindow(store, propertyId, metric, weeks * 7);
  const out: number[] = [];
  for (let i = 0; i < daily.length; i += 7) out.push(daily.slice(i, i + 7).reduce((a, b) => a + b, 0));
  return out;
}

/** Latest 7-day sum vs the preceding 7-day sum (deltaPct null when previous is 0). */
export function wow(
  store: GaHistory,
  propertyId: string,
  metric: MetricKey,
): { current: number; previous: number; deltaPct: number | null } {
  const daily = dailyWindow(store, propertyId, metric, 14);
  const previous = daily.slice(0, 7).reduce((a, b) => a + b, 0);
  const current = daily.slice(7, 14).reduce((a, b) => a + b, 0);
  return { current, previous, deltaPct: deltaPct(current, previous) };
}

/** Trailing consecutive weeks each strictly below the prior week (from a >0 base). */
export function consecutiveDeclineWeeks(
  store: GaHistory,
  propertyId: string,
  metric: MetricKey,
  maxWeeks = 12,
): number {
  const w = weeklySeries(store, propertyId, metric, maxWeeks);
  let c = 0;
  for (let i = w.length - 1; i >= 1; i--) {
    const cur = w[i] as number;
    const prev = w[i - 1] as number;
    if (prev > 0 && cur < prev) c++;
    else break;
  }
  return c;
}

/** Compact per-site history summary attached to the /api/summary payload. */
export function historyDigest(store: GaHistory, propertyId: string): HistoryDigest | null {
  const days = store.byProperty[propertyId]?.days;
  if (!days || Object.keys(days).length === 0) return null;
  return {
    wow: {
      activeUsers: wow(store, propertyId, 'activeUsers').deltaPct,
      sessions: wow(store, propertyId, 'sessions').deltaPct,
      keyEvents: wow(store, propertyId, 'keyEvents').deltaPct,
      aiSessions: wow(store, propertyId, 'aiSessions').deltaPct,
    },
    declineWeeks: consecutiveDeclineWeeks(store, propertyId, 'activeUsers'),
  };
}

export function loadGaHistory(filePath: string): Promise<GaHistory> {
  return loadJsonStore<GaHistory>(filePath, emptyGaHistory, (p) => Boolean((p as { byProperty?: unknown }).byProperty));
}
export function saveGaHistory(filePath: string, store: GaHistory): Promise<void> {
  return saveJsonStore(filePath, store);
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/ga-store.test.ts`
Expected: PASS

- [ ] **Step 6: 타입체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add src/ga-store.ts src/ga-store.test.ts src/config.ts
git commit -m "feat(ga-store): daily-history store + weekly/WoW/decline derivations"
```

---

## Task 2: GA 일별 조회 (`fetchDailyMetrics` + `mapDailyMetricsRows`)

**Files:**
- Modify: `src/ga.ts`
- Modify: `src/ga.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/ga.test.ts`에 추가 (import에 `mapDailyMetricsRows` 추가)

```ts
import { mapDailyMetricsRows } from './ga';

describe('mapDailyMetricsRows', () => {
  const base = [
    { dimensionValues: [{ value: '20260101' }], metricValues: [{ value: '10' }, { value: '20' }, { value: '2' }] },
    { dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '5' }, { value: '9' }, { value: '1' }] },
  ];
  const ai = [{ dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '3' }] }];
  const days = ['20260101', '20260102', '20260103'];

  it('merges base + AI reports by day, zero-fills the range, and dashes dates', () => {
    expect(mapDailyMetricsRows(base, ai, days)).toEqual([
      { date: '2026-01-01', metrics: { activeUsers: 10, sessions: 20, keyEvents: 2, aiSessions: 0 } },
      { date: '2026-01-02', metrics: { activeUsers: 5, sessions: 9, keyEvents: 1, aiSessions: 3 } },
      { date: '2026-01-03', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
  });
  it('handles null report rows', () => {
    expect(mapDailyMetricsRows(null, null, ['20260101'])).toEqual([
      { date: '2026-01-01', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/ga.test.ts`
Expected: FAIL — `mapDailyMetricsRows is not a function`

- [ ] **Step 3: `src/ga.ts` 수정** — import + 함수 추가

파일 상단 import에 `DayMetrics` 타입 추가:
```ts
import type { DayMetrics } from './ga-store';
```
(기존 `import { enumerateDays, type DateRange } from './periods';`는 그대로 — `enumerateDays` 사용.)

파일 끝에 추가:
```ts
export interface DailyMetricsRow {
  date: string; // YYYY-MM-DD
  metrics: DayMetrics;
}

type Row = { dimensionValues?: ({ value?: string | null } | undefined)[] | null; metricValues?: ({ value?: string | null } | undefined)[] | null };

/** Merge a base report (date + [activeUsers,sessions,keyEvents]) and an AI report
 *  (date + [sessions]) into one zero-filled daily series over `days` (YYYYMMDD),
 *  converting the date to YYYY-MM-DD. Pure — split out for unit testing. */
export function mapDailyMetricsRows(base: Row[] | null | undefined, ai: Row[] | null | undefined, days: string[]): DailyMetricsRow[] {
  const b = new Map<string, { a: number; s: number; k: number }>();
  for (const r of base ?? []) {
    const day = r.dimensionValues?.[0]?.value;
    if (day) b.set(day, {
      a: Number(r.metricValues?.[0]?.value ?? 0),
      s: Number(r.metricValues?.[1]?.value ?? 0),
      k: Number(r.metricValues?.[2]?.value ?? 0),
    });
  }
  const aiMap = new Map<string, number>();
  for (const r of ai ?? []) {
    const day = r.dimensionValues?.[0]?.value;
    if (day) aiMap.set(day, Number(r.metricValues?.[0]?.value ?? 0));
  }
  return days.map((ymd) => {
    const bv = b.get(ymd) ?? { a: 0, s: 0, k: 0 };
    return {
      date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      metrics: { activeUsers: bv.a, sessions: bv.s, keyEvents: bv.k, aiSessions: aiMap.get(ymd) ?? 0 },
    };
  });
}

/** Daily {activeUsers, sessions, keyEvents, aiSessions} over a range, zero-filled. */
export async function fetchDailyMetrics(auth: OAuth2Client, propertyId: string, range: DateRange): Promise<DailyMetricsRow[]> {
  const client = data(auth);
  const [[base], [aiRep]] = await Promise.all([
    client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'keyEvents' }],
    }),
    client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: AI_DIMENSION_FILTER as never,
    }),
  ]);
  return mapDailyMetricsRows(base.rows, aiRep.rows, enumerateDays(range));
}
```

- [ ] **Step 4: 통과 확인 + 타입체크 + 전체 테스트**

Run: `npx vitest run src/ga.test.ts && npm run typecheck && npx vitest run`
Expected: 신규 테스트 통과, 타입 에러 없음, 회귀 없음

- [ ] **Step 5: 커밋**

```bash
git add src/ga.ts src/ga.test.ts
git commit -m "feat(ga): fetchDailyMetrics + mapDailyMetricsRows for history backfill"
```

---

## Task 3: 서버 — 백필 + digest + 드로어 히스토리 (`src/summary.ts`, `src/server.ts`)

**Files:**
- Modify: `src/summary.ts` (SiteSummary에 history 추가)
- Modify: `src/server.ts` (import, buildSummary, /api/site-detail)

- [ ] **Step 1: `src/summary.ts`에 history 필드 추가**

파일 상단에 import 추가:
```ts
import type { HistoryDigest } from './ga-store';
```
`SiteSummary` 인터페이스 끝(`search` 다음)에 추가:
```ts
  /** Compact daily-history summary (WoW deltas + activeUsers decline streak); null until history exists. */
  history: HistoryDigest | null;
```

- [ ] **Step 2: `src/server.ts` import 보강**

`./config` import에 상수 추가:
```ts
import { DETAIL_TOPN, GA_CONCURRENCY, GA_HISTORY_FETCH_DAYS, GA_HISTORY_RETENTION_DAYS, GA_HISTORY_STORE_PATH, GA_HISTORY_WEEKS, OAUTH_CALLBACK_PATH, PORT, SEARCH_CONSOLE_SCOPE, type Period } from './config';
```
`./ga` import에 `fetchDailyMetrics` 추가(그리고 `fetchDailySeries`는 buildSummary에서 미사용이 되지만 import 목록에서 제거):
```ts
import {
  AI_DIMENSION_FILTER,
  fetchAiSessions,
  fetchBreakdown,
  fetchDailyMetrics,
  fetchRange,
  fetchTopValue,
  listProperties,
  listSiteUrls,
} from './ga';
```
(주의: 기존 `fetchDailySeries` import 줄 제거. 타 사용처 없음.)
새 import 추가:
```ts
import { loadGaHistory, saveGaHistory, upsertDailyMetrics, historyDigest, weeklySeries, wow } from './ga-store';
```

- [ ] **Step 3: `buildSummary` 교체** — 현재 함수 본문(props 로드 이후 ~ return)을 아래로 교체

```ts
  const props = await listProperties(auth);
  const [siteUrls, gscSites] = await Promise.all([
    listSiteUrls(auth, props).catch(() => []),
    listGscSites(auth).catch(() => []),
  ]);
  const gscMatch = matchSites(siteUrls, gscSites);

  // Daily-history backfill: fetch a fixed 90-day window per property (independent of
  // the view period) and upsert it, so history accumulates as the app is used.
  let history = await loadGaHistory(GA_HISTORY_STORE_PATH);
  const historyRange = comparisonRanges(GA_HISTORY_FETCH_DAYS as Period).current;

  const results = (
    await mapPool(props, GA_CONCURRENCY, async (p) => {
      try {
        const gscSiteUrl = gscMatch.get(p.propertyId);
        const [cur, prev, topPage, topSource, daily, aiCur, aiPrev, search] = await Promise.all([
          fetchRange(auth, p.propertyId, ranges.current),
          fetchRange(auth, p.propertyId, ranges.previous),
          fetchTopValue(auth, p.propertyId, ranges.current, 'pagePath', 'screenPageViews'),
          fetchTopValue(auth, p.propertyId, ranges.current, 'sessionDefaultChannelGroup', 'sessions'),
          fetchDailyMetrics(auth, p.propertyId, historyRange),
          fetchAiSessions(auth, p.propertyId, ranges.current),
          fetchAiSessions(auth, p.propertyId, ranges.previous),
          gscSiteUrl ? fetchSearchMetrics(auth, gscSiteUrl, ranges.current).catch(() => null) : Promise.resolve(null),
        ]);
        const summary: SiteSummary = {
          propertyId: p.propertyId,
          displayName: p.displayName,
          activeUsers: metricDelta(cur.activeUsers, prev.activeUsers),
          sessions: metricDelta(cur.sessions, prev.sessions),
          keyEvents: metricDelta(cur.keyEvents, prev.keyEvents),
          aiSessions: metricDelta(aiCur, aiPrev),
          trend: daily.slice(-period).map((r) => r.metrics.activeUsers),
          topPage,
          topSource,
          search,
          history: null,
        };
        return { propertyId: p.propertyId, series: daily, summary };
      } catch (err) {
        errors.push({
          propertyId: p.propertyId,
          displayName: p.displayName,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    })
  ).filter((r): r is { propertyId: string; series: Awaited<ReturnType<typeof fetchDailyMetrics>>; summary: SiteSummary } => r !== null);

  // Upsert sequentially (never mutate the shared store concurrently), persist once.
  for (const r of results) history = upsertDailyMetrics(history, r.propertyId, r.series, GA_HISTORY_RETENTION_DAYS);
  await saveGaHistory(GA_HISTORY_STORE_PATH, history).catch((e) => console.error('ga-history save failed (non-fatal):', e));

  const sites = results.map((r) => ({ ...r.summary, history: historyDigest(history, r.propertyId) }));

  return { authenticated: true, period, generatedAt: new Date().toISOString(), sites, errors };
```

- [ ] **Step 4: `/api/site-detail`에 history 추가** — 핸들러의 `const [channels, pages, aiEngines] = await Promise.all([...]);` 다음, `json(...)` 이전에 삽입하고 응답에 history 포함

```ts
      const gh = await loadGaHistory(GA_HISTORY_STORE_PATH);
      const hasHistory = Object.keys(gh.byProperty[propertyId]?.days ?? {}).length > 0;
      const history = hasHistory
        ? {
            weekly: {
              activeUsers: weeklySeries(gh, propertyId, 'activeUsers', GA_HISTORY_WEEKS),
              sessions: weeklySeries(gh, propertyId, 'sessions', GA_HISTORY_WEEKS),
              keyEvents: weeklySeries(gh, propertyId, 'keyEvents', GA_HISTORY_WEEKS),
              aiSessions: weeklySeries(gh, propertyId, 'aiSessions', GA_HISTORY_WEEKS),
            },
            wow: {
              activeUsers: wow(gh, propertyId, 'activeUsers').deltaPct,
              sessions: wow(gh, propertyId, 'sessions').deltaPct,
              keyEvents: wow(gh, propertyId, 'keyEvents').deltaPct,
              aiSessions: wow(gh, propertyId, 'aiSessions').deltaPct,
            },
          }
        : null;
      json(res, 200, { authenticated: true, channels, pages, aiEngines, history });
```
(기존 `json(res, 200, { authenticated: true, channels, pages, aiEngines });` 줄 제거.)

- [ ] **Step 5: 타입체크 + 전체 테스트 + 빌드 스모크**

Run:
```bash
npm run typecheck && npx vitest run 2>&1 | tail -3
npm run build:server
PORT=4399 node dist/server.mjs & sleep 2
curl -s -H "Host: localhost:4399" "http://localhost:4399/api/summary?period=28" -o /dev/null -w "summary %{http_code}\n"
PROP=$(curl -s -H "Host: localhost:4399" "http://localhost:4399/api/summary?period=28" | grep -oE '"propertyId":"[0-9]+"' | head -1 | grep -oE '[0-9]+')
curl -s -H "Host: localhost:4399" "http://localhost:4399/api/site-detail?propertyId=$PROP&period=28" | grep -o '"history":[^}]*}[^}]*}' | head -c 200; echo
kill %1
ls -la ~/.sitedeck/ga-history.json 2>/dev/null && echo "store written"
```
Expected: 타입/테스트 통과, summary 200, site-detail 응답에 `"history"` 포함(또는 null), `ga-history.json` 생성됨.

- [ ] **Step 6: 커밋**

```bash
git add src/summary.ts src/server.ts
git commit -m "feat(server): GA history backfill in buildSummary + weekly series in site-detail"
```

---

## Task 4: 추세 전략 규칙 (`public/strategy.js`) + i18n

**Files:**
- Modify: `public/strategy.js`
- Modify: `src/strategy.test.ts`
- Modify: `public/locales/{en,ko,ja,zh,es}.json`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/strategy.test.ts`에 추가

```ts
describe('trend-decline rule', () => {
  it('fires when history.declineWeeks >= 3', () => {
    const f = analyzeSite(site({ history: { wow: {}, declineWeeks: 3 } }));
    expect(f.some((x) => x.id === 'trend-decline' && x.severity === 'medium')).toBe(true);
  });
  it('does not fire below the threshold or without history', () => {
    expect(analyzeSite(site({ history: { wow: {}, declineWeeks: 2 } })).some((x) => x.id === 'trend-decline')).toBe(false);
    expect(analyzeSite(site()).some((x) => x.id === 'trend-decline')).toBe(false);
  });
});
```
(주의: 기존 `site()` 헬퍼가 반환 객체에 `history`를 포함하지 않으므로, `site()` 기본에 `history: null`을 추가하거나 위처럼 override로 전달. 기본 `site()`가 all-good를 유지하도록 `history`는 기본 null.)

`src/strategy.test.ts`의 `site()` 헬퍼 기본값에 `history: null,`를 추가.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/strategy.test.ts`
Expected: FAIL — trend-decline 미구현으로 단언 실패

- [ ] **Step 3: `public/strategy.js` 수정**

`STRATEGY` 객체에 추가:
```js
  DECLINE_WEEKS: 3,
```
`analyzeSite`의 `conversion-low` 규칙 다음(‘all-good’ 판정 전)에 추가:
```js
  // High-signal time-series rule: activeUsers declined N+ consecutive weeks.
  if (summary.history && summary.history.declineWeeks >= STRATEGY.DECLINE_WEEKS) {
    out.push({ id: "trend-decline", severity: "medium", params: { weeks: summary.history.declineWeeks } });
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/strategy.test.ts`
Expected: PASS

- [ ] **Step 5: i18n `strategy.trendDecline` 추가** — 5개 파일, `strategy.allGood` 다음(콤마 처리)

en: `"strategy.trendDecline": "Active users declined {weeks} weeks in a row — investigate a sustained downtrend",`
ko: `"strategy.trendDecline": "활성 사용자가 {weeks}주 연속 하락 — 지속적 하락세 원인 점검",`
ja: `"strategy.trendDecline": "アクティブユーザーが{weeks}週連続で減少 — 継続的な下降傾向を調査",`
zh: `"strategy.trendDecline": "活跃用户连续 {weeks} 周下降 — 排查持续下行趋势",`
es: `"strategy.trendDecline": "Usuarios activos bajaron {weeks} semanas seguidas — investiga la tendencia sostenida a la baja",`

(각 파일에서 기존 마지막 키였던 `strategy.allGood`에 콤마를 추가하고 그 아래에 삽입. 단, Task 이후 파일 말미 키가 다를 수 있으니 실제 파일을 확인 후 유효한 위치에 추가.)

- [ ] **Step 6: 파싱 + 커밋**

Run: `node -e "['en','ko','ja','zh','es'].forEach(l=>JSON.parse(require('fs').readFileSync('public/locales/'+l+'.json','utf8')));console.log('OK')" && npm run typecheck && npx vitest run 2>&1 | tail -2`

```bash
git add public/strategy.js src/strategy.test.ts public/locales
git commit -m "feat(strategy): trend-decline rule (N consecutive weeks down)"
```

---

## Task 5: 프론트 — 드로어 히스토리 + 버크 복사 WoW (`public/app.js`) + i18n

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html` (`.repo-detail` 스타일시트 = `public/style.css`에 CSS 소량 추가, 필요 시)
- Modify: `public/locales/{en,ko,ja,zh,es}.json`

> DOM 통합이라 브라우저로 검증(Task 6). `trendSparkText`는 이미 import됨.

- [ ] **Step 1: 드로어 히스토리 헬퍼 추가** — `renderSiteDetailBody` 위에 삽입

```js
// 최근 주간 시리즈(스파크라인) + WoW %를 4개 지표로 보여주는 드로어 섹션.
function historyBlock(history) {
  if (!history) return "";
  const wowStr = (v) => (typeof v === "number" ? `${v > 0 ? "+" : ""}${v}%` : "—");
  const rows = [
    ["activeUsers", "col.activeUsers"],
    ["sessions", "col.sessions"],
    ["keyEvents", "col.keyEvents"],
    ["aiSessions", "col.aiTraffic"],
  ]
    .map(([k, key]) =>
      `<li>${escapeHtml(t(key))} <span class="muted">${escapeHtml(trendSparkText(history.weekly[k]))} · WoW ${wowStr(history.wow[k])}</span></li>`,
    )
    .join("");
  return `<div class="bd-block"><b>${escapeHtml(t("detail.history"))}</b><ul>${rows}</ul></div>`;
}
```

- [ ] **Step 2: `renderSiteDetailBody`에 히스토리 섹션 추가** — `renderStrategy(...)` 다음, "전체 복사" 버튼 앞에 삽입

```js
    historyBlock(detail.history) +
```
(최종 순서: 채널 · 페이지 · AI엔진 · 전략 · **히스토리** · 전체복사 버튼.)

- [ ] **Step 3: `trafficMarkdown`에 WoW 섹션 추가** — `strategy` 계산 다음, return 앞에 삽입하고 return 문자열에 이어붙이기

```js
  const wowLines = sites
    .map((s) => {
      const h = s.history;
      if (!h) return null;
      const p = (v) => (typeof v === "number" ? `${v > 0 ? "+" : ""}${v}%` : "—");
      return `- ${s.displayName}: ${t("col.activeUsers")} ${p(h.wow.activeUsers)} · ${t("col.sessions")} ${p(h.wow.sessions)} · ${t("col.aiTraffic")} ${p(h.wow.aiSessions)}`;
    })
    .filter(Boolean);
  const wowSection = wowLines.length ? `\n\n${t("copy.wowHeading")}\n${wowLines.join("\n")}` : "";
```
return 문 변경:
```js
  return `${t("copy.aiPrompt")}\n\n${title}\n${portfolio}\n\n${toMarkdownTable(headers, rows)}${strategy}${wowSection}`;
```

- [ ] **Step 4: i18n 키 추가** — 5개 파일 (`detail.history`, `copy.wowHeading`)

en: `"detail.history": "History (weekly)",` / `"copy.wowHeading": "## Week-over-week (WoW)",`
ko: `"detail.history": "히스토리 (주간)",` / `"copy.wowHeading": "## 주간 대비 (WoW)",`
ja: `"detail.history": "履歴（週次）",` / `"copy.wowHeading": "## 前週比 (WoW)",`
zh: `"detail.history": "历史（每周）",` / `"copy.wowHeading": "## 环比上周 (WoW)",`
es: `"detail.history": "Historial (semanal)",` / `"copy.wowHeading": "## Semana contra semana (WoW)",`

(각 파일 유효 위치에 삽입 — 실제 말미 확인 후.)

- [ ] **Step 5: 파싱/파스/회귀 확인**

Run:
```bash
npx esbuild public/app.js --format=esm >/dev/null && echo APPJS_OK
node -e "['en','ko','ja','zh','es'].forEach(l=>JSON.parse(require('fs').readFileSync('public/locales/'+l+'.json','utf8')));console.log('LOCALES_OK')"
npm run typecheck && npx vitest run 2>&1 | tail -2
```
Expected: APPJS_OK, LOCALES_OK, 타입 클린, 회귀 없음

- [ ] **Step 6: 커밋**

```bash
git add public/app.js public/index.html public/style.css public/locales
git commit -m "feat(history): drawer history section + bulk-copy WoW section"
```

---

## Task 6: 통합 QA + 검증

**Files:** (없음)

- [ ] **Step 1: 타입체크 + 전체 테스트**

Run: `npm run typecheck && npx vitest run`
Expected: 클린, 모든 테스트 통과(기존 180 + ga-store ~10 + mapDailyMetricsRows 2 + trend-decline 2).

- [ ] **Step 2: 빌드 + 브라우저 실데이터 QA**

Run: `npm run build:server && PORT=4399 node dist/server.mjs`
브라우저 `http://localhost:4399`:
- 트래픽 행 펼침 → 드로어에 **히스토리(주간)** 섹션(4개 지표 스파크라인 + WoW %) 표시
- (해당 시) 전략에 "N주 연속 하락"
- "텍스트 복사" → 붙여넣어 **## 주간 대비 (WoW)** 섹션 확인
- 재조회 후 다시 열어 `~/.sitedeck/ga-history.json` 누적 확인
- DevTools 콘솔 오류 0 (SiteDeck 기준)

- [ ] **Step 3: 시크릿 스캔 + git 상태**

Run:
```bash
git grep -nE "github_pat_[A-Za-z0-9_]{20}|AIzaSy|GOCSPX" -- ':!docs' || echo clean
git status --short
```
Expected: clean, 커밋 안 된 변경 없음

---

## Self-Review 메모(작성자 확인 완료)

- **Spec 커버리지:** 스토어+파생(T1)·GA 조회(T2)·서버 백필/digest/드로어(T3)·전략 규칙(T4)·프론트 드로어+복사(T5)·QA(T6) — spec 전 항목 매핑.
- **타입/이름 일관성:** `DayMetrics`/`HistoryDigest`(ga-store 소유) ↔ ga.ts·summary.ts type import; `historyDigest`→`SiteSummary.history` ↔ strategy `summary.history.declineWeeks` ↔ site-detail `history.weekly/wow` ↔ app `historyBlock`/`wowSection`; `weeklySeries`/`wow` 인자 `MetricKey` 일치; `GA_HISTORY_*` 상수 일치.
- **레이스:** upsert는 mapPool 팬아웃 밖에서 순차 → 공유 store 동시 변형 없음.
- **YAGNI:** 스케줄러·메인표 WoW 컬럼·YoY 제외.
- **브랜치:** feature 브랜치 `feat/ga-history`에서 작업 후 main 병합.
```
