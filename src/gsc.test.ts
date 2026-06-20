import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OAuth2Client } from 'google-auth-library';
import {
  normalizeHost,
  matchSites,
  parseGscSites,
  parseSearchMetrics,
  fetchSearchMetrics,
  listGscSites,
} from './gsc';

afterEach(() => vi.unstubAllGlobals());
const auth = { getAccessToken: async () => ({ token: 'tok' }) } as unknown as OAuth2Client;
function stubJson(value: unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({ ok, status, statusText: 'x', json: async () => value } as unknown as Response),
  );
}

describe('normalizeHost', () => {
  it('strips the sc-domain: prefix', () => {
    expect(normalizeHost('sc-domain:example.com')).toBe('example.com');
  });

  it('strips scheme, leading www, and trailing slash', () => {
    expect(normalizeHost('https://www.example.com/')).toBe('example.com');
    expect(normalizeHost('https://example.com')).toBe('example.com');
  });

  it('keeps subdomains and drops the path', () => {
    expect(normalizeHost('http://blog.example.com/path/')).toBe('blog.example.com');
  });

  it('lowercases', () => {
    expect(normalizeHost('HTTPS://WWW.Example.COM')).toBe('example.com');
  });

  it('returns empty for empty input', () => {
    expect(normalizeHost('')).toBe('');
  });
});

describe('matchSites', () => {
  it('matches a domain property to apex and www GA4 urls', () => {
    const m = matchSites([{ propertyId: '1', url: 'https://www.soursea.com' }], ['sc-domain:soursea.com']);
    expect(m.get('1')).toBe('sc-domain:soursea.com');
  });

  it('matches a url-prefix site by normalized host (www vs apex)', () => {
    const m = matchSites([{ propertyId: '2', url: 'https://soursea.com' }], ['https://www.soursea.com/']);
    expect(m.get('2')).toBe('https://www.soursea.com/');
  });

  it('matches a subdomain GA4 property to a covering domain property', () => {
    const m = matchSites([{ propertyId: '3', url: 'https://shop.x.com' }], ['sc-domain:x.com']);
    expect(m.get('3')).toBe('sc-domain:x.com');
  });

  it('does NOT match a subdomain to a url-prefix apex site', () => {
    const m = matchSites([{ propertyId: '4', url: 'https://shop.x.com' }], ['https://x.com/']);
    expect(m.size).toBe(0);
  });

  it('leaves unmatched properties out of the map', () => {
    const m = matchSites([{ propertyId: '5', url: 'https://a.com' }], ['sc-domain:b.com']);
    expect(m.size).toBe(0);
  });

  it('matches only the properties that have a verified site', () => {
    const m = matchSites(
      [
        { propertyId: '6', url: 'https://c.com' },
        { propertyId: '7', url: 'https://d.com' },
      ],
      ['sc-domain:c.com'],
    );
    expect(m.size).toBe(1);
    expect(m.get('6')).toBe('sc-domain:c.com');
  });

  it('returns an empty map when there are no GSC sites', () => {
    expect(matchSites([{ propertyId: '8', url: 'https://e.com' }], []).size).toBe(0);
  });

  it('prefers an exact host match over a covering parent domain (regardless of order)', () => {
    const sites = ['sc-domain:example.com', 'sc-domain:zodiacly.example.com'];
    expect(
      matchSites([{ propertyId: '1', url: 'https://zodiacly.example.com' }], sites).get('1'),
    ).toBe('sc-domain:zodiacly.example.com');
    // Reversed input order must yield the same match — not whatever the API listed first.
    expect(
      matchSites([{ propertyId: '1', url: 'https://zodiacly.example.com' }], [...sites].reverse()).get('1'),
    ).toBe('sc-domain:zodiacly.example.com');
  });

  it('falls back to a parent domain property only when there is no exact match', () => {
    const m = matchSites([{ propertyId: '1', url: 'https://shop.example.com' }], ['sc-domain:example.com']);
    expect(m.get('1')).toBe('sc-domain:example.com');
  });

  it('matches the apex GA4 url to the apex property, not a subdomain property', () => {
    const m = matchSites(
      [{ propertyId: '1', url: 'https://example.com' }],
      ['sc-domain:blog.example.com', 'sc-domain:example.com'],
    );
    expect(m.get('1')).toBe('sc-domain:example.com');
  });

  it('breaks exact-host ties (domain vs url-prefix) the same way regardless of order', () => {
    const sites = ['sc-domain:x.com', 'https://x.com/'];
    const a = matchSites([{ propertyId: '1', url: 'https://x.com' }], sites).get('1');
    const b = matchSites([{ propertyId: '1', url: 'https://x.com' }], [...sites].reverse()).get('1');
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });
});

describe('parseGscSites', () => {
  it('returns verified site URLs and drops unverified ones', () => {
    expect(
      parseGscSites({
        siteEntry: [
          { siteUrl: 'sc-domain:a.com', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://b.com/', permissionLevel: 'siteUnverifiedUser' },
          { siteUrl: 'https://c.com/', permissionLevel: 'siteFullUser' },
        ],
      }),
    ).toEqual(['sc-domain:a.com', 'https://c.com/']);
  });

  it('returns an empty array for a missing or empty list', () => {
    expect(parseGscSites({})).toEqual([]);
    expect(parseGscSites({ siteEntry: [] })).toEqual([]);
  });
});

describe('parseSearchMetrics', () => {
  it('reads clicks, impressions, and position from the first row', () => {
    expect(parseSearchMetrics({ rows: [{ clicks: 38, impressions: 1240, position: 12.34 }] })).toEqual({
      clicks: 38,
      impressions: 1240,
      position: 12.34,
    });
  });

  it('rounds clicks and impressions and defaults missing fields to 0', () => {
    expect(parseSearchMetrics({ rows: [{ clicks: 38.6, impressions: 1240.4 }] })).toEqual({
      clicks: 39,
      impressions: 1240,
      position: 0,
    });
  });

  it('returns zeros when there are no rows', () => {
    expect(parseSearchMetrics({})).toEqual({ clicks: 0, impressions: 0, position: 0 });
    expect(parseSearchMetrics({ rows: [] })).toEqual({ clicks: 0, impressions: 0, position: 0 });
  });
});

describe('listGscSites / fetchSearchMetrics (network)', () => {
  it('listGscSites returns only the verified sites from the API', async () => {
    stubJson({
      siteEntry: [
        { siteUrl: 'sc-domain:x.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://y.com/', permissionLevel: 'siteUnverifiedUser' },
      ],
    });
    expect(await listGscSites(auth)).toEqual(['sc-domain:x.com']);
  });

  it('fetchSearchMetrics parses the aggregate row', async () => {
    stubJson({ rows: [{ clicks: 5, impressions: 100, position: 3.2 }] });
    const m = await fetchSearchMetrics(auth, 'sc-domain:x.com', {
      startDate: '2024-01-01',
      endDate: '2024-01-28',
    });
    expect(m).toEqual({ clicks: 5, impressions: 100, position: 3.2 });
  });

  it('throws on a non-ok response so the caller can degrade to no data', async () => {
    stubJson({}, false, 403);
    await expect(listGscSites(auth)).rejects.toThrow(/403/);
  });
});
