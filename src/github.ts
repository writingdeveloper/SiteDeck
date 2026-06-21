// GitHub repo-traffic client. Direct REST + bearer PAT (no Octokit) to keep
// SiteDeck dependency-light — mirrors src/gsc.ts.

export interface DayViews {
  date: string;
  views: number;
  uniqueViews: number;
}
export interface DayClones {
  date: string;
  clones: number;
  uniqueClones: number;
}
export interface Referrer {
  referrer: string;
  count: number;
  uniques: number;
}
export interface PathStat {
  path: string;
  title: string;
  count: number;
  uniques: number;
}
export interface RepoTraffic {
  views: DayViews[];
  clones: DayClones[];
  referrers: Referrer[];
  paths: PathStat[];
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function rows(body: unknown, key: string): { timestamp?: unknown; count?: unknown; uniques?: unknown }[] {
  const arr = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(arr) ? (arr as { timestamp?: unknown; count?: unknown; uniques?: unknown }[]) : [];
}

/** Per-day views from GET /traffic/views?per=day. */
export function parseViews(body: unknown): DayViews[] {
  return rows(body, 'views')
    .filter((r) => typeof r.timestamp === 'string')
    .map((r) => ({ date: (r.timestamp as string).slice(0, 10), views: num(r.count), uniqueViews: num(r.uniques) }));
}

/** Per-day clones from GET /traffic/clones?per=day. */
export function parseClones(body: unknown): DayClones[] {
  return rows(body, 'clones')
    .filter((r) => typeof r.timestamp === 'string')
    .map((r) => ({ date: (r.timestamp as string).slice(0, 10), clones: num(r.count), uniqueClones: num(r.uniques) }));
}

/** Top-10 referrers from GET /traffic/popular/referrers. */
export function parseReferrers(body: unknown): Referrer[] {
  return (Array.isArray(body) ? body : [])
    .map((r) => ({ referrer: String(r?.referrer ?? ''), count: num(r?.count), uniques: num(r?.uniques) }))
    .filter((r) => r.referrer);
}

/** Top-10 popular paths from GET /traffic/popular/paths. */
export function parsePaths(body: unknown): PathStat[] {
  return (Array.isArray(body) ? body : [])
    .map((p) => ({ path: String(p?.path ?? ''), title: String(p?.title ?? ''), count: num(p?.count), uniques: num(p?.uniques) }))
    .filter((p) => p.path);
}

const API = 'https://api.github.com';

async function ghRequest(token: string, url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'SiteDeck',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** All four traffic endpoints for one repo. Requires the PAT's Administration: Read. */
export async function fetchRepoTraffic(token: string, owner: string, repo: string): Promise<RepoTraffic> {
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/traffic`;
  const [views, clones, referrers, paths] = await Promise.all([
    ghRequest(token, `${base}/views?per=day`),
    ghRequest(token, `${base}/clones?per=day`),
    ghRequest(token, `${base}/popular/referrers`),
    ghRequest(token, `${base}/popular/paths`),
  ]);
  return { views: parseViews(views), clones: parseClones(clones), referrers: parseReferrers(referrers), paths: parsePaths(paths) };
}

/** Split "owner/repo" into its parts, or null if it isn't exactly that shape. */
export function parseRepo(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}
