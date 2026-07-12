import { PERIODS, type Period } from './config';

/** Coerce a raw `?period` query value to a supported Period, defaulting to 28. */
export function parsePeriod(raw: string | null): Period {
  const n = Number(raw);
  return (PERIODS as readonly number[]).includes(n) ? (n as Period) : 28;
}

// A revoked/expired Google grant surfaces deep in the API client; treat it as
// "needs to reconnect" rather than an opaque 500.
export function isReauthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant|invalid_token|token (has been|was) (expired|revoked)|unauthorized_client/i.test(msg);
}

/** True for a GA4 numeric property id (digits only, 1–20 chars). Guards the
 *  site-detail endpoint against path-injection / malformed ids. */
export function isValidPropertyId(raw: string | null): raw is string {
  return typeof raw === 'string' && /^\d{1,20}$/.test(raw);
}

/**
 * Is this request same-origin? Gates both state-changing requests (POST/etc.) AND every
 * `/api/*` request including read-only GETs — see server.ts's same-origin guard: /api/summary
 * is a GET but writes the history store and fans out real GA4 calls, so it needs this too.
 *
 * The DNS-rebinding guard only checks the Host header — which a cross-site request from any
 * website the user happens to be visiting legitimately satisfies, because the request really
 * IS addressed to localhost:PORT.
 *
 * For POST — the security-critical case, since it's what protects the PSI key and GitHub PAT
 * in /api/settings — this check is airtight: a browser always attaches a foreign `Origin` to
 * a cross-site POST, so a present-but-foreign Origin is a reliable signal.
 *
 * For GET, an absent Origin is NOT proof the request isn't cross-site: a no-cors cross-site
 * sub-resource request (e.g. `<img src=".../api/summary">`) sends NO Origin at all, same as a
 * same-site request or curl. What actually blocks that `<img>` is `Sec-Fetch-Site: cross-site`
 * below — so the /api/* GET protection rests entirely on Sec-Fetch-Site support (Chrome 76+,
 * Firefox 90+, Safari 16.4+). On an older browser that never sends Sec-Fetch-Site, a cross-site
 * GET with no Origin falls through both checks and reaches the handler — a residual gap, but
 * one that only affects read-only endpoints on legacy browsers, never the Origin-protected
 * POSTs.
 *
 * Assumes header keys are already lowercased, as Node's `http.IncomingMessage.headers`
 * guarantees for real requests. A hand-built object with a capitalized key (e.g.
 * `{ Origin: '...' }`) reads as "no origin" and is ALLOWED — keep test fixtures lowercase.
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
