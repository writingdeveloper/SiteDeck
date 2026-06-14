import { describe, it, expect } from 'vitest';
import { parsePsiScores } from './psi';

describe('parsePsiScores', () => {
  it('converts 0–1 category scores to 0–100 integers', () => {
    const resp = {
      lighthouseResult: {
        categories: {
          performance: { score: 0.87 },
          accessibility: { score: 0.95 },
          'best-practices': { score: 0.92 },
          seo: { score: 1 },
        },
      },
    };
    expect(parsePsiScores(resp)).toEqual({
      performance: 87,
      accessibility: 95,
      bestPractices: 92,
      seo: 100,
    });
  });

  it('returns null for missing categories', () => {
    expect(parsePsiScores({ lighthouseResult: { categories: {} } })).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
    });
  });

  it('returns all null for a malformed response', () => {
    expect(parsePsiScores({})).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
    });
  });
});
