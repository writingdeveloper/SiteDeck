# 지속적 정확도 검증 (Accuracy Guard) — 설계

**작성일:** 2026-07-11
**상태:** 검토 대기 (작성됨)
**선행:** Spec 1 (GA/GSC 데이터 정확도, 머지됨 85a1c6d)

## 목표 (Goal)

정확도 검증을 **일회성 QA가 아니라 상시 가드**로 만든다. Spec 1에서 단위 테스트 223개와 3라운드 코드 리뷰가
모두 놓친 회귀(희소한 일별 시리즈 → 추세 왜곡)를 잡은 것은 **실데이터 검증**이었다. 그 검증을 사람이 기억해서
하는 절차가 아니라, **코드가 스스로 매번 하는 검사**로 바꾼다.

## 핵심 통찰 — GA가 GA를 검증한다 (외부 정답 불필요, 추가 API 호출 0)

`buildSummary`는 이미 **두 개의 독립적인 GA 쿼리** 결과를 갖고 있다:
1. `fetchRange(period)` — 기간 총계 (차원 없는 집계)
2. `fetchDailyMetrics(90일)` — 일별 시리즈 (date 차원)

**세션·핵심이벤트·AI세션은 날짜별로 가산적**이므로 다음 등식이 반드시 성립한다:

```
sum(일별 마지막 N일의 sessions) == fetchRange(N일).sessions
```

**활성 사용자는 기간 내 중복제거되므로 등식이 아니라 하한 관계**만 성립한다:
```
sum(일별 activeUsers) >= fetchRange.activeUsers
```

**실측 검증 (2026-07-11, 11개 속성 × 기간 7·28 = 22개 검사):** 가산 지표 3종이 **전부 정확히 일치**했고
(오차 0 → 허용범위·퍼지 매칭 불필요), 활성 사용자 하한 관계도 전부 성립했다(예: Receo 28일 — 일별합 40 ≥ 총계 11,
중복제거가 실제로 관측됨). 즉 이 등식은 **거짓 경보를 내지 않는 엄격한 불변식**이다.

**이 검사가 실제로 잡는 것:** 날짜 창이 하루라도 어긋나거나(타임존 버그), 일별 시리즈가 희소·불연속이면
(keepEmptyRows 회귀) 두 쿼리의 합이 갈라진다. 즉 **Spec 1에서 실제로 겪은 두 버그를 모두 잡는다.**

## 아키텍처 (Architecture)

3계층. 핵심은 계층 1 — 사용자가 대시보드를 열 때마다 자동으로 돌고 비용이 0이다.

**계층 1 — 앱 내 상시 교차검증.** 순수 함수 `checkIntegrity`를 `src/integrity.ts`에 두고 `buildSummary`에서
호출한다. 이미 가져온 데이터만 쓰므로 GA 호출이 늘지 않는다. **현재 기간과 직전 기간 양쪽**을 검사한다(둘 다
이미 fetch됨 → 여전히 비용 0). 불일치 시 `SiteSummary.integrity`에 실어 UI에 경고를 띄운다.

**계층 2 — 릴리스 전 심층 게이트.** `scripts/verify-accuracy.mts` (`npm run verify:accuracy`). 실 GA를 호출해
계층 1 불변식을 전 속성 × 전 기간에 대해 돌리고, 추가로 일별 시리즈의 길이·연속성·종료일(속성 타임존의 "어제"),
저장 이력과 신규 조회의 드리프트, GSC 매칭의 스킴 정합을 검사한다. PASS/FAIL 표를 찍고 실패 시 exit 1.
사용자 OAuth 토큰이 필요하므로 CI가 아니라 **로컬 릴리스 게이트**다.

**계층 3 — 검사기 자체의 단위 테스트.** `checkIntegrity`가 **정상 데이터는 통과시키고, 희소·어긋난 데이터는
반드시 FAIL시키는지**를 테스트한다. (Spec 1의 실제 버그 데이터 모양을 픽스처로 재현 → 검사기가 진짜로 잡는지 증명)

## 기술 스택 (Tech Stack)

ESM TypeScript, vitest, tsx(스크립트 실행). 신규 의존성 없음.

---

## 컴포넌트 1: 교차검증 엔진 — `src/integrity.ts` (신규)

```ts
/** 한 기간의 총계 (fetchRange + fetchAiSessions를 합친 모양). */
export interface RangeTotals {
  activeUsers: number;
  sessions: number;
  keyEvents: number;
  aiSessions: number;
}

export interface IntegrityReport {
  ok: boolean;
  /** 불일치 항목 라벨 (예: 'sessions(current)', 'days(previous)', 'contiguity(current)'). 비면 ok. */
  mismatches: string[];
}

/**
 * 일별 시리즈를 독립적으로 가져온 기간 총계와 교차검증한다.
 * sessions/keyEvents/aiSessions는 날짜별 가산적 → 일별 합이 총계와 **정확히 같아야** 한다.
 * activeUsers는 기간 내 중복제거 → 일별 합 >= 총계 (하한)만 성립.
 * 창 길이·날짜 연속성도 함께 검사한다(희소 시리즈 탐지).
 */
export function checkIntegrity(
  daily: DailyMetricsRow[],
  period: number,
  current: RangeTotals,
  previous: RangeTotals,
): IntegrityReport;
```

검사 항목(각 창 = current: `daily.slice(-period)`, previous: `daily.slice(-2*period, -period)`):
- `days` — 창의 행 수가 정확히 `period`인가 (희소 시리즈면 실패)
- `contiguity` — 창의 날짜가 하루 간격 연속인가
- `sessions` / `keyEvents` / `aiSessions` — 일별 합 **==** 총계 (엄격 등식)
- `activeUsers` — 일별 합 **>=** 총계 (중복제거 하한)

`previous` 창은 `daily.length >= 2*period`일 때만 검사(90일 시리즈에 period=90이면 직전 창이 없음 → 건너뜀).

## 컴포넌트 2: 요약에 연결 — `src/server.ts`, `src/summary.ts`

- `summary.ts`: `SiteSummary`에 `integrity: IntegrityReport | null` 추가.
- `server.ts` `buildSummary`: 이미 있는 `daily`, `cur`/`prev`, `aiCur`/`aiPrev`로 `checkIntegrity` 호출 후 부착.
  **추가 GA 호출 없음.**

## 컴포넌트 3: UI 경고 — `public/app.js`, i18n

무결성 불일치는 GA의 데이터 특성(샘플링 등)이 아니라 **SiteDeck의 버그 신호**다. 데이터 품질 배지(`dq-badge`)와
구분되는 **더 강한 경고**로 표시한다: 사이트 행에 `integrity-badge`(🛑) + 툴팁("내부 교차검증 불일치 — 이 수치를
신뢰하지 마세요: {fields}"). i18n 키 `integrity.mismatch`(파라미터 `{fields}`) ×5 로케일.

## 컴포넌트 4: 릴리스 게이트 — `scripts/verify-accuracy.mts` + `package.json`

`npm run verify:accuracy` → `tsx scripts/verify-accuracy.mts`. 실 GA 호출. 속성 × 기간(7/28/90)마다:
1. `checkIntegrity` 불변식
2. 일별 시리즈: 길이 == `GA_HISTORY_FETCH_DAYS`, 날짜 연속, 마지막 날 == 속성 타임존의 "어제"
   (`expectedDaysInZone(report.metadata.timeZone, …)`의 마지막 값과 대조)
3. 저장 이력 드리프트: `ga-history.json`의 겹치는 날짜 값이 신규 조회와 일치하는가
4. GSC: 매칭된 사이트의 스킴이 GA 스트림 URL의 스킴과 일치하는가

PASS/FAIL 표 출력, 하나라도 실패면 `process.exit(1)`.

## 에러 처리 (Error Handling)

- `checkIntegrity`는 순수·무예외. 데이터가 부족하면(창을 못 만들면) 해당 창을 건너뛰고 `ok: true`로 둔다
  (없는 데이터로 거짓 경보를 내지 않는다).
- 계층 1은 요약 응답에 실릴 뿐 요약을 실패시키지 않는다(경고이지 차단이 아님).
- 계층 2 스크립트는 속성별 GA 오류를 잡아 해당 속성만 FAIL로 표시하고 계속 진행한다.

## 테스트 (Testing)

- `src/integrity.test.ts`:
  - 정상(가산 일치 + 연속 + 길이 정확) → `ok: true`
  - **희소 시리즈**(Spec 1의 실제 버그 모양: 90일 요청에 구멍 뚫린 21행) → `days`/`contiguity`/`sessions` 불일치 검출
  - **하루 밀린 창**(타임존 버그 모양) → `sessions` 불일치 검출
  - activeUsers 하한 위반(일별합 < 총계) → 검출
  - activeUsers 일별합 > 총계는 **정상**(중복제거) → 오탐 안 냄
  - previous 창이 없을 때(데이터 부족) → 건너뛰고 ok
- 실데이터 QA: `npm run verify:accuracy`가 현 상태에서 전부 PASS.

## 비목표 (Non-goals / YAGNI)

- CI에서 실 GA 호출 — 제외(토큰 필요, 로컬 게이트로 충분).
- GA UI 스크래핑으로 외부 정답 대조 — 제외(불안정; 자기검증 불변식이 더 강하다).
- 불일치 시 요약 응답 자체를 실패시키기 — 제외(경고로 충분; 데이터를 아예 못 보게 하면 더 나쁘다).
- 히스토리 전체(365일) 드리프트 검사 — 제외(신규 조회 범위인 90일만).
