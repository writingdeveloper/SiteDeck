import { describe, it, expect } from 'vitest';
import { deltaPct } from './summary';

describe('deltaPct', () => {
  it('computes a positive percentage change', () => {
    expect(deltaPct(110, 100)).toBe(10);
  });

  it('computes a negative percentage change', () => {
    expect(deltaPct(90, 100)).toBe(-10);
  });

  it('is zero when unchanged', () => {
    expect(deltaPct(100, 100)).toBe(0);
  });

  it('rounds to two decimal places', () => {
    expect(deltaPct(1234, 1100)).toBe(12.18);
  });

  it('returns null when the previous value is zero (change is undefined)', () => {
    expect(deltaPct(50, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
  });
});
