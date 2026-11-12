/**
 * Full dream over real stdio against the BUILT bundle, driven by the bench's scripted oracle through a proxy that
 * only sees the text a model would see (wire-proxy.ts). Planted-error story (PLAN §9 #1): memory says the dev server
 * runs on port 3000, the transcript shows the user correcting it to 5173.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '@agent-dream/core';
import { drive, writeTarget, verifyPages } from '../../../bench/src/oracle.ts';
import { WireDreamService } from './wire-proxy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, '../../dist/agent-dream.js');
const SESSION = '99999999-8888-7777-6666-555555555555';
const SOURCE = { harness: 'claude-code' as const, session: SESSION };

describe.skipIf(!fs.existsSync(bundle))('full dream over stdio (planted error)', () => {
  let tmp: string;
  let project: string;
  let client: Client;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dream-wire-'));
    project = path.join(tmp, 'proj');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(project, { recursive: true });

    // Synthetic Claude Code transcript.
    const dir = path.join(home, '.claude', 'projects', project.replace(/[:\\/.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now() - 120_000;
    const rec = (i: number, role: 'user' | 'assistant', text: string) =>
      JSON.stringify({
        type: role,
        uuid: `w-${i}`,
        parentUuid: i ? `w-${i - 1}` : null,
        isSidechain: false,
        sessionId: SESSION,
        cwd: project,
        timestamp: new Date(t0 + i * 1000).toISOString(),
        message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
      });
    fs.writeFileSync(
      path.join(dir, `${SESSION}.jsonl`),
      [
        rec(0, 'user', 'Start the dev server please.'),
        rec(1, 'assistant', 'Started it. The dev server listens on port 3000.'),
        rec(2, 'user', "No, that's wrong: it is listening on :5173, it's Vite."),
        rec(3, 'assistant', 'Right, the dev server port is 5173.'),
      ].join('\n') + '\n',
    );

    // Pre-existing (wrong) memory page.
    const store = new MemoryStore(project);
    await store.init();
    await store.applyChanges(
      [
        {
          type: 'write',
          path: 'pages/dev-server.md',
          content: store.serializePage({
            name: 'dev-server',
            meta: {
              title: 'Dev server',
              kind: 'fact',
              volatile: true,
              confidence: 'unverified',
              sources: [{ ...SOURCE, msgs: '1' }],
              links: [],
            },
            body: 'The dev server listens on port 3000.\n',
          }),
        },
      ],
      'seed wrong page',
    );

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { HOME: home, USERPROFILE: home, AGENT_DREAM_PROJECT: project });
    delete env.CLAUDE_PROJECT_DIR;
    client = new Client({ name: 'e2e-dream', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle], env, stderr: 'pipe' }));
  });

  afterAll(async () => {
    await client?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('corrects the planted error end to end, rejecting a hallucinated quote on the way', async () => {
    const svc = new WireDreamService(client);
    const result = await drive(
      svc,
      {
        extract: () => ({
          claims: [{ text: 'The dev server (Vite) listens on port 5173.', kind: 'fact', sources: [{ ...SOURCE, msgs: '2-3' }] }],
        }),
        verify: (c) => ({
          verdicts: verifyPages(c.step).map((page) =>
            page === 'dev-server'
              ? {
                  page,
                  verdict: 'correct',
                  // First attempt: a quote that is NOT in the transcript → must be rejected by the server.
                  evidence: {
                    quote: c.attempt === 0 ? 'the port was changed to 5173 in vite.config.ts' : 'it is listening on :5173',
                    source: { ...SOURCE, msgs: '2' },
                  },
                  corrected: 'The dev server (Vite) listens on port 5173.',
                }
              : { page, verdict: 'keep' },
          ),
        }),
        outline: () => ({ targets: [{ page: 'dev-server', op: 'update', reason: 'port corrected by the user' }] }),
        write_page: (c) => {
          const t = writeTarget(c.step);
          return {
            op: {
              op: t.op,
              page: t.page,
              body: 'The dev server is Vite and listens on port `5173` (not 3000).\n',
              meta: { title: 'Dev server', kind: 'fact', volatile: true },
              sources: [{ ...SOURCE, msgs: '2-3' }],
              reason: 'user correction',
            },
          };
        },
      },
      { begin: { harness: 'claude-code', session: SESSION, scope: 'thread' } },
    );

    expect(result.rejections.length).toBe(1);
    expect(result.rejections[0]?.name).toBe('verify');
    expect(result.commit?.outcome).toBe('applied');
    const corr = result.commit?.summary.corrections.find((c) => c.page === 'dev-server');
    expect(corr?.verdict).toBe('correct');
    expect(corr?.quote).toBe('it is listening on :5173');

    const page = fs.readFileSync(path.join(project, '.dream', 'pages', 'dev-server.md'), 'utf8');
    expect(page).toContain('5173');
    expect(page).not.toMatch(/listens on port 3000\./);
    const index = fs.readFileSync(path.join(project, '.dream', 'MEMORY.md'), 'utf8');
    expect(index).toContain('[[dev-server]]');
    expect(fs.readdirSync(path.join(project, '.dream', 'threads')).some((f) => f.startsWith('thread-claude-code-'))).toBe(true);

    // The corrected fact is findable by the next session.
    const hits = await svc.memorySearch('dev server port');
    expect(hits[0]?.ref).toBe('dev-server');
    expect(await svc.memoryRead('dev-server')).toContain('5173');

    // A second dream finds nothing new to do.
    const again = await svc.dreamBegin({ harness: 'claude-code', session: SESSION, scope: 'thread' });
    expect(['done', 'step']).toContain(again.status);
  });
});
