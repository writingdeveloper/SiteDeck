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
