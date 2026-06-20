import { readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeJsonAtomic } from './atomic';
import type { DayViews, DayClones, Referrer, PathStat } from './github';

export interface DayCount {
  views: number;
  uniqueViews: number;
  clones: number;
  uniqueClones: number;
}
export interface RepoEntry {
  displayName: string;
  days: Record<string, DayCount>;
  referrers: Referrer[];
  paths: PathStat[];
  snapshotAt: string | null;
}
export interface GithubStore {
  version: number;
  lastRunAt: string | null;
  byRepo: Record<string, RepoEntry>;
}
export interface RepoSummary {
  fullName: string;
  displayName: string;
  totals14d: DayCount;
  trend: number[];
  referrers: Referrer[];
  paths: PathStat[];
  snapshotAt: string | null;
}

const ZERO: DayCount = { views: 0, uniqueViews: 0, clones: 0, uniqueClones: 0 };

export function emptyStore(): GithubStore {
  return { version: 1, lastRunAt: null, byRepo: {} };
}

/**
 * Upsert per-day views/clones into a repo by calendar date. Re-runs and overlapping
 * 14-day windows are idempotent (the latest value for a date wins — never summed),
 * so backfilling after the app was offline (<14 days) merges cleanly. Keeps only the
 * newest `retention` calendar days.
 */
export function upsertDays(
  store: GithubStore,
  fullName: string,
  displayName: string,
  views: DayViews[],
  clones: DayClones[],
  retention: number,
  ts: string,
): GithubStore {
  const prev = store.byRepo[fullName];
  const days: Record<string, DayCount> = { ...(prev?.days ?? {}) };
  for (const v of views) {
    days[v.date] = { ...(days[v.date] ?? ZERO), views: v.views, uniqueViews: v.uniqueViews };
  }
  for (const c of clones) {
    days[c.date] = { ...(days[c.date] ?? ZERO), clones: c.clones, uniqueClones: c.uniqueClones };
  }
  const trimmed: Record<string, DayCount> = {};
  for (const date of Object.keys(days).sort().slice(-retention)) {
    trimmed[date] = days[date] as DayCount;
  }
  return {
    ...store,
    lastRunAt: ts,
    byRepo: {
      ...store.byRepo,
      [fullName]: {
        displayName,
        days: trimmed,
        referrers: prev?.referrers ?? [],
        paths: prev?.paths ?? [],
        snapshotAt: prev?.snapshotAt ?? null,
      },
    },
  };
}

/** Replace the live 14-day referrers/paths snapshot for a repo (not accumulated). */
export function putSnapshot(
  store: GithubStore,
  fullName: string,
  displayName: string,
  referrers: Referrer[],
  paths: PathStat[],
  snapshotAt: string,
): GithubStore {
  const prev = store.byRepo[fullName] ?? { displayName, days: {}, referrers: [], paths: [], snapshotAt: null };
  return { ...store, byRepo: { ...store.byRepo, [fullName]: { ...prev, displayName, referrers, paths, snapshotAt } } };
}

export function summarize(store: GithubStore, trendLength: number): RepoSummary[] {
  return Object.entries(store.byRepo).map(([fullName, entry]) => {
    const dates = Object.keys(entry.days).sort();
    const totals14d = dates.slice(-14).reduce<DayCount>((acc, d) => {
      const day = entry.days[d] as DayCount;
      return {
        views: acc.views + day.views,
        uniqueViews: acc.uniqueViews + day.uniqueViews,
        clones: acc.clones + day.clones,
        uniqueClones: acc.uniqueClones + day.uniqueClones,
      };
    }, { ...ZERO });
    const trend = dates.slice(-trendLength).map((d) => (entry.days[d] as DayCount).views);
    return { fullName, displayName: entry.displayName, totals14d, trend, referrers: entry.referrers, paths: entry.paths, snapshotAt: entry.snapshotAt };
  });
}

export async function loadStore(filePath: string): Promise<GithubStore> {
  if (!existsSync(filePath)) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as GithubStore;
    if (parsed && typeof parsed === 'object' && parsed.byRepo) return parsed;
    throw new Error('bad shape');
  } catch {
    await rename(filePath, `${filePath}.bak`).catch(() => {});
    return emptyStore();
  }
}

export async function saveStore(filePath: string, store: GithubStore): Promise<void> {
  await writeJsonAtomic(filePath, store);
}
