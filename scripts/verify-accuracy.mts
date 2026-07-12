/**
 * 실 GA를 호출해 정확도를 심층 검증하는 릴리스 게이트. `npm run verify:accuracy`.
 * 사용자 OAuth 토큰이 필요하므로 CI가 아니라 로컬에서 돌린다. 실패가 하나라도 있으면 exit 1.
 */
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { getClient } from '../src/auth';
import { listProperties, fetchRange, fetchAiSessions, fetchDailyMetrics, listSiteUrls } from '../src/ga';
import { gaRanges, gaHistoryRange } from '../src/periods';
import { checkIntegrity, type RangeTotals } from '../src/integrity';
import { loadGaHistory } from '../src/ga-store';
import { listGscSites, matchSites, parseSite } from '../src/gsc';
import { GA_HISTORY_FETCH_DAYS, GA_HISTORY_STORE_PATH, PERIODS } from '../src/config';

// GUARD = 구성상 항상 참인 검사(0-채움 회귀 가드). 통과해도 "검증"으로 세지 않는다 — 단
// 깨지면(회귀) 여전히 FAIL로 릴리스를 막는다. 자세한 배경은 아래 1) 검사 주석 참고.
type Outcome = 'PASS' | 'FAIL' | 'SKIP' | 'GUARD';
const tally = { PASS: 0, FAIL: 0, SKIP: 0, GUARD: 0 };
const fails: string[] = [];
// PASS/FAIL 여부와 별개로, "실제로 0이 아닌 무언가를 비교했는가"만 센다. tally.PASS는 구성상
// 항상 참인 검사나 전량 0 비교로도 늘어날 수 있어 "검증된 게 있다"는 증거가 못 된다 — substantive는
// 그 구멍을 메우는 별도의, 더 엄격한 카운터다.
let substantive = 0;
function report(outcome: Outcome, what: string, detail = ''): void {
  tally[outcome]++;
  if (outcome === 'FAIL') fails.push(what);
  console.log(`${outcome.padEnd(5)}  ${what}${detail ? `  — ${detail}` : ''}`);
}

const auth = await getClient();
// src/ga.ts's Data API client isn't exported, so this script builds its own — same
// auth-bridging cast src/ga.ts uses internally (see its gaOptions helper). Used only
// for the non-circular timezone check below (1b).
const dataClient = new BetaAnalyticsDataClient({ authClient: auth as never, fallback: true });
const props = await listProperties(auth);
console.log(`속성 ${props.length}개 검증\n`);

// 프로퍼티 루프 밖에서 한 번만 로드한다 — 루프 안에서 매 속성마다 다시 읽으면(속성 N개면 N회)
// 같은 파일을 반복 재읽기하는 낭비다. 이 스크립트는 절대 store를 쓰지 않으므로(읽기 전용
// 검증), 루프 내내 값이 바뀔 이유가 없다.
const gaHistory = await loadGaHistory(GA_HISTORY_STORE_PATH);

// GA 'yesterday' 대조(1b)가 실제로 결론(SKIP 포함)까지 도달한 횟수와 그중 SKIP인 횟수.
// 전부 SKIP였다면 날짜 창이 단 한 번도 외부 기준에 닻을 내리지 못한 것이므로 아래 루프 뒤에서
// FAIL로 승격한다.
let yesterdayAttempts = 0;
let yesterdaySkips = 0;

for (const p of props) {
  try {
    const { rows: daily, unexpectedDates, sampleUnexpectedDate } = await fetchDailyMetrics(
      auth,
      p.propertyId,
      gaHistoryRange(GA_HISTORY_FETCH_DAYS),
      GA_HISTORY_FETCH_DAYS,
    );

    // 1) 일별 시리즈: 길이·연속성 (형태 회귀 가드 — GUARD, PASS 아님)
    // 주의: 아래 두 검사는 현재 코드에서는 구조적으로 항상 참이다 — fetchDailyMetrics가
    // expectedDaysInZone이 만든 날짜 목록을 map하기 때문. 즉 GA의 동작을 검증하는 게 아니라,
    // 0-채움을 없애는 회귀(과거에 실제로 발생)를 막는 가드다. 진짜 GA 동작 검증은 아래
    // checkIntegrity 불변식, 'GA yesterday 대조', '기대 밖 날짜'가 한다. 통과는 GUARD로 세고
    // (검증으로 카운트하지 않는다), 그 조건이 깨지면(회귀) 여전히 FAIL로 릴리스를 막는다.
    report(
      daily.length === GA_HISTORY_FETCH_DAYS ? 'GUARD' : 'FAIL',
      `${p.displayName}: 일별 ${GA_HISTORY_FETCH_DAYS}일 (형태 회귀 가드)`,
      `${daily.length}행`,
    );
    let contiguous = true;
    for (let i = 1; i < daily.length; i++) {
      const a = Date.parse(`${(daily[i - 1] as { date: string }).date}T00:00:00Z`);
      const b = Date.parse(`${(daily[i] as { date: string }).date}T00:00:00Z`);
      if (b - a !== 86_400_000) contiguous = false;
    }
    report(contiguous ? 'GUARD' : 'FAIL', `${p.displayName}: 날짜 연속 (형태 회귀 가드)`);

    // 1b) 비순환 타임존 검사: GA에게 "yesterday"를 직접 해석시켜(서버 측, 속성의 저장된 타임존)
    // 우리가 로컬 Intl로 계산한 시리즈의 마지막 날짜와 대조한다. 시리즈 날짜는 로컬
    // expectedDaysInZone에서 나오므로, 이 검사만이 "우리 계산 vs GA 해석"의 불일치를 잡는다.
    const [ry] = await dataClient.runReport({
      property: `properties/${p.propertyId}`,
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      keepEmptyRows: true,
    });
    const gaYmd = ry.rows?.[0]?.dimensionValues?.[0]?.value;
    const ourLast = daily[daily.length - 1]?.date;
    yesterdayAttempts++;
    if (!gaYmd || !ourLast) {
      yesterdaySkips++;
      report('SKIP', `${p.displayName}: GA 'yesterday' 대조`, 'GA가 해당 날짜 행을 반환하지 않음');
    } else {
      const gaDate = `${gaYmd.slice(0, 4)}-${gaYmd.slice(4, 6)}-${gaYmd.slice(6, 8)}`;
      substantive++; // 실제 두 날짜(GA 서버측 해석 vs 로컬 계산)를 비교했다 — 실질 검증.
      report(gaDate === ourLast ? 'PASS' : 'FAIL', `${p.displayName}: GA 'yesterday' == 시리즈 마지막 날`,
        `GA ${gaDate} vs 로컬 ${ourLast}`);
    }

    // 1c) 기대 밖 날짜: GA가 반환한 base 리포트 날짜 중 우리 expected 밖의 것이 있는가.
    // mapDailyMetricsRows는 expected를 map하므로 이런 행은 오늘 조용히 버려진다 — 합 불변식이
    // 놓치는 "창 밀림"(예: 타임존 계산이 어긋나 GA가 우리 예상과 다른 날짜 집합으로 응답)을
    // 잡아내는 무료 신호다. 트래픽 유무와 무관하게 유효하다 — 제로 트래픽 속성이라도 GA는
    // date 차원 값 자체는 돌려주므로, checkIntegrity의 합 불변식이 못 보는 지점(창이 하루 밀려도
    // 들어오는 날과 나가는 날의 값이 같으면 합은 그대로인 경우, 특히 전량 0인 포트폴리오에서는
    // 항상 그렇다)을 정확히 메운다. SKIP 분기가 없다 — GA 응답(빈 응답 포함)과 로컬 expected를
    // 항상 실제로 대조하므로 매 실행 실질 검증이다.
    substantive++; // GA가 반환한 날짜 집합과 로컬 expected 집합을 실제로 대조했다 — 실질 검증.
    report(
      unexpectedDates === 0 ? 'PASS' : 'FAIL',
      `${p.displayName}: GA가 기대 밖 날짜를 반환하지 않음 (창 정렬)`,
      unexpectedDates === 0 ? '0개' : `${unexpectedDates}개, 예시 ${sampleUnexpectedDate}`,
    );

    // 2) 교차검증 불변식 (전 기간)
    for (const period of PERIODS) {
      const r = gaRanges(period);
      const [cur, prev, aiCur, aiPrev] = await Promise.all([
        fetchRange(auth, p.propertyId, r.current),
        fetchRange(auth, p.propertyId, r.previous),
        fetchAiSessions(auth, p.propertyId, r.current),
        fetchAiSessions(auth, p.propertyId, r.previous),
      ]);
      const current: RangeTotals = { activeUsers: cur.activeUsers, sessions: cur.sessions, keyEvents: cur.keyEvents, aiSessions: aiCur };
      const previous: RangeTotals = { activeUsers: prev.activeUsers, sessions: prev.sessions, keyEvents: prev.keyEvents, aiSessions: aiPrev };
      const res = checkIntegrity(daily, period, current, previous);
      // 창이 전량 0(제로 트래픽 속성, 혹은 keyEvents 미설정 아암)이면 0 === 0만 비교하는 셈이라
      // 아무것도 검증하지 못한다. PASS/FAIL 판정 자체는 그대로 둔다(실제로 어긋나면 여전히
      // FAIL) — 다만 substantive에는 넣지 않는다.
      const nonZero = Object.values(current).some((v) => v !== 0);
      if (nonZero) substantive++;
      report(
        res.ok ? 'PASS' : 'FAIL',
        `${p.displayName}: 교차검증 ${period}일${nonZero ? '' : ' (전량 0 — 비실질)'}`,
        res.mismatches.join(', '),
      );
    }

    // 3) 저장 이력 드리프트: 겹치는 날짜의 값이 신규 조회와 일치하는가.
    // GA는 최근 ~24-48시간 데이터를 계속 수정한다 — 뒤늦게 재조회하면 최신 며칠은 이전에 저장한
    // 값과 정당하게 달라질 수 있다(버그가 아니다). 그래서 최근 3일은 비교 대상에서 제외한다.
    const stored = gaHistory.byProperty[p.propertyId]?.days ?? {};
    const driftCandidates = daily.slice(0, -3);
    const overlapping = driftCandidates.filter((d) => stored[d.date] !== undefined);
    const drift = overlapping.filter((d) => {
      const s = stored[d.date] as { sessions: number; keyEvents: number };
      return s.sessions !== d.metrics.sessions || s.keyEvents !== d.metrics.keyEvents;
    });
    if (overlapping.length === 0) {
      report('SKIP', `${p.displayName}: 저장 이력 드리프트`, '겹치는 저장 날짜 0일 (첫 실행/신규 속성)');
    } else {
      substantive++; // 저장된 값과 신규 GA 조회를 실제로 비교했다 — 실질 검증.
      report(drift.length === 0 ? 'PASS' : 'FAIL', `${p.displayName}: 저장 이력 드리프트`,
        `${overlapping.length}일 비교(최근 3일 제외), ${drift.length}일 불일치`);
    }
  } catch (e) {
    report('FAIL', `${p.displayName}: 조회 실패`, e instanceof Error ? e.message : String(e));
  }
}

// GA 'yesterday' 대조가 결론까지 도달한 모든 속성에서 SKIP였다면, 날짜 창이 외부 기준(GA
// 자신의 서버측 날짜 해석)에 단 한 번도 닻을 내리지 못했다는 뜻이다 — 조용한 통과로 흘리지 않는다.
if (yesterdayAttempts > 0 && yesterdaySkips === yesterdayAttempts) {
  report(
    'FAIL',
    "GA 'yesterday' 대조 전체 SKIP",
    `${yesterdayAttempts}개 속성 모두 GA가 어제 날짜 행을 반환하지 않음 — 날짜 창이 외부 기준에 전혀 닻을 내리지 못함`,
  );
}

// 4) GSC 매칭: 스킴이 GA 스트림과 일치하는가
let gscListError: string | null = null;
const [siteUrls, gscSites] = await Promise.all([
  listSiteUrls(auth, props).catch((e: unknown) => {
    gscListError = e instanceof Error ? e.message : String(e);
    return [] as Awaited<ReturnType<typeof listSiteUrls>>;
  }),
  listGscSites(auth).catch((e: unknown) => {
    gscListError = e instanceof Error ? e.message : String(e);
    return [] as string[];
  }),
]);
if (gscListError) {
  report('SKIP', 'GSC 검사군', `사이트 목록 조회 실패 — ${gscListError}`);
}
const matched = matchSites(siteUrls, gscSites);
let gscChecked = 0;
for (const s of siteUrls) {
  const site = matched.get(s.propertyId);
  if (!site) {
    report('SKIP', `${s.displayName}: GSC 스킴 정합`, '매칭된 GSC 사이트 없음');
    continue;
  }
  gscChecked++;
  const ga = parseSite(s.url);
  const gsc = parseSite(site);
  if (!ga || !gsc) {
    // 파싱 실패를 조용한 PASS로 흘리지 않는다 (undefined === undefined 함정).
    report('FAIL', `${s.displayName}: GSC 스킴 정합`, `파싱 실패 — GA:${s.url} GSC:${site}`);
    continue;
  }
  const ok = gsc.kind === 'domain' || gsc.scheme === ga.scheme;
  substantive++; // 실제 GA↔GSC 스킴 문자열을 비교했다 — 실질 검증.
  report(ok ? 'PASS' : 'FAIL', `${s.displayName}: GSC 스킴 정합`, `${s.url} → ${site}`);
}
// GSC에 검증된 사이트가 있는데 단 하나도 매칭되지 않았다면 matchSites 회귀를 의심해야 한다.
if (gscSites.length > 0 && gscChecked === 0) {
  report('FAIL', 'GSC 매칭 전멸',
    `GSC에 ${gscSites.length}개 사이트가 있는데 매칭된 속성이 0개 — matchSites 회귀 의심`);
}

console.log(`\n${tally.PASS} PASS / ${tally.FAIL} FAIL / ${tally.SKIP} SKIP / ${tally.GUARD} GUARD`);
console.log(`실질 검증(substantive): ${substantive}건`);
if (tally.FAIL > 0) {
  console.log(`❌ 실패: ${fails.join(', ')}`);
  process.exit(1);
}
// 아무것도 실제로 검증하지 못한 실행은 성공이 아니다 — 거짓 확신 방지. tally.PASS는 구성상
// 항상 참인 GUARD성 검사나 전량 0 비교로도 부풀 수 있으므로, 이 백스톱은 tally.PASS가 아니라
// substantive(실제로 0이 아닌 무언가를 비교한 횟수)를 기준으로 한다.
if (substantive === 0) {
  console.log('❌ 실질적으로 검증된 항목이 0건 — 이 실행은 아무것도 확인하지 못했습니다.');
  process.exit(1);
}
console.log('✅ 전부 PASS');
