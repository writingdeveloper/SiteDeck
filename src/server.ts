import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { CREDENTIALS_PATH, OAUTH_CALLBACK_PATH, PERIODS, PORT, type Period } from './config';
import { getAuthUrl, getClient, handleCallback, isAuthenticated } from './auth';
import { AppError } from './errors';
import { getSettings, updateSettings, type Settings } from './settings';
import { tServer } from './i18n';
import { comparisonRanges } from './periods';
import { fetchDailySeries, fetchRange, fetchTopValue, listProperties } from './ga';
import { metricDelta, type SiteSummary } from './summary';
import { getInsightsState, initInsights, measureNow, startInsightsScheduler } from './insights';
import { listenWithFallback } from './listen';
import { escapeHtml } from './html';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

// The port we actually bound — may differ from PORT if it was already taken.
let actualPort = PORT;

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

function parsePeriod(raw: string | null): Period {
  const n = Number(raw);
  return (PERIODS as readonly number[]).includes(n) ? (n as Period) : 28;
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
  const props = await listProperties(auth);
  const ranges = comparisonRanges(period);
  const errors: SummaryError[] = [];

  const sites = (
    await Promise.all(
      props.map(async (p): Promise<SiteSummary | null> => {
        try {
          const [cur, prev, topPage, topSource, trend] = await Promise.all([
            fetchRange(auth, p.propertyId, ranges.current),
            fetchRange(auth, p.propertyId, ranges.previous),
            fetchTopValue(auth, p.propertyId, ranges.current, 'pagePath', 'screenPageViews'),
            fetchTopValue(auth, p.propertyId, ranges.current, 'sessionDefaultChannelGroup', 'sessions'),
            fetchDailySeries(auth, p.propertyId, ranges.current),
          ]);
          return {
            propertyId: p.propertyId,
            displayName: p.displayName,
            activeUsers: metricDelta(cur.activeUsers, prev.activeUsers),
            sessions: metricDelta(cur.sessions, prev.sessions),
            keyEvents: metricDelta(cur.keyEvents, prev.keyEvents),
            trend,
            topPage,
            topSource,
          };
        } catch (err) {
          errors.push({
            propertyId: p.propertyId,
            displayName: p.displayName,
            message: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    )
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

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const s = await getSettings();
    json(res, 200, {
      language: s.language ?? null,
      hasPsiKey: Boolean(s.psiApiKey),
      psiKeyMasked: s.psiApiKey ? `${s.psiApiKey.slice(0, 6)}…${s.psiApiKey.slice(-4)}` : null,
      hasCredentials: existsSync(CREDENTIALS_PATH),
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
      res.writeHead(302, { location: getAuthUrl(auth, oauthRedirectUri()) }).end();
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

listenWithFallback(server, PORT, 10)
  .then((port) => {
    actualPort = port;
    console.log(`SiteDeck → http://localhost:${port}`);
    // Machine-readable line so the Electron main process learns the real port.
    console.log(`SITEDECK_LISTENING ${port}`);
    void initInsights()
      .then(startInsightsScheduler)
      .catch((err) => console.error('insights init failed:', err));
    if (!process.env.SITEDECK_NO_OPEN) {
      void open(`http://localhost:${port}`);
    }
  })
  .catch((err: Error) => {
    console.error(`SiteDeck: could not bind a port starting at ${PORT}: ${err.message}`);
    process.exit(1);
  });
