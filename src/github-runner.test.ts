import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the disk/network/config edges; keep the pure store + parseRepo real.
vi.mock('./settings', async (orig) => ({
  ...(await orig<typeof import('./settings')>()),
  getGithubToken: vi.fn(),
  getGithubRepos: vi.fn(),
}));
vi.mock('./github', async (orig) => ({
  ...(await orig<typeof import('./github')>()),
  fetchRepoTraffic: vi.fn(),
}));
vi.mock('./github-store', async (orig) => ({
  ...(await orig<typeof import('./github-store')>()),
  loadStore: vi.fn(),
  saveStore: vi.fn(async () => {}),
}));

import { measureNow, getGithubState, initGithub } from './github-runner';
import { getGithubToken, getGithubRepos } from './settings';
import { fetchRepoTraffic } from './github';
import { loadStore, saveStore, emptyStore } from './github-store';

const mockToken = vi.mocked(getGithubToken);
const mockRepos = vi.mocked(getGithubRepos);
const mockFetch = vi.mocked(fetchRepoTraffic);
const mockLoadStore = vi.mocked(loadStore);
const mockSaveStore = vi.mocked(saveStore);
const EMPTY = { views: [], clones: [], referrers: [], paths: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

const settle = () => vi.waitFor(() => expect(getGithubState().isMeasuring).toBe(false));

describe('measureNow', () => {
  it('returns not-configured when there is no token', () => {
    mockToken.mockReturnValue(null);
    expect(measureNow()).toEqual({ started: false, reason: 'not-configured' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches only well-formed owner/repo entries and records the rest as errors', async () => {
    mockToken.mockReturnValue('tok');
    mockRepos.mockReturnValue(['ok/repo', 'owner/repo/extra', 'noslash', 'bad/']);
    mockFetch.mockResolvedValue(EMPTY);
    expect(measureNow()).toEqual({ started: true });
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('tok', 'ok', 'repo');
    expect(getGithubState().errors.map((e) => e.repo).sort()).toEqual(['bad/', 'noslash', 'owner/repo/extra']);
  });

  it('isolates one repo failure without aborting the rest of the batch', async () => {
    mockToken.mockReturnValue('tok');
    mockRepos.mockReturnValue(['a/x', 'b/y']);
    mockFetch.mockImplementation(async (_t, owner) => {
      if (owner === 'a') throw new Error('boom');
      return EMPTY;
    });
    measureNow();
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const errs = getGithubState().errors;
    expect(errs).toHaveLength(1);
    expect(errs[0]?.repo).toBe('a/x');
    expect(errs[0]?.message).toContain('boom');
  });

  it('refuses a second concurrent run while one is in flight', async () => {
    mockToken.mockReturnValue('tok');
    mockRepos.mockReturnValue(['a/x']);
    let release = () => {};
    mockFetch.mockReturnValue(new Promise((res) => {
      release = () => res(EMPTY);
    }));
    expect(measureNow()).toEqual({ started: true });
    expect(measureNow()).toEqual({ started: false, reason: 'already-running' });
    release();
    await settle();
  });
});

// Regression coverage for the CRITICAL data-loss fix in store-io.ts's loadJsonStore: a FAILED
// READ (anything but ENOENT) must never be treated as safe to overwrite. loadJsonStore's own
// rethrow is covered by store-io.test.ts; these two tests cover the OTHER half of the fix —
// that a load-then-save caller actually honors that rethrow by skipping the save — which had
// no test coverage at all before these were added.
describe('storeReadable guard (regression for the CRITICAL data-loss fix)', () => {
  // Order matters: storeReadable (see github-runner.ts) only ever flips true -> false for a
  // given module instance and never resets, so the "guard allows the save" case must run
  // before the "guard blocks the save" case. No other test in this file calls initGithub(),
  // so this ordering dependency is local to these two tests.
  it('saves after a measurement run when the initial load succeeded (sanity check for the guard test below)', async () => {
    mockToken.mockReturnValue('tok');
    mockRepos.mockReturnValue(['a/x']);
    mockFetch.mockResolvedValue(EMPTY);
    mockLoadStore.mockResolvedValue(emptyStore());
    await initGithub();
    expect(measureNow()).toEqual({ started: true });
    await settle();
    expect(mockSaveStore).toHaveBeenCalledTimes(1);
  });

  it('never saves when the initial load failed to read (non-ENOENT) — would otherwise clobber a good-but-unreadable file', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockToken.mockReturnValue('tok');
      mockRepos.mockReturnValue(['a/x']);
      mockFetch.mockResolvedValue(EMPTY);
      mockLoadStore.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EMFILE' }));
      await initGithub();
      expect(measureNow()).toEqual({ started: true });
      await settle();
      expect(mockSaveStore).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
