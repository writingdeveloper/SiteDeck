// Types for the DOM-free client helpers in format.js (consumed by the unit tests).
export function escapeCsvField(value: unknown): string;
export function deltaClass(pct: number | null | undefined, bigThreshold: number): "none" | "flat" | "up" | "down" | "up big" | "down big";
export function toCsv(headers: unknown[], rows: unknown[][]): string;
export function matchesFilter(name: unknown, query: unknown): boolean;
export function relTime(fromMs: number, nowMs: number, locale: string, justNowLabel?: string): string;
export function resolveTheme(setting: unknown, prefersLight: boolean): "light" | "dark";
export function cwvRating(value: number | null | undefined, kind: string): "good" | "avg" | "poor" | "na";
export function cwvText(value: number | null | undefined, kind: string): string;
export function sortValue(s: Record<string, unknown>, key: string): number;
export function geoScore(s: { checks: Record<string, boolean>; llmsTxt: boolean }): number;
export function trendSparkText(values: number[] | null | undefined): string;
export function buildCopyText(site: Record<string, any>, labels: Record<string, string>): string;
export function toMarkdownTable(headers: unknown[], rows: unknown[][]): string;
export function portfolioTotals(sites: Array<Record<string, any>>): { activeUsers: number; sessions: number; keyEvents: number; aiSessions: number; declining: number; aiSharePct: number };
export function wowText(w: { current: number; previous: number; deltaPct: number | null } | null | undefined, locale?: string): string;
