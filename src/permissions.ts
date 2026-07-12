import { chmod } from 'node:fs/promises';
import { CONFIG_DIR, CONFIG_JSON_PATH, TOKEN_PATH } from './config';

/**
 * Tighten the local config dir and the two files that hold secrets: the OAuth token, and
 * config.json (PSI key + GitHub PAT). Best-effort — every failure is ignored.
 *
 * This also repairs installs created before config.json was written 0600.
 *
 * Honest limit: on Windows, Node's `mode` is overridden by NTFS ACLs, so this is
 * effectively a no-op there. The real beneficiaries are macOS/Linux users, where the
 * default umask would otherwise leave the secrets world-readable (0644) on a shared host.
 */
export async function hardenConfigPermissions(): Promise<void> {
  await chmod(CONFIG_DIR, 0o700).catch(() => {});
  await Promise.all([
    chmod(TOKEN_PATH, 0o600).catch(() => {}),
    chmod(CONFIG_JSON_PATH, 0o600).catch(() => {}),
  ]);
}
