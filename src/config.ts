import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Local app identifier — also used for the config dir name (~/.sitedeck). */
export const APP_NAME = 'sitedeck';

/** HTTP port for the local dashboard server (also the OAuth loopback target). */
export const PORT = Number(process.env.PORT ?? 4317);

/**
 * Read-only Analytics scope. Covers both the Admin API
 * (accountSummaries.list) and the Data API (runReport).
 */
export const GA_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

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
 * OAuth loopback callback. A Desktop OAuth client allows redirects to any
 * localhost port/path, so we reuse the dashboard server's port.
 */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';
export const REDIRECT_URI = `http://localhost:${PORT}${OAUTH_CALLBACK_PATH}`;

/** PageSpeed Insights / performance-tracking config. */
export const CONFIG_JSON_PATH = path.join(CONFIG_DIR, 'config.json');
export const INSIGHTS_PATH = path.join(CONFIG_DIR, 'insights.json');
export const INSIGHTS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const INSIGHTS_CONCURRENCY = 2;
export const INSIGHTS_RETENTION = 90;
export const INSIGHTS_TREND_LENGTH = 30;

/** PSI API key: env SITEDECK_PSI_KEY, else psiApiKey in ~/.sitedeck/config.json, else null. */
export function getPsiApiKey(): string | null {
  if (process.env.SITEDECK_PSI_KEY) return process.env.SITEDECK_PSI_KEY;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { psiApiKey?: unknown };
    return typeof cfg.psiApiKey === 'string' && cfg.psiApiKey ? cfg.psiApiKey : null;
  } catch {
    return null;
  }
}
