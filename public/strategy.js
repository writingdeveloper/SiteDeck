// Pure, DOM-free improvement-strategy engine. Shared by the dashboard
// (public/app.js) and unit tests (src/strategy.test.ts → ../public/strategy.js).
// Deterministic, no network, $0. Thresholds live here (the browser can't read
// src/config.ts); tune them in one place.

export const STRATEGY = {
  DELTA_DROP: -25,
  TREND_DOWN_RATIO: 0.8,
  AI_SHARE_LOW: 0.02,
  AI_SHARE_MIN_SESSIONS: 50,
  CTR_LOW: 0.02,
  CTR_MIN_IMPRESSIONS: 100,
  POSITION_WEAK: 10,
  CONVERSION_LOW: 0.01,
  CONVERSION_MIN_SESSIONS: 50,
  CHANNEL_CONCENTRATION: 0.7,
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, good: 3 };
const round1 = (n) => Math.round(n * 10) / 10;

/** Diagnose a site summary (+ optional channel breakdown) into ordered findings.
 *  Each finding: { id, severity, params } — app.js maps id→localized text. */
export function analyzeSite(summary, detail) {
  const out = [];
  const { activeUsers, sessions, keyEvents, aiSessions, trend, search } = summary;

  // High: active-user drop vs the previous period (deltaPct may be null).
  if (activeUsers && typeof activeUsers.deltaPct === "number" && activeUsers.deltaPct <= STRATEGY.DELTA_DROP) {
    out.push({ id: "delta-drop", severity: "high", params: { pct: activeUsers.deltaPct } });
  }

  // High: downward daily trend (last day well below the first, with real volume).
  if (trend && trend.length >= 2) {
    const first = trend[0] ?? 0;
    const last = trend[trend.length - 1] ?? 0;
    const sum = trend.reduce((a, b) => a + b, 0);
    if (sum > 0 && first > 0 && last < first * STRATEGY.TREND_DOWN_RATIO) {
      out.push({ id: "trend-down", severity: "high", params: {} });
    }
  }

  // Medium: low AI-referred share (only meaningful with enough sessions).
  if (sessions && sessions.current >= STRATEGY.AI_SHARE_MIN_SESSIONS) {
    const share = (aiSessions?.current ?? 0) / sessions.current;
    if (share < STRATEGY.AI_SHARE_LOW) {
      out.push({ id: "ai-share-low", severity: "medium", params: { pct: round1(share * 100) } });
    }
  }

  // Medium: low search click-through rate despite impressions.
  if (search && search.impressions >= STRATEGY.CTR_MIN_IMPRESSIONS) {
    const ctr = search.clicks / search.impressions;
    if (ctr < STRATEGY.CTR_LOW) {
      out.push({ id: "ctr-low", severity: "medium", params: { pct: round1(ctr * 100) } });
    }
  }

  // Medium: one channel dominates traffic (needs the breakdown).
  if (detail && detail.channels && detail.channels.length > 0) {
    const total = detail.channels.reduce((a, c) => a + c.value, 0);
    const top = detail.channels[0];
    if (total > 0 && top && top.value / total > STRATEGY.CHANNEL_CONCENTRATION) {
      out.push({
        id: "channel-concentrated",
        severity: "medium",
        params: { name: top.name, pct: round1((top.value / total) * 100) },
      });
    }
  }

  // Low: weak average search position.
  if (search && search.impressions >= STRATEGY.CTR_MIN_IMPRESSIONS && search.position > STRATEGY.POSITION_WEAK) {
    out.push({ id: "position-weak", severity: "low", params: { pos: round1(search.position) } });
  }

  // Low: few key events per session.
  if (sessions && sessions.current >= STRATEGY.CONVERSION_MIN_SESSIONS) {
    const rate = (keyEvents?.current ?? 0) / sessions.current;
    if (rate < STRATEGY.CONVERSION_LOW) {
      out.push({ id: "conversion-low", severity: "low", params: { pct: round1(rate * 100) } });
    }
  }

  if (out.length === 0) out.push({ id: "all-good", severity: "good", params: {} });

  return out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
  );
}
