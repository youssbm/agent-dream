/** A recording fake of IDreamService for server tests (no engine, no disk). */
import type {
  BeginArgs,
  CommitResult,
  IDreamService,
  ListSessionsOptions,
  Harness,
  MemoryStatus,
  NoteEntry,
  ReviewResult,
  RunRecord,
  SearchHit,
  SessionInfo,
  StepResponse,
} from '@agent-dream/core';

export interface Call {
  method: string;
  args: unknown[];
}

const budget = { usedTokens: 1200, limitTokens: 150000 };

export const STEP_RESPONSE: StepResponse = {
  jobId: 'job-1',
  status: 'step',
  message: 'Extract claims from this chunk.',
  budget,
  step: {
    name: 'extract',
    index: 2,
    total: 9,
    label: 'extract 1/3 (codex:s1 0-40)',
    instructions: 'INSTRUCTIONS-MARKER: list salient claims with sources.',
    input: '<untrusted-transcript harness="codex" session="s1" msgs="0-40">\n[#0 user] INPUT-MARKER\n</untrusted-transcript>',
    outputSchema: { type: 'object', properties: { claims: { type: 'array' } }, required: ['claims'] },
  },
};

export const COMMIT_RESULT: CommitResult = {
  jobId: 'job-1',
  outcome: 'applied',
  run: { id: 'abc123', ts: '2026-01-01T00:00:00.000Z', message: 'dream: test' },
  summary: {
    created: ['dev-server'],
    updated: [],
    deleted: [],
    renamed: [],
    corrections: [{ page: 'dev-server', verdict: 'correct', quote: 'listening on :5173', corrected: 'port 5173' }],
    indexLines: 3,
    indexBytes: 80,
  },
  index: '# Memory\n- [[dev-server]] dev server port\n',
  threadPage: 'thread-codex-s1',
  message: 'Memory saved. You can now /compact or start a new session; the index loads via memory_index.',
};

/** Fake service; set `fail` to make the named method throw. */
export class FakeService implements IDreamService {
  calls: Call[] = [];
  fail = new Map<string, unknown>();
  index = '# Memory\n- [[dev-server]] dev server port\n- [[thread-codex-s1]] active thread\n';
  pages = new Map<string, string>([
    ['dev-server', '---\ntitle: Dev server\n---\n\nPort 5173.\n'],
    ['thread-codex-s1', '---\ntitle: Thread\nkind: thread\n---\n\n## Goal\nShip it.\n'],
  ]);
  instructions: () => Promise<string> = async () => 'INSTRUCTIONS FROM SERVICE';

  private rec(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.fail.has(method)) throw this.fail.get(method);
  }

  last(method: string): unknown[] | undefined {
    return [...this.calls].reverse().find((c) => c.method === method)?.args;
  }

  async memoryIndex(): Promise<string> {
    this.rec('memoryIndex', []);
    return this.index;
  }
  async memorySearch(query: string, opts?: { includeTranscripts?: boolean; limit?: number }): Promise<SearchHit[]> {
    this.rec('memorySearch', [query, opts]);
    return [{ ref: 'dev-server', kind: 'page', title: 'Dev server', snippet: 'Port 5173.', score: 1.5 }];
  }
  async memoryRead(name: string): Promise<string | null> {
    this.rec('memoryRead', [name]);
    if (name === 'index') return this.index;
    return this.pages.get(name) ?? null;
  }
  async memoryNote(text: string, source?: NoteEntry['source']): Promise<NoteEntry> {
    this.rec('memoryNote', [text, source]);
    const e: NoteEntry = { id: 'n1', ts: '2026-01-01T00:00:00.000Z', text };
    if (source) e.source = source;
    return e;
  }
  async memoryStatus(): Promise<MemoryStatus> {
    this.rec('memoryStatus', []);
    return {
      initialized: true,
      dir: '/p/.dream',
      pageCount: 2,
      threadCount: 1,
      indexLines: 3,
      indexBytes: 80,
      inboxCount: 0,
      pending: [],
      dueForReverify: [],
      stagedJobs: [],
      activeJobs: [],
      availableHarnesses: ['codex'],
      lintIssues: [],
    };
  }
  async listSessions(opts?: ListSessionsOptions & { harness?: Harness }): Promise<SessionInfo[]> {
    this.rec('listSessions', [opts]);
    return [{ harness: 'codex', id: 's1', updatedAt: '2026-01-01T00:00:00.000Z', cwd: '/p' }];
  }
  async dreamBegin(args: BeginArgs): Promise<StepResponse> {
    this.rec('dreamBegin', [args]);
    return STEP_RESPONSE;
  }
  async dreamStep(jobId: string, output: unknown): Promise<StepResponse> {
    this.rec('dreamStep', [jobId, output]);
    return { jobId, status: 'ready_to_commit', message: 'All steps done.', budget };
  }
  async dreamCommit(jobId: string): Promise<CommitResult> {
    this.rec('dreamCommit', [jobId]);
    return COMMIT_RESULT;
  }
  async dreamReview(args: { jobId?: string; action: 'show' | 'approve' | 'reject' }): Promise<ReviewResult> {
    this.rec('dreamReview', [args]);
    return { jobId: 'job-2', action: args.action, diff: '--- a/pages/x.md\n+++ b/pages/x.md\n-old\n+new', message: 'Staged diff.' };
  }
  async dreamRollback(runId?: string): Promise<RunRecord> {
    this.rec('dreamRollback', [runId]);
    return { id: 'def456', ts: '2026-01-02T00:00:00.000Z', message: 'Revert run' };
  }
  async serverInstructions(): Promise<string> {
    this.rec('serverInstructions', []);
    return this.instructions();
  }
}
