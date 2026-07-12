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
 * Is this state-changing request same-origin?
 *
 * The DNS-rebinding guard only checks the Host header — which a cross-site POST from any
 * website the user happens to be visiting legitimately satisfies, because the request
 * really IS addressed to localhost:PORT. Browsers always attach `Origin` to a cross-origin
 * POST, so a present-but-foreign Origin is the signal.
 *
 * An ABSENT Origin means it is not a cross-site browser request (curl, a local script);
 * allowing it costs no security and keeps local tooling working.
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
