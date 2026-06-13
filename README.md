# SiteDeck

여러 Google Analytics 4(GA4) 사이트의 핵심 지표를, 사이트마다 들어가 보지 않고
한 화면에서 요약해 보는 **로컬 대시보드**.

- **지표(MVP)**: 활성 사용자(activeUsers), 세션(sessions) + 직전 동일 기간 대비 증감 Δ%(▲▼)
- **기간**: 7 / 28 / 90일 토글, 정렬 가능한 테이블
- **인증**: OAuth 2.0 loopback — 내 Google 계정 1회 로그인 → 접근 가능한 모든 GA4 속성 자동 수집
- **비용**: 0원 (GA API 무료 쿼터 내)

## 요구사항

- Node.js ≥ 20 (개발 환경: v22)

## 설치

```bash
npm install
```

## Google Cloud 설정 (1회, ~5분)

1. [Google Cloud Console](https://console.cloud.google.com)에서 새 프로젝트 생성
2. **Google Analytics Admin API** + **Google Analytics Data API** 사용 설정
3. OAuth 동의 화면: External, 테스트 사용자에 본인 계정 추가
4. 사용자 인증 정보 → OAuth 클라이언트 ID → **데스크톱 앱** → JSON 다운로드
5. 내려받은 JSON을 프로젝트 루트에 `credentials.json`으로 저장 (git 추적 제외됨 — 형식은 [`credentials.json.example`](credentials.json.example) 참고)

## 실행

```bash
npm start        # http://localhost:4317
```

처음 실행 시 브라우저에서 Google 로그인 1회 → 토큰은 `~/.sitedeck/token.json`에만 저장됩니다.

## 스크립트

- `npm start` — 대시보드 서버 실행
- `npm run dev` — 파일 변경 시 자동 재시작
- `npm test` — 단위 테스트(vitest)
- `npm run typecheck` — 타입 검사

## 구조

```
src/
  config.ts    상수 · 로컬 파일 경로 · OAuth 범위
  server.ts    HTTP 서버 (/ 대시보드, /api/summary, OAuth 콜백)
  periods.ts   기간 → 현재/직전 날짜 범위 계산
  auth.ts      OAuth loopback + 토큰 캐시        (예정)
  ga.ts        Admin 속성 나열 + Data runReport  (예정)
  summary.ts   사이트별 요약 + Δ% 조립           (예정)
public/        대시보드 프런트(HTML/CSS/JS, 다크 테마)
```

## 구현 노트

- 기간 비교는 속성당 `runReport`를 **현재·직전 2회 호출하되 두 호출을 병렬 실행**합니다.
  단일 호출에 2개 date range를 넣는 방식보다 응답 파싱이 단순·견고하고, 병렬 전송이라
  지연은 1회와 사실상 동일합니다. 여러 속성도 서로 병렬로 수집합니다.
- 모든 날짜는 **어제까지의 완전한 날**만 집계합니다(부분 집계되는 오늘 제외).

## 보안

- OAuth 클라이언트 JSON(`credentials.json`)과 토큰(`~/.sitedeck/token.json`)은
  로컬에만 저장되며 저장소에 커밋되지 않습니다.
- GA 범위는 읽기 전용(`analytics.readonly`)만 요청합니다.

## 기여

PR 환영합니다. 변경 전 `npm run typecheck`와 `npm test`가 통과하는지 확인해 주세요.
순수 로직은 TDD(테스트 우선)로 작성합니다.

## 라이선스

[MIT](LICENSE) © Si Hyeong Lee
