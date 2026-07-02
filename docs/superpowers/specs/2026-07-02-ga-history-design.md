# GA 일별 히스토리 저장 + 활용 — 설계

**작성일:** 2026-07-02
**상태:** 승인됨 (구현 대기)

## 목표 (Goal)

GA4 일별 지표(활성 사용자·세션·핵심 이벤트·AI 세션)를 로컬에 누적 저장해, 선택 기간(최대 90일)을 넘는 장기 추세·주간 대비(WoW)·추세 기반 전략을 제공한다. PSI(`insights.json`)·GitHub(`github.json`)은 이미 히스토리를 저장하는데 GA만 매번 실시간 조회하던 구조적 공백을 해소한다.

## 아키텍처 (Architecture)

`/api/summary` 실행 시 속성별 90일 일별 시리즈를 가져와 `~/.sitedeck/ga-history.json`에 upsert(조회 시점 백필). 별도 스케줄러 없이 앱 사용 중 히스토리가 누적되고, 보존 365일까지 자란다. 90일 이내 파생값(WoW=14일, 연속 하락=~28일, 드로어 12주=84일)은 첫 조회부터 즉시 제공되고, 90일 초과 장기 추세는 시간이 지나며 축적된다. 히스토리 파생값(주간 시리즈·WoW·연속 하락)은 모두 스토어에서 계산하는 순수 함수로 분리해 테스트한다. 요약 응답에는 사이트별 compact digest(WoW·연속 하락 주수)를 실어, 전략 규칙과 버크 복사가 드로어 없이도 동작한다. 드로어 상세(`/api/site-detail`)에는 차트용 주간 시리즈를 싣는다.

## 기술 스택 (Tech Stack)

ESM TypeScript(GA4 Data API), vitest, `store-io`(원자적 JSON 스토어), 바닐라 JS 프론트, `public/strategy.js`(브라우저 전략 엔진), i18n JSON ×5.

---

## 컴포넌트 1: 스토어 — `src/ga-store.ts` (github-store 패턴)

`~/.sitedeck/ga-history.json`. `store-io`의 `loadJsonStore`/`saveJsonStore` 재사용.

```ts
export interface DayMetrics { activeUsers: number; sessions: number; keyEvents: number; aiSessions: number; }
export interface GaHistory {
  version: number;
  byProperty: Record<string, { days: Record<string, DayMetrics> }>; // days 키 = 'YYYY-MM-DD'
}
export interface HistoryDigest {
  wow: { activeUsers: number | null; sessions: number | null; keyEvents: number | null; aiSessions: number | null };
  declineWeeks: number; // activeUsers 기준 최근 연속 하락 주수
}
```

순수 함수(전부 테스트):
- `emptyGaHistory(): GaHistory`
- `upsertDailyMetrics(store, propertyId, series: {date:string, metrics:DayMetrics}[], retentionDays): GaHistory` — 날짜별 병합(최신값 우선), 최신 `retentionDays` 캘린더일만 유지(github-store `upsertDays`의 정렬·slice 방식).
- `weeklySeries(store, propertyId, metric, weeks): number[]` — 최신 저장일에서 끝나는 `weeks*7` 연속 캘린더일을 7일 버킷 합으로 집계(오래된→최신, 누락일 0). github-store `calendarDays`/`isoMinusDays` 방식 재사용.
- `wow(store, propertyId, metric): { current: number; previous: number; deltaPct: number | null }` — 최신 7일 vs 직전 7일 합. `deltaPct`는 previous 0이면 null(`summary.ts`의 deltaPct 의미 재사용).
- `consecutiveDeclineWeeks(store, propertyId, metric): number` — 최대 12주 주간 시리즈에서, 최신 주부터 직전 주보다 낮은 주를 연속 카운트. 주 2개 미만이거나 비교 구간 합이 0이면 0.
- `historyDigest(store, propertyId): HistoryDigest | null` — 해당 속성 days가 없으면 null.
- `loadGaHistory(path)` / `saveGaHistory(path, store)` — `store-io` 위임, isValid = `Boolean(p.byProperty)`.

## 컴포넌트 2: GA 일별 조회 — `src/ga.ts`

```ts
export interface DailyMetricsRow { date: string; metrics: DayMetrics; } // date = 'YYYY-MM-DD'
export function mapDailyMetricsRows(
  base: Array<{ dimensionValues?; metricValues? }> | null | undefined, // date + [activeUsers,sessions,keyEvents]
  ai: Array<{ dimensionValues?; metricValues? }> | null | undefined,   // date + [sessions] (AI-filtered)
  days: string[],  // enumerateDays(range) → YYYYMMDD
): DailyMetricsRow[]
export async function fetchDailyMetrics(auth, propertyId, range: DateRange): Promise<DailyMetricsRow[]>
```

`fetchDailyMetrics`: runReport 2회 —
1. `dimensions:[date]`, `metrics:[activeUsers, sessions, keyEvents]`
2. `dimensions:[date]`, `metrics:[sessions]`, `dimensionFilter: AI_DIMENSION_FILTER` → aiSessions
`mapDailyMetricsRows`(순수, 테스트)가 두 리포트를 날짜별로 합쳐 `enumerateDays(range)` 전체를 0-채움하고 `YYYYMMDD`→`YYYY-MM-DD` 변환.

`fetchDailySeries`(기존 활성 전용)는 `buildSummary`에서 더는 쓰지 않으면 유지하되 미사용(제거는 하지 않음 — 타 호출 없음 확인 시 제거 가능). 추세 스파크라인은 `fetchDailyMetrics` 결과의 activeUsers를 현재 기간 길이만큼 잘라 사용.

## 컴포넌트 3: `buildSummary` 백필 + digest 부착 — `src/server.ts`, `src/summary.ts`

- `summary.ts`: `SiteSummary`에 `history: HistoryDigest | null` 추가.
- `buildSummary`: 시작 시 `let history = await loadGaHistory(GA_HISTORY_STORE_PATH)`. 팬아웃에서 각 속성은 `fetchDailySeries` 대신 `fetchDailyMetrics(auth, id, historyRange)` 호출(historyRange = `comparisonRanges`와 별도로 최근 `GA_HISTORY_FETCH_DAYS`일, 어제까지). 각 속성 결과에 `series`(DailyMetricsRow[])를 포함해 반환. 팬아웃 후 순차로 `history = upsertDailyMetrics(history, id, series, GA_HISTORY_RETENTION_DAYS)` → `saveGaHistory` 1회 → 각 SiteSummary에 `historyDigest(history, id)` 부착. 추세 = series의 activeUsers 마지막 `period`일.
- 동시성 레이스 방지: upsert는 팬아웃 밖에서 순차 실행(공유 store 객체 동시 변형 금지).

## 컴포넌트 4: 드로어 히스토리 — `/api/site-detail` + `public/app.js`

- `/api/site-detail`: 기존 채널/페이지/AI엔진에 더해 `const gh = await loadGaHistory(...)` 후 `history: { weekly: { activeUsers:number[], sessions:number[], keyEvents:number[], aiSessions:number[] }, wow: {…} }` 반환(각 `weeklySeries(gh, id, metric, GA_HISTORY_WEEKS)` + `wow`). days 없으면 `history: null`.
- `renderSiteDetailBody`: 분해·전략 아래 **히스토리 섹션** 추가 — 4개 지표 각각 **주간 스파크라인(`trendSparkText`)** + **WoW %**(`fmtDelta` 스타일). `detail.history`가 null이면 섹션 생략.

## 컴포넌트 5: 추세 전략 규칙 — `public/strategy.js`

- `STRATEGY.DECLINE_WEEKS = 3` 추가.
- `analyzeSite`에 `trend-decline`(medium): `summary.history && summary.history.declineWeeks >= STRATEGY.DECLINE_WEEKS` → `{ id:'trend-decline', severity:'medium', params:{ weeks: summary.history.declineWeeks } }`. 요약 digest 사용 → 드로어·버크 복사 양쪽 발화.
- i18n `strategy.trendDecline`(파라미터 `{weeks}`).

## 컴포넌트 6: 버크 복사 히스토리 — `public/app.js`

`trafficMarkdown`에 표 뒤 **`## 주간 대비 (WoW)` 섹션** 추가: history 있는 사이트만 `- {name}: 활성 {au}% · 세션 {sess}% · AI {ai}%`(deltaPct null은 `—`). i18n `copy.wowHeading`.

## 컴포넌트 7: 설정 상수 — `src/config.ts`

```ts
export const GA_HISTORY_STORE_PATH = path.join(CONFIG_DIR, 'ga-history.json');
export const GA_HISTORY_RETENTION_DAYS = 365;
export const GA_HISTORY_FETCH_DAYS = 90;
export const GA_HISTORY_WEEKS = 12;
```
(`STRATEGY.DECLINE_WEEKS`는 브라우저 로드라 `strategy.js`에 둔다.)

## 에러 처리 (Error Handling)

- 스토어 없음/손상: `store-io`가 빈 스토어로 복구(.bak). 첫 실행 시 digest/history null → 관련 UI·규칙·복사 라인 생략(graceful).
- `fetchDailyMetrics` 실패: 해당 속성은 기존 per-property try/catch에 잡혀 summary 오류로 처리(다른 속성 영향 없음). 히스토리 upsert 건너뜀.
- 순수 파생 함수: days 누락·짧은 시리즈·0 분모 전부 가드.

## 테스트 (Testing)

- `src/ga-store.test.ts`: `upsertDailyMetrics`(병합·retention trim), `weeklySeries`(7일 버킷·0채움·짧은 이력), `wow`(deltaPct·0 분모), `consecutiveDeclineWeeks`(연속 하락 카운트·2주 미만·0 볼륨 가드), `historyDigest`(빈 속성 null).
- `src/ga.test.ts`: `mapDailyMetricsRows`(두 리포트 병합·0채움·YYYYMMDD→YYYY-MM-DD).
- `src/strategy.test.ts`: `trend-decline`(3주 이상 발화, 미만/무이력 미발화).
- 브라우저 실데이터 QA: 드로어 히스토리 섹션(주간 스파크라인+WoW), 전략에 연속 하락(해당 시), 버크 복사 WoW 섹션, 콘솔 오류 0. 재조회 시 ga-history.json 생성·누적 확인.
- 기존 180 테스트 회귀 없음.

## 비목표 (Non-goals / YAGNI)

- 일일 스케줄러(백필로 충분) — 제외.
- 메인 표에 WoW 컬럼 상시 표시 — 제외(드로어·복사로 충분).
- 커스텀 기간·연도 대비(YoY) — 제외.
- 90일 초과를 강제로 즉시 채우는 장기 백필 — 제외(자연 누적).
