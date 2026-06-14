import { describe, it, expect } from 'vitest';
import { interpolate, translate } from './i18n';

describe('interpolate', () => {
  it('substitutes {name} params', () => {
    expect(interpolate('Hi {name}, {n} new', { name: 'A', n: 3 })).toBe('Hi A, 3 new');
  });
  it('leaves unknown placeholders as-is', () => {
    expect(interpolate('Hi {who}', {})).toBe('Hi {who}');
  });
});

describe('translate', () => {
  const en = { greeting: 'Hello {name}', plain: 'Plain' };
  const ko = { greeting: '안녕 {name}' };
  it('uses the locale catalog with interpolation', () => {
    expect(translate(ko, en, 'greeting', { name: '윤' })).toBe('안녕 윤');
  });
  it('falls back to the en catalog when the key is missing', () => {
    expect(translate(ko, en, 'plain', {})).toBe('Plain');
  });
  it('falls back to the key itself when missing everywhere', () => {
    expect(translate(ko, en, 'absent', {})).toBe('absent');
  });
});
