# 트래픽 상세 드로어 + 개선 전략 + 텍스트 복사 — 설계

**작성일:** 2026-06-29
**상태:** 승인됨 (구현 대기)

## 목표 (Goal)

트래픽 탭에서 사이트별로 더 깊은 데이터를 펼쳐 보고, 가진 지표만으로 $0 비용의 개선 전략(진단·처방)을 자동 도출하며, 각 사이트의 지표(활성 사용자~추세)를 한국어 라벨 블록 텍스트로 복사할 수 있게 한다.

## 아키텍처 (Architecture)

기존 **Repos 탭의 행-클릭 드로어 패턴**을 트래픽 탭에 재사용한다. 메인 요약(`/api/summary`)은 변경하지 않고, 행을 펼칠 때만 해당 사이트 하나에 대해 새 엔드포인트(`/api/site-detail`)를 지연 호출한다. 개선 전략은 외부 API 없이 순수 함수(`src/strategy.ts`)로 계산하며, 결과는 구조화된 finding(id·심각도·파라미터)으로 반환해 app.js가 i18n으로 렌더한다(5개국어 유지). 텍스트 복사 포맷 생성도 순수 함수(`public/format.js`의 `buildCopyText`)로 분리해 테스트 가능하게 한다.

## 기술 스택 (Tech Stack)

ESM TypeScript(tsx dev / esbuild bundle), vitest, GA4 Data API(`@google-analytics/data`), 바닐라 JS 프론트(`public/app.js` + `public/format.js`), i18n JSON(`public/locales/*.json` ×5).

---

## 컴포넌트 1: 개선 전략 엔진 — `src/strategy.ts`

순수 함수. 입력은 `SiteSummary`(요약 데이터)와 선택적 상세 분해 데이터. 출력은 심각도순으로 정렬된 finding 배열. `SiteSummary`는 `src/summary.ts`에서 import한다(독립 모듈 — 서버 부팅 없음). `MetricDelta.deltaPct`는 `number | null`이므로 `delta-drop` 규칙은 `typeof deltaPct === 'number'`로 가드한 뒤 비교한다.

### 인터페이스

```ts
export type Severity = 'high' | 'medium' | 'low' | 'good';

export interface Finding {
  id: string;                          // 안정 키, i18n 키 매핑용 (예: 'ai-share-low')
  severity: Severity;
  params: Record<string, string | number>; // i18n 보간용 (예: { pct: 1.2 })
}

// detail이 없으면 detail-tier 규칙은 건너뛴다.
export function analyzeSite(
  summary: SiteSummary,
  detail?: { channels: { name: string; value: number }[] },
): Finding[];
```

### 규칙 (기본 임계값 — `config.ts`의 상수 사용)

요약 데이터로 계산(즉시):
- `delta-drop` (high): `summary.activeUsers.deltaPct <= -25`
- `trend-down` (high): 추세 배열이 비어있지 않고, 마지막 값 < 첫 값 × 0.8 이며 합이 0보다 큼
- `ai-share-low` (medium): `sessions.current >= AI_SHARE_MIN_SESSIONS(=50)` 이고 `aiSessions.current / sessions.current < AI_SHARE_LOW(=0.02)`
- `ctr-low` (medium): `search`가 있고 `search.impressions >= CTR_MIN_IMPRESSIONS(=100)` 이고 `search.clicks / search.impressions < CTR_LOW(=0.02)`
- `position-weak` (low): `search`가 있고 `search.impressions >= CTR_MIN_IMPRESSIONS(=100)` 이고 `search.position > POSITION_WEAK(=10)`
- `conversion-low` (low): `sessions.current >= CONVERSION_MIN_SESSIONS(=50)` 이고 `keyEvents.current / sessions.current < CONVERSION_LOW(=0.01)`

상세 분해 데이터로 계산(드로어 열 때만, `detail`이 있을 때):
- `channel-concentrated` (medium): 톱 채널 세션 / 전체 채널 세션 합 > `CHANNEL_CONCENTRATION(=0.7)` (채널 합이 0보다 클 때)

종합:
- `all-good` (good): 위 규칙 중 어느 것도 발화하지 않으면 단일 양호 finding 반환

### 정렬

심각도 순서 `high > medium > low > good`, 동률이면 `id` 알파벳순(안정성). `all-good`은 다른 finding이 하나도 없을 때만 단독 존재.

### 임계값 상수 (`src/config.ts`에 추가)

```ts
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
} as const;
export const DETAIL_TOPN = 5;
```

---

## 컴포넌트 2: 지연 로딩 상세 엔드포인트 — `GET /api/site-detail`

쿼리: `propertyId`(숫자만 허용), `period`(`parsePeriod`). 인증/재인증/에러 봉투는 `/api/summary`와 동일 패턴(`isAuthenticated`, `isReauthError` → `{ authenticated:false, authUrl }`).

### `ga.ts`에 추가: `fetchBreakdown`

`fetchTopValue`(limit:1)를 topN으로 일반화. 선택적 `dimensionFilter` 지원.

```ts
export interface BreakdownRow { name: string; value: number; }

export async function fetchBreakdown(
  auth: OAuth2Client,
  propertyId: string,
  range: DateRange,
  dimension: string,
  metric: string,
  limit: number,
  dimensionFilter?: unknown,
): Promise<BreakdownRow[]>;
```

각 행 `{ name: dimensionValues[0].value, value: Number(metricValues[0].value) }`로 매핑하고 `(not set)`은 그대로 둔다(채널/페이지 이름 그대로 표기). 정렬은 `orderBys: [{ metric:{metricName}, desc:true }]`.

### 엔드포인트 동작

```ts
// GET /api/site-detail?propertyId=123&period=28
const detail = await Promise.all([
  fetchBreakdown(auth, id, range, 'sessionDefaultChannelGroup', 'sessions', DETAIL_TOPN),
  fetchBreakdown(auth, id, range, 'pagePath', 'screenPageViews', DETAIL_TOPN),
  fetchBreakdown(auth, id, range, 'sessionSource', 'sessions', DETAIL_TOPN, AI_DIMENSION_FILTER),
]);
// → json: { channels, pages, aiEngines }
```

`AI_DIMENSION_FILTER`는 `ga.ts`의 기존 AI orGroup 필터(`AI Assistant` 채널 + `AI_SOURCE_REGEX` 소스)를 재사용. `range`는 `comparisonRanges(period).current`.

---

## 컴포넌트 3: 프론트엔드 — 드로어 + 복사 (`public/app.js`)

### 드로어 (Repos 패턴 미러)

- 각 트래픽 행에 `tabindex="0" role="button" aria-expanded="false"` 부여, 뒤에 숨김 상세행 `<tr class="site-detail-row" hidden><td colspan=...></td></tr>` 추가.
- 클릭/Enter/Space로 토글(Repos의 `toggleRepoDetail` 동등 로직 재사용). `aria-expanded` 동기화.
- 펼칠 때 캐시 키 `${propertyId}:${period}` 미존재면 `fetch('/api/site-detail?...')` → `state.siteDetail[key]`에 저장. 로딩 중 "불러오는 중" 표시, 실패 시 에러 + 재시도 버튼.
- 드로어 내용: 채널/페이지/AI엔진 톱5 막대 리스트 + `analyzeSite(summary, {channels})` 전략 finding 리스트(심각도 색상 점) + "전체 복사" 버튼.
- `load()` 시작 시 `state.siteDetail = {}`로 캐시 초기화(period/데이터 갱신 시 무효화).

### 복사

- 각 행에 작은 복사 버튼(아이콘). 클릭 시 `buildCopyText(site, labels)`로 한국어 라벨 블록 생성 → `navigator.clipboard.writeText` → "복사됨" 피드백(짧은 토스트/버튼 텍스트 변경). 실패 시 안내 메시지.
- 드로어 "전체 복사"는 요약 블록 + 분해(채널/페이지/AI엔진) + 전략 텍스트를 이어붙여 복사.

### `public/format.js`에 추가 (순수 함수, 라벨 주입)

```js
// labels: { title, period, activeUsers, sessions, keyEvents, aiSessions,
//           search, impressions, clicks, position, topPage, topSource, trend } (모두 localized)
export function buildCopyText(site, period, labels) { /* 라벨 블록 문자열 반환 */ }
export function trendSparkText(values) { /* ▁▂▃▄▅▆▇█ 유니코드 스파크라인 */ }
```

`format.d.ts`에 시그니처 추가. `format.test.ts`에 고정 라벨로 단위 테스트(블록 형식, 추세 ▁▇ 매핑, 빈 추세 처리).

라벨 블록 예시:
```
[Soursea] (최근 28일)
활성 사용자: 1,234 (+5.2%)
세션: 2,345 (−1.1%)
핵심 이벤트: 120 (+0%)
AI 추천 세션: 88 (+12%)
검색: 노출 5,000 / 클릭 210 / 평균순위 8.3
톱 페이지: /pricing · 톱 채널: Organic Search
추세(28일): ▁▂▃▅▆▇
```

검색 데이터가 없으면(`search == null`) 검색 줄은 생략. delta가 없으면 괄호 생략.

---

## i18n (`public/locales/*.json` ×5)

추가 키 그룹(en/ko/ja/zh/es 전부):
- `strategy.*`: 각 finding id별 제목 + 심각도 라벨 (`strategy.deltaDrop`, `strategy.trendDown`, `strategy.aiShareLow`, `strategy.ctrLow`, `strategy.channelConcentrated`, `strategy.positionWeak`, `strategy.conversionLow`, `strategy.allGood`, `strategy.title`, `strategy.sev.high/medium/low/good`)
- `detail.*`: 드로어 라벨 (`detail.channels`, `detail.pages`, `detail.aiEngines`, `detail.loading`, `detail.error`, `detail.retry`, `detail.copyAll`)
- `copy.*`: 복사 라벨 (`copy.button`, `copy.done`, `copy.failed`) + `buildCopyText`에 주입할 라벨들(기존 `col.*` 재사용 가능한 것은 재사용)

## 에러 처리 (Error Handling)

- `/api/site-detail`: 인증 만료 → `{authenticated:false}`; 그 외 예외 → 에러 봉투. 드로어가 에러 표시 + 재시도.
- 클립보드 실패: "복사 실패" 안내(권한/비보안 컨텍스트 대비).
- `analyzeSite`: 순수, 예외 없음. 데이터 누락은 규칙 조건에서 가드.

## 테스트 (Testing)

- `src/strategy.test.ts`: 규칙별 발화/비발화, 임계값 경계, 심각도 정렬, `all-good` 단독, `channel-concentrated`는 detail 유무 분기.
- `public/format.test.ts`: `buildCopyText` 블록 형식(검색 유무, delta 유무), `trendSparkText` 유니코드 매핑·빈 배열.
- `src/server.test.ts` 또는 http-helpers 패턴: `/api/site-detail` propertyId 숫자 검증·period 파싱(가능한 범위에서).
- 기존 155개 테스트 회귀 없음.

## 비목표 (Non-goals / YAGNI)

- LLM 생성 전략(비용·비밀키) — 제외.
- 전략 임계값 사용자 설정 UI — 제외(상수로 충분, 추후).
- 행 위 심각도 배지 — v1 제외(전략은 드로어 안에서만).
- 새 GA 지표(이탈률·체류시간 등) 추가 — 제외(현 지표로 충분).
