import { readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeJsonAtomic } from './atomic';

/** Load a JSON store, recovering a corrupt/invalid file to a timestamped .bak. */
export async function loadJsonStore<T>(
  filePath: string,
  empty: () => T,
  isValid: (parsed: unknown) => boolean,
): Promise<T> {
  if (!existsSync(filePath)) return empty();
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && isValid(parsed)) return parsed as T;
    throw new Error('bad shape');
  } catch {
    await rename(filePath, `${filePath}.${Date.now()}.bak`).catch(() => {});
    return empty();
  }
}

export async function saveJsonStore<T>(filePath: string, store: T): Promise<void> {
  await writeJsonAtomic(filePath, store);
}
