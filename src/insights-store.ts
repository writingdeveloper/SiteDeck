import type { PsiScores } from './psi';

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
    trend: entry.history.slice(-trendLength).map((measurement) => measurement.performance ?? 0),
  }));
}
