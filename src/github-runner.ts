import { GITHUB_STORE_PATH, GITHUB_INTERVAL_MS, GITHUB_CONCURRENCY, GITHUB_RETENTION_DAYS, GITHUB_TREND_LENGTH } from './config';
import { getGithubToken, getGithubRepos } from './settings';
import { fetchRepoTraffic } from './github';
import { shouldMeasure } from './insights-store';
import { type GithubStore, emptyStore, loadStore, saveStore, upsertDays, putSnapshot, summarize } from './github-store';

let store: GithubStore = emptyStore();
let measuring = false;
let lastErrors: { repo: string; message: string }[] = [];

export async function initGithub(): Promise<void> {
  store = await loadStore(GITHUB_STORE_PATH);
}

export function getGithubState() {
  return {
    configured: getGithubToken() !== null,
    isMeasuring: measuring,
    lastRunAt: store.lastRunAt,
    repos: summarize(store, GITHUB_TREND_LENGTH),
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
  const token = getGithubToken();
  // Guard here (not only in measureNow) so the scheduler tick can never race a second run.
  if (!token || measuring) return;
  measuring = true;
  lastErrors = [];
  try {
    const repos = getGithubRepos();
    await mapLimit(repos, GITHUB_CONCURRENCY, async (fullName) => {
      const [owner, repo] = fullName.split('/');
      if (!owner || !repo) {
        lastErrors.push({ repo: fullName, message: 'invalid repo (expected owner/repo)' });
        return;
      }
      try {
        const traffic = await fetchRepoTraffic(token, owner, repo);
        const ts = new Date().toISOString();
        store = upsertDays(store, fullName, repo, traffic.views, traffic.clones, GITHUB_RETENTION_DAYS, ts);
        store = putSnapshot(store, fullName, repo, traffic.referrers, traffic.paths, ts);
      } catch (err) {
        lastErrors.push({ repo: fullName, message: err instanceof Error ? err.message : String(err) });
      }
    });
    await saveStore(GITHUB_STORE_PATH, store);
  } catch (err) {
    lastErrors.push({ repo: '(run)', message: err instanceof Error ? err.message : String(err) });
  } finally {
    measuring = false;
  }
}

export function measureNow(): { started: boolean; reason?: string } {
  if (getGithubToken() === null) return { started: false, reason: 'not-configured' };
  if (measuring) return { started: false, reason: 'already-running' };
  void runMeasurement();
  return { started: true };
}

export function startGithubScheduler(): void {
  const tick = () => {
    if (shouldMeasure(store.lastRunAt, Date.now(), GITHUB_INTERVAL_MS)) void runMeasurement();
  };
  tick();
  setInterval(tick, GITHUB_INTERVAL_MS).unref();
}
