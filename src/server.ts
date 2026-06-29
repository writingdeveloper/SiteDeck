import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { DETAIL_TOPN, GA_CONCURRENCY, OAUTH_CALLBACK_PATH, PORT, SEARCH_CONSOLE_SCOPE, type Period } from './config';
import {
  credentialsStatus,
  getAuthUrl,
  getClient,
  grantedScopes,
  handleCallback,
  isAuthenticated,
} from './auth';
import { AppError } from './errors';
import { getSettings, updateSettings, type Settings } from './settings';
import { tServer } from './i18n';
import { comparisonRanges } from './periods';
import {
  AI_DIMENSION_FILTER,
  fetchAiSessions,
  fetchBreakdown,
  fetchDailySeries,
  fetchRange,
  fetchTopValue,
  listProperties,
  listSiteUrls,
} from './ga';
import { fetchSearchMetrics, listGscSites, matchSites } from './gsc';
import { getOnPageReport } from './onpage';
import { mapPool } from './concurrency';
import { metricDelta, type SiteSummary } from './summary';
import { getInsightsState, initInsights, measureNow, startInsightsScheduler } from './insights';
import {
  getGithubState,
  initGithub,
  measureNow as measureGithubNow,
  startGithubScheduler,
} from './github-runner';
import { listenWithFallback } from './listen';
import { escapeHtml } from './html';
import { isReauthError, isValidPropertyId, parsePeriod } from './http-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

// The port we actually bound — may differ from PORT if it was already taken.
let actualPort = PORT;

// Outstanding OAuth `state` nonces (single-use, TTL-expired) — a CSRF guard so a
// same-machine page can't forge a callback that binds the app to another account.
const pendingOAuthStates = new Set<string>();

// Build the OAuth redirect from our own bound port — never the client-supplied
// Host header — so it's always a trusted localhost URL and still works after a
// port fallback (a desktop OAuth client accepts any localhost port).
function oauthRedirectUri(): string {
  return `http://localhost:${actualPort}${OAUTH_CALLBACK_PATH}`;
}

// Conservative security headers on every response. The frontend loads only its
// own same-origin module script + styles and talks to GitHub for version checks.
function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self' https://api.github.com; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

interface SummaryError {
  propertyId: string;
  displayName: string;
  message: string;
}

async function buildSummary(period: Period): Promise<{
  authenticated: true;
  period: Period;
  generatedAt: string;
  sites: SiteSummary[];
  errors: SummaryError[];
}> {
  const auth = await getClient();
  const ranges = comparisonRanges(period);
  const errors: SummaryError[] = [];

  // GA4 properties (the dashboard rows) plus, in parallel, what's needed to attach
  // Search Console data: each property's site URL and the user's verified GSC sites.
  // GSC is best-effort — if the scope wasn't granted (older token) or a call fails,
  // we fall back to no search data rather than failing the whole summary.
  const props = await listProperties(auth);
  const [siteUrls, gscSites] = await Promise.all([
    listSiteUrls(auth, props).catch(() => []),
    listGscSites(auth).catch(() => []),
  ]);
  const gscMatch = matchSites(siteUrls, gscSites);

  // Bound the per-property fan-out: each property fans out ~7 Data API calls, so an
  // unbounded props.map would launch P×7 simultaneous requests and silently 429 past
  // ~10-15 properties. mapPool caps in-flight properties at GA_CONCURRENCY.
  const sites = (
    await mapPool(props, GA_CONCURRENCY, async (p): Promise<SiteSummary | null> => {
      try {
        const gscSiteUrl = gscMatch.get(p.propertyId);
        const [cur, prev, topPage, topSource, trend, aiCur, aiPrev, search] = await Promise.all([
          fetchRange(auth, p.propertyId, ranges.current),
          fetchRange(auth, p.propertyId, ranges.previous),
          fetchTopValue(auth, p.propertyId, ranges.current, 'pagePath', 'screenPageViews'),
          fetchTopValue(auth, p.propertyId, ranges.current, 'sessionDefaultChannelGroup', 'sessions'),
          fetchDailySeries(auth, p.propertyId, ranges.current),
          fetchAiSessions(auth, p.propertyId, ranges.current),
          fetchAiSessions(auth, p.propertyId, ranges.previous),
          gscSiteUrl
            ? fetchSearchMetrics(auth, gscSiteUrl, ranges.current).catch(() => null)
            : Promise.resolve(null),
        ]);
        return {
          propertyId: p.propertyId,
          displayName: p.displayName,
          activeUsers: metricDelta(cur.activeUsers, prev.activeUsers),
          sessions: metricDelta(cur.sessions, prev.sessions),
          keyEvents: metricDelta(cur.keyEvents, prev.keyEvents),
          aiSessions: metricDelta(aiCur, aiPrev),
          trend,
          topPage,
          topSource,
          search,
        };
      } catch (err) {
        errors.push({
          propertyId: p.propertyId,
          displayName: p.displayName,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    })
  ).filter((s): s is SiteSummary => s !== null);

  return { authenticated: true, period, generatedAt: new Date().toISOString(), sites, errors };
}

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

function errorBody(err: unknown): { error: { code: string; detail?: string } } {
  if (err instanceof AppError) return { error: { code: err.code, detail: err.detail } };
  return { error: { code: 'unknown', detail: err instanceof Error ? err.message : String(err) } };
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy(); // stop reading instead of buffering an unbounded body
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

let currentVersion: string | null = null;
async function getCurrentVersion(): Promise<string> {
  if (currentVersion === null) {
    const pkg = JSON.parse(await readFile(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      version: string;
    };
    currentVersion = pkg.version;
  }
  return currentVersion;
}

async function getVersion(): Promise<VersionInfo> {
  const current = await getCurrentVersion();
  let latest: string | null = null;
  try {
    const res = await fetch('https://api.github.com/repos/writingdeveloper/SiteDeck/releases/latest', {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000), // never hang the request on a slow/offline GitHub
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
    }
  } catch {
    latest = null;
  }
  return { current, latest, updateAvailable: latest !== null && latest !== current };
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
  // DNS-rebinding guard: only serve requests addressed to our own loopback host
  // (a malicious site rebinding to 127.0.0.1:PORT carries its own Host header).
  const host = req.headers.host;
  if (host !== `localhost:${actualPort}` && host !== `127.0.0.1:${actualPort}`) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  const url = new URL(req.url ?? '/', `http://localhost:${actualPort}`);

  if (url.pathname === '/api/summary') {
    try {
      const period = parsePeriod(url.searchParams.get('period'));
      if (!(await isAuthenticated())) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start' });
        return;
      }
      json(res, 200, await buildSummary(period));
    } catch (err) {
      if (isReauthError(err)) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start', reason: 'reauth_required' });
        return;
      }
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/onpage') {
    try {
      if (!(await isAuthenticated())) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start' });
        return;
      }
      json(res, 200, { authenticated: true, ...(await getOnPageReport(await getClient())) });
    } catch (err) {
      if (isReauthError(err)) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start', reason: 'reauth_required' });
        return;
      }
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/site-detail') {
    try {
      if (!(await isAuthenticated())) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start' });
        return;
      }
      const propertyId = url.searchParams.get('propertyId');
      if (!isValidPropertyId(propertyId)) {
        json(res, 400, { error: { code: 'bad_request', detail: 'invalid propertyId' } });
        return;
      }
      const range = comparisonRanges(parsePeriod(url.searchParams.get('period'))).current;
      const auth = await getClient();
      const [channels, pages, aiEngines] = await Promise.all([
        fetchBreakdown(auth, propertyId, range, 'sessionDefaultChannelGroup', 'sessions', DETAIL_TOPN),
        fetchBreakdown(auth, propertyId, range, 'pagePath', 'screenPageViews', DETAIL_TOPN),
        fetchBreakdown(auth, propertyId, range, 'sessionSource', 'sessions', DETAIL_TOPN, AI_DIMENSION_FILTER),
      ]);
      json(res, 200, { authenticated: true, channels, pages, aiEngines });
    } catch (err) {
      if (isReauthError(err)) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start', reason: 'reauth_required' });
        return;
      }
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/insights') {
    try {
      json(res, 200, getInsightsState());
    } catch (err) {
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/insights/measure' && req.method === 'POST') {
    try {
      json(res, 200, measureNow());
    } catch (err) {
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/github') {
    try {
      json(res, 200, getGithubState());
    } catch (err) {
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/github/measure' && req.method === 'POST') {
    try {
      json(res, 200, measureGithubNow());
    } catch (err) {
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const s = await getSettings();
    // Actually parse the credentials file, not just existsSync — so a malformed /
    // wrong (non-Desktop) credentials.json reports "invalid", not a false "found".
    const credStatus = await credentialsStatus();
    // Search Console state: 'reconnect' when authenticated on an older token that
    // predates the webmasters scope, 'granted' once the scope is present, else
    // 'unavailable' (not connected yet — the normal connect flow covers it).
    let searchConsole: 'granted' | 'reconnect' | 'unavailable' = 'unavailable';
    try {
      if (credStatus === 'valid' && (await isAuthenticated())) {
        searchConsole = (await grantedScopes()).includes(SEARCH_CONSOLE_SCOPE)
          ? 'granted'
          : 'reconnect';
      }
    } catch {
      searchConsole = 'unavailable';
    }
    json(res, 200, {
      language: s.language ?? null,
      hasPsiKey: Boolean(s.psiApiKey),
      psiKeyMasked: s.psiApiKey ? `${s.psiApiKey.slice(0, 6)}…${s.psiApiKey.slice(-4)}` : null,
      hasCredentials: credStatus === 'valid',
      credentialsStatus: credStatus,
      searchConsole,
    });
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const s = await updateSettings(body as Partial<Settings>);
      json(res, 200, { language: s.language ?? null, hasPsiKey: Boolean(s.psiApiKey) });
    } catch (err) {
      json(res, 500, errorBody(err));
    }
    return;
  }

  if (url.pathname === '/api/version') {
    json(res, 200, await getVersion());
    return;
  }

  if (url.pathname === '/oauth/start') {
    try {
      const auth = await getClient();
      const state = randomUUID();
      pendingOAuthStates.add(state);
      setTimeout(() => pendingOAuthStates.delete(state), 10 * 60 * 1000).unref(); // 10-min TTL
      res.writeHead(302, { location: getAuthUrl(auth, oauthRedirectUri(), state) }).end();
    } catch (err) {
      res
        .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        .end(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (url.pathname === OAUTH_CALLBACK_PATH) {
    const locale = (await getSettings()).language ?? 'en';
    const code = url.searchParams.get('code');
    const oauthError = url.searchParams.get('error');
    if (oauthError || !code) {
      // oauthError comes straight from the callback query string — escape it.
      const detail = escapeHtml(oauthError ?? tServer(locale, 'oauth.noCode'));
      res
        .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<p>${tServer(locale, 'oauth.failed', { detail })}</p>`);
      return;
    }
    // Reject a callback whose state we didn't issue (CSRF / replay). Single-use.
    const state = url.searchParams.get('state');
    if (!state || !pendingOAuthStates.delete(state)) {
      const detail = escapeHtml('invalid or expired state');
      res
        .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<p>${tServer(locale, 'oauth.failed', { detail })}</p>`);
      return;
    }
    try {
      await handleCallback(code, oauthRedirectUri());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1; url=/">` +
          `<body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:40px">` +
          `✅ ${tServer(locale, 'oauth.success')}</body>`,
      );
    } catch (err) {
      const detail = escapeHtml(err instanceof Error ? err.message : String(err));
      res
        .writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<p>${tServer(locale, 'oauth.tokenFailed', { detail })}</p>`);
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

// Bind to loopback only — never 0.0.0.0 — so this stays a local-only tool and
// doesn't expose GA4 data / settings to anyone else on the LAN.
listenWithFallback(server, PORT, 10, '127.0.0.1')
  .then((port) => {
    actualPort = port;
    console.log(`SiteDeck → http://127.0.0.1:${port}`);
    // Machine-readable line so the Electron main process learns the real port.
    console.log(`SITEDECK_LISTENING ${port}`);
    void initInsights()
      .then(startInsightsScheduler)
      .catch((err) => console.error('insights init failed:', err));
    void initGithub()
      .then(startGithubScheduler)
      .catch((err) => console.error('github init failed:', err));
    if (!process.env.SITEDECK_NO_OPEN) {
      // 127.0.0.1 (not localhost) to match the loopback bind even when localhost
      // resolves to ::1.
      void open(`http://127.0.0.1:${port}`);
    }
  })
  .catch((err: Error) => {
    console.error(`SiteDeck: could not bind a port starting at ${PORT}: ${err.message}`);
    process.exit(1);
  });
