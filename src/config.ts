import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

/** Local app identifier — also used for the config dir name (~/.sitedeck). */
export const APP_NAME = 'sitedeck';

/** HTTP port for the local dashboard server (also the OAuth loopback target). */
export const PORT = Number(process.env.PORT ?? 4317);

/**
 * Read-only Analytics scope. Covers both the Admin API
 * (accountSummaries.list) and the Data API (runReport).
 */
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/** Read-only Search Console scope (sites.list + searchAnalytics.query). */
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** All OAuth scopes requested at consent: Analytics + Search Console. */
export const OAUTH_SCOPES = [ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE];

/** Local-only directory + refresh/access token cache. Never committed. */
export const CONFIG_DIR = path.join(os.homedir(), `.${APP_NAME}`);
export const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');

/**
 * OAuth client credentials (Desktop app JSON). Resolved from SITEDECK_CREDENTIALS,
 * then ./credentials.json (project root for `npm start`), then
 * ~/.sitedeck/credentials.json (installed/packaged app, where cwd is unreliable).
 */
function resolveCredentialsPath(): string {
  if (process.env.SITEDECK_CREDENTIALS) return process.env.SITEDECK_CREDENTIALS;
  const cwdPath = path.resolve(process.cwd(), 'credentials.json');
  if (existsSync(cwdPath)) return cwdPath;
  return path.join(CONFIG_DIR, 'credentials.json');
}

export const CREDENTIALS_PATH = resolveCredentialsPath();

/** Supported summary periods, in days. */
export const PERIODS = [7, 28, 90] as const;
export type Period = (typeof PERIODS)[number];

/**
 * OAuth loopback callback path. A Desktop OAuth client allows redirects to any
 * localhost port, so the full redirect URI is built at request time from the
 * port the server actually bound (see oauthRedirectUri in server.ts).
 */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/** PageSpeed Insights / performance-tracking config. */
export const CONFIG_JSON_PATH = path.join(CONFIG_DIR, 'config.json');
export const INSIGHTS_PATH = path.join(CONFIG_DIR, 'insights.json');
export const INSIGHTS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const INSIGHTS_CONCURRENCY = 2;
export const INSIGHTS_RETENTION = 90;
export const INSIGHTS_TREND_LENGTH = 30;

/** GitHub repo-traffic config (mirrors the PSI/insights constants). */
export const GITHUB_STORE_PATH = path.join(CONFIG_DIR, 'github.json');
export const GITHUB_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GITHUB_RETENTION_DAYS = 90;
export const GITHUB_CONCURRENCY = 2;
export const GITHUB_TREND_LENGTH = 30;
