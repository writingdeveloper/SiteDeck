# Contributing to SiteDeck

Thanks for your interest! SiteDeck is a small, local-first GA4 + PageSpeed
dashboard — contributions are welcome.

## Setup

- Node 20 or 22.
- `npm install`
- Put a Google OAuth **desktop** client at `~/.sitedeck/credentials.json`
  (copy `credentials.json.example` and fill it in — see the README for the GCP
  steps). A PageSpeed API key is optional and can be entered in the Settings tab.
- `npm start` runs the dashboard at <http://localhost:4317>.
  `npm run electron` runs the desktop shell.

## Before opening a PR

Both of these must pass — CI runs them on Node 20 and 22:

```bash
npm run typecheck
npm test
```

- Follow the existing style: strict TypeScript, ESM, no dev build step (run via
  `tsx`). The packaged app runs a precompiled `dist/server.mjs`.
- Add or update **tests** for any behavior change — the project uses Vitest.
- Keep secrets out of commits: never commit `credentials.json`, `token.json`, or
  `config.json`. They live in `~/.sitedeck/` and are gitignored.

## Reporting

- Bugs / ideas: open an issue (templates provided).
- Security vulnerabilities: see [SECURITY.md](SECURITY.md) — please report privately.
