import type { PsiScores } from './psi';
import { loadJsonStore, saveJsonStore } from './store-io';

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

export function loadStore(filePath: string): Promise<InsightsStore> {
  return loadJsonStore<InsightsStore>(filePath, emptyStore, (p) => Boolean((p as { byUrl?: unknown }).byUrl));
}

export function saveStore(filePath: string, store: InsightsStore): Promise<void> {
  return saveJsonStore(filePath, store);
}
