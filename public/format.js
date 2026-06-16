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
