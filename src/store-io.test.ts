import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadJsonStore, MAX_BACKUPS } from './store-io';

const made: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'sitedeck-store-'));
  made.push(d);
  return d;
}
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Store { version: number; items: Record<string, number> }
const empty = (): Store => ({ version: 1, items: {} });
const isValid = (p: unknown): boolean => Boolean((p as { items?: unknown }).items);
const baks = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((f) => f.endsWith('.bak'));

describe('loadJsonStore', () => {
  it('파일이 없으면 빈 스토어 (백업도 안 만든다)', async () => {
    const dir = await tmpDir();
    expect(await loadJsonStore(path.join(dir, 'x.json'), empty, isValid, 1)).toEqual(empty());
    expect(await baks(dir)).toEqual([]);
  });

  it('유효한 스토어는 그대로 로드', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    const store: Store = { version: 1, items: { a: 1 } };
    await writeFile(file, JSON.stringify(store));
    expect(await loadJsonStore(file, empty, isValid, 1)).toEqual(store);
    expect(await baks(dir)).toEqual([]);
  });

  it('version 불일치 → .bak으로 옮기고 빈 스토어 (조용히 넘어가지 않고 로그)', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    await writeFile(file, JSON.stringify({ version: 2, items: { a: 1 } }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadJsonStore(file, empty, isValid, 1)).toEqual(empty());
    expect((await baks(dir)).length).toBe(1);
    expect(err).toHaveBeenCalled(); // 이력 초기화는 소리 없이 일어나면 안 된다
  });

  it('손상된 JSON → .bak + 빈 스토어', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    await writeFile(file, '{ not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadJsonStore(file, empty, isValid, 1)).toEqual(empty());
    expect((await baks(dir)).length).toBe(1);
  });

  it('expectedVersion을 안 넘기면 version을 검사하지 않는다 (기존 호출부 호환)', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    await writeFile(file, JSON.stringify({ version: 99, items: { a: 1 } }));
    expect(await loadJsonStore(file, empty, isValid)).toEqual({ version: 99, items: { a: 1 } });
    expect(await baks(dir)).toEqual([]);
  });

  it(`.bak을 최신 ${MAX_BACKUPS}개로 제한한다`, async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 손상 → 복구를 MAX_BACKUPS + 2회 반복
    for (let i = 0; i < MAX_BACKUPS + 2; i++) {
      await writeFile(file, `{ corrupt ${i}`);
      await loadJsonStore(file, empty, isValid, 1);
    }
    expect((await baks(dir)).length).toBeLessThanOrEqual(MAX_BACKUPS);
  });
});
