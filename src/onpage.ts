import net from 'node:net';
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
  // Unquoted values stop at whitespace, quotes, or the tag's closing '>' (so a
  // trailing '>' is never captured into the value).
  const re = /([a-z][a-z0-9-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
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
  // Drop commented-out markup first so a tag inside <!-- ... --> never counts.
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const metas = tagsOf(clean, 'meta');
  const titleMatch = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: Boolean(titleMatch?.[1]?.trim()),
    description: metas.some((m) => m.name?.toLowerCase() === 'description' && Boolean(m.content?.trim())),
    canonical: tagsOf(clean, 'link').some((l) => l.rel?.toLowerCase() === 'canonical' && Boolean(l.href)),
    openGraph: metas.some((m) => (m.property ?? '').toLowerCase().startsWith('og:')),
    // Attribute parse (not a raw regex) so unquoted `type=application/ld+json` is
    // caught and a look-alike like `application/ld+json-x` is not.
    structuredData: tagsOf(clean, 'script').some((s) => s.type?.toLowerCase() === 'application/ld+json'),
  };
}

/** Obviously-internal hosts: localhost, loopback, link-local, and private IP ranges. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) {
    const [a = 0, b = 0] = h.split('.').map(Number);
    return a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(h)) {
    return h === '::' || h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('::ffff:127');
  }
  return false;
}

/** Only http(s) to a non-internal host may be fetched for an on-page check (SSRF guard). */
export function isSafeUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !isBlockedHost(u.hostname);
  } catch {
    return false;
  }
}

// Follow redirects manually so EVERY hop is SSRF-checked — redirect:'follow' would
// silently bounce a public-looking URL into 127.0.0.1 / the LAN / link-local metadata.
async function fetchGuarded(urlStr: string, ms: number, maxRedirects = 5): Promise<Response> {
  let url = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSafeUrl(url)) throw new Error(`blocked URL (bad scheme or internal host): ${url}`);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'SiteDeck/onpage-check' },
      signal: AbortSignal.timeout(ms),
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    url = new URL(location, url).href;
  }
  throw new Error('too many redirects');
}

/** Fetch one site's homepage + /llms.txt and compute its on-page checks. */
export async function fetchOnPage(site: SiteUrl): Promise<SiteOnPage> {
  const base = { propertyId: site.propertyId, displayName: site.displayName, url: site.url };
  let checks: OnPageChecks | null = null;
  let error: string | null = null;
  try {
    const res = await fetchGuarded(site.url, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    checks = parseOnPage(await res.text());
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  let llmsTxt = false;
  try {
    llmsTxt = (await fetchGuarded(new URL('/llms.txt', site.url).href, 6000)).ok;
  } catch {
    llmsTxt = false;
  }
  return { ...base, checks, llmsTxt, error };
}

// Run `task` over items with at most `limit` in flight at once. Exported for tests.
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
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
