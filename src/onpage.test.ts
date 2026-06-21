import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseOnPage, fetchOnPage, isSafeUrl, isBlockedHost } from './onpage';
import { mapPool } from './concurrency';

afterEach(() => vi.unstubAllGlobals());

// Stub global fetch with a per-URL responder so the network wrappers can be tested
// without real requests.
function stubFetch(fn: (url: string) => { ok: boolean; status?: number; body?: string }) {
  vi.stubGlobal('fetch', (input: unknown) => {
    const r = fn(String(input));
    return Promise.resolve({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      text: async () => r.body ?? '',
    } as unknown as Response);
  });
}

describe('SSRF guard', () => {
  it('isSafeUrl allows public http(s) and blocks bad schemes + internal hosts', () => {
    expect(isSafeUrl('https://example.com/')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('http://127.0.0.1/')).toBe(false);
    expect(isSafeUrl('http://localhost:4317/')).toBe(false);
    expect(isSafeUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeUrl('http://192.168.1.1/')).toBe(false);
    expect(isSafeUrl('http://10.0.0.5/')).toBe(false);
    expect(isSafeUrl('not a url')).toBe(false);
  });

  it('isBlockedHost flags loopback/link-local/private literals but not public hosts', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('172.16.0.1')).toBe(true);
    expect(isBlockedHost('172.32.0.1')).toBe(false);
  });

  it('fetchOnPage refuses an internal URL without any network call', async () => {
    const r = await fetchOnPage({ propertyId: '1', displayName: 'X', url: 'http://127.0.0.1/admin' });
    expect(r.checks).toBeNull();
    expect(r.error).toMatch(/blocked/i);
    expect(r.llmsTxt).toBe(false);
  });
});

const FULL = `<!doctype html><html><head>
  <title>Soursea — AI tools</title>
  <meta name="description" content="Find the best AI tools." />
  <link rel="canonical" href="https://soursea.io/" />
  <meta property="og:title" content="Soursea" />
  <meta property="og:image" content="https://soursea.io/og.png" />
  <script type="application/ld+json">{"@type":"WebSite"}</script>
</head><body>hi</body></html>`;

describe('parseOnPage', () => {
  it('detects all signals in a fully-marked-up page', () => {
    expect(parseOnPage(FULL)).toEqual({
      title: true,
      description: true,
      canonical: true,
      openGraph: true,
      structuredData: true,
    });
  });

  it('reports false for an empty document', () => {
    expect(parseOnPage('<html></html>')).toEqual({
      title: false,
      description: false,
      canonical: false,
      openGraph: false,
      structuredData: false,
    });
  });

  it('treats an empty or whitespace title as missing', () => {
    expect(parseOnPage('<title>   </title>').title).toBe(false);
    expect(parseOnPage('<title>Real</title>').title).toBe(true);
  });

  it('requires a non-empty description content', () => {
    expect(parseOnPage('<meta name="description" content="">').description).toBe(false);
    expect(parseOnPage('<meta name="description" content="x">').description).toBe(true);
  });

  it('is case-insensitive and tolerant of attribute order', () => {
    const html = '<META CONTENT="d" NAME="Description"><LINK HREF="/c" REL="Canonical">';
    const r = parseOnPage(html);
    expect(r.description).toBe(true);
    expect(r.canonical).toBe(true);
  });

  it('detects Open Graph via any og: property', () => {
    expect(parseOnPage('<meta property="og:type" content="website">').openGraph).toBe(true);
    expect(parseOnPage('<meta name="twitter:card" content="x">').openGraph).toBe(false);
  });

  it('detects JSON-LD structured data with either quote style', () => {
    expect(parseOnPage(`<script type='application/ld+json'>{}</script>`).structuredData).toBe(true);
    expect(parseOnPage('<script type="text/javascript"></script>').structuredData).toBe(false);
  });

  it('detects JSON-LD even when the type attribute is unquoted', () => {
    expect(parseOnPage('<script type=application/ld+json>{}</script>').structuredData).toBe(true);
  });

  it('does not treat a look-alike script type as JSON-LD', () => {
    expect(parseOnPage('<script type="application/ld+json-x">{}</script>').structuredData).toBe(false);
  });

  it('ignores tags inside HTML comments', () => {
    expect(parseOnPage('<!-- <title>Old</title> -->').title).toBe(false);
    const r = parseOnPage('<!-- <meta name="description" content="x"> --><title>Real</title>');
    expect(r.description).toBe(false);
    expect(r.title).toBe(true);
  });
});

const SITE = { propertyId: '1', displayName: 'X', url: 'https://x.com' };

describe('fetchOnPage', () => {
  it('parses checks on success and probes /llms.txt', async () => {
    stubFetch((url) =>
      url.endsWith('/llms.txt')
        ? { ok: true }
        : { ok: true, body: '<title>Hi</title><meta name="description" content="d">' },
    );
    const r = await fetchOnPage(SITE);
    expect(r.checks?.title).toBe(true);
    expect(r.checks?.description).toBe(true);
    expect(r.llmsTxt).toBe(true);
    expect(r.error).toBeNull();
  });

  it('treats a missing /llms.txt as absent without failing the page checks', async () => {
    stubFetch((url) => (url.endsWith('/llms.txt') ? { ok: false } : { ok: true, body: '<title>Hi</title>' }));
    const r = await fetchOnPage(SITE);
    expect(r.checks?.title).toBe(true);
    expect(r.llmsTxt).toBe(false);
  });

  it('degrades to checks:null + error when the homepage fetch throws', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('boom')));
    const r = await fetchOnPage(SITE);
    expect(r.checks).toBeNull();
    expect(r.error).toContain('boom');
    expect(r.llmsTxt).toBe(false);
  });

  it('records an HTTP error and still returns the site', async () => {
    stubFetch(() => ({ ok: false, status: 503 }));
    const r = await fetchOnPage(SITE);
    expect(r.checks).toBeNull();
    expect(r.error).toMatch(/HTTP 503/);
  });
});

describe('mapPool', () => {
  it('preserves input order in the output', async () => {
    expect(await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 10)).toEqual([10, 20, 30, 40, 50]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(out).toHaveLength(7);
  });

  it('handles an empty list', async () => {
    expect(await mapPool([], 3, async (n: number) => n)).toEqual([]);
  });
});
