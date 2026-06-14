# Internationalization + Settings Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Localize the whole app (UI + server messages) into en/ko/es/zh/ja and add a Settings tab (language, PageSpeed API key, version/update status, about), plus README translations.

**Architecture:** Shared flat JSON locale catalogs under `public/locales/` are fetched by the client and read from disk by the server. The client (`public/i18n.js`) and server (`src/i18n.ts`) each have a tiny `t()`. API errors return `{ error: { code, detail } }` and are localized client-side. Settings persist to `~/.sitedeck/config.json`.

**Tech Stack:** Node + TypeScript (ESM), vitest, plain HTML/CSS/JS front-end, global `fetch`.

**Spec:** `docs/superpowers/specs/2026-06-13-i18n-and-settings-design.md`

**Conventions:** ESM, `moduleResolution: Bundler` (imports without extensions), strict TS + `noUncheckedIndexedAccess`. Commit subjects are plain imperative and END with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File structure

- `src/errors.ts` — `AppError` (code + detail).
- `src/i18n.ts` — pure `interpolate` + `translate`; server-side `loadCatalogs`/`tServer`/`resolveServerLocale`.
- `src/i18n.test.ts` — tests for `interpolate` + `translate`.
- `src/settings.ts` — pure `mergeSettings` + `isLanguage`; IO `getSettings`/`updateSettings`/`getPsiApiKey`.
- `src/settings.test.ts` — tests for `mergeSettings` + `isLanguage`.
- `public/locales/{en,ko,es,zh,ja}.json` — message catalogs (en is source of truth).
- `src/locales.test.ts` — catalog key-parity test.
- `public/i18n.js` — client `t`, `applyI18n`, `setLanguage`, `resolveClientLocale`.
- `src/config.ts` (modify) — drop `getPsiApiKey` (moves to settings).
- `src/auth.ts` (modify) — throw `AppError`.
- `src/insights.ts` (modify) — import `getPsiApiKey` from `./settings`.
- `src/server.ts` (modify) — error codes, `/api/settings`, `/api/version`, localized OAuth pages.
- `public/index.html` (modify) — `data-i18n` attributes + Settings tab/view.
- `public/app.js` (modify) — i18n integration + Settings logic + error localization.
- `public/style.css` (modify) — settings form styles.
- `README.md` / `README.ko.md` (modify links) + `README.es.md` / `README.zh.md` / `README.ja.md` (new).

---

### Task 1: AppError

**Files:** Create `src/errors.ts`

- [ ] **Step 1: Create `src/errors.ts`**

```ts
/** An error carrying a stable code (for client-side localization) plus optional detail. */
export class AppError extends Error {
  constructor(
    public code: string,
    public detail?: string,
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'AppError';
  }
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` → no errors.
- [ ] **Step 3: Commit**

```bash
git add src/errors.ts
git commit -m "Add AppError with a localizable code"
```

---

### Task 2: i18n pure core (TDD)

**Files:** Create `src/i18n.ts`, `src/i18n.test.ts`

- [ ] **Step 1: Write the failing test** — `src/i18n.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { interpolate, translate } from './i18n';

describe('interpolate', () => {
  it('substitutes {name} params', () => {
    expect(interpolate('Hi {name}, {n} new', { name: 'A', n: 3 })).toBe('Hi A, 3 new');
  });
  it('leaves unknown placeholders as-is', () => {
    expect(interpolate('Hi {who}', {})).toBe('Hi {who}');
  });
});

describe('translate', () => {
  const en = { greeting: 'Hello {name}', plain: 'Plain' };
  const ko = { greeting: '안녕 {name}' };
  it('uses the locale catalog with interpolation', () => {
    expect(translate(ko, en, 'greeting', { name: '윤' })).toBe('안녕 윤');
  });
  it('falls back to the en catalog when the key is missing', () => {
    expect(translate(ko, en, 'plain', {})).toBe('Plain');
  });
  it('falls back to the key itself when missing everywhere', () => {
    expect(translate(ko, en, 'absent', {})).toBe('absent');
  });
});
```

- [ ] **Step 2: Run it** — `npm test -- i18n` → FAIL (module not found).

- [ ] **Step 3: Create `src/i18n.ts`**

```ts
export type Catalog = Record<string, string>;

export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

export function translate(
  catalog: Catalog,
  fallback: Catalog,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const template = catalog[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}
```

- [ ] **Step 4: Run it** — `npm test -- i18n` → PASS. `npm run typecheck` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/i18n.ts src/i18n.test.ts
git commit -m "Add i18n interpolate + translate (TDD)"
```

---

### Task 3: settings pure logic (TDD)

**Files:** Create `src/settings.ts`, `src/settings.test.ts`

- [ ] **Step 1: Write the failing test** — `src/settings.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { isLanguage, mergeSettings, LANGUAGES } from './settings';

describe('isLanguage', () => {
  it('accepts supported languages', () => {
    for (const l of LANGUAGES) expect(isLanguage(l)).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage('')).toBe(false);
  });
});

describe('mergeSettings', () => {
  it('merges a patch over current settings', () => {
    expect(mergeSettings({ language: 'en' }, { psiApiKey: 'K' })).toEqual({
      language: 'en',
      psiApiKey: 'K',
    });
  });
  it('ignores an invalid language', () => {
    expect(mergeSettings({ language: 'en' }, { language: 'xx' })).toEqual({ language: 'en' });
  });
  it('clears the key when given an empty string', () => {
    expect(mergeSettings({ psiApiKey: 'K' }, { psiApiKey: '' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run it** — `npm test -- settings` → FAIL (module not found).

- [ ] **Step 3: Create `src/settings.ts`** (pure parts only for now)

```ts
export const LANGUAGES = ['en', 'ko', 'es', 'zh', 'ja'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Settings {
  language?: Language;
  psiApiKey?: string;
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Merge a patch over current settings: validate language, trim key, empty key clears. */
export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current };
  if (patch.language !== undefined && isLanguage(patch.language)) next.language = patch.language;
  if (patch.psiApiKey !== undefined) {
    const trimmed = patch.psiApiKey.trim();
    if (trimmed) next.psiApiKey = trimmed;
    else delete next.psiApiKey;
  }
  return next;
}
```

- [ ] **Step 4: Run it** — `npm test -- settings` → PASS. `npm run typecheck` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/settings.test.ts
git commit -m "Add settings merge + language validation (TDD)"
```

---

### Task 4: settings IO + move getPsiApiKey

**Files:** Modify `src/settings.ts`, `src/config.ts`, `src/insights.ts`

- [ ] **Step 1: Append IO to `src/settings.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, CONFIG_JSON_PATH } from './config';

export async function getSettings(): Promise<Settings> {
  if (!existsSync(CONFIG_JSON_PATH)) return {};
  try {
    const raw = JSON.parse(await readFile(CONFIG_JSON_PATH, 'utf8')) as Settings;
    return mergeSettings({}, raw);
  } catch {
    return {};
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings(await getSettings(), patch);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_JSON_PATH, JSON.stringify(next, null, 2));
  return next;
}

/** PSI key: SITEDECK_PSI_KEY env, else psiApiKey in config.json, else null. Sync (used at call sites). */
export function getPsiApiKey(): string | null {
  if (process.env.SITEDECK_PSI_KEY) return process.env.SITEDECK_PSI_KEY;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { psiApiKey?: unknown };
    return typeof cfg.psiApiKey === 'string' && cfg.psiApiKey ? cfg.psiApiKey : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Remove `getPsiApiKey` from `src/config.ts`.** Open `src/config.ts`, delete the entire `export function getPsiApiKey() { … }` block (and its preceding doc comment). Keep `CONFIG_JSON_PATH`, `CONFIG_DIR`, and the other constants. If `readFileSync` is now unused in `config.ts`, change its import back to `import { existsSync } from 'node:fs';`.

- [ ] **Step 3: Update the import in `src/insights.ts`.** Change `getPsiApiKey` to come from `./settings`: remove it from the `'./config'` import and add `import { getPsiApiKey } from './settings';`.

- [ ] **Step 4: Verify** — `npm run typecheck` → clean; `npm test` → all pass.
- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/config.ts src/insights.ts
git commit -m "Move PSI key + config.json IO into settings module"
```

---

### Task 5: English catalog (source of truth)

**Files:** Create `public/locales/en.json`

- [ ] **Step 1: Create `public/locales/en.json`**

```json
{
  "controls.period": "Period",
  "period.option": "{n} days",
  "btn.refresh": "Refresh",
  "btn.measureNow": "Measure now",
  "btn.save": "Save",
  "tab.traffic": "Traffic",
  "tab.performance": "Performance",
  "tab.settings": "Settings",
  "col.site": "Site",
  "col.activeUsers": "Active users",
  "col.sessions": "Sessions",
  "col.keyEvents": "Key events",
  "col.topPage": "Top page",
  "col.topSource": "Top channel",
  "col.trend": "Trend",
  "col.performance": "Performance",
  "col.accessibility": "Accessibility",
  "col.bestPractices": "Best Practices",
  "col.seo": "SEO",
  "col.measuredAt": "Measured",
  "status.loading": "Loading…",
  "status.needAuth": "A Google account connection is required.",
  "link.connectAccount": "Connect account",
  "link.reconnect": "Reconnect",
  "status.noProperties": "No accessible GA4 properties.",
  "meta.summary": "{count} sites · last {period} days · {when}",
  "meta.errorsSuffix": " · {count} property errors",
  "insights.notConfigured": "Set your PageSpeed API key in Settings to start.",
  "insights.measuring": "Measuring…",
  "insights.empty": "No measurements yet. Press “Measure now” to start.",
  "insights.lastMeasured": "Last measured {when}",
  "insights.errorsSuffix": " · {count} errors",
  "settings.languageLabel": "Language",
  "settings.psiKeyLabel": "PageSpeed API key",
  "settings.psiKeyPlaceholder": "AIza…",
  "settings.psiKeySet": "A key is set ({masked}).",
  "settings.credentialsLabel": "Google OAuth credentials",
  "settings.credentialsFound": "Found at ~/.sitedeck/credentials.json.",
  "settings.credentialsMissing": "Not found. Place credentials.json in ~/.sitedeck/.",
  "settings.versionLabel": "Version",
  "settings.checkUpdate": "Check for updates",
  "settings.upToDate": "Up to date.",
  "settings.updateAvailable": "Update available ({version}). It installs on restart.",
  "settings.aboutLabel": "About",
  "settings.description": "A local dashboard summarizing key GA4 metrics and PageSpeed scores across your sites.",
  "settings.saved": "Saved.",
  "link.github": "GitHub",
  "link.readme": "README",
  "link.license": "License",
  "link.issues": "Issues",
  "error.credentials_not_found": "OAuth credentials not found: {detail}. Place credentials.json in ~/.sitedeck/.",
  "error.credentials_invalid": "credentials.json is missing client_id/client_secret: {detail}.",
  "error.unknown": "Something went wrong: {detail}",
  "oauth.success": "Authenticated. Returning to the dashboard…",
  "oauth.failed": "Authentication failed: {detail}",
  "oauth.tokenFailed": "Token exchange failed: {detail}",
  "oauth.noCode": "no code"
}
```

- [ ] **Step 2: Commit**

```bash
git add public/locales/en.json
git commit -m "Add English message catalog (source of truth)"
```

---

### Task 6: Translations (ko/es/zh/ja) + parity test

**Files:** Create `public/locales/{ko,es,zh,ja}.json`, `src/locales.test.ts`

- [ ] **Step 1: Create the four translated catalogs.** For each of `ko` (Korean), `es` (Spanish), `zh` (Simplified Chinese), `ja` (Japanese), create `public/locales/<code>.json` with the **exact same keys** as `en.json`, translating each value naturally and concisely for a developer dashboard. Keep `{param}` placeholders intact and in a natural position. Do not translate "SEO", "GA4", "PageSpeed", "GitHub", "README". Korean reference values already used in the app: `tab.traffic`="트래픽", `tab.performance`="성능", `tab.settings`="설정", `col.site`="사이트", `col.activeUsers`="활성 사용자", `col.sessions`="세션", `col.keyEvents`="핵심 이벤트", `col.topPage`="탑 페이지", `col.topSource`="탑 소스", `col.trend`="추세", `btn.refresh`="새로고침", `btn.measureNow`="지금 측정", `insights.measuring`="측정 중…".

- [ ] **Step 2: Write the parity test** — `src/locales.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LANGUAGES } from './settings';

const dir = path.resolve(__dirname, '../public/locales');
const load = (l: string) => JSON.parse(readFileSync(path.join(dir, `${l}.json`), 'utf8')) as Record<string, string>;
const en = load('en');
const enKeys = Object.keys(en).sort();

describe('locale catalogs', () => {
  it.each(LANGUAGES.filter((l) => l !== 'en'))('%s has exactly the en keys', (lang) => {
    expect(Object.keys(load(lang)).sort()).toEqual(enKeys);
  });
});
```

- [ ] **Step 3: Run it** — `npm test -- locales` → PASS (all catalogs have identical keys). Fix any missing/extra keys in the translations until green.
- [ ] **Step 4: Commit**

```bash
git add public/locales/ko.json public/locales/es.json public/locales/zh.json public/locales/ja.json src/locales.test.ts
git commit -m "Add ko/es/zh/ja catalogs with a key-parity test"
```

---

### Task 7: Server i18n loader

**Files:** Modify `src/i18n.ts`

- [ ] **Step 1: Append server-side loading to `src/i18n.ts`**

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLanguage, type Language } from './settings';

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/locales');

const cache = new Map<string, Catalog>();

function load(locale: string): Catalog {
  const cached = cache.get(locale);
  if (cached) return cached;
  let catalog: Catalog = {};
  try {
    catalog = JSON.parse(readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')) as Catalog;
  } catch {
    catalog = {};
  }
  cache.set(locale, catalog);
  return catalog;
}

/** Server-side translate for the given locale, falling back to en. */
export function tServer(locale: string, key: string, params: Record<string, string | number> = {}): string {
  const lang: Language = isLanguage(locale) ? locale : 'en';
  return translate(load(lang), load('en'), key, params);
}
```

- [ ] **Step 2: Verify** — `npm run typecheck` → clean; `npm test` → all pass.
- [ ] **Step 3: Commit**

```bash
git add src/i18n.ts
git commit -m "Add server-side catalog loader and tServer"
```

---

### Task 8: auth.ts throws AppError

**Files:** Modify `src/auth.ts`

- [ ] **Step 1:** In `src/auth.ts`, add `import { AppError } from './errors';`. In `loadInstalledCredentials`, replace the two `throw new Error(...)` calls:
  - the "not found" one → `throw new AppError('credentials_not_found', CREDENTIALS_PATH);`
  - the "missing client_id/client_secret" one → `throw new AppError('credentials_invalid', CREDENTIALS_PATH);`

- [ ] **Step 2: Verify** — `npm run typecheck` → clean; `npm test` → all pass.
- [ ] **Step 3: Commit**

```bash
git add src/auth.ts
git commit -m "Throw coded AppError for missing/invalid credentials"
```

---

### Task 9: Server endpoints + error codes + localized OAuth pages

**Files:** Modify `src/server.ts`

- [ ] **Step 1: Imports.** Add to the top of `src/server.ts`:

```ts
import { AppError } from './errors';
import { getSettings, updateSettings } from './settings';
import { tServer } from './i18n';
```

- [ ] **Step 2: Add an error helper** near the `json` helper:

```ts
function errorBody(err: unknown): { error: { code: string; detail?: string } } {
  if (err instanceof AppError) return { error: { code: err.code, detail: err.detail } };
  return { error: { code: 'unknown', detail: err instanceof Error ? err.message : String(err) } };
}
```

- [ ] **Step 3: Use it in the `/api/summary` catch.** Replace its `catch (err) { json(res, 500, { error: ... }); }` body with:

```ts
    } catch (err) {
      json(res, 500, errorBody(err));
    }
```

Also replace the `/api/insights` catch body the same way: `json(res, 500, errorBody(err));`.

- [ ] **Step 4: Add the settings + version routes** right after the `/api/insights/measure` block:

```ts
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    void (async () => {
      const s = await getSettings();
      json(res, 200, {
        language: s.language ?? null,
        hasPsiKey: Boolean(s.psiApiKey),
        psiKeyMasked: s.psiApiKey ? `${s.psiApiKey.slice(0, 6)}…${s.psiApiKey.slice(-4)}` : null,
        hasCredentials: existsSyncSafe(),
      });
    })();
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        const s = await updateSettings(body);
        json(res, 200, { language: s.language ?? null, hasPsiKey: Boolean(s.psiApiKey) });
      } catch (err) {
        json(res, 500, errorBody(err));
      }
    })();
    return;
  }

  if (url.pathname === '/api/version') {
    void (async () => {
      json(res, 200, await getVersion());
    })();
    return;
  }
```

- [ ] **Step 5: Add the helpers** used above (place them above `const server = http.createServer`):

```ts
import { readFile as readFileFs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { CREDENTIALS_PATH } from './config';

function existsSyncSafe(): boolean {
  return existsSync(CREDENTIALS_PATH);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

async function getVersion(): Promise<VersionInfo> {
  const pkg = JSON.parse(await readFileFs(path.resolve(__dirname, '../package.json'), 'utf8')) as {
    version: string;
  };
  let latest: string | null = null;
  try {
    const res = await fetch('https://api.github.com/repos/writingdeveloper/SiteDeck/releases/latest', {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
    }
  } catch {
    latest = null;
  }
  return { current: pkg.version, latest, updateAvailable: latest !== null && latest !== pkg.version };
}
```

(Note: `CREDENTIALS_PATH` may already be importable; if `./config` is already imported, add `CREDENTIALS_PATH` to that import instead of a second line. `existsSync` likewise — dedupe if already imported.)

- [ ] **Step 6: Localize the OAuth callback page.** In the `OAUTH_CALLBACK_PATH` handler, compute the locale once: `const locale = (await getSettings()).language ?? 'en';` (wrap the handler body so it can `await`), and replace the Korean strings:
  - the success HTML body text → `tServer(locale, 'oauth.success')`
  - the `인증 실패: ${oauthError ?? 'code 없음'}` → `tServer(locale, 'oauth.failed', { detail: oauthError ?? tServer(locale, 'oauth.noCode') })`
  - the `토큰 교환 실패: ${...}` → `tServer(locale, 'oauth.tokenFailed', { detail: err instanceof Error ? err.message : String(err) })`

- [ ] **Step 7: Verify** — `npm run typecheck` → clean; `npm test` → all pass.
- [ ] **Step 8: Commit**

```bash
git add src/server.ts
git commit -m "Add settings/version endpoints, coded errors, and localized OAuth pages"
```

---

### Task 10: Client i18n module

**Files:** Create `public/i18n.js`

- [ ] **Step 1: Create `public/i18n.js`**

```js
// Lightweight client i18n. Loads /locales/<locale>.json, applies data-i18n, and t().
const LANGUAGES = ["en", "ko", "es", "zh", "ja"];
const state = { locale: "en", catalog: {}, en: {} };

function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    params && key in params ? String(params[key]) : whole,
  );
}

export function t(key, params) {
  const template = state.catalog[key] ?? state.en[key] ?? key;
  return interpolate(template, params || {});
}

export function getLocale() {
  return state.locale;
}

async function fetchCatalog(locale) {
  const res = await fetch(`/locales/${locale}.json`);
  if (!res.ok) throw new Error(`locale ${locale} ${res.status}`);
  return res.json();
}

export function resolveClientLocale(stored) {
  if (LANGUAGES.includes(stored)) return stored;
  const nav = (navigator.language || "en").slice(0, 2);
  return LANGUAGES.includes(nav) ? nav : "en";
}

/** Load en (fallback) + the chosen locale and set state. */
export async function initI18n(stored) {
  state.en = await fetchCatalog("en");
  const locale = resolveClientLocale(stored);
  state.locale = locale;
  state.catalog = locale === "en" ? state.en : await fetchCatalog(locale);
}

export async function setLocale(locale) {
  state.locale = LANGUAGES.includes(locale) ? locale : "en";
  state.catalog = state.locale === "en" ? state.en : await fetchCatalog(state.locale);
}

export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
}

export { LANGUAGES };
```

- [ ] **Step 2: Verify syntax** — `node --check public/i18n.js` → no output.
- [ ] **Step 3: Commit**

```bash
git add public/i18n.js
git commit -m "Add client i18n module (t, applyI18n, locale resolution)"
```

---

### Task 11: index.html — data-i18n + Settings tab/view

**Files:** Modify `public/index.html`

- [ ] **Step 1: Make `app.js` a module and add the tab.** Change the script tag to `<script type="module" src="/app.js"></script>`. In the tab bar add a third tab after performance: `<button class="tab" data-view="settings" data-i18n="tab.settings">Settings</button>`. Add `data-i18n` to the two existing tabs (`data-i18n="tab.traffic"`, `data-i18n="tab.performance"`).

- [ ] **Step 2: Add `data-i18n` to every static UI string** in `index.html`: the `기간` label → `data-i18n="controls.period"`; the `새로고침` button → `data-i18n="btn.refresh"`; each traffic `<th>` → its key (`col.site`, `col.activeUsers`, `col.sessions`, `col.keyEvents`, `col.topPage`, `col.topSource`, `col.trend`); the `지금 측정` button → `data-i18n="btn.measureNow"`; each performance `<th>` → (`col.site`, `col.performance`, `col.accessibility`, `col.bestPractices`, `col.seo`, `col.measuredAt`, `col.trend`). Replace the visible text with the English value (it will be overwritten by `applyI18n`). The period `<option>`s keep `value="7|28|90"` but their text is set in JS (Task 12), so leave them as `7`/`28`/`90`.

- [ ] **Step 3: Add the Settings view** after the performance section, inside `<main>`:

```html
      <section id="view-settings" hidden>
        <div class="settings">
          <label class="field">
            <span data-i18n="settings.languageLabel">Language</span>
            <select id="lang-select">
              <option value="en">English</option>
              <option value="ko">한국어</option>
              <option value="es">Español</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
            </select>
          </label>

          <label class="field">
            <span data-i18n="settings.psiKeyLabel">PageSpeed API key</span>
            <span class="field-row">
              <input id="psi-key" type="password" data-i18n-placeholder="settings.psiKeyPlaceholder" />
              <button id="psi-save" type="button" data-i18n="btn.save">Save</button>
            </span>
            <small id="psi-status" class="muted"></small>
            <small id="cred-status" class="muted"></small>
          </label>

          <div class="field">
            <span data-i18n="settings.versionLabel">Version</span>
            <span class="field-row">
              <span id="version-current" class="muted"></span>
              <button id="check-update" type="button" data-i18n="settings.checkUpdate">Check for updates</button>
            </span>
            <small id="update-status" class="muted"></small>
          </div>

          <div class="field">
            <span data-i18n="settings.aboutLabel">About</span>
            <small class="muted" data-i18n="settings.description"></small>
            <span class="field-row">
              <a href="https://github.com/writingdeveloper/SiteDeck" data-i18n="link.github">GitHub</a>
              <a href="https://github.com/writingdeveloper/SiteDeck#readme" data-i18n="link.readme">README</a>
              <a href="https://github.com/writingdeveloper/SiteDeck/blob/main/LICENSE" data-i18n="link.license">License</a>
              <a href="https://github.com/writingdeveloper/SiteDeck/issues" data-i18n="link.issues">Issues</a>
            </span>
          </div>
        </div>
        <div id="settings-status" class="status" hidden></div>
      </section>
```

- [ ] **Step 4: Add the i18n script** before `app.js` is not needed (app.js imports it). Just confirm `app.js` is `type="module"`.
- [ ] **Step 5: Verify** — open is deferred to live test. Confirm `index.html` contains `data-view="settings"` and `data-i18n="tab.traffic"`.
- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Add data-i18n attributes and the Settings view to index.html"
```

---

### Task 12: app.js — i18n integration, Settings logic, coded errors

**Files:** Modify `public/app.js`

- [ ] **Step 1: Import i18n at the top** of `public/app.js`:

```js
import { t, applyI18n, initI18n, setLocale, getLocale } from "/i18n.js";
```

- [ ] **Step 2: Replace hard-coded strings with `t(...)`.** Throughout `app.js`, replace each Korean literal with the matching `t()` call:
  - `"불러오는 중…"` → `t("status.loading")`
  - the needs-auth status → `` `${t("status.needAuth")} <a href="${data.authUrl}">${t("link.connectAccount")}</a>` ``
  - `"접근 가능한 GA4 속성이 없습니다."` → `t("status.noProperties")`
  - the traffic meta line → `` `${t("meta.summary", { count: data.sites.length, period: data.period, when })}${data.errors?.length ? t("meta.errorsSuffix", { count: data.errors.length }) : ""}` ``
  - the insights "not configured" → `t("insights.notConfigured")`
  - `"측정 중…"` → `t("insights.measuring")`
  - the insights empty message → `t("insights.empty")`
  - the insights last-measured meta → `` `${t("insights.lastMeasured", { when: new Date(data.lastRunAt).toLocaleString() })}${data.errors?.length ? t("insights.errorsSuffix", { count: data.errors.length }) : ""}` ``

- [ ] **Step 3: Localize errors via code.** Both summary and insights now receive `{ error: { code, detail } }`. Add a helper and use it in the error branches:

```js
function localizeError(error) {
  if (!error) return "";
  const key = `error.${error.code}`;
  const msg = t(key, { detail: error.detail ?? "" });
  return msg === key ? t("error.unknown", { detail: error.detail ?? error.code }) : msg;
}
```
In `load()`, change `if (data.error)` to render `` `${localizeError(data.error)} · <a href="/oauth/start">${t("link.reconnect")}</a>` ``. Do the same in the insights error path.

- [ ] **Step 4: Set period option texts** in a small function and call it from `applyI18n` usage:

```js
function applyPeriodOptions() {
  els.period.querySelectorAll("option").forEach((o) => {
    o.textContent = t("period.option", { n: o.value });
  });
}
```

- [ ] **Step 5: Add Settings tab logic.** Append:

```js
const settings = {
  view: document.getElementById("view-settings"),
  lang: document.getElementById("lang-select"),
  psiKey: document.getElementById("psi-key"),
  psiSave: document.getElementById("psi-save"),
  psiStatus: document.getElementById("psi-status"),
  credStatus: document.getElementById("cred-status"),
  versionCurrent: document.getElementById("version-current"),
  checkUpdate: document.getElementById("check-update"),
  updateStatus: document.getElementById("update-status"),
  status: document.getElementById("settings-status"),
};

async function loadSettings() {
  const s = await (await fetch("/api/settings")).json();
  settings.lang.value = getLocale();
  settings.psiStatus.textContent = s.hasPsiKey ? t("settings.psiKeySet", { masked: s.psiKeyMasked }) : "";
  settings.credStatus.textContent = s.hasCredentials
    ? t("settings.credentialsFound")
    : t("settings.credentialsMissing");
}

settings.lang.addEventListener("change", async () => {
  await setLocale(settings.lang.value);
  await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language: settings.lang.value }),
  });
  try { localStorage.setItem("sitedeck.locale", settings.lang.value); } catch {}
  rerenderAll();
});

settings.psiSave.addEventListener("click", async () => {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ psiApiKey: settings.psiKey.value }),
  });
  settings.psiKey.value = "";
  settings.status.hidden = false;
  settings.status.className = "status info";
  settings.status.textContent = t("settings.saved");
  loadSettings();
});

settings.checkUpdate.addEventListener("click", async () => {
  const v = await (await fetch("/api/version")).json();
  settings.versionCurrent.textContent = `v${v.current}`;
  settings.updateStatus.textContent = v.updateAvailable
    ? t("settings.updateAvailable", { version: `v${v.latest}` })
    : t("settings.upToDate");
});
```

- [ ] **Step 6: Add `rerenderAll` + wire startup.** Define a function that re-applies i18n and re-renders whatever is loaded, and call i18n init before the first `load()`:

```js
function rerenderAll() {
  applyI18n();
  applyPeriodOptions();
  if (state.data) render();
  loadSettings();
  if (!views.performance.hidden) loadInsights();
}
```
Replace the bottom `load();` bootstrap with:

```js
(async () => {
  let stored = null;
  try { stored = (await (await fetch("/api/settings")).json()).language; } catch {}
  if (!stored) { try { stored = localStorage.getItem("sitedeck.locale"); } catch {} }
  await initI18n(stored);
  applyI18n();
  applyPeriodOptions();
  load();
})();
```

- [ ] **Step 7: Add the settings tab to the tab switcher.** In the existing `tabs.forEach(... tab.addEventListener("click", ...))`, generalize the show/hide to all three views and load settings on entry:

```js
    views.traffic.hidden = view !== "traffic";
    views.performance.hidden = view !== "performance";
    settings.view.hidden = view !== "settings";
    if (view === "performance") loadInsights();
    if (view === "settings") { loadSettings(); }
```

- [ ] **Step 8: Verify syntax** — `node --check public/app.js` → no output.
- [ ] **Step 9: Commit**

```bash
git add public/app.js
git commit -m "Integrate i18n into the dashboard and add Settings tab logic"
```

---

### Task 13: Settings styles

**Files:** Modify `public/style.css`

- [ ] **Step 1: Append**

```css
.settings {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 640px;
}
.settings .field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.settings .field > span:first-child {
  font-weight: 600;
}
.settings .field-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.settings input {
  flex: 1;
  min-width: 220px;
  background: #0d1117;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
}
.settings .muted {
  color: var(--muted);
}
.settings a {
  color: var(--accent);
}
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css
git commit -m "Style the Settings view"
```

---

### Task 14: README translations

**Files:** Modify `README.md`, `README.ko.md`; Create `README.es.md`, `README.zh.md`, `README.ja.md`

- [ ] **Step 1: Update the language switcher line** at the top of `README.md` and `README.ko.md` to:
`**English** · [한국어](README.ko.md) · [Español](README.es.md) · [中文](README.zh.md) · [日本語](README.ja.md)` (bold the current file's language; in README.ko.md make `[English](README.md)` a link and bold `한국어`).

- [ ] **Step 2: Create `README.es.md`, `README.zh.md`, `README.ja.md`** as full translations of `README.md` (Spanish, Simplified Chinese, Japanese). Keep all code blocks, commands, paths, badges, and links identical; translate prose. Each starts with the same switcher line, bolding its own language. Add a short "Performance (PageSpeed)" + (new) note about the Settings tab consistent with the English README.

- [ ] **Step 3: Commit**

```bash
git add README.md README.ko.md README.es.md README.zh.md README.ja.md
git commit -m "Add Spanish/Chinese/Japanese README translations"
```

---

### Task 15: Live verification

- [ ] **Step 1:** `npm run typecheck` and `npm test` → all green.
- [ ] **Step 2:** `npm start`; open the dashboard. Confirm the UI renders (default locale from the browser). Switch the **Settings → Language** dropdown through en/ko/es/zh/ja and confirm tabs, headers, buttons, and status text all change language live.
- [ ] **Step 3:** In Settings, confirm the credentials status line; clear the PSI key and re-enter it (Save) and confirm `hasPsiKey` reflects it and the Performance tab measures.
- [ ] **Step 4:** Click **Check for updates** → confirm it shows the current version and "Up to date" (current == latest release).
- [ ] **Step 5:** Confirm an error path localizes: temporarily rename `~/.sitedeck/credentials.json`, refresh Traffic → the error shows the localized `credentials_not_found` message in the active language; restore the file.
- [ ] **Step 6:** Stop the server.

---

## Self-Review

**Spec coverage:** shared catalogs (T5/T6) served + read by server (T7) and client (T10); client `t`/`applyI18n`/locale resolution (T10); server `tServer` (T7); error codes (T1/T8/T9) localized client-side (T12); settings persistence + `getPsiApiKey` (T3/T4); Settings tab — language, PSI key, version/update, about (T11/T12); endpoints `/api/settings`, `/api/version`, `/locales/*` (T9, static); default language navigator→en (T10); README translations (T14); TDD for interpolate/translate, settings merge, catalog parity (T2/T3/T6). All spec sections map to tasks.

**Placeholder scan:** no TBD/TODO; every code step has complete code; the translation tasks (T6 catalogs, T14 READMEs) provide the full English source plus exact, bounded instructions (mechanical translation, not deferred work).

**Type consistency:** `Catalog`, `interpolate`, `translate` (T2) reused by `tServer` (T7); `LANGUAGES`/`Language`/`isLanguage`/`mergeSettings`/`Settings` (T3) reused by IO (T4), parity test (T6), server i18n (T7); `AppError(code, detail)` (T1) thrown in T8, shaped by `errorBody` (T9), localized by `localizeError` (T12); `getPsiApiKey` moves config→settings (T4) and `insights.ts` import updated (T4). `/api/settings` GET fields (`language`, `hasPsiKey`, `psiKeyMasked`, `hasCredentials`) match what `loadSettings` reads (T12). `/api/version` fields (`current`, `latest`, `updateAvailable`) match the Settings check handler (T12).
