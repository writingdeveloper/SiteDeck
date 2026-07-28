import { GITHUB_STORE_PATH, GITHUB_INTERVAL_MS, GITHUB_CONCURRENCY, GITHUB_RETENTION_DAYS, GITHUB_TREND_LENGTH } from './config';
import { getGithubToken, getGithubRepos } from './settings';
import { fetchRepoTraffic, parseRepo } from './github';
import { shouldMeasure } from './schedule';
import { mapPool } from './concurrency';
import { type GithubStore, emptyStore, loadStore, saveStore, upsertDays, putSnapshot, summarize } from './github-store';

let store: GithubStore = emptyStore();
let measuring = false;
let lastErrors: { repo: string; message: string }[] = [];
// False when the initial load below FAILED TO READ (not "was corrupt" — loadStore already
// recovers that case on its own and still resolves) the real store. `store` above is then
// just the blank fallback, and letting runMeasurement's saveStore write it out would clobber
// a file we never actually got to inspect. Stays false for this process's whole lifetime; the
// next process start retries the read from scratch.
let storeReadable = true;

export async function initGithub(): Promise<void> {
  try {
    store = await loadStore(GITHUB_STORE_PATH);
  } catch (err) {
    console.error('SiteDeck: github store unreadable — running without it and NOT persisting:', err);
    storeReadable = false;
  }
}

export function getGithubState() {
  // A token with no repo list measures nothing, so it isn't "configured" — but the two are
  // reported separately so the tab can say WHICH half is missing instead of one vague hint.
  const hasToken = getGithubToken() !== null;
  const hasRepos = getGithubRepos().length > 0;
  return {
    configured: hasToken && hasRepos,
    hasToken,
    isMeasuring: measuring,
    lastRunAt: store.lastRunAt,
    repos: summarize(store, GITHUB_TREND_LENGTH),
    errors: lastErrors,
  };
}

async function runMeasurement(): Promise<void> {
  const token = getGithubToken();
  // Guard here (not only in measureNow) so the scheduler tick can never race a second run.
  if (!token || measuring) return;
  measuring = true;
  lastErrors = [];
  try {
    const repos = getGithubRepos();
    await mapPool(repos, GITHUB_CONCURRENCY, async (fullName) => {
      const parsed = parseRepo(fullName);
      if (!parsed) {
        lastErrors.push({ repo: fullName, message: 'invalid repo (expected owner/repo)' });
        return;
      }
      try {
        const traffic = await fetchRepoTraffic(token, parsed.owner, parsed.repo);
        const ts = new Date().toISOString();
        store = upsertDays(store, fullName, parsed.repo, traffic.views, traffic.clones, GITHUB_RETENTION_DAYS, ts);
        store = putSnapshot(store, fullName, parsed.repo, traffic.referrers, traffic.paths, ts);
      } catch (err) {
        lastErrors.push({ repo: fullName, message: err instanceof Error ? err.message : String(err) });
      }
    });
    // Skip the save entirely if the initial load couldn't read the real file (see
    // storeReadable's comment above) — never persist over a file we failed to read.
    if (storeReadable) await saveStore(GITHUB_STORE_PATH, store);
  } catch (err) {
    lastErrors.push({ repo: '(run)', message: err instanceof Error ? err.message : String(err) });
  } finally {
    measuring = false;
  }
}

export function measureNow(): { started: boolean; reason?: string } {
  if (getGithubToken() === null) return { started: false, reason: 'not-configured' };
  // Distinct from 'not-configured': the token is fine, there is just nothing to measure.
  if (getGithubRepos().length === 0) return { started: false, reason: 'no-repos' };
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
