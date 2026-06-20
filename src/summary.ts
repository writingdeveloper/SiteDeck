/** A metric's current vs previous value plus its percentage change. */
export interface MetricDelta {
  current: number;
  previous: number;
  /** Percentage change, rounded to 2 decimals. `null` when previous is 0. */
  deltaPct: number | null;
}

/** Google Search Console metrics for a property's matched verified site. */
export interface SearchMetrics {
  clicks: number;
  impressions: number;
  /** Average position (1 = top of results). 0 when there were no impressions. */
  position: number;
}

export interface SiteSummary {
  propertyId: string;
  displayName: string;
  activeUsers: MetricDelta;
  sessions: MetricDelta;
  keyEvents: MetricDelta;
  /** Sessions referred by AI answer engines (ChatGPT, Perplexity, Gemini, …). */
  aiSessions: MetricDelta;
  trend: number[];
  topPage: string | null;
  topSource: string | null;
  /** Search Console metrics for the matched verified site; null when none/ungranted. */
  search: SearchMetrics | null;
}

/**
 * Percentage change from `previous` to `current`, rounded to 2 decimals.
 * Returns null when `previous` is 0 (the change is mathematically undefined).
 */
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  return Math.round(pct * 100) / 100;
}

export function metricDelta(current: number, previous: number): MetricDelta {
  return { current, previous, deltaPct: deltaPct(current, previous) };
}
