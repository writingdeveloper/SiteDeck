import os from 'node:os';
import path from 'node:path';

/** Local app identifier — also used for the config dir name (~/.sitedeck). */
export const APP_NAME = 'sitedeck';

/** HTTP port for the local dashboard server (also the OAuth loopback target). */
export const PORT = Number(process.env.PORT ?? 4317);

/**
 * Read-only Analytics scope. Covers both the Admin API
 * (accountSummaries.list) and the Data API (runReport).
 */
export const GA_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

/** OAuth client credentials downloaded from Google Cloud Console (Desktop app). */
export const CREDENTIALS_PATH =
  process.env.SITEDECK_CREDENTIALS ?? path.resolve(process.cwd(), 'credentials.json');

/** Local-only directory + refresh/access token cache. Never committed. */
export const CONFIG_DIR = path.join(os.homedir(), `.${APP_NAME}`);
export const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');

/** Supported summary periods, in days. */
export const PERIODS = [7, 28, 90] as const;
export type Period = (typeof PERIODS)[number];

/**
 * OAuth loopback callback. A Desktop OAuth client allows redirects to any
 * localhost port/path, so we reuse the dashboard server's port.
 */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';
export const REDIRECT_URI = `http://localhost:${PORT}${OAUTH_CALLBACK_PATH}`;
