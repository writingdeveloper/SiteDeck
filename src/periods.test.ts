import { describe, it, expect } from 'vitest';
import { comparisonRanges } from './periods';
import { PERIODS } from './config';

// Fixed "now" so tests are deterministic. GA only counts full days, so the
// current period ends *yesterday* (2026-06-12) relative to this asOf.
const asOf = new Date('2026-06-13T10:00:00Z');

function dayCount({ startDate, endDate }: { startDate: string; endDate: string }): number {
  const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return ms / 86_400_000 + 1; // inclusive of both ends
}

function nextDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

describe('comparisonRanges', () => {
  it('builds a 7-day current range ending yesterday (UTC)', () => {
    expect(comparisonRanges(7, asOf).current).toEqual({
      startDate: '2026-06-06',
      endDate: '2026-06-12',
    });
  });

  it('builds the immediately-preceding 7-day previous range', () => {
    expect(comparisonRanges(7, asOf).previous).toEqual({
      startDate: '2026-05-30',
      endDate: '2026-06-05',
    });
  });

  it('spans month boundaries for 28-day periods', () => {
    const { current, previous } = comparisonRanges(28, asOf);
    expect(current).toEqual({ startDate: '2026-05-16', endDate: '2026-06-12' });
    expect(previous).toEqual({ startDate: '2026-04-18', endDate: '2026-05-15' });
  });

  it.each(PERIODS)('current/previous both span %i days and abut each other', (period) => {
    const { current, previous } = comparisonRanges(period, asOf);
    expect(current.endDate).toBe('2026-06-12'); // yesterday of asOf
    expect(dayCount(current)).toBe(period);
    expect(dayCount(previous)).toBe(period);
    expect(nextDay(previous.endDate)).toBe(current.startDate);
  });
});
