# 지속적 정확도 검증 (Accuracy Guard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SiteDeck이 매 새로고침마다 스스로 수치 정확도를 교차검증하고, 릴리스 전에는 실 GA로 심층 검증하게 만든다.

**Architecture:** `buildSummary`가 이미 가져오는 두 독립 GA 쿼리(기간 총계 + 일별 시리즈)를 순수 함수 `checkIntegrity`로 교차검증한다 — 세션·핵심이벤트·AI세션은 날짜별 가산적이라 `일별 합 == 기간 총계`가 엄격히 성립하고, 활성 사용자는 중복제거 탓에 `일별 합 >= 총계` 하한만 성립한다. 추가 GA 호출은 0. 별도로 `npm run verify:accuracy`가 실 GA로 심층 검사를 돌린다.

**Tech Stack:** ESM TypeScript, vitest, tsx. 신규 의존성 없음.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-11-accuracy-guard-design.md`
- TypeScript `noUncheckedIndexedAccess` 활성 — 배열/Record 인덱싱은 옵셔널 체이닝 또는 non-null 단정 필요(테스트 파일도 타입체크됨).
- 신규 런타임 의존성 추가 금지.
- i18n 키는 5개 로케일(en·ko·ja·es·zh) 모두에 일관 추가 — 현재 각 157키, 파리티가 `src/locales.test.ts`로 강제됨.
- `public/` JS는 브라우저 ESM — TypeScript 문법 금지.
- 브랜치: `feat/accuracy-guard` (이미 생성됨).
- 커밋 트레일러(모든 커밋 메시지 끝, 앞에 빈 줄):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LLuTzFzb7JybkfcbYhDvdX
  ```
- 검증: `npm test` (현재 223 통과), `npm run typecheck`. 둘 다 clean해야 커밋.

---

### Task 1: 교차검증 엔진 — `src/integrity.ts` (신규)

**Files:**
- Create: `src/integrity.ts`
- Test: `src/integrity.test.ts`

**Interfaces:**
- Produces: `RangeTotals`, `IntegrityReport`, `checkIntegrity(daily, period, current, previous)`.
- Consumes: `DailyMetricsRow` (type) from `./ga`.

- [ ] **Step 1: 실패 테스트 작성** — `src/integrity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkIntegrity, type RangeTotals } from './integrity';
import type { DailyMetricsRow } from './ga';

/** 연속 날짜 시리즈 빌더. values[i] = 그 날의 sessions(활성=세션, 핵심이벤트=0, AI=0). */
function series(startDate: string, values: number[]): DailyMetricsRow[] {
  const MS = 86_400_000;
  const t0 = Date.parse(`${startDate}T00:00:00Z`);
  return values.map((v, i) => ({
    date: new Date(t0 + i * MS).toISOString().slice(0, 10),
    metrics: { activeUsers: v, sessions: v, keyEvents: 0, aiSessions: 0 },
  }));
}
const totals = (sessions: number, activeUsers = sessions): RangeTotals => ({
  activeUsers,
  sessions,
  keyEvents: 0,
  aiSessions: 0,
});

describe('checkIntegrity', () => {
  it('정합한 데이터는 통과', () => {
    // 14일, 마지막 7일 합 = 7, 직전 7일 합 = 7
    const daily = series('2026-07-01', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(checkIntegrity(daily, 7, totals(7), totals(7))).toEqual({ ok: true, mismatches: [] });
  });

  it('활성 사용자는 일별 합이 총계보다 커도 정상(기간 내 중복제거)', () => {
    const daily = series('2026-07-01', [2, 2, 2, 2, 2, 2, 2]);
    // 일별 활성 합 14, 기간 총계 5 → 중복제거된 정상 케이스, 오탐 없어야 함
    expect(checkIntegrity(daily, 7, totals(14, 5), totals(0, 0)).ok).toBe(true);
  });

  it('활성 사용자 일별 합이 총계보다 작으면 불일치(하한 위반)', () => {
    const daily = series('2026-07-01', [1, 1, 1, 1, 1, 1, 1]);
    const r = checkIntegrity(daily, 7, totals(7, 99), totals(0, 0));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain('activeUsers(current)');
  });

  it('희소 시리즈(구멍 뚫린 일별)는 잡아낸다 — Spec 1의 실제 버그 모양', () => {
    // GA가 0인 날의 행을 안 준 상태: 7/01,02,03 다음이 7/08,09,10,11 (5일 점프)
    const daily: DailyMetricsRow[] = [
      ...series('2026-07-01', [1, 1, 1]),
      ...series('2026-07-08', [1, 1, 1, 1]),
    ];
    // slice(-7)이 7행을 집지만 실제로는 11일에 걸쳐 있다 → 세션 합(7)이 진짜 7일 총계(4)와 어긋남
    const r = checkIntegrity(daily, 7, totals(4), totals(0, 0));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain('contiguity(current)');
    expect(r.mismatches).toContain('sessions(current)');
  });

  it('창이 하루 밀리면 잡아낸다 — 타임존 버그 모양', () => {
    const daily = series('2026-07-01', [5, 1, 1, 1, 1, 1, 1, 9]); // 8일
    // 마지막 7일 합 = 1*6 + 9 = 15. 총계가 하루 밀린 창(5..1 = 11)이면 불일치.
    const r = checkIntegrity(daily, 7, totals(11), totals(0, 0));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain('sessions(current)');
  });

  it('창 길이가 모자라면 days 불일치', () => {
    const daily = series('2026-07-01', [1, 1, 1]); // 3일뿐인데 period 7
    const r = checkIntegrity(daily, 7, totals(3), totals(0, 0));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain('days(current)');
  });

  it('직전 창을 담기에 시리즈가 짧으면 previous는 건너뛴다(거짓 경보 금지)', () => {
    const daily = series('2026-07-01', [1, 1, 1, 1, 1, 1, 1]); // 7일 = current만 가능
    // previous 총계에 말도 안 되는 값을 넣어도 검사하지 않으므로 ok
    const r = checkIntegrity(daily, 7, totals(7), totals(999, 999));
    expect(r).toEqual({ ok: true, mismatches: [] });
  });

  it('직전 창도 검사한다', () => {
    const daily = series('2026-07-01', [2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1]);
    // current(뒤 7일) 합 7, previous(앞 7일) 합 14
    expect(checkIntegrity(daily, 7, totals(7), totals(14)).ok).toBe(true);
    const bad = checkIntegrity(daily, 7, totals(7), totals(99));
    expect(bad.ok).toBe(false);
    expect(bad.mismatches).toContain('sessions(previous)');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/integrity.test.ts` → FAIL (`Cannot find module './integrity'`).

- [ ] **Step 3: 구현** — `src/integrity.ts`:

```ts
import type { DailyMetricsRow } from './ga';

/** Totals for one period (fetchRange + fetchAiSessions combined). */
export interface RangeTotals {
  activeUsers: number;
  sessions: number;
  keyEvents: number;
  aiSessions: number;
}

export interface IntegrityReport {
  ok: boolean;
  /** Mismatch labels, e.g. 'sessions(current)', 'days(previous)', 'contiguity(current)'. */
  mismatches: string[];
}

const MS_PER_DAY = 86_400_000;

/** A session / key event / AI session belongs to exactly ONE day, so daily sums must equal
 *  the period total. activeUsers is de-duplicated across the period and is NOT additive —
 *  it can only be bounded from below (dailySum >= periodTotal). */
const ADDITIVE = ['sessions', 'keyEvents', 'aiSessions'] as const;

type MetricKey = 'activeUsers' | 'sessions' | 'keyEvents' | 'aiSessions';

function sum(rows: DailyMetricsRow[], key: MetricKey): number {
  return rows.reduce((a, r) => a + r.metrics[key], 0);
}

/** True when every date is exactly one calendar day after the previous one. */
function contiguous(rows: DailyMetricsRow[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    const prev = Date.parse(`${(rows[i - 1] as DailyMetricsRow).date}T00:00:00Z`);
    const cur = Date.parse(`${(rows[i] as DailyMetricsRow).date}T00:00:00Z`);
    if (cur - prev !== MS_PER_DAY) return false;
  }
  return true;
}

function checkWindow(rows: DailyMetricsRow[], period: number, totals: RangeTotals, label: string): string[] {
  const out: string[] = [];
  if (rows.length !== period) out.push(`days(${label})`);
  if (!contiguous(rows)) out.push(`contiguity(${label})`);
  for (const k of ADDITIVE) {
    if (sum(rows, k) !== totals[k]) out.push(`${k}(${label})`);
  }
  if (sum(rows, 'activeUsers') < totals.activeUsers) out.push(`activeUsers(${label})`);
  return out;
}

/**
 * Cross-check the daily series against independently-fetched range totals.
 *
 * buildSummary already fetches BOTH a dimensionless aggregate (fetchRange) and a
 * date-dimensioned series (fetchDailyMetrics), so this costs no extra GA call. Because the
 * additive metrics must sum to the period total, a date window that drifts by even one day
 * — or a sparse/non-contiguous series — makes the two disagree. That is exactly the bug
 * class this guard exists to catch (both were shipped and caught in Spec 1).
 *
 * Caveat: if GA applied data thresholding to the dimensioned report, a mismatch can be
 * GA's doing rather than ours — SiteSummary.dataQuality.thresholded surfaces that
 * separately, so the two signals are read together.
 *
 * The previous window is only checked when the series is long enough to contain it (a
 * missing window must never raise a false alarm).
 */
export function checkIntegrity(
  daily: DailyMetricsRow[],
  period: number,
  current: RangeTotals,
  previous: RangeTotals,
): IntegrityReport {
  const mismatches = checkWindow(daily.slice(-period), period, current, 'current');
  if (daily.length >= period * 2) {
    mismatches.push(...checkWindow(daily.slice(-period * 2, -period), period, previous, 'previous'));
  }
  return { ok: mismatches.length === 0, mismatches };
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/integrity.test.ts` → PASS (8건). 그 다음 `npm test` + `npm run typecheck` → clean.

- [ ] **Step 5: 커밋**

```bash
git add src/integrity.ts src/integrity.test.ts
git commit -m "feat(integrity): 일별↔총계 교차검증 엔진 (가산 지표 엄격 등식 + 활성사용자 하한)"
```

---

### Task 2: 요약에 연결 — `src/summary.ts`, `src/server.ts`

**Files:**
- Modify: `src/summary.ts` (SiteSummary에 `integrity` 추가)
- Modify: `src/server.ts` (`buildSummary`에서 `checkIntegrity` 호출)

**Interfaces:**
- Consumes: `checkIntegrity`, `IntegrityReport`, `RangeTotals` (Task 1).
- Produces: `SiteSummary.integrity: IntegrityReport | null`.

- [ ] **Step 1: 타입 추가** — `src/summary.ts`: 상단에 타입 import 추가하고 `SiteSummary`에 필드 추가.

```ts
import type { IntegrityReport } from './integrity';
```
`SiteSummary` 안(마지막 필드 뒤):
```ts
  /** 일별 시리즈 ↔ 기간 총계 교차검증 결과. 불일치면 이 사이트 수치를 신뢰할 수 없다. */
  integrity: IntegrityReport | null;
```

- [ ] **Step 2: `buildSummary`에서 호출** — `src/server.ts`. import 추가:
```ts
import { checkIntegrity } from './integrity';
```
`const summary: SiteSummary = { … }` 리터럴 **바로 위**에 삽입(이미 스코프에 있는 값만 사용 — 추가 GA 호출 없음):
```ts
        const integrity = checkIntegrity(
          daily,
          period,
          { activeUsers: cur.activeUsers, sessions: cur.sessions, keyEvents: cur.keyEvents, aiSessions: aiCur },
          { activeUsers: prev.activeUsers, sessions: prev.sessions, keyEvents: prev.keyEvents, aiSessions: aiPrev },
        );
```
그리고 리터럴에 필드 추가(`dataQuality: …` 줄 뒤):
```ts
          integrity,
```

- [ ] **Step 3: 검증 + 커밋** — 이 태스크는 배선이라 신규 단위 테스트가 없다. 게이트는 typecheck + 기존 스위트.

Run: `npm run typecheck` → 0 오류. Run: `npm test` → 전부 그린.

```bash
git add src/summary.ts src/server.ts
git commit -m "feat(server): 매 요약마다 일별↔총계 교차검증 (추가 GA 호출 0)"
```

---

### Task 3: UI 무결성 경고 — `public/app.js`, `public/style.css`, i18n ×5

**Files:**
- Modify: `public/app.js` (`integrityBadge` 헬퍼 + 이름 셀 삽입)
- Modify: `public/style.css` (`.integrity-badge`)
- Modify: `public/locales/{en,ko,ja,es,zh}.json`

**Interfaces:**
- Consumes: `SiteSummary.integrity` (Task 2).

- [ ] **Step 1: i18n 키 추가 (5개 로케일 전부)** — 신규 키 2개:

| key | en | ko | ja | es | zh |
|---|---|---|---|---|---|
| `integrity.mismatch` | `Internal cross-check failed ({fields}) — do not trust these numbers. This is a SiteDeck bug, not a GA caveat.` | `내부 교차검증 불일치 ({fields}) — 이 수치를 신뢰하지 마세요. GA의 특성이 아니라 SiteDeck의 버그입니다.` | `内部クロスチェック不一致 ({fields}) — この数値を信頼しないでください。GA の仕様ではなく SiteDeck のバグです。` | `Verificación cruzada interna fallida ({fields}): no confíe en estas cifras. Es un error de SiteDeck, no una peculiaridad de GA.` | `内部交叉校验不一致（{fields}）— 请勿信任这些数字。这是 SiteDeck 的缺陷，而非 GA 的特性。` |
| `integrity.badgeLabel` | `Integrity check failed` | `무결성 검사 실패` | `整合性チェック失敗` | `Fallo de verificación de integridad` | `完整性校验失败` |

  (`src/locales.test.ts`가 키 파리티를 강제하므로 5개 파일 전부에 추가할 것. 추가 후 각 파일 157→159키.)

- [ ] **Step 2: `app.js` 배지 헬퍼** — `dqBadge` 바로 아래에 추가:

```js
// Loud badge when our own cross-check (daily series vs period totals) disagrees. Unlike
// dqBadge (a GA data caveat), this means SiteDeck's numbers are internally inconsistent.
function integrityBadge(integrity) {
  if (!integrity || integrity.ok) return "";
  const fields = integrity.mismatches.join(", ");
  const text = t("integrity.mismatch", { fields });
  return ` <span class="integrity-badge" title="${escapeHtml(text)}" aria-label="${escapeHtml(t("integrity.badgeLabel") + ": " + fields)}" tabindex="0">🛑</span>`;
}
```

- [ ] **Step 3: 이름 셀에 삽입** — `<td class="name">` 줄의 `${dqBadge(s.dataQuality)}` 뒤에 이어붙인다:

```js
        <td class="name">${copyBtn(s.propertyId)}${siteLink(s.displayName, gaUrl(s.propertyId))}${dqBadge(s.dataQuality)}${integrityBadge(s.integrity)}</td>
```

- [ ] **Step 4: `style.css`** — 파일 끝에 추가(dq-badge와 달리 키보드 포커스 가능하게):

```css
.integrity-badge { cursor: help; font-size: 0.9em; }
.integrity-badge:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: 2px; border-radius: 3px; }
```

- [ ] **Step 5: 검증 + 커밋** — Run: `npm run typecheck` → 0 오류. Run: `npm test` → 전부 그린(`locales.test.ts`가 5개 로케일 파리티를 확인).

수동 확인: 정상 상태에선 🛑 배지가 **안 보여야** 정상(교차검증이 통과하므로). 강제로 보려면 브라우저 콘솔에서 `state.data.sites[0].integrity = {ok:false, mismatches:['sessions(current)']}` 후 재렌더.

```bash
git add public/app.js public/style.css public/locales/
git commit -m "feat(ui): 교차검증 불일치 시 무결성 경고 배지"
```

---

### Task 4: 릴리스 게이트 — `scripts/verify-accuracy.mts` + `package.json`

**Files:**
- Create: `scripts/verify-accuracy.mts`
- Modify: `package.json` (scripts에 `verify:accuracy` 추가)

**Interfaces:**
- Consumes: `checkIntegrity` (Task 1), `getClient`, `listProperties`, `fetchRange`, `fetchAiSessions`, `fetchDailyMetrics`, `listSiteUrls`, `gaRanges`, `gaHistoryRange`, `expectedDaysInZone`, `loadGaHistory`, `listGscSites`, `matchSites`, `parseSite`.

- [ ] **Step 1: 스크립트 작성** — `scripts/verify-accuracy.mts`:

```ts
/**
 * 실 GA를 호출해 정확도를 심층 검증하는 릴리스 게이트. `npm run verify:accuracy`.
 * 사용자 OAuth 토큰이 필요하므로 CI가 아니라 로컬에서 돌린다. 실패가 하나라도 있으면 exit 1.
 */
import { getClient } from '../src/auth';
import { listProperties, fetchRange, fetchAiSessions, fetchDailyMetrics, listSiteUrls } from '../src/ga';
import { gaRanges, gaHistoryRange, expectedDaysInZone } from '../src/periods';
import { checkIntegrity } from '../src/integrity';
import { loadGaHistory } from '../src/ga-store';
import { listGscSites, matchSites, parseSite } from '../src/gsc';
import { GA_HISTORY_FETCH_DAYS, GA_HISTORY_STORE_PATH, PERIODS } from '../src/config';

const fails: string[] = [];
function report(ok: boolean, what: string, detail = ''): void {
  if (!ok) fails.push(what);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
}

const auth = await getClient();
const props = await listProperties(auth);
console.log(`속성 ${props.length}개 검증\n`);

for (const p of props) {
  const daily = await fetchDailyMetrics(auth, p.propertyId, gaHistoryRange(GA_HISTORY_FETCH_DAYS), GA_HISTORY_FETCH_DAYS);

  // 1) 일별 시리즈: 길이·연속성
  report(daily.length === GA_HISTORY_FETCH_DAYS, `${p.displayName}: 일별 ${GA_HISTORY_FETCH_DAYS}일`, `${daily.length}행`);
  let contiguous = true;
  for (let i = 1; i < daily.length; i++) {
    const a = Date.parse(`${(daily[i - 1] as { date: string }).date}T00:00:00Z`);
    const b = Date.parse(`${(daily[i] as { date: string }).date}T00:00:00Z`);
    if (b - a !== 86_400_000) contiguous = false;
  }
  report(contiguous, `${p.displayName}: 날짜 연속`);

  // 2) 교차검증 불변식 (전 기간)
  for (const period of PERIODS) {
    const r = gaRanges(period);
    const [cur, prev, aiCur, aiPrev] = await Promise.all([
      fetchRange(auth, p.propertyId, r.current),
      fetchRange(auth, p.propertyId, r.previous),
      fetchAiSessions(auth, p.propertyId, r.current),
      fetchAiSessions(auth, p.propertyId, r.previous),
    ]);
    const res = checkIntegrity(
      daily,
      period,
      { activeUsers: cur.activeUsers, sessions: cur.sessions, keyEvents: cur.keyEvents, aiSessions: aiCur },
      { activeUsers: prev.activeUsers, sessions: prev.sessions, keyEvents: prev.keyEvents, aiSessions: aiPrev },
    );
    report(res.ok, `${p.displayName}: 교차검증 ${period}일`, res.mismatches.join(', '));
  }

  // 3) 저장 이력 드리프트: 겹치는 날짜의 값이 신규 조회와 일치하는가
  const store = await loadGaHistory(GA_HISTORY_STORE_PATH);
  const stored = store.byProperty[p.propertyId]?.days ?? {};
  const drift = daily.filter((d) => {
    const s = stored[d.date];
    return s && (s.sessions !== d.metrics.sessions || s.keyEvents !== d.metrics.keyEvents);
  });
  report(drift.length === 0, `${p.displayName}: 저장 이력 드리프트 없음`, drift.length ? `${drift.length}일 불일치` : '');
}

// 4) GSC 매칭: 스킴이 GA 스트림과 일치하는가
const [siteUrls, gscSites] = await Promise.all([listSiteUrls(auth, props).catch(() => []), listGscSites(auth).catch(() => [])]);
const matched = matchSites(siteUrls, gscSites);
for (const s of siteUrls) {
  const site = matched.get(s.propertyId);
  if (!site) continue;
  const ga = parseSite(s.url);
  const gsc = parseSite(site);
  const ok = gsc?.kind === 'domain' || gsc?.scheme === ga?.scheme;
  report(ok, `${s.displayName}: GSC 스킴 정합`, `${s.url} → ${site}`);
}

console.log(`\n${fails.length === 0 ? '✅ 전부 PASS' : `❌ ${fails.length}건 FAIL`}`);
if (fails.length > 0) process.exit(1);
```

- [ ] **Step 2: `package.json` 스크립트 추가** — `"test": "vitest run",` 아래에:

```json
    "verify:accuracy": "tsx scripts/verify-accuracy.mts",
```

- [ ] **Step 3: 실행 (실데이터 게이트)** — Run: `npm run verify:accuracy`.
기대: 전 속성 × 전 기간 PASS, 최종 `✅ 전부 PASS`, exit 0. **FAIL이 나오면 그것이 진짜 정확도 결함이므로 STOP하고 보고할 것** (스크립트를 느슨하게 고쳐서 통과시키지 말 것).

- [ ] **Step 4: 검증 + 커밋** — Run: `npm run typecheck` → 0 오류(스크립트도 `src`가 아니라 tsconfig include 밖일 수 있으니, 오류가 나면 스크립트를 `tsc` 대상에서 제외하지 말고 타입을 맞출 것). Run: `npm test` → 전부 그린.

```bash
git add scripts/verify-accuracy.mts package.json
git commit -m "feat(guard): npm run verify:accuracy — 실 GA 대상 릴리스 게이트"
```

---

## Self-Review 메모 (작성자 확인)

- **스펙 커버리지**: 계층 1 = Task 1(엔진) + Task 2(배선) + Task 3(UI); 계층 2 = Task 4(스크립트); 계층 3 = Task 1의 테스트. 스펙의 4개 컴포넌트 전부 매핑됨.
- **타입 일관성**: `RangeTotals`/`IntegrityReport`는 `integrity.ts`에서 정의 → `summary.ts`가 `import type`으로 참조(런타임 사이클 없음; `integrity.ts`는 `ga.ts`의 타입만 import) → `server.ts`가 값으로 `checkIntegrity` 호출 → `app.js`가 `s.integrity` 읽음. 일관.
- **거짓 경보 방지**(핵심): previous 창은 시리즈가 짧으면 건너뛴다. activeUsers는 등식이 아니라 하한. 이 두 가지를 Task 1의 테스트가 명시적으로 잠근다.
- **주의**: Task 4의 스크립트는 `src/`를 상대 경로로 import한다. tsconfig의 `include`가 `["src"]`뿐이면 `scripts/`는 타입체크 대상 밖이다 — 그 경우 `npm run typecheck`는 통과하지만 스크립트 자체의 타입 오류는 `tsx` 실행 시 드러난다. Step 3의 실제 실행이 그 게이트다.
