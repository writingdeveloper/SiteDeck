import { describe, it, expect } from 'vitest';
import { isLanguage, isRepoFullName, maskSecret, mergeSettings, LANGUAGES, type Language, type Settings } from './settings';

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

describe('mergeSettings — github', () => {
  it('keeps a trimmed token and only well-formed owner/repo entries', () => {
    const s = mergeSettings({}, {
      githubToken: '  tok  ',
      githubRepos: ['o/r', '', 'a/b', 'owner/repo/extra', 'noslash'] as unknown as string[],
    });
    expect(s.githubToken).toBe('tok');
    expect(s.githubRepos).toEqual(['o/r', 'a/b']); // 'owner/repo/extra' and 'noslash' rejected
  });

  it('clears the token when an empty string is patched in', () => {
    const s = mergeSettings({ githubToken: 'tok' }, { githubToken: '   ' });
    expect(s.githubToken).toBeUndefined();
  });

  it('clears the repo list when an empty array is patched in', () => {
    const s = mergeSettings({ githubRepos: ['o/r'] }, { githubRepos: [] });
    expect(s.githubRepos).toBeUndefined();
  });

  // /api/settings takes arbitrary JSON and config.json is hand-editable, so a non-string
  // secret must be ignored rather than thrown out of .trim() as a 500.
  it('ignores a non-string secret instead of throwing', () => {
    const patch = { psiApiKey: 42, githubToken: null } as unknown as Partial<Settings>;
    expect(() => mergeSettings({ psiApiKey: 'K', githubToken: 'tok' }, patch)).not.toThrow();
    const s = mergeSettings({ psiApiKey: 'K', githubToken: 'tok' }, patch);
    expect(s).toEqual({ psiApiKey: 'K', githubToken: 'tok' });
  });
});

describe('isRepoFullName', () => {
  it('accepts exactly owner/repo', () => {
    expect(isRepoFullName('writingdeveloper/SiteDeck')).toBe(true);
    expect(isRepoFullName('  o/r  ')).toBe(true); // trimmed before matching
    expect(isRepoFullName('a.b_c-d/e.f_g-h')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isRepoFullName('noslash')).toBe(false);
    expect(isRepoFullName('owner/repo/extra')).toBe(false);
    expect(isRepoFullName('bad/')).toBe(false);
    expect(isRepoFullName('/bad')).toBe(false);
    expect(isRepoFullName('own er/repo')).toBe(false);
    // Not a string — the endpoint receives raw JSON.
    expect(isRepoFullName(42)).toBe(false);
    expect(isRepoFullName(null)).toBe(false);
  });
});

describe('maskSecret', () => {
  it('shows only the last 4 characters', () => {
    expect(maskSecret('github_pat_11ABCDEFG_wxyz')).toBe('••••wxyz');
  });
  it('reveals nothing at all from a very short secret', () => {
    expect(maskSecret('abcd')).toBe('••••');
    expect(maskSecret('a')).toBe('••••');
  });
});
