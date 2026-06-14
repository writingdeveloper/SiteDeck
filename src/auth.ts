import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { CONFIG_DIR, CREDENTIALS_PATH, GA_SCOPES, REDIRECT_URI, TOKEN_PATH } from './config';
import { AppError } from './errors';

let client: OAuth2Client | null = null;
let building: Promise<OAuth2Client> | null = null;

async function loadInstalledCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  let raw: { installed?: Record<string, string>; web?: Record<string, string> } & Record<string, string>;
  try {
    raw = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'));
  } catch {
    throw new AppError('credentials_not_found', CREDENTIALS_PATH);
  }
  const node = raw.installed ?? raw.web ?? raw;
  if (!node.client_id || !node.client_secret) {
    throw new AppError('credentials_invalid', CREDENTIALS_PATH);
  }
  return { clientId: node.client_id, clientSecret: node.client_secret };
}

async function persistTokens(current: Credentials, incoming: Credentials): Promise<void> {
  // Refresh responses omit refresh_token; merge so we never lose it.
  const merged = { ...current, ...incoming };
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
}

/** Lazily build a single OAuth2Client, loading any cached token from disk. */
export async function getClient(): Promise<OAuth2Client> {
  if (client) return client;
  // Coalesce concurrent first-callers onto one build so we never create two
  // clients (which would each attach a `tokens` listener and double-write).
  if (!building) {
    building = (async () => {
      const { clientId, clientSecret } = await loadInstalledCredentials();
      const c = new OAuth2Client({ clientId, clientSecret, redirectUri: REDIRECT_URI });
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

export function getAuthUrl(c: OAuth2Client): string {
  return c.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GA_SCOPES });
}

export async function handleCallback(code: string): Promise<void> {
  const c = await getClient();
  const { tokens } = await c.getToken(code);
  c.setCredentials(tokens);
  await persistTokens(c.credentials, tokens);
}
