import { mkdir, open as openFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Serializes writes to the same target within this process, so two concurrent saves of
 *  the same store cannot interleave. (Cross-process safety comes from the unique temp
 *  name below: a racing writer can LOSE, but can never corrupt.) */
const inFlight = new Map<string, Promise<void>>();

/**
 * fsync a directory so a rename INTO it is durable. The written file is already fsynced
 * before the rename (see writeOnce), so data loss is not a residual risk; the only durability
 * gap this closes is losing the rename itself (a lost update, not corruption, since the prior
 * file remains intact and valid).
 *
 * On Windows, `open(dir, 'r')` itself SUCCEEDS (measured on this machine) — it is
 * `FileHandle.sync()` that throws `EPERM`, since Windows has no equivalent of fsync-ing a
 * directory handle. We ignore that: NTFS journals rename metadata, so the durability gap
 * this closes is a POSIX concern.
 */
async function syncDir(dir: string): Promise<void> {
  try {
    const dh = await openFile(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // EPERM from FileHandle.sync() on Windows; EISDIR/EINVAL from open() itself on some other
    // filesystems — deliberately non-fatal either way.
  }
}

async function writeOnce(filePath: string, value: unknown, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  // Unique per writer AND per process: two writers never share a temp file, so a concurrent
  // write can lose (last rename wins) but can never produce a mixed/truncated target.
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fh = await openFile(tmp, 'w', mode);
    try {
      await fh.writeFile(JSON.stringify(value, null, 2));
      await fh.sync(); // bytes are on disk BEFORE the rename makes them visible
    } finally {
      await fh.close();
    }
    await rename(tmp, filePath);
    await syncDir(dir);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {}); // never leave a stray .tmp behind
    throw err;
  }
}

/**
 * Write `value` as pretty JSON to `filePath` atomically: write a UNIQUE sibling temp file,
 * fsync it, rename over the target, then fsync the directory. A crash mid-write cannot
 * truncate or corrupt the existing file, and two concurrent writers cannot interleave —
 * the loser is simply replaced by the winner's rename.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts?: { mode?: number },
): Promise<void> {
  const prev = inFlight.get(filePath) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeOnce(filePath, value, opts?.mode));
  inFlight.set(filePath, next);
  try {
    await next;
  } finally {
    if (inFlight.get(filePath) === next) inFlight.delete(filePath);
  }
}
