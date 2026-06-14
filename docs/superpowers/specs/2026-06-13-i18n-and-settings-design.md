# SiteDeck — Internationalization + Settings tab design

## Goal

Add multi-language support (English, Korean, Spanish, Chinese, Japanese) across the
whole app — UI **and** server-returned messages — plus a **Settings** tab for
language, PageSpeed API key, version/update status, and project info. Ship README
translations in all five languages (English primary).

## Decisions (approved)

- **i18n scope**: full — client UI strings and server messages are both localizable.
- **Default language**: stored setting → `navigator.language` → `en`.
- **PSI key**: entered/saved in the Settings tab (writes `~/.sitedeck/config.json`).
- **Auto-update UI**: status display (current version vs latest GitHub release); the
  actual install stays with electron-updater on launch.

## Languages

`en` (source / fallback), `ko`, `es`, `zh` (Simplified), `ja`.

## Architecture

### Message catalogs (shared, single source)

- `public/locales/{en,ko,es,zh,ja}.json` — flat dot-keyed maps (`"tab.performance": "Performance"`).
- Served statically to the client at `/locales/<locale>.json`. The **server reads the
  same files from disk** for server-rendered output (DRY, one source).
- `en.json` is the source of truth for keys; the other locales mirror its keys.

### Client i18n — `public/i18n.js`

- `t(key, params)` — looks up the active locale's catalog, falls back to `en`, then to
  the key itself; `{name}`-style param interpolation.
- `applyI18n(root)` — sets `textContent` for `[data-i18n]` and `placeholder` for
  `[data-i18n-placeholder]`.
- `setLanguage(locale)` — loads the catalog (cached), persists (POST `/api/settings` +
  `localStorage`), re-applies and re-renders dynamic views.
- On load: language = server setting (from `/api/settings`) → `navigator.language` short
  code (if among the five) → `en`. Loads catalog, applies.
- Dynamic strings rendered in JS use `t(...)`.

### Server i18n — `src/i18n.ts`

- Loads catalogs from `public/locales`. `t(locale, key, params)` with `en` fallback.
- `resolveServerLocale()` — from saved settings → `en`.
- Used for server-rendered HTML (OAuth callback / error pages).

### Errors as codes (enables full i18n)

- `src/errors.ts`: `class AppError extends Error { constructor(code: string, detail?: string) }`.
- `auth.ts` throws `AppError('credentials_not_found', path)` and
  `AppError('credentials_invalid', path)`.
- API handlers catch → `{ error: { code, detail } }` for `AppError`, else
  `{ error: { code: 'unknown', detail: message } }`.
- Client localizes via `t('error.' + code, { detail })`; `unknown` → generic message +
  raw detail. Third-party (GA/Lighthouse) errors surface as `unknown` with the library's
  English message as `detail` (not translated — explicit boundary).

### Settings — `src/settings.ts`

- Reads/writes `~/.sitedeck/config.json`: `{ psiApiKey?: string, language?: string }`.
- `getSettings()`, `updateSettings(patch)` (merge-write). `getPsiApiKey()` delegates here
  (replaces the current `config.ts` reader), keeping the `SITEDECK_PSI_KEY` env override.

## Settings tab (UI)

New tab **Settings** (`data-view="settings"`). Sections:

- **Language**: `<select>` of the five locales → `setLanguage` on change.
- **PageSpeed API key**: password input + Save; shows the masked current key if set, and a
  `credentials.json` status line (found at `~/.sitedeck/credentials.json` / not found →
  setup hint). This also resolves the prior "credentials not found" UX.
- **Version & updates**: current version; a Check action shows the latest GitHub release →
  "Up to date" / "Update available (vY)" with a note (desktop auto-installs on restart;
  web is version-only).
- **About**: app name, version, description, links (GitHub repo, README, license, issues).

## Endpoints

- `GET /api/settings` → `{ language, hasPsiKey, psiKeyMasked, hasCredentials }`.
- `POST /api/settings` (JSON `{ language?, psiApiKey? }`) → validate (`language` ∈ the five;
  `psiApiKey` trimmed, empty string clears), merge-save, return updated state.
- `GET /api/version` → `{ current, latest, updateAvailable }` (current from `package.json`;
  latest from `https://api.github.com/repos/writingdeveloper/SiteDeck/releases/latest`,
  tolerant of failure → `latest: null`).
- `/locales/*.json` served by the existing static handler (they live under `public/`).

## Data flow

1. App load → `GET /api/settings` → resolve language → load catalog → `applyI18n` →
   render dashboards (Traffic/Performance) with `t()`.
2. Change language → `setLanguage` → `POST /api/settings` → reload catalog + re-apply + re-render.
3. Save PSI key → `POST /api/settings` → server writes `config.json` → insights become configured.
4. Version → `GET /api/version` → display.

## README

`README.md` (English, primary) + `README.ko.md`, `README.es.md`, `README.zh.md`,
`README.ja.md`. Each starts with a language-switcher line:
`English · [한국어](README.ko.md) · [Español](README.es.md) · [中文](README.zh.md) · [日本語](README.ja.md)`.

## Testing (TDD for pure logic)

- `t()` interpolation + fallback chain (locale → en → key); param substitution.
- locale resolution (setting → navigator → en) as a pure function of inputs.
- `settings` merge-write (patch merges; language validation; empty `psiApiKey` clears).
- catalog key parity: every non-`en` catalog contains all `en` keys (guards translations).

## Migration / compatibility

- Existing hard-coded Korean strings in `public/index.html` / `public/app.js` move into the
  catalogs (under `ko`, with `en`/`es`/`zh`/`ja` added) and are replaced by `data-i18n`/`t()`.
- `config.json` gaining `language` is backward-compatible (optional field); existing
  `{ psiApiKey }` files keep working.

## Non-goals

- Translation-management UI; RTL languages; pluralization beyond simple `{param}`
  interpolation; translating third-party (GA/Lighthouse) error text.
