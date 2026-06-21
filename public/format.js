// Pure, DOM-free formatting helpers shared by the dashboard front-end and unit
// tests. No imports, no browser globals beyond Intl (available in Node too).

/** Escape one CSV field (RFC 4180): quote if it contains a comma/quote/newline.
 *  Also neutralizes spreadsheet formula injection — a leading =/+/@ (or a leading
 *  - that isn't a real number) is prefixed with ' so Excel/Sheets treats it as text. */
export function escapeCsvField(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+@\t\r]/.test(s) || (s[0] === "-" && !Number.isFinite(Number(s)))) {
    s = "'" + s;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header row + data rows (arrays of cells). */
export function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(escapeCsvField).join(",")).join("\r\n");
}

/** Classify a period-over-period delta for the badge: "none" (no prior data),
 *  "flat" (rounds to 0.0%), "up"/"down", or "up big"/"down big" past bigThreshold. */
export function deltaClass(pct, bigThreshold) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "none";
  if (Math.abs(pct) < 0.05) return "flat";
  const dir = pct > 0 ? "up" : "down";
  return Math.abs(pct) >= bigThreshold ? dir + " big" : dir;
}

/** Case-insensitive substring match; an empty/whitespace query matches everything. */
export function matchesFilter(name, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return true;
  return String(name ?? "").toLowerCase().includes(q);
}

// Core Web Vitals "good / needs-improvement / poor" thresholds.
const CWV_THRESHOLDS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500] };

/** Rate a Core Web Vital value as "good" | "avg" | "poor" (or "na" if unknown). */
export function cwvRating(value, kind) {
  const t = CWV_THRESHOLDS[kind];
  if (value === null || value === undefined || !t) return "na";
  return value <= t[0] ? "good" : value <= t[1] ? "avg" : "poor";
}

/** Display a Core Web Vital: LCP in seconds, CLS to 2 dp, INP in ms. */
export function cwvText(value, kind) {
  if (value === null || value === undefined) return "—";
  if (kind === "lcp") return `${(value / 1000).toFixed(1)}s`;
  if (kind === "cls") return value.toFixed(2);
  if (kind === "inp") return `${Math.round(value)}ms`;
  return String(value);
}

/** Resolve a theme setting ("system"/unset → the OS preference) to "light" or "dark". */
export function resolveTheme(setting, prefersLight) {
  if (setting === "light" || setting === "dark") return setting;
  return prefersLight ? "light" : "dark";
}

/** Localized "x minutes ago" for a timestamp, with a "just now" label under a minute. */
export function relTime(fromMs, nowMs, locale, justNowLabel = "just now") {
  const diffSec = Math.round((nowMs - fromMs) / 1000);
  if (!isFinite(diffSec)) return "";
  if (diffSec < 60) return justNowLabel;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return rtf.format(-diffHr, "hour");
  return rtf.format(-Math.round(diffHr / 24), "day");
}

/** Numeric sort value for a site under the active column. Search columns read from
 *  s.search; for average position, a site with no impressions sorts last via Infinity.
 *  Every other column is a MetricDelta with a .current. */
export function sortValue(s, key) {
  if (key === "searchImpressions") return s.search?.impressions ?? 0;
  if (key === "searchClicks") return s.search?.clicks ?? 0;
  if (key === "searchPosition") return s.search && s.search.impressions > 0 ? s.search.position : Infinity;
  return s[key]?.current ?? 0;
}

/** Count how many of the 6 GEO/on-page signals are true for a site. */
export function geoScore(s) {
  const c = s.checks;
  return [c.title, c.description, c.canonical, c.openGraph, c.structuredData, s.llmsTxt].filter(Boolean).length;
}
