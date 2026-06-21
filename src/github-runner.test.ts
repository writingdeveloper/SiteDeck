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
  saveStore: vi.fn(async () => {}),
}));

import { measureNow, getGithubState } from './github-runner';
import { getGithubToken, getGithubRepos } from './settings';
import { fetchRepoTraffic } from './github';

const mockToken = vi.mocked(getGithubToken);
const mockRepos = vi.mocked(getGithubRepos);
const mockFetch = vi.mocked(fetchRepoTraffic);
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
