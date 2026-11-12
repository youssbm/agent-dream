import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/transcripts/claude-code.ts';
import { DreamError } from '../../src/types.ts';
import { IDS, STORY, copyFixture, findMsg, setMtime, textOf } from './helpers.ts';

const PROJ = '-home-dev-projects-demo-app';

describe('ClaudeCodeAdapter', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let adapter: ClaudeCodeAdapter;
  const file = (id: string, proj = PROJ): string => path.join(home, '.claude', 'projects', proj, `${id}.jsonl`);

  beforeAll(async () => {
    ({ home, cleanup } = await copyFixture('claude-code'));
    await setMtime(file(IDS.claude.main), '2026-05-01T09:20:00Z');
    await setMtime(file(IDS.claude.older), '2026-04-28T08:01:00Z');
    await setMtime(file(IDS.claude.other, '-home-dev-projects-other-app'), '2026-05-02T00:00:00Z');
    await setMtime(file(IDS.claude.empty), '2026-05-03T00:00:00Z');
    adapter = new ClaudeCodeAdapter({ homeDir: home });
  });
  afterAll(() => cleanup());

  it('is available only when the projects dir exists', async () => {
    expect(await adapter.available()).toBe(true);
    expect(await new ClaudeCodeAdapter({ homeDir: path.join(home, 'nope') }).available()).toBe(false);
    expect(await new ClaudeCodeAdapter({ homeDir: path.join(home, 'nope') }).listSessions()).toEqual([]);
  });

  it('lists sessions newest first, skipping bookkeeping-only files and subagent files', async () => {
    const all = await adapter.listSessions();
    expect(all.map((s) => s.id)).toEqual([IDS.claude.other, IDS.claude.main, IDS.claude.older]);
    const main = all.find((s) => s.id === IDS.claude.main)!;
    expect(main).toMatchObject({
      harness: 'claude-code',
      cwd: STORY.cwd,
      title: 'Dev server port setup',
      updatedAt: '2026-05-01T09:20:00.000Z',
      startedAt: '2026-05-01T09:01:00.000Z',
    });
    expect(main.location).toBe(file(IDS.claude.main));
    expect(all.find((s) => s.id === IDS.claude.older)?.title).toBe('Initial scaffolding');
  });

  it('filters by cwd, since and limit', async () => {
    const mine = await adapter.listSessions({ cwd: STORY.cwd + '/' });
    expect(mine.map((s) => s.id)).toEqual([IDS.claude.main, IDS.claude.older]);
    expect((await adapter.listSessions({ cwd: STORY.cwd, since: '2026-04-30T00:00:00Z' })).map((s) => s.id)).toEqual([IDS.claude.main]);
    expect((await adapter.listSessions({ limit: 1 })).map((s) => s.id)).toEqual([IDS.claude.other]);
    expect(await adapter.listSessions({ cwd: '/somewhere/else' })).toEqual([]);
  });

  it('normalizes the main thread (sidechains excluded, blocks merged, tool results as role tool)', async () => {
    const msgs = await adapter.readSession(IDS.claude.main);
    expect(msgs.map((m) => m.idx)).toEqual(msgs.map((_, i) => i));
    expect(msgs.every((m) => m.harness === 'claude-code' && m.session === IDS.claude.main)).toBe(true);
    expect(msgs.map((m) => m.role)).toEqual([
      'user', 'system', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user',
      'assistant', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'system', 'user', 'assistant',
    ]);
    expect(msgs.some((m) => textOf(m).includes('SIDECHAIN'))).toBe(false);
    // Three assistant records with the same message id → one message with reasoning, text, tool call.
    expect(msgs[2]!.parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(msgs[2]!.parts[2]).toMatchObject({ tool: 'Read', text: JSON.stringify({ file_path: `${STORY.cwd}/package.json` }) });
    expect(msgs[3]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'Read', text: STORY.packageJson });
    expect(msgs[6]!.parts[0]).toMatchObject({ kind: 'tool_call', tool: 'Bash', text: 'npm run dev' });
    expect(msgs[7]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'Bash', text: STORY.devOutput });
    expect(textOf(msgs[9])).toBe(STORY.correction);
    expect(textOf(msgs[10])).toBe(STORY.ack); // U+2028 inside JSON survives line splitting
    expect(textOf(msgs[13]).startsWith('[error] FAIL')).toBe(true);
    // Mixed user record: injected reminder → system, typed text → user.
    expect(textOf(msgs[17])).toContain('<system-reminder>');
    expect(textOf(msgs[18])).toBe(STORY.pnpm);
    expect(msgs[0]!.ts).toBe('2026-05-01T09:01:00.000Z');
  });

  it('can include sidechains on request', async () => {
    const msgs = await new ClaudeCodeAdapter({ homeDir: home, includeSidechains: true }).readSession(IDS.claude.main);
    expect(findMsg(msgs, 'SIDECHAIN: explore')).toBeDefined();
  });

  it('throws SESSION_NOT_FOUND for unknown or unsafe ids', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', '../etc/passwd', '']) {
      await expect(adapter.readSession(id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    }
    await expect(adapter.readSession('nope')).rejects.toBeInstanceOf(DreamError);
  });

  it('handles CRLF line endings', async () => {
    const f = file(IDS.claude.older);
    const crlf = (await fsp.readFile(f, 'utf8')).replace(/\n/g, '\r\n');
    const id = 'c0de0001-0000-4000-8000-0000000000cr';
    await fsp.writeFile(file(id), crlf);
    const msgs = await adapter.readSession(id);
    expect(msgs.map((m) => textOf(m))).toEqual(['Scaffold a Vite + React app.', 'Scaffolded with `npm create vite@latest`.']);
    await fsp.rm(file(id));
  });

  it('reads cwd beyond bookkeeping-only heads and the newest title from the tail', async () => {
    const id = 'c0de0001-0000-4000-8000-0000000000bb';
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) lines.push(JSON.stringify({ type: 'file-history-snapshot', messageId: `m${i}`, snapshot: { pad: 'x'.repeat(2000) } }));
    lines.push(JSON.stringify({ type: 'user', cwd: '/home/dev/projects/big', sessionId: id, timestamp: '2026-05-05T00:00:00Z', message: { role: 'user', content: 'hi' } }));
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: 'first' }));
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: 'second' }));
    await fsp.writeFile(file(id), lines.join('\n') + '\n');
    // The cwd sits past the head window; it is picked up from the tail, as is the newest title.
    const found = await adapter.listSessions({ cwd: '/home/dev/projects/big' });
    expect(found.map((s) => [s.id, s.title, s.cwd])).toEqual([[id, 'second', '/home/dev/projects/big']]);
    await fsp.rm(file(id));
  });
});
