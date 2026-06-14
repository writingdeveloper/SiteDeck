import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_DIR, CONFIG_JSON_PATH } from './config';

export const LANGUAGES = ['en', 'ko', 'es', 'zh', 'ja'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Settings {
  language?: Language;
  psiApiKey?: string;
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Merge a patch over current settings: validate language, trim key, empty key clears. */
export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current };
  if (patch.language !== undefined && isLanguage(patch.language)) next.language = patch.language;
  if (patch.psiApiKey !== undefined) {
    const trimmed = patch.psiApiKey.trim();
    if (trimmed) next.psiApiKey = trimmed;
    else delete next.psiApiKey;
  }
  return next;
}

export async function getSettings(): Promise<Settings> {
  if (!existsSync(CONFIG_JSON_PATH)) return {};
  try {
    const raw = JSON.parse(await readFile(CONFIG_JSON_PATH, 'utf8')) as Settings;
    return mergeSettings({}, raw);
  } catch {
    return {};
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings(await getSettings(), patch);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_JSON_PATH, JSON.stringify(next, null, 2));
  return next;
}

/** PSI key: SITEDECK_PSI_KEY env, else psiApiKey in config.json, else null (sync). */
export function getPsiApiKey(): string | null {
  if (process.env.SITEDECK_PSI_KEY) return process.env.SITEDECK_PSI_KEY;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { psiApiKey?: unknown };
    return typeof cfg.psiApiKey === 'string' && cfg.psiApiKey ? cfg.psiApiKey : null;
  } catch {
    return null;
  }
}
