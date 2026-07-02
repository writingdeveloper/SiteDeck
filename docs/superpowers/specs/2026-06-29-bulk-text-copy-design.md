# 전체 텍스트 복사 (LLM 질의용) — 설계

**작성일:** 2026-06-29
**상태:** 승인됨 (구현 대기)

## 목표 (Goal)

현재 탭(트래픽/성능/GEO)의 모든 사이트 데이터를 한 번에 LLM 친화 Markdown 텍스트로 클립보드에 복사해, Claude Code 등에 붙여넣어 바로 질의·분석할 수 있게 한다. 기존 CSV 내보내기는 유지하고 별도 "텍스트 복사" 버튼을 추가한다.

## 아키텍처 (Architecture)

CSV 내보내기 핸들러와 동일하게 현재 보이는 탭을 인식해 분기한다. 추가 API 호출 없이 이미 로드된 `state.data`(트래픽) / `state.insights`(성능) / `state.onpage`(GEO)만으로 즉시 텍스트를 만든다($0). filter/sort를 반영해 "보이는 그대로" 복사한다. 트래픽 탭은 프롬프트 한 줄 + 포트폴리오 요약 헤더 + Markdown 표 + 사이트별 개선 전략(요약 규칙, 분해 불필요분)으로 구성한다. 전략은 기존 `public/strategy.js`의 `analyzeSite(summary)`를 detail 없이 호출해 요약 규칙만 계산한다(채널 집중 규칙은 분해가 필요하므로 자동 제외). Markdown 조립의 순수 로직은 `public/format.js`에 테스트 가능한 함수로 둔다.

## 기술 스택 (Tech Stack)

바닐라 JS 프론트(`public/app.js` + `public/format.js` + `public/strategy.js`), vitest(`src/**/*.test.ts`가 `../public/*.js` import), i18n JSON ×5(en/ko/ja/zh/es).

---

## 컴포넌트 1: 순수 함수 — `public/format.js`

### `toMarkdownTable(headers, rows)`

GitHub-flavored Markdown 표 문자열을 만든다. 셀의 `|`는 `\|`로, 개행은 공백으로 이스케이프한다. rows가 비어도 헤더+구분선은 낸다.

```js
export function toMarkdownTable(headers, rows) {
  const esc = (c) => String(c === null || c === undefined ? "" : c).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = `| ${headers.map(esc).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  if (!rows.length) return `${head}\n${sep}`;
  return `${head}\n${sep}\n${rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n")}`;
}
```

### `portfolioTotals(sites)`

사이트 배열의 포트폴리오 합계를 계산한다. `declining`은 활성 사용자 델타가 숫자이고 음수인 사이트 수(prior 없음(null)은 제외). `aiSharePct`는 세션 합이 0이면 0, 아니면 소수 1자리.

```js
export function portfolioTotals(sites) {
  const acc = { activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0, declining: 0 };
  for (const s of sites) {
    acc.activeUsers += s.activeUsers?.current ?? 0;
    acc.sessions += s.sessions?.current ?? 0;
    acc.keyEvents += s.keyEvents?.current ?? 0;
    acc.aiSessions += s.aiSessions?.current ?? 0;
    if (typeof s.activeUsers?.deltaPct === "number" && s.activeUsers.deltaPct < 0) acc.declining += 1;
  }
  acc.aiSharePct = acc.sessions > 0 ? Math.round((acc.aiSessions / acc.sessions) * 1000) / 10 : 0;
  return acc;
}
```

`public/format.d.ts`에 두 함수 시그니처 추가. 테스트는 `src/format.test.ts`.

---

## 컴포넌트 2: 프론트엔드 — `public/app.js`

### 버튼

`index.html` 툴바의 `#export`(CSV) 옆에 `<button id="copytext" type="button" data-i18n="copy.textButton">Copy as text</button>` 추가. `els.copytext = document.getElementById("copytext")`.

### 핸들러 (CSV 분기 미러)

```js
els.copytext.addEventListener("click", () => {
  let text = null;
  if (!views.traffic.hidden && state.data) text = trafficMarkdown();
  else if (!views.performance.hidden && state.insights) text = performanceMarkdown();
  else if (!views.geo.hidden && state.onpage) text = geoMarkdown();
  if (text) copyText(text, els.copytext);
});
```

`copyText`/`flashCopied`(기존)로 복사 + ✓ 피드백, 실패 시 `copy.failed` 배너.

### 빌더

- `fmtCell(m)`: MetricDelta → `"4 (-33.3%)"` (deltaPct 없으면 값만).
- `trafficMarkdown()`: 프롬프트(`copy.aiPrompt`) + 제목(`copy.titleTraffic` {n,count,when}) + 포트폴리오(`copy.portfolio` {active,sessions,ai,aiPct,declining}) + `toMarkdownTable`(사이트, 활성/세션/이벤트/AI(각 fmtCell), 노출/클릭/순위, 톱페이지/톱채널, 추세=`trendSparkText`) + `## 개선 전략` 섹션(각 사이트 `analyzeSite(s)`에서 good 제외 finding을 `t(strategyKey(id),params)`로, 전략 있는 사이트만 한 줄). 사이트는 `sortedSites()`(filter/sort 반영).
- `performanceMarkdown()`: 프롬프트 + `copy.titlePerformance` {count} + 표(사이트/성능/접근성/권장/SEO/LCP/CLS/INP/측정시각) — CSV 성능 컬럼 미러, `matchesFilter` 반영.
- `geoMarkdown()`: 프롬프트 + `copy.titleGeo` {count} + 표(사이트/제목/설명/canonical/OG/JSON-LD/llms.txt/점수) — CSV GEO 미러(1/0 대신 ✓/✗ 사용), `matchesFilter` 반영.

import에 `toMarkdownTable, portfolioTotals, trendSparkText`를 `/format.js`에서 추가(`analyzeSite`, `strategyKey`는 기존).

---

## i18n (`public/locales/*.json` ×5)

신규 키(en/ko/ja/zh/es):
- `copy.textButton` — 버튼 라벨
- `copy.aiPrompt` — 프롬프트 한 줄(파라미터 없음, 범용)
- `copy.titleTraffic` {n}{count}{when} · `copy.titlePerformance` {count} · `copy.titleGeo` {count}
- `copy.portfolio` {active}{sessions}{ai}{aiPct}{declining}
- `copy.strategyHeading`

기존 `col.*`, `strategy.*`, `copy.failed` 재사용.

## 에러 처리 (Error Handling)

- 데이터 없음(state.* null): 해당 분기 미실행 → 아무 동작 없음(CSV와 동일).
- 클립보드 실패: `setStatus(t("copy.failed"), "error")`.
- filter가 전부 숨김: 표는 헤더만, 프롬프트/포트폴리오는 그대로 복사(0개 반영).

## 테스트 (Testing)

- `src/format.test.ts`: `toMarkdownTable`(헤더+행, `|`·개행 이스케이프, 빈 rows), `portfolioTotals`(합계, aiSharePct 반올림/0분모, declining이 null 델타 제외, 빈 배열 → 0).
- 브라우저 실데이터 QA: 트래픽 탭에서 텍스트 복사 → 붙여넣어 프롬프트+헤더+표+전략 확인, 콘솔 오류 0.
- 기존 174 테스트 회귀 없음.

## 비목표 (Non-goals / YAGNI)

- 심층 복사(사이트별 분해 fetch) — 제외(즉시 요약으로 충분).
- Repos 탭 텍스트 복사 — 제외(CSV도 미지원).
- 복사 형식 선택 UI — 제외(Markdown 고정).
- 포트폴리오 지표를 화면에 상시 표시 — 제외(복사 텍스트에만).
