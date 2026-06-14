import { AnalyticsAdminServiceClient } from '@google-analytics/admin';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import type { OAuth2Client } from 'google-auth-library';
import { enumerateDays, type DateRange } from './periods';

export interface PropertyRef {
  propertyId: string;
  displayName: string;
}

export interface RangeMetrics {
  activeUsers: number;
  sessions: number;
  keyEvents: number;
}

let adminClient: AnalyticsAdminServiceClient | null = null;
let dataClient: BetaAnalyticsDataClient | null = null;

// The GA client libraries bundle their own copy of google-auth-library, so our
// OAuth2Client is structurally identical but nominally incompatible with their
// expected auth type. The cast bridges that dual-package hazard (runtime is fine).
function gaOptions(auth: OAuth2Client) {
  return { authClient: auth as never, fallback: true };
}

function admin(auth: OAuth2Client): AnalyticsAdminServiceClient {
  return (adminClient ??= new AnalyticsAdminServiceClient(gaOptions(auth)));
}

function data(auth: OAuth2Client): BetaAnalyticsDataClient {
  return (dataClient ??= new BetaAnalyticsDataClient(gaOptions(auth)));
}

/** Every GA4 property the authenticated user can access, across all accounts. */
export async function listProperties(auth: OAuth2Client): Promise<PropertyRef[]> {
  const [summaries] = await admin(auth).listAccountSummaries();
  const props: PropertyRef[] = [];
  for (const account of summaries) {
    for (const p of account.propertySummaries ?? []) {
      const propertyId = (p.property ?? '').split('/')[1] ?? '';
      if (propertyId) {
        props.push({ propertyId, displayName: p.displayName ?? propertyId });
      }
    }
  }
  return props;
}

/** activeUsers + sessions totals for one property over a single date range. */
export async function fetchRange(
  auth: OAuth2Client,
  propertyId: string,
  range: DateRange,
): Promise<RangeMetrics> {
  const [report] = await data(auth).runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'keyEvents' }],
  });
  const row = report.rows?.[0];
  return {
    activeUsers: Number(row?.metricValues?.[0]?.value ?? 0),
    sessions: Number(row?.metricValues?.[1]?.value ?? 0),
    keyEvents: Number(row?.metricValues?.[2]?.value ?? 0),
  };
}

/** The single top dimension value (by `metric`, descending) for a property over a range. */
export async function fetchTopValue(
  auth: OAuth2Client,
  propertyId: string,
  range: DateRange,
  dimension: string,
  metric: string,
): Promise<string | null> {
  const [report] = await data(auth).runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    dimensions: [{ name: dimension }],
    metrics: [{ name: metric }],
    orderBys: [{ metric: { metricName: metric }, desc: true }],
    limit: 1,
  });
  const value = report.rows?.[0]?.dimensionValues?.[0]?.value;
  return value && value !== '(not set)' ? value : null;
}

/** Daily values of `metric` over a range, zero-filled and in chronological order. */
export async function fetchDailySeries(
  auth: OAuth2Client,
  propertyId: string,
  range: DateRange,
  metric = 'activeUsers',
): Promise<number[]> {
  const [report] = await data(auth).runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: metric }],
  });
  const byDay = new Map<string, number>();
  for (const row of report.rows ?? []) {
    const day = row.dimensionValues?.[0]?.value;
    if (day) byDay.set(day, Number(row.metricValues?.[0]?.value ?? 0));
  }
  return enumerateDays(range).map((day) => byDay.get(day) ?? 0);
}

export interface SiteUrl {
  propertyId: string;
  displayName: string;
  url: string;
}

/** Each property's first web data stream URL (defaultUri). Non-web properties are skipped. */
export async function listSiteUrls(auth: OAuth2Client): Promise<SiteUrl[]> {
  const props = await listProperties(auth);
  const client = admin(auth);
  const out: SiteUrl[] = [];
  await Promise.all(
    props.map(async (p) => {
      const [streams] = await client.listDataStreams({ parent: `properties/${p.propertyId}` });
      const url = streams.find((s) => s.webStreamData?.defaultUri)?.webStreamData?.defaultUri;
      if (url) out.push({ propertyId: p.propertyId, displayName: p.displayName, url });
    }),
  );
  return out;
}
