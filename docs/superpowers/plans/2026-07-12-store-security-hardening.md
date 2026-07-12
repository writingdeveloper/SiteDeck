# 저장소·보안 하드닝 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 스토어의 무결성과 비밀의 기밀성을 확보한다 — 동시 저장 손상, localhost CSRF, 비밀 파일 권한, 프로세스 사망, 조용한 이력 초기화를 모두 제거한다. Spec 3(MCP)의 전제조건.

**Architecture:** 다섯 개의 독립적인 하드닝(C1~C5). 크로스프로세스 락은 만들지 않는다 — 임시 파일 이름을 writer마다 고유하게 하면 손상이 원천 불가능해지고, 남는 "덮어쓰기 손실"은 `ga-history.json`이 재조회 가능한 캐시라 자가치유된다.

**Tech Stack:** ESM TypeScript, `node:fs/promises`(`FileHandle.sync`), `node:crypto`, vitest. 신규 의존성 없음.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-12-store-security-hardening-design.md`
- TypeScript `noUncheckedIndexedAccess` 활성 — 배열/Record 인덱싱은 옵셔널 체이닝 또는 non-null 단정 필요(테스트 파일도 타입체크됨). `tsconfig.json`의 `include`는 `["src", "scripts"]`.
- 신규 런타임 의존성 추가 금지.
- **기존 사용자 데이터를 파괴하지 말 것.** `~/.sitedeck`의 `ga-history.json`·`insights.json`·`github.json`은 전부 `version: 1`이고 실사용 이력(99일치)을 담고 있다. `config.json`은 `version` 필드가 **없고** `loadJsonStore`를 거치지 않으므로 version 검증 대상이 **아니다** — 여기에 검증을 걸면 사용자 설정이 날아간다.
- **Windows 현실:** Node의 `mode`는 NTFS ACL에 밀려 사실상 무시되고, 디렉터리 fsync도 실패한다. 두 경우 모두 **의도적으로 삼켜서 no-op**으로 두고 주석으로 명시한다(POSIX 사용자에게는 실효가 있다).
- 브랜치: `feat/store-security-hardening` (이미 생성됨).
- 커밋 트레일러(모든 커밋 메시지 끝, 앞에 빈 줄):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LLuTzFzb7JybkfcbYhDvdX
  ```
- 검증: `npm test` (현재 236 통과), `npm run typecheck`. 둘 다 clean해야 커밋.

---

### Task 1: 원자적 쓰기 — 고유 temp + fsync + 직렬화 (C1) — `src/atomic.ts`

**Files:**
- Modify: `src/atomic.ts` (전면 교체)
- Test: `src/atomic.test.ts` (신규)

**Interfaces:**
- Produces: `writeJsonAtomic(filePath, value, opts?: { mode?: number }): Promise<void>` — 시그니처 불변(기존 호출부 무영향).

- [ ] **Step 1: 실패 테스트 작성** — `src/atomic.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/atomic.test.ts`
Expected: 첫 번째 테스트 FAIL — 고정 `.tmp` 이름 탓에 동시 writer가 같은 임시 파일을 truncate/interleave 하고, 먼저 rename한 쪽이 temp를 치워버려 두 번째 rename이 `ENOENT`로 던지거나 파일이 뒤섞인 JSON이 된다.

- [ ] **Step 3: 구현** — `src/atomic.ts` **전체를 교체**:

```ts
import { mkdir, open as openFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Serializes writes to the same target within this process, so two concurrent saves of
 *  the same store cannot interleave. (Cross-process safety comes from the unique temp
 *  name below: a racing writer can LOSE, but can never corrupt.) */
const inFlight = new Map<string, Promise<void>>();

/**
 * fsync a directory so a rename INTO it is durable — without it a crash can persist the
 * rename without the data, or lose the rename entirely.
 *
 * Windows cannot open a directory as a file handle, so this throws there and we ignore it:
 * NTFS journals rename metadata, so the durability gap this closes is a POSIX concern.
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
    // EISDIR/EPERM (Windows), EINVAL (some filesystems) — deliberately non-fatal.
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
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/atomic.test.ts` → PASS(4건, Windows에선 3건 + 1 skip). 이어서 `npm test` + `npm run typecheck` → 둘 다 clean.

- [ ] **Step 5: 커밋**

```bash
git add src/atomic.ts src/atomic.test.ts
git commit -m "fix(atomic): 고유 temp 이름 + fsync + 경로별 직렬화 — 동시 쓰기 손상 제거"
```

---

### Task 2: 크로스사이트 POST 차단 (C2) — `src/http-helpers.ts`, `src/server.ts`

**Files:**
- Modify: `src/http-helpers.ts` (순수 함수 추가)
- Modify: `src/server.ts` (Host 가드 뒤에 일괄 적용)
- Test: `src/http-helpers.test.ts`

**Interfaces:**
- Produces: `isSameOriginRequest(headers, allowedOrigins): boolean`.

- [ ] **Step 1: 실패 테스트 추가** — `src/http-helpers.test.ts`의 import에 `isSameOriginRequest`를 추가하고 append:

```ts
describe('isSameOriginRequest', () => {
  const allowed = ['http://localhost:4317', 'http://127.0.0.1:4317'];

  it('동일 출처 origin은 허용', () => {
    expect(isSameOriginRequest({ origin: 'http://127.0.0.1:4317' }, allowed)).toBe(true);
    expect(isSameOriginRequest({ origin: 'http://localhost:4317' }, allowed)).toBe(true);
  });

  it('origin이 없으면 허용 — 브라우저는 크로스오리진 POST에 항상 Origin을 붙이므로, 없다는 건 브라우저 크로스사이트가 아니라는 뜻(curl/스크립트)', () => {
    expect(isSameOriginRequest({}, allowed)).toBe(true);
  });

  it('크로스사이트 origin은 거부 — 사용자가 방문한 악성 사이트의 POST', () => {
    expect(isSameOriginRequest({ origin: 'https://evil.example' }, allowed)).toBe(false);
  });

  it('다른 로컬 포트의 origin도 거부 — 다른 로컬 앱이 우리 설정을 만질 수 없다', () => {
    expect(isSameOriginRequest({ origin: 'http://127.0.0.1:4318' }, allowed)).toBe(false);
  });

  it('sec-fetch-site: cross-site / same-site 는 거부', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': 'cross-site' }, allowed)).toBe(false);
    expect(isSameOriginRequest({ 'sec-fetch-site': 'same-site' }, allowed)).toBe(false);
  });

  it('sec-fetch-site: same-origin / none 은 허용', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4317' }, allowed)).toBe(true);
    expect(isSameOriginRequest({ 'sec-fetch-site': 'none' }, allowed)).toBe(true);
  });

  it('중복된 헤더(배열)는 거부', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': ['same-origin', 'cross-site'] }, allowed)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/http-helpers.test.ts` → FAIL (`isSameOriginRequest is not a function`).

- [ ] **Step 3: 구현** — `src/http-helpers.ts` 끝에 추가:

```ts
/**
 * Is this state-changing request same-origin?
 *
 * The DNS-rebinding guard only checks the Host header — which a cross-site POST from any
 * website the user happens to be visiting legitimately satisfies, because the request
 * really IS addressed to localhost:PORT. Browsers always attach `Origin` to a cross-origin
 * POST, so a present-but-foreign Origin is the signal.
 *
 * An ABSENT Origin means it is not a cross-site browser request (curl, a local script);
 * allowing it costs no security and keeps local tooling working.
 */
export function isSameOriginRequest(
  headers: { origin?: string | string[] | undefined; 'sec-fetch-site'?: string | string[] | undefined },
  allowedOrigins: readonly string[],
): boolean {
  const site = headers['sec-fetch-site'];
  if (Array.isArray(site)) return false; // duplicated header — treat as hostile
  // 'same-site' is rejected too: another app on a different localhost port must not be able
  // to change our settings.
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;

  const origin = headers.origin;
  if (origin === undefined) return true;
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}
```

- [ ] **Step 4: 서버에 일괄 적용** — `src/server.ts`:

import에 `isSameOriginRequest`를 추가:
```ts
import { isReauthError, isSameOriginRequest, isValidPropertyId, parsePeriod } from './http-helpers';
```
`oauthRedirectUri()` 근처에 헬퍼 추가:
```ts
// The origins our own frontend can legitimately be served from (we bind loopback only).
function allowedOrigins(): string[] {
  return [`http://localhost:${actualPort}`, `http://127.0.0.1:${actualPort}`];
}
```
Host 가드(`res.writeHead(403, …).end('Forbidden'); return;` 블록) **바로 뒤**, `const url = new URL(...)` **앞**에 삽입 — 엔드포인트별이 아니라 일괄 적용해야 미래에 추가되는 POST가 누락되지 않는다:
```ts
  // CSRF guard for state-changing requests. The Host check above cannot stop a cross-site
  // POST — that request genuinely IS addressed to our loopback host — so a website the user
  // is visiting could otherwise rewrite settings (PSI key, GitHub PAT) or trigger runs.
  if (req.method === 'POST' && !isSameOriginRequest(req.headers, allowedOrigins())) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden (cross-site)');
    return;
  }
```

- [ ] **Step 5: 통과 + 회귀 + 커밋** — Run: `npx vitest run src/http-helpers.test.ts` → PASS. `npm test` + `npm run typecheck` → clean.

수동 확인(선택): 앱을 띄우고 설정 탭에서 언어를 바꿔 저장이 여전히 동작하는지 확인(프런트의 POST는 same-origin이므로 통과해야 한다).

```bash
git add src/http-helpers.ts src/http-helpers.test.ts src/server.ts
git commit -m "fix(server): 크로스사이트 POST 차단 (localhost CSRF) — Origin/Sec-Fetch-Site 검사"
```

---

### Task 3: 비밀 파일 권한 (C3) — `src/settings.ts`, `src/permissions.ts`(신규), `src/server.ts`

**Files:**
- Modify: `src/settings.ts` (mode 전달)
- Create: `src/permissions.ts`
- Modify: `src/server.ts` (시작 시 호출)

**Interfaces:**
- Produces: `hardenConfigPermissions(): Promise<void>`.

- [ ] **Step 1: `settings.ts`에 mode 전달** — `updateSettings`의 쓰기(현재 `await writeJsonAtomic(CONFIG_JSON_PATH, next);`)를 교체:

```ts
  // config.json holds secrets (PSI key, GitHub PAT) — write it 0600 like token.json does.
  await writeJsonAtomic(CONFIG_JSON_PATH, next, { mode: 0o600 });
```

- [ ] **Step 2: `src/permissions.ts` 생성**

```ts
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
```

- [ ] **Step 3: 시작 시 호출** — `src/server.ts`의 import에 추가:
```ts
import { hardenConfigPermissions } from './permissions';
```
`listenWithFallback(...).then((port) => { … })` 안, `void initInsights()` 호출들 **앞**에 삽입:
```ts
    void hardenConfigPermissions();
```

- [ ] **Step 4: 검증 + 커밋** — 이 계층은 단위 테스트가 없다(chmod는 플랫폼 의존적이고 Windows에선 no-op). 게이트는 typecheck + 기존 스위트.

Run: `npm run typecheck` → 0 오류. Run: `npm test` → 전부 그린.

```bash
git add src/settings.ts src/permissions.ts src/server.ts
git commit -m "fix(settings): config.json의 비밀을 0600으로 저장 + 시작 시 권한 복구"
```

---

### Task 4: 프로세스 생존 (C4) — `src/server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: 프로세스 레벨 핸들러 추가** — `src/server.ts`에서 `const server = http.createServer(...)` **앞**에 삽입:

```ts
// A stray rejection — a background scheduler, a store write, `open()` — must not kill a
// long-running local dashboard: log loudly and keep serving. An uncaughtException, by
// contrast, leaves the process in an undefined state, so continuing is the riskier choice.
process.on('unhandledRejection', (reason) => {
  console.error('SiteDeck: unhandled rejection (continuing):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('SiteDeck: uncaught exception (exiting):', err);
  process.exit(1);
});
```

- [ ] **Step 2: `open()` 보호** — 현재 `void open(\`http://127.0.0.1:${port}\`);`를 교체:

```ts
      open(`http://127.0.0.1:${port}`).catch((err: unknown) =>
        console.error('SiteDeck: could not open a browser:', err),
      );
```

- [ ] **Step 3: 검증 + 커밋** — Run: `npm run typecheck` → 0 오류. Run: `npm test` → 전부 그린.

```bash
git add src/server.ts
git commit -m "fix(server): 미처리 rejection이 프로세스를 죽이지 않게 + open() 보호"
```

---

### Task 5: 스토어 복구의 정직성 (C5) — `src/store-io.ts` + 스토어 3종

**Files:**
- Modify: `src/store-io.ts` (전면 교체)
- Modify: `src/ga-store.ts`, `src/insights-store.ts`, `src/github-store.ts` (버전 상수 + 전달)
- Test: `src/store-io.test.ts` (신규)

**Interfaces:**
- Produces: `loadJsonStore(filePath, empty, isValid, expectedVersion?)` — 4번째 인자는 **선택적**이라 기존 호출부는 무영향. `MAX_BACKUPS`.

- [ ] **Step 1: 실패 테스트 작성** — `src/store-io.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/store-io.test.ts` → FAIL (`MAX_BACKUPS` 미export, version 미검사, 복구가 로그를 안 남김, 프루닝 없음).

- [ ] **Step 3: 구현** — `src/store-io.ts` **전체를 교체**:

```ts
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
```

- [ ] **Step 4: 스토어 3종이 버전을 넘기게 한다** — 매직 넘버를 남기지 말고 각 스토어에 상수를 둔다.

`src/ga-store.ts`: `emptyGaHistory` 위에 상수 추가하고 두 곳에서 사용:
```ts
/** Bump when the on-disk shape changes; loadGaHistory rejects any other version. */
export const GA_HISTORY_VERSION = 1;
```
```ts
export function emptyGaHistory(): GaHistory {
  return { version: GA_HISTORY_VERSION, byProperty: {} };
}
```
```ts
export function loadGaHistory(filePath: string): Promise<GaHistory> {
  return loadJsonStore<GaHistory>(
    filePath,
    emptyGaHistory,
    (p) => Boolean((p as { byProperty?: unknown }).byProperty),
    GA_HISTORY_VERSION,
  );
}
```

`src/insights-store.ts`: 동일 패턴 —
```ts
/** Bump when the on-disk shape changes; loadStore rejects any other version. */
export const INSIGHTS_VERSION = 1;
```
```ts
export function emptyStore(): InsightsStore {
  return { version: INSIGHTS_VERSION, lastRunAt: null, byUrl: {} };
}
```
```ts
export function loadStore(filePath: string): Promise<InsightsStore> {
  return loadJsonStore<InsightsStore>(
    filePath,
    emptyStore,
    (p) => Boolean((p as { byUrl?: unknown }).byUrl),
    INSIGHTS_VERSION,
  );
}
```

`src/github-store.ts`: 동일 패턴 —
```ts
/** Bump when the on-disk shape changes; loadStore rejects any other version. */
export const GITHUB_VERSION = 1;
```
```ts
export function emptyStore(): GithubStore {
  return { version: GITHUB_VERSION, lastRunAt: null, byRepo: {} };
}
```
```ts
export function loadStore(filePath: string): Promise<GithubStore> {
  return loadJsonStore<GithubStore>(
    filePath,
    emptyStore,
    (p) => Boolean((p as { byRepo?: unknown }).byRepo),
    GITHUB_VERSION,
  );
}
```

**절대 `config.json`에는 적용하지 말 것** — `version` 필드가 없고 `settings.ts`가 `loadJsonStore`를 거치지 않는다. 적용하면 사용자 설정(PSI 키·GitHub PAT·언어)이 날아간다.

- [ ] **Step 5: 통과 + 회귀 + 커밋** — Run: `npx vitest run src/store-io.test.ts` → PASS(6건). `npm test` + `npm run typecheck` → clean.

```bash
git add src/store-io.ts src/store-io.test.ts src/ga-store.ts src/insights-store.ts src/github-store.ts
git commit -m "fix(store): version 검증 + 시끄러운 복구 + .bak 프루닝"
```

---

## 실데이터 QA (구현 후, 머지 전 — 필수)

가장 중요한 확인은 **기존 사용자 데이터가 살아남는가**이다.

- [ ] `~/.sitedeck/*.json`을 백업한 뒤 앱을 실행(`npm start`)하고:
  - `ga-history.json`이 **초기화되지 않았는지**(속성 11개 × 90일 유지) — version 검증이 실데이터를 통과해야 한다.
  - `insights.json`·`github.json`도 마찬가지.
  - 콘솔에 `is unreadable … starting fresh` 로그가 **뜨지 않아야** 한다.
  - `.bak` 파일이 새로 생기지 **않아야** 한다.
- [ ] 기간(7/28/90)을 빠르게 연속 토글해 동시 저장을 유발한 뒤 `ga-history.json`이 유효 JSON인지 확인.
- [ ] 설정 탭에서 언어를 바꿔 저장이 되는지(프런트 POST가 same-origin이라 CSRF 가드를 통과해야 한다).
- [ ] `npm run verify:accuracy` → 여전히 0 FAIL.

## Self-Review 메모 (작성자 확인)

- **스펙 커버리지**: C1=Task 1, C2=Task 2, C3=Task 3, C4=Task 4, C5=Task 5. 스펙의 5개 컴포넌트 전부 매핑됨.
- **타입 일관성**: `writeJsonAtomic`의 시그니처는 불변이라 기존 호출부(`auth.ts`·`settings.ts`·`store-io.ts`) 무영향. `loadJsonStore`의 4번째 인자는 선택적이라 하위 호환.
- **데이터 손실 방지**: Task 5의 version 검증은 실제 스토어(전부 `version: 1`)를 통과하도록 상수 1을 쓴다. `config.json`은 명시적으로 제외(계획에 경고 포함).
- **Windows**: 디렉터리 fsync와 chmod가 no-op인 것은 의도이며, 테스트도 플랫폼 가드(`it.skipIf`)를 쓴다.
