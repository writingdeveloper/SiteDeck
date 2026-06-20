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

function rows(body: unknown, key: string): { timestamp?: unknown; count?: unknown; uniques?: unknown }[] {
  const arr = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(arr) ? (arr as { timestamp?: unknown; count?: unknown; uniques?: unknown }[]) : [];
}

/** Per-day views from GET /traffic/views?per=day. */
export function parseViews(body: unknown): DayViews[] {
  return rows(body, 'views')
    .filter((r) => typeof r.timestamp === 'string')
    .map((r) => ({ date: (r.timestamp as string).slice(0, 10), views: Number(r.count ?? 0), uniqueViews: Number(r.uniques ?? 0) }));
}

/** Per-day clones from GET /traffic/clones?per=day. */
export function parseClones(body: unknown): DayClones[] {
  return rows(body, 'clones')
    .filter((r) => typeof r.timestamp === 'string')
    .map((r) => ({ date: (r.timestamp as string).slice(0, 10), clones: Number(r.count ?? 0), uniqueClones: Number(r.uniques ?? 0) }));
}

/** Top-10 referrers from GET /traffic/popular/referrers. */
export function parseReferrers(body: unknown): Referrer[] {
  return (Array.isArray(body) ? body : [])
    .map((r) => ({ referrer: String(r?.referrer ?? ''), count: Number(r?.count ?? 0), uniques: Number(r?.uniques ?? 0) }))
    .filter((r) => r.referrer);
}

/** Top-10 popular paths from GET /traffic/popular/paths. */
export function parsePaths(body: unknown): PathStat[] {
  return (Array.isArray(body) ? body : [])
    .map((p) => ({ path: String(p?.path ?? ''), title: String(p?.title ?? ''), count: Number(p?.count ?? 0), uniques: Number(p?.uniques ?? 0) }))
    .filter((p) => p.path);
}
