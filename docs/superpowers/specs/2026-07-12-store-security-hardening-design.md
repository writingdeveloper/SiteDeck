# 저장소·보안 하드닝 — 설계 (Spec 2)

**작성일:** 2026-07-12
**상태:** 검토 대기 (작성됨)
**시리즈:** 4개 스펙 중 2/4 (정확도 ✅ → **하드닝** → MCP → UX)
**선행:** Spec 1 (머지 85a1c6d), Accuracy Guard (머지 b9fa461)

## 목표 (Goal)

로컬 스토어의 **무결성**과 비밀의 **기밀성**을 확보한다. 지금은 (a) 동시 저장이 스토어를 **손상**시킬 수 있고,
(b) 사용자가 방문한 아무 웹사이트가 설정(PSI 키·GitHub PAT)을 **변조**할 수 있으며, (c) 손상 복구가 **조용해서**
누적 이력이 소리 없이 초기화되고, (d) 산발적 rejection이 프로세스를 **죽일 수** 있다.

이 스펙은 **Spec 3(MCP)의 전제조건**이다 — 특히 원자적 쓰기 수정 없이는, 실행 중인 서버와 다른 프로세스가
같은 `~/.sitedeck/*.json`을 같은 임시 파일 이름으로 동시에 쓰면서 손상이 크로스프로세스로 확대된다.

## 배경 (현재 코드에서 확인된 사실)

- `atomic.ts:15` — `const tmp = \`${filePath}.tmp\`` — **고정 임시 파일 이름**. 두 writer가 같은 temp를 공유해
  내용이 뒤섞이고 두 rename이 경합한다. `fsync`도 없다. 그런데 파일 상단 주석은
  *"A crash mid-write can never truncate or corrupt the existing file"* 라고 **사실이 아닌 보장을 단언**한다.
  `/api/summary`는 매 호출마다 `ga-history.json`을 저장하므로(기간 토글·자동 새로고침·수동 새로고침) 실제로 경합한다.
- `server.ts:267-270` — 유일한 방어인 Host 헤더 검사는 **크로스사이트 POST를 막지 못한다**. 그 요청은 진짜로
  `localhost:PORT` 앞으로 온 것이기 때문이다. POST 3개(`/api/insights/measure`, `/api/github/measure`,
  `/api/settings`)가 무방비다. `readJsonBody`는 Content-Type도 보지 않는다.
- `settings.ts:59` — `writeJsonAtomic(CONFIG_JSON_PATH, next)` — **`mode`를 넘기지 않는다.** 그런데
  `config.json`은 `psiApiKey`·`githubToken`(비밀)을 담고, `writeJsonAtomic`은 이미 `mode` 옵션을 받으며
  `auth.ts:50`은 `token.json`에 `0o600`을 쓴다. 비밀 파일 하나만 보호되고 하나는 방치된 셈.
- `store-io.ts:17` — `rename(...).catch(() => {})` — 손상 복구가 **완전히 조용**하고, `.bak`이 무한 누적되며,
  rename 실패도 삼켜진다. `version`은 기록만 하고 **검증하지 않는다**(`isValid`는 최상위 키 1개만 확인).
- `server.ts:509` — `void open(...)` 미보호. 프로세스 레벨 `unhandledRejection`/`uncaughtException` 핸들러 없음.

**안전 확인(구현 전 실측):** `loadJsonStore`가 읽는 3개 스토어(`ga-history.json`·`insights.json`·`github.json`)는
**전부 `version: 1`** 이므로 version 검증 도입이 기존 데이터를 파괴하지 않는다. `config.json`은 version이 없지만
`loadJsonStore`를 거치지 않고 `settings.ts`가 직접 읽으므로 **검증 대상이 아니다**(적용했다면 설정이 날아갔다).

## 아키텍처 (Architecture)

다섯 개의 독립적인 하드닝. 서로 얽히지 않으므로 개별 태스크로 쪼개 검증한다.

**핵심 결정 — 크로스프로세스 락은 만들지 않는다.** 임시 파일 이름을 writer마다 고유하게 만들면 **손상은 원천
불가능**해진다(각자 자기 temp에 쓰고 원자적으로 rename). 남는 실패 모드는 "덮어쓰기 손실"(마지막 rename 승)뿐인데,
`ga-history.json`은 매 요약마다 90일을 재조회하는 **캐시**라 다음 새로고침에 자가치유된다. Spec 3의 MCP는
**read-only 설계**라 애초에 쓰지 않는다. 락은 stale lock 회수·Windows 시맨틱 등 복잡도만 크고 이득이 작다 → 비목표.

**정직성 원칙.** 이 스펙의 절반은 "코드가 하지 않는 일을 한다고 주장하는 것"을 고치는 일이다. `atomic.ts`의
거짓 보장 주석, 조용한 이력 초기화, 검증하지 않는 `version`이 모두 그 부류다.

## 기술 스택 (Tech Stack)

ESM TypeScript, `node:fs/promises`(`FileHandle.sync`), `node:crypto`(고유 temp 이름), vitest. 신규 의존성 없음.

---

## 컴포넌트 1: 원자적 쓰기 — `src/atomic.ts` (C1)

세 가지를 고친다: **고유 임시 이름**, **fsync**, **프로세스 내 경로별 직렬화**.

```ts
/** 대상 경로별 진행 중 쓰기 — 같은 스토어의 동시 저장이 뒤섞이지 않게 프로세스 내에서 직렬화한다. */
const inFlight = new Map<string, Promise<void>>();

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts?: { mode?: number },
): Promise<void>
```
- 임시 파일: `` `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp` `` — 두 writer가(다른 프로세스라도)
  같은 temp를 절대 공유하지 않는다. 동시 쓰기는 **질 수는 있어도(last rename wins) 손상시킬 수는 없다.**
- 내구성: `FileHandle.sync()`로 **바이트를 rename 전에 디스크에 확정**하고, rename 후 **부모 디렉터리도 fsync**한다
  (그러지 않으면 크래시 시 rename만 남고 데이터가 없거나, rename 자체가 사라질 수 있다).
- 디렉터리 fsync는 **Windows에서 실패하므로 삼켜서 no-op** 처리한다(NTFS rename은 메타데이터 저널링되므로 이 갭은
  POSIX 관심사다). 이 예외 처리는 의도이며 주석으로 명시한다.
- 실패 시 임시 파일을 정리해 **찌꺼기 `.tmp`를 남기지 않는다.**
- 파일 상단의 **거짓 보장 주석을 사실로 교체**한다(fsync 이후에는 실제로 참이 된다).

## 컴포넌트 2: 크로스사이트 POST 차단 — `src/server.ts` (C2)

`http-helpers.ts`에 순수 함수를 두고(테스트 가능), 서버의 Host 가드 **바로 뒤에서 모든 POST에 일괄 적용**한다
(엔드포인트별로 붙이면 미래에 추가되는 POST가 누락된다).

```ts
/** 상태를 바꾸는 요청이 동일 출처에서 왔는가. */
export function isSameOriginRequest(
  headers: { origin?: string; 'sec-fetch-site'?: string },
  allowedOrigins: string[],
): boolean
```
- `sec-fetch-site`가 있으면 `same-origin` 또는 `none`만 허용(`cross-site`·`same-site` 거부 — 다른 로컬 포트의
  앱도 우리 설정을 만질 수 없다).
- `origin`이 **없으면 허용**한다. 브라우저는 크로스오리진 POST에 `Origin`을 **항상** 붙이므로, 없다는 건
  브라우저 크로스사이트 요청이 아니라는 뜻이다(curl·로컬 스크립트). 거부해봐야 보안 이득 없이 도구만 깨진다.
- `origin`이 있으면 `http://localhost:{port}` / `http://127.0.0.1:{port}`와 정확히 일치해야 한다.
- 위반 시 **403**.
- Content-Type 강제는 **하지 않는다**(프런트가 보내지 않을 수 있어 깨질 위험만 있고, Origin 검사가 이미 완결된 방어다).

## 컴포넌트 3: 비밀 파일 권한 — `src/settings.ts`, `src/permissions.ts`(신규) (C3)

- `settings.ts`: `writeJsonAtomic(CONFIG_JSON_PATH, next, { mode: 0o600 })` — `token.json`과 동일하게.
- `src/permissions.ts`(신규): 기존 설치를 복구하는 **시작 시 1회 best-effort chmod**.
  ```ts
  /** ~/.sitedeck를 0700, 비밀 파일을 0600으로 조인다. 실패는 무시(Windows에선 사실상 no-op). */
  export async function hardenConfigPermissions(): Promise<void>
  ```
  `server.ts`의 listen 성공 후 호출.
- **정직한 한계:** Windows에서 Node의 `mode`는 NTFS ACL에 밀려 사실상 무시된다. 즉 이 수정은 **macOS/Linux
  사용자에게만 실효**가 있다(SiteDeck은 배포되는 앱이므로 고칠 가치가 있다). 이 사실을 코드 주석에 남긴다.

## 컴포넌트 4: 프로세스 생존 — `src/server.ts` (C4)

```ts
// 산발적 rejection(백그라운드 스케줄러·스토어 쓰기·open())이 장시간 실행되는 로컬 대시보드를
// 죽여선 안 된다. 크게 로그하고 계속 서빙한다. 반면 uncaughtException은 프로세스 상태를
// 미정의로 만들므로 계속하는 게 더 위험하다 — 로그 후 종료.
process.on('unhandledRejection', (reason) => { console.error('SiteDeck: unhandled rejection (continuing):', reason); });
process.on('uncaughtException', (err) => { console.error('SiteDeck: uncaught exception (exiting):', err); process.exit(1); });
```
그리고 `void open(...)` → `open(...).catch((e) => console.error('SiteDeck: could not open a browser:', e))`.

## 컴포넌트 5: 스토어 복구의 정직성 — `src/store-io.ts` (C5)

- `loadJsonStore`에 **선택적 `expectedVersion`** 추가. 불일치면 조용히 넘어가지 않고 복구 경로로 보낸다.
- 복구는 **크게 로그한다** — 사용자의 누적 이력이 초기화되는 사건이므로 소리 없이 일어나선 안 된다.
  백업 경로를 함께 출력한다.
- **rename 실패를 삼키지 않는다.** 실패하면 나쁜 파일이 그대로 남아 다음 로드에서 또 실패하므로, 그 사실을 로그한다.
- `.bak` **개수를 제한**한다(최신 `MAX_BACKUPS = 3`개만 유지). 타임스탬프 이름이라 사전식 정렬 == 시간순 정렬.
- 호출부 3곳(`ga-store`·`insights-store`·`github-store`)이 `expectedVersion = 1`을 넘긴다.
  **`config.json`에는 적용하지 않는다**(version 필드가 없고 `loadJsonStore`를 거치지 않는다).
- **마이그레이션 프레임워크는 만들지 않는다** — 존재하는 버전이 1뿐이라 마이그레이션이 없다(YAGNI).
  version 검증은 "미래의 다른 버전을 조용히 오독하지 않는다"는 방어일 뿐이다.

## 에러 처리 (Error Handling)

- `writeJsonAtomic` 실패: 임시 파일을 정리하고 예외를 던진다. 호출부(`saveGaHistory` 등)는 이미
  `.catch()`로 비치명 처리하므로 요약 응답을 막지 않는다.
- 디렉터리 fsync 실패(Windows): 의도적으로 무시(주석 명시).
- `chmod` 실패: 무시(권한 없음/Windows).
- 스토어 복구: 위 컴포넌트 5대로 **로그하되 앱을 멈추지 않는다**(빈 스토어로 계속).

## 테스트 (Testing)

- `src/atomic.test.ts`(신규): 같은 경로에 **동시에 여러 번 쓰면** 결과 파일이 항상 **유효한 JSON**이고 쓴 값 중
  하나와 정확히 일치한다(손상 없음); 성공·실패 후 **찌꺼기 `.tmp`가 남지 않는다**; POSIX에서 `mode`가 적용된다
  (Windows에선 이 단언을 건너뛴다 — 플랫폼 가드).
- `src/http-helpers.test.ts`: `isSameOriginRequest` — 동일 출처 허용, `origin` 없음 허용, 크로스사이트 거부,
  `sec-fetch-site: cross-site`/`same-site` 거부, 다른 포트의 origin 거부.
- `src/store-io.test.ts`(신규): 유효한 스토어는 그대로 로드; **version 불일치 → `.bak` + 빈 스토어**; 손상 JSON →
  `.bak` + 빈 스토어; `.bak`이 `MAX_BACKUPS`를 넘지 않도록 프루닝.
- 기존 236 테스트 회귀 없음.
- 실데이터 QA: 앱 실행 후 `~/.sitedeck`의 `version: 1` 스토어들이 **초기화되지 않는지** 확인(가장 중요),
  기간을 빠르게 토글해도 `ga-history.json`이 유효 JSON으로 유지되는지, `npm run verify:accuracy`가 여전히 통과하는지.

## 비목표 (Non-goals / YAGNI)

- **크로스프로세스 파일 락** — 위 아키텍처 결정 참조(고유 temp가 손상을 원천 차단; 덮어쓰기 손실은 캐시라 무해).
- **스토어 마이그레이션 프레임워크** — 버전이 1뿐이라 마이그레이션 대상이 없다.
- **스토어 복구를 UI에 노출** — 콘솔 로그로 우선 처리(백로그).
- **`settings.ts`의 `readFileSync` 캐싱**(C7) — 로컬 도구에서 영향이 미미(백로그).
- **Content-Type 강제** — Origin 검사가 완결된 방어이고, 프런트를 깨뜨릴 위험만 있다.
