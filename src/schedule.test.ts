import { describe, it, expect } from 'vitest';
import { shouldMeasure } from './schedule';

describe('shouldMeasure', () => {
  const now = Date.parse('2026-06-13T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  it('is true when never measured', () => expect(shouldMeasure(null, now, day)).toBe(true));
  it('is false within the interval', () =>
    expect(shouldMeasure('2026-06-13T06:00:00Z', now, day)).toBe(false));
  it('is true once the interval elapsed', () =>
    expect(shouldMeasure('2026-06-12T06:00:00Z', now, day)).toBe(true));
});
