import type { Period } from './config';

export interface DateRange {
  /** Inclusive start, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive end, YYYY-MM-DD. */
  endDate: string;
}

export interface ComparisonRanges {
  current: DateRange;
  previous: DateRange;
}

const MS_PER_DAY = 86_400_000;

/** UTC midnight of the given instant's calendar date. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the current and immediately-preceding date ranges for a period.
 *
 * Ranges end *yesterday* relative to `asOf`, because GA only has complete data
 * for full days. For period = 7 and asOf = 2026-06-13:
 *   current  = 2026-06-06 .. 2026-06-12
 *   previous = 2026-05-30 .. 2026-06-05
 */
export function comparisonRanges(period: Period, asOf: Date = new Date()): ComparisonRanges {
  const endCurrent = addDays(utcMidnight(asOf), -1); // yesterday
  const startCurrent = addDays(endCurrent, -(period - 1));
  const endPrevious = addDays(startCurrent, -1);
  const startPrevious = addDays(endPrevious, -(period - 1));

  return {
    current: { startDate: iso(startCurrent), endDate: iso(endCurrent) },
    previous: { startDate: iso(startPrevious), endDate: iso(endPrevious) },
  };
}
