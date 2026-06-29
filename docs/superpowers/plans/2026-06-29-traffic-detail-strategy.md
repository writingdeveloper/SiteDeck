# 트래픽 상세 드로어 + 개선 전략 + 텍스트 복사 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 트래픽 탭에서 사이트 행을 펼쳐 채널/페이지/AI엔진 분해와 자동 개선 전략을 보고, 각 사이트 지표를 한국어 라벨 텍스트로 복사할 수 있게 한다.

**Architecture:** 메인 요약(`/api/summary`)은 불변. 행 클릭 시에만 새 엔드포인트 `/api/site-detail`을 지연 호출(Repos 탭 드로어 패턴 미러). 개선 전략은 외부 API 없는 순수 함수(`public/strategy.js`, $0)로 계산하고 결과를 i18n으로 렌더. 텍스트 복사 포맷도 순수 함수(`public/format.js`)로 분리해 테스트.

**Tech Stack:** ESM TypeScript(tsx/esbuild), vitest, GA4 Data API, 바닐라 JS 프론트(`public/*.js`), i18n JSON ×5(en/ko/ja/zh/es).

**참고:** 전략 엔진은 `format.js`처럼 브라우저가 직접 import해야 하므로 `public/strategy.js`(+`.d.ts`)에 두고 `src/strategy.test.ts`가 `../public/strategy.js`를 import해 검증한다. `t()`는 미스 키를 en→키 순으로 폴백하므로 **모든 신규 키는 최소 en.json에, 이상적으로 5개 로케일 전부**에 추가한다. `SiteSummary` 형태: `{ propertyId, displayName, activeUsers/sessions/keyEvents/aiSessions: {current,previous,deltaPct}, trend: number[], topPage|null, topSource|null, search: {clicks,impressions,position}|null }`.

---

## Task 1: 개선 전략 엔진 (`public/strategy.js`)

**Files:**
- Create: `public/strategy.js`
- Create: `public/strategy.d.ts`
- Create: `src/strategy.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/strategy.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { analyzeSite } from '../public/strategy.js';

// MetricDelta 빌더.
function md(current: number, deltaPct: number | null = 0) {
  return { current, previous: 0, deltaPct };
}
// 기본값은 "전부 양호"(어떤 규칙도 발화 안 함)인 사이트.
function site(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: '1',
    displayName: 'X',
    activeUsers: md(1000, 5),
    sessions: md(2000, 5),
    keyEvents: md(100, 5), // 5% 전환율
    aiSessions: md(200, 5), // 10% AI 비중
    trend: [10, 11, 12, 13, 14],
    topPage: '/',
    topSource: 'Organic',
    search: { clicks: 50, impressions: 500, position: 5 }, // 10% CTR, 5위
    ...overrides,
  };
}

describe('analyzeSite', () => {
  it('건강한 사이트는 all-good 하나만 반환', () => {
    const f = analyzeSite(site());
    expect(f).toEqual([{ id: 'all-good', severity: 'good', params: {} }]);
  });

  it('활성 사용자 급락 → delta-drop(high)', () => {
    const f = analyzeSite(site({ activeUsers: md(700, -30) }));
    expect(f.some((x) => x.id === 'delta-drop' && x.severity === 'high')).toBe(true);
  });

  it('하락 추세 → trend-down(high)', () => {
    const f = analyzeSite(site({ trend: [100, 80, 60, 40, 20] }));
    expect(f.some((x) => x.id === 'trend-down')).toBe(true);
  });

  it('AI 비중 낮음 → ai-share-low(medium)', () => {
    const f = analyzeSite(site({ aiSessions: md(10, 0) })); // 0.5%
    expect(f.some((x) => x.id === 'ai-share-low' && x.severity === 'medium')).toBe(true);
  });

  it('CTR 낮음 → ctr-low', () => {
    const f = analyzeSite(site({ search: { clicks: 5, impressions: 1000, position: 5 } }));
    expect(f.some((x) => x.id === 'ctr-low')).toBe(true);
  });

  it('평균 순위 나쁨 → position-weak(low)', () => {
    const f = analyzeSite(site({ search: { clicks: 50, impressions: 1000, position: 25 } }));
    expect(f.some((x) => x.id === 'position-weak' && x.severity === 'low')).toBe(true);
  });

  it('전환율 낮음 → conversion-low', () => {
    const f = analyzeSite(site({ keyEvents: md(5, 0) })); // 0.25%
    expect(f.some((x) => x.id === 'conversion-low')).toBe(true);
  });

  it('채널 집중은 detail 있을 때만 → channel-concentrated', () => {
    const detail = { channels: [{ name: 'Organic', value: 90 }, { name: 'Direct', value: 10 }] };
    expect(analyzeSite(site(), detail).some((x) => x.id === 'channel-concentrated')).toBe(true);
    expect(analyzeSite(site()).some((x) => x.id === 'channel-concentrated')).toBe(false);
  });

  it('심각도 순으로 정렬(high가 low보다 앞)', () => {
    const f = analyzeSite(site({ activeUsers: md(700, -30), keyEvents: md(5, 0) }));
    const ids = f.map((x) => x.id);
    expect(ids.indexOf('delta-drop')).toBeLessThan(ids.indexOf('conversion-low'));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/strategy.test.ts`
Expected: FAIL — `Cannot find module '../public/strategy.js'`

- [ ] **Step 3: `public/strategy.js` 구현**

```js
// Pure, DOM-free improvement-strategy engine. Shared by the dashboard
// (public/app.js) and unit tests (src/strategy.test.ts → ../public/strategy.js).
// Deterministic, no network, $0. Thresholds live here (the browser can't read
// src/config.ts); tune them in one place.

export const STRATEGY = {
  DELTA_DROP: -25,
  TREND_DOWN_RATIO: 0.8,
  AI_SHARE_LOW: 0.02,
  AI_SHARE_MIN_SESSIONS: 50,
  CTR_LOW: 0.02,
  CTR_MIN_IMPRESSIONS: 100,
  POSITION_WEAK: 10,
  CONVERSION_LOW: 0.01,
  CONVERSION_MIN_SESSIONS: 50,
  CHANNEL_CONCENTRATION: 0.7,
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, good: 3 };
const round1 = (n) => Math.round(n * 10) / 10;

/** Diagnose a site summary (+ optional channel breakdown) into ordered findings.
 *  Each finding: { id, severity, params } — app.js maps id→localized text. */
export function analyzeSite(summary, detail) {
  const out = [];
  const { activeUsers, sessions, keyEvents, aiSessions, trend, search } = summary;

  // High: active-user drop vs the previous period (deltaPct may be null).
  if (activeUsers && typeof activeUsers.deltaPct === "number" && activeUsers.deltaPct <= STRATEGY.DELTA_DROP) {
    out.push({ id: "delta-drop", severity: "high", params: { pct: activeUsers.deltaPct } });
  }

  // High: downward daily trend (last day well below the first, with real volume).
  if (trend && trend.length >= 2) {
    const first = trend[0] ?? 0;
    const last = trend[trend.length - 1] ?? 0;
    const sum = trend.reduce((a, b) => a + b, 0);
    if (sum > 0 && first > 0 && last < first * STRATEGY.TREND_DOWN_RATIO) {
      out.push({ id: "trend-down", severity: "high", params: {} });
    }
  }

  // Medium: low AI-referred share (only meaningful with enough sessions).
  if (sessions && sessions.current >= STRATEGY.AI_SHARE_MIN_SESSIONS) {
    const share = (aiSessions?.current ?? 0) / sessions.current;
    if (share < STRATEGY.AI_SHARE_LOW) {
      out.push({ id: "ai-share-low", severity: "medium", params: { pct: round1(share * 100) } });
    }
  }

  // Medium: low search click-through rate despite impressions.
  if (search && search.impressions >= STRATEGY.CTR_MIN_IMPRESSIONS) {
    const ctr = search.clicks / search.impressions;
    if (ctr < STRATEGY.CTR_LOW) {
      out.push({ id: "ctr-low", severity: "medium", params: { pct: round1(ctr * 100) } });
    }
  }

  // Medium: one channel dominates traffic (needs the breakdown).
  if (detail && detail.channels && detail.channels.length > 0) {
    const total = detail.channels.reduce((a, c) => a + c.value, 0);
    const top = detail.channels[0];
    if (total > 0 && top && top.value / total > STRATEGY.CHANNEL_CONCENTRATION) {
      out.push({
        id: "channel-concentrated",
        severity: "medium",
        params: { name: top.name, pct: round1((top.value / total) * 100) },
      });
    }
  }

  // Low: weak average search position.
  if (search && search.impressions >= STRATEGY.CTR_MIN_IMPRESSIONS && search.position > STRATEGY.POSITION_WEAK) {
    out.push({ id: "position-weak", severity: "low", params: { pos: round1(search.position) } });
  }

  // Low: few key events per session.
  if (sessions && sessions.current >= STRATEGY.CONVERSION_MIN_SESSIONS) {
    const rate = (keyEvents?.current ?? 0) / sessions.current;
    if (rate < STRATEGY.CONVERSION_LOW) {
      out.push({ id: "conversion-low", severity: "low", params: { pct: round1(rate * 100) } });
    }
  }

  if (out.length === 0) out.push({ id: "all-good", severity: "good", params: {} });

  return out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
  );
}
```

- [ ] **Step 4: `public/strategy.d.ts` 작성**

```ts
export type Severity = "high" | "medium" | "low" | "good";
export interface Finding {
  id: string;
  severity: Severity;
  params: Record<string, string | number>;
}
export interface ChannelBreakdown {
  channels: { name: string; value: number }[];
}
export const STRATEGY: Record<string, number>;
export function analyzeSite(summary: Record<string, unknown>, detail?: ChannelBreakdown): Finding[];
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/strategy.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: 타입체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add public/strategy.js public/strategy.d.ts src/strategy.test.ts
git commit -m "feat(strategy): rule-based improvement-strategy engine (public/strategy.js)"
```

---

## Task 2: GA 분해 조회 (`fetchBreakdown` + `mapBreakdownRows`)

**Files:**
- Modify: `src/ga.ts`
- Create: `src/ga.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/ga.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mapBreakdownRows } from './ga';

describe('mapBreakdownRows', () => {
  it('dimension + metric 값을 {name, value}로 매핑', () => {
    expect(
      mapBreakdownRows([
        { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '120' }] },
        { dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '45' }] },
      ]),
    ).toEqual([
      { name: 'Organic Search', value: 120 },
      { name: 'Direct', value: 45 },
    ]);
  });

  it('이름 누락은 (not set), 값 누락은 0', () => {
    expect(mapBreakdownRows([{}])).toEqual([{ name: '(not set)', value: 0 }]);
  });

  it('null/undefined rows는 빈 배열', () => {
    expect(mapBreakdownRows(null)).toEqual([]);
    expect(mapBreakdownRows(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/ga.test.ts`
Expected: FAIL — `mapBreakdownRows is not a function`

- [ ] **Step 3: `src/ga.ts` 수정 — AI 필터 상수 추출 + 분해 함수 추가**

`AI_SOURCE_REGEX` 상수 바로 아래에 추가:

```ts
/** GA4 dimensionFilter matching AI answer-engine referred sessions. Reused by
 *  fetchAiSessions and the AI-engine breakdown so the definition stays in one place. */
export const AI_DIMENSION_FILTER = {
  orGroup: {
    expressions: [
      {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'AI Assistant' },
        },
      },
      {
        filter: {
          fieldName: 'sessionSource',
          stringFilter: { matchType: 'FULL_REGEXP', value: AI_SOURCE_REGEX },
        },
      },
    ],
  },
} as const;
```

`fetchAiSessions`의 인라인 `dimensionFilter: { orGroup: {...} }`를 `dimensionFilter: AI_DIMENSION_FILTER as never`로 교체(런타임 동일).

파일 끝(`listSiteUrls` 뒤)에 추가:

```ts
export interface BreakdownRow {
  name: string;
  value: number;
}

/** Map a runReport response (one dimension + one metric) to {name, value} rows.
 *  Pure — split out so it can be unit-tested without the GA client. */
export function mapBreakdownRows(
  rows:
    | { dimensionValues?: ({ value?: string | null } | undefined)[]; metricValues?: ({ value?: string | null } | undefined)[] }[]
    | null
    | undefined,
): BreakdownRow[] {
  return (rows ?? []).map((r) => ({
    name: r.dimensionValues?.[0]?.value ?? '(not set)',
    value: Number(r.metricValues?.[0]?.value ?? 0),
  }));
}

/** Top-N values of `metric` by `dimension` for a property over a range (descending),
 *  optionally constrained by a dimensionFilter (e.g. AI_DIMENSION_FILTER). */
export async function fetchBreakdown(
  auth: OAuth2Client,
  propertyId: string,
  range: DateRange,
  dimension: string,
  metric: string,
  limit: number,
  dimensionFilter?: unknown,
): Promise<BreakdownRow[]> {
  const [report] = await data(auth).runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    dimensions: [{ name: dimension }],
    metrics: [{ name: metric }],
    orderBys: [{ metric: { metricName: metric }, desc: true }],
    limit,
    ...(dimensionFilter ? { dimensionFilter: dimensionFilter as never } : {}),
  });
  return mapBreakdownRows(report.rows);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/ga.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 타입체크 + 전체 테스트(회귀 없음)**

Run: `npm run typecheck && npx vitest run`
Expected: 에러 없음, 모든 테스트 통과

- [ ] **Step 6: 커밋**

```bash
git add src/ga.ts src/ga.test.ts
git commit -m "feat(ga): fetchBreakdown + mapBreakdownRows, extract AI_DIMENSION_FILTER"
```

---

## Task 3: `/api/site-detail` 엔드포인트 + propertyId 검증

**Files:**
- Modify: `src/http-helpers.ts`
- Modify: `src/http-helpers.test.ts`
- Modify: `src/config.ts:77` (끝에 `DETAIL_TOPN` 추가)
- Modify: `src/server.ts` (import 보강 + 새 라우트)

- [ ] **Step 1: 실패하는 테스트 작성** — `src/http-helpers.test.ts`에 추가

```ts
import { isValidPropertyId } from './http-helpers';

describe('isValidPropertyId', () => {
  it('숫자 id를 허용', () => {
    expect(isValidPropertyId('123456789')).toBe(true);
  });
  it('null/빈값/비숫자/초과길이를 거부', () => {
    expect(isValidPropertyId(null)).toBe(false);
    expect(isValidPropertyId('')).toBe(false);
    expect(isValidPropertyId('12a')).toBe(false);
    expect(isValidPropertyId('../etc')).toBe(false);
    expect(isValidPropertyId('1'.repeat(21))).toBe(false);
  });
});
```

(파일 상단 import에 `isValidPropertyId`를 기존 `import { ... } from './http-helpers'`에 합쳐도 되고 위처럼 별도 import해도 됨.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/http-helpers.test.ts`
Expected: FAIL — `isValidPropertyId is not a function`

- [ ] **Step 3: `src/http-helpers.ts`에 검증 함수 추가**

```ts
/** True for a GA4 numeric property id (digits only, 1–20 chars). Guards the
 *  site-detail endpoint against path-injection / malformed ids. */
export function isValidPropertyId(raw: string | null): raw is string {
  return typeof raw === 'string' && /^\d{1,20}$/.test(raw);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/http-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: `src/config.ts` 끝에 상수 추가**

```ts
/** How many rows each /api/site-detail breakdown returns (top N). */
export const DETAIL_TOPN = 5;
```

- [ ] **Step 6: `src/server.ts` import 보강**

`./config` import에 `DETAIL_TOPN` 추가:
```ts
import { DETAIL_TOPN, GA_CONCURRENCY, OAUTH_CALLBACK_PATH, PORT, SEARCH_CONSOLE_SCOPE, type Period } from './config';
```
`./ga` import에 `AI_DIMENSION_FILTER, fetchBreakdown` 추가:
```ts
import {
  AI_DIMENSION_FILTER,
  fetchAiSessions,
  fetchBreakdown,
  fetchDailySeries,
  fetchRange,
  fetchTopValue,
  listProperties,
  listSiteUrls,
} from './ga';
```
`./http-helpers` import에 `isValidPropertyId` 추가:
```ts
import { isReauthError, isValidPropertyId, parsePeriod } from './http-helpers';
```

- [ ] **Step 7: `src/server.ts`에 라우트 추가** — `/api/onpage` 블록(280행대) 바로 뒤에 삽입

```ts
  if (url.pathname === '/api/site-detail') {
    try {
      if (!(await isAuthenticated())) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start' });
        return;
      }
      const propertyId = url.searchParams.get('propertyId');
      if (!isValidPropertyId(propertyId)) {
        json(res, 400, { error: { code: 'bad_request', detail: 'invalid propertyId' } });
        return;
      }
      const range = comparisonRanges(parsePeriod(url.searchParams.get('period'))).current;
      const auth = await getClient();
      const [channels, pages, aiEngines] = await Promise.all([
        fetchBreakdown(auth, propertyId, range, 'sessionDefaultChannelGroup', 'sessions', DETAIL_TOPN),
        fetchBreakdown(auth, propertyId, range, 'pagePath', 'screenPageViews', DETAIL_TOPN),
        fetchBreakdown(auth, propertyId, range, 'sessionSource', 'sessions', DETAIL_TOPN, AI_DIMENSION_FILTER),
      ]);
      json(res, 200, { authenticated: true, channels, pages, aiEngines });
    } catch (err) {
      if (isReauthError(err)) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start', reason: 'reauth_required' });
        return;
      }
      json(res, 500, errorBody(err));
    }
    return;
  }
```

- [ ] **Step 8: 타입체크 + 전체 테스트**

Run: `npm run typecheck && npx vitest run`
Expected: 에러 없음, 모든 테스트 통과

- [ ] **Step 9: 빌드 산출물 스모크(엔드포인트 응답 확인)**

Run:
```bash
npm run build:server
node dist/server.mjs & sleep 2
curl -s -H "Host: localhost:4317" "http://localhost:4317/api/site-detail?propertyId=abc&period=28"
curl -s -H "Host: localhost:4317" "http://localhost:4317/api/site-detail?propertyId=123&period=28"
kill %1
```
Expected: 첫 호출은 `{"error":{"code":"bad_request",...}}`(또는 미인증 시 `{"authenticated":false,...}`), 둘째는 인증 상태면 `{"authenticated":true,"channels":[...],"pages":[...],"aiEngines":[...]}`, 미인증이면 `{"authenticated":false,...}`. 500이 아니면 통과.

- [ ] **Step 10: 커밋**

```bash
git add src/http-helpers.ts src/http-helpers.test.ts src/config.ts src/server.ts
git commit -m "feat(server): /api/site-detail lazy breakdown endpoint + propertyId guard"
```

---

## Task 4: 복사 텍스트 포맷터 (`buildCopyText` + `trendSparkText`)

**Files:**
- Modify: `public/format.js`
- Modify: `public/format.d.ts`
- Modify: `src/format.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/format.test.ts`

import 줄에 `buildCopyText, trendSparkText` 추가, 그리고 파일 끝에:

```ts
const LABELS = {
  period: 'Last 28 days',
  activeUsers: 'Active users',
  sessions: 'Sessions',
  keyEvents: 'Key events',
  aiSessions: 'AI referrals',
  search: 'Search',
  impressions: 'Impr',
  clicks: 'Clicks',
  position: 'Pos',
  topPage: 'Top page',
  topSource: 'Top channel',
  trend: 'Trend',
};
const cmd = (current: number, deltaPct: number | null) => ({ current, previous: 0, deltaPct });

describe('trendSparkText', () => {
  it('수열을 유니코드 블록으로 (낮음→높음)', () => {
    expect(trendSparkText([0, 100])).toBe('▁█');
    expect(trendSparkText([0, 50, 100])).toBe('▁▅█');
  });
  it('빈/누락 수열은 빈 문자열', () => {
    expect(trendSparkText([])).toBe('');
    expect(trendSparkText(null)).toBe('');
  });
});

describe('buildCopyText', () => {
  const s = {
    displayName: 'Soursea',
    activeUsers: cmd(1234, 5.2),
    sessions: cmd(2345, -1.1),
    keyEvents: cmd(120, 0),
    aiSessions: cmd(88, 12),
    trend: [0, 50, 100],
    topPage: '/pricing',
    topSource: 'Organic Search',
    search: { clicks: 210, impressions: 5000, position: 8.3 },
  };
  it('델타·검색 포함 라벨 블록 렌더', () => {
    const txt = buildCopyText(s, LABELS);
    expect(txt).toContain('[Soursea] (Last 28 days)');
    expect(txt).toContain('Active users: 1,234 (+5.2%)');
    expect(txt).toContain('Sessions: 2,345 (-1.1%)');
    expect(txt).toContain('AI referrals: 88 (+12%)');
    expect(txt).toContain('Search: Impr 5,000 / Clicks 210 / Pos 8.3');
    expect(txt).toContain('Top page: /pricing · Top channel: Organic Search');
    expect(txt).toContain('Trend: ▁▅█');
  });
  it('검색 데이터 없으면 검색 줄 생략', () => {
    expect(buildCopyText({ ...s, search: null }, LABELS)).not.toContain('Search:');
  });
  it('deltaPct가 null이면 괄호 생략', () => {
    expect(buildCopyText({ ...s, activeUsers: cmd(1234, null) }, LABELS)).toContain('Active users: 1,234\n');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/format.test.ts`
Expected: FAIL — `trendSparkText`/`buildCopyText` import 에러

- [ ] **Step 3: `public/format.js` 끝에 함수 추가**

```js
const SPARK_CHARS = "▁▂▃▄▅▆▇█";

/** Render a numeric series as a unicode block sparkline (text — pastes anywhere). */
export function trendSparkText(values) {
  if (!values || values.length === 0) return "";
  const max = Math.max(...values, 1);
  return values
    .map((v) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.round((v / max) * (SPARK_CHARS.length - 1)))])
    .join("");
}

/** Build a human-readable, localized metrics block for one site (clipboard copy).
 *  `labels` supplies every localized string (incl. labels.period already
 *  interpolated), so this stays DOM-free and unit-testable. Lines with no data
 *  (e.g. no Search Console) are omitted; a null deltaPct drops the "(±%)" suffix. */
export function buildCopyText(site, labels) {
  const delta = (m) =>
    m && typeof m.deltaPct === "number" ? ` (${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}%)` : "";
  const num = (m) => (m && typeof m.current === "number" ? m.current.toLocaleString("en-US") : "0");
  const lines = [
    `[${site.displayName}] (${labels.period})`,
    `${labels.activeUsers}: ${num(site.activeUsers)}${delta(site.activeUsers)}`,
    `${labels.sessions}: ${num(site.sessions)}${delta(site.sessions)}`,
    `${labels.keyEvents}: ${num(site.keyEvents)}${delta(site.keyEvents)}`,
    `${labels.aiSessions}: ${num(site.aiSessions)}${delta(site.aiSessions)}`,
  ];
  if (site.search) {
    lines.push(
      `${labels.search}: ${labels.impressions} ${site.search.impressions.toLocaleString("en-US")}` +
        ` / ${labels.clicks} ${site.search.clicks.toLocaleString("en-US")}` +
        ` / ${labels.position} ${site.search.position}`,
    );
  }
  lines.push(`${labels.topPage}: ${site.topPage ?? "—"} · ${labels.topSource}: ${site.topSource ?? "—"}`);
  lines.push(`${labels.trend}: ${trendSparkText(site.trend)}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: `public/format.d.ts`에 시그니처 추가**

```ts
export function trendSparkText(values: number[] | null | undefined): string;
export function buildCopyText(site: Record<string, any>, labels: Record<string, string>): string;
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/format.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add public/format.js public/format.d.ts src/format.test.ts
git commit -m "feat(format): buildCopyText + trendSparkText (clipboard metrics block)"
```

---

## Task 5: 트래픽 행 드로어 + 지연 분해 렌더 (`public/app.js` + CSS + detail.* 로케일)

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html` (`.repo-detail`이 정의된 스타일시트 — grep로 확인 후 인접 위치에 CSS 추가)
- Modify: `public/locales/{en,ko,ja,zh,es}.json`

> 이 Task는 DOM 통합이라 단위 테스트 대신 빌드 스모크 + 브라우저로 검증한다(Task 8). 비-DOM 로직은 Task 1·4에서 이미 테스트됨.

- [ ] **Step 1: state에 detail 캐시 추가** — `public/app.js:16`

```js
const state = { data: null, insights: null, onpage: null, github: null, filter: "", sortKey: "activeUsers", sortDir: "desc", siteDetail: {} };
```

- [ ] **Step 2: 드로어 헬퍼 추가** — `public/app.js`의 `render()` 함수 바로 위에 삽입

```js
function findSite(propertyId) {
  return (state.data?.sites ?? []).find((s) => s.propertyId === propertyId) || null;
}

// 드로어 한 칸(채널/페이지/AI엔진 톱N 막대). rows: [{name, value}].
function breakdownBlock(label, rows) {
  if (!rows || !rows.length) return "";
  const items = rows
    .map((x) => `<li>${escapeHtml(x.name)} <span class="muted">${fmtNum(x.value)}</span></li>`)
    .join("");
  return `<div class="bd-block"><b>${escapeHtml(label)}</b><ul>${items}</ul></div>`;
}

function detailLoading() {
  return `<div class="site-detail"><span class="muted">${t("detail.loading")}</span></div>`;
}
function detailError(propertyId) {
  return `<div class="site-detail"><span class="status error">${t("detail.error")}</span> ` +
    `<button class="link-btn" type="button" data-retry="${escapeHtml(propertyId)}">${t("detail.retry")}</button></div>`;
}

// 드로어 본문(분해). Task 6에서 전략 섹션, Task 7에서 "전체 복사"가 여기 추가됨.
function renderSiteDetailBody(site, detail) {
  return `<div class="site-detail">` +
    breakdownBlock(t("detail.channels"), detail.channels) +
    breakdownBlock(t("detail.pages"), detail.pages) +
    breakdownBlock(t("detail.aiEngines"), detail.aiEngines) +
    `</div>`;
}

async function fetchSiteDetailInto(propertyId, cell) {
  const key = `${propertyId}:${state.data.period}`;
  cell.innerHTML = detailLoading();
  try {
    const res = await fetch(`/api/site-detail?propertyId=${encodeURIComponent(propertyId)}&period=${state.data.period}`);
    const data = await res.json().catch(() => null);
    if (!data || data.error || data.authenticated === false) throw new Error("detail failed");
    state.siteDetail[key] = data;
    cell.innerHTML = renderSiteDetailBody(findSite(propertyId), data);
  } catch {
    cell.innerHTML = detailError(propertyId);
  }
}

// 행 펼치기/접기 + 최초 펼침 시 지연 로딩(캐시되면 즉시).
function expandSiteRow(row) {
  const detailRow = row.nextElementSibling;
  if (!detailRow || !detailRow.classList.contains("site-detail-row")) return;
  const willOpen = detailRow.hidden;
  detailRow.hidden = !willOpen;
  row.setAttribute("aria-expanded", String(willOpen));
  if (!willOpen) return;
  const propertyId = row.dataset.prop;
  const cell = detailRow.firstElementChild;
  const cached = state.siteDetail[`${propertyId}:${state.data.period}`];
  if (cached) cell.innerHTML = renderSiteDetailBody(findSite(propertyId), cached);
  else fetchSiteDetailInto(propertyId, cell);
}
```

- [ ] **Step 3: `render()` 행 템플릿 교체** — `public/app.js:178-195`의 `const rows = sites.map(...)` 블록을 아래로 교체

```js
  const rows = sites
    .map(
      (s) => `
      <tr class="site-row" data-prop="${escapeHtml(s.propertyId)}" tabindex="0" role="button" aria-expanded="false">
        <td class="name">${siteLink(s.displayName, gaUrl(s.propertyId))}</td>
        <td class="num">${fmtNum(s.activeUsers?.current)} ${fmtDelta(s.activeUsers?.deltaPct)}</td>
        <td class="num">${fmtNum(s.sessions?.current)} ${fmtDelta(s.sessions?.deltaPct)}</td>
        <td class="num">${fmtNum(s.keyEvents?.current)} ${fmtDelta(s.keyEvents?.deltaPct)}</td>
        <td class="num">${fmtNum(s.aiSessions?.current)} ${fmtDelta(s.aiSessions?.deltaPct)}</td>
        <td class="num">${fmtNum(s.search?.impressions)}</td>
        <td class="num">${fmtNum(s.search?.clicks)}</td>
        <td class="num">${fmtPos(s.search)}</td>
        <td class="top" title="${escapeHtml(s.topPage ?? "")}">${escapeHtml(s.topPage ?? "—")}</td>
        <td class="top">${escapeHtml(s.topSource ?? "—")}</td>
        <td class="spark-cell" title="${escapeHtml(trendTip(s.trend))}">${sparkline(s.trend, `${s.displayName} ${t("col.trend")}`)}</td>
      </tr>
      <tr class="site-detail-row" hidden><td colspan="11"></td></tr>`,
    )
    .join("");
```

- [ ] **Step 4: 클릭/키보드 핸들러 추가** — `public/app.js` 하단(이벤트 바인딩 영역, 예: `els.export.addEventListener` 근처)에 삽입

```js
// 트래픽 행 펼치기(Repos 패턴 미러). 링크/버튼 클릭은 펼침을 트리거하지 않음.
els.tbody.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("a")) return;
  const retry = e.target.closest && e.target.closest("[data-retry]");
  if (retry) {
    const propertyId = retry.getAttribute("data-retry");
    const detailRow = retry.closest(".site-detail-row");
    delete state.siteDetail[`${propertyId}:${state.data.period}`];
    if (detailRow) fetchSiteDetailInto(propertyId, detailRow.firstElementChild);
    return;
  }
  if (e.target.closest && e.target.closest("button")) return;
  const row = e.target.closest && e.target.closest(".site-row");
  if (row) expandSiteRow(row);
});
els.tbody.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("site-row")) {
    e.preventDefault();
    expandSiteRow(e.target);
  }
});
```

- [ ] **Step 5: `load()`에서 detail 캐시 초기화** — `public/app.js`의 `async function load()` 본문 시작부(`setStatus(t("status.loading"), "info");` 다음 줄)에 추가

```js
  state.siteDetail = {};
```

- [ ] **Step 6: CSS 추가** — `.repo-detail` 정의 위치를 찾아 인접 추가

먼저 `grep -n "\.repo-detail" public/index.html`(또는 해당 스타일시트)로 위치 확인 후, 같은 블록 근처에 추가:

```css
.site-detail { display: flex; flex-wrap: wrap; gap: 1.5rem; padding: 0.5rem 0.75rem; }
.bd-block { min-width: 12rem; }
.bd-block > b { display: block; margin-bottom: 0.25rem; font-size: 0.85em; opacity: 0.8; }
.bd-block ul { margin: 0; padding-left: 1rem; }
.bd-block li { font-variant-numeric: tabular-nums; }
.site-row { cursor: pointer; }
.link-btn { background: none; border: none; color: var(--link, #4ea1ff); cursor: pointer; padding: 0; text-decoration: underline; font: inherit; }
```

(`--link` 변수가 없으면 기존 링크 색 변수를 사용하거나 색을 직접 지정.)

- [ ] **Step 7: detail.* 로케일 키 추가** — 5개 파일 전부

en.json:
```json
  "detail.channels": "Channels",
  "detail.pages": "Top pages",
  "detail.aiEngines": "AI engines",
  "detail.loading": "Loading details…",
  "detail.error": "Couldn't load details.",
  "detail.retry": "Retry",
```
ko.json:
```json
  "detail.channels": "채널",
  "detail.pages": "인기 페이지",
  "detail.aiEngines": "AI 엔진",
  "detail.loading": "상세 불러오는 중…",
  "detail.error": "상세를 불러오지 못했습니다.",
  "detail.retry": "재시도",
```
ja.json:
```json
  "detail.channels": "チャネル",
  "detail.pages": "人気ページ",
  "detail.aiEngines": "AIエンジン",
  "detail.loading": "詳細を読み込み中…",
  "detail.error": "詳細を読み込めませんでした。",
  "detail.retry": "再試行",
```
zh.json:
```json
  "detail.channels": "渠道",
  "detail.pages": "热门页面",
  "detail.aiEngines": "AI 引擎",
  "detail.loading": "正在加载详情…",
  "detail.error": "无法加载详情。",
  "detail.retry": "重试",
```
es.json:
```json
  "detail.channels": "Canales",
  "detail.pages": "Páginas top",
  "detail.aiEngines": "Motores de IA",
  "detail.loading": "Cargando detalles…",
  "detail.error": "No se pudieron cargar los detalles.",
  "detail.retry": "Reintentar",
```

- [ ] **Step 8: 빌드 + 브라우저 확인**

Run: `npm run build:server && node dist/server.mjs`
브라우저에서 `http://localhost:4317` 열고: 트래픽 행 클릭 → 드로어 펼침 → 채널/페이지/AI엔진 톱5 표시. 다시 클릭 → 접힘. 콘솔 오류 없음. (인증 상태 필요 — 사용자 ~/.sitedeck 토큰 사용.)

- [ ] **Step 9: 커밋**

```bash
git add public/app.js public/index.html public/locales
git commit -m "feat(traffic): expandable site rows with lazy channel/page/AI breakdowns"
```

---

## Task 6: 드로어에 개선 전략 섹션 (`public/app.js` + strategy.* 로케일)

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html` (전략 심각도 점 CSS)
- Modify: `public/locales/{en,ko,ja,zh,es}.json`

- [ ] **Step 1: strategy 모듈 import** — `public/app.js:5`의 format import 다음 줄에 추가

```js
import { analyzeSite } from "/strategy.js";
```

- [ ] **Step 2: 전략 렌더 헬퍼 추가** — `renderSiteDetailBody` 위에 삽입

```js
// finding id('ai-share-low') → i18n 키('strategy.aiShareLow').
function strategyKey(id) {
  return "strategy." + id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function renderStrategy(site, detail) {
  const findings = analyzeSite(site, { channels: detail.channels });
  const items = findings
    .map(
      (f) => `<li class="sev-${f.severity}"><span class="sev-dot" aria-hidden="true"></span>` +
        `${escapeHtml(t(strategyKey(f.id), f.params))}</li>`,
    )
    .join("");
  return `<div class="bd-block strategy"><b>${escapeHtml(t("strategy.title"))}</b><ul>${items}</ul></div>`;
}
```

- [ ] **Step 3: `renderSiteDetailBody`에 전략 섹션 추가** — 닫는 `</div>` 앞에 `renderStrategy(site, detail)` 삽입

```js
function renderSiteDetailBody(site, detail) {
  return `<div class="site-detail">` +
    breakdownBlock(t("detail.channels"), detail.channels) +
    breakdownBlock(t("detail.pages"), detail.pages) +
    breakdownBlock(t("detail.aiEngines"), detail.aiEngines) +
    renderStrategy(site, detail) +
    `</div>`;
}
```

- [ ] **Step 4: 심각도 점 CSS 추가** — Task 5의 CSS 블록 근처

```css
.strategy { min-width: 18rem; }
.strategy ul { list-style: none; padding-left: 0; }
.strategy li { display: flex; align-items: baseline; gap: 0.4rem; margin-bottom: 0.2rem; }
.sev-dot { flex: none; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: #8a8f98; }
.sev-high .sev-dot { background: #e5484d; }
.sev-medium .sev-dot { background: #f5a623; }
.sev-low .sev-dot { background: #4ea1ff; }
.sev-good .sev-dot { background: #30a46c; }
```

- [ ] **Step 5: strategy.* 로케일 키 추가** — 5개 파일 전부

en.json:
```json
  "strategy.title": "Improvement strategy",
  "strategy.deltaDrop": "Active users dropped {pct}% vs. the previous period — check recent changes or ended campaigns",
  "strategy.trendDown": "Daily trend is declining — review content freshness and acquisition channels",
  "strategy.aiShareLow": "Low AI-referred share ({pct}%) — strengthen GEO with llms.txt and structured data",
  "strategy.ctrLow": "Low click-through vs. impressions ({pct}%) — improve titles and meta descriptions",
  "strategy.channelConcentrated": "Traffic concentrated in '{name}' ({pct}%) — diversify acquisition channels",
  "strategy.positionWeak": "Average search position {pos} — strengthen internal links and content",
  "strategy.conversionLow": "Few key events per session ({pct}%) — review CTAs and the conversion funnel",
  "strategy.allGood": "Core metrics look healthy — no warnings",
```
ko.json:
```json
  "strategy.title": "개선 전략",
  "strategy.deltaDrop": "활성 사용자가 전기 대비 {pct}% 급감 — 최근 변경·캠페인 종료 여부 점검",
  "strategy.trendDown": "일일 추세가 하락세 — 콘텐츠 신선도·유입 경로 점검",
  "strategy.aiShareLow": "AI 추천 비중이 낮음({pct}%) — llms.txt·구조화 데이터로 GEO 강화",
  "strategy.ctrLow": "검색 노출 대비 클릭률 낮음({pct}%) — 제목·메타 설명 개선",
  "strategy.channelConcentrated": "유입이 '{name}' 채널에 집중({pct}%) — 채널 다변화 검토",
  "strategy.positionWeak": "평균 검색 순위 {pos}위 — 내부 링크·콘텐츠 보강",
  "strategy.conversionLow": "세션 대비 핵심 이벤트 적음({pct}%) — CTA·전환 퍼널 점검",
  "strategy.allGood": "주요 지표 양호 — 별다른 경고 없음",
```
ja.json:
```json
  "strategy.title": "改善戦略",
  "strategy.deltaDrop": "アクティブユーザーが前期比{pct}%減 — 最近の変更やキャンペーン終了を確認",
  "strategy.trendDown": "日次トレンドが下降 — コンテンツの鮮度と流入経路を確認",
  "strategy.aiShareLow": "AI経由の割合が低い（{pct}%） — llms.txtと構造化データでGEOを強化",
  "strategy.ctrLow": "表示に対しクリック率が低い（{pct}%） — タイトルとメタ説明を改善",
  "strategy.channelConcentrated": "流入が「{name}」チャネルに集中（{pct}%） — チャネルの多様化を検討",
  "strategy.positionWeak": "平均検索順位{pos}位 — 内部リンクとコンテンツを強化",
  "strategy.conversionLow": "セッション当たりの主要イベントが少ない（{pct}%） — CTAと導線を点検",
  "strategy.allGood": "主要指標は良好 — 警告なし",
```
zh.json:
```json
  "strategy.title": "改进策略",
  "strategy.deltaDrop": "活跃用户环比下降{pct}% — 检查近期改动或已结束的活动",
  "strategy.trendDown": "每日趋势下降 — 检查内容新鲜度与流量来源",
  "strategy.aiShareLow": "AI 推荐占比偏低（{pct}%） — 用 llms.txt 和结构化数据加强 GEO",
  "strategy.ctrLow": "展示对应的点击率偏低（{pct}%） — 优化标题与元描述",
  "strategy.channelConcentrated": "流量集中于“{name}”渠道（{pct}%） — 考虑渠道多元化",
  "strategy.positionWeak": "平均搜索排名第{pos}位 — 加强内部链接与内容",
  "strategy.conversionLow": "每次会话的关键事件偏少（{pct}%） — 检查 CTA 与转化漏斗",
  "strategy.allGood": "核心指标良好 — 暂无警告",
```
es.json:
```json
  "strategy.title": "Estrategia de mejora",
  "strategy.deltaDrop": "Usuarios activos cayeron {pct}% frente al periodo anterior — revisa cambios o campañas finalizadas",
  "strategy.trendDown": "La tendencia diaria baja — revisa la frescura del contenido y los canales de adquisición",
  "strategy.aiShareLow": "Baja proporción de IA ({pct}%) — refuerza el GEO con llms.txt y datos estructurados",
  "strategy.ctrLow": "Baja tasa de clics frente a impresiones ({pct}%) — mejora títulos y metadescripciones",
  "strategy.channelConcentrated": "Tráfico concentrado en '{name}' ({pct}%) — diversifica los canales",
  "strategy.positionWeak": "Posición media de búsqueda {pos} — refuerza enlaces internos y contenido",
  "strategy.conversionLow": "Pocos eventos clave por sesión ({pct}%) — revisa CTAs y el embudo",
  "strategy.allGood": "Métricas principales saludables — sin avisos",
```

- [ ] **Step 6: 빌드 + 브라우저 확인**

Run: `npm run build:server && node dist/server.mjs`
행을 펼치면 분해 아래 "개선 전략" 섹션 + 심각도 점 + 처방 문구 표시. 콘솔 오류 없음.

- [ ] **Step 7: 커밋**

```bash
git add public/app.js public/index.html public/locales
git commit -m "feat(strategy): show per-site improvement strategy in the traffic drawer"
```

---

## Task 7: 텍스트 복사 버튼 (행 + 드로어 "전체 복사")

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html` (복사 버튼 CSS)
- Modify: `public/locales/{en,ko,ja,zh,es}.json`

- [ ] **Step 1: buildCopyText import 추가** — `public/app.js:5`의 format import에 합치기

```js
import { toCsv, matchesFilter, relTime, resolveTheme, cwvRating, cwvText, deltaClass, sortValue, geoScore, buildCopyText } from "/format.js";
```

- [ ] **Step 2: 복사 헬퍼 추가** — 드로어 헬퍼 근처에 삽입

```js
function copyBtn(propertyId) {
  return `<button class="copy-btn" type="button" data-copy="${escapeHtml(propertyId)}" ` +
    `title="${escapeHtml(t("copy.button"))}" aria-label="${escapeHtml(t("copy.button"))}">⧉</button>`;
}

// buildCopyText에 주입할 localized 라벨(기간은 미리 보간).
function copyLabels() {
  return {
    period: t("copy.period", { n: state.data.period }),
    activeUsers: t("col.activeUsers"),
    sessions: t("col.sessions"),
    keyEvents: t("col.keyEvents"),
    aiSessions: t("col.aiTraffic"),
    search: t("copy.search"),
    impressions: t("col.searchImpressions"),
    clicks: t("col.searchClicks"),
    position: t("col.searchPosition"),
    topPage: t("col.topPage"),
    topSource: t("col.topSource"),
    trend: t("col.trend"),
  };
}

function flashCopied(btn) {
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = "✓";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove("copied");
  }, 1200);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flashCopied(btn);
  } catch {
    setStatus(t("copy.failed"), "error");
  }
}

// 드로어 "전체 복사": 요약 블록 + 분해 + 전략.
function buildDetailCopyText(site, detail) {
  const block = (label, rows) =>
    rows && rows.length ? `\n${label}:\n` + rows.map((x) => `  ${x.name}: ${x.value}`).join("\n") : "";
  const findings = analyzeSite(site, { channels: detail.channels });
  const strategy = `\n${t("strategy.title")}:\n` + findings.map((f) => `  - ${t(strategyKey(f.id), f.params)}`).join("\n");
  return [
    buildCopyText(site, copyLabels()),
    block(t("detail.channels"), detail.channels),
    block(t("detail.pages"), detail.pages),
    block(t("detail.aiEngines"), detail.aiEngines),
    strategy,
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 3: 행 이름 셀에 복사 버튼 추가** — Task 5의 행 템플릿에서 name 셀 교체

```js
        <td class="name">${copyBtn(s.propertyId)}${siteLink(s.displayName, gaUrl(s.propertyId))}</td>
```

- [ ] **Step 4: 드로어 본문에 "전체 복사" 버튼 추가** — `renderSiteDetailBody`의 닫는 `</div>` 앞

```js
function renderSiteDetailBody(site, detail) {
  return `<div class="site-detail">` +
    breakdownBlock(t("detail.channels"), detail.channels) +
    breakdownBlock(t("detail.pages"), detail.pages) +
    breakdownBlock(t("detail.aiEngines"), detail.aiEngines) +
    renderStrategy(site, detail) +
    `<div class="bd-block"><button class="link-btn" type="button" data-copyall="${escapeHtml(site.propertyId)}">${escapeHtml(t("detail.copyAll"))}</button></div>` +
    `</div>`;
}
```

- [ ] **Step 5: 클릭 핸들러에 복사 분기 추가** — Task 5에서 만든 `els.tbody` click 리스너 상단(링크 체크 직후, retry 위)에 삽입

```js
  const copy = e.target.closest && e.target.closest("[data-copy]");
  if (copy) {
    e.stopPropagation();
    const site = findSite(copy.getAttribute("data-copy"));
    if (site) copyText(buildCopyText(site, copyLabels()), copy);
    return;
  }
  const copyAll = e.target.closest && e.target.closest("[data-copyall]");
  if (copyAll) {
    const propertyId = copyAll.getAttribute("data-copyall");
    const site = findSite(propertyId);
    const detail = state.siteDetail[`${propertyId}:${state.data.period}`];
    if (site && detail) copyText(buildDetailCopyText(site, detail), copyAll);
    return;
  }
```

- [ ] **Step 6: 복사 버튼 CSS 추가** — Task 5/6 CSS 근처

```css
.copy-btn { background: none; border: none; cursor: pointer; font-size: 0.9em; opacity: 0.5; padding: 0 0.3rem 0 0; color: inherit; }
.copy-btn:hover { opacity: 1; }
.copy-btn.copied { opacity: 1; color: #30a46c; }
```

- [ ] **Step 7: copy.* 로케일 키 추가** — 5개 파일 전부 (detail.copyAll 포함)

en.json:
```json
  "copy.button": "Copy metrics",
  "copy.period": "Last {n} days",
  "copy.search": "Search",
  "copy.failed": "Copy failed — check clipboard permissions.",
  "detail.copyAll": "Copy all",
```
ko.json:
```json
  "copy.button": "지표 복사",
  "copy.period": "최근 {n}일",
  "copy.search": "검색",
  "copy.failed": "복사 실패 — 클립보드 권한을 확인하세요.",
  "detail.copyAll": "전체 복사",
```
ja.json:
```json
  "copy.button": "指標をコピー",
  "copy.period": "直近{n}日",
  "copy.search": "検索",
  "copy.failed": "コピー失敗 — クリップボードの権限を確認してください。",
  "detail.copyAll": "すべてコピー",
```
zh.json:
```json
  "copy.button": "复制指标",
  "copy.period": "最近 {n} 天",
  "copy.search": "搜索",
  "copy.failed": "复制失败 — 请检查剪贴板权限。",
  "detail.copyAll": "复制全部",
```
es.json:
```json
  "copy.button": "Copiar métricas",
  "copy.period": "Últimos {n} días",
  "copy.search": "Búsqueda",
  "copy.failed": "Error al copiar — revisa los permisos del portapapeles.",
  "detail.copyAll": "Copiar todo",
```

- [ ] **Step 8: 빌드 + 브라우저 확인**

Run: `npm run build:server && node dist/server.mjs`
행의 복사 버튼 클릭 → ✓ 피드백, 클립보드에 라벨 블록. 드로어 "전체 복사" → 요약+분해+전략 텍스트. 콘솔 오류 없음.

- [ ] **Step 9: 커밋**

```bash
git add public/app.js public/index.html public/locales
git commit -m "feat(traffic): per-row + drawer copy-to-text for site metrics"
```

---

## Task 8: 통합 QA + 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 타입체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 2: 전체 테스트 스위트**

Run: `npx vitest run`
Expected: 모든 테스트 통과, 개수 증가(기존 155 + strategy 9 + ga 3 + isValidPropertyId + buildCopyText/trendSparkText). 새 파일: `src/strategy.test.ts`, `src/ga.test.ts`.

- [ ] **Step 3: 빌드 산출물 스모크(전 라우트)**

Run:
```bash
npm run build:server
node dist/server.mjs & sleep 2
for p in /api/summary?period=28 /api/onpage /api/insights /api/github "/api/site-detail?propertyId=999&period=28" /api/version; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: localhost:4317' "http://localhost:4317$p")"
done
kill %1
```
Expected: 모두 200(미인증이어도 `{authenticated:false}`를 200으로 반환). 어떤 라우트도 500이 아님.

- [ ] **Step 4: 브라우저 사용자 관점 QA(실데이터)**

`node dist/server.mjs` 실행 후 브라우저에서:
- 트래픽 행 클릭 → 채널/페이지/AI엔진 분해 + 개선 전략 표시
- 행 복사 버튼 → 클립보드에 라벨 블록(붙여넣어 확인)
- 드로어 "전체 복사" → 요약+분해+전략
- 정렬/필터 변경 후에도 드로어 정상, period 변경 시 재로딩
- 콘솔 오류 0 (DevTools Console 확인)

- [ ] **Step 5: 시크릿 스캔**

Run: `git grep -nE "github_pat_[A-Za-z0-9_]{20}|AIzaSy|GOCSPX" -- ':!docs' || echo "clean"`
Expected: `clean`(매치 0)

- [ ] **Step 6: git 상태 확인**

Run: `git status --short`
Expected: 커밋 안 된 변경 없음(클린)

---

## Self-Review 메모(작성자 확인 완료)

- **Spec 커버리지:** 전략 엔진(T1)·지연 엔드포인트(T2·T3)·복사 포맷(T4)·드로어 UI(T5)·전략 표시(T6)·복사 버튼(T7)·QA(T8) — spec 전 항목 매핑됨.
- **타입/이름 일관성:** `analyzeSite(summary, {channels})`·`Finding{id,severity,params}`·`BreakdownRow{name,value}`·`buildCopyText(site, labels)`·`strategyKey()`↔strategy.* 키·`state.siteDetail` 캐시 키 `${propertyId}:${period}` 전 Task 일치.
- **YAGNI:** LLM 전략, 행 위 배지, 임계값 설정 UI는 비목표로 제외.
- **브랜치:** 다중 커밋 기능이므로 feature 브랜치(`feat/traffic-detail-strategy`)에서 작업 후 마지막에 main 병합(finishing-a-development-branch).
