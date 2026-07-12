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
  const expected3 = ['2026-01-01', '2026-01-02', '2026-01-03'];
  const base = [
    { dimensionValues: [{ value: '20260101' }], metricValues: [{ value: '10' }, { value: '20' }, { value: '2' }] },
    { dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '5' }, { value: '9' }, { value: '1' }] },
    // keepEmptyRows:true인 날도 실제로 행이 온 경우: 명시적 0.
    { dimensionValues: [{ value: '20260103' }], metricValues: [{ value: '0' }, { value: '0' }, { value: '0' }] },
  ];
  const ai = [{ dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '3' }] }];

  it('base+AI를 expected 날짜 목록 기준으로 병합하고 YYYY-MM-DD로 변환', () => {
    expect(mapDailyMetricsRows(base, ai, expected3)).toEqual([
      { date: '2026-01-01', metrics: { activeUsers: 10, sessions: 20, keyEvents: 2, aiSessions: 0 } },
      { date: '2026-01-02', metrics: { activeUsers: 5, sessions: 9, keyEvents: 1, aiSessions: 3 } },
      { date: '2026-01-03', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
  });

  it('expected가 비면 리포트 내용과 무관하게 빈 배열', () => {
    expect(mapDailyMetricsRows(base, ai, [])).toEqual([]);
    expect(mapDailyMetricsRows(null, null, [])).toEqual([]);
  });

  it('GA가 희소한 행만 반환해도(중간 공백 + 말미 누락) expected 전체를 0으로 채워 반환 — keepEmptyRows 회귀 재현', () => {
    // 실측: keepEmptyRows:true여도 GA가 요청 범위의 모든 날짜에 행을 채워 돌려주지 않는다
    // (30일 요청에 21행, 8행 등). base/ai 리포트 모두 2026-02-02(중간)와 2026-02-05(말미)를
    // 완전히 누락시킨 상황을 재현한다 — 출력은 여전히 expected와 같은 길이의 연속 5일이어야 한다.
    const expected5 = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'];
    const sparseBase = [
      { dimensionValues: [{ value: '20260201' }], metricValues: [{ value: '10' }, { value: '20' }, { value: '2' }] },
      // 20260202: GA 응답에서 통째로 누락 (중간 공백)
      { dimensionValues: [{ value: '20260203' }], metricValues: [{ value: '3' }, { value: '4' }, { value: '1' }] },
      { dimensionValues: [{ value: '20260204' }], metricValues: [{ value: '7' }, { value: '8' }, { value: '0' }] },
      // 20260205: GA 응답에서 통째로 누락 (말미 누락)
    ];
    const sparseAi = [
      { dimensionValues: [{ value: '20260201' }], metricValues: [{ value: '5' }] },
      { dimensionValues: [{ value: '20260204' }], metricValues: [{ value: '2' }] },
    ];

    expect(mapDailyMetricsRows(sparseBase, sparseAi, expected5)).toEqual([
      { date: '2026-02-01', metrics: { activeUsers: 10, sessions: 20, keyEvents: 2, aiSessions: 5 } },
      { date: '2026-02-02', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
      { date: '2026-02-03', metrics: { activeUsers: 3, sessions: 4, keyEvents: 1, aiSessions: 0 } },
      { date: '2026-02-04', metrics: { activeUsers: 7, sessions: 8, keyEvents: 0, aiSessions: 2 } },
      { date: '2026-02-05', metrics: { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 } },
    ]);
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
