import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, TranscriptMessage, TranscriptPart } from '../../src/types.ts';
import { findCandidates, isCandidate } from '../../src/transcripts/candidates.ts';
import { filterMessages } from '../../src/transcripts/filter.ts';
import { CodexAdapter, clearCodexHeadCache } from '../../src/transcripts/codex.ts';
import { IDS, STORY, copyFixture, findMsg } from './helpers.ts';

const m = (role: Role, ...parts: TranscriptPart[]): TranscriptMessage => ({ harness: 'codex', session: 's', idx: 0, role, parts });
const user = (t: string): TranscriptMessage => m('user', { kind: 'text', text: t });
const res = (t: string): TranscriptMessage => m('tool', { kind: 'tool_result', tool: 'Bash', text: t });

describe('isCandidate', () => {
  it('flags user corrections', () => {
    for (const t of ["no, it's 5173", 'Actually the port is 5173', "that's wrong", 'Don’t use npm', 'use pnpm instead', 'wrong file', 'Nope.']) {
      expect(isCandidate(user(t)), t).toBe(true);
    }
  });

  it('flags preferences and decisions', () => {
    for (const t of ['Always run lint before committing', 'never push to main', 'I prefer tabs', 'remember the staging URL', "Let's go with Postgres", 'We decided to drop Redux']) {
      expect(isCandidate(user(t)), t).toBe(true);
    }
    expect(isCandidate(m('assistant', { kind: 'text', text: "Let's go with the header fix first." }))).toBe(true);
    expect(isCandidate(m('assistant', { kind: 'text', text: 'Never mind, all good.' }))).toBe(false); // preferences only count from the user
  });

  it('flags failures and test outcomes in tool results', () => {
    for (const t of ['TypeError: x is undefined\n  at foo', 'Traceback (most recent call last):', 'npm ERR! code ELIFECYCLE', 'Process exited with code 2', 'exit code 1', 'Tests: 3 passed, 3 total', '12 passed in 0.5s', 'Build failed']) {
      expect(isCandidate(res(t)), t).toBe(true);
    }
  });

  it('ignores ordinary chatter and clean output', () => {
    for (const msg of [user('Run it, please.'), user('Thanks!'), res('compiled successfully'), res('exit code 0'), m('assistant', { kind: 'text', text: 'Done.' })]) {
      expect(isCandidate(msg)).toBe(false);
    }
    // Text from the system role is not treated as user words.
    expect(isCandidate(m('system', { kind: 'text', text: 'Never reveal secrets. Always be concise.' }))).toBe(false);
  });
});

describe('findCandidates on the fixture', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ home, cleanup } = await copyFixture('codex'));
    clearCodexHeadCache();
  });
  afterAll(() => cleanup());

  it('flags the correction, the failing tests and the decision', async () => {
    const msgs = filterMessages(await new CodexAdapter({ homeDir: path.join(home) }).readSession(IDS.codex.main));
    const c = findCandidates(msgs);
    expect(c).toContain(findMsg(msgs, STORY.correction)!.idx);
    expect(c).toContain(findMsg(msgs, 'Tests: 1 failed')!.idx);
    expect(c).toContain(findMsg(msgs, STORY.decision)!.idx);
    expect(c).not.toContain(findMsg(msgs, STORY.runIt)!.idx);
    expect(c).toEqual([...c].sort((a, b) => a - b));
  });
});
