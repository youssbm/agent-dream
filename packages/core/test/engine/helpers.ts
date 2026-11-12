/**
 * Test helpers for engine tests: fake transcript adapters with synthetic messages, a temp project, and a
 * scripted "model" that answers each dream step for the planted-error story.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { MemoryStore } from '../../src/store/store.ts';
import os from 'node:os';
import path from 'node:path';
import { DreamError } from '../../src/types.ts';
import type {
  Harness,
  ListSessionsOptions,
  Page,
  SessionInfo,
  StepResponse,
  TranscriptAdapter,
  TranscriptMessage,
  TranscriptPart,
} from '../../src/types.ts';
import { serializePage, threadPageName } from '../../src/store/frontmatter.ts';
import { samePath } from '../../src/transcripts/paths.ts';

export const NOW = new Date('2026-11-11T12:00:00.000Z');
export const now = (): Date => NOW;

export interface FakeSession {
  info: SessionInfo;
  messages: TranscriptMessage[];
}

/** In-memory adapter. */
export class FakeAdapter implements TranscriptAdapter {
  readonly sessions: FakeSession[] = [];
  reads = 0;
  readonly harness: Harness;
  private readonly isAvailable: boolean;
  constructor(harness: Harness, isAvailable = true) {
    this.harness = harness;
    this.isAvailable = isAvailable;
  }
  add(s: FakeSession): this {
    this.sessions.push(s);
    return this;
  }
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionInfo[]> {
    let list = this.sessions.map((s) => s.info);
    if (opts.cwd) list = list.filter((s) => samePath(s.cwd, opts.cwd));
    if (opts.since) list = list.filter((s) => Date.parse(s.updatedAt) >= Date.parse(opts.since as string));
    list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return opts.limit ? list.slice(0, opts.limit) : list;
  }
  async readSession(id: string): Promise<TranscriptMessage[]> {
    const s = this.sessions.find((x) => x.info.id === id);
    if (!s) throw new DreamError('SESSION_NOT_FOUND', `no session ${id}`);
    this.reads++;
    return s.messages;
  }
}

type Spec = [TranscriptMessage['role'], string | TranscriptPart[]];

/** Build messages from compact [role, text|parts] specs. */
export function messages(harness: Harness, session: string, specs: Spec[]): TranscriptMessage[] {
  return specs.map(([role, content], idx) => ({
    harness,
    session,
    idx,
    role,
    ts: new Date(NOW.getTime() - (specs.length - idx) * 60_000).toISOString(),
    parts: typeof content === 'string' ? [{ kind: 'text', text: content }] : content,
  }));
}

/** The planted-error story: the agent says port 3000, the tool output and the user say 5173. */
export function plantedStory(harness: Harness, session: string): TranscriptMessage[] {
  return messages(harness, session, [
    ['user', 'Start the dev server please, then check the home page.'],
    ['assistant', [{ kind: 'tool_call', tool: 'Bash', text: 'npm run dev' }]],
    ['tool', [{ kind: 'tool_result', tool: 'Bash', text: 'VITE v5.4.0 ready in 312 ms\nlistening on :5173\nLocal: http://localhost:5173/' }]],
    ['assistant', 'The dev server is running on port 3000.'],
    ['user', "no, it's 5173. Always use port 5173 for the dev server."],
    ['assistant', 'Right, port 5173. I will use http://localhost:5173 from now on.'],
  ]);
}

export interface TempProject {
  dir: string;
  cleanup(): Promise<void>;
}

export async function tempProject(): Promise<TempProject> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dream-engine-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

/** Write pages into memory as one committed history run (initializes the store). */
export async function seedPages(projectDir: string, pages: Page[]): Promise<void> {
  const store = new MemoryStore(projectDir, { now });
  await store.init();
  await store.applyChanges(
    pages.map((p) => ({ type: 'write' as const, path: store.pagePath(p.name), content: serializePage(p) })),
    'test: seed pages',
  );
}

export function page(name: string, body: string, extra: Partial<Page['meta']> = {}): Page {
  return {
    name,
    body,
    meta: {
      title: extra.title ?? name.replace(/-/g, ' '),
      kind: extra.kind ?? 'fact',
      volatile: extra.volatile ?? false,
      confidence: extra.confidence ?? 'verified',
      verified_at: extra.verified_at ?? '2026-11-01',
      sources: extra.sources ?? [{ harness: 'claude-code', session: 'old-session', msgs: '1-2' }],
      links: [],
    },
  };
}

export function sessionInfo(harness: Harness, id: string, cwd: string, updatedAt: string, count?: number): SessionInfo {
  const info: SessionInfo = { harness, id, cwd, updatedAt, title: `session ${id}` };
  if (count !== undefined) info.messageCount = count;
  return info;
}

/** Pages listed in a verify step input (`### [[name]]`). */
export function verifyPages(resp: StepResponse): string[] {
  return [...(resp.step?.input ?? '').matchAll(/^### \[\[([a-z0-9-]+)\]\]/gm)].map((m) => m[1] as string);
}

/** write_page target from the label `write_page k/n (name)`. */
export function writeTarget(resp: StepResponse): string {
  return /\(([^)]+)\)$/.exec(resp.step?.label ?? '')?.[1] ?? '';
}

export type Script = Partial<Record<string, (resp: StepResponse) => unknown>>;

const SRC = (session: string, msgs: string, harness: Harness = 'claude-code') => ({ harness, session, msgs });

export const THREAD_BODY = [
  '## Goal',
  'Get the dev server running and check the home page.',
  '## Decisions',
  '- Use port 5173 for the dev server (user correction, msgs 4).',
  '## Current state',
  'Dev server runs; next: check the home page.',
  '## Open questions',
  '- none',
  '## Files and areas touched',
  '- package.json scripts',
  '## Failed approaches and traps',
  '- Do not assume port 3000.',
  '## Related pages',
  '- [[dev-server]]',
].join('\n');

/** Default scripted answers for the planted story in session `sess-a` (claude-code). */
export function storyScript(session = 'sess-a'): Script {
  return {
    extract: () => ({
      claims: [
        { text: 'The dev server listens on port `5173` (started with `npm run dev`).', kind: 'fact', verbatim: true, volatile: true, sources: [SRC(session, '1-4')] },
        { text: 'Always use port 5173 for the dev server.', kind: 'preference', sources: [SRC(session, '4')] },
      ],
    }),
    verify: (resp) => ({
      verdicts: verifyPages(resp).map((p) =>
        p === 'dev-server'
          ? { page: p, verdict: 'correct', corrected: 'The dev server runs on port 5173.', evidence: { quote: 'listening on :5173', source: SRC(session, '2') } }
          : { page: p, verdict: 'keep' },
      ),
    }),
    patterns: () => ({ patterns: [] }),
    outline: () => ({
      targets: [
        { page: 'dev-server', op: 'update', reason: 'port was wrong', claims: ['c1', 'c2'] },
      ],
    }),
    write_page: (resp) => {
      const name = writeTarget(resp);
      return {
        op: {
          op: name === 'dev-server' ? 'update' : 'create',
          page: name,
          body: name === 'dev-server' ? 'Dev server: `npm run dev`, listening on port `5173`.\n\nNever assume 3000-style defaults.' : `About ${name}.`,
          meta: { title: name === 'dev-server' ? 'Dev server' : name, kind: 'fact', volatile: true },
          sources: [SRC(session, '1-4')],
          reason: 'apply claims',
        },
      };
    },
    gap_fill: () => ({ ops: [] }),
    thread_state: () => ({ body: THREAD_BODY, title: 'Dev server bring-up' }),
    promote: (resp) => {
      const thread = threadPageName('claude-code', session);
      const names = [...(resp.step?.input ?? '').matchAll(/^- ([a-z0-9-]+) — /gm)].map((m) => m[1] as string);
      return {
        index: ['# Memory index', '', `Active thread: [[${thread}]]`, '', ...names.map((n) => `- [[${n}]] — ${n}`), ''].join('\n'),
      };
    },
  };
}

/** Drive a job to ready_to_commit with a script. Returns the last response and every response seen. */
export async function drive(
  service: { dreamStep(jobId: string, output: unknown): Promise<StepResponse> },
  first: StepResponse,
  script: Script,
  maxSteps = 60,
): Promise<{ last: StepResponse; seen: StepResponse[] }> {
  const seen: StepResponse[] = [first];
  let resp = first;
  for (let i = 0; i < maxSteps && resp.status === 'step'; i++) {
    const step = resp.step;
    if (!step) throw new Error('step missing');
    const fn = script[step.name];
    if (!fn) throw new Error(`no script for ${step.name}`);
    const out = fn(resp) as Record<string, unknown>;
    resp = await service.dreamStep(resp.jobId, { step: step.index, ...out });
    if (resp.rejection) throw new Error(`rejected ${step.label}: ${JSON.stringify(resp.rejection)}`);
    seen.push(resp);
  }
  return { last: resp, seen };
}
