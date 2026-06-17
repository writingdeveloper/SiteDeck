import { describe, it, expect } from 'vitest';
// Pure, DOM-free client helpers — shared by the browser (public/app.js) and tested here.
import {
  escapeCsvField,
  toCsv,
  matchesFilter,
  relTime,
  resolveTheme,
  cwvRating,
  cwvText,
  deltaClass,
} from '../public/format.js';

describe('escapeCsvField', () => {
  it('leaves plain values untouched', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField(42)).toBe('42');
  });
  it('quotes values with commas, quotes, or newlines and doubles quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    expect(escapeCsvField('a\nb')).toBe('"a\nb"');
  });
  it('renders null/undefined as empty', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });
  it('neutralizes spreadsheet formula injection (=, +, @, leading -text)', () => {
    // "=HYPERLINK(""x"")" gets a leading ' then is quoted because it contains ".
    expect(escapeCsvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(escapeCsvField('@cmd')).toBe("'@cmd");
    expect(escapeCsvField('+1+2')).toBe("'+1+2");
    expect(escapeCsvField('-2+3')).toBe("'-2+3");
  });
  it('does NOT prefix legitimate negative numbers', () => {
    expect(escapeCsvField('-33.33')).toBe('-33.33');
    expect(escapeCsvField(-5)).toBe('-5');
  });
});

describe('toCsv', () => {
  it('joins header + rows with CRLF and escapes fields', () => {
    expect(toCsv(['A', 'B'], [['1', 'x,y'], ['2', 'z']])).toBe('A,B\r\n1,"x,y"\r\n2,z');
  });
});

describe('matchesFilter', () => {
  it('matches case-insensitively on substring', () => {
    expect(matchesFilter('FitCheck', 'fit')).toBe(true);
    expect(matchesFilter('FitCheck', 'CHECK')).toBe(true);
  });
  it('returns false when no substring match', () => {
    expect(matchesFilter('FitCheck', 'xyz')).toBe(false);
  });
  it('matches everything for an empty/whitespace query', () => {
    expect(matchesFilter('Anything', '')).toBe(true);
    expect(matchesFilter('Anything', '   ')).toBe(true);
  });
});

describe('relTime', () => {
  const now = 1_000_000_000_000;
  it('shows the just-now label under a minute', () => {
    expect(relTime(now - 30_000, now, 'en', 'just now')).toBe('just now');
  });
  it('formats minutes, hours, and days (English)', () => {
    expect(relTime(now - 5 * 60_000, now, 'en', 'now')).toBe('5 minutes ago');
    expect(relTime(now - 2 * 3_600_000, now, 'en', 'now')).toBe('2 hours ago');
    expect(relTime(now - 3 * 86_400_000, now, 'en', 'now')).toBe('3 days ago');
  });
});

describe('cwvRating', () => {
  it('rates LCP / CLS / INP against the Core Web Vitals thresholds', () => {
    expect(cwvRating(2000, 'lcp')).toBe('good');
    expect(cwvRating(3000, 'lcp')).toBe('avg');
    expect(cwvRating(5000, 'lcp')).toBe('poor');
    expect(cwvRating(0.05, 'cls')).toBe('good');
    expect(cwvRating(0.2, 'cls')).toBe('avg');
    expect(cwvRating(0.3, 'cls')).toBe('poor');
    expect(cwvRating(150, 'inp')).toBe('good');
    expect(cwvRating(400, 'inp')).toBe('avg');
    expect(cwvRating(600, 'inp')).toBe('poor');
  });
  it('returns "na" for null or an unknown metric', () => {
    expect(cwvRating(null, 'lcp')).toBe('na');
    expect(cwvRating(100, 'xyz')).toBe('na');
  });
});

describe('cwvText', () => {
  it('formats LCP in seconds, CLS to 2 dp, INP in ms', () => {
    expect(cwvText(2500, 'lcp')).toBe('2.5s');
    expect(cwvText(0.05, 'cls')).toBe('0.05');
    expect(cwvText(180, 'inp')).toBe('180ms');
  });
  it('shows a dash for null', () => {
    expect(cwvText(null, 'lcp')).toBe('—');
  });
});

describe('deltaClass', () => {
  it('returns "none" for null/non-finite (no prior data)', () => {
    expect(deltaClass(null, 30)).toBe('none');
    expect(deltaClass(undefined, 30)).toBe('none');
    expect(deltaClass(Infinity, 30)).toBe('none');
  });
  it('treats values that round to 0.0% as flat (neither up nor down)', () => {
    expect(deltaClass(0, 30)).toBe('flat');
    expect(deltaClass(0.04, 30)).toBe('flat');
    expect(deltaClass(-0.04, 30)).toBe('flat');
  });
  it('marks direction, and flags big movers past the threshold', () => {
    expect(deltaClass(5, 30)).toBe('up');
    expect(deltaClass(-12, 30)).toBe('down');
    expect(deltaClass(40, 30)).toBe('up big');
    expect(deltaClass(-55, 30)).toBe('down big');
  });
});

describe('resolveTheme', () => {
  it('returns an explicit choice as-is', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('follows the OS preference for "system" (or anything unset)', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme(undefined, true)).toBe('light');
    expect(resolveTheme(null, false)).toBe('dark');
  });
});
