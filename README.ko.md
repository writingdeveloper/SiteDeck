# SiteDeck

[English](README.md) · **한국어** · [Español](README.es.md) · [中文](README.zh.md) · [日本語](README.ja.md)

[![CI](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

여러 Google Analytics 4(GA4) 속성의 핵심 지표를, 속성마다 들어가 보지 않고
**한 화면에서 요약**해 보는 로컬 대시보드.

- **지표** — 활성 사용자, 세션, 핵심 이벤트(직전 기간 대비 Δ% ▲▼), 탑 페이지, 탑 채널, 일별 추세 스파크라인
- **기간** — 7 / 28 / 90일 토글, 정렬 가능한 컬럼
- **인증** — OAuth 2.0 loopback: 내 Google 계정 1회 로그인 → 접근 가능한 모든 GA4 속성 자동 수집
- **비용** — 0원 (GA API 무료 쿼터 내)

## 요구사항

- Node.js ≥ 20 (개발 환경: v22)

## 설치

```bash
npm install
```

## Google Cloud 설정 (1회, ~5분)

1. [Google Cloud Console](https://console.cloud.google.com)에서 새 프로젝트 생성
2. **Google Analytics Admin API** + **Google Analytics Data API** 사용 설정
3. OAuth 동의 화면: **External**, 본인을 **테스트 사용자**로 추가
4. 사용자 인증 정보 → **OAuth 클라이언트 ID** → **데스크톱 앱** → JSON 다운로드
5. 프로젝트 루트에 `credentials.json`으로 저장(git 제외). 형식은 [`credentials.json.example`](credentials.json.example) 참고

## 실행

```bash
npm start        # http://localhost:4317
```

첫 실행 시 Google 로그인 1회 → 갱신 토큰은 `~/.sitedeck/token.json`에만 저장됩니다.

## 성능 (PageSpeed)

**성능** 탭은 각 사이트의 라이트하우스 점수(성능·접근성·모범사례·SEO)를 PageSpeed Insights
API로 추적합니다. 앱 실행 중 하루 1회 자동 측정 + 수동 **측정** 버튼. 점수는
`~/.sitedeck/insights.json`에 로컬 저장되며, 측정 URL은 각 GA4 속성의 웹 데이터 스트림에서
자동 추출됩니다.

사용하려면 PageSpeed Insights API 키를 추가하세요:

1. 같은 GCP 프로젝트에서 **PageSpeed Insights API** 사용 설정
2. **API 키** 생성 (API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키)
3. `~/.sitedeck/config.json`에 저장:
   ```json
   { "psiApiKey": "YOUR_API_KEY" }
   ```
   (또는 `SITEDECK_PSI_KEY` 환경변수 설정)

## 데스크톱 앱 (Electron)

브라우저 대신 데스크톱 창으로 실행:

```bash
npm run electron
```

Google 로그인은 시스템 기본 브라우저에서 진행되며(임베디드 웹뷰 로그인은 Google이 차단), 인증 후 앱에서 새로고침하면 데이터가 표시됩니다.

### 설치 파일 빌드

```bash
npm run dist          # release/ 에 설치 파일 생성
```

데스크톱 빌드는 GitHub Releases로 **자동 업데이트**됩니다(`electron-updater`). 설치된 앱이
업데이트할 릴리스를 게시하려면:

```bash
npm version patch                 # 버전 올리고 태그 생성
GH_TOKEN=<토큰> npm run release    # 빌드 + GitHub Releases 게시
```

또는 `v*` 태그를 푸시하면 [릴리스 워크플로](.github/workflows/release.yml)가 빌드·게시합니다.

> 설치형 앱에서는 `credentials.json`을 `~/.sitedeck/`에 두세요(소스 실행 시에만 프로젝트 루트를 확인).

## 스크립트

| 스크립트 | 설명 |
| --- | --- |
| `npm start` | 대시보드 서버 실행 |
| `npm run dev` | 파일 변경 시 자동 재시작 |
| `npm run electron` | 데스크톱(Electron) 창으로 실행 |
| `npm run dist` | 데스크톱 설치 파일 패키징 |
| `npm run release` | 빌드 + GitHub Releases 게시 |
| `npm test` | 단위 테스트(vitest) |
| `npm run typecheck` | 타입 검사 |

## 구조

```
src/
  config.ts    상수 · 로컬 경로 · OAuth 범위
  server.ts    HTTP 서버 (/ 대시보드, /api/summary, OAuth 콜백)
  periods.ts   기간 → 현재/직전 날짜 범위 계산
  auth.ts      OAuth loopback + 토큰 캐시
  ga.ts        Admin 속성 나열 + Data API runReport
  summary.ts   사이트별 요약 + Δ% 조립
public/        대시보드 프런트(HTML/CSS/JS, 다크 테마)
electron/      데스크톱 래핑(Electron main + 자동 업데이터)
```

## 동작 방식

- 속성마다 현재·직전 기간을 병렬 `runReport`로 수집하고, 속성들도 서로 병렬 처리합니다.
- 완전한 날만 집계합니다(부분 집계되는 오늘 제외).
- `credentials.json`과 토큰(`~/.sitedeck/token.json`)은 로컬에만 있으며 커밋되지 않습니다.
- GA 범위는 읽기 전용(`analytics.readonly`)만 요청합니다.

## 기여

PR 환영합니다. `npm run typecheck`와 `npm test` 통과를 확인해 주세요. 순수 로직은 TDD로 작성합니다.

## 라이선스

[MIT](LICENSE) © Si Hyeong Lee
