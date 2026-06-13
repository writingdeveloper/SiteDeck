/** A metric's current vs previous value plus its percentage change. */
export interface MetricDelta {
  current: number;
  previous: number;
  /** Percentage change, rounded to 2 decimals. `null` when previous is 0. */
  deltaPct: number | null;
}

export interface SiteSummary {
  propertyId: string;
  displayName: string;
  activeUsers: MetricDelta;
  sessions: MetricDelta;
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
