import type { OAuth2Client } from 'google-auth-library';
import type { DateRange } from './periods';
import type { SearchMetrics } from './summary';

// Google Search Console (Search Console API v3 / "webmasters"). We call the REST
// endpoints directly with the existing OAuth access token rather than pulling in
// the heavyweight `googleapis` package — keeping SiteDeck dependency-light.
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

/**
 * Normalize a site identifier to a bare host for comparison: lowercase, and strip
 * the `sc-domain:` prefix, the URL scheme, any path, and a leading `www.`.
 */
export function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

export interface ParsedSite {
  raw: string;
  kind: 'domain' | 'prefix';
  host: string;      // 정규화(소문자, 선행 www 제거)
  scheme?: string;   // prefix 전용 (예: 'https')
  path?: string;     // prefix 전용 (예: '/', '/shop/')
}

/** GSC/GA 사이트 식별자를 스킴·호스트·경로로 파싱. sc-domain:은 도메인, 그 외는 URL. */
export function parseSite(input: string): ParsedSite | null {
  const raw = input.trim();
  if (/^sc-domain:/i.test(raw)) {
    const host = normalizeHost(raw);
    return host ? { raw, kind: 'domain', host } : null;
  }
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host ? { raw, kind: 'prefix', host, scheme: u.protocol.replace(/:$/, ''), path: u.pathname || '/' } : null;
  } catch {
    return null;
  }
}

/**
 * Map each GA4 property (by its web data-stream URL) to a verified GSC site.
 * Domain properties (`sc-domain:`) cover subdomains too; URL-prefix sites match
 * on the exact normalized host *and* require the GA URL's path to fall under the
 * property's path, so a subpath-only property (e.g. `https://x.com/shop/`) never
 * absorbs traffic for the whole host (A5).
 *
 * When several verified sites cover one host (e.g. a subdomain that has both its
 * own property and a parent domain property), the most specific one wins — the
 * longest matched host — so a subdomain never silently reports the parent's
 * aggregate. Next, a URL-prefix candidate whose scheme matches the GA data-stream
 * URL is preferred, so `http://` and `https://` properties for the same host — two
 * distinct, separately-verified GSC properties — don't collide on the legacy/empty
 * one (A1). Remaining ties break alphabetically, so the choice — and thus the
 * numbers — stay stable across refreshes instead of following the API's
 * (unordered) site list.
 */
export function matchSites(
  siteUrls: { propertyId: string; url: string }[],
  gscSites: string[],
): Map<string, string> {
  const parsed = gscSites.map(parseSite).filter((s): s is ParsedSite => s !== null);
  const out = new Map<string, string>();
  for (const { propertyId, url } of siteUrls) {
    const ga = parseSite(url);
    if (!ga || ga.kind !== 'prefix') continue; // GA 스트림 URL은 절대 URL
    const gaPath = ga.path ?? '/';
    const candidates = parsed.filter((c) => {
      if (c.kind === 'domain') return c.host === ga.host || ga.host.endsWith(`.${c.host}`);
      // Path containment must respect segment boundaries: a candidate registered as
      // `https://x.com/shop` must not swallow `/shopping/...`. Normalize the trailing
      // slash, then require an exact match or a `/`-terminated prefix.
      const base = (c.path ?? '/').replace(/\/+$/, '');
      return c.host === ga.host && (base === '' || gaPath === base || gaPath.startsWith(`${base}/`));
    });
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const hostSpec = b.host.length - a.host.length;            // 더 구체적인 호스트 우선
      if (hostSpec !== 0) return hostSpec;
      const sa = a.kind === 'prefix' && a.scheme === ga.scheme ? 0 : 1; // 스킴 일치 우선(A1)
      const sb = b.kind === 'prefix' && b.scheme === ga.scheme ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;         // 결정적 폴백
    });
    out.set(propertyId, (candidates[0] as ParsedSite).raw);
  }
  return out;
}

interface GscSitesBody {
  siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
}

/** Verified site URLs from a sites.list response (drops sites the user can't read). */
export function parseGscSites(body: GscSitesBody): string[] {
  return (body.siteEntry ?? [])
    .filter((s) => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
    .map((s) => s.siteUrl as string);
}

interface GscQueryBody {
  rows?: { clicks?: number; impressions?: number; position?: number }[];
}

/** Aggregate clicks/impressions/position from a searchAnalytics.query response. */
export function parseSearchMetrics(body: GscQueryBody): SearchMetrics {
  const row = body.rows?.[0];
  return {
    clicks: Math.round(row?.clicks ?? 0),
    impressions: Math.round(row?.impressions ?? 0),
    position: Math.round((row?.position ?? 0) * 100) / 100,
  };
}

async function gscRequest(auth: OAuth2Client, url: string, init?: RequestInit): Promise<unknown> {
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('no GSC access token');
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GSC ${res.status} ${res.statusText}`);
  return res.json();
}

/** Every Search Console site the authenticated user can read. */
export async function listGscSites(auth: OAuth2Client): Promise<string[]> {
  return parseGscSites((await gscRequest(auth, SITES_URL)) as GscSitesBody);
}

/** Aggregate Search Console metrics for one verified site over a date range. */
export async function fetchSearchMetrics(
  auth: OAuth2Client,
  siteUrl: string,
  range: DateRange,
): Promise<SearchMetrics> {
  const url = `${SITES_URL}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const body = await gscRequest(auth, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Search Console finalizes data ~2-3 days late; our range ends yesterday, so
    // without dataState:'all' (the default 'final') the most recent days come back
    // empty and clicks/impressions are silently undercounted on every refresh.
    body: JSON.stringify({ startDate: range.startDate, endDate: range.endDate, dataState: 'all' }),
  });
  return parseSearchMetrics(body as GscQueryBody);
}
