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

/**
 * Well-formed "owner/repo"? The only shape allowed to reach api.github.com.
 * Exported so the settings endpoint can REJECT a bad entry with a message instead of
 * letting mergeSettings silently drop it — a silent drop looks like a successful save
 * while the repo quietly never gets measured.
 */
export function isRepoFullName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.trim());
}

/**
 * Mask a secret for display: last 4 characters only. Unlike a Google API key, a GitHub PAT
 * starts with a long constant prefix (`github_pat_` / `ghp_`), so showing the head would
 * identify nothing while leaking the useful part of a short token.
 */
export function maskSecret(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

/** Merge a patch over current settings: validate language, trim key, empty key clears. */
export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current };
  if (patch.language !== undefined && isLanguage(patch.language)) next.language = patch.language;
  // Each secret is type-guarded, not just presence-checked: config.json is user-editable and
  // /api/settings takes arbitrary JSON, so a non-string here would throw out of .trim().
  if (typeof patch.psiApiKey === 'string') {
    const trimmed = patch.psiApiKey.trim();
    if (trimmed) next.psiApiKey = trimmed;
    else delete next.psiApiKey;
  }
  if (typeof patch.githubToken === 'string') {
    const trimmed = patch.githubToken.trim();
    if (trimmed) next.githubToken = trimmed;
    else delete next.githubToken;
  }
  if (patch.githubRepos !== undefined && Array.isArray(patch.githubRepos)) {
    // Backstop only — the endpoint rejects malformed entries before we get here.
    const repos = patch.githubRepos.filter(isRepoFullName).map((r) => r.trim());
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
  // config.json holds secrets (PSI key, GitHub PAT) — write it 0600 like token.json does.
  await writeJsonAtomic(CONFIG_JSON_PATH, next, { mode: 0o600 });
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

export const GITHUB_TOKEN_ENV = 'SITEDECK_GITHUB_TOKEN';
export const GITHUB_REPOS_ENV = 'SITEDECK_GITHUB_REPOS';

/**
 * Which GitHub values an environment variable is currently shadowing. The Settings UI needs
 * this: with the env var set, anything saved into config.json is read but never used, so the
 * form has to say so instead of showing a "Saved." that changes nothing.
 */
export function githubEnvOverrides(): { token: boolean; repos: boolean } {
  return {
    token: Boolean(process.env[GITHUB_TOKEN_ENV]),
    repos: Boolean(process.env[GITHUB_REPOS_ENV]),
  };
}

/** GitHub PAT: SITEDECK_GITHUB_TOKEN env, else githubToken in config.json, else null. */
export function getGithubToken(): string | null {
  if (process.env[GITHUB_TOKEN_ENV]) return process.env[GITHUB_TOKEN_ENV];
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { githubToken?: unknown };
    return typeof cfg.githubToken === 'string' && cfg.githubToken ? cfg.githubToken : null;
  } catch {
    return null;
  }
}

/** Repo list: SITEDECK_GITHUB_REPOS (comma-separated) env, else githubRepos in config.json, else []. */
export function getGithubRepos(): string[] {
  const env = process.env[GITHUB_REPOS_ENV];
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf8')) as { githubRepos?: unknown };
    return Array.isArray(cfg.githubRepos) ? cfg.githubRepos.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  } catch {
    return [];
  }
}
