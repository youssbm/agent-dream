import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, mergeConfig } from '../../src/store/config.ts';
import { DEFAULT_CONFIG } from '../../src/types.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dream-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults when the file is missing', async () => {
    expect(await loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults for unparsable JSON', async () => {
    await writeFile(path.join(dir, 'config.json'), '{ nope');
    expect(await loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it('merges valid fields onto defaults', async () => {
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ chunkTokens: 4000, applyMode: 'review', harnesses: ['codex'], safetyNetRatio: 0.5 }),
    );
    expect(await loadConfig(dir)).toEqual({
      ...DEFAULT_CONFIG,
      chunkTokens: 4000,
      applyMode: 'review',
      harnesses: ['codex'],
      safetyNetRatio: 0.5,
    });
  });

  it('tolerates a BOM', async () => {
    await writeFile(path.join(dir, 'config.json'), '﻿{"indexMaxLines": 50}');
    expect((await loadConfig(dir)).indexMaxLines).toBe(50);
  });

  it('returns a copy that does not alias DEFAULT_CONFIG', async () => {
    const cfg = await loadConfig(dir);
    cfg.harnesses.push('codex');
    expect(DEFAULT_CONFIG.harnesses).toEqual(['claude-code', 'codex', 'opencode']);
  });
});

describe('mergeConfig', () => {
  it('ignores invalid types and out-of-range values', () => {
    const cfg = mergeConfig({
      chunkTokens: '6000',
      runTokens: -5,
      indexMaxLines: 1.5,
      indexMaxBytes: null,
      applyMode: 'sometimes',
      safetyNetRatio: 2,
      safetyNetMinPages: -1,
      maxWikiSourceRatio: 0,
      harnesses: ['nope', 42],
      reverifyAfterDays: Number.NaN,
      reverifyVolatileAfterDays: 'x',
      unknownKey: true,
    });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('filters and dedups harnesses', () => {
    expect(mergeConfig({ harnesses: ['opencode', 'bogus', 'opencode', 'claude-code'] }).harnesses).toEqual([
      'opencode',
      'claude-code',
    ]);
    expect(mergeConfig({ harnesses: [] }).harnesses).toEqual(DEFAULT_CONFIG.harnesses);
  });

  it('accepts boundary values', () => {
    const cfg = mergeConfig({ safetyNetRatio: 0, safetyNetMinPages: 0, reverifyAfterDays: 0 });
    expect(cfg.safetyNetRatio).toBe(0);
    expect(cfg.safetyNetMinPages).toBe(0);
    expect(cfg.reverifyAfterDays).toBe(0);
  });

  it('handles non-object input', () => {
    expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig([1, 2])).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig('x')).toEqual(DEFAULT_CONFIG);
  });
});
