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

const MS_PER_DAY = 86_400_000;
/** YYYY-MM-DD `n` days before `dateStr` (UTC). */
function isoMinusDays(dateStr: string, n: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - n * MS_PER_DAY).toISOString().slice(0, 10);
}
/** Every YYYY-MM-DD from `start` to `end` inclusive (UTC). */
function calendarDays(start: string, end: string): string[] {
  const out: string[] = [];
  const endT = Date.parse(`${end}T00:00:00Z`);
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= endT; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Trailing calendar days the "14d" totals cover. */
const TOTALS_WINDOW_DAYS = 14;

export function summarize(store: GithubStore, trendLength: number): RepoSummary[] {
  return Object.entries(store.byRepo).map(([fullName, entry]) => {
    const base = {
      fullName,
      displayName: entry.displayName,
      referrers: entry.referrers,
      paths: entry.paths,
      snapshotAt: entry.snapshotAt,
    };
    const dates = Object.keys(entry.days).sort();
    const last = dates[dates.length - 1];
    if (!last) return { ...base, totals14d: { ...ZERO }, trend: [] };
    // GitHub's traffic API omits zero-activity days, so stored dates are sparse. Total
    // over a contiguous CALENDAR window ending at the latest measured day (missing days
    // count as 0) rather than the last N *entries*, and zero-fill the trend — mirroring
    // ga.ts fetchDailySeries, so the "(14D)" label matches the math and the sparkline
    // doesn't silently compress its time axis.
    const totals14d = calendarDays(isoMinusDays(last, TOTALS_WINDOW_DAYS - 1), last).reduce<DayCount>(
      (acc, d) => {
        const day = entry.days[d] ?? ZERO;
        return {
          views: acc.views + day.views,
          uniqueViews: acc.uniqueViews + day.uniqueViews,
          clones: acc.clones + day.clones,
          uniqueClones: acc.uniqueClones + day.uniqueClones,
        };
      },
      { ...ZERO },
    );
    const trend = calendarDays(isoMinusDays(last, trendLength - 1), last).map((d) => (entry.days[d] ?? ZERO).views);
    return { ...base, totals14d, trend };
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
