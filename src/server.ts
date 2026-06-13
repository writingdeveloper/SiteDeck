import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { OAUTH_CALLBACK_PATH, PERIODS, PORT, type Period } from './config';
import { getAuthUrl, getClient, handleCallback, isAuthenticated } from './auth';
import { comparisonRanges } from './periods';
import { fetchRange, fetchTopValue, listProperties } from './ga';
import { metricDelta, type SiteSummary } from './summary';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

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
          const [cur, prev, topPage, topSource] = await Promise.all([
            fetchRange(auth, p.propertyId, ranges.current),
            fetchRange(auth, p.propertyId, ranges.previous),
            fetchTopValue(auth, p.propertyId, ranges.current, 'pagePath', 'screenPageViews'),
            fetchTopValue(auth, p.propertyId, ranges.current, 'sessionDefaultChannelGroup', 'sessions'),
          ]);
          return {
            propertyId: p.propertyId,
            displayName: p.displayName,
            activeUsers: metricDelta(cur.activeUsers, prev.activeUsers),
            sessions: metricDelta(cur.sessions, prev.sessions),
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/api/summary') {
    try {
      const period = parsePeriod(url.searchParams.get('period'));
      if (!(await isAuthenticated())) {
        json(res, 200, { authenticated: false, authUrl: '/oauth/start' });
        return;
      }
      json(res, 200, await buildSummary(period));
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === '/oauth/start') {
    try {
      const auth = await getClient();
      res.writeHead(302, { location: getAuthUrl(auth) }).end();
    } catch (err) {
      res
        .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        .end(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (url.pathname === OAUTH_CALLBACK_PATH) {
    const code = url.searchParams.get('code');
    const oauthError = url.searchParams.get('error');
    if (oauthError || !code) {
      res
        .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<p>인증 실패: ${oauthError ?? 'code 없음'}</p>`);
      return;
    }
    try {
      await handleCallback(code);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1; url=/">` +
          `<body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:40px">` +
          `✅ 인증 완료. 대시보드로 돌아갑니다…</body>`,
      );
    } catch (err) {
      res
        .writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<p>토큰 교환 실패: ${err instanceof Error ? err.message : String(err)}</p>`);
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`SiteDeck → http://localhost:${PORT}`);
  if (!process.env.SITEDECK_NO_OPEN) {
    void open(`http://localhost:${PORT}`);
  }
});
