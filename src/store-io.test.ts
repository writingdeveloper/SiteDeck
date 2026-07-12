import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFile, readFile, readdir, mkdtemp, mkdir, stat, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadJsonStore, saveJsonStore, MAX_BACKUPS } from './store-io';

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

  it('ENOENT가 아닌 읽기 실패(디렉터리를 가리킴)는 reject하고 파일에 손대지 않는다 (.bak도 안 만든다)', async () => {
    const dir = await tmpDir();
    const target = path.join(dir, 'x.json');
    // A directory at the target path makes readFile() reject with something other than
    // ENOENT — EISDIR, reliably reproduced on this machine — standing in for EMFILE/EIO/
    // EBUSY/EACCES: any failure to READ, as opposed to a successfully-read-but-bad-content
    // file. This MUST reject, not silently recover: recovering here would rename away a path
    // we never even managed to read, which could be a perfectly good file blocked only by a
    // transient OS error (see loadJsonStore's doc comment).
    await mkdir(target);
    await expect(loadJsonStore(target, empty, isValid, 1)).rejects.toThrow();
    // Untouched: still the same directory — not renamed to a .bak, not replaced.
    expect((await stat(target)).isDirectory()).toBe(true);
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

describe('saveJsonStore (sweepStaleTemps age heuristic)', () => {
  // Own-pid exclusion alone isn't enough to prove a foreign .tmp is abandoned — a genuinely
  // live SECOND process's in-flight write has a different pid too. These pin the age proxy
  // that covers that gap (see sweepStaleTemps's doc comment in store-io.ts).
  it('막 생성된 다른 프로세스의 .tmp는 살아있는 쓰기로 보고 지우지 않는다', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    const foreignTmp = path.join(dir, 'x.json.otherpid.deadbeef.tmp');
    await writeFile(foreignTmp, '{}'); // mtime = now → looks live
    await saveJsonStore(file, { version: 1, items: {} });
    expect(await readFile(foreignTmp, 'utf8')).toBe('{}'); // untouched
  });

  it('60초 넘게 방치된 다른 프로세스의 .tmp는 정리한다', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'x.json');
    const foreignTmp = path.join(dir, 'x.json.otherpid.deadbeef.tmp');
    await writeFile(foreignTmp, '{}');
    const old = new Date(Date.now() - 61_000);
    await utimes(foreignTmp, old, old); // backdate past the liveness window
    await saveJsonStore(file, { version: 1, items: {} });
    await expect(readFile(foreignTmp, 'utf8')).rejects.toThrow();
  });
});
