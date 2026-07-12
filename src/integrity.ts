import type { DailyMetricsRow } from './ga';

/** Totals for one period (fetchRange + fetchAiSessions combined). */
export interface RangeTotals {
  activeUsers: number;
  sessions: number;
  keyEvents: number;
  aiSessions: number;
}

export interface IntegrityReport {
  ok: boolean;
  /** Mismatch labels, e.g. 'sessions(current)', 'days(previous)', 'contiguity(current)'. */
  mismatches: string[];
}

const MS_PER_DAY = 86_400_000;

/** A session / key event / AI session belongs to exactly ONE day, so daily sums must equal
 *  the period total. activeUsers is de-duplicated across the period and is NOT additive —
 *  it can only be bounded from below (dailySum >= periodTotal). */
const ADDITIVE = ['sessions', 'keyEvents', 'aiSessions'] as const;

type MetricKey = 'activeUsers' | 'sessions' | 'keyEvents' | 'aiSessions';

function sum(rows: DailyMetricsRow[], key: MetricKey): number {
  return rows.reduce((a, r) => a + r.metrics[key], 0);
}

/** True when every date is exactly one calendar day after the previous one. */
function contiguous(rows: DailyMetricsRow[]): boolean {
  // i ∈ [1, rows.length-1] so both indices are in range — the casts are the loop invariant,
  // not an assumption about the data.
  for (let i = 1; i < rows.length; i++) {
    const prev = Date.parse(`${(rows[i - 1] as DailyMetricsRow).date}T00:00:00Z`);
    const cur = Date.parse(`${(rows[i] as DailyMetricsRow).date}T00:00:00Z`);
    if (cur - prev !== MS_PER_DAY) return false;
  }
  return true;
}

function checkWindow(rows: DailyMetricsRow[], period: number, totals: RangeTotals, label: string): string[] {
  const out: string[] = [];
  if (rows.length !== period) out.push(`days(${label})`);
  if (!contiguous(rows)) out.push(`contiguity(${label})`);
  for (const k of ADDITIVE) {
    if (sum(rows, k) !== totals[k]) out.push(`${k}(${label})`);
  }
  if (sum(rows, 'activeUsers') < totals.activeUsers) out.push(`activeUsers(${label})`);
  return out;
}

/**
 * Cross-check the daily series against independently-fetched range totals.
 *
 * buildSummary already fetches BOTH a dimensionless aggregate (fetchRange) and a
 * date-dimensioned series (fetchDailyMetrics), so this costs no extra GA call. Because the
 * additive metrics must sum to the period total, a date window that drifts by even one day
 * — or a sparse/non-contiguous series — makes the two disagree. That is exactly the bug
 * class this guard exists to catch (both were shipped and caught in Spec 1).
 *
 * Caveat: a mismatch here is NOT necessarily a SiteDeck bug. Three GA-side causes can
 * legitimately produce one, none of which SiteSummary.dataQuality.thresholded can rule
 * out — that flag reflects fetchRange's dimensionless report, while fetchDailyMetrics
 * (src/ga.ts) reads only metadata.timeZone off the dimensioned daily report and discards
 * the rest of its metadata, so the daily report's OWN subjectToThresholding is never
 * captured; the two are not the same signal and cannot be "read together." The three
 * causes: (1) above a cardinality threshold GA4 estimates sessions/activeUsers with
 * HyperLogLog++ (~1.6–3% error), so at real traffic volumes the daily sums and the
 * period total can legitimately disagree; (2) GA data thresholding can apply to this
 * dimensioned daily report without applying to the dimensionless total, or vice versa;
 * (3) a midnight-rollover race between GA's server-side `yesterday` and our local
 * computation. A `sessions(...)` mismatch on a HIGH-TRAFFIC property should be
 * investigated as GA estimation FIRST, before assuming a SiteDeck bug.
 *
 * The previous window is only checked when the series is long enough to contain it (a
 * missing window must never raise a false alarm).
 *
 * @param daily Daily rows in ascending date order (oldest→newest), as produced by
 *   `mapDailyMetricsRows`. Out-of-order input would be reported as a contiguity mismatch.
 */
export function checkIntegrity(
  daily: DailyMetricsRow[],
  period: number,
  current: RangeTotals,
  previous: RangeTotals,
): IntegrityReport {
  const mismatches = checkWindow(daily.slice(-period), period, current, 'current');
  if (daily.length >= period * 2) {
    mismatches.push(...checkWindow(daily.slice(-period * 2, -period), period, previous, 'previous'));
  }
  return { ok: mismatches.length === 0, mismatches };
}
