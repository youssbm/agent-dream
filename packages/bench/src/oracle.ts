/**
 * Scripted "oracle model" and the dream driver loop.
 *
 * An oracle answers each `StepSpec` by `step.name` with predetermined output. It never depends on the exact
 * number or order of steps: handlers read the step (label, instructions, input) to find what they need, e.g.
 * the target page of a `write_page` step or the pages of a `verify` batch.
 */
import type { BeginArgs, CommitResult, IDreamService, StepName, StepResponse, StepSpec } from '@agent-dream/core';

/** Steps the model performs. */
export type ModelStep = Exclude<StepName, 'plan' | 'commit'>;

/** What a handler gets for one submission. */
export interface OracleCall {
  step: StepSpec;
  /** 0 on the first submission for this step index, 1 after one rejection, … */
  attempt: number;
  /** Rejection of the previous submission for this step, if any. */
  rejection?: StepResponse['rejection'];
  /** How many steps with this name were already accepted in this job. */
  seen: number;
  /** Scratch space shared by all handlers of one drive (e.g. remember the outline). */
  memo: Record<string, unknown>;
}

/** A handler returns the `output` for dream_step (the driver adds `step: step.index` when missing). */
export type OracleHandler = (call: OracleCall) => unknown;

export type Oracle = Partial<Record<ModelStep, OracleHandler>>;

/** One request/response pair of the drive, for diagnostics and assertions. */
export interface TraceEntry {
  name: StepName | 'begin';
  index: number;
  label: string;
  attempt: number;
  status: StepResponse['status'];
  rejected?: { reason: string; details?: string[] };
  /** Response step after this submission. */
  next?: { name: StepName; index: number; label: string };
}

export interface DriveResult {
  jobId: string;
  /** Last StepResponse (ready_to_commit when the drive completed). */
  final: StepResponse;
  trace: TraceEntry[];
  /** Distinct step indexes handed out to the model. */
  stepsHandedOut: number;
  /** Budget used as reported by the engine. */
  tokens: number;
  commit?: CommitResult;
  rejections: { name: StepName; label: string; reason: string; details?: string[] }[];
  /** The handlers' shared scratch space after the drive. */
  memo: Record<string, unknown>;
}

export interface DriveOptions {
  begin?: BeginArgs;
  /** Commit when ready (default true). */
  commit?: boolean;
  /** Abort when one step is rejected this many times in a row (default 3). */
  maxAttempts?: number;
  /** Hard cap on dream_step calls (default 200). */
  maxCalls?: number;
  /**
   * Called before each submission; may return a replacement service (to simulate a crash/restart:
   * the driver then calls `dreamBegin({ resume: jobId })` on it and continues from what it returns).
   */
  beforeSubmit?: (resp: StepResponse, callNo: number) => Promise<IDreamService | void> | IDreamService | void;
  /** Start from this response instead of calling dreamBegin (e.g. after a manual begin). */
  startFrom?: StepResponse;
}

/** Thrown when the oracle has no handler or a drive goes off the rails. */
export class DriveError extends Error {
  readonly trace: TraceEntry[];
  constructor(message: string, trace: TraceEntry[]) {
    super(message);
    this.name = 'DriveError';
    this.trace = trace;
  }
}

/** Default answers for steps a scenario does not care about. */
export const DEFAULT_ORACLE: Required<Oracle> = {
  extract: () => ({ claims: [] }),
  verify: (c) => ({ verdicts: versionAgnosticKeep(c.step) }),
  patterns: () => ({ patterns: [] }),
  outline: () => ({ targets: [] }),
  write_page: (c) => {
    const t = writeTarget(c.step);
    return {
      op: {
        op: t.op,
        page: t.page,
        body: `${t.page}: placeholder written by the default oracle.\n`,
        sources: [],
        reason: 'default oracle',
      },
    };
  },
  gap_fill: () => ({ ops: [] }),
  thread_state: (c) => ({ body: defaultThreadBody(c.step), title: 'Thread state' }),
  promote: (c) => ({ index: defaultIndex(c.step) }),
};

function versionAgnosticKeep(step: StepSpec): { page: string; verdict: 'keep'; reason: string }[] {
  return verifyPages(step).map((page) => ({ page, verdict: 'keep' as const, reason: 'default oracle' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading steps
// ─────────────────────────────────────────────────────────────────────────────

/** The target of a write_page step: parsed from the instructions (`write page "x" (op: y`), else the label. */
export function writeTarget(step: StepSpec): { page: string; op: 'create' | 'update' | 'merge' | 'delete' | 'rename'; into?: string } {
  const m = /write page "([a-z0-9-]+)" \(op: (create|update|merge|delete|rename)(?:, into: "([a-z0-9-]+)")?/.exec(step.instructions);
  if (m?.[1] && m[2]) {
    const op = m[2] as 'create' | 'update' | 'merge' | 'delete' | 'rename';
    return m[3] ? { page: m[1], op, into: m[3] } : { page: m[1], op };
  }
  const l = /\(([a-z0-9-]+)(?:,\s*(create|update|merge))?/.exec(step.label);
  if (l?.[1]) return { page: l[1], op: (l[2] as 'create' | 'update' | 'merge' | undefined) ?? 'update' };
  throw new Error(`cannot find the write_page target in step ${step.label}`);
}

/**
 * Page names in a verify batch: from the label (`verify 1/2 (a, b)`), else from the `### [[name]]` page
 * headers of the input (outside transcript blocks), in order.
 */
export function verifyPages(step: StepSpec): string[] {
  const fromLabel = /\(([a-z0-9][a-z0-9-]*(?:,\s*[a-z0-9][a-z0-9-]*)*)\)\s*$/.exec(step.label)?.[1];
  if (fromLabel) return fromLabel.split(/,\s*/);
  const names: string[] = [];
  const outside = stripUntrusted(step.input);
  for (const m of outside.matchAll(/^#{2,4}\s*\[\[([a-z0-9][a-z0-9-]*)\]\]\s*$/gm)) if (m[1] && !names.includes(m[1])) names.push(m[1]);
  return names;
}

/** Lines of the `## <heading…>` section of a step input (up to the next `## ` heading). */
export function section(input: string, heading: string): string[] {
  const lines = stripUntrusted(input).split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    out.push(l);
  }
  return out;
}

/**
 * Page names that will exist after this run, as listed in the promote input ("Pages after this run" and
 * "Thread pages" sections: lines `- name — …`).
 */
export function listedPages(step: StepSpec): string[] {
  const names: string[] = [];
  for (const l of [...section(step.input, 'Pages after this run'), ...section(step.input, 'Thread pages')]) {
    const m = /^\s*-\s+([a-z0-9][a-z0-9-]*)\b/.exec(l);
    if (m?.[1] && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** The thread page name mentioned in the instructions (`[[thread-…]]`), if any. */
export function threadPageOf(step: StepSpec): string | undefined {
  return /\[\[(thread-[a-z0-9-]+)\]\]/.exec(step.instructions)?.[1] ?? /\[\[(thread-[a-z0-9-]+)\]\]/.exec(step.input)?.[1];
}

/** Input with `<untrusted-transcript …>…</untrusted-transcript>` blocks removed. */
export function stripUntrusted(input: string): string {
  return input.replace(/<untrusted-transcript[\s\S]*?<\/untrusted-transcript>/g, '');
}

function defaultThreadBody(step: StepSpec): string {
  return [
    '## Goal',
    'Bench run (scripted oracle).',
    '## Decisions',
    '- none',
    '## Current state',
    `- written at step ${step.index}`,
    '## Open questions',
    '- none',
    '## Files and areas touched',
    '- none',
    '## Failed approaches and traps',
    '- none',
    '## Related pages',
    '- none',
    '',
  ].join('\n');
}

/** A compliant index linking every page offered in the promote input (plus the thread page). */
export function defaultIndex(step: StepSpec, extraLines: string[] = []): string {
  const thread = threadPageOf(step);
  const pages = listedPages(step).filter((n) => n !== thread);
  const lines = ['# Project memory', '', '- Bench project (scripted oracle).', ''];
  if (thread) lines.push(`Active thread: [[${thread}]]`, '');
  lines.push(...extraLines);
  if (pages.length) lines.push('## Pages', ...pages.map((p) => `- [[${p}]] — ${p.replace(/-/g, ' ')}`));
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Driving a job
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a dream job to completion with a scripted oracle: dreamBegin → dreamStep… → (dreamCommit).
 * Handlers missing from `oracle` fall back to {@link DEFAULT_ORACLE}.
 */
export async function drive(service: IDreamService, oracle: Oracle, opts: DriveOptions = {}): Promise<DriveResult> {
  let svc = service;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxCalls = opts.maxCalls ?? 200;
  const trace: TraceEntry[] = [];
  const rejections: DriveResult['rejections'] = [];
  const memo: Record<string, unknown> = {};
  const accepted: Partial<Record<StepName, number>> = {};
  const handedOut = new Set<number>();

  let resp = opts.startFrom ?? (await svc.dreamBegin(opts.begin ?? {}));
  if (!opts.startFrom) trace.push({ name: 'begin', index: 0, label: 'begin', attempt: 0, status: resp.status, next: stepRef(resp) });
  if (resp.status === 'needs_confirmation') {
    throw new DriveError(`dreamBegin needs confirmation: ${resp.message}`, trace);
  }
  const jobId = resp.jobId;
  let attempt = 0;
  let calls = 0;
  let lastRejection: StepResponse['rejection'];

  while (resp.status === 'step') {
    const step = resp.step;
    if (!step) throw new DriveError('status "step" without a step', trace);
    handedOut.add(step.index);
    if (++calls > maxCalls) throw new DriveError(`more than ${maxCalls} dream_step calls`, trace);

    const replacement = await opts.beforeSubmit?.(resp, calls);
    if (replacement) {
      svc = replacement;
      resp = await svc.dreamBegin({ resume: jobId });
      trace.push({ name: 'begin', index: 0, label: `resume ${jobId}`, attempt: 0, status: resp.status, next: stepRef(resp) });
      continue;
    }

    const name = step.name as ModelStep;
    const handler = oracle[name] ?? DEFAULT_ORACLE[name];
    if (!handler) throw new DriveError(`no oracle handler for step ${step.name}`, trace);
    let output = handler({ step, attempt, rejection: lastRejection, seen: accepted[step.name] ?? 0, memo });
    if (output && typeof output === 'object' && !Array.isArray(output) && !('step' in output)) {
      output = { step: step.index, ...(output as Record<string, unknown>) };
    }

    const next = await svc.dreamStep(jobId, output);
    const entry: TraceEntry = { name: step.name, index: step.index, label: step.label, attempt, status: next.status, next: stepRef(next) };
    if (next.rejection) {
      entry.rejected = next.rejection;
      rejections.push({ name: step.name, label: step.label, reason: next.rejection.reason, details: next.rejection.details });
    }
    trace.push(entry);

    if (next.rejection && next.status === 'step' && next.step?.index === step.index) {
      attempt++;
      lastRejection = next.rejection;
      if (attempt >= maxAttempts) {
        throw new DriveError(
          `step ${step.label} rejected ${attempt} times; last: ${next.rejection.reason} ${(next.rejection.details ?? []).join('; ')}`,
          trace,
        );
      }
    } else {
      accepted[step.name] = (accepted[step.name] ?? 0) + 1;
      attempt = 0;
      lastRejection = undefined;
    }
    resp = next;
  }

  if (resp.status !== 'ready_to_commit') {
    throw new DriveError(`job ended in status ${resp.status}: ${resp.message}`, trace);
  }
  const result: DriveResult = {
    jobId,
    final: resp,
    trace,
    stepsHandedOut: handedOut.size,
    tokens: resp.budget.usedTokens,
    rejections,
    memo,
  };
  if (opts.commit !== false) result.commit = await svc.dreamCommit(jobId);
  return result;
}

function stepRef(resp: StepResponse): TraceEntry['next'] {
  return resp.step ? { name: resp.step.name, index: resp.step.index, label: resp.step.label } : undefined;
}

/** Compact one-line rendering of a trace, for failure details. */
export function formatTrace(trace: TraceEntry[]): string {
  return trace
    .map((t) => `${t.label}${t.attempt ? `#${t.attempt}` : ''}→${t.status}${t.rejected ? `(rejected: ${t.rejected.reason})` : ''}`)
    .join(' | ');
}
