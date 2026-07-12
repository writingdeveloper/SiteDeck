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
