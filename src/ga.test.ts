import { describe, it, expect } from 'vitest';
import { mapBreakdownRows, mapDailyMetricsRows, pickTopValue } from './ga';
import { mapDataQuality, mapTopValue } from './ga';

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
    // keepEmptyRows:true 이므로 0인 날도 리포트에 포함되어 들어온다.
    { dimensionValues: [{ value: '20260103' }], metricValues: [{ value: '0' }, { value: '0' }, { value: '0' }] },
  ];
  const ai = [{ dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '3' }] }];

  it('base+AI를 날짜별 병합(날짜는 리포트에서 도출)하고 YYYY-MM-DD로 변환', () => {
    expect(mapDailyMetricsRows(base, ai)).toEqual([
      { date: '2026-01-01', metrics: { activeUsers: 10, sessions: 20, keyEvents: 2, aiSessions: 0 } },
      { date: '2026-01-02', metrics: { activeUsers: 5, sessions: 9, keyEvents: 1, aiSessions: 3 } },
      { date: '2026-01-03', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
  });

  it('두 리포트가 비면 빈 배열', () => {
    expect(mapDailyMetricsRows(null, null)).toEqual([]);
  });
});

describe('pickTopValue', () => {
  it('(other)/(not set)를 건너뛰고 첫 유효 값을 고른다', () => {
    expect(pickTopValue([
      { dimensionValues: [{ value: '(other)' }] },
      { dimensionValues: [{ value: '/home' }] },
    ])).toBe('/home');
  });
  it('전부 (other)/(not set)면 null', () => {
    expect(pickTopValue([{ dimensionValues: [{ value: '(not set)' }] }, { dimensionValues: [{ value: '(other)' }] }])).toBe(null);
    expect(pickTopValue([])).toBe(null);
    expect(pickTopValue(null)).toBe(null);
  });
});

describe('mapBreakdownRows — (other) 제외', () => {
  it('(other) 집계행을 버린다', () => {
    expect(mapBreakdownRows([
      { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '120' }] },
      { dimensionValues: [{ value: '(other)' }], metricValues: [{ value: '80' }] },
    ])).toEqual([{ name: 'Organic Search', value: 120 }]);
  });
});

describe('mapDataQuality', () => {
  it('샘플링·임계·기타행 손실 플래그', () => {
    expect(mapDataQuality({ samplingMetadatas: [{}], subjectToThresholding: true, dataLossFromOtherRow: true }))
      .toEqual({ sampled: true, thresholded: true, otherRow: true });
  });
  it('없거나 빈 metadata는 전부 false', () => {
    expect(mapDataQuality(undefined)).toEqual({ sampled: false, thresholded: false, otherRow: false });
    expect(mapDataQuality({ samplingMetadatas: [] })).toEqual({ sampled: false, thresholded: false, otherRow: false });
  });
  it('otherRow은 dataLossFromOtherRow 단독 필드에서도 유래(다른 플래그와 독립) — 이 값이 진짜인지가 FIX 1의 핵심', () => {
    expect(mapDataQuality({ dataLossFromOtherRow: true }).otherRow).toBe(true);
    expect(mapDataQuality({}).otherRow).toBe(false);
  });
});

describe('mapTopValue — fetchTopValue의 {value, otherRow} 합성(순수부, GA 클라이언트 없이 테스트)', () => {
  it('rows에서 상위 값을, metadata에서 otherRow를 뽑아 하나로 합성', () => {
    expect(
      mapTopValue(
        [{ dimensionValues: [{ value: '(other)' }] }, { dimensionValues: [{ value: '/home' }] }],
        { dataLossFromOtherRow: true },
      ),
    ).toEqual({ value: '/home', otherRow: true });
  });
  it('픽된 값이 (other)가 아니어도, 리포트 metadata가 롱테일 손실을 알리면 otherRow는 true — ' +
    '이전에는 fetchTopValue가 string만 반환해 이 신호가 통째로 버려졌다', () => {
    expect(mapTopValue([{ dimensionValues: [{ value: '/home' }] }], { dataLossFromOtherRow: true }))
      .toEqual({ value: '/home', otherRow: true });
  });
  it('metadata 없으면 otherRow는 false', () => {
    expect(mapTopValue([{ dimensionValues: [{ value: '(other)' }] }], undefined)).toEqual({ value: null, otherRow: false });
  });
});
