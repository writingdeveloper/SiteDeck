import { writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write `value` as pretty JSON to `filePath` atomically: create the parent dir,
 * write to a sibling .tmp file, then rename over the target. A crash mid-write
 * can never truncate or corrupt the existing file.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts?: { mode?: number },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), opts?.mode ? { mode: opts.mode } : undefined);
  await rename(tmp, filePath);
}
