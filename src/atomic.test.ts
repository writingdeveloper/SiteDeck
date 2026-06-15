import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './atomic';

const dirs: string[] = [];
async function makeDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'sitedeck-atomic-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('writeJsonAtomic', () => {
  it('writes JSON that reads back identically and creates the parent dir', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'nested', 'data.json');
    const value = { a: 1, b: ['x', 'y'], c: { d: true } };
    await writeJsonAtomic(file, value);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(value);
  });

  it('leaves no temporary file behind', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'data.json');
    await writeJsonAtomic(file, { ok: true });
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('overwrites an existing file', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'data.json');
    await writeJsonAtomic(file, { v: 1 });
    await writeJsonAtomic(file, { v: 2 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 2 });
  });
});
