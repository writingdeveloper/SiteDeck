import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseViews,
  parseClones,
  parseReferrers,
  parsePaths,
  fetchRepoTraffic,
  parseRepo,
  parseAccessibleRepos,
  fetchAccessibleRepos,
  REPO_MAX_PAGES,
} from './github';

afterEach(() => vi.unstubAllGlobals());

function stubGh(byUrl: (url: string) => unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', (input: unknown) =>
    Promise.resolve({ ok, status, statusText: 'x', json: async () => byUrl(String(input)) } as unknown as Response),
  );
}

describe('parseRepo', () => {
  it('parses a well-formed owner/repo', () => {
    expect(parseRepo('writingdeveloper/SiteDeck')).toEqual({ owner: 'writingdeveloper', repo: 'SiteDeck' });
  });

  it('rejects anything that is not exactly owner/repo (so a stray path segment is flagged, not silently mis-measured)', () => {
    expect(parseRepo('writingdeveloper/SiteDeck/tree/main')).toBeNull();
    expect(parseRepo('noslash')).toBeNull();
    expect(parseRepo('/repo')).toBeNull();
    expect(parseRepo('owner/')).toBeNull();
    expect(parseRepo('')).toBeNull();
  });
});

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

describe('parseAccessibleRepos', () => {
  const repo = (over: Record<string, unknown>) => ({
    full_name: 'o/r',
    private: false,
    fork: false,
    archived: false,
    pushed_at: '2026-07-01T00:00:00Z',
    permissions: { admin: true },
    ...over,
  });

  it('keeps only admin, non-archived repos — the ones traffic can actually be read for', () => {
    const out = parseAccessibleRepos([
      repo({ full_name: 'o/admin' }),
      repo({ full_name: 'o/readonly', permissions: { admin: false } }),
      repo({ full_name: 'o/archived', archived: true }),
      repo({ full_name: 'o/nopermissions', permissions: undefined }),
    ]);
    expect(out.map((r) => r.fullName)).toEqual(['o/admin']);
  });

  it('sorts most-recently-pushed first so the useful repos head a long list', () => {
    const out = parseAccessibleRepos([
      repo({ full_name: 'o/old', pushed_at: '2024-01-01T00:00:00Z' }),
      repo({ full_name: 'o/new', pushed_at: '2026-07-20T00:00:00Z' }),
      repo({ full_name: 'o/mid', pushed_at: '2025-06-01T00:00:00Z' }),
    ]);
    expect(out.map((r) => r.fullName)).toEqual(['o/new', 'o/mid', 'o/old']);
  });

  it('carries the private/fork flags the picker labels rows with', () => {
    const out = parseAccessibleRepos([repo({ full_name: 'o/p', private: true, fork: true })]);
    expect(out[0]).toMatchObject({ fullName: 'o/p', private: true, fork: true });
  });

  it('drops malformed entries and survives a non-array body', () => {
    expect(parseAccessibleRepos([repo({ full_name: 'noslash' }), repo({ full_name: undefined })])).toEqual([]);
    expect(parseAccessibleRepos(null)).toEqual([]);
    expect(parseAccessibleRepos({ message: 'Bad credentials' })).toEqual([]);
  });
});

describe('fetchAccessibleRepos', () => {
  it('stops at a short page and reports no truncation', async () => {
    const pages: unknown[][] = [[{ full_name: 'o/a', permissions: { admin: true }, pushed_at: '2026-07-01T00:00:00Z' }]];
    stubGh(() => pages[0]);
    const { repos, truncated } = await fetchAccessibleRepos('tok');
    expect(repos.map((r) => r.fullName)).toEqual(['o/a']);
    expect(truncated).toBe(false);
  });

  it('reports truncated=true rather than silently capping at the page limit', async () => {
    // Always a FULL page → paging never terminates on its own; the cap must own that.
    const full = Array.from({ length: 100 }, (_, i) => ({
      full_name: `o/r${i}`,
      permissions: { admin: true },
      pushed_at: '2026-07-01T00:00:00Z',
    }));
    stubGh(() => full);
    const { repos, truncated } = await fetchAccessibleRepos('tok');
    expect(truncated).toBe(true);
    expect(repos).toHaveLength(100 * REPO_MAX_PAGES);
  });
});
