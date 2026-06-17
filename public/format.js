// Pure, DOM-free formatting helpers shared by the dashboard front-end and unit
// tests. No imports, no browser globals beyond Intl (available in Node too).

/** Escape one CSV field (RFC 4180): quote if it contains a comma/quote/newline. */
export function escapeCsvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header row + data rows (arrays of cells). */
export function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(escapeCsvField).join(",")).join("\r\n");
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
