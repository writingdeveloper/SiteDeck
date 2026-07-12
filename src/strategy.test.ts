import { describe, it, expect } from 'vitest';
import { analyzeSite } from '../public/strategy.js';

// MetricDelta 빌더.
function md(current: number, deltaPct: number | null = 0) {
  return { current, previous: 0, deltaPct };
}
// 기본값은 "전부 양호"(어떤 규칙도 발화 안 함)인 사이트.
function site(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: '1',
    displayName: 'X',
    activeUsers: md(1000, 5),
    sessions: md(2000, 5),
    keyEvents: md(100, 5), // 5% 전환율
    aiSessions: md(200, 5), // 10% AI 비중
    trend: [10, 11, 12, 13, 14],
    topPage: '/',
    topSource: 'Organic',
    search: { clicks: 50, impressions: 500, position: 5 }, // 10% CTR, 5위
    history: null,
    ...overrides,
  };
}

describe('analyzeSite', () => {
  it('건강한 사이트는 all-good 하나만 반환', () => {
    const f = analyzeSite(site());
    expect(f).toEqual([{ id: 'all-good', severity: 'good', params: {} }]);
  });

  it('활성 사용자 급락 → delta-drop(high)', () => {
    const f = analyzeSite(site({ activeUsers: md(700, -30) }));
    expect(f.some((x) => x.id === 'delta-drop' && x.severity === 'high')).toBe(true);
  });

  it('하락 추세 → trend-down(high)', () => {
    const f = analyzeSite(site({ trend: [100, 80, 60, 40, 20] }));
    expect(f.some((x) => x.id === 'trend-down')).toBe(true);
  });

  it('AI 비중 낮음 → ai-share-low(medium)', () => {
    const f = analyzeSite(site({ aiSessions: md(10, 0) })); // 0.5%
    expect(f.some((x) => x.id === 'ai-share-low' && x.severity === 'medium')).toBe(true);
  });

  it('CTR 낮음 → ctr-low', () => {
    const f = analyzeSite(site({ search: { clicks: 5, impressions: 1000, position: 5 } }));
    expect(f.some((x) => x.id === 'ctr-low')).toBe(true);
  });

  it('평균 순위 나쁨 → position-weak(low)', () => {
    const f = analyzeSite(site({ search: { clicks: 50, impressions: 1000, position: 25 } }));
    expect(f.some((x) => x.id === 'position-weak' && x.severity === 'low')).toBe(true);
  });

  it('전환율 낮음 → conversion-low', () => {
    const f = analyzeSite(site({ keyEvents: md(5, 0) })); // 0.25%
    expect(f.some((x) => x.id === 'conversion-low')).toBe(true);
  });

  it('핵심 이벤트가 0이면 측정 미설정(key-events-unset)으로 진단하고 conversion-low는 내지 않음', () => {
    const f = analyzeSite(site({ keyEvents: md(0, null) }));
    expect(f.some((x) => x.id === 'key-events-unset' && x.severity === 'low')).toBe(true);
    expect(f.some((x) => x.id === 'conversion-low')).toBe(false);
  });

  it('세션이 적으면 key-events-unset도 내지 않음(신호 부족)', () => {
    const f = analyzeSite(site({ sessions: md(10, 0), keyEvents: md(0, null), aiSessions: md(1, 0) }));
    expect(f.some((x) => x.id === 'key-events-unset')).toBe(false);
  });

  it('상위 채널이 세션총계의 70% 초과면 channel-concentrated (분모=세션총계)', () => {
    // site()의 sessions.current = 2000; 1500/2000 = 75% > 70%
    const detail = { channels: [{ name: 'Organic', value: 1500 }, { name: 'Direct', value: 200 }] };
    expect(analyzeSite(site(), detail).some((x) => x.id === 'channel-concentrated')).toBe(true);
    expect(analyzeSite(site()).some((x) => x.id === 'channel-concentrated')).toBe(false);
  });

  it('top-5 합 기준이면 오발화했을 케이스가 세션총계 기준이면 미발화', () => {
    // 상위 채널 300은 top-5 합(360)의 83%지만 세션총계 2000 대비 15% → 미발화
    const detail = { channels: [{ name: 'Organic', value: 300 }, { name: 'Direct', value: 60 }] };
    expect(analyzeSite(site(), detail).some((x) => x.id === 'channel-concentrated')).toBe(false);
  });

  it('심각도 순으로 정렬(high가 low보다 앞)', () => {
    const f = analyzeSite(site({ activeUsers: md(700, -30), keyEvents: md(5, 0) }));
    const ids = f.map((x) => x.id);
    expect(ids.indexOf('delta-drop')).toBeLessThan(ids.indexOf('conversion-low'));
  });
});

describe('trend-decline rule', () => {
  it('fires when history.declineWeeks >= 3', () => {
    const f = analyzeSite(site({ history: { wow: {}, declineWeeks: 3 } }));
    expect(f.some((x) => x.id === 'trend-decline' && x.severity === 'medium')).toBe(true);
  });
  it('does not fire below the threshold or without history', () => {
    expect(analyzeSite(site({ history: { wow: {}, declineWeeks: 2 } })).some((x) => x.id === 'trend-decline')).toBe(false);
    expect(analyzeSite(site()).some((x) => x.id === 'trend-decline')).toBe(false);
  });
});
