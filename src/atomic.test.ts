import { describe, it, expect, afterEach } from 'vitest';
import { readFile, readdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './atomic';

const made: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'sitedeck-atomic-'));
  made.push(d);
  return d;
}
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('동시 쓰기가 파일을 손상시키지 않는다 (항상 유효 JSON이고, 쓴 값 중 하나와 정확히 일치)', async () => {
    const file = path.join(await tmpDir(), 'store.json');
    // 페이로드를 크게 잡아, 고정 temp 이름이었다면 쓰기가 뒤섞이도록 강제한다.
    const values = Array.from({ length: 12 }, (_, i) => ({ n: i, pad: 'x'.repeat(50_000) }));
    await Promise.all(values.map((v) => writeJsonAtomic(file, v)));
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { n: number; pad: string };
    expect(values).toContainEqual(parsed);
  });

  it('성공 후 찌꺼기 .tmp 파일을 남기지 않는다', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'store.json');
    await Promise.all([1, 2, 3, 4, 5].map((n) => writeJsonAtomic(file, { n })));
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('부모 디렉터리를 만든다', async () => {
    const file = path.join(await tmpDir(), 'a', 'b', 'store.json');
    await writeJsonAtomic(file, { ok: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ok: true });
  });

  it.skipIf(process.platform === 'win32')('mode를 적용한다 (POSIX 전용 — Windows는 NTFS ACL이 우선)', async () => {
    const file = path.join(await tmpDir(), 'secret.json');
    await writeJsonAtomic(file, { k: 'v' }, { mode: 0o600 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
