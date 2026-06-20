import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyStore, upsertDays, putSnapshot, summarize, saveStore, loadStore } from './github-store';

describe('upsertDays', () => {
  it('is idempotent for the same day — latest wins, no duplicate entry', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 10, uniqueViews: 4 }], [], 90, 't1');
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 12, uniqueViews: 5 }], [], 90, 't2');
    expect(s.byRepo['o/r']?.days['2026-06-19']).toEqual({ views: 12, uniqueViews: 5, clones: 0, uniqueClones: 0 });
    expect(Object.keys(s.byRepo['o/r']?.days ?? {})).toHaveLength(1);
    expect(s.lastRunAt).toBe('t2');
  });

  it('merges overlapping 14-day windows (backfill) into a union of dates', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-10', views: 1, uniqueViews: 1 }, { date: '2026-06-11', views: 2, uniqueViews: 1 }], [], 90, 't1');
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-11', views: 2, uniqueViews: 1 }, { date: '2026-06-12', views: 3, uniqueViews: 1 }], [], 90, 't2');
    expect(Object.keys(s.byRepo['o/r']?.days ?? {}).sort()).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
  });

  it('merges views and clones for the same day', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 10, uniqueViews: 4 }], [{ date: '2026-06-19', clones: 3, uniqueClones: 2 }], 90, 't1');
    expect(s.byRepo['o/r']?.days['2026-06-19']).toEqual({ views: 10, uniqueViews: 4, clones: 3, uniqueClones: 2 });
  });

  it('keeps only the newest `retention` days', () => {
    let s = emptyStore();
    const days = ['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'].map((date, i) => ({ date, views: i, uniqueViews: 0 }));
    s = upsertDays(s, 'o/r', 'r', days, [], 2, 't1');
    expect(Object.keys(s.byRepo['o/r']?.days ?? {}).sort()).toEqual(['2026-06-12', '2026-06-13']);
  });
});

describe('putSnapshot', () => {
  it('replaces referrers/paths wholesale and stamps snapshotAt', () => {
    let s = emptyStore();
    s = upsertDays(s, 'o/r', 'r', [{ date: '2026-06-19', views: 1, uniqueViews: 1 }], [], 90, 't1');
    s = putSnapshot(s, 'o/r', 'r', [{ referrer: 'github.com', count: 5, uniques: 2 }], [{ path: '/x', title: 'X', count: 9, uniques: 3 }], 't2');
    expect(s.byRepo['o/r']?.referrers[0]?.referrer).toBe('github.com');
    expect(s.byRepo['o/r']?.paths[0]?.path).toBe('/x');
    expect(s.byRepo['o/r']?.snapshotAt).toBe('t2');
  });
});

describe('summarize', () => {
  it('totals the last 14 days and builds a daily-views trend', () => {
    let s = emptyStore();
    const days = Array.from({ length: 3 }, (_, i) => ({ date: `2026-06-1${i}`, views: (i + 1) * 10, uniqueViews: i + 1 }));
    s = upsertDays(s, 'o/r', 'r', days, [], 90, 't1');
    const sum = summarize(s, 30)[0];
    expect(sum?.fullName).toBe('o/r');
    expect(sum?.totals14d).toEqual({ views: 60, uniqueViews: 6, clones: 0, uniqueClones: 0 });
    expect(sum?.trend).toEqual([10, 20, 30]);
  });
});

describe('saveStore / loadStore', () => {
  it('round-trips a store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sitedeck-gh-'));
    try {
      const file = path.join(dir, 'nested', 'github.json');
      const store = upsertDays(emptyStore(), 'o/r', 'r', [{ date: '2026-06-19', views: 1, uniqueViews: 1 }], [], 90, 't1');
      await saveStore(file, store);
      expect(await loadStore(file)).toEqual(store);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
