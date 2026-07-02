import { describe, it, expect } from 'vitest';
import { mapBreakdownRows, mapDailyMetricsRows } from './ga';

describe('mapBreakdownRows', () => {
  it('dimension + metric 값을 {name, value}로 매핑', () => {
    expect(
      mapBreakdownRows([
        { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '120' }] },
        { dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '45' }] },
      ]),
    ).toEqual([
      { name: 'Organic Search', value: 120 },
      { name: 'Direct', value: 45 },
    ]);
  });

  it('이름 누락은 (not set), 값 누락은 0', () => {
    expect(mapBreakdownRows([{}])).toEqual([{ name: '(not set)', value: 0 }]);
  });

  it('null/undefined rows는 빈 배열', () => {
    expect(mapBreakdownRows(null)).toEqual([]);
    expect(mapBreakdownRows(undefined)).toEqual([]);
  });
});

describe('mapDailyMetricsRows', () => {
  const base = [
    { dimensionValues: [{ value: '20260101' }], metricValues: [{ value: '10' }, { value: '20' }, { value: '2' }] },
    { dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '5' }, { value: '9' }, { value: '1' }] },
  ];
  const ai = [{ dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '3' }] }];
  const days = ['20260101', '20260102', '20260103'];

  it('merges base + AI reports by day, zero-fills the range, and dashes dates', () => {
    expect(mapDailyMetricsRows(base, ai, days)).toEqual([
      { date: '2026-01-01', metrics: { activeUsers: 10, sessions: 20, keyEvents: 2, aiSessions: 0 } },
      { date: '2026-01-02', metrics: { activeUsers: 5, sessions: 9, keyEvents: 1, aiSessions: 3 } },
      { date: '2026-01-03', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
  });
  it('handles null report rows', () => {
    expect(mapDailyMetricsRows(null, null, ['20260101'])).toEqual([
      { date: '2026-01-01', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
  });
});
