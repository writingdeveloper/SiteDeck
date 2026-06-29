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

  it('채널 집중은 detail 있을 때만 → channel-concentrated', () => {
    const detail = { channels: [{ name: 'Organic', value: 90 }, { name: 'Direct', value: 10 }] };
    expect(analyzeSite(site(), detail).some((x) => x.id === 'channel-concentrated')).toBe(true);
    expect(analyzeSite(site()).some((x) => x.id === 'channel-concentrated')).toBe(false);
  });

  it('심각도 순으로 정렬(high가 low보다 앞)', () => {
    const f = analyzeSite(site({ activeUsers: md(700, -30), keyEvents: md(5, 0) }));
    const ids = f.map((x) => x.id);
    expect(ids.indexOf('delta-drop')).toBeLessThan(ids.indexOf('conversion-low'));
  });
});
