import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LANGUAGES } from './settings';

const dir = path.resolve(__dirname, '../public/locales');
const load = (l: string) => JSON.parse(readFileSync(path.join(dir, `${l}.json`), 'utf8')) as Record<string, string>;
const enKeys = Object.keys(load('en')).sort();

describe('locale catalogs', () => {
  it.each(LANGUAGES.filter((l) => l !== 'en'))('%s has exactly the en keys', (lang) => {
    expect(Object.keys(load(lang)).sort()).toEqual(enKeys);
  });
});
