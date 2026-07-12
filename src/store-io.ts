import { readFile, readdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic';

/** How many timestamped .bak files to keep per store. */
export const MAX_BACKUPS = 3;

/**
 * Load a JSON store.
 *
 * A corrupt file, an unexpected shape, or a `version` we don't understand is NOT silently
 * discarded: the file is moved to a timestamped .bak, the reset is LOGGED (the user's
 * accumulated history is going away — they should be able to find out why), and an empty
 * store is returned. Old backups are pruned to MAX_BACKUPS.
 *
 * `expectedVersion` is optional: callers that pass it get the version check, callers that
 * don't keep the previous behaviour.
 */
export async function loadJsonStore<T>(
  filePath: string,
  empty: () => T,
  isValid: (parsed: unknown) => boolean,
  expectedVersion?: number,
): Promise<T> {
  if (!existsSync(filePath)) return empty();
  let reason: string;
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    if (expectedVersion !== undefined) {
      const version = (parsed as { version?: unknown }).version;
      if (version !== expectedVersion) {
        throw new Error(`version ${JSON.stringify(version)} != expected ${expectedVersion}`);
      }
    }
    if (!isValid(parsed)) throw new Error('unexpected shape');
    return parsed as T;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  await recoverStore(filePath, reason);
  return empty();
}

/** Move an unreadable store aside — loudly — and prune old backups. */
async function recoverStore(filePath: string, reason: string): Promise<void> {
  const name = path.basename(filePath);
  const bak = `${filePath}.${Date.now()}.bak`;
  try {
    await rename(filePath, bak);
  } catch (err) {
    // The bad file is still in place and will fail again on the next load — never hide that.
    console.error(`SiteDeck: ${name} is unreadable (${reason}) and could not be backed up:`, err);
    return;
  }
  console.error(`SiteDeck: ${name} is unreadable (${reason}) — starting fresh. Previous file kept at ${bak}`);
  await pruneBackups(filePath).catch(() => {});
}

/** Keep only the newest MAX_BACKUPS `.bak` files for this store. */
async function pruneBackups(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  // Names are `<store>.<epoch-ms>.bak`, so lexicographic sort == chronological sort.
  const found = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.bak')).sort();
  for (const f of found.slice(0, Math.max(0, found.length - MAX_BACKUPS))) {
    await unlink(path.join(dir, f)).catch(() => {});
  }
}

export async function saveJsonStore<T>(filePath: string, store: T): Promise<void> {
  await writeJsonAtomic(filePath, store);
}
