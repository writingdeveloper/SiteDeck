import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLanguage, type Language } from './settings';

export type Catalog = Record<string, string>;

export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

export function translate(
  catalog: Catalog,
  fallback: Catalog,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const template = catalog[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/locales');

const cache = new Map<string, Catalog>();

function load(locale: string): Catalog {
  const cached = cache.get(locale);
  if (cached) return cached;
  let catalog: Catalog = {};
  try {
    catalog = JSON.parse(readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')) as Catalog;
  } catch {
    catalog = {};
  }
  cache.set(locale, catalog);
  return catalog;
}

/** Server-side translate for the given locale, falling back to en. */
export function tServer(locale: string, key: string, params: Record<string, string | number> = {}): string {
  const lang: Language = isLanguage(locale) ? locale : 'en';
  return translate(load(lang), load('en'), key, params);
}
