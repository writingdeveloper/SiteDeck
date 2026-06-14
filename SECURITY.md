# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue for a
vulnerability.

- Preferred: open a [private security advisory](https://github.com/writingdeveloper/SiteDeck/security/advisories/new).
- Alternatively, email the maintainer and allow a reasonable time to respond
  before any public disclosure.

Please include steps to reproduce, the affected version, and the impact you
observed. We aim to acknowledge reports within a few days.

## Supported versions

SiteDeck is distributed from GitHub Releases. Only the **latest** release
receives security fixes. Update via the in-app updater or by installing the
newest release.

## How SiteDeck handles your data

SiteDeck is a local-only dashboard. There is no SiteDeck server and no
telemetry — your data never leaves your machine except to call Google's APIs
directly.

- **Credentials and tokens** live only on your machine, under `~/.sitedeck/`:
  - `credentials.json` — your Google OAuth *desktop* client (client id/secret).
  - `token.json` — the OAuth refresh/access token, written with `0600`
    permissions.
  - `config.json` — local settings, including your optional PageSpeed API key.
- **OAuth scope** is read-only Analytics
  (`https://www.googleapis.com/auth/analytics.readonly`).
- **OAuth flow** uses a loopback redirect (`http://localhost:4317/oauth/callback`)
  and opens consent in your real browser, never an embedded webview.
- None of these files are tracked by git. Never commit `credentials.json`,
  `token.json`, or `config.json`, and never share them.

## Building from source

Releases are not code-signed yet, so Windows SmartScreen will warn on first run
(choose *More info → Run anyway*). If you prefer, clone the repo and run from
source with `npm start`.
