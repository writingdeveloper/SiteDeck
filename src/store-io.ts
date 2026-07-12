import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './atomic';

/** How many timestamped .bak files to keep per store. */
export const MAX_BACKUPS = 3;

/**
 * Load a JSON store.
 *
 * Two failure modes are handled completely differently, on purpose:
 *
 * 1. We FAILED TO READ the file (anything but ENOENT — EMFILE, EIO, EBUSY, EACCES, a
 *    transient AV/indexer lock…). This says nothing about the file's content: it may be
 *    perfectly good. We NEVER route this into recovery — we rethrow and let the caller
 *    decide how to degrade for this run without persisting over it. This matters because the
 *    stores here are NOT fully re-fetchable: ga-history.json retains 365 days but only the
 *    newest 90 are re-fetched, github.json retains 90 days from a GitHub API that only serves
 *    14, and insights.json (PSI history) cannot be rebuilt at all. Silently treating an I/O
 *    error as "corrupt" would rename a good file away and let the next save overwrite it with
 *    an empty store — the exact data-destruction bug this function exists to prevent.
 * 2. The file WAS read but its content is bad — invalid JSON, wrong shape, or a `version` we
 *    don't understand. Only THIS is recovery's job: the file is moved to a timestamped .bak,
 *    the reset is logged to stderr for diagnostics (surfacing it in the UI is a known backlog
 *    item — a packaged Electron app has no console a user will ever see), and an empty store
 *    is returned. Old backups are pruned to MAX_BACKUPS.
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
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // First run — nothing to recover.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    // Any OTHER I/O error means we could not even read the file — see the doc comment above.
    // Never destroy data we merely failed to read.
    throw err;
  }

  let reason: string;
  try {
    const parsed: unknown = JSON.parse(raw);
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
  // Timestamp-first (so pruneBackups' lexicographic sort stays chronological) plus a short
  // random suffix, so two recoveries landing in the same millisecond never collide and
  // silently replace each other's backup.
  const bak = `${filePath}.${Date.now()}.${randomBytes(3).toString('hex')}.bak`;
  try {
    await rename(filePath, bak);
  } catch (err) {
    // The bad file is still in place and will fail again on the next load — never hide that.
    console.error(`SiteDeck: ${name} is unreadable (${reason}) and could not be backed up:`, err);
    return;
  }
  // Logged to stderr for diagnostics — Electron spawns this process with stderr 'inherit', but
  // a packaged Windows GUI app has no console a user will ever see this in. Surfacing this
  // reset in the UI itself is a known backlog item, not something a user can discover today.
  console.error(`SiteDeck: ${name} is unreadable (${reason}) — starting fresh. Previous file kept at ${bak}`);
  await pruneBackups(filePath).catch(() => {});
}

/** Keep only the newest MAX_BACKUPS `.bak` files for this store. */
async function pruneBackups(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  // Names are `<store>.<epoch-ms>.<hex>.bak` — epoch-ms sorts first, so lexicographic sort ==
  // chronological sort (the random suffix only ever breaks a same-millisecond tie).
  const found = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.bak')).sort();
  for (const f of found.slice(0, Math.max(0, found.length - MAX_BACKUPS))) {
    await unlink(path.join(dir, f)).catch(() => {});
  }
}

/**
 * A `.tmp` younger than this is presumed to be a LIVE in-flight write, possibly from another
 * process — see sweepStaleTemps's doc comment for why age is a sufficient proxy.
 */
const MIN_TEMP_AGE_MS = 60_000;

/**
 * Delete stale `<basename>.<pid>.<hex>.tmp` siblings left behind by a process that died
 * mid-write (writeJsonAtomic's temp name — see atomic.ts). This is ordinary here, not
 * exotic: Electron kills the server on quit, and /api/summary writes ga-history.json on
 * every call, so quitting mid-refresh happens regularly and nothing else sweeps the litter.
 *
 * Excludes the current process's own temps (never race our own in-flight write) AND, since
 * pid exclusion alone only protects THIS process, anything younger than MIN_TEMP_AGE_MS: a
 * genuinely live second process's in-flight temp could otherwise be swept mid-write (its
 * later `rename` then loses its target, which every caller already treats as a non-fatal lost
 * update — but deleting another process's live file is wrong regardless of how the failure is
 * absorbed). writeJsonAtomic's temp exists only for the few milliseconds between creation and
 * rename, so anything still present after MIN_TEMP_AGE_MS is necessarily abandoned — age alone
 * is a sufficient "not live" proxy without needing actual cross-process coordination. If we
 * can't even stat a candidate, don't guess: skip it rather than delete what we can't inspect.
 */
async function sweepStaleTemps(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  const mine = `.${process.pid}.`;
  let found: string[];
  try {
    found = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.tmp'));
  } catch {
    return;
  }
  for (const f of found) {
    if (f.includes(mine)) continue; // could be our own in-flight write — never touch it
    const full = path.join(dir, f);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(full)).mtimeMs;
    } catch {
      continue; // can't inspect it — don't delete what we can't verify is stale
    }
    if (Date.now() - mtimeMs < MIN_TEMP_AGE_MS) continue; // too young — could be a live write
    await unlink(full).catch(() => {});
  }
}

export async function saveJsonStore<T>(filePath: string, store: T): Promise<void> {
  await writeJsonAtomic(filePath, store);
  // Swept on save (not load): saves happen far more often than process starts (every
  // /api/summary call, every measurement run), so litter from a killed-mid-write process gets
  // cleaned up promptly. Doing it here also means we only ever sweep once we've proven the
  // directory is writable, instead of adding filesystem work to loadJsonStore's read path,
  // which Fix 1 above needs to stay as simple and auditable as possible.
  await sweepStaleTemps(filePath).catch(() => {});
}
