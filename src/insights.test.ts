import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OAuth2Client } from 'google-auth-library';

// Mock the disk/network/config edges; keep the pure store logic (emptyStore, appendMeasurement,
// summarize) real. Mirrors github-runner.test.ts's mocking style.
vi.mock('./settings', async (orig) => ({
  ...(await orig<typeof import('./settings')>()),
  getPsiApiKey: vi.fn(),
}));
vi.mock('./auth', async (orig) => ({
  ...(await orig<typeof import('./auth')>()),
  getClient: vi.fn(),
}));
vi.mock('./ga', async (orig) => ({
  ...(await orig<typeof import('./ga')>()),
  listSiteUrls: vi.fn(),
}));
vi.mock('./psi', async (orig) => ({
  ...(await orig<typeof import('./psi')>()),
  fetchPsiScores: vi.fn(),
}));
vi.mock('./insights-store', async (orig) => ({
  ...(await orig<typeof import('./insights-store')>()),
  loadStore: vi.fn(),
  saveStore: vi.fn(async () => {}),
}));

import { measureNow, getInsightsState, initInsights } from './insights';
import { getPsiApiKey } from './settings';
import { getClient } from './auth';
import { listSiteUrls } from './ga';
import { fetchPsiScores } from './psi';
import { loadStore, saveStore, emptyStore } from './insights-store';

const mockApiKey = vi.mocked(getPsiApiKey);
const mockGetClient = vi.mocked(getClient);
const mockListSiteUrls = vi.mocked(listSiteUrls);
const mockFetchPsi = vi.mocked(fetchPsiScores);
const mockLoadStore = vi.mocked(loadStore);
const mockSaveStore = vi.mocked(saveStore);

const SCORES = {
  performance: 90,
  accessibility: 95,
  bestPractices: 100,
  seo: 100,
  lcpMs: 1200,
  cls: 0.02,
  inpMs: 150,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-path defaults shared by both tests below — only mockLoadStore's behaviour differs
  // between them, so that difference is the only thing that can explain a different outcome.
  mockGetClient.mockResolvedValue({} as OAuth2Client);
  mockApiKey.mockReturnValue('key');
  mockListSiteUrls.mockResolvedValue([{ propertyId: 'p1', displayName: 'Site', url: 'https://a/' }]);
  mockFetchPsi.mockResolvedValue(SCORES);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () => vi.waitFor(() => expect(getInsightsState().isMeasuring).toBe(false));

// Regression coverage for the CRITICAL data-loss fix in store-io.ts's loadJsonStore: a FAILED
// READ (anything but ENOENT) must never be treated as safe to overwrite. loadJsonStore's own
// rethrow is covered by store-io.test.ts; these two tests cover the OTHER half of the fix —
// that a load-then-save caller actually honors that rethrow by skipping the save — which had
// no test coverage at all before this file existed.
describe('storeReadable guard (regression for the CRITICAL data-loss fix)', () => {
  // Order matters: storeReadable (see insights.ts) only ever flips true -> false for a given
  // module instance and never resets, so the "guard allows the save" case must run before the
  // "guard blocks the save" case. No other test in this file calls initInsights(), so this
  // ordering dependency is local to these two tests.
  it('saves after a measurement run when the initial load succeeded (sanity check for the guard test below)', async () => {
    mockLoadStore.mockResolvedValue(emptyStore());
    await initInsights();
    expect(measureNow()).toEqual({ started: true });
    await settle();
    expect(mockSaveStore).toHaveBeenCalledTimes(1);
  });

  it('never saves when the initial load failed to read (non-ENOENT) — would otherwise clobber a good-but-unreadable file', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadStore.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EMFILE' }));
    await initInsights();
    expect(measureNow()).toEqual({ started: true });
    await settle();
    expect(mockSaveStore).not.toHaveBeenCalled();
  });
});
