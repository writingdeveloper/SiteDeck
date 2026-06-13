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

/** Every calendar day in an inclusive range as GA-style YYYYMMDD strings. */
export function enumerateDays(range: DateRange): string[] {
  const out: string[] = [];
  let day = utcMidnight(new Date(`${range.startDate}T00:00:00Z`));
  const end = utcMidnight(new Date(`${range.endDate}T00:00:00Z`));
  while (day.getTime() <= end.getTime()) {
    out.push(iso(day).replace(/-/g, ''));
    day = addDays(day, 1);
  }
  return out;
}
