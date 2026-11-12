/**
 * End-to-end: spawn the BUILT bundle (packages/server/dist/agent-dream.js) over real stdio and talk MCP to it.
 * Uses a synthetic HOME with a synthetic Claude Code transcript, so no real user data is read.
 * Requires `npm run build` first (`npm run check` builds before testing).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, '../../dist/agent-dream.js');

type TextResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
const textOf = (r: unknown): string =>
  ((r as TextResult).content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');

describe.skipIf(!fs.existsSync(bundle))('built bundle over stdio', () => {
  let tmp: string;
  let project: string;
  let home: string;
  let client: Client;
  const sessionId = '11111111-2222-3333-4444-555555555555';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dream-e2e-'));
    project = path.join(tmp, 'proj');
    home = path.join(tmp, 'home');
    fs.mkdirSync(project, { recursive: true });
    const slug = project.replace(/[:\\/.]/g, '-');
    const dir = path.join(home, '.claude', 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now() - 60_000;
    const rec = (i: number, role: 'user' | 'assistant', text: string) =>
      JSON.stringify({
        type: role,
        uuid: `u-${i}`,
        parentUuid: i ? `u-${i - 1}` : null,
        isSidechain: false,
        sessionId,
        cwd: project,
        timestamp: new Date(t0 + i * 1000).toISOString(),
        message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
      });
    fs.writeFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      [
        rec(0, 'user', 'Start the dev server please.'),
        rec(1, 'assistant', 'Started it. The dev server listens on port 3000.'),
        rec(2, 'user', "No, that's wrong: it is listening on :5173, it's Vite."),
        rec(3, 'assistant', 'Right, the dev server port is 5173.'),
      ].join('\n') + '\n',
    );

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { HOME: home, USERPROFILE: home, AGENT_DREAM_PROJECT: project });
    delete env.CLAUDE_PROJECT_DIR;

    const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], env, stderr: 'pipe' });
    client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exposes the full tool, prompt and resource surface', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        'dream_begin',
        'dream_commit',
        'dream_review',
        'dream_rollback',
        'dream_sessions',
        'dream_step',
        'memory_index',
        'memory_note',
        'memory_read',
        'memory_search',
        'memory_status',
      ].sort(),
    );
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['dream', 'resume']);
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(50);
    expect(instructions.length).toBeLessThanOrEqual(4096);
    expect(instructions.slice(0, 512)).toMatch(/memory_index/);
  });

  it('finds the synthetic session through the Claude Code adapter', async () => {
    const r = await client.callTool({ name: 'dream_sessions', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(sessionId);
  });

  it('starts a dream whose first step carries instructions, untrusted transcript input and a schema', async () => {
    const r = await client.callTool({
      name: 'dream_begin',
      arguments: { harness: 'claude-code', session: sessionId, scope: 'thread' },
    });
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toMatch(/dream_step/);
    expect(text).toContain('<untrusted-transcript');
    expect(text).toContain('5173');
    expect(text.toLowerCase()).toContain('schema');
    const jobId = /job[_ ]?id["\s:=]+["']?([A-Za-z0-9_-]{6,})/i.exec(text)?.[1];
    expect(jobId).toBeTruthy();

    // A malformed submission is rejected and the same step is repeated, without crashing the server.
    const bad = await client.callTool({ name: 'dream_step', arguments: { job_id: jobId!, output: { nonsense: true } } });
    expect(textOf(bad).toLowerCase()).toMatch(/reject|invalid/);

    const status = await client.callTool({ name: 'memory_status', arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(textOf(status)).toContain(jobId!);
  });

  it('notes, index and errors behave over the wire', async () => {
    const note = await client.callTool({ name: 'memory_note', arguments: { text: 'Tests need the db container up.' } });
    expect(note.isError).toBeFalsy();
    const idx = await client.callTool({ name: 'memory_index', arguments: {} });
    expect(textOf(idx)).toMatch(/Memory index/i);
    const missing = await client.callTool({ name: 'memory_read', arguments: { name: 'no-such-page' } });
    expect(missing.isError).toBe(true);
    // Memory stays inside <project>/.dream
    expect(fs.existsSync(path.join(project, '.dream', 'MEMORY.md'))).toBe(true);
    expect(fs.readdirSync(project).filter((f) => f !== '.dream' && f !== '.gitignore')).toEqual([]);
  });
});
