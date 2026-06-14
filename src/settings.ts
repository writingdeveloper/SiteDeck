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
