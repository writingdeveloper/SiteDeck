export interface PsiScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

interface PsiResponse {
  lighthouseResult?: { categories?: Record<string, { score?: number | null }> };
}

export function parsePsiScores(response: unknown): PsiScores {
  const categories = (response as PsiResponse)?.lighthouseResult?.categories ?? {};
  const score = (key: string): number | null => {
    const raw = categories[key]?.score;
    return typeof raw === 'number' ? Math.round(raw * 100) : null;
  };
  return {
    performance: score('performance'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
    seo: score('seo'),
  };
}

/** Call PageSpeed Insights v5 (mobile, 4 categories) for a URL and return parsed scores. */
export async function fetchPsiScores(apiKey: string, url: string): Promise<PsiScores> {
  const params = new URLSearchParams({ url, strategy: 'mobile', key: apiKey });
  for (const c of ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']) {
    params.append('category', c);
  }
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
    // Cap the request so a hung PSI call can't hold the measurement lock forever.
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`PSI ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  }
  return parsePsiScores(await res.json());
}
