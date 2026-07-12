/**
 * 실 GA를 호출해 정확도를 심층 검증하는 릴리스 게이트. `npm run verify:accuracy`.
 * 사용자 OAuth 토큰이 필요하므로 CI가 아니라 로컬에서 돌린다. 실패가 하나라도 있으면 exit 1.
 */
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { getClient } from '../src/auth';
import { listProperties, fetchRange, fetchAiSessions, fetchDailyMetrics, listSiteUrls } from '../src/ga';
import { gaRanges, gaHistoryRange } from '../src/periods';
import { checkIntegrity } from '../src/integrity';
import { loadGaHistory } from '../src/ga-store';
import { listGscSites, matchSites, parseSite } from '../src/gsc';
import { GA_HISTORY_FETCH_DAYS, GA_HISTORY_STORE_PATH, PERIODS } from '../src/config';

type Outcome = 'PASS' | 'FAIL' | 'SKIP';
const tally = { PASS: 0, FAIL: 0, SKIP: 0 };
const fails: string[] = [];
function report(outcome: Outcome, what: string, detail = ''): void {
  tally[outcome]++;
  if (outcome === 'FAIL') fails.push(what);
  console.log(`${outcome.padEnd(4)}  ${what}${detail ? `  — ${detail}` : ''}`);
}

const auth = await getClient();
// src/ga.ts's Data API client isn't exported, so this script builds its own — same
// auth-bridging cast src/ga.ts uses internally (see its gaOptions helper). Used only
// for the non-circular timezone check below (1b).
const dataClient = new BetaAnalyticsDataClient({ authClient: auth as never, fallback: true });
const props = await listProperties(auth);
console.log(`속성 ${props.length}개 검증\n`);

for (const p of props) {
  try {
    const daily = await fetchDailyMetrics(auth, p.propertyId, gaHistoryRange(GA_HISTORY_FETCH_DAYS), GA_HISTORY_FETCH_DAYS);

    // 1) 일별 시리즈: 길이·연속성 (형태 회귀 가드)
    // 주의: 아래 두 검사는 현재 코드에서는 구조적으로 항상 참이다 — fetchDailyMetrics가
    // expectedDaysInZone이 만든 날짜 목록을 map하기 때문. 즉 GA의 동작을 검증하는 게 아니라,
    // 0-채움을 없애는 회귀(과거에 실제로 발생)를 막는 가드다. 진짜 GA 동작 검증은 아래
    // checkIntegrity 불변식과 'GA yesterday 대조'가 한다.
    report(daily.length === GA_HISTORY_FETCH_DAYS ? 'PASS' : 'FAIL', `${p.displayName}: 일별 ${GA_HISTORY_FETCH_DAYS}일 (형태 회귀 가드)`, `${daily.length}행`);
    let contiguous = true;
    for (let i = 1; i < daily.length; i++) {
      const a = Date.parse(`${(daily[i - 1] as { date: string }).date}T00:00:00Z`);
      const b = Date.parse(`${(daily[i] as { date: string }).date}T00:00:00Z`);
      if (b - a !== 86_400_000) contiguous = false;
    }
    report(contiguous ? 'PASS' : 'FAIL', `${p.displayName}: 날짜 연속 (형태 회귀 가드)`);

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
    if (!gaYmd || !ourLast) {
      report('SKIP', `${p.displayName}: GA 'yesterday' 대조`, 'GA가 해당 날짜 행을 반환하지 않음');
    } else {
      const gaDate = `${gaYmd.slice(0, 4)}-${gaYmd.slice(4, 6)}-${gaYmd.slice(6, 8)}`;
      report(gaDate === ourLast ? 'PASS' : 'FAIL', `${p.displayName}: GA 'yesterday' == 시리즈 마지막 날`,
        `GA ${gaDate} vs 로컬 ${ourLast}`);
    }

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
      report(res.ok ? 'PASS' : 'FAIL', `${p.displayName}: 교차검증 ${period}일`, res.mismatches.join(', '));
    }

    // 3) 저장 이력 드리프트: 겹치는 날짜의 값이 신규 조회와 일치하는가
    const store = await loadGaHistory(GA_HISTORY_STORE_PATH);
    const stored = store.byProperty[p.propertyId]?.days ?? {};
    const overlapping = daily.filter((d) => stored[d.date] !== undefined);
    const drift = overlapping.filter((d) => {
      const s = stored[d.date] as { sessions: number; keyEvents: number };
      return s.sessions !== d.metrics.sessions || s.keyEvents !== d.metrics.keyEvents;
    });
    if (overlapping.length === 0) {
      report('SKIP', `${p.displayName}: 저장 이력 드리프트`, '겹치는 저장 날짜 0일 (첫 실행/신규 속성)');
    } else {
      report(drift.length === 0 ? 'PASS' : 'FAIL', `${p.displayName}: 저장 이력 드리프트`,
        `${overlapping.length}일 비교, ${drift.length}일 불일치`);
    }
  } catch (e) {
    report('FAIL', `${p.displayName}: 조회 실패`, e instanceof Error ? e.message : String(e));
  }
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
  report(ok ? 'PASS' : 'FAIL', `${s.displayName}: GSC 스킴 정합`, `${s.url} → ${site}`);
}
// GSC에 검증된 사이트가 있는데 단 하나도 매칭되지 않았다면 matchSites 회귀를 의심해야 한다.
if (gscSites.length > 0 && gscChecked === 0) {
  report('FAIL', 'GSC 매칭 전멸',
    `GSC에 ${gscSites.length}개 사이트가 있는데 매칭된 속성이 0개 — matchSites 회귀 의심`);
}

console.log(`\n${tally.PASS} PASS / ${tally.FAIL} FAIL / ${tally.SKIP} SKIP`);
if (tally.FAIL > 0) {
  console.log(`❌ 실패: ${fails.join(', ')}`);
  process.exit(1);
}
// 아무것도 실제로 검증하지 못한 실행은 성공이 아니다 — 거짓 확신 방지.
if (tally.PASS === 0) {
  console.log('❌ 검증된 항목이 0건 — 게이트가 아무것도 확인하지 못했습니다.');
  process.exit(1);
}
console.log('✅ 전부 PASS');
