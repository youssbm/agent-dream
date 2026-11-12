/**
 * Textual diffs of staged changes for `dream_review show`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileChange } from '../types.ts';

type Edit = { kind: ' ' | '-' | '+'; line: string };

/** LCS line diff; falls back to "replace everything" for very large inputs. */
export function lineDiff(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((line) => ({ kind: '-' as const, line })), ...b.map((line) => ({ kind: '+' as const, line }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    const next = dp[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', line: a[i] as string });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: '-', line: a[i++] as string });
    } else {
      out.push({ kind: '+', line: b[j++] as string });
    }
  }
  while (i < n) out.push({ kind: '-', line: a[i++] as string });
  while (j < m) out.push({ kind: '+', line: b[j++] as string });
  return out;
}

function lines(text: string): string[] {
  if (text === '') return [];
  const l = text.replace(/\r\n?/g, '\n').split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** Diff of one file, with unchanged runs collapsed to `context` lines around changes. */
export function fileDiff(rel: string, before: string | null, after: string | null, context = 2): string {
  const head = [`--- ${before === null ? '/dev/null' : `a/${rel}`}`, `+++ ${after === null ? '/dev/null' : `b/${rel}`}`];
  const edits = lineDiff(lines(before ?? ''), lines(after ?? ''));
  const keep = new Array<boolean>(edits.length).fill(false);
  edits.forEach((e, i) => {
    if (e.kind === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(edits.length - 1, i + context); k++) keep[k] = true;
  });
  const body: string[] = [];
  let skipped = false;
  edits.forEach((e, i) => {
    if (!keep[i]) {
      skipped = true;
      return;
    }
    if (skipped) body.push('@@');
    skipped = false;
    body.push(`${e.kind}${e.line}`);
  });
  return [...head, ...body].join('\n');
}

/** Diff of a staged change set against the files currently in `dreamDir`. */
export async function changesDiff(dreamDir: string, changes: FileChange[]): Promise<string> {
  const parts: string[] = [];
  for (const c of changes) {
    let before: string | null = null;
    try {
      before = await readFile(path.join(dreamDir, ...c.path.split('/')), 'utf8');
    } catch {
      before = null;
    }
    const after = c.type === 'write' ? c.content : null;
    if (before !== null && after !== null && before.replace(/\r\n/g, '\n') === after.replace(/\r\n/g, '\n')) continue;
    if (before === null && after === null) continue;
    parts.push(fileDiff(c.path, before, after));
  }
  return parts.length ? parts.join('\n\n') : '(no differences)';
}
