/**
 * Turns service results into MCP tool results.
 *
 * Every result is one text block: a short human-readable header line followed by the payload
 * (pretty JSON, or markdown for page reads). Small object payloads are also returned as
 * `structuredContent`. Step responses are rendered as a readable work order instead (instructions,
 * input, output schema, next call) and deliberately carry no `structuredContent`: some clients hand
 * only `structuredContent` to the model and others hand both, so a duplicate would either hide the
 * rendered step or double the (large) transcript input.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  CommitResult,
  MemoryStatus,
  NoteEntry,
  ReviewResult,
  RunRecord,
  SearchHit,
  SessionInfo,
  StepResponse,
} from '@agent-dream/core';

/** Pretty JSON used in every payload. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Header line + pretty JSON payload; object payloads are mirrored in structuredContent. */
export function jsonResult(header: string, payload: unknown): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: `${header}\n\n${json(payload)}` }] };
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    result.structuredContent = payload as Record<string, unknown>;
  }
  return result;
}

/** Plain text result (header + body). */
export function textResult(header: string, body?: string): CallToolResult {
  return { content: [{ type: 'text', text: body === undefined || body === '' ? header : `${header}\n\n${body}` }] };
}

/** Shape of errors thrown by core (`DreamError`), detected structurally so server.ts needs no runtime core import. */
export interface DreamErrorLike {
  name: 'DreamError';
  code: string;
  message: string;
  details?: string[];
}

/** True for a core `DreamError` (or anything shaped like one). */
export function isDreamError(err: unknown): err is DreamErrorLike {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  return e.name === 'DreamError' && typeof e.code === 'string' && typeof e.message === 'string';
}

/** Any thrown value → `isError: true` tool result with a code and message. Never throws. */
export function errorResult(tool: string, err: unknown): CallToolResult {
  let code = 'INTERNAL';
  let message: string;
  let details: string[] | undefined;
  if (isDreamError(err)) {
    code = err.code;
    message = err.message;
    details = Array.isArray(err.details) ? err.details.map(String) : undefined;
  } else if (err instanceof Error) {
    message = err.message || err.name;
  } else {
    message = String(err);
  }
  const lines = [`${tool} failed [${code}]: ${message}`];
  if (details && details.length > 0) lines.push('', ...details.map((d) => `- ${d}`));
  const error: { code: string; message: string; details?: string[] } = { code, message };
  if (details && details.length > 0) error.details = details;
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { error } };
}

/** Renders a StepResponse as a work order for the model. */
export function renderStep(res: StepResponse): CallToolResult {
  const out: string[] = [];
  const step = res.step;
  const where = step ? ` — step ${step.index}/${step.total}: ${step.label}` : '';
  out.push(`dream job ${res.jobId} — status: ${res.status}${where}`);
  out.push(`budget: ${res.budget.usedTokens}/${res.budget.limitTokens} tokens`);
  if (res.message) out.push('', res.message);

  if (res.rejection) {
    out.push('', `REJECTED — the previous submission was not accepted: ${res.rejection.reason}`);
    for (const d of res.rejection.details ?? []) out.push(`- ${d}`);
    out.push('Fix these issues and submit this same step again.');
  }

  const meta: Record<string, unknown> = { job_id: res.jobId, status: res.status };
  if (step) meta.step = { name: step.name, index: step.index, total: step.total, label: step.label };
  meta.budget = res.budget;
  out.push('', json(meta));

  if (res.status === 'needs_confirmation') {
    out.push('', '## Candidate sessions', '', json(res.candidates ?? []));
    out.push(
      '',
      'Next: ask the user which session to dream, then call dream_begin again with {"session": "<id>", "harness": "<harness>"} (add "confirm": true to skip this check).',
    );
  }

  if (step) {
    out.push('', '## Instructions', '', step.instructions);
    out.push('', '## Input', '', step.input === '' ? '(none)' : step.input);
    out.push('', '## Output schema', '', '```json', json(step.outputSchema), '```');
    out.push(
      '',
      `Next: call dream_step with {"job_id": "${res.jobId}", "output": <JSON object matching the output schema above>}.`,
    );
  } else if (res.status === 'ready_to_commit') {
    out.push('', `Next: call dream_commit with {"job_id": "${res.jobId}"}.`);
  }
  return { content: [{ type: 'text', text: out.join('\n') }] };
}

/** Header for a commit result. */
export function commitHeader(r: CommitResult): string {
  const s = r.summary;
  const counts = `${s.created.length} created, ${s.updated.length} updated, ${s.deleted.length} deleted, ${s.renamed.length} renamed, ${s.corrections.length} corrections`;
  const run = r.run ? ` (run ${r.run.id})` : '';
  const why = r.outcome === 'staged' && r.stagedReason ? ` — staged: ${r.stagedReason}` : '';
  return `dream_commit ${r.outcome}${run}: ${counts}${why}\n${r.message}`;
}

/** Commit result → tool result. */
export function renderCommit(r: CommitResult): CallToolResult {
  return jsonResult(commitHeader(r), r);
}

/** Review result → tool result (diff shown as text, not escaped JSON). */
export function renderReview(r: ReviewResult): CallToolResult {
  const header = `dream_review ${r.action} (job ${r.jobId}): ${r.message}`;
  const { diff, ...rest } = r;
  const parts = [header];
  if (r.commit) parts.push('', commitHeader(r.commit));
  if (diff !== undefined) parts.push('', '```diff', diff, '```');
  parts.push('', json(rest));
  return { content: [{ type: 'text', text: parts.join('\n') }], structuredContent: { ...r } };
}

/** Search hits → tool result. */
export function renderSearch(query: string, hits: SearchHit[]): CallToolResult {
  const header =
    hits.length === 0
      ? `memory_search "${query}": no hits`
      : `memory_search "${query}": ${hits.length} hit(s). Read a page with memory_read {name}.`;
  return jsonResult(header, { hits });
}

/** Session list → tool result. */
export function renderSessions(sessions: SessionInfo[]): CallToolResult {
  return jsonResult(
    `dream_sessions: ${sessions.length} session(s), most recent first. Dream one with dream_begin {session, harness}.`,
    { sessions },
  );
}

/** Status → tool result. */
export function renderStatus(s: MemoryStatus): CallToolResult {
  const header = s.initialized
    ? `memory_status: ${s.pageCount} page(s), ${s.threadCount} thread(s), index ${s.indexLines} lines / ${s.indexBytes} bytes, ${s.inboxCount} inbox note(s), ${s.pending.length} session(s) with new messages, last dream ${s.lastRunAt ?? 'never'}`
    : `memory_status: memory not initialized yet (${s.dir}); it is created on the first memory_note or dream.`;
  return jsonResult(header, s);
}

/** Note → tool result. */
export function renderNote(n: NoteEntry): CallToolResult {
  return jsonResult(`memory_note saved (${n.id}); it will be organized into pages at the next dream.`, n);
}

/** Rollback → tool result. */
export function renderRollback(r: RunRecord): CallToolResult {
  return jsonResult(`dream_rollback done: new history entry ${r.id}.`, r);
}
