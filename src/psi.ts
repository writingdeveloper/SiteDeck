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
