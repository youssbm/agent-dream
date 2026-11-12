/**
 * Test helpers for the transcript fixtures (fixtures/transcripts, all synthetic).
 * Other test suites (engine, bench) may reuse these.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranscriptMessage } from '../../src/types.ts';

/** Absolute path of `fixtures/transcripts`. */
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/transcripts');

/** Strings of the planted-error story shared by all harness fixtures. */
export interface Story {
  cwd: string;
  otherCwd: string;
  ask: string;
  check: string;
  packageJson: string;
  wrongClaim: string;
  runIt: string;
  devOutput: string;
  wrongAgain: string;
  correction: string;
  ack: string;
  runTests: string;
  testOutput: string;
  decision: string;
  pnpm: string;
  pnpmAck: string;
}
export const STORY = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'story.json'), 'utf8')) as Story;

export const IDS = {
  claude: {
    main: 'c0de0001-0000-4000-8000-000000000001',
    older: 'c0de0001-0000-4000-8000-000000000002',
    other: 'c0de0001-0000-4000-8000-000000000003',
    empty: 'c0de0001-0000-4000-8000-000000000004',
  },
  codex: {
    main: '0c0d0e00-0000-4000-8000-000000000001',
    subagent: '0c0d0e00-0000-4000-8000-000000000002',
    windows: '0c0d0e00-0000-4000-8000-000000000003',
    archived: '0c0d0e00-0000-4000-8000-000000000004',
  },
  opencode: { v1: 'ses_v1demo', v2: 'ses_v2demo', child: 'ses_child', other: 'ses_other', parts: 'ses_parts' },
} as const;

/** A fresh temp directory and its cleanup. */
export async function tempDir(prefix = 'agent-dream-transcripts-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/** Copy `fixtures/transcripts/<sub>` into a temp dir (the copy is the fake home directory). */
export async function copyFixture(sub: 'claude-code' | 'codex'): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const t = await tempDir();
  await fsp.cp(path.join(FIXTURES, sub), t.dir, { recursive: true });
  return { home: t.dir, cleanup: t.cleanup };
}

/** Set a file's mtime (and atime) to an ISO time. */
export async function setMtime(file: string, iso: string): Promise<void> {
  const d = new Date(iso);
  await fsp.utimes(file, d, d);
}

/** Build the synthetic opencode database from `fixtures/transcripts/opencode/opencode.sql` at `file`. */
export async function buildOpencodeDb(file: string): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(fs.readFileSync(path.join(FIXTURES, 'opencode', 'opencode.sql'), 'utf8'));
  } finally {
    db.close();
  }
  return file;
}

/** All part texts of a message joined by newlines. */
export function textOf(m: TranscriptMessage | undefined): string {
  return m ? m.parts.map((p) => p.text).join('\n') : '';
}

/** First message whose text contains `needle`. */
export function findMsg(msgs: TranscriptMessage[], needle: string): TranscriptMessage | undefined {
  return msgs.find((m) => textOf(m).includes(needle));
}
