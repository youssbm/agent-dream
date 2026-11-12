/**
 * idx stability for live sessions: reading a session, letting it grow (records appended, running tools
 * finishing, summaries written), and reading again must never shift earlier idx values.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '../../src/types.ts';
import { ClaudeCodeAdapter } from '../../src/transcripts/claude-code.ts';
import { CodexAdapter } from '../../src/transcripts/codex.ts';
import { OpencodeAdapter, PENDING_RESULT } from '../../src/transcripts/opencode.ts';
import { renderMessage } from '../../src/transcripts/chunk.ts';
import { tempDir, textOf } from './helpers.ts';

/** Every message of `before` keeps its idx/role in `after`, and its text is a prefix (unless it was pending). */
function expectStable(before: TranscriptMessage[], after: TranscriptMessage[]): void {
  expect(after.length).toBeGreaterThanOrEqual(before.length);
  for (const m of before) {
    const n = after[m.idx];
    expect(n, `idx ${m.idx} missing`).toBeDefined();
    expect(n!.idx).toBe(m.idx);
    expect(n!.role, `role of #${m.idx}`).toBe(m.role);
    if (textOf(m).includes(PENDING_RESULT)) continue;
    expect(renderMessage(n!).startsWith(renderMessage(m)), `text of #${m.idx}`).toBe(true);
  }
}

const jsonl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('idx stability across appends', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ dir, cleanup } = await tempDir()));
  afterAll(() => cleanup());

  it('Claude Code: appended records (incl. blocks of the same message.id) never shift earlier idx', async () => {
    const root = path.join(dir, 'claude', 'projects');
    const file = path.join(root, '-proj', 'aaaa0001-0000-4000-8000-000000000001.jsonl');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const base = { cwd: '/proj', sessionId: 'aaaa0001-0000-4000-8000-000000000001', isSidechain: false, timestamp: '2026-05-01T09:00:00Z' };
    const asst = (id: string, content: unknown[]): unknown => ({ ...base, type: 'assistant', message: { id, role: 'assistant', content } });
    const user = (content: unknown): unknown => ({ ...base, type: 'user', message: { role: 'user', content } });
    await fsp.writeFile(
      file,
      jsonl([
        user('Which port?'),
        asst('m1', [{ type: 'text', text: 'Checking.' }]),
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run dev' } }]),
        user([{ type: 'tool_result', tool_use_id: 't1', content: 'listening on :5173' }]),
        asst('m2', [{ type: 'text', text: 'Port 5173.' }]),
      ]) + '{"type":"assistant","partial',
    );
    const a = new ClaudeCodeAdapter({ root });
    const first = await a.readSession('aaaa0001-0000-4000-8000-000000000001');
    expect(first.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // Finish the partial line and keep going: more blocks of m2, a new tool round, a new user turn.
    const content = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(
      file,
      content.slice(0, content.lastIndexOf('\n') + 1) +
        jsonl([
          asst('m2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
          user([{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]),
          user('thanks'),
        ]),
    );
    const second = await a.readSession('aaaa0001-0000-4000-8000-000000000001');
    expectStable(first, second);
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
  });

  it('Codex: appended rollout records never shift earlier idx', async () => {
    const root = path.join(dir, 'codex');
    await fsp.mkdir(root, { recursive: true });
    const id = 'bbbb0001-0000-4000-8000-000000000001';
    const file = path.join(root, `rollout-2026-05-01T09-00-00-${id}.jsonl`);
    const item = (payload: unknown): unknown => ({ timestamp: '2026-05-01T09:00:00Z', type: 'response_item', payload });
    await fsp.writeFile(
      file,
      jsonl([
        { timestamp: '2026-05-01T09:00:00Z', type: 'session_meta', payload: { id, cwd: '/proj', timestamp: '2026-05-01T09:00:00Z' } },
        item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Which port?' }] }),
        item({ type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","npm run dev"]}', call_id: 'c1' }),
      ]),
    );
    const a = new CodexAdapter({ root });
    const first = await a.readSession(id);
    await fsp.appendFile(
      file,
      jsonl([
        item({ type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}', call_id: 'c2' }),
        item({ type: 'function_call_output', call_id: 'c1', output: 'listening on :5173' }),
        item({ type: 'function_call_output', call_id: 'c2', output: '' }),
        item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Port 5173.' }] }),
      ]),
    );
    expectStable(first, await a.readSession(id));
  });

  describe('opencode', () => {
    let db: import('node:sqlite').DatabaseSync;
    let dbPath: string;
    beforeAll(async () => {
      const { DatabaseSync } = await import('node:sqlite');
      dbPath = path.join(dir, 'oc', 'opencode.db');
      await fsp.mkdir(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE session (id text PRIMARY KEY, directory text, title text, parent_id text, time_created integer, time_updated integer);
        CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, data text);
        CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, data text);
        CREATE TABLE session_v2 (id text PRIMARY KEY, directory text, title text, parent_id text, time_created integer, time_updated integer);
        CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, data text);
      `);
    });
    afterAll(() => db.close());

    const msg = (id: string, sid: string, t: number, data: unknown): void => {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, sid, t, JSON.stringify(data));
    };
    const prt = (id: string, mid: string, sid: string, data: unknown): void => {
      db.prepare('INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?)').run(id, mid, sid, JSON.stringify(data));
    };
    const tool = (name: string, status: string, output?: string): unknown => ({ type: 'tool', tool: name, callID: name, state: { status, input: { command: name }, ...(output === undefined ? {} : { output }) } });

    it('v1: parallel tools finishing out of order and late summaries never shift earlier idx', async () => {
      const s = 'ses_live1';
      db.prepare('INSERT INTO session VALUES (?, ?, ?, NULL, 1, 2)').run(s, '/proj', 'live');
      msg('m1', s, 1, { role: 'user' });
      prt('p1', 'm1', s, { type: 'text', text: 'Run both.' });
      msg('m2', s, 2, { role: 'assistant' });
      prt('p2a', 'm2', s, { type: 'text', text: 'Starting.' });
      prt('p2b', 'm2', s, tool('slow', 'running'));
      prt('p2c', 'm2', s, tool('fast', 'completed', 'fast done'));
      msg('m3', s, 3, { role: 'assistant', summary: true }); // compaction summary not written yet
      const a = new OpencodeAdapter({ dbPath });
      const first = await a.readSession(s);
      expect(first.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'system']);
      expect(textOf(first[2])).toBe(PENDING_RESULT);

      prt('p2b', 'm2', s, tool('slow', 'completed', ''));
      prt('p3', 'm3', s, { type: 'text', text: 'Both ran.' });
      msg('m4', s, 4, { role: 'user' });
      prt('p4', 'm4', s, { type: 'text', text: 'thanks' });
      const second = await a.readSession(s);
      expectStable(first, second);
      expect(textOf(second[2])).toBe('[no output]');
      expect(textOf(second[5])).toContain('Both ran.');
    });

    it('v2: a tool finishing and a compaction summary arriving later never shift earlier idx', async () => {
      const s = 'ses_live2';
      db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, NULL, 1, 2)').run(s, '/proj', 'live2');
      const row = (id: string, type: string, seq: number, data: unknown): void => {
        db.prepare('INSERT OR REPLACE INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(id, s, type, seq, seq, JSON.stringify(data));
      };
      const t = (status: string, text?: string): unknown => ({ type: 'tool', id: 'x', name: 'bash', state: { status, input: { command: 'make' }, ...(text ? { content: [{ type: 'text', text }] } : {}) } });
      row('a', 'user', 1, { text: 'build it' });
      row('b', 'assistant', 2, { content: [t('pending'), { type: 'text', text: 'Waiting.' }] });
      row('c', 'compaction', 3, {});
      const a = new OpencodeAdapter({ dbPath });
      const first = await a.readSession(s);
      expect(first.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'system']);
      row('b', 'assistant', 2, { content: [t('completed', 'built'), { type: 'text', text: 'Waiting.' }, { type: 'text', text: 'Done.' }] });
      row('c', 'compaction', 3, { summary: 'Built the project.' });
      row('d', 'user', 4, { text: 'great' });
      const second = await a.readSession(s);
      expectStable(first, second);
      expect(textOf(second[4])).toContain('Built the project.');
    });
  });
});
