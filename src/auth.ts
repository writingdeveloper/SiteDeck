import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { CREDENTIALS_PATH, OAUTH_SCOPES, TOKEN_PATH } from './config';
import { AppError } from './errors';
import { writeJsonAtomic } from './atomic';

let client: OAuth2Client | null = null;
let building: Promise<OAuth2Client> | null = null;

/** Parse a Google OAuth desktop-client JSON string. Throws AppError on a bad shape. */
export function parseInstalledCredentials(raw: string): { clientId: string; clientSecret: string } {
  let obj: { installed?: Record<string, string>; web?: Record<string, string> } & Record<string, string>;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new AppError('credentials_invalid', CREDENTIALS_PATH);
  }
  const node = obj?.installed ?? obj?.web ?? obj ?? {};
  if (!node.client_id || !node.client_secret) {
    throw new AppError('credentials_invalid', CREDENTIALS_PATH);
  }
  return { clientId: node.client_id, clientSecret: node.client_secret };
}

async function loadInstalledCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_PATH, 'utf8');
  } catch {
    throw new AppError('credentials_not_found', CREDENTIALS_PATH);
  }
  return parseInstalledCredentials(raw);
}

/** Real credential state for Settings: present+parseable, present-but-bad, or absent. */
export async function credentialsStatus(): Promise<'valid' | 'invalid' | 'missing'> {
  if (!existsSync(CREDENTIALS_PATH)) return 'missing';
  try {
    parseInstalledCredentials(await readFile(CREDENTIALS_PATH, 'utf8'));
    return 'valid';
  } catch {
    return 'invalid';
  }
}

async function persistTokens(current: Credentials, incoming: Credentials): Promise<void> {
  // Refresh responses omit refresh_token; merge so we never lose it. Atomic write
  // (tmp+rename) so a crash mid-write can't truncate the token and force a re-auth.
  await writeJsonAtomic(TOKEN_PATH, { ...current, ...incoming }, { mode: 0o600 });
}

/** Lazily build a single OAuth2Client, loading any cached token from disk. */
export async function getClient(): Promise<OAuth2Client> {
  if (client) return client;
  // Coalesce concurrent first-callers onto one build so we never create two
  // clients (which would each attach a `tokens` listener and double-write).
  if (!building) {
    building = (async () => {
      const { clientId, clientSecret } = await loadInstalledCredentials();
      // redirect_uri is supplied explicitly per request (getAuthUrl / getToken),
      // derived from the actually-bound port — so none is set on the client here.
      const c = new OAuth2Client({ clientId, clientSecret });
      c.on('tokens', (tokens) => {
        void persistTokens(c.credentials, tokens);
      });
      if (existsSync(TOKEN_PATH)) {
        try {
          c.setCredentials(JSON.parse(await readFile(TOKEN_PATH, 'utf8')));
        } catch {
          // Ignore a corrupt token cache — the user can simply re-authenticate.
        }
      }
      client = c;
      return c;
    })();
  }
  try {
    return await building;
  } finally {
    // Clear on failure so a later call can retry (e.g. after adding credentials).
    if (!client) building = null;
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const c = await getClient();
  return Boolean(c.credentials?.refresh_token);
}

export function getAuthUrl(c: OAuth2Client, redirectUri: string): string {
  return c.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES,
  });
}

/** Scopes the cached token was actually granted (from the OAuth token response). */
export async function grantedScopes(): Promise<string[]> {
  const c = await getClient();
  return (c.credentials?.scope ?? '').split(/\s+/).filter(Boolean);
}

export async function handleCallback(code: string, redirectUri: string): Promise<void> {
  const c = await getClient();
  const { tokens } = await c.getToken({ code, redirect_uri: redirectUri });
  c.setCredentials(tokens);
  await persistTokens(c.credentials, tokens);
}
