import { describe, it, expect } from 'vitest';
import {
  emptyGaHistory, upsertDailyMetrics, weeklySeries, wow, consecutiveDeclineWeeks, historyDigest,
} from './ga-store';

const M = (activeUsers: number, sessions = 0, keyEvents = 0, aiSessions = 0) => ({ activeUsers, sessions, keyEvents, aiSessions });
// n consecutive days ending at `end` (YYYY-MM-DD), each with activeUsers=values[i].
function daysStore(propertyId: string, end: string, values: number[]) {
  let store = emptyGaHistory();
  const series = values.map((v, i) => {
    const d = new Date(Date.parse(`${end}T00:00:00Z`) - (values.length - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date: d, metrics: M(v) };
  });
  store = upsertDailyMetrics(store, propertyId, series, 400);
  return store;
}

describe('upsertDailyMetrics', () => {
  it('merges by date (latest wins) and trims to retention', () => {
    let s = emptyGaHistory();
    s = upsertDailyMetrics(s, '1', [{ date: '2026-01-01', metrics: M(5) }, { date: '2026-01-02', metrics: M(6) }], 400);
    s = upsertDailyMetrics(s, '1', [{ date: '2026-01-02', metrics: M(9) }], 400); // overwrite
    expect(s.byProperty['1']?.days['2026-01-02']).toEqual(M(9));
    expect(Object.keys(s.byProperty['1']?.days ?? {})).toHaveLength(2);
  });
  it('keeps only the newest `retention` days', () => {
    let s = emptyGaHistory();
    const many = Array.from({ length: 10 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, metrics: M(i) }));
    s = upsertDailyMetrics(s, '1', many, 3);
    expect(Object.keys(s.byProperty['1']?.days ?? {}).sort()).toEqual(['2026-01-08', '2026-01-09', '2026-01-10']);
  });
});

describe('weeklySeries', () => {
  it('sums into 7-day buckets ending at the latest day (oldest→newest)', () => {
    // 14 days: first week all 1 (sum 7), second week all 2 (sum 14).
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(1), ...Array(7).fill(2)]);
    expect(weeklySeries(s, '1', 'activeUsers', 2)).toEqual([7, 14]);
  });
  it('zero-fills weeks with no data', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(3)]); // only the latest week has data
    expect(weeklySeries(s, '1', 'activeUsers', 2)).toEqual([0, 21]);
  });
});

describe('wow', () => {
  it('compares the latest 7 days vs the previous 7', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(10), ...Array(7).fill(5)]); // prev 70, cur 35
    expect(wow(s, '1', 'activeUsers')).toEqual({ current: 35, previous: 70, deltaPct: -50 });
  });
  it('returns deltaPct null when the previous week is zero', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(0), ...Array(7).fill(5)]);
    expect(wow(s, '1', 'activeUsers').deltaPct).toBeNull();
  });
});

describe('consecutiveDeclineWeeks', () => {
  it('counts trailing weeks each below the prior week', () => {
    // weekly sums (oldest→newest): 70,70,63,49,35 → last three decline (70→63→49→35)
    const s = daysStore('1', '2026-03-07', [
      ...Array(7).fill(10), ...Array(7).fill(10), ...Array(7).fill(9), ...Array(7).fill(7), ...Array(7).fill(5),
    ]);
    expect(consecutiveDeclineWeeks(s, '1', 'activeUsers')).toBe(3);
  });
  it('returns 0 with fewer than two weeks or no volume', () => {
    expect(consecutiveDeclineWeeks(daysStore('1', '2026-03-07', [1, 2, 3]), '1', 'activeUsers')).toBe(0);
    expect(consecutiveDeclineWeeks(emptyGaHistory(), 'x', 'activeUsers')).toBe(0);
  });
});

describe('historyDigest', () => {
  it('returns null for a property with no days', () => {
    expect(historyDigest(emptyGaHistory(), 'x')).toBeNull();
  });
  it('exposes per-metric WoW deltaPct and activeUsers declineWeeks', () => {
    const s = daysStore('1', '2026-02-14', [...Array(7).fill(10), ...Array(7).fill(5)]);
    const d = historyDigest(s, '1');
    expect(d?.wow.activeUsers).toBe(-50);
    expect(typeof d?.declineWeeks).toBe('number');
  });
});
