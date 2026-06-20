import type { OAuth2Client } from 'google-auth-library';
import { listSiteUrls, type SiteUrl } from './ga';

export interface OnPageChecks {
  title: boolean;
  description: boolean;
  canonical: boolean;
  openGraph: boolean;
  structuredData: boolean;
}

export interface SiteOnPage {
  propertyId: string;
  displayName: string;
  url: string;
  /** null when the homepage couldn't be fetched (see `error`). */
  checks: OnPageChecks | null;
  llmsTxt: boolean;
  error: string | null;
}

// Parse a tag's attributes into a lowercased name→value map. Good enough for the
// handful of <meta>/<link> signals we check — not a general-purpose HTML parser.
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z][a-z0-9-]*)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    const key = m[1]?.toLowerCase();
    if (key) out[key] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

function tagsOf(html: string, name: string): Record<string, string>[] {
  return (html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []).map(attrs);
}

/** On-page SEO/GEO signals parsed from a page's HTML (no network). */
export function parseOnPage(html: string): OnPageChecks {
  const metas = tagsOf(html, 'meta');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: Boolean(titleMatch?.[1]?.trim()),
    description: metas.some((m) => m.name?.toLowerCase() === 'description' && Boolean(m.content?.trim())),
    canonical: tagsOf(html, 'link').some((l) => l.rel?.toLowerCase() === 'canonical' && Boolean(l.href)),
    openGraph: metas.some((m) => (m.property ?? '').toLowerCase().startsWith('og:')),
    structuredData: /<script[^>]+type=["']application\/ld\+json["']/i.test(html),
  };
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'SiteDeck/onpage-check' },
    signal: AbortSignal.timeout(ms),
  });
}

/** Fetch one site's homepage + /llms.txt and compute its on-page checks. */
export async function fetchOnPage(site: SiteUrl): Promise<SiteOnPage> {
  const base = { propertyId: site.propertyId, displayName: site.displayName, url: site.url };
  let checks: OnPageChecks | null = null;
  let error: string | null = null;
  try {
    const res = await fetchWithTimeout(site.url, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    checks = parseOnPage(await res.text());
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  let llmsTxt = false;
  try {
    llmsTxt = (await fetchWithTimeout(new URL('/llms.txt', site.url).href, 6000)).ok;
  } catch {
    llmsTxt = false;
  }
  return { ...base, checks, llmsTxt, error };
}

// Run `task` over items with at most `limit` in flight at once.
async function mapPool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** On-page report for every web property, fetched concurrently (bounded). */
export async function getOnPageReport(
  auth: OAuth2Client,
): Promise<{ generatedAt: string; sites: SiteOnPage[] }> {
  const urls = await listSiteUrls(auth);
  const sites = await mapPool(urls, 5, fetchOnPage);
  return { generatedAt: new Date().toISOString(), sites };
}
