import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceRef, TranscriptMessage } from '../../src/types.ts';
import { DreamError } from '../../src/types.ts';
import { checkQuote, parseMsgRange } from '../../src/transcripts/evidence.ts';
import { ClaudeCodeAdapter } from '../../src/transcripts/claude-code.ts';
import { OpencodeAdapter } from '../../src/transcripts/opencode.ts';
import { IDS, STORY, buildOpencodeDb, copyFixture, findMsg, tempDir } from './helpers.ts';

describe('parseMsgRange', () => {
  it('parses single idx and inclusive ranges', () => {
    expect(parseMsgRange('40')).toEqual({ from: 40, to: 40 });
    expect(parseMsgRange('40-52')).toEqual({ from: 40, to: 52 });
    expect(parseMsgRange(' 3 - 5 ')).toEqual({ from: 3, to: 5 });
    expect(parseMsgRange('0')).toEqual({ from: 0, to: 0 });
  });

  it('throws INVALID_OUTPUT on bad input', () => {
    for (const bad of ['', 'a', '5-3', '-1', '1-2-3', '1.5', '#4', '4-']) {
      expect(() => parseMsgRange(bad), bad).toThrow(DreamError);
      try {
        parseMsgRange(bad);
      } catch (e) {
        expect((e as DreamError).code).toBe('INVALID_OUTPUT');
      }
    }
  });
});

describe('checkQuote (Claude Code planted-error fixture)', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let raw: TranscriptMessage[];
  const src = (msgs: string, session: string = IDS.claude.main): SourceRef => ({ harness: 'claude-code', session, msgs });

  beforeAll(async () => {
    ({ home, cleanup } = await copyFixture('claude-code'));
    raw = await new ClaudeCodeAdapter({ homeDir: home }).readSession(IDS.claude.main);
  });
  afterAll(() => cleanup());

  it('accepts a real quote in the cited range (normalized for case, quotes and whitespace)', () => {
    const toolIdx = findMsg(raw, 'listening on :5173')!.idx;
    expect(checkQuote(raw, src(String(toolIdx)), 'listening on :5173')).toEqual({ ok: true });
    expect(checkQuote(raw, src(`${toolIdx}-${toolIdx + 2}`), '  LISTENING   on :5173 ')).toEqual({ ok: true });
    const corrIdx = findMsg(raw, STORY.correction)!.idx;
    expect(checkQuote(raw, src(String(corrIdx)), 'No, it’s 5173 – vite defaults to 5173')).toEqual({ ok: true });
  });

  it('allows one message of slack on each side of the range', () => {
    const toolIdx = findMsg(raw, 'listening on :5173')!.idx;
    expect(checkQuote(raw, src(String(toolIdx + 1)), 'listening on :5173').ok).toBe(true);
    expect(checkQuote(raw, src(String(toolIdx - 1)), 'listening on :5173').ok).toBe(true);
    expect(checkQuote(raw, src(String(toolIdx + 2)), 'listening on :5173')).toEqual({ ok: false, reason: 'not_found_in_range' });
    expect(checkQuote(raw, src('0-1'), 'listening on :5173')).toEqual({ ok: false, reason: 'not_found_in_range' });
  });

  it('rejects hallucinated quotes', () => {
    expect(checkQuote(raw, src('0-19'), 'the dev server listens on port 8080')).toEqual({ ok: false, reason: 'not_found_in_range' });
    expect(checkQuote(raw, src('0-19'), 'it is 5173, said the user')).toEqual({ ok: false, reason: 'not_found_in_range' });
  });

  it('checks against unfiltered text (content the filter stubs out still counts)', () => {
    const readIdx = findMsg(raw, '"vitest": "^1.6.0"')!.idx;
    expect(checkQuote(raw, src(String(readIdx)), '"vitest": "^1.6.0"').ok).toBe(true);
  });

  it('accepts quotes copied from the rendered chunk format', () => {
    const toolIdx = findMsg(raw, 'listening on :5173')!.idx;
    expect(checkQuote(raw, src(String(toolIdx)), '← Bash: > demo-app@0.1.0 dev').ok).toBe(true);
  });

  it('enforces quote length bounds', () => {
    expect(checkQuote(raw, src('0-19'), '5173')).toEqual({ ok: false, reason: 'quote_too_short' });
    expect(checkQuote(raw, src('0-19'), '   a   b   ')).toEqual({ ok: false, reason: 'quote_too_short' });
    expect(checkQuote(raw, src('0-19'), 'x'.repeat(601))).toEqual({ ok: false, reason: 'quote_too_long' });
  });

  it('reports session mismatches and bad ranges', () => {
    expect(checkQuote(raw, src('7', IDS.claude.older), 'listening on :5173')).toEqual({ ok: false, reason: 'session_mismatch' });
    expect(checkQuote(raw, { harness: 'codex', session: IDS.claude.main, msgs: '7' }, 'listening on :5173')).toEqual({ ok: false, reason: 'session_mismatch' });
    expect(checkQuote(raw, src('nine'), 'listening on :5173')).toEqual({ ok: false, reason: 'invalid_range' });
    expect(checkQuote(raw, src('900-905'), 'listening on :5173')).toEqual({ ok: false, reason: 'not_found_in_range' });
  });
});

describe('checkQuote (opencode fixture, mixed sessions)', () => {
  it('only looks at messages of the cited session', async () => {
    const t = await tempDir();
    try {
      const dbPath = await buildOpencodeDb(path.join(t.dir, 'opencode.db'));
      const a = new OpencodeAdapter({ dbPath });
      const v1 = await a.readSession(IDS.opencode.v1);
      const parts = await a.readSession(IDS.opencode.parts);
      const all = [...parts, ...v1];
      const idx = findMsg(v1, 'listening on :5173')!.idx;
      expect(checkQuote(all, { harness: 'opencode', session: IDS.opencode.v1, msgs: String(idx) }, 'listening on :5173').ok).toBe(true);
      // ses_parts also says "listening on :5173" at idx 2, but that must not satisfy a citation of another session.
      expect(checkQuote(all, { harness: 'opencode', session: IDS.opencode.v1, msgs: '2' }, 'listening on :5173').ok).toBe(idx >= 1 && idx <= 3);
    } finally {
      await t.cleanup();
    }
  });
});
