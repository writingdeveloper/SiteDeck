import {
  INSIGHTS_PATH,
  INSIGHTS_INTERVAL_MS,
  INSIGHTS_CONCURRENCY,
  INSIGHTS_RETENTION,
  INSIGHTS_TREND_LENGTH,
} from './config';
import { getPsiApiKey } from './settings';
import { getClient } from './auth';
import { listSiteUrls } from './ga';
import { fetchPsiScores } from './psi';
import {
  type InsightsStore,
  emptyStore,
  loadStore,
  saveStore,
  appendMeasurement,
  summarize,
} from './insights-store';
import { shouldMeasure } from './schedule';
import { mapPool } from './concurrency';

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

async function runMeasurement(): Promise<void> {
  const apiKey = getPsiApiKey();
  // Guard here (not only in measureNow) so the scheduler tick can never start a
  // second run that races with an in-flight one and double-appends measurements.
  if (!apiKey || measuring) return;
  measuring = true;
  lastErrors = [];
  try {
    const auth = await getClient();
    const sites = await listSiteUrls(auth);
    await mapPool(sites, INSIGHTS_CONCURRENCY, async (site) => {
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
  // unref so this daily timer never keeps the process alive on its own.
  setInterval(tick, INSIGHTS_INTERVAL_MS).unref();
}
