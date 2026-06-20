import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_JSON_PATH } from './config';
import { writeJsonAtomic } from './atomic';

export const LANGUAGES = ['en', 'ko', 'es', 'zh', 'ja'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Settings {
  language?: Language;
  psiApiKey?: string;
  githubToken?: string;
  githubRepos?: string[];
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
  if (patch.githubToken !== undefined) {
    const trimmed = patch.githubToken.trim();
    if (trimmed) next.githubToken = trimmed;
    else delete next.githubToken;
  }
  if (patch.githubRepos !== undefined && Array.isArray(patch.githubRepos)) {
    const repos = patch.githubRepos.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim());
    if (repos.length) next.githubRepos = repos;
    else delete next.githubRepos;
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
  await writeJsonAtomic(CONFIG_JSON_PATH, next);
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

/** GitHub PAT: SITEDECK_GITHUB_TOKEN env, else githubToken in config.json, else null. */
export function getGithubToken(): string | null {
  if (process.env.SITEDECK_GITHUB_TOKEN) return process.env.SITEDECK_GITHUB_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { githubToken?: unknown };
    return typeof cfg.githubToken === 'string' && cfg.githubToken ? cfg.githubToken : null;
  } catch {
    return null;
  }
}

/** Repo list: SITEDECK_GITHUB_REPOS (comma-separated) env, else githubRepos in config.json, else []. */
export function getGithubRepos(): string[] {
  const env = process.env.SITEDECK_GITHUB_REPOS;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { githubRepos?: unknown };
    return Array.isArray(cfg.githubRepos) ? cfg.githubRepos.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  } catch {
    return [];
  }
}
