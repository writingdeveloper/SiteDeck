import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  emptyStore,
  appendMeasurement,
  summarize,
  saveStore,
  loadStore,
} from './insights-store';

const m = (ts: string, p: number) => ({
  ts,
  performance: p,
  accessibility: 90,
  bestPractices: 90,
  seo: 90,
  lcpMs: null,
  cls: null,
  inpMs: null,
});

describe('appendMeasurement', () => {
  it('adds a measurement and sets lastRunAt + displayName', () => {
    const s = appendMeasurement(emptyStore(), 'https://a/', 'A', m('2026-06-13T00:00:00Z', 80), 90);
    expect(s.byUrl['https://a/']?.history).toHaveLength(1);
    expect(s.byUrl['https://a/']?.displayName).toBe('A');
    expect(s.lastRunAt).toBe('2026-06-13T00:00:00Z');
  });

  it('trims history to the retention cap, keeping the newest', () => {
    let s = emptyStore();
    for (let i = 0; i < 5; i++) {
      s = appendMeasurement(s, 'https://a/', 'A', m(`2026-06-1${i}T00:00:00Z`, i), 3);
    }
    const hist = s.byUrl['https://a/']?.history ?? [];
    expect(hist.map((x) => x.performance)).toEqual([2, 3, 4]);
  });
});

describe('summarize', () => {
  it('returns latest measurement and performance trend per url', () => {
    let s = emptyStore();
    s = appendMeasurement(s, 'https://a/', 'A', m('t1', 70), 90);
    s = appendMeasurement(s, 'https://a/', 'A', m('t2', 75), 90);
    const site = summarize(s, 30)[0];
    expect(site?.url).toBe('https://a/');
    expect(site?.latest?.performance).toBe(75);
    expect(site?.trend).toEqual([70, 75]);
  });

  it('omits null performance points from the trend (no fake drop-to-zero)', () => {
    let s = emptyStore();
    s = appendMeasurement(s, 'https://a/', 'A', m('t1', 80), 90);
    s = appendMeasurement(s, 'https://a/', 'A', m('t2', null as unknown as number), 90);
    s = appendMeasurement(s, 'https://a/', 'A', m('t3', 90), 90);
    expect(summarize(s, 30)[0]?.trend).toEqual([80, 90]);
  });
});

describe('saveStore / loadStore', () => {
  it('round-trips a store and creates the parent directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sitedeck-store-'));
    try {
      const file = path.join(dir, 'nested', 'insights.json');
      const store = appendMeasurement(emptyStore(), 'https://a/', 'A', m('2026-06-13T00:00:00Z', 80), 90);
      await saveStore(file, store);
      expect(await loadStore(file)).toEqual(store);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves no temporary file beside the saved store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sitedeck-store-'));
    try {
      const file = path.join(dir, 'insights.json');
      await saveStore(file, emptyStore());
      await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
