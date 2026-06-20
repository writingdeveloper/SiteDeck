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

/**
 * Map each GA4 property (by its web data-stream URL) to a verified GSC site.
 * Domain properties (`sc-domain:`) cover subdomains too; URL-prefix sites match
 * on the exact normalized host. Properties with no verified site are omitted.
 */
export function matchSites(
  siteUrls: { propertyId: string; url: string }[],
  gscSites: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const { propertyId, url } of siteUrls) {
    const host = normalizeHost(url);
    if (!host) continue;
    const match = gscSites.find((site) => {
      const dom = normalizeHost(site);
      if (!dom) return false;
      return /^sc-domain:/i.test(site) ? host === dom || host.endsWith(`.${dom}`) : host === dom;
    });
    if (match) out.set(propertyId, match);
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
    body: JSON.stringify({ startDate: range.startDate, endDate: range.endDate }),
  });
  return parseSearchMetrics(body as GscQueryBody);
}
