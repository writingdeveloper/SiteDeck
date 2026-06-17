import { describe, it, expect } from 'vitest';
import { parsePsiScores } from './psi';

const NO_CWV = { lcpMs: null, cls: null, inpMs: null };

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
      ...NO_CWV,
    });
  });

  it('returns null for missing categories', () => {
    expect(parsePsiScores({ lighthouseResult: { categories: {} } })).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
      ...NO_CWV,
    });
  });

  it('returns all null for a malformed response', () => {
    expect(parsePsiScores({})).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
      ...NO_CWV,
    });
  });
});

describe('parsePsiScores — Core Web Vitals', () => {
  it('reads LCP/CLS/INP from field data (CrUX); CLS percentile is /100', () => {
    const resp = {
      loadingExperience: {
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2500 },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 }, // → 0.05
          INTERACTION_TO_NEXT_PAINT: { percentile: 180 },
        },
      },
    };
    expect(parsePsiScores(resp)).toMatchObject({ lcpMs: 2500, cls: 0.05, inpMs: 180 });
  });

  it('falls back to lab audits for LCP/CLS when there is no field data (INP stays null)', () => {
    const resp = {
      lighthouseResult: {
        audits: {
          'largest-contentful-paint': { numericValue: 3200 },
          'cumulative-layout-shift': { numericValue: 0.12 },
        },
      },
    };
    expect(parsePsiScores(resp)).toMatchObject({ lcpMs: 3200, cls: 0.12, inpMs: null });
  });

  it('prefers field LCP over lab when both are present', () => {
    const resp = {
      loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000 } } },
      lighthouseResult: { audits: { 'largest-contentful-paint': { numericValue: 9999 } } },
    };
    expect(parsePsiScores(resp).lcpMs).toBe(2000);
  });
});
