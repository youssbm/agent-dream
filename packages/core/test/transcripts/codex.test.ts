import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAdapter, clearCodexHeadCache } from '../../src/transcripts/codex.ts';
import { zstdSupported } from '../../src/transcripts/lines.ts';
import { IDS, STORY, copyFixture, findMsg, setMtime, textOf } from './helpers.ts';

describe('CodexAdapter', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let adapter: CodexAdapter;
  const sessions = (): string => path.join(home, '.codex', 'sessions');
  const mainFile = (): string => path.join(sessions(), '2026', '05', '01', `rollout-2026-05-01T10-00-00-${IDS.codex.main}.jsonl`);

  beforeAll(async () => {
    ({ home, cleanup } = await copyFixture('codex'));
    clearCodexHeadCache();
    await setMtime(mainFile(), '2026-05-01T09:16:00Z');
    await setMtime(path.join(sessions(), '2026', '05', '01', `rollout-2026-05-01T10-05-00-${IDS.codex.subagent}.jsonl`), '2026-05-01T09:30:00Z');
    await setMtime(path.join(sessions(), '2026', '04', '20', `rollout-2026-04-20T08-00-00-${IDS.codex.windows}.jsonl`), '2026-04-20T08:10:00Z');
    await setMtime(path.join(home, '.codex', 'archived_sessions', `rollout-2026-04-01T08-00-00-${IDS.codex.archived}.jsonl`), '2026-04-01T08:10:00Z');
    adapter = new CodexAdapter({ homeDir: home });
  });
  afterAll(() => cleanup());

  it('is available when sessions exist', async () => {
    expect(await adapter.available()).toBe(true);
    expect(await new CodexAdapter({ homeDir: path.join(home, 'none') }).available()).toBe(false);
    expect(await new CodexAdapter({ homeDir: path.join(home, 'none') }).listSessions()).toEqual([]);
  });

  it('lists sessions (incl. archived) newest first, excluding subagent threads', async () => {
    const all = await adapter.listSessions();
    expect(all.map((s) => s.id)).toEqual([IDS.codex.main, IDS.codex.windows, IDS.codex.archived]);
    expect(all[0]).toMatchObject({
      harness: 'codex',
      cwd: STORY.cwd,
      title: 'Dev server port setup',
      startedAt: '2026-05-01T09:00:00.000Z',
      updatedAt: '2026-05-01T09:16:00.000Z',
    });
    const withSubs = await new CodexAdapter({ homeDir: home, includeSubagents: true }).listSessions();
    expect(withSubs.map((s) => s.id)).toContain(IDS.codex.subagent);
  });

  it('filters by cwd (Windows paths case-insensitively), since and limit', async () => {
    expect((await adapter.listSessions({ cwd: STORY.cwd })).map((s) => s.id)).toEqual([IDS.codex.main]);
    expect((await adapter.listSessions({ cwd: 'c:/users/dev/projects/demo-app/' })).map((s) => s.id)).toEqual([IDS.codex.windows]);
    expect((await adapter.listSessions({ cwd: '\\\\?\\C:\\USERS\\dev\\Projects\\Demo-App' })).map((s) => s.id)).toEqual([IDS.codex.windows]);
    expect((await adapter.listSessions({ since: '2026-04-15T00:00:00Z' })).map((s) => s.id)).toEqual([IDS.codex.main, IDS.codex.windows]);
    expect((await adapter.listSessions({ limit: 2 })).map((s) => s.id)).toEqual([IDS.codex.main, IDS.codex.windows]);
  });

  it('normalizes response items and skips everything else', async () => {
    const msgs = await adapter.readSession(IDS.codex.main);
    expect(msgs.map((m) => m.idx)).toEqual(msgs.map((_, i) => i));
    expect(msgs.map((m) => m.role)).toEqual([
      'system', 'system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant',
      'user', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant',
    ]);
    expect(textOf(msgs[0])).toContain('<permissions instructions>');
    expect(textOf(msgs[1])).toContain('<environment_context>');
    expect(textOf(msgs[2])).toBe(STORY.ask);
    expect(msgs[3]!.parts).toEqual([
      { kind: 'text', text: STORY.check },
      { kind: 'tool_call', tool: 'shell_command', text: 'cat package.json' },
    ]);
    expect(msgs[4]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'shell_command', text: STORY.packageJson });
    expect(msgs[8]!.parts[0]).toMatchObject({ kind: 'tool_result', text: STORY.devOutput });
    expect(textOf(msgs[11])).toBe(STORY.ack);
    expect(msgs[13]!.parts[0]).toMatchObject({ kind: 'tool_call', tool: 'local_shell', text: 'npm test' });
    expect(msgs[14]!.parts[0]!.text).toMatch(/Tests: 1 failed[\s\S]*\[exit code 1\]$/);
    expect(msgs[15]!.parts[0]).toMatchObject({ kind: 'tool_call', tool: 'apply_patch' });
    expect(msgs[17]!.parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(msgs[17]!.parts[2]).toMatchObject({ tool: 'web_search', text: 'vite default dev server port' });
    expect(msgs.some((m) => textOf(m).includes('gAAAA'))).toBe(false);
    expect(msgs[2]!.ts).toBe('2026-05-01T09:01:00.000Z');
  });

  it('reads subagent threads directly, mapping inter-agent messages to tool results', async () => {
    const msgs = await adapter.readSession(IDS.codex.subagent);
    expect(findMsg(msgs, 'Header renders')?.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'agent:Scout' });
  });

  it('throws SESSION_NOT_FOUND for unknown ids', async () => {
    await expect(adapter.readSession('11111111-2222-4333-8444-555555555555')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(adapter.readSession('../../x')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it.runIf(zstdSupported())('reads zstd-compressed rollouts', async () => {
    const src = path.join(sessions(), '2026', '04', '20', `rollout-2026-04-20T08-00-00-${IDS.codex.windows}.jsonl`);
    const id = '0c0d0e00-0000-4000-8000-0000000000aa';
    const dest = path.join(sessions(), '2026', '04', '21', `rollout-2026-04-21T08-00-00-${id}.jsonl.zst`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const text = (await fsp.readFile(src, 'utf8')).replaceAll(IDS.codex.windows, id);
    const compress = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
    await fsp.writeFile(dest, compress(Buffer.from(text)));
    await setMtime(dest, '2026-04-21T08:10:00Z');
    const fresh = new CodexAdapter({ homeDir: home });
    const listed = await fresh.listSessions({ cwd: 'C:\\Users\\Dev\\Projects\\Demo-App' });
    expect(listed.map((s) => s.id)).toEqual([id, IDS.codex.windows]);
    const msgs = await fresh.readSession(id);
    expect(msgs.map((m) => textOf(m))).toEqual(['Windows session: list the files.', 'Listed.']);
    await fsp.rm(dest);
  });

  it('understands the legacy rollout format', async () => {
    const id = '0c0d0e00-0000-4000-8000-0000000000bb';
    const dest = path.join(sessions(), '2025', '01', '01', `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const lines = [
      { id, timestamp: '2025-01-01T00:00:00Z', instructions: null },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy hello' }] },
      { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: '{"output":"a\\nb","metadata":{"exit_code":0}}' },
    ];
    await fsp.writeFile(dest, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const fresh = new CodexAdapter({ homeDir: home });
    const msgs = await fresh.readSession(id);
    expect(msgs.map((m) => [m.role, textOf(m)])).toEqual([
      ['user', 'legacy hello'],
      ['assistant', 'ls'],
      ['tool', 'a\nb'],
    ]);
    expect((await fresh.listSessions()).find((s) => s.id === id)?.cwd).toBeUndefined();
    await fsp.rm(dest);
  });
});
