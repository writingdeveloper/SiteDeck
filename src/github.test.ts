import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseViews, parseClones, parseReferrers, parsePaths, fetchRepoTraffic } from './github';

afterEach(() => vi.unstubAllGlobals());

function stubGh(byUrl: (url: string) => unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', (input: unknown) =>
    Promise.resolve({ ok, status, statusText: 'x', json: async () => byUrl(String(input)) } as unknown as Response),
  );
}

describe('parseViews / parseClones', () => {
  it('maps the daily timestamp to a YYYY-MM-DD date and reads count/uniques', () => {
    expect(parseViews({ views: [{ timestamp: '2026-06-19T00:00:00Z', count: 42, uniques: 8 }] })).toEqual([
      { date: '2026-06-19', views: 42, uniqueViews: 8 },
    ]);
    expect(parseClones({ clones: [{ timestamp: '2026-06-19T00:00:00Z', count: 3, uniques: 2 }] })).toEqual([
      { date: '2026-06-19', clones: 3, uniqueClones: 2 },
    ]);
  });

  it('returns an empty array for a missing/empty payload and skips rows with no timestamp', () => {
    expect(parseViews({})).toEqual([]);
    expect(parseViews({ views: [{ count: 1 }] })).toEqual([]);
    expect(parseClones(null)).toEqual([]);
  });
});

describe('parseReferrers / parsePaths', () => {
  it('normalizes referrer and path rows and drops empties', () => {
    expect(parseReferrers([{ referrer: 'github.com', count: 30, uniques: 10 }, { count: 1 }])).toEqual([
      { referrer: 'github.com', count: 30, uniques: 10 },
    ]);
    expect(parsePaths([{ path: '/x', title: 'X', count: 50, uniques: 12 }])).toEqual([
      { path: '/x', title: 'X', count: 50, uniques: 12 },
    ]);
    expect(parseReferrers(null)).toEqual([]);
  });
});

describe('fetchRepoTraffic', () => {
  it('fetches and parses all four traffic endpoints', async () => {
    stubGh((url) => {
      if (url.includes('/views')) return { views: [{ timestamp: '2026-06-19T00:00:00Z', count: 42, uniques: 8 }] };
      if (url.includes('/clones')) return { clones: [{ timestamp: '2026-06-19T00:00:00Z', count: 3, uniques: 2 }] };
      if (url.includes('/referrers')) return [{ referrer: 'github.com', count: 30, uniques: 10 }];
      if (url.includes('/paths')) return [{ path: '/x', title: 'X', count: 50, uniques: 12 }];
      return {};
    });
    const t = await fetchRepoTraffic('tok', 'writingdeveloper', 'SiteDeck');
    expect(t.views).toEqual([{ date: '2026-06-19', views: 42, uniqueViews: 8 }]);
    expect(t.clones).toEqual([{ date: '2026-06-19', clones: 3, uniqueClones: 2 }]);
    expect(t.referrers[0]?.referrer).toBe('github.com');
    expect(t.paths[0]?.path).toBe('/x');
  });

  it('throws on a non-ok response (so the runner records a per-repo error)', async () => {
    stubGh(() => ({}), false, 403);
    await expect(fetchRepoTraffic('tok', 'o', 'r')).rejects.toThrow(/403/);
  });
});
