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
