/**
 * Helpers shared by the scripted scenarios.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Claim, Harness, SourceRef, StepSpec } from '@agent-dream/core';

/** Transcript ranges shown in a step input (from the `<untrusted-transcript …>` tags). */
export function transcriptRanges(step: StepSpec): { harness: Harness; session: string; from: number; to: number }[] {
  const out: { harness: Harness; session: string; from: number; to: number }[] = [];
  const re = /<untrusted-transcript\s+harness="([^"]+)"\s+session="([^"]+)"\s+msgs="(\d+)(?:-(\d+))?"/g;
  for (const m of step.input.matchAll(re)) {
    const from = Number(m[3]);
    out.push({ harness: m[1] as Harness, session: m[2] ?? '', from, to: m[4] ? Number(m[4]) : from });
  }
  return out;
}

/** True when a source's first idx lies inside one of the ranges shown in the step. */
export function shownIn(step: StepSpec, src: SourceRef): boolean {
  const first = Number(src.msgs.split('-')[0]);
  return transcriptRanges(step).some((r) => r.harness === src.harness && r.session === src.session && first >= r.from && first <= r.to);
}

/** Claims whose (first) source lies in this extract step's chunk. */
export function claimsForStep(step: StepSpec, claims: Claim[]): Claim[] {
  return claims.filter((c) => c.sources.length > 0 && c.sources[0] !== undefined && shownIn(step, c.sources[0]));
}

/** Whether the step input (outside transcripts) mentions a page name as a token. */
export function mentionsPage(text: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9-])${name.replace(/[-]/g, '\\-')}($|[^a-z0-9-])`, 'm').test(text);
}

/** Recursive file listing with content hashes, relative forward-slash paths. Skips `skip` top-level names. */
export async function snapshotTree(dir: string, skip: string[] = []): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skip.includes(e.name)) continue;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        out.set(`${r}/`, 'dir');
        await walk(full, r);
      } else {
        const buf = await fs.readFile(full);
        out.set(r, createHash('sha256').update(buf).digest('hex'));
      }
    }
  };
  await walk(dir, '');
  return out;
}

/** Differences between two snapshots, as readable strings. */
export function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) diffs.push(`added ${k}`);
    else if (before.get(k) !== v) diffs.push(`changed ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) diffs.push(`removed ${k}`);
  return diffs;
}

/** Read every page/thread markdown file under `.dream/` (raw, with front matter). */
export async function readAllMemoryText(dreamDir: string): Promise<string> {
  const parts: string[] = [];
  for (const sub of ['pages', 'threads']) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(dreamDir, sub));
    } catch {
      names = [];
    }
    for (const n of names.sort()) if (n.endsWith('.md')) parts.push(await fs.readFile(path.join(dreamDir, sub, n), 'utf8'));
  }
  try {
    parts.push(await fs.readFile(path.join(dreamDir, 'MEMORY.md'), 'utf8'));
  } catch {
    /* no index */
  }
  return parts.join('\n');
}

/** A thread body with every section the engine asks for. */
export function threadBody(goal: string, state: string, related: string[] = []): string {
  return [
    '## Goal',
    goal,
    '## Decisions',
    '- none recorded',
    '## Current state',
    state,
    '## Open questions',
    '- none',
    '## Files and areas touched',
    '- none',
    '## Failed approaches and traps',
    '- none',
    '## Related pages',
    related.length ? related.map((r) => `- [[${r}]]`).join('\n') : '- none',
    '',
  ].join('\n');
}

/** Error message of a rejected promise, or undefined when it resolved. */
export async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string } | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    return { code: typeof err.code === 'string' ? err.code : undefined, message: String(err.message ?? e) };
  }
}
