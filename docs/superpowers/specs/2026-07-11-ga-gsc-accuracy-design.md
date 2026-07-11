# GA/GSC 데이터 정확도 — 설계 (Spec 1)

**작성일:** 2026-07-11
**상태:** 검토 대기 (작성됨)
**시리즈:** 4개 스펙 중 1/4 (정확도 → 하드닝 → MCP → UX)

## 목표 (Goal)

SiteDeck이 보여주는 수치가 GA4·Search Console UI와 **정의·경계까지 일치**하도록 만든다. 감사에서 확인된 정확도 결함을 제거하고(타임존 경계, GSC 속성 오매칭, `(other)`/동점 비결정성, 채널집중도 분모 오류), GA가 데이터를 샘플링·임계 처리했을 때 이를 **정직하게 표시**한다. 파이프라인 자체는 이미 GA API를 왜곡 없이 전달함을 실측 확인했으므로(라이브 조회 = 저장 이력), 이 스펙은 "경계·매칭·표기"의 정확도에 집중한다.

## 배경 (실측 근거)

- 날짜 범위를 순수 UTC로 계산(`periods.ts:18-19`) → GA4 Data API는 **속성 타임존**으로 해석하므로, 하루 중 특정 시간대(UTC 자정~속성 자정 사이)에 최신 완결일이 하루 밀리거나 미완결 당일을 포함 → GA UI 대비 불일치.
- `matchSites`가 스킴을 제거해 매칭(`gsc.ts:19`) → `http://`/`https://` GSC 속성이 충돌, 보통 비어있는 `http://`를 선택 → Search Console 수치가 실제와 무관하게 0에 가깝게 표시.
- `fetchTopValue`가 GA4 `(other)` 집계행을 "상위 페이지/소스"로 노출 가능(`ga.ts:129-130`), 동점 시 2차 정렬 부재로 새로고침마다 값 변동(`ga.ts:126-128`).
- 채널집중도 분모가 top-5 합(`strategy.js:62`) → 실제 세션총계보다 작아 "channel-concentrated" 오발화.

## 아키텍처 (Architecture)

**핵심 결정: GA는 상대 날짜, GSC는 절대 날짜.**
GA4 Data API는 `"yesterday"`·`"NdaysAgo"` 상대 키워드를 **속성 타임존**으로 해석하므로, GA 조회 전부를 상대 키워드로 전환해 타임존 버그 클래스를 제거한다. 일별 리포트는 `keepEmptyRows: true`로 0인 날까지 GA가 채워주므로, 응답의 `date` 차원(속성 타임존 절대일)을 그대로 저장 키로 쓴다 — 로컬 `enumerateDays` 0-채움과 UTC 계산이 불필요해진다. 반면 Search Console API(`searchanalytics.query`)는 상대 키워드를 받지 못하므로 **절대 날짜를 유지**한다(GSC는 자체 타임존·확정 지연을 가지며, 검색 지표는 보조값이라 속성 타임존 정합보다 "확정성"을 우선). 따라서 `comparisonRanges`(절대)는 GSC 전용으로 남기고, GA용 `gaRanges`(상대)를 신설한다.

`ga-store.ts`의 WoW·주간·연속하락 로직은 **저장된 날짜 라벨** 기준 순수 문자열 연산이라 타임존 전환의 영향을 받지 않는다(무변경). 저장 키가 UTC파생→속성타임존파생으로 바뀌며 전환 시점에 일부 속성에서 하루짜리 라벨 불연속이 생길 수 있으나, upsert 누적으로 자연 치유되고 retention이 정리한다(허용).

## 기술 스택 (Tech Stack)

ESM TypeScript(GA4 Data API `runReport`, Search Console `searchanalytics.query`), vitest, 바닐라 JS 프론트(`public/strategy.js`, `public/app.js`), i18n JSON ×5. 신규 의존성 없음.

---

## 컴포넌트 1: GA 상대 날짜 범위 — `src/periods.ts`, `src/ga.ts`, `src/server.ts`

**`periods.ts`** — 신설:
```ts
// GA4 Data API 전용. 속성 타임존으로 GA가 해석하는 상대 키워드.
export function gaRanges(period: Period): ComparisonRanges {
  return {
    current:  { startDate: `${period}daysAgo`,       endDate: 'yesterday' },
    previous: { startDate: `${period * 2}daysAgo`,   endDate: `${period + 1}daysAgo` },
  };
}
export function gaHistoryRange(days: number): DateRange {
  return { startDate: `${days}daysAgo`, endDate: 'yesterday' };
}
```
- `DateRange` 타입은 그대로(`{startDate, endDate}`), 값이 절대일→상대 키워드로 바뀔 뿐이라 GA fetch 함수들은 그대로 통과(이미 startDate/endDate를 그대로 전달).
- `comparisonRanges`(절대)·`enumerateDays`는 **유지**(전자는 GSC용, 후자는 테스트·잠재적 재사용). GA 일별 경로에서 `enumerateDays` 사용만 제거.

**`ga.ts`** — 일별 리포트에 `keepEmptyRows: true` 추가, `mapDailyMetricsRows` 시그니처 변경:
```ts
// days 파라미터 제거. keepEmptyRows로 GA가 모든 날짜를 반환하므로 base 행에서 날짜를 도출.
export function mapDailyMetricsRows(
  base: Row[] | null | undefined,   // date + [activeUsers, sessions, keyEvents], 0일 포함
  ai:   Row[] | null | undefined,   // date + [sessions] (AI 필터)
): DailyMetricsRow[]
```
- base 행의 `date` 차원을 오름차순 정렬 → 그 순서로 시리즈 구성, AI는 날짜별 병합, `YYYYMMDD`→`YYYY-MM-DD` 변환.
- `fetchDailyMetrics(auth, propertyId, range)`: 두 `runReport` 모두 `keepEmptyRows: true`. `range`는 `gaHistoryRange(GA_HISTORY_FETCH_DAYS)`.
- `fetchRange`(집계, date 차원 없음)는 `keepEmptyRows` 불필요(0이면 행 없음 → 기존 `?? 0` 유지).

**`server.ts`** — `buildSummary`:
- `const ranges = gaRanges(period)`, `const historyRange = gaHistoryRange(GA_HISTORY_FETCH_DAYS)`로 교체.
- GSC만 절대 날짜 사용: `const gscRange = comparisonRanges(period).current`를 별도로 계산해 `fetchSearchMetrics(auth, gscSiteUrl, gscRange)`에 전달(컴포넌트 4 참조).
- `/api/site-detail`도 `gaRanges(period).current`로 breakdown 조회.

## 컴포넌트 2: 상위값·브레이크다운 정확도 — `src/ga.ts`

- **A3 `(other)` 제외** — `fetchTopValue`: `limit: 1`→`limit: 5`, 응답에서 `(other)`·`(not set)`이 아닌 **첫 값** 선택(전부 해당되면 null). `mapBreakdownRows`: `(other)` 행 제거(채널/페이지 노이즈).
- **A6 결정적 정렬** — `fetchTopValue`·`fetchBreakdown`의 `orderBys`에 2차 정렬 추가: `[{ metric: {metricName}, desc: true }, { dimension: {dimensionName: dimension} }]`. 동점 시 차원명 오름차순으로 고정.

## 컴포넌트 3: 채널집중도 분모 — `public/strategy.js`

- **A2** — `channel-concentrated` 판정의 분모를 top-5 합이 아니라 **진짜 세션총계**로:
```js
// 현재: const total = detail.channels.reduce((a, c) => a + c.value, 0);
// 변경: 상위 채널 / summary.sessions.current
const topShare = sessions?.current ? top.value / sessions.current : 0;
if (topShare > STRATEGY.CHANNEL_CONCENTRATION) { … params: { pct: round1(topShare * 100) } }
```
- `analyzeSite`는 이미 `summary.sessions`를 받으므로 추가 인자 불필요. 표시 %도 실제 비중으로 정정.
- 테스트(`strategy.test.ts`)의 `channel-concentrated` 케이스를 세션총계 기준으로 갱신.

## 컴포넌트 4: GSC 속성 매칭·확정성 — `src/gsc.ts`, UI

- **A1 스킴 인식 매칭** — URL-prefix 후보 동점 시 GA 스트림 URL의 스킴과 일치하는 후보를 우선(알파벳 폴백 이전). `sc-domain:` 속성은 스킴 무관하게 호스트로 매칭.
- **A5 경로 인식** — URL-prefix 속성의 경로를 제거하지 말고 유지: 하위경로 속성(`https://x.com/blog/`)은 해당 경로에만 매칭하고, 루트/전체호스트 속성을 하위경로 속성보다 우선.
- **A4 확정성 라벨** — `fetchSearchMetrics`는 `dataState: 'all'` 유지(최근일 0 방지)하되, 최근 ~3일이 잠정임을 UI에 표기: Search Console 지표 라벨/툴팁에 "최근 N일(일부 잠정 포함)" i18n 문자열(`search.provisionalNote`). 창을 앞당기지 않음(GA 기간과 어긋나 혼란 유발 방지).
- `matchSites` 재설계는 순수 함수 유지 → `gsc.test.ts`에 스킴/경로 케이스 추가.

## 컴포넌트 5: GA 데이터 품질 경고 — `src/ga.ts`, `src/summary.ts`, `src/server.ts`, `public/app.js`

GA `runReport` 응답의 `metadata`를 지금은 무시. 유용한 플래그를 포집해 사이트별로 노출:
```ts
export interface DataQuality { sampled: boolean; thresholded: boolean; otherRow: boolean; }
```
- `ga.ts`: **현재 기간 `fetchRange` 리포트**(헤드라인 수치의 출처)의 `report.metadata`에서 `samplingMetadatas`(존재/비어있지 않음→`sampled`), `subjectToThresholding`→`thresholded`, `dataLossFromOtherRow`→`otherRow`를 추출하는 순수 매퍼 `mapDataQuality(metadata)`. `fetchRange`는 `RangeMetrics`에 더해 이 metadata를 반환하도록 확장(또는 `dataQuality`를 함께 반환).
- `summary.ts`: `SiteSummary`에 `dataQuality: DataQuality | null` 추가.
- `server.ts`: 값 전달(플래그 없으면 null).
- `app.js`: 셋 중 하나라도 true면 사이트 행에 작은 경고 배지(예: "표본"/"임계"/"기타행") + 툴팁. i18n `quality.sampled`·`quality.thresholded`·`quality.otherRow`.

## 컴포넌트 6: 숫자 정의 명확화 — `public/app.js`, `public/index.html`, i18n

- **활성 사용자** — 컬럼/라벨이 GA `activeUsers`임을 명시(툴팁: "GA4 활성 사용자. 리포트에 따라 GA의 totalUsers와 다를 수 있음"). `totalUsers` 병기는 이번 스펙 비목표(백로그).
- **AI 세션** — 값이 **하한값(floor)**이며 정의(채널그룹 "AI Assistant" 또는 소스 목록)임을 툴팁/정보 아이콘으로 노출. 재조정 가능하도록 소스 목록을 문구에 포함.
- i18n `def.activeUsers`·`def.aiSessions`(파라미터 없는 설명 문자열) ×5 로케일.

## 에러 처리 (Error Handling)

- 상대 키워드 전환은 GA 요청 형식만 바뀌므로 기존 per-property try/catch(`server.ts`) 그대로 적용 — 한 속성 실패가 요약 전체를 막지 않음.
- `metadata` 부재/필드 누락: `mapDataQuality`가 전부 false 또는 null 반환(가드).
- GSC 매칭 실패/스코프 없음: 기존처럼 `search: null`로 폴백(무변경).
- 저장 키 라벨 전환 불연속: graceful(누적 치유). 마이그레이션 코드 불필요.

## 테스트 (Testing)

- `src/periods.test.ts`: `gaRanges`(current/previous 상대 키워드 문자열), `gaHistoryRange`. `comparisonRanges`(절대, GSC용) 회귀 유지.
- `src/ga.test.ts`: `mapDailyMetricsRows`(days 인자 제거, base 행에서 날짜 도출·AI 병합·0일 포함·형식 변환), `mapDataQuality`(각 플래그), `(other)` 제외·2차 정렬은 매퍼 단위로 검증 가능한 범위에서.
- `src/gsc.test.ts`: 스킴 동점(http vs https→GA 스킴 우선), 하위경로 vs 루트 우선, `sc-domain` 매칭.
- `src/strategy.test.ts`: `channel-concentrated`를 세션총계 분모 기준으로 갱신(오발화 제거 확인).
- 브라우저 실데이터 QA: 오전/오후 각각 최신일이 GA UI "어제"와 일치, 상위 페이지에 `(other)` 미표시, GSC 수치가 실제 속성과 매칭, 데이터 품질 배지·정의 툴팁 렌더, 콘솔 오류 0.
- 기존 테스트 회귀 없음.

## 비목표 (Non-goals / YAGNI)

- `totalUsers` 병기 — 백로그(라벨/툴팁으로 충분).
- GSC를 GA와 완전 동일 타임존·창으로 강제 정합 — 제외(GSC 자체 타임존/확정지연, 보조지표).
- A7 on-page `/llms.txt` soft-404 판정, A8 PSI 데스크톱 전략 — 별도 백로그(onpage/psi, 중심 아님).
- 커스텀 기간·YoY — 제외.
