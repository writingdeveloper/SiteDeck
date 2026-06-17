export interface PsiScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  // Core Web Vitals: LCP (ms), CLS (raw), INP (ms). null when unavailable.
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
}

interface PsiResponse {
  lighthouseResult?: {
    categories?: Record<string, { score?: number | null }>;
    audits?: Record<string, { numericValue?: number | null }>;
  };
  loadingExperience?: {
    metrics?: Record<string, { percentile?: number | null }>;
  };
}

export function parsePsiScores(response: unknown): PsiScores {
  const data = response as PsiResponse;
  const categories = data?.lighthouseResult?.categories ?? {};
  const audits = data?.lighthouseResult?.audits ?? {};
  const field = data?.loadingExperience?.metrics ?? {};

  const score = (key: string): number | null => {
    const raw = categories[key]?.score;
    return typeof raw === 'number' ? Math.round(raw * 100) : null;
  };
  const fieldNum = (key: string): number | null => {
    const v = field[key]?.percentile;
    return typeof v === 'number' ? v : null;
  };
  const labNum = (id: string): number | null => {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' ? v : null;
  };

  // Prefer real-user field data (CrUX) for Core Web Vitals; fall back to the lab
  // run for LCP/CLS. CrUX CLS is reported ×100 (5 → 0.05); lab CLS is already raw.
  // INP is field-only (the lab run can't measure real interactions).
  const clsField = fieldNum('CUMULATIVE_LAYOUT_SHIFT_SCORE');
  return {
    performance: score('performance'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
    seo: score('seo'),
    lcpMs: fieldNum('LARGEST_CONTENTFUL_PAINT_MS') ?? labNum('largest-contentful-paint'),
    cls: clsField !== null ? clsField / 100 : labNum('cumulative-layout-shift'),
    inpMs: fieldNum('INTERACTION_TO_NEXT_PAINT'),
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
