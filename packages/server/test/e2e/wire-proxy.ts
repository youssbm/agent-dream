/**
 * Test-only IDreamService that talks to a running agent-dream server over MCP and reconstructs results from the
 * TEXT the tools return — i.e. exactly what a model in a tools-only host would see. If a full dream can be driven
 * through this proxy, the rendered step text carries everything the protocol needs.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  BeginArgs,
  CommitResult,
  IDreamService,
  MemoryStatus,
  NoteEntry,
  ReviewResult,
  RunRecord,
  SearchHit,
  SessionInfo,
  StepResponse,
  StepSpec,
} from '@agent-dream/core';

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

export function textOf(r: unknown): string {
  return ((r as ToolResult).content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

/** First pretty-printed JSON object (top-level `{` … `}` lines) at or after `from`. */
function jsonBlockAfter(text: string, from = 0): unknown {
  const start = text.indexOf('\n{', from);
  if (start < 0) throw new Error(`no JSON block in:\n${text.slice(0, 500)}`);
  const end = text.indexOf('\n}', start + 1);
  return JSON.parse(text.slice(start + 1, end + 2));
}

export function parseStepResponse(text: string): StepResponse {
  const meta = jsonBlockAfter(text) as {
    job_id: string;
    status: StepResponse['status'];
    step?: { name: StepSpec['name']; index: number; total: number; label: string };
    budget: StepResponse['budget'];
  };
  const lines = text.split('\n');
  const message = lines.slice(3, lines.findIndex((l, i) => i > 2 && (l.startsWith('{') || l.startsWith('REJECTED')))).join('\n').trim();
  const res: StepResponse = { jobId: meta.job_id, status: meta.status, message, budget: meta.budget };

  const rej = /\nREJECTED — the previous submission was not accepted: (.*)\n((?:- .*\n)*)/.exec(text);
  if (rej) {
    res.rejection = {
      reason: rej[1] ?? '',
      details: (rej[2] ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
    };
  }

  if (meta.step) {
    const iInstr = text.indexOf('\n## Instructions\n\n');
    const iInput = text.indexOf('\n\n## Input\n\n', iInstr);
    const iSchema = text.lastIndexOf('\n\n## Output schema\n\n');
    if (iInstr < 0 || iInput < 0 || iSchema < 0) throw new Error('step sections missing from rendered step');
    const instructions = text.slice(iInstr + '\n## Instructions\n\n'.length, iInput);
    const rawInput = text.slice(iInput + '\n\n## Input\n\n'.length, iSchema);
    const schemaStart = text.indexOf('```json\n', iSchema) + '```json\n'.length;
    const schemaEnd = text.indexOf('\n```', schemaStart);
    res.step = {
      ...meta.step,
      instructions,
      input: rawInput === '(none)' ? '' : rawInput,
      outputSchema: JSON.parse(text.slice(schemaStart, schemaEnd)) as Record<string, unknown>,
    };
  }
  return res;
}

export class WireDreamService implements IDreamService {
  constructor(private readonly client: Client) {}

  private async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = (await this.client.callTool({ name, arguments: args })) as ToolResult;
    const t = textOf(r);
    if (r.isError) throw new Error(`${name} failed: ${t}`);
    return t;
  }

  async dreamBegin(args: BeginArgs): Promise<StepResponse> {
    return parseStepResponse(await this.call('dream_begin', { ...args }));
  }
  async dreamStep(jobId: string, output: unknown): Promise<StepResponse> {
    return parseStepResponse(await this.call('dream_step', { job_id: jobId, output }));
  }
  async dreamCommit(jobId: string): Promise<CommitResult> {
    return jsonBlockAfter(await this.call('dream_commit', { job_id: jobId })) as CommitResult;
  }
  async dreamReview(args: { jobId?: string; action: 'show' | 'approve' | 'reject' }): Promise<ReviewResult> {
    return jsonBlockAfter(await this.call('dream_review', { job_id: args.jobId, action: args.action })) as ReviewResult;
  }
  async dreamRollback(runId?: string): Promise<RunRecord> {
    return jsonBlockAfter(await this.call('dream_rollback', runId ? { run_id: runId } : {})) as RunRecord;
  }
  async memoryIndex(): Promise<string> {
    return this.call('memory_index');
  }
  async memoryRead(name: string): Promise<string | null> {
    const r = (await this.client.callTool({ name: 'memory_read', arguments: { name } })) as ToolResult;
    return r.isError ? null : textOf(r);
  }
  async memorySearch(query: string, opts?: { includeTranscripts?: boolean; limit?: number }): Promise<SearchHit[]> {
    const t = await this.call('memory_search', { query, include_transcripts: opts?.includeTranscripts, limit: opts?.limit });
    return (jsonBlockAfter(t) as { hits: SearchHit[] }).hits;
  }
  async memoryNote(text: string, source?: NoteEntry['source']): Promise<NoteEntry> {
    return jsonBlockAfter(await this.call('memory_note', { text, ...source })) as NoteEntry;
  }
  async memoryStatus(): Promise<MemoryStatus> {
    return jsonBlockAfter(await this.call('memory_status')) as MemoryStatus;
  }
  async listSessions(): Promise<SessionInfo[]> {
    return (jsonBlockAfter(await this.call('dream_sessions')) as { sessions: SessionInfo[] }).sessions;
  }
  async serverInstructions(): Promise<string> {
    return this.client.getInstructions() ?? '';
  }
}
