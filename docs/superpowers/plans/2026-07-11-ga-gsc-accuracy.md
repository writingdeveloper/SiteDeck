# GA/GSC 데이터 정확도 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SiteDeck의 GA4·Search Console 수치를 소스 UI와 정의·경계까지 일치시키고, 샘플링·임계 처리를 정직하게 표시한다.

**Architecture:** GA4 Data API 조회를 상대 날짜 키워드(`"yesterday"`/`"NdaysAgo"`)로 전환해 GA가 속성 타임존으로 해석하게 하고, 일별 리포트는 `keepEmptyRows:true`로 GA가 0일까지 채우게 한다. Search Console API는 상대 키워드를 못 받으므로 절대 날짜(`comparisonRanges`)를 유지한다. 순수 함수 위주로 변경해 vitest로 검증한다.

**Tech Stack:** ESM TypeScript, `@google-analytics/data` runReport, Search Console REST, vitest, 바닐라 JS 프론트(`public/`), i18n JSON ×5.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-11-ga-gsc-accuracy-design.md`.
- `noUncheckedIndexedAccess` 활성 — Record/배열 인덱싱은 옵셔널 체이닝 또는 non-null 단정 필요(테스트 파일도 타입체크됨).
- 신규 런타임 의존성 추가 금지.
- i18n 키는 5개 로케일(en·ko·ja·es·zh) 모두에 일관 추가 — 누락 시 파리티 깨짐.
- 커밋 트레일러(모든 커밋 메시지 끝):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LLuTzFzb7JybkfcbYhDvdX
  ```
- 브랜치: `feat/ga-gsc-accuracy` (이미 생성됨).
- 검증 명령: `npm test`(vitest), `npm run typecheck`(tsc --noEmit).

---

### Task 1: GA 상대 날짜 범위 — `src/periods.ts`

**Files:**
- Modify: `src/periods.ts` (추가; `comparisonRanges`·`enumerateDays`는 유지)
- Test: `src/periods.test.ts`

**Interfaces:**
- Produces: `gaRanges(period: Period): ComparisonRanges`, `gaHistoryRange(days: number): DateRange` — 값이 GA 상대 키워드 문자열.

- [ ] **Step 1: 실패 테스트 작성** — `src/periods.test.ts` 상단 import에 `gaRanges, gaHistoryRange` 추가 후 append:

```ts
import { gaRanges, gaHistoryRange } from './periods';

describe('gaRanges (GA4 상대 날짜)', () => {
  it('current = NdaysAgo..yesterday, previous = 직전 N일', () => {
    expect(gaRanges(7)).toEqual({
      current: { startDate: '7daysAgo', endDate: 'yesterday' },
      previous: { startDate: '14daysAgo', endDate: '8daysAgo' },
    });
    expect(gaRanges(28)).toEqual({
      current: { startDate: '28daysAgo', endDate: 'yesterday' },
      previous: { startDate: '56daysAgo', endDate: '29daysAgo' },
    });
  });
});

describe('gaHistoryRange', () => {
  it('최근 N일, 어제까지', () => {
    expect(gaHistoryRange(90)).toEqual({ startDate: '90daysAgo', endDate: 'yesterday' });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/periods.test.ts` → FAIL (`gaRanges is not a function`).

- [ ] **Step 3: 구현** — `src/periods.ts` 끝에 추가:

```ts
/** GA4 Data API 전용 상대 날짜 범위 — GA가 속성 타임존으로 해석한다. */
export function gaRanges(period: Period): ComparisonRanges {
  return {
    current: { startDate: `${period}daysAgo`, endDate: 'yesterday' },
    previous: { startDate: `${period * 2}daysAgo`, endDate: `${period + 1}daysAgo` },
  };
}

/** GA4 일별 히스토리 백필용 상대 범위(어제까지 최근 `days`일). */
export function gaHistoryRange(days: number): DateRange {
  return { startDate: `${days}daysAgo`, endDate: 'yesterday' };
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/periods.test.ts` → PASS. 기존 `comparisonRanges`/`enumerateDays` 테스트도 그대로 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/periods.ts src/periods.test.ts
git commit -m "feat(periods): GA4 상대 날짜 범위(gaRanges/gaHistoryRange)로 타임존 정합"
```

---

### Task 2: GA 일별 조회 — `keepEmptyRows` + `mapDailyMetricsRows` 시그니처 — `src/ga.ts`

**Files:**
- Modify: `src/ga.ts` (`mapDailyMetricsRows` 시그니처에서 `days` 제거, `fetchDailyMetrics`에 `keepEmptyRows`)
- Test: `src/ga.test.ts` (기존 `mapDailyMetricsRows` 테스트 갱신)

**Interfaces:**
- Consumes: 없음(이 태스크 내 자기완결).
- Produces: `mapDailyMetricsRows(base, ai): DailyMetricsRow[]` — 날짜를 리포트 행에서 도출(0일 포함은 `keepEmptyRows`가 보장).

- [ ] **Step 1: 실패 테스트로 갱신** — `src/ga.test.ts`의 `describe('mapDailyMetricsRows', …)` 블록 전체를 아래로 교체:

```ts
describe('mapDailyMetricsRows', () => {
  const base = [
    { dimensionValues: [{ value: '20260101' }], metricValues: [{ value: '10' }, { value: '20' }, { value: '2' }] },
    { dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '5' }, { value: '9' }, { value: '1' }] },
    // keepEmptyRows:true 이므로 0인 날도 리포트에 포함되어 들어온다.
    { dimensionValues: [{ value: '20260103' }], metricValues: [{ value: '0' }, { value: '0' }, { value: '0' }] },
  ];
  const ai = [{ dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '3' }] }];

  it('base+AI를 날짜별 병합(날짜는 리포트에서 도출)하고 YYYY-MM-DD로 변환', () => {
    expect(mapDailyMetricsRows(base, ai)).toEqual([
      { date: '2026-01-01', metrics: { activeUsers: 10, sessions: 20, keyEvents: 2, aiSessions: 0 } },
      { date: '2026-01-02', metrics: { activeUsers: 5, sessions: 9, keyEvents: 1, aiSessions: 3 } },
      { date: '2026-01-03', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
  });

  it('두 리포트가 비면 빈 배열', () => {
    expect(mapDailyMetricsRows(null, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/ga.test.ts` → FAIL (기존 3-인자 시그니처와 불일치).

- [ ] **Step 3: 구현** — `src/ga.ts`의 `mapDailyMetricsRows`를 교체(시그니처에서 `days` 제거):

```ts
/** Merge a base report (date + [activeUsers,sessions,keyEvents]) and an AI report
 *  (date + [sessions]) by date. keepEmptyRows guarantees 0-traffic days are present,
 *  so the date set comes from the reports themselves. Pure — split for unit testing. */
export function mapDailyMetricsRows(base: Row[] | null | undefined, ai: Row[] | null | undefined): DailyMetricsRow[] {
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
  const days = [...new Set([...b.keys(), ...aiMap.keys()])].sort();
  return days.map((ymd) => {
    const bv = b.get(ymd) ?? { a: 0, s: 0, k: 0 };
    return {
      date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      metrics: { activeUsers: bv.a, sessions: bv.s, keyEvents: bv.k, aiSessions: aiMap.get(ymd) ?? 0 },
    };
  });
}
```

그리고 `fetchDailyMetrics`에서 두 `runReport`에 `keepEmptyRows: true`를 추가하고 마지막 반환을 `mapDailyMetricsRows(base.rows, aiRep.rows)`로 변경(끝의 `, enumerateDays(range)` 인자 제거):

```ts
export async function fetchDailyMetrics(auth: OAuth2Client, propertyId: string, range: DateRange): Promise<DailyMetricsRow[]> {
  const client = data(auth);
  const [[base], [aiRep]] = await Promise.all([
    client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'keyEvents' }],
      keepEmptyRows: true,
    }),
    client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: AI_DIMENSION_FILTER as never,
      keepEmptyRows: true,
    }),
  ]);
  return mapDailyMetricsRows(base.rows, aiRep.rows);
}
```

(주의: `enumerateDays` import는 `fetchDailySeries`가 계속 사용하므로 제거하지 않는다.)

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/ga.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/ga.ts src/ga.test.ts
git commit -m "feat(ga): keepEmptyRows로 일별 0채움을 GA에 위임, mapDailyMetricsRows 날짜 자체 도출"
```

---

### Task 3: 상위값·브레이크다운 정확도 — `(other)` 제외 + 결정적 정렬 — `src/ga.ts`

**Files:**
- Modify: `src/ga.ts` (`pickTopValue` 신설, `fetchTopValue`·`mapBreakdownRows`·`fetchBreakdown`)
- Test: `src/ga.test.ts`

**Interfaces:**
- Produces: `pickTopValue(rows): string | null` — `(other)`/`(not set)`가 아닌 첫 차원값.

- [ ] **Step 1: 실패 테스트 추가** — `src/ga.test.ts` import에 `pickTopValue` 추가 후 append:

```ts
import { pickTopValue } from './ga';

describe('pickTopValue', () => {
  it('(other)/(not set)를 건너뛰고 첫 유효 값을 고른다', () => {
    expect(pickTopValue([
      { dimensionValues: [{ value: '(other)' }], metricValues: [{ value: '999' }] },
      { dimensionValues: [{ value: '/home' }], metricValues: [{ value: '120' }] },
    ])).toBe('/home');
  });
  it('전부 (other)/(not set)면 null', () => {
    expect(pickTopValue([{ dimensionValues: [{ value: '(not set)' }] }, { dimensionValues: [{ value: '(other)' }] }])).toBe(null);
    expect(pickTopValue([])).toBe(null);
    expect(pickTopValue(null)).toBe(null);
  });
});

describe('mapBreakdownRows — (other) 제외', () => {
  it('(other) 집계행을 버린다', () => {
    expect(mapBreakdownRows([
      { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '120' }] },
      { dimensionValues: [{ value: '(other)' }], metricValues: [{ value: '80' }] },
    ])).toEqual([{ name: 'Organic Search', value: 120 }]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/ga.test.ts` → FAIL (`pickTopValue` 없음, `(other)` 미제외).

- [ ] **Step 3: 구현** — `src/ga.ts`:

`mapBreakdownRows`를 `(other)` 필터 추가로 교체:

```ts
export function mapBreakdownRows(
  rows:
    | { dimensionValues?: ({ value?: string | null } | undefined)[] | null; metricValues?: ({ value?: string | null } | undefined)[] | null }[]
    | null
    | undefined,
): BreakdownRow[] {
  return (rows ?? [])
    .filter((r) => r.dimensionValues?.[0]?.value !== '(other)')
    .map((r) => ({
      name: r.dimensionValues?.[0]?.value ?? '(not set)',
      value: Number(r.metricValues?.[0]?.value ?? 0),
    }));
}
```

`fetchTopValue` 위에 순수 헬퍼 추가:

```ts
const OMIT_TOP_VALUES = new Set(['(not set)', '(other)']);
/** First dimension value that isn't GA's (not set)/(other) aggregate. Pure — unit-tested. */
export function pickTopValue(
  rows: { dimensionValues?: ({ value?: string | null } | undefined)[] | null }[] | null | undefined,
): string | null {
  for (const r of rows ?? []) {
    const v = r.dimensionValues?.[0]?.value;
    if (v && !OMIT_TOP_VALUES.has(v)) return v;
  }
  return null;
}
```

`fetchTopValue` 본문을 `limit: 5` + 2차 정렬 + `pickTopValue`로 교체:

```ts
export async function fetchTopValue(
  auth: OAuth2Client,
  propertyId: string,
  range: DateRange,
  dimension: string,
  metric: string,
): Promise<string | null> {
  const [report] = await data(auth).runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    dimensions: [{ name: dimension }],
    metrics: [{ name: metric }],
    orderBys: [{ metric: { metricName: metric }, desc: true }, { dimension: { dimensionName: dimension } }],
    limit: 5,
  });
  return pickTopValue(report.rows);
}
```

`fetchBreakdown`의 `orderBys`에도 2차 차원 정렬 추가:

```ts
    orderBys: [{ metric: { metricName: metric }, desc: true }, { dimension: { dimensionName: dimension } }],
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/ga.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/ga.ts src/ga.test.ts
git commit -m "fix(ga): 상위값/브레이크다운에서 (other) 제외 + 동점 결정적 정렬"
```

---

### Task 4: GA 데이터 품질 경고 — `mapDataQuality` + `fetchRange` 확장 — `src/ga.ts`, `src/summary.ts`

**Files:**
- Modify: `src/ga.ts` (`DataQuality`, `mapDataQuality`, `RangeMetrics`+`fetchRange`)
- Modify: `src/summary.ts` (`SiteSummary.dataQuality`)
- Test: `src/ga.test.ts`

**Interfaces:**
- Produces: `interface DataQuality { sampled: boolean; thresholded: boolean; otherRow: boolean }`, `mapDataQuality(metadata: unknown): DataQuality`, `RangeMetrics.dataQuality: DataQuality`.
- Consumes(다음 태스크): `SiteSummary.dataQuality: DataQuality | null`.

- [ ] **Step 1: 실패 테스트 추가** — `src/ga.test.ts` import에 `mapDataQuality` 추가 후 append:

```ts
import { mapDataQuality } from './ga';

describe('mapDataQuality', () => {
  it('샘플링·임계·기타행 손실 플래그', () => {
    expect(mapDataQuality({ samplingMetadatas: [{}], subjectToThresholding: true, dataLossFromOtherRow: true }))
      .toEqual({ sampled: true, thresholded: true, otherRow: true });
  });
  it('없거나 빈 metadata는 전부 false', () => {
    expect(mapDataQuality(undefined)).toEqual({ sampled: false, thresholded: false, otherRow: false });
    expect(mapDataQuality({ samplingMetadatas: [] })).toEqual({ sampled: false, thresholded: false, otherRow: false });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/ga.test.ts` → FAIL.

- [ ] **Step 3: 구현** — `src/ga.ts`:

`RangeMetrics` 인터페이스와 새 타입/매퍼 추가(파일 상단 `RangeMetrics` 정의 옆):

```ts
export interface DataQuality {
  sampled: boolean;
  thresholded: boolean;
  otherRow: boolean;
}
export interface RangeMetrics {
  activeUsers: number;
  sessions: number;
  keyEvents: number;
  dataQuality: DataQuality;
}
/** GA4 runReport metadata → data-quality flags. Pure — unit-tested. */
export function mapDataQuality(metadata: unknown): DataQuality {
  const m = (metadata ?? {}) as { samplingMetadatas?: unknown[]; subjectToThresholding?: boolean; dataLossFromOtherRow?: boolean };
  return {
    sampled: Array.isArray(m.samplingMetadatas) && m.samplingMetadatas.length > 0,
    thresholded: m.subjectToThresholding === true,
    otherRow: m.dataLossFromOtherRow === true,
  };
}
```

`fetchRange` 반환에 `dataQuality` 추가:

```ts
  const row = report.rows?.[0];
  return {
    activeUsers: Number(row?.metricValues?.[0]?.value ?? 0),
    sessions: Number(row?.metricValues?.[1]?.value ?? 0),
    keyEvents: Number(row?.metricValues?.[2]?.value ?? 0),
    dataQuality: mapDataQuality(report.metadata),
  };
```

`src/summary.ts`: 상단에 타입 import 추가(런타임 사이클 방지 위해 `import type`), `SiteSummary`에 필드 추가:

```ts
import type { DataQuality } from './ga';
```
```ts
  /** GA가 이 사이트 수치를 샘플링/임계 처리했는지(없으면 null). */
  dataQuality: DataQuality | null;
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/ga.test.ts` → PASS. `npm run typecheck` → 0 오류(다음 태스크에서 server.ts가 `dataQuality`를 채우기 전까지 summary 객체 리터럴이 있는 곳은 Task 7에서 채운다 — 이 태스크에서 typecheck가 빨간 경우 Task 7과 함께 커밋).

  > 주: `SiteSummary`에 필수 필드를 추가하므로 `server.ts`의 summary 리터럴이 typecheck 실패할 수 있다. 실패 시 Step 5 커밋은 Task 7 완료 후 함께 수행하고, 여기서는 vitest PASS만 확인한다.

- [ ] **Step 5: 커밋**(typecheck 통과 시)

```bash
git add src/ga.ts src/summary.ts src/ga.test.ts
git commit -m "feat(ga): runReport metadata → 데이터 품질 플래그(sampled/thresholded/otherRow)"
```

---

### Task 5: GSC 속성 매칭 — 스킴/경로 인식 — `src/gsc.ts`

**Files:**
- Modify: `src/gsc.ts` (`parseSite` 신설, `matchSites` 재구현; `normalizeHost` 유지)
- Test: `src/gsc.test.ts`

**Interfaces:**
- Produces: `parseSite(input): { raw; kind:'domain'|'prefix'; host; scheme?; path? } | null`, `matchSites` 동일 시그니처.

- [ ] **Step 1: 실패 테스트 추가** — `src/gsc.test.ts`의 `describe('matchSites', …)` 안에 append(기존 케이스는 유지):

```ts
  it('GA 스트림과 스킴이 일치하는 속성을 레거시 http보다 우선 (A1)', () => {
    const m = matchSites([{ propertyId: '1', url: 'https://x.com' }], ['http://x.com/', 'https://x.com/']);
    expect(m.get('1')).toBe('https://x.com/');
  });
  it('하위경로 전용 속성을 전체 사이트 GA 속성에 붙이지 않는다 (A5)', () => {
    expect(matchSites([{ propertyId: '1', url: 'https://x.com' }], ['https://x.com/shop/']).size).toBe(0);
  });
  it('루트 url-prefix를 하위경로보다 우선 (A5)', () => {
    const m = matchSites([{ propertyId: '1', url: 'https://x.com' }], ['https://x.com/shop/', 'https://x.com/']);
    expect(m.get('1')).toBe('https://x.com/');
  });
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/gsc.test.ts` → FAIL (A1: 현재는 알파벳순으로 `http://` 선택).

- [ ] **Step 3: 구현** — `src/gsc.ts`의 `matchSites`를 아래로 교체하고 그 위에 `parseSite`를 추가(`normalizeHost`는 그대로 둠):

```ts
export interface ParsedSite {
  raw: string;
  kind: 'domain' | 'prefix';
  host: string;      // 정규화(소문자, 선행 www 제거)
  scheme?: string;   // prefix 전용 (예: 'https')
  path?: string;     // prefix 전용 (예: '/', '/shop/')
}

/** GSC/GA 사이트 식별자를 스킴·호스트·경로로 파싱. sc-domain:은 도메인, 그 외는 URL. */
export function parseSite(input: string): ParsedSite | null {
  const raw = input.trim();
  if (/^sc-domain:/i.test(raw)) {
    const host = normalizeHost(raw);
    return host ? { raw, kind: 'domain', host } : null;
  }
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host ? { raw, kind: 'prefix', host, scheme: u.protocol.replace(/:$/, ''), path: u.pathname || '/' } : null;
  } catch {
    return null;
  }
}

export function matchSites(
  siteUrls: { propertyId: string; url: string }[],
  gscSites: string[],
): Map<string, string> {
  const parsed = gscSites.map(parseSite).filter((s): s is ParsedSite => s !== null);
  const out = new Map<string, string>();
  for (const { propertyId, url } of siteUrls) {
    const ga = parseSite(url);
    if (!ga || ga.kind !== 'prefix') continue; // GA 스트림 URL은 절대 URL
    const gaPath = ga.path ?? '/';
    const candidates = parsed.filter((c) => {
      if (c.kind === 'domain') return c.host === ga.host || ga.host.endsWith(`.${c.host}`);
      return c.host === ga.host && gaPath.startsWith(c.path ?? '/'); // 경로 포함(A5)
    });
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const hostSpec = b.host.length - a.host.length;            // 더 구체적인 호스트 우선
      if (hostSpec !== 0) return hostSpec;
      const sa = a.kind === 'prefix' && a.scheme === ga.scheme ? 0 : 1; // 스킴 일치 우선(A1)
      const sb = b.kind === 'prefix' && b.scheme === ga.scheme ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;         // 결정적 폴백
    });
    out.set(propertyId, (candidates[0] as ParsedSite).raw);
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/gsc.test.ts` → PASS (신규 3건 + 기존 matchSites 11건 전부 그린).

- [ ] **Step 5: 커밋**

```bash
git add src/gsc.ts src/gsc.test.ts
git commit -m "fix(gsc): 스킴/경로 인식 매칭 — http/https 충돌·하위경로 오귀속 제거"
```

---

### Task 6: 채널집중도 분모 — 세션총계 — `public/strategy.js`

**Files:**
- Modify: `public/strategy.js` (`channel-concentrated` 판정)
- Test: `src/strategy.test.ts`

**Interfaces:**
- Consumes: `analyzeSite(summary, detail)` — `summary.sessions.current`를 분모로.

- [ ] **Step 1: 실패 테스트로 갱신** — `src/strategy.test.ts`의 `it('채널 집중은 detail 있을 때만 → channel-concentrated', …)`를 아래 두 개로 교체:

```ts
  it('상위 채널이 세션총계의 70% 초과면 channel-concentrated (분모=세션총계)', () => {
    // site()의 sessions.current = 2000; 1500/2000 = 75% > 70%
    const detail = { channels: [{ name: 'Organic', value: 1500 }, { name: 'Direct', value: 200 }] };
    expect(analyzeSite(site(), detail).some((x) => x.id === 'channel-concentrated')).toBe(true);
    expect(analyzeSite(site()).some((x) => x.id === 'channel-concentrated')).toBe(false);
  });

  it('top-5 합 기준이면 오발화했을 케이스가 세션총계 기준이면 미발화', () => {
    // 상위 채널 300은 top-5 합(360)의 83%지만 세션총계 2000 대비 15% → 미발화
    const detail = { channels: [{ name: 'Organic', value: 300 }, { name: 'Direct', value: 60 }] };
    expect(analyzeSite(site(), detail).some((x) => x.id === 'channel-concentrated')).toBe(false);
  });
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/strategy.test.ts` → FAIL (현재는 top-5 합 분모라 300/360=83% 오발화).

- [ ] **Step 3: 구현** — `public/strategy.js`의 채널집중 블록(현재 `const total = detail.channels.reduce(...)` 부분)을 교체:

```js
  // Medium: one channel dominates traffic. Denominator = true session total
  // (summary.sessions.current), NOT the truncated top-N breakdown sum, so a long
  // tail beyond the top 5 doesn't inflate the share into a false positive.
  if (detail && detail.channels && detail.channels.length > 0 && sessions && sessions.current > 0) {
    const top = detail.channels[0];
    const share = top ? top.value / sessions.current : 0;
    if (share > STRATEGY.CHANNEL_CONCENTRATION) {
      out.push({
        id: "channel-concentrated",
        severity: "medium",
        params: { name: top.name, pct: round1(share * 100) },
      });
    }
  }
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/strategy.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add public/strategy.js src/strategy.test.ts
git commit -m "fix(strategy): 채널집중도 분모를 세션총계로 — top-5 절단 오발화 제거"
```

---

### Task 7: 서버 배선 — `gaRanges`/`gaHistoryRange`/`dataQuality`, GSC는 절대 날짜 — `src/server.ts`

**Files:**
- Modify: `src/server.ts` (`buildSummary`, `/api/site-detail`)
- Test: 기존 전체 스위트(회귀) + typecheck

**Interfaces:**
- Consumes: `gaRanges`, `gaHistoryRange`(Task 1), `RangeMetrics.dataQuality`(Task 4), `comparisonRanges`(GSC용).

- [ ] **Step 1: import 갱신** — `src/server.ts` 상단 import에 `gaRanges, gaHistoryRange` 추가(`comparisonRanges`는 유지):

```ts
import { comparisonRanges, gaRanges, gaHistoryRange } from './periods';
```
그리고 config import에서 `GA_HISTORY_FETCH_DAYS`가 이미 있으므로 그대로 사용.

- [ ] **Step 2: `buildSummary` 범위 교체** — 현재:
```ts
  const ranges = comparisonRanges(period);
```
를:
```ts
  const ranges = gaRanges(period);              // GA: 상대 날짜(속성 타임존)
  const gscRange = comparisonRanges(period).current; // GSC: 절대 날짜
```
로 바꾸고, 히스토리 범위:
```ts
  const historyRange = comparisonRanges(GA_HISTORY_FETCH_DAYS as Period).current;
```
를:
```ts
  const historyRange = gaHistoryRange(GA_HISTORY_FETCH_DAYS);
```
로 교체.

- [ ] **Step 3: GSC 호출과 dataQuality 배선** — 팬아웃 안의 `fetchSearchMetrics(auth, gscSiteUrl, ranges.current)`를 `fetchSearchMetrics(auth, gscSiteUrl, gscRange)`로 바꾸고, `summary` 리터럴에 `dataQuality` 추가:

```ts
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
          dataQuality: cur.dataQuality,
        };
```

- [ ] **Step 4: `/api/site-detail` 범위 교체** — 현재:
```ts
      const range = comparisonRanges(parsePeriod(url.searchParams.get('period'))).current;
```
를:
```ts
      const range = gaRanges(parsePeriod(url.searchParams.get('period'))).current;
```
(site-detail의 breakdown은 전부 GA Data API라 상대 날짜로 전환.)

- [ ] **Step 5: 회귀 + 타입체크 + 커밋**

Run: `npm run typecheck` → 0 오류. Run: `npm test` → 전체 그린(기존 스위트 + Task 1~6 신규).

```bash
git add src/server.ts
git commit -m "feat(server): GA는 상대 날짜, GSC는 절대 날짜로 배선 + dataQuality 전달"
```

(Task 4 커밋을 typecheck 때문에 보류했다면 여기서 `src/ga.ts src/summary.ts src/ga.test.ts`를 함께 add하여 커밋.)

---

### Task 8: UI — 데이터 품질 배지 · 정의 툴팁 · GSC 잠정 라벨 — `public/`

**Files:**
- Modify: `public/app.js` (`dqBadge` 헬퍼 + 이름 셀 삽입)
- Modify: `public/index.html` (`activeUsers` 헤더에 `data-i18n-title` 추가)
- Modify: `public/style.css` (`.dq-badge`)
- Modify: `public/locales/{en,ko,ja,es,zh}.json` (신규/수정 키)
- Test: 수동 브라우저 QA(이 계층은 단위테스트 없음) + `npm test` 회귀 + `npm run typecheck`

**Interfaces:**
- Consumes: `SiteSummary.dataQuality`(Task 4/7).

- [ ] **Step 1: i18n 키 추가/수정** — 5개 로케일 각각에 아래 키를 추가하고, 기존 `tip.aiTraffic`·`tip.searchImpressions`·`tip.searchClicks`·`tip.searchPosition`를 정의/잠정 문구로 교체. 값(en·ko 정확, ja·es·zh 동등 번역):

| key | en | ko | ja | es | zh |
|---|---|---|---|---|---|
| `tip.activeUsers` | `GA4 active users. May differ from GA's totalUsers in some reports.` | `GA4 활성 사용자. 일부 리포트의 totalUsers와 다를 수 있습니다.` | `GA4 のアクティブ ユーザー。一部レポートの totalUsers とは異なる場合があります。` | `Usuarios activos de GA4. Puede diferir de totalUsers en algunos informes.` | `GA4 活跃用户。在某些报告中可能与 totalUsers 不同。` |
| `tip.aiTraffic` | `AI answer-engine referred sessions (ChatGPT, Perplexity, Gemini, …). A floor — referrer-stripped visits are not counted.` | `AI 답변엔진 유입 세션(ChatGPT·Perplexity·Gemini 등). 리퍼러가 제거된 방문은 빠진 하한값입니다.` | `AI 回答エンジン経由のセッション（ChatGPT・Perplexity・Gemini など）。リファラーが除去された訪問は含まない下限値です。` | `Sesiones referidas por motores de IA (ChatGPT, Perplexity, Gemini…). Un mínimo: no cuenta visitas sin referente.` | `AI 回答引擎引流的会话（ChatGPT、Perplexity、Gemini 等）。为下限值，不含被移除来源的访问。` |
| `tip.searchImpressions` | `Search Console impressions. Recent ~3 days are provisional.` | `Search Console 노출수. 최근 약 3일은 잠정치입니다.` | `Search Console の表示回数。直近約 3 日は暫定値です。` | `Impresiones de Search Console. Los últimos ~3 días son provisionales.` | `Search Console 展示次数。最近约 3 天为临时数据。` |
| `tip.searchClicks` | `Search Console clicks. Recent ~3 days are provisional.` | `Search Console 클릭수. 최근 약 3일은 잠정치입니다.` | `Search Console のクリック数。直近約 3 日は暫定値です。` | `Clics de Search Console. Los últimos ~3 días son provisionales.` | `Search Console 点击次数。最近约 3 天为临时数据。` |
| `tip.searchPosition` | `Average Search Console position. Recent ~3 days are provisional.` | `Search Console 평균 게재순위. 최근 약 3일은 잠정치입니다.` | `Search Console の平均掲載順位。直近約 3 日は暫定値です。` | `Posición media en Search Console. Los últimos ~3 días son provisionales.` | `Search Console 平均排名。最近约 3 天为临时数据。` |
| `quality.sampled` | `Sampled` | `표본` | `サンプリング` | `Muestreado` | `抽样` |
| `quality.thresholded` | `Thresholded` | `임계 처리` | `しきい値処理` | `Con umbral` | `阈值处理` |
| `quality.otherRow` | `Long tail folded into (other)` | `일부가 (기타)로 합산됨` | `一部が(その他)に集約` | `Cola larga en (otros)` | `部分并入(其他)` |
| `quality.badgeLabel` | `Data quality` | `데이터 품질` | `データ品質` | `Calidad de datos` | `数据质量` |

  (기존에 `tip.aiTraffic` 등이 이미 있으므로 **덮어쓰기**. 없던 `tip.activeUsers`·`quality.*`는 신규 추가. 5개 파일 키 개수가 동일하게 유지되는지 확인.)

- [ ] **Step 2: `index.html` 헤더 툴팁** — `activeUsers` 헤더(현재 line 44)에 `data-i18n-title="tip.activeUsers"` 추가:

```html
              <th class="sortable num" data-sort="activeUsers" scope="col" tabindex="0" aria-sort="none" data-i18n-title="tip.activeUsers" data-i18n="col.activeUsers">Active users</th>
```
(`aiTraffic`·`searchImpressions`·`searchClicks`·`searchPosition` 헤더는 이미 `data-i18n-title`을 가지므로 Step 1의 문구 변경만으로 반영됨.)

- [ ] **Step 3: `app.js` 데이터 품질 배지** — `fmtPos` 근처(파일 상단 헬퍼 영역)에 추가:

```js
// Small warning badge when GA sampled/thresholded/(other)-folded this site's numbers.
function dqBadge(dq) {
  if (!dq) return "";
  const flags = [];
  if (dq.sampled) flags.push(t("quality.sampled"));
  if (dq.thresholded) flags.push(t("quality.thresholded"));
  if (dq.otherRow) flags.push(t("quality.otherRow"));
  if (flags.length === 0) return "";
  const text = flags.join(" · ");
  return ` <span class="dq-badge" title="${escapeHtml(text)}" aria-label="${escapeHtml(t("quality.badgeLabel") + ": " + text)}">⚠</span>`;
}
```
그리고 이름 셀(현재 line 343)에 삽입:

```js
        <td class="name">${copyBtn(s.propertyId)}${siteLink(s.displayName, gaUrl(s.propertyId))}${dqBadge(s.dataQuality)}</td>
```

- [ ] **Step 4: `style.css` 배지 스타일** — 파일 끝에 추가:

```css
.dq-badge { cursor: help; opacity: 0.7; font-size: 0.85em; }
.dq-badge:hover { opacity: 1; }
```

- [ ] **Step 5: 회귀 + 타입체크 + 수동 QA**

Run: `npm run typecheck` → 0 오류. Run: `npm test` → 전체 그린.

수동 QA(`npm start` 후 브라우저):
- 활성 사용자/AI/검색 헤더에 마우스오버 → 정의·잠정 문구 툴팁 표시.
- (샘플링/임계가 실제로 걸린 사이트가 없으면 배지는 안 뜨는 게 정상 — 콘솔에서 `state.data.sites`의 `dataQuality`가 채워지는지 확인.)
- 오전/오후 각각 새로고침 → 최신일이 GA UI "어제"와 일치, 상위 페이지에 `(other)` 미표시.
- 콘솔 오류 0.

- [ ] **Step 6: 커밋**

```bash
git add public/app.js public/index.html public/style.css public/locales/
git commit -m "feat(ui): 데이터 품질 배지 + 활성사용자/AI/검색 정의·잠정 툴팁"
```

---

## Self-Review 메모 (작성자 확인)

- **스펙 커버리지**: 타임존(T1·T2·T7) · A3/A6 (T3) · 데이터품질(T4·T8) · A1/A5 (T5) · A2 (T6) · A4 잠정라벨(T8) · 숫자정의(T8). 스펙의 모든 컴포넌트가 태스크에 매핑됨.
- **타입 일관성**: `DataQuality`는 `ga.ts`에서 정의, `summary.ts`는 `import type`으로 참조(런타임 사이클 없음). `RangeMetrics.dataQuality` → `cur.dataQuality`(server) → `SiteSummary.dataQuality`(summary) → `s.dataQuality`(app.js) 일관.
- **비목표(백로그)**: `totalUsers` 병기, A7(llms.txt), A8(PSI 데스크톱), GSC 완전 타임존 정합.
- **주의**: Task 4는 `SiteSummary` 필수 필드 추가로 인해 Task 7 전까지 `typecheck`가 빨갈 수 있어, 두 태스크 커밋을 함께 하거나 순서대로 즉시 진행한다(계획에 명시됨).
