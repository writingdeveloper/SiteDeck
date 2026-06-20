import { describe, it, expect } from 'vitest';
import { parseViews, parseClones, parseReferrers, parsePaths } from './github';

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
