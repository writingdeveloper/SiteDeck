# 전체 텍스트 복사 (LLM 질의용) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 탭(트래픽/성능/GEO) 전체 사이트를 LLM 친화 Markdown 텍스트로 한 번에 클립보드 복사하는 "텍스트 복사" 버튼을 추가한다.

**Architecture:** CSV 내보내기 핸들러처럼 보이는 탭을 인식해 분기. 추가 API 호출 없이 이미 로드된 `state.data`/`state.insights`/`state.onpage`만으로 즉시 텍스트 생성($0), filter/sort 반영. 트래픽은 프롬프트 + 포트폴리오 헤더 + Markdown 표 + 사이트별 전략(요약 규칙). Markdown 조립 순수 로직은 `public/format.js`에 둔다.

**Tech Stack:** 바닐라 JS(`public/app.js`+`public/format.js`+`public/strategy.js`), vitest, i18n JSON ×5(en/ko/ja/zh/es).

**참고:** `t()`는 미스 키를 en→키로 폴백하므로 신규 키는 5개 로케일 전부에 추가. `analyzeSite(summary)`는 detail 없이 호출하면 요약 규칙만 계산(채널집중 규칙 자동 제외). `trendSparkText`, `strategyKey`, `analyzeSite`, `copyText`, `flashCopied`, `fmtWhen`, `getLocale`, `matchesFilter`, `geoScore`, `sortedSites`는 이미 존재.

---

## Task 1: 순수 함수 — `toMarkdownTable` + `portfolioTotals`

**Files:**
- Modify: `public/format.js`
- Modify: `public/format.d.ts`
- Modify: `src/format.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/format.test.ts`

import 줄에 `toMarkdownTable, portfolioTotals` 추가, 파일 끝에:

```ts
describe('toMarkdownTable', () => {
  it('헤더 + 구분선 + 행을 만든다', () => {
    expect(toMarkdownTable(['A', 'B'], [['1', '2'], ['3', '4']]))
      .toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  });
  it('셀의 파이프를 이스케이프하고 개행을 공백으로', () => {
    expect(toMarkdownTable(['H'], [['a|b'], ['c\nd']]))
      .toBe('| H |\n| --- |\n| a\\|b |\n| c d |');
  });
  it('null/undefined 셀은 빈칸, 행이 없으면 헤더만', () => {
    expect(toMarkdownTable(['H'], [])).toBe('| H |\n| --- |');
    expect(toMarkdownTable(['H'], [[null], [undefined]])).toBe('| H |\n| --- |\n|  |\n|  |');
  });
});

describe('portfolioTotals', () => {
  const md = (current: number, deltaPct: number | null = 0) => ({ current, previous: 0, deltaPct });
  it('지표 합계와 AI 비중(소수 1자리)을 계산', () => {
    const sites = [
      { activeUsers: md(10, 5), sessions: md(100, 0), keyEvents: md(2, 0), aiSessions: md(3, 0) },
      { activeUsers: md(20, 1), sessions: md(100, 0), keyEvents: md(4, 0), aiSessions: md(0, 0) },
    ];
    expect(portfolioTotals(sites)).toEqual({
      activeUsers: 30, sessions: 200, keyEvents: 6, aiSessions: 3, declining: 0, aiSharePct: 1.5,
    });
  });
  it('활성 델타가 음수인 사이트만 하락으로 카운트(null 제외)', () => {
    const sites = [
      { activeUsers: md(10, -5), sessions: md(10, 0), keyEvents: md(0, 0), aiSessions: md(0, 0) },
      { activeUsers: md(10, null), sessions: md(10, 0), keyEvents: md(0, 0), aiSessions: md(0, 0) },
      { activeUsers: md(10, 3), sessions: md(10, 0), keyEvents: md(0, 0), aiSessions: md(0, 0) },
    ];
    expect(portfolioTotals(sites).declining).toBe(1);
  });
  it('빈 배열은 0 (0으로 나누기 없음)', () => {
    expect(portfolioTotals([])).toEqual({
      activeUsers: 0, sessions: 0, keyEvents: 0, aiSessions: 0, declining: 0, aiSharePct: 0,
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/format.test.ts`
Expected: FAIL — `toMarkdownTable is not a function`

- [ ] **Step 3: `public/format.js` 끝에 함수 추가**

```js
/** Build a GitHub-flavored Markdown table from a header row + data rows.
 *  Cells: `|` escaped, newlines flattened to spaces, null/undefined → empty. */
export function toMarkdownTable(headers, rows) {
  const esc = (c) => String(c === null || c === undefined ? "" : c).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = `| ${headers.map(esc).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  if (!rows.length) return `${head}\n${sep}`;
  return `${head}\n${sep}\n${rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n")}`;
}

/** Portfolio-level rollup across sites: metric sums, AI share (1 dp), and the
 *  count of sites whose active-users delta is negative (null delta = no prior, ignored). */
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

- [ ] **Step 4: `public/format.d.ts`에 시그니처 추가**

```ts
export function toMarkdownTable(headers: unknown[], rows: unknown[][]): string;
export function portfolioTotals(sites: Array<Record<string, any>>): { activeUsers: number; sessions: number; keyEvents: number; aiSessions: number; declining: number; aiSharePct: number };
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/format.test.ts`
Expected: PASS (기존 + 신규 6개)

- [ ] **Step 6: 타입체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add public/format.js public/format.d.ts src/format.test.ts
git commit -m "feat(format): toMarkdownTable + portfolioTotals for bulk text copy"
```

---

## Task 2: "텍스트 복사" 버튼 + 탭별 빌더 (`public/app.js` + index.html + 로케일)

**Files:**
- Modify: `public/index.html:24` (export 버튼 뒤에 버튼 추가)
- Modify: `public/app.js` (import, els, 빌더, 핸들러)
- Modify: `public/locales/{en,ko,ja,zh,es}.json`

> DOM 통합이라 단위 테스트 대신 빌드 스모크 + 브라우저로 검증(Task 3). 순수 로직은 Task 1에서 테스트됨.

- [ ] **Step 1: index.html에 버튼 추가** — `<button id="export" ...>` 다음 줄

```html
        <button id="copytext" type="button" data-i18n="copy.textButton">Copy as text</button>
```

- [ ] **Step 2: app.js import + els 보강**

`public/app.js:5`의 `/format.js` import에 `toMarkdownTable, portfolioTotals, trendSparkText` 추가:
```js
import { toCsv, matchesFilter, relTime, resolveTheme, cwvRating, cwvText, deltaClass, sortValue, geoScore, buildCopyText, toMarkdownTable, portfolioTotals, trendSparkText } from "/format.js";
```
`els` 객체(`export: document.getElementById("export"),` 근처)에 추가:
```js
  copytext: document.getElementById("copytext"),
```

- [ ] **Step 3: 빌더 + 핸들러 추가** — `els.export.addEventListener(...)` 블록(트래픽/성능/GEO CSV 분기) 바로 뒤에 삽입

```js
// MetricDelta → "1,234 (-33.3%)" (delta 없으면 값만). 표 셀용.
function mdCell(m) {
  if (!m || typeof m.current !== "number") return "";
  const d = typeof m.deltaPct === "number" ? ` (${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}%)` : "";
  return `${m.current.toLocaleString(getLocale())}${d}`;
}

function trafficMarkdown() {
  const sites = sortedSites();
  const tot = portfolioTotals(sites);
  const nf = (n) => n.toLocaleString(getLocale());
  const headers = [t("col.site"), t("col.activeUsers"), t("col.sessions"), t("col.keyEvents"), t("col.aiTraffic"), t("col.searchImpressions"), t("col.searchClicks"), t("col.searchPosition"), t("col.topPage"), t("col.topSource"), t("col.trend")];
  const rows = sites.map((s) => [
    s.displayName, mdCell(s.activeUsers), mdCell(s.sessions), mdCell(s.keyEvents), mdCell(s.aiSessions),
    s.search?.impressions ?? "", s.search?.clicks ?? "",
    s.search && s.search.impressions > 0 ? s.search.position : "",
    s.topPage ?? "", s.topSource ?? "", trendSparkText(s.trend),
  ]);
  const title = t("copy.titleTraffic", { n: state.data.period, count: sites.length, when: fmtWhen(state.data.generatedAt) });
  const portfolio = t("copy.portfolio", { active: nf(tot.activeUsers), sessions: nf(tot.sessions), ai: nf(tot.aiSessions), aiPct: tot.aiSharePct, declining: tot.declining });
  const stratLines = sites
    .map((s) => {
      const findings = analyzeSite(s).filter((f) => f.severity !== "good");
      return findings.length ? `- ${s.displayName}: ${findings.map((f) => t(strategyKey(f.id), f.params)).join("; ")}` : null;
    })
    .filter(Boolean);
  const strategy = stratLines.length ? `\n\n${t("copy.strategyHeading")}\n${stratLines.join("\n")}` : "";
  return `${t("copy.aiPrompt")}\n\n${title}\n${portfolio}\n\n${toMarkdownTable(headers, rows)}${strategy}`;
}

function performanceMarkdown() {
  const sites = (state.insights.sites ?? []).filter((s) => matchesFilter(s.displayName, state.filter));
  const headers = [t("col.site"), t("col.performance"), t("col.accessibility"), t("col.bestPractices"), t("col.seo"), t("col.lcp"), t("col.cls"), t("col.inp"), t("col.measuredAt")];
  const rows = sites.map((s) => {
    const l = s.latest ?? {};
    return [s.displayName, l.performance ?? "", l.accessibility ?? "", l.bestPractices ?? "", l.seo ?? "", l.lcpMs ?? "", l.cls ?? "", l.inpMs ?? "", l.ts ? fmtWhen(l.ts) : ""];
  });
  return `${t("copy.aiPrompt")}\n\n${t("copy.titlePerformance", { count: sites.length })}\n\n${toMarkdownTable(headers, rows)}`;
}

function geoMarkdown() {
  const sites = (state.onpage.sites ?? []).filter((s) => matchesFilter(s.displayName, state.filter));
  const headers = [t("col.site"), t("col.title"), t("col.description"), t("col.canonical"), t("col.openGraph"), t("col.structuredData"), t("col.llmsTxt"), t("col.geoScore")];
  const chk = (v) => (v ? "✓" : "✗");
  const rows = sites.map((s) => {
    const c = s.checks;
    if (!c) return [s.displayName, "—", "—", "—", "—", "—", "—", ""];
    return [s.displayName, chk(c.title), chk(c.description), chk(c.canonical), chk(c.openGraph), chk(c.structuredData), chk(s.llmsTxt), `${geoScore(s)}/6`];
  });
  return `${t("copy.aiPrompt")}\n\n${t("copy.titleGeo", { count: sites.length })}\n\n${toMarkdownTable(headers, rows)}`;
}

els.copytext.addEventListener("click", () => {
  let text = null;
  if (!views.traffic.hidden && state.data) text = trafficMarkdown();
  else if (!views.performance.hidden && state.insights) text = performanceMarkdown();
  else if (!views.geo.hidden && state.onpage) text = geoMarkdown();
  if (text) copyText(text, els.copytext);
});
```

- [ ] **Step 4: 로케일 키 추가** — 5개 파일 전부 (기존 `copy.failed` 다음에 삽입)

en.json:
```json
  "copy.textButton": "Copy as text",
  "copy.aiPrompt": "Here is analytics data for my sites. Assess the overall state and suggest the highest-priority improvements:",
  "copy.titleTraffic": "# SiteDeck Traffic — last {n} days ({count} sites, as of {when})",
  "copy.titlePerformance": "# SiteDeck Performance ({count} sites)",
  "copy.titleGeo": "# SiteDeck GEO ({count} sites)",
  "copy.portfolio": "Portfolio: {active} active · {sessions} sessions · {ai} AI ({aiPct}%) · {declining} declining",
  "copy.strategyHeading": "## Improvement strategy",
```
ko.json:
```json
  "copy.textButton": "텍스트 복사",
  "copy.aiPrompt": "다음은 내 사이트 분석 데이터입니다. 전반 상태를 평가하고 우선순위 높은 개선점을 제안해주세요:",
  "copy.titleTraffic": "# SiteDeck 트래픽 — 최근 {n}일 ({count}개 사이트, {when} 기준)",
  "copy.titlePerformance": "# SiteDeck 성능 ({count}개 사이트)",
  "copy.titleGeo": "# SiteDeck GEO ({count}개 사이트)",
  "copy.portfolio": "포트폴리오: 활성 {active} · 세션 {sessions} · AI {ai} ({aiPct}%) · 하락 {declining}개",
  "copy.strategyHeading": "## 개선 전략",
```
ja.json:
```json
  "copy.textButton": "テキストをコピー",
  "copy.aiPrompt": "以下は私のサイトの分析データです。全体の状態を評価し、優先度の高い改善点を提案してください:",
  "copy.titleTraffic": "# SiteDeck トラフィック — 直近{n}日（{count}サイト、{when}時点）",
  "copy.titlePerformance": "# SiteDeck パフォーマンス（{count}サイト）",
  "copy.titleGeo": "# SiteDeck GEO（{count}サイト）",
  "copy.portfolio": "ポートフォリオ: アクティブ {active} · セッション {sessions} · AI {ai}（{aiPct}%）· 減少 {declining}件",
  "copy.strategyHeading": "## 改善戦略",
```
zh.json:
```json
  "copy.textButton": "复制为文本",
  "copy.aiPrompt": "以下是我的网站分析数据。请评估整体状况并提出优先级最高的改进建议：",
  "copy.titleTraffic": "# SiteDeck 流量 — 最近 {n} 天（{count} 个站点，截至 {when}）",
  "copy.titlePerformance": "# SiteDeck 性能（{count} 个站点）",
  "copy.titleGeo": "# SiteDeck GEO（{count} 个站点）",
  "copy.portfolio": "组合概览：活跃 {active} · 会话 {sessions} · AI {ai}（{aiPct}%）· 下降 {declining} 个",
  "copy.strategyHeading": "## 改进策略",
```
es.json:
```json
  "copy.textButton": "Copiar como texto",
  "copy.aiPrompt": "Estos son los datos analíticos de mis sitios. Evalúa el estado general y sugiere las mejoras más prioritarias:",
  "copy.titleTraffic": "# SiteDeck Tráfico — últimos {n} días ({count} sitios, a fecha de {when})",
  "copy.titlePerformance": "# SiteDeck Rendimiento ({count} sitios)",
  "copy.titleGeo": "# SiteDeck GEO ({count} sitios)",
  "copy.portfolio": "Portafolio: {active} activos · {sessions} sesiones · {ai} IA ({aiPct}%) · {declining} en descenso",
  "copy.strategyHeading": "## Estrategia de mejora",
```

- [ ] **Step 5: 파싱/빌드/회귀 확인**

Run:
```bash
npx esbuild public/app.js --format=esm >/dev/null && echo APPJS_OK
node -e "['en','ko','ja','zh','es'].forEach(l=>JSON.parse(require('fs').readFileSync('public/locales/'+l+'.json','utf8')));console.log('LOCALES_OK')"
npm run typecheck && npx vitest run 2>&1 | tail -3
```
Expected: `APPJS_OK`, `LOCALES_OK`, typecheck 클린, 테스트 회귀 없음

- [ ] **Step 6: 커밋**

```bash
git add public/index.html public/app.js public/locales
git commit -m "feat(copy): 'Copy as text' button — LLM-friendly markdown for traffic/perf/geo"
```

---

## Task 3: QA + 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 타입체크 + 전체 테스트**

Run: `npm run typecheck && npx vitest run`
Expected: 클린, 모든 테스트 통과(기존 174 + 신규 6 = 180)

- [ ] **Step 2: 빌드 + 브라우저 실데이터 QA**

Run: `npm run build:server && PORT=4399 node dist/server.mjs`
브라우저 `http://localhost:4399`에서:
- 트래픽 탭 → "텍스트 복사" 클릭 → ✓ 피드백, 콘솔 오류 없음
- 붙여넣어 확인: 프롬프트 한 줄 + `# SiteDeck 트래픽…` 헤더 + `포트폴리오:` 줄 + Markdown 표(사이트 전부, 추세 ▁▇) + `## 개선 전략` (전략 있는 사이트만)
- 필터 입력 후 복사 → 필터된 사이트만 표에 포함
- 성능/GEO 탭에서도 복사 → 해당 표(GEO는 ✓/✗) 확인
- DevTools 콘솔 오류 0

- [ ] **Step 3: 시크릿 스캔 + git 상태**

Run:
```bash
git grep -nE "github_pat_[A-Za-z0-9_]{20}|AIzaSy|GOCSPX" -- ':!docs' || echo clean
git status --short
```
Expected: `clean`, 커밋 안 된 변경 없음

---

## Self-Review 메모(작성자 확인 완료)

- **Spec 커버리지:** 순수함수(T1) · 버튼+탭별 빌더+i18n(T2) · QA(T3) — spec 전 항목 매핑.
- **타입/이름 일관성:** `toMarkdownTable(headers, rows)` · `portfolioTotals(sites)→{...,aiSharePct}` · `mdCell` · `trafficMarkdown/performanceMarkdown/geoMarkdown` · `copy.*` 키 ↔ 사용처 일치. `analyzeSite(s)`는 detail 없이 호출(요약 규칙만).
- **YAGNI:** 심층 복사·Repos·형식 선택 UI·상시 포트폴리오 표시 제외.
- **브랜치:** feature 브랜치 `feat/bulk-text-copy`에서 작업 후 main 병합.
