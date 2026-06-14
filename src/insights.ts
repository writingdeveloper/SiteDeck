import {
  INSIGHTS_PATH,
  INSIGHTS_INTERVAL_MS,
  INSIGHTS_CONCURRENCY,
  INSIGHTS_RETENTION,
  INSIGHTS_TREND_LENGTH,
  getPsiApiKey,
} from './config';
import { getClient } from './auth';
import { listSiteUrls } from './ga';
import { fetchPsiScores } from './psi';
import {
  type InsightsStore,
  emptyStore,
  loadStore,
  saveStore,
  appendMeasurement,
  shouldMeasure,
  summarize,
} from './insights-store';

let store: InsightsStore = emptyStore();
let measuring = false;
let lastErrors: { url: string; message: string }[] = [];

export async function initInsights(): Promise<void> {
  store = await loadStore(INSIGHTS_PATH);
}

export function getInsightsState() {
  return {
    configured: getPsiApiKey() !== null,
    isMeasuring: measuring,
    lastRunAt: store.lastRunAt,
    sites: summarize(store, INSIGHTS_TREND_LENGTH),
    errors: lastErrors,
  };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function runMeasurement(): Promise<void> {
  const apiKey = getPsiApiKey();
  if (!apiKey) return;
  measuring = true;
  lastErrors = [];
  try {
    const auth = await getClient();
    const sites = await listSiteUrls(auth);
    await mapLimit(sites, INSIGHTS_CONCURRENCY, async (site) => {
      try {
        const scores = await fetchPsiScores(apiKey, site.url);
        store = appendMeasurement(
          store,
          site.url,
          site.displayName,
          { ts: new Date().toISOString(), ...scores },
          INSIGHTS_RETENTION,
        );
      } catch (err) {
        lastErrors.push({ url: site.url, message: err instanceof Error ? err.message : String(err) });
      }
    });
    await saveStore(INSIGHTS_PATH, store);
  } catch (err) {
    lastErrors.push({ url: '(run)', message: err instanceof Error ? err.message : String(err) });
  } finally {
    measuring = false;
  }
}

export function measureNow(): { started: boolean; reason?: string } {
  if (getPsiApiKey() === null) return { started: false, reason: 'not-configured' };
  if (measuring) return { started: false, reason: 'already-running' };
  void runMeasurement();
  return { started: true };
}

export function startInsightsScheduler(): void {
  const tick = () => {
    if (shouldMeasure(store.lastRunAt, Date.now(), INSIGHTS_INTERVAL_MS)) void runMeasurement();
  };
  tick();
  setInterval(tick, INSIGHTS_INTERVAL_MS);
}
