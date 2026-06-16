import { describe, it, expect } from 'vitest';
// Pure, DOM-free client helpers — shared by the browser (public/app.js) and tested here.
import { escapeCsvField, toCsv, matchesFilter, relTime } from '../public/format.js';

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
