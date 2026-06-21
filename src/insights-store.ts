import { readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { PsiScores } from './psi';
import { writeJsonAtomic } from './atomic';

export interface Measurement extends PsiScores {
  ts: string;
}
export interface UrlEntry {
  displayName: string;
  history: Measurement[];
}
export interface InsightsStore {
  version: number;
  lastRunAt: string | null;
  byUrl: Record<string, UrlEntry>;
}
export interface InsightsSite {
  url: string;
  displayName: string;
  latest: Measurement | null;
  trend: number[];
}

export function emptyStore(): InsightsStore {
  return { version: 1, lastRunAt: null, byUrl: {} };
}

export function appendMeasurement(
  store: InsightsStore,
  url: string,
  displayName: string,
  measurement: Measurement,
  retention: number,
): InsightsStore {
  const prev = store.byUrl[url]?.history ?? [];
  const history = [...prev, measurement].slice(-retention);
  return {
    ...store,
    lastRunAt: measurement.ts,
    byUrl: { ...store.byUrl, [url]: { displayName, history } },
  };
}

export function shouldMeasure(lastRunAt: string | null, nowMs: number, intervalMs: number): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  return Number.isNaN(last) || nowMs - last >= intervalMs;
}

export function summarize(store: InsightsStore, trendLength: number): InsightsSite[] {
  return Object.entries(store.byUrl).map(([url, entry]) => ({
    url,
    displayName: entry.displayName,
    latest: entry.history[entry.history.length - 1] ?? null,
    // Only real numeric performance points — a null run must not plot as a
    // drop-to-zero (fake "perf collapsed" alarm) in the sparkline / min-max tip.
    trend: entry.history
      .slice(-trendLength)
      .map((measurement) => measurement.performance)
      .filter((p): p is number => typeof p === 'number'),
  }));
}

export async function loadStore(filePath: string): Promise<InsightsStore> {
  if (!existsSync(filePath)) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as InsightsStore;
    if (parsed && typeof parsed === 'object' && parsed.byUrl) return parsed;
    throw new Error('bad shape');
  } catch {
    await rename(filePath, `${filePath}.${Date.now()}.bak`).catch(() => {});
    return emptyStore();
  }
}

export async function saveStore(filePath: string, store: InsightsStore): Promise<void> {
  await writeJsonAtomic(filePath, store);
}
