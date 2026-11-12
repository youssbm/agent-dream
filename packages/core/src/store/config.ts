/**
 * `.dream/config.json` loading: user values merged onto DEFAULT_CONFIG, invalid fields ignored.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, HARNESSES } from '../types.ts';
import type { DreamConfig, Harness } from '../types.ts';

/** File name of the config inside `.dream/`. */
export const CONFIG_FILE = 'config.json';

/** A fresh copy of the defaults (arrays not shared with DEFAULT_CONFIG). */
export function defaultConfig(): DreamConfig {
  return { ...DEFAULT_CONFIG, harnesses: [...DEFAULT_CONFIG.harnesses] };
}

type NumRule = { min: number; max: number; integer: boolean };

const NUMBER_RULES: Record<
  Exclude<keyof DreamConfig, 'applyMode' | 'harnesses'>,
  NumRule
> = {
  chunkTokens: { min: 100, max: 1_000_000, integer: true },
  runTokens: { min: 100, max: 100_000_000, integer: true },
  indexMaxLines: { min: 1, max: 100_000, integer: true },
  indexMaxBytes: { min: 64, max: 100 * 1024 * 1024, integer: true },
  safetyNetRatio: { min: 0, max: 1, integer: false },
  safetyNetMinPages: { min: 0, max: 1_000_000, integer: true },
  maxWikiSourceRatio: { min: 0.001, max: 1_000, integer: false },
  reverifyAfterDays: { min: 0, max: 36_500, integer: false },
  reverifyVolatileAfterDays: { min: 0, max: 36_500, integer: false },
};

function validNumber(v: unknown, rule: NumRule): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= rule.min &&
    v <= rule.max &&
    (!rule.integer || Number.isInteger(v))
  );
}

/**
 * Merge an arbitrary parsed value onto the defaults. Unknown keys and fields with a wrong type or out-of-range
 * value are ignored (the default is kept). `harnesses` keeps only known harness names (deduplicated); an
 * empty result keeps the default list.
 */
export function mergeConfig(raw: unknown): DreamConfig {
  const cfg = defaultConfig();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return cfg;
  const r = raw as Record<string, unknown>;
  for (const [key, rule] of Object.entries(NUMBER_RULES) as [keyof typeof NUMBER_RULES, NumRule][]) {
    const v = r[key];
    if (validNumber(v, rule)) cfg[key] = v;
  }
  if (r['applyMode'] === 'auto' || r['applyMode'] === 'review') cfg.applyMode = r['applyMode'];
  if (Array.isArray(r['harnesses'])) {
    const hs: Harness[] = [];
    for (const h of r['harnesses']) {
      if (typeof h === 'string' && (HARNESSES as readonly string[]).includes(h) && !hs.includes(h as Harness)) {
        hs.push(h as Harness);
      }
    }
    if (hs.length > 0) cfg.harnesses = hs;
  }
  return cfg;
}

/**
 * Read `<dreamDir>/config.json` and merge it onto DEFAULT_CONFIG.
 * A missing or unparsable file yields the defaults. Never throws for bad content.
 */
export async function loadConfig(dreamDir: string): Promise<DreamConfig> {
  let text: string;
  try {
    text = await readFile(path.join(dreamDir, CONFIG_FILE), 'utf8');
  } catch {
    return defaultConfig();
  }
  try {
    return mergeConfig(JSON.parse(text.replace(/^﻿/, '')) as unknown);
  } catch {
    return defaultConfig();
  }
}
