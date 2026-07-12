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

/** YYYY-MM-DD `n` days before `dateStr`. Pure calendar arithmetic on the date label
 *  (never local-zone hour math), so it's DST-safe. Mirrors the private helper in
 *  ga-store.ts:36 — kept separate rather than shared, per module boundaries. */
function isoMinusDays(dateStr: string, n: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - n * MS_PER_DAY).toISOString().slice(0, 10);
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

/** GA4 Data API 전용 상대 날짜 범위 — GA가 속성 타임존으로 해석한다. */
export function gaRanges(period: Period): ComparisonRanges {
  return {
    current: { startDate: `${period}daysAgo`, endDate: 'yesterday' },
    previous: { startDate: `${period * 2}daysAgo`, endDate: `${period + 1}daysAgo` },
  };
}

/** GA4 일별 히스토리 백필용 상대 범위(어제까지 최근 `days`일). */
export function gaHistoryRange(days: number): DateRange {
  return { startDate: `${days}daysAgo`, endDate: 'yesterday' };
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA time zone. */
export function todayInZone(timeZone: string, asOf: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(asOf);
}

/**
 * The `days` calendar dates ending YESTERDAY in `timeZone`, oldest→newest (YYYY-MM-DD).
 * This is exactly the set GA4 resolves `"NdaysAgo".."yesterday"` to for a property in that
 * zone. GA's keepEmptyRows does NOT emit a row for every date in the range, so callers
 * zero-fill their daily series against this list.
 */
export function expectedDaysInZone(timeZone: string, days: number, asOf: Date = new Date()): string[] {
  const end = isoMinusDays(todayInZone(timeZone, asOf), 1); // yesterday, in the property's zone
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(isoMinusDays(end, i));
  return out;
}
