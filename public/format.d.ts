// Types for the DOM-free client helpers in format.js (consumed by the unit tests).
export function escapeCsvField(value: unknown): string;
export function toCsv(headers: unknown[], rows: unknown[][]): string;
export function matchesFilter(name: unknown, query: unknown): boolean;
export function relTime(fromMs: number, nowMs: number, locale: string, justNowLabel?: string): string;
export function resolveTheme(setting: unknown, prefersLight: boolean): "light" | "dark";
