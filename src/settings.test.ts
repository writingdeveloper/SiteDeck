import { describe, it, expect } from 'vitest';
import { isLanguage, mergeSettings, LANGUAGES, type Language } from './settings';

describe('isLanguage', () => {
  it('accepts supported languages', () => {
    for (const l of LANGUAGES) expect(isLanguage(l)).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage('')).toBe(false);
  });
});

describe('mergeSettings', () => {
  it('merges a patch over current settings', () => {
    expect(mergeSettings({ language: 'en' }, { psiApiKey: 'K' })).toEqual({
      language: 'en',
      psiApiKey: 'K',
    });
  });
  it('ignores an invalid language', () => {
    expect(mergeSettings({ language: 'en' }, { language: 'xx' as Language })).toEqual({
      language: 'en',
    });
  });
  it('clears the key when given an empty string', () => {
    expect(mergeSettings({ psiApiKey: 'K' }, { psiApiKey: '' })).toEqual({});
  });
});
