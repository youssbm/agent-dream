import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DreamError } from '../../../core/src/types.ts';
import {
  createDreamServer,
  dreamPromptText,
  FALLBACK_INSTRUCTIONS,
  indexLinks,
  loadInstructions,
} from '../../src/server.ts';
import { COMMIT_RESULT, FakeService } from './fake-service.ts';

const TOOLS = [
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
];

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

async function connect(service = new FakeService(), instructions?: string) {
  const server = createDreamServer(service, { version: '9.9.9', ...(instructions ? { instructions } : {}) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, service };
}

function text(r: unknown): string {
  const res = r as CallToolResult;
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('server metadata', () => {
  it('announces name, version and instructions', async () => {
    const { client } = await connect(new FakeService(), 'HELLO INSTRUCTIONS');
    expect(client.getServerVersion()).toMatchObject({ name: 'agent-dream', version: '9.9.9' });
    expect(client.getInstructions()).toBe('HELLO INSTRUCTIONS');
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, prompts: {}, resources: {} });
  });

  it('uses the fallback instructions when none are given', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toBe(FALLBACK_INSTRUCTIONS);
  });

  it('loadInstructions falls back when the service throws, returns empty, or hangs', async () => {
    const s = new FakeService();
    expect(await loadInstructions(s)).toBe('INSTRUCTIONS FROM SERVICE');
    s.instructions = async () => {
      throw new DreamError('HISTORY', 'boom');
    };
    expect(await loadInstructions(s)).toBe(FALLBACK_INSTRUCTIONS);
    s.instructions = async () => '   ';
    expect(await loadInstructions(s)).toBe(FALLBACK_INSTRUCTIONS);
    s.instructions = () => new Promise<string>(() => {});
    expect(await loadInstructions(s, 20)).toBe(FALLBACK_INSTRUCTIONS);
  });
});

describe('tools', () => {
  it('lists exactly the expected tools with schemas and annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));

    const props = (n: string) => Object.keys((by[n]?.inputSchema.properties ?? {}) as object).sort();
    const req = (n: string) => [...((by[n]?.inputSchema.required ?? []) as string[])].sort();
    expect(props('memory_index')).toEqual([]);
    expect(props('memory_search')).toEqual(['include_transcripts', 'limit', 'query']);
    expect(req('memory_search')).toEqual(['query']);
    expect(props('memory_read')).toEqual(['name']);
    expect(props('memory_note')).toEqual(['harness', 'session', 'text']);
    expect(req('memory_note')).toEqual(['text']);
    expect(props('memory_status')).toEqual([]);
    expect(props('dream_sessions')).toEqual(['harness', 'limit']);
    expect(props('dream_begin')).toEqual(['confirm', 'dry_run', 'harness', 'resume', 'scope', 'session', 'since']);
    expect(req('dream_begin')).toEqual([]);
    expect(props('dream_step')).toEqual(['job_id', 'output']);
    expect(req('dream_step')).toEqual(['job_id', 'output']);
    expect(props('dream_commit')).toEqual(['job_id']);
    expect(props('dream_review')).toEqual(['action', 'job_id']);
    expect(req('dream_review')).toEqual(['action']);
    expect(props('dream_rollback')).toEqual(['run_id']);

    const stepOutput = (by.dream_step?.inputSchema.properties as Record<string, Record<string, unknown>>).output;
    const variants = ((stepOutput?.anyOf ?? []) as { type?: string }[]).map((v) => v.type).sort();
    expect(variants).toEqual(['object', 'string']);
    const harness = (by.dream_begin?.inputSchema.properties as Record<string, Record<string, unknown>>).harness;
    expect(harness?.enum).toEqual(['claude-code', 'codex', 'opencode']);

    for (const n of ['memory_index', 'memory_search', 'memory_read', 'memory_status', 'dream_sessions']) {
      expect(by[n]?.annotations?.readOnlyHint, n).toBe(true);
    }
    expect(by.dream_rollback?.annotations?.destructiveHint).toBe(true);
    expect(by.dream_step?.annotations?.readOnlyHint).toBe(false);

    for (const n of ['dream_begin', 'dream_step']) {
      const d = by[n]?.description ?? '';
      expect(d.length, `${n} description length`).toBeLessThanOrEqual(900);
      expect(d).toContain('dream_step');
      expect(d).toContain('dream_commit');
      expect(d).toContain('ready_to_commit');
      expect(d).toContain('untrusted-transcript');
    }
    expect(by.dream_begin?.description).toContain('needs_confirmation');
  });

  it('memory_index returns the index text', async () => {
    const { client, service } = await connect();
    const r = await client.callTool({ name: 'memory_index', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('[[dev-server]]');
    service.index = '';
    expect(text(await client.callTool({ name: 'memory_index', arguments: {} }))).toContain('empty');
  });

  it('memory_search maps args and returns hits as JSON + structuredContent', async () => {
    const { client, service } = await connect();
    const r = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'port', include_transcripts: true, limit: 5 },
    });
    expect(service.last('memorySearch')).toEqual(['port', { includeTranscripts: true, limit: 5 }]);
    expect(text(r)).toContain('"ref": "dev-server"');
    expect((r.structuredContent as { hits: unknown[] }).hits).toHaveLength(1);

    await client.callTool({ name: 'memory_search', arguments: { query: 'x' } });
    expect(service.last('memorySearch')).toEqual(['x', {}]);
  });

  it('memory_read returns markdown, and isError for a missing page', async () => {
    const { client, service } = await connect();
    const r = await client.callTool({ name: 'memory_read', arguments: { name: 'dev-server' } });
    expect(service.last('memoryRead')).toEqual(['dev-server']);
    expect(text(r)).toContain('Port 5173.');
    const miss = await client.callTool({ name: 'memory_read', arguments: { name: 'nope' } });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toContain('nope');
  });

  it('memory_note maps text and source', async () => {
    const { client, service } = await connect();
    await client.callTool({ name: 'memory_note', arguments: { text: 'Use pnpm.' } });
    expect(service.last('memoryNote')).toEqual(['Use pnpm.', undefined]);
    const r = await client.callTool({
      name: 'memory_note',
      arguments: { text: 'Use pnpm.', harness: 'codex', session: 's1' },
    });
    expect(service.last('memoryNote')).toEqual(['Use pnpm.', { harness: 'codex', session: 's1' }]);
    expect(r.structuredContent).toMatchObject({ id: 'n1', text: 'Use pnpm.' });
  });

  it('memory_status and dream_sessions', async () => {
    const { client, service } = await connect();
    const st = await client.callTool({ name: 'memory_status', arguments: {} });
    expect(st.structuredContent).toMatchObject({ pageCount: 2, initialized: true });
    expect(text(st)).toContain('2 page(s)');

    await client.callTool({ name: 'dream_sessions', arguments: { harness: 'opencode', limit: 3 } });
    expect(service.last('listSessions')).toEqual([{ harness: 'opencode', limit: 3 }]);
    const ss = await client.callTool({ name: 'dream_sessions', arguments: {} });
    expect(service.last('listSessions')).toEqual([{ limit: 20 }]);
    expect((ss.structuredContent as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('dream_begin maps every argument and renders the step', async () => {
    const { client, service } = await connect();
    const r = await client.callTool({
      name: 'dream_begin',
      arguments: {
        harness: 'claude-code',
        session: 'abc',
        since: '2026-01-01T00:00:00Z',
        scope: 'thread',
        dry_run: true,
        resume: 'job-0',
        confirm: true,
      },
    });
    expect(service.last('dreamBegin')).toEqual([
      {
        harness: 'claude-code',
        session: 'abc',
        since: '2026-01-01T00:00:00Z',
        scope: 'thread',
        dry_run: true,
        resume: 'job-0',
        confirm: true,
      },
    ]);
    const t = text(r);
    const iInstr = t.indexOf('INSTRUCTIONS-MARKER');
    const iInput = t.indexOf('INPUT-MARKER');
    const iSchema = t.indexOf('"claims"');
    const iNext = t.indexOf('Next: call dream_step');
    expect(iInstr).toBeGreaterThan(-1);
    expect(iInput).toBeGreaterThan(iInstr);
    expect(iSchema).toBeGreaterThan(iInput);
    expect(iNext).toBeGreaterThan(iSchema);
    expect(t).toContain('"job_id": "job-1"');
    expect(t).toContain('step 2/9');
    expect(t).toContain('1200/150000');
    expect(r.structuredContent).toBeUndefined();

    await client.callTool({ name: 'dream_begin', arguments: {} });
    expect(service.last('dreamBegin')).toEqual([{}]);
  });

  it('dream_step passes the output object through unchanged', async () => {
    const { client, service } = await connect();
    const output = { step: 2, claims: [{ text: 'port is 5173', kind: 'fact', sources: [] }], extra: { deep: [1, 2] } };
    const r = await client.callTool({ name: 'dream_step', arguments: { job_id: 'job-1', output } });
    expect(service.last('dreamStep')).toEqual(['job-1', output]);
    expect(text(r)).toContain('ready_to_commit');
    expect(text(r)).toContain('Next: call dream_commit with {"job_id": "job-1"}');
  });

  it('dream_step passes a JSON-string output through to the service (which parses it)', async () => {
    const { client, service } = await connect();
    const r = await client.callTool({ name: 'dream_step', arguments: { job_id: 'job-1', output: '{"step":1,"claims":[]}' } });
    expect(r.isError).toBeFalsy();
    expect(service.last('dreamStep')).toEqual(['job-1', '{"step":1,"claims":[]}']);
  });

  it('dream_step rejects outputs that are neither objects nor strings via schema validation', async () => {
    const { client, service } = await connect();
    const r = await client.callTool({ name: 'dream_step', arguments: { job_id: 'job-1', output: 42 } });
    expect(r.isError).toBe(true);
    expect(service.last('dreamStep')).toBeUndefined();
  });

  it('renders rejections and needs_confirmation', async () => {
    const service = new FakeService();
    service.dreamStep = async (jobId) => ({
      jobId,
      status: 'step',
      message: 'Try again.',
      budget: { usedTokens: 1, limitTokens: 2 },
      rejection: { reason: 'evidence quote not found', details: ['verdicts[0].evidence.quote: not_found_in_range'] },
      step: {
        name: 'verify',
        index: 3,
        total: 9,
        label: 'verify 1/1',
        instructions: 'Verify.',
        input: '',
        outputSchema: { type: 'object' },
      },
    });
    service.dreamBegin = async () => ({
      jobId: 'job-9',
      status: 'needs_confirmation',
      message: 'Two recent sessions.',
      budget: { usedTokens: 0, limitTokens: 2 },
      candidates: [
        { harness: 'codex', id: 's1', updatedAt: '2026-01-01T00:00:00.000Z' },
        { harness: 'opencode', id: 's2', updatedAt: '2026-01-01T00:01:00.000Z' },
      ],
    });
    const { client } = await connect(service);
    const rej = text(await client.callTool({ name: 'dream_step', arguments: { job_id: 'j', output: {} } }));
    expect(rej).toContain('REJECTED');
    expect(rej).toContain('not_found_in_range');
    expect(rej).toContain('(none)');
    const conf = text(await client.callTool({ name: 'dream_begin', arguments: {} }));
    expect(conf).toContain('needs_confirmation');
    expect(conf).toContain('"id": "s2"');
    expect(conf).toContain('call dream_begin again');
  });

  it('dream_commit, dream_review and dream_rollback', async () => {
    const { client, service } = await connect();
    const c = await client.callTool({ name: 'dream_commit', arguments: { job_id: 'job-1' } });
    expect(service.last('dreamCommit')).toEqual(['job-1']);
    expect(text(c)).toContain('applied (run abc123)');
    expect(text(c)).toContain('Memory saved.');
    expect(c.structuredContent).toMatchObject({ outcome: 'applied', threadPage: COMMIT_RESULT.threadPage });

    const rv = await client.callTool({ name: 'dream_review', arguments: { action: 'show' } });
    expect(service.last('dreamReview')).toEqual([{ action: 'show' }]);
    expect(text(rv)).toContain('```diff\n--- a/pages/x.md');
    await client.callTool({ name: 'dream_review', arguments: { action: 'approve', job_id: 'job-2' } });
    expect(service.last('dreamReview')).toEqual([{ action: 'approve', jobId: 'job-2' }]);
    const bad = await client.callTool({ name: 'dream_review', arguments: { action: 'nuke' } });
    expect(bad.isError).toBe(true);

    await client.callTool({ name: 'dream_rollback', arguments: {} });
    expect(service.last('dreamRollback')).toEqual([undefined]);
    const rb = await client.callTool({ name: 'dream_rollback', arguments: { run_id: 'abc123' } });
    expect(service.last('dreamRollback')).toEqual(['abc123']);
    expect(rb.structuredContent).toMatchObject({ id: 'def456' });
  });

  it('turns DreamError and other errors into isError results without crashing', async () => {
    const { client, service } = await connect();
    service.fail.set('dreamCommit', new DreamError('JOB_STATE', 'job is not ready', ['status is step']));
    const r = await client.callTool({ name: 'dream_commit', arguments: { job_id: 'job-1' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('[JOB_STATE]');
    expect(text(r)).toContain('job is not ready');
    expect(text(r)).toContain('- status is step');
    expect(r.structuredContent).toMatchObject({ error: { code: 'JOB_STATE' } });

    service.fail.set('memoryStatus', new TypeError('kaput'));
    const r2 = await client.callTool({ name: 'memory_status', arguments: {} });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toContain('[INTERNAL]: kaput');

    service.fail.set('memoryIndex', 'a string');
    const r3 = await client.callTool({ name: 'memory_index', arguments: {} });
    expect(r3.isError).toBe(true);

    // still alive
    const ok = await client.callTool({ name: 'memory_read', arguments: { name: 'dev-server' } });
    expect(ok.isError).toBeFalsy();
  });
});

describe('prompts', () => {
  it('lists dream and resume with arguments', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['dream', 'resume']);
    const dream = prompts.find((p) => p.name === 'dream');
    expect(dream?.arguments?.map((a) => a.name).sort()).toEqual(['dry_run', 'harness', 'session']);
    expect(dream?.arguments?.every((a) => !a.required)).toBe(true);
  });

  it('renders the dream prompt with arguments', async () => {
    const { client } = await connect();
    const p = await client.getPrompt({ name: 'dream', arguments: { session: 'abc', dry_run: 'true' } });
    const msg = p.messages[0];
    expect(msg?.role).toBe('user');
    const t = msg?.content.type === 'text' ? msg.content.text : '';
    expect(t).toContain('dream_begin with {"session":"abc","dry_run":true}');
    expect(t).toContain('dream_step');
    expect(t).toContain('dream_commit');
    expect(t).toContain('/compact');
    const plain = await client.getPrompt({ name: 'dream', arguments: {} });
    expect(plain.messages[0]?.content.type === 'text' && plain.messages[0].content.text).toContain('dream_begin with {}');
  });

  it('renders the resume prompt', async () => {
    const { client } = await connect();
    const p = await client.getPrompt({ name: 'resume' });
    const t = p.messages[0]?.content.type === 'text' ? p.messages[0].content.text : '';
    expect(t).toContain('memory_index');
    expect(t).toContain('memory_read');
  });

  it('dreamPromptText ignores falsey dry_run', () => {
    expect(dreamPromptText({ dry_run: 'no' })).toContain('dream_begin with {}');
  });
});

describe('resources', () => {
  it('lists the index, templates and linked pages', async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(['memory://index', 'memory://page/dev-server', 'memory://thread/thread-codex-s1']);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(['memory://page/{name}', 'memory://thread/{name}']);
  });

  it('reads index, page and thread resources', async () => {
    const { client, service } = await connect();
    const idx = await client.readResource({ uri: 'memory://index' });
    expect(idx.contents[0]).toMatchObject({ uri: 'memory://index', mimeType: 'text/markdown' });
    expect((idx.contents[0] as { text: string }).text).toContain('[[dev-server]]');

    const page = await client.readResource({ uri: 'memory://page/dev-server' });
    expect((page.contents[0] as { text: string }).text).toContain('Port 5173.');
    expect(service.last('memoryRead')).toEqual(['dev-server']);

    const th = await client.readResource({ uri: 'memory://thread/codex-s1' });
    expect((th.contents[0] as { text: string }).text).toContain('## Goal');
    expect(service.last('memoryRead')).toEqual(['thread-codex-s1']);

    await expect(client.readResource({ uri: 'memory://page/missing' })).rejects.toThrow(/missing/);
  });

  it('indexLinks extracts unique link targets', () => {
    expect(indexLinks('- [[a]] x [[b|B]] [[a]]\n[[ c ]]')).toEqual(['a', 'b', 'c']);
  });
});
