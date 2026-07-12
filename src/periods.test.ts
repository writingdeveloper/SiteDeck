import { describe, it, expect } from 'vitest';
import { comparisonRanges, enumerateDays, gaRanges, gaHistoryRange, todayInZone, expectedDaysInZone } from './periods';
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

describe('enumerateDays', () => {
  it('lists each day of an inclusive range as YYYYMMDD (GA date format)', () => {
    expect(enumerateDays({ startDate: '2026-06-06', endDate: '2026-06-12' })).toEqual([
      '20260606',
      '20260607',
      '20260608',
      '20260609',
      '20260610',
      '20260611',
      '20260612',
    ]);
  });

  it('spans month boundaries', () => {
    expect(enumerateDays({ startDate: '2026-05-30', endDate: '2026-06-02' })).toEqual([
      '20260530',
      '20260531',
      '20260601',
      '20260602',
    ]);
  });
});

describe('gaRanges (GA4 상대 날짜)', () => {
  it('current = NdaysAgo..yesterday, previous = 직전 N일', () => {
    expect(gaRanges(7)).toEqual({
      current: { startDate: '7daysAgo', endDate: 'yesterday' },
      previous: { startDate: '14daysAgo', endDate: '8daysAgo' },
    });
    expect(gaRanges(28)).toEqual({
      current: { startDate: '28daysAgo', endDate: 'yesterday' },
      previous: { startDate: '56daysAgo', endDate: '29daysAgo' },
    });
  });
});

describe('gaHistoryRange', () => {
  it('최근 N일, 어제까지', () => {
    expect(gaHistoryRange(90)).toEqual({ startDate: '90daysAgo', endDate: 'yesterday' });
  });
});

describe('todayInZone', () => {
  // 2026-07-11 19:06 PDT  ==  2026-07-12 11:06 KST  — the two zones are on different calendar days.
  const asOf = new Date('2026-07-12T02:06:00Z');

  it('UTC 순간을 속성 타임존의 오늘 날짜(YYYY-MM-DD)로 변환한다 (LA는 아직 7/11)', () => {
    expect(todayInZone('America/Los_Angeles', asOf)).toBe('2026-07-11');
  });

  it('같은 순간이라도 서울은 이미 7/12로 넘어갔다', () => {
    expect(todayInZone('Asia/Seoul', asOf)).toBe('2026-07-12');
  });
});

describe('expectedDaysInZone', () => {
  // GA4's keepEmptyRows does NOT emit a row for every date in "NdaysAgo..yesterday" —
  // real responses can be sparse. This is the date list callers zero-fill against instead,
  // resolved in the property's own reporting time zone (not UTC, not the server's local zone).
  // 2026-07-11 19:06 PDT  ==  2026-07-12 11:06 KST  — the two zones are on different calendar days.
  const asOf = new Date('2026-07-12T02:06:00Z');

  it('속성 타임존의 "어제"까지 N일을 만든다 (LA)', () => {
    expect(expectedDaysInZone('America/Los_Angeles', 3, asOf)).toEqual(['2026-07-08', '2026-07-09', '2026-07-10']);
  });

  it('같은 순간이라도 타임존이 다르면 다른 날짜 집합 (Seoul)', () => {
    expect(expectedDaysInZone('Asia/Seoul', 3, asOf)).toEqual(['2026-07-09', '2026-07-10', '2026-07-11']);
  });

  it('days=0이면 빈 배열', () => {
    expect(expectedDaysInZone('America/Los_Angeles', 0, asOf)).toEqual([]);
  });

  it('월 경계를 넘어가도 연속된 날짜(오래된→최신)를 만든다', () => {
    // Yesterday in LA relative to asOf is 2026-07-10; walking back 12 days crosses June/July.
    expect(expectedDaysInZone('America/Los_Angeles', 12, asOf)).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
    ]);
  });
});
