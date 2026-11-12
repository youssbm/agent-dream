import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, TranscriptMessage, TranscriptPart } from '../../src/types.ts';
import { DREAM_PROMPT_FIRST_LINE, RESUME_PROMPT_FIRST_LINE } from '../../src/types.ts';
import { DREAM_RUN_STUB, FILE_READ_STUB, filterMessages, headTail, isDreamTraffic } from '../../src/transcripts/filter.ts';
import { ClaudeCodeAdapter } from '../../src/transcripts/claude-code.ts';
import { IDS, STORY, copyFixture, findMsg, textOf } from './helpers.ts';

let n = 0;
const msg = (role: Role, ...parts: TranscriptPart[]): TranscriptMessage => ({ harness: 'claude-code', session: 's', idx: n++, role, parts });
const text = (t: string): TranscriptPart => ({ kind: 'text', text: t });
const call = (tool: string, t: string): TranscriptPart => ({ kind: 'tool_call', tool, text: t });
const result = (tool: string, t: string): TranscriptPart => ({ kind: 'tool_result', tool, text: t });

describe('filterMessages', () => {
  it('drops reasoning (unless asked) and keeps idx values', () => {
    n = 0;
    const msgs = [msg('user', text('hi')), msg('assistant', { kind: 'reasoning', text: 'secret thoughts' }), msg('assistant', { kind: 'reasoning', text: 'r' }, text('answer'))];
    const out = filterMessages(msgs);
    expect(out.map((m) => m.idx)).toEqual([0, 2]);
    expect(out[1]!.parts).toEqual([text('answer')]);
    expect(filterMessages(msgs, { keepReasoning: true }).map((m) => m.idx)).toEqual([0, 1, 2]);
    expect(msgs[1]!.parts).toHaveLength(1); // input untouched
  });

  it('shortens long tool results to head + tail', () => {
    n = 0;
    const long = 'A'.repeat(1000) + 'MIDDLE' + 'Z'.repeat(1000);
    const out = filterMessages([msg('assistant', call('Bash', 'npm run build')), msg('tool', result('Bash', long))]);
    const p = out[1]!.parts[0]!;
    expect(p.truncated).toBe(true);
    expect(p.originalChars).toBe(long.length);
    expect(p.text.startsWith('A'.repeat(900))).toBe(true);
    expect(p.text.endsWith('Z'.repeat(600))).toBe(true);
    expect(p.text).toContain(`… [${long.length - 1500} chars omitted]`);
    expect(p.text).not.toContain('MIDDLE');
    expect(filterMessages([msg('tool', result('Bash', long))], { maxToolResultChars: 5000 })[0]!.parts[0]!.truncated).toBeUndefined();
  });

  it('stubs file reads by tool name or by read-only shell command, unless short or an error', () => {
    n = 0;
    const big = 'line\n'.repeat(200);
    const out = filterMessages([
      msg('assistant', call('Read', '{"file_path":"/a.ts"}')),
      msg('tool', result('Read', big)),
      msg('assistant', call('shell_command', 'cat src/a.ts')),
      msg('tool', result('shell_command', big)),
      msg('assistant', call('shell_command', 'cat a.log | grep ERR')),
      msg('tool', result('shell_command', big)),
      msg('assistant', call('read', '{"filePath":"/b"}')),
      msg('tool', result('read', 'short file')),
      msg('assistant', call('read_file', '{"path":"/c"}')),
      msg('tool', result('read_file', `[error] ${big}`)),
    ]);
    expect(out[1]!.parts[0]).toMatchObject({ text: FILE_READ_STUB, truncated: true, originalChars: big.length });
    expect(out[3]!.parts[0]!.text).toBe(FILE_READ_STUB);
    expect(out[5]!.parts[0]!.text).not.toBe(FILE_READ_STUB);
    expect(out[7]!.parts[0]!.text).toBe('short file');
    expect(out[9]!.parts[0]!.text).not.toBe(FILE_READ_STUB);
  });

  it('collapses consecutive identical tool calls, keeping the last with its result', () => {
    n = 0;
    const out = filterMessages([
      msg('user', text('run tests')),
      msg('assistant', call('Bash', 'npm test')),
      msg('tool', result('Bash', 'fail 1')),
      msg('assistant', call('Bash', 'npm test')),
      msg('tool', result('Bash', 'fail 2')),
      msg('assistant', call('Bash', 'npm test')),
      msg('tool', result('Bash', 'fail 3')),
      msg('assistant', text('fixing'), call('Bash', 'npm test')),
      msg('tool', result('Bash', 'pass')),
    ]);
    expect(out.map((m) => m.idx)).toEqual([0, 5, 6, 7, 8]);
    expect(out[1]!.parts[0]!.text).toBe('npm test (repeated ×3)');
    expect(textOf(out[2])).toBe('fail 3');
    expect(out[3]!.parts[1]!.text).toBe('npm test'); // separated by text → not a repeat
  });

  it('does not collapse different args or calls separated by a user turn', () => {
    n = 0;
    const out = filterMessages([
      msg('assistant', call('Bash', 'npm test')),
      msg('tool', result('Bash', 'x')),
      msg('assistant', call('Bash', 'npm test -- --watch')),
      msg('tool', result('Bash', 'y')),
      msg('user', text('again')),
      msg('assistant', call('Bash', 'npm test -- --watch')),
    ]);
    expect(out).toHaveLength(6);
  });

  it('stubs huge system context, truncates huge tool args, drops empty messages', () => {
    n = 0;
    const out = filterMessages([
      msg('system', text('S'.repeat(5000))),
      msg('system', text('short system note')),
      msg('assistant', call('Write', 'W'.repeat(3000))),
      msg('user', text('   ')),
      msg('assistant', { kind: 'reasoning', text: 'only thinking' }),
    ]);
    expect(out.map((m) => m.idx)).toEqual([0, 1, 2]);
    expect(out[0]!.parts[0]).toMatchObject({ text: '[system context omitted: 5000 chars]', truncated: true, originalChars: 5000 });
    expect(textOf(out[1])).toBe('short system note');
    expect(out[2]!.parts[0]!.truncated).toBe(true);
    expect(out[2]!.parts[0]!.text.length).toBeLessThan(1100);
  });

  it('headTail leaves short text alone', () => {
    expect(headTail('abc', 10)).toBe('abc');
  });
});

describe('filterMessages on the planted-error fixture', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ home, cleanup } = await copyFixture('claude-code')));
  afterAll(() => cleanup());

  it('keeps the story but drops the package.json body and the repeated test run', async () => {
    const raw = await new ClaudeCodeAdapter({ homeDir: path.join(home) }).readSession(IDS.claude.main);
    const out = filterMessages(raw);
    expect(findMsg(out, STORY.wrongClaim)).toBeDefined();
    expect(findMsg(out, 'listening on :5173')).toBeDefined();
    expect(findMsg(out, STORY.correction)).toBeDefined();
    expect(findMsg(out, '"vitest"')).toBeUndefined();
    expect(findMsg(out, FILE_READ_STUB)?.idx).toBe(3);
    expect(out.some((m) => m.parts.some((p) => p.kind === 'reasoning'))).toBe(false);
    expect(findMsg(out, 'npm test (repeated ×2)')?.idx).toBe(14);
    expect(out.find((m) => m.idx === 12)).toBeUndefined();
    expect(out.find((m) => m.idx === 13)).toBeUndefined();
    // idx are a subset of the raw ones and still point at the same messages.
    for (const m of out) expect(raw[m.idx]!.role).toBe(m.role);
  });
});

describe('filterMessages: dream traffic', () => {
  const stubAt = (out: TranscriptMessage[], idx: number): boolean => out.some((m) => m.idx === idx && textOf(m) === DREAM_RUN_STUB);

  it('collapses a dream run started by the MCP prompt (Claude Code mcp__agent-dream__ tool names)', () => {
    n = 0;
    const msgs = [
      msg('user', text('The dev server port is 5173.')), // 0
      msg('assistant', text('Noted.')), // 1
      msg('user', text(`${DREAM_PROMPT_FIRST_LINE}\nFollow the loop…`)), // 2
      msg('assistant', call('mcp__agent-dream__dream_begin', '{}')), // 3
      msg('tool', result('mcp__agent-dream__dream_begin', '{"status":"step","input":"<untrusted-transcript …> port 3000 …"}')), // 4
      msg('assistant', text('Extracting…'), call('mcp__agent-dream__dream_step', '{"job_id":"j"}')), // 5
      msg('tool', result('mcp__agent-dream__dream_step', 'ok')), // 6
      msg('assistant', call('mcp__agent-dream__dream_commit', '{"job_id":"j"}')), // 7
      msg('tool', result('mcp__agent-dream__dream_commit', 'Memory saved.')), // 8
      msg('assistant', text('Memory saved. You can now /compact.')), // 9
      msg('user', text('Next: add a login page.')), // 10
      msg('assistant', text('On it.')), // 11
    ];
    const out = filterMessages(msgs);
    expect(out.map((m) => m.idx)).toEqual([0, 1, 2, 10, 11]);
    expect(stubAt(out, 2)).toBe(true);
    expect(out.find((m) => m.idx === 2)!.parts).toEqual([{ kind: 'other', text: DREAM_RUN_STUB }]);
    expect(filterMessages(msgs, { keepDreamTraffic: true }).map((m) => m.idx)).toEqual(msgs.map((m) => m.idx));
    expect(msgs[2]!.parts[0]!.kind).toBe('text'); // input untouched
  });

  it('collapses opencode Code Mode `execute` calls and includes a plain "run a dream" request', () => {
    n = 0;
    const msgs = [
      msg('user', text('Fix the header test.')), // 0
      msg('assistant', call('bash', 'npm test')), // 1
      msg('tool', result('bash', 'Tests: 5 passed')), // 2
      msg('user', text('great, run a dream')), // 3
      msg('system', text('<system-reminder>x</system-reminder>')), // 4
      msg('assistant', text('Starting.'), call('execute', 'const r = await tools["agent-dream"].dream_begin({}); return r;')), // 5
      msg('tool', result('execute', '{"jobId":"j"}')), // 6
      msg('assistant', call('execute', 'return await dream_step({ job_id: "j", output })')), // 7
      msg('tool', result('execute', 'ok')), // 8
      msg('user', text(`${RESUME_PROMPT_FIRST_LINE}`)), // 9 (prompt: span continues)
      msg('assistant', call('execute', 'return await dream_commit({ job_id: "j" })')), // 10
      msg('tool', result('execute', 'saved')), // 11
      msg('user', text('thanks')), // 12
    ];
    const out = filterMessages(msgs);
    expect(out.map((m) => m.idx)).toEqual([0, 1, 2, 3, 12]);
    expect(stubAt(out, 3)).toBe(true);
  });

  it('does not take the user message when the turn did other work before dreaming, and ignores mere mentions', () => {
    n = 0;
    const msgs = [
      msg('user', text('no, the port is 5173 — fix the config and then dream')), // 0
      msg('assistant', call('Edit', '{"file":"vite.config.ts","new":"port: 5173"}')), // 1
      msg('tool', result('Edit', 'ok')), // 2
      msg('assistant', call('dream_begin', '{}')), // 3
      msg('tool', result('dream_begin', 'step')), // 4
      msg('user', text('ok')), // 5
      msg('assistant', call('Bash', 'grep -rn "dream_begin(" src')), // 6: a grep is not a dream call
      msg('tool', result('Bash', 'src/x.ts: dream_begin(')), // 7
      msg('assistant', call('Write', '{"content":"await tools[\\"agent-dream\\"].dream_step()"}')), // 8
    ];
    const out = filterMessages(msgs);
    expect(out.map((m) => m.idx)).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(stubAt(out, 3)).toBe(true);
  });

  it('isDreamTraffic flags single messages for the engine', () => {
    n = 0;
    expect(isDreamTraffic(msg('user', text(`  ${DREAM_PROMPT_FIRST_LINE}`)))).toBe(true);
    expect(isDreamTraffic(msg('system', text(RESUME_PROMPT_FIRST_LINE)))).toBe(true);
    expect(isDreamTraffic(msg('assistant', call('mcp__agent-dream__dream_step', '{}')))).toBe(true);
    expect(isDreamTraffic(msg('assistant', call('agent-dream_dream_review', '{}')))).toBe(true);
    expect(isDreamTraffic(msg('assistant', call('execute', 'tools["agent-dream"].dream_rollback()')))).toBe(true);
    expect(isDreamTraffic(msg('tool', result('mcp__agent-dream__dream_commit', 'saved')))).toBe(true);
    expect(isDreamTraffic(msg('assistant', call('mcp__agent-dream__memory_index', '{}')))).toBe(false);
    expect(isDreamTraffic(msg('assistant', call('my_dream_step_helper', '{}')))).toBe(false);
    expect(isDreamTraffic(msg('assistant', call('Bash', 'echo dream_begin(')))).toBe(false);
    expect(isDreamTraffic(msg('user', text('please run a dream')))).toBe(false);
  });
});
