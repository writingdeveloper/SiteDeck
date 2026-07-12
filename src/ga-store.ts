import { loadJsonStore, saveJsonStore } from './store-io';
import { deltaPct } from './summary';

export interface DayMetrics {
  activeUsers: number;
  sessions: number;
  keyEvents: number;
  aiSessions: number;
}
export type MetricKey = keyof DayMetrics;

export interface GaHistory {
  version: number;
  byProperty: Record<string, { days: Record<string, DayMetrics> }>;
}
export interface WowDelta {
  current: number;
  previous: number;
  /** null when the previous week is 0 (change is undefined) — consumers can still
   *  render "0→N" from current/previous instead of a bare dash. */
  deltaPct: number | null;
}
export interface HistoryDigest {
  wow: Record<MetricKey, WowDelta>;
  declineWeeks: number;
}

const ZERO: DayMetrics = { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0 };
const MS_PER_DAY = 86_400_000;

/** Bump when the on-disk shape changes; loadGaHistory rejects any other version. */
export const GA_HISTORY_VERSION = 1;

export function emptyGaHistory(): GaHistory {
  return { version: GA_HISTORY_VERSION, byProperty: {} };
}

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

/** Merge a daily series into a property by calendar date (latest value wins),
 *  keeping only the newest `retentionDays` days. */
export function upsertDailyMetrics(
  store: GaHistory,
  propertyId: string,
  series: { date: string; metrics: DayMetrics }[],
  retentionDays: number,
): GaHistory {
  const prev = store.byProperty[propertyId];
  const days: Record<string, DayMetrics> = { ...(prev?.days ?? {}) };
  for (const row of series) days[row.date] = row.metrics;
  const trimmed: Record<string, DayMetrics> = {};
  for (const date of Object.keys(days).sort().slice(-retentionDays)) trimmed[date] = days[date] as DayMetrics;
  return { ...store, byProperty: { ...store.byProperty, [propertyId]: { days: trimmed } } };
}

/** Contiguous daily values of `metric` for the last `count` calendar days ending at
 *  the property's latest stored date (missing days = 0), oldest→newest. */
function dailyWindow(store: GaHistory, propertyId: string, metric: MetricKey, count: number): number[] {
  const days = store.byProperty[propertyId]?.days ?? {};
  const dates = Object.keys(days).sort();
  const last = dates[dates.length - 1];
  if (!last) return [];
  return calendarDays(isoMinusDays(last, count - 1), last).map((d) => (days[d] ?? ZERO)[metric]);
}

/** Weekly sums for the last `weeks` complete 7-day buckets, oldest→newest. */
export function weeklySeries(store: GaHistory, propertyId: string, metric: MetricKey, weeks: number): number[] {
  const daily = dailyWindow(store, propertyId, metric, weeks * 7);
  const out: number[] = [];
  for (let i = 0; i < daily.length; i += 7) out.push(daily.slice(i, i + 7).reduce((a, b) => a + b, 0));
  return out;
}

/** Latest 7-day sum vs the preceding 7-day sum (deltaPct null when previous is 0). */
export function wow(store: GaHistory, propertyId: string, metric: MetricKey): WowDelta {
  const daily = dailyWindow(store, propertyId, metric, 14);
  const previous = daily.slice(0, 7).reduce((a, b) => a + b, 0);
  const current = daily.slice(7, 14).reduce((a, b) => a + b, 0);
  return { current, previous, deltaPct: deltaPct(current, previous) };
}

/** Trailing consecutive weeks each strictly below the prior week (from a >0 base). */
export function consecutiveDeclineWeeks(
  store: GaHistory,
  propertyId: string,
  metric: MetricKey,
  maxWeeks = 12,
): number {
  const w = weeklySeries(store, propertyId, metric, maxWeeks);
  let c = 0;
  for (let i = w.length - 1; i >= 1; i--) {
    const cur = w[i] as number;
    const prev = w[i - 1] as number;
    if (prev > 0 && cur < prev) c++;
    else break;
  }
  return c;
}

/** Compact per-site history summary attached to the /api/summary payload. */
export function historyDigest(store: GaHistory, propertyId: string): HistoryDigest | null {
  const days = store.byProperty[propertyId]?.days;
  if (!days || Object.keys(days).length === 0) return null;
  return {
    wow: {
      activeUsers: wow(store, propertyId, 'activeUsers'),
      sessions: wow(store, propertyId, 'sessions'),
      keyEvents: wow(store, propertyId, 'keyEvents'),
      aiSessions: wow(store, propertyId, 'aiSessions'),
    },
    declineWeeks: consecutiveDeclineWeeks(store, propertyId, 'activeUsers'),
  };
}

export function loadGaHistory(filePath: string): Promise<GaHistory> {
  return loadJsonStore<GaHistory>(
    filePath,
    emptyGaHistory,
    (p) => Boolean((p as { byProperty?: unknown }).byProperty),
    GA_HISTORY_VERSION,
  );
}
export function saveGaHistory(filePath: string, store: GaHistory): Promise<void> {
  return saveJsonStore(filePath, store);
}
