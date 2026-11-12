/**
 * Dream job model: the persisted state machine behind `dream_begin` / `dream_step` / `dream_commit`.
 *
 * A job is a plain JSON document stored with `store.writeJob`. Every transition rewrites it, so a brand-new
 * `DreamService` pointed at the same project can pick the job up where it was left.
 *
 * Steps are generated phase by phase: when the last generated step is accepted, the next phase is planned
 * from the results gathered so far (e.g. verify batches are planned after extraction).
 */
import { randomBytes } from 'node:crypto';
import type {
  ChangeSummary,
  Claim,
  FileChange,
  Harness,
  NoteEntry,
  OutlineTarget,
  PageOp,
  Pattern,
  RunRecord,
  SourceRef,
  Verdict,
} from '../types.ts';
import type { ModelStepName } from './schemas.ts';

export const JOB_VERSION = 1;

/** One transcript session taking part in the job. */
export interface JobSession {
  harness: Harness;
  session: string;
  title?: string;
  cwd?: string;
  updatedAt: string;
  /** True for the session whose thread page is written. */
  primary: boolean;
  /** First idx offered to the model (watermark + 1, or the first re-offered skipped idx). */
  fromIdx: number;
  /** Highest raw idx known when the job was planned (max idx of the read transcript). */
  lastIdx: number;
  /**
   * New watermark on commit: the raw last idx for sessions planned in this job (everything up to it is either
   * read in this job or recorded in `skipped`); -1 for evidence-only sessions (no state change).
   */
  processedTo: number;
  /** Filtered characters of the messages handed to the model (for state.sourceChars). */
  filteredChars: number;
  /** Inclusive idx ranges actually handed to the model in extract steps (merged). */
  taken?: [number, number][];
  /** Ranges left unread (budget) that later runs must re-offer; replaces state.skipped for this session on commit. */
  skipped?: [number, number][];
}

/** A claim as stored in the job: server-assigned id plus the verbatim check outcome. */
export interface StoredClaim extends Claim {
  id: string;
  /** Set when `verbatim` was claimed but the exact text could not be found in the cited source. */
  verbatimFailed?: boolean;
}

/** An accepted verdict plus whether its evidence passed the server check. */
export interface StoredVerdict extends Verdict {
  evidenceChecked?: boolean;
}

/** Outline target with the optional engine extensions (claim ids, into). */
export interface StoredTarget extends OutlineTarget {
  into?: string;
  claims?: string[];
  /** Added by the server (correct/delete verdicts the outline omitted). */
  auto?: boolean;
}

/** Validation context for one planned step. */
export interface StepData {
  /** extract: chunk coordinates. */
  chunk?: { harness: Harness; session: string; fromIdx: number; toIdx: number };
  /** extract: inbox note ids shown in this step. */
  notes?: string[];
  /** verify: page names in this batch. */
  pages?: string[];
  /** write_page: index into job.results.targets. */
  target?: number;
  /** gap_fill: issue messages shown. */
  issues?: string[];
}

/** A step as handed to the model (outputSchema is regenerated from `name`). */
export interface PlannedStep {
  name: ModelStepName;
  label: string;
  instructions: string;
  input: string;
  tokens: number;
  data: StepData;
  /** Set once `input` went through secret redaction (before it was first persisted). */
  redacted?: boolean;
}

/** Next phase to plan once the generated steps are exhausted. */
export type Phase = 'verify' | 'patterns' | 'outline' | 'write' | 'gap_fill' | 'thread_state' | 'promote' | 'done';

export const PHASE_ORDER: readonly Phase[] = [
  'verify',
  'patterns',
  'outline',
  'write',
  'gap_fill',
  'thread_state',
  'promote',
  'done',
];

/** Changes computed by commit when they had to be staged for review. */
export interface StagedChanges {
  changes: FileChange[];
  summary: ChangeSummary;
  index: string;
  threadPage?: string;
  reason: string;
  /** Latest history run when staged; approval refuses if memory moved on. */
  baseRun?: string;
  stagedAt: string;
}

export interface JobResults {
  claims: StoredClaim[];
  verdicts: StoredVerdict[];
  patterns: Pattern[];
  targets: StoredTarget[];
  /** Accepted write_page ops, in order. */
  ops: PageOp[];
  /** Accepted gap_fill ops. */
  gapOps: PageOp[];
  thread?: { body: string; title?: string };
  index?: string;
}

export interface Job {
  version: typeof JOB_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'step' | 'ready_to_commit' | 'staged';
  dryRun: boolean;
  scope: 'thread' | 'project';
  /** Primary session (thread page owner), when one was found. */
  primary?: {
    harness: Harness;
    session: string;
    /** No readable transcript: the thread page is written from the model's own context (unverified). */
    degraded?: boolean;
  };
  sessions: JobSession[];
  /** Inbox notes consumed by this job (removed on commit). */
  notes: NoteEntry[];
  /** Project guidance from dream.md at begin time. */
  instructions: string;
  steps: PlannedStep[];
  /** Non-thread pages that existed when the job began (no pages → no verify step to estimate). */
  pagesAtBegin?: number;
  /** 0-based index of the current step in `steps`. */
  cursor: number;
  /** Phase to plan when `cursor` runs past `steps`. */
  nextPhase: Phase;
  /** write phase: index of the next outline target to turn into a step/op. */
  nextTarget: number;
  results: JobResults;
  budget: { usedTokens: number; limitTokens: number };
  /** Steps whose tokens were already counted (0-based indexes). */
  servedUpTo: number;
  /** Human-readable notes for log.md (skipped chunks, downgrades, ...). */
  log: string[];
  /** Stable estimate of the total step count shown as StepSpec.total (recomputed after extract and verify planning). */
  totalEstimate?: number;
  staged?: StagedChanges;
  lastRun?: RunRecord;
}

/** Job ids: `dj-<yyyymmdd>-<random>`, inside the store's `[A-Za-z0-9_-]` charset. */
export function newJobId(now: Date): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `dj-${d}-${randomBytes(4).toString('hex')}`;
}

/** Fresh job skeleton. */
export function createJob(args: {
  id: string;
  now: Date;
  dryRun: boolean;
  scope: 'thread' | 'project';
  limitTokens: number;
  instructions: string;
}): Job {
  const ts = args.now.toISOString();
  return {
    version: JOB_VERSION,
    id: args.id,
    createdAt: ts,
    updatedAt: ts,
    status: 'step',
    dryRun: args.dryRun,
    scope: args.scope,
    sessions: [],
    notes: [],
    instructions: args.instructions,
    steps: [],
    cursor: 0,
    nextPhase: 'verify',
    nextTarget: 0,
    results: { claims: [], verdicts: [], patterns: [], targets: [], ops: [], gapOps: [] },
    budget: { usedTokens: 0, limitTokens: args.limitTokens },
    servedUpTo: 0,
    log: [],
  };
}

/** Runtime check that a value read from disk looks like a job this version understands. */
export function isJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object') return false;
  const j = value as Partial<Job>;
  return (
    j.version === JOB_VERSION &&
    typeof j.id === 'string' &&
    Array.isArray(j.steps) &&
    typeof j.cursor === 'number' &&
    typeof j.results === 'object'
  );
}

/** The step the model is working on, or undefined when all generated steps are done. */
export function currentStep(job: Job): PlannedStep | undefined {
  return job.steps[job.cursor];
}

/** Count the tokens of every step up to and including the current one exactly once. */
export function chargeBudget(job: Job): void {
  while (job.servedUpTo <= job.cursor && job.servedUpTo < job.steps.length) {
    const s = job.steps[job.servedUpTo];
    if (s) job.budget.usedTokens += s.tokens;
    job.servedUpTo++;
  }
}

/** Remaining budget (never negative). */
export function remainingBudget(job: Job): number {
  return Math.max(0, job.budget.limitTokens - job.budget.usedTokens - pendingTokens(job));
}

/** Tokens of generated steps not yet served. */
function pendingTokens(job: Job): number {
  let t = 0;
  for (let i = job.servedUpTo; i < job.steps.length; i++) t += job.steps[i]?.tokens ?? 0;
  return t;
}

/** Re-estimate `job.totalEstimate` from the steps generated so far plus the phases still to plan. */
export function refreshTotal(job: Job): void {
  job.totalEstimate = Math.max(job.steps.length + estimateRemainingSteps(job), job.cursor + 1);
}

/** StepSpec.total: the stored estimate, never below the current step index or the generated step count so far. */
export function displayTotal(job: Job): number {
  return Math.max(job.totalEstimate ?? job.steps.length + estimateRemainingSteps(job), job.cursor + 1);
}

/** Rough count of steps still to be generated, for `StepSpec.total`. */
export function estimateRemainingSteps(job: Job): number {
  const idx = PHASE_ORDER.indexOf(job.nextPhase);
  let n = 0;
  for (const p of PHASE_ORDER.slice(idx)) {
    switch (p) {
      case 'verify':
        n += (job.pagesAtBegin ?? 1) > 0 ? 1 : 0;
        break;
      case 'patterns':
        n += job.results.claims.length > 0 || job.nextPhase === 'verify' ? 1 : 0;
        break;
      case 'outline':
        n += 1;
        break;
      case 'write':
        n += job.results.targets.length > 0 ? writableTargets(job) : 2;
        break;
      case 'gap_fill':
        break;
      case 'thread_state':
        n += job.primary ? 1 : 0;
        break;
      case 'promote':
        n += 1;
        break;
      case 'done':
        break;
    }
  }
  return n;
}

function writableTargets(job: Job): number {
  return job.results.targets
    .slice(job.nextTarget)
    .filter((t) => t.op === 'create' || t.op === 'update' || t.op === 'merge').length;
}

/** Find the session record for a source, if it belongs to the job. */
export function jobSession(job: Job, src: Pick<SourceRef, 'harness' | 'session'>): JobSession | undefined {
  return job.sessions.find((s) => s.harness === src.harness && s.session === src.session);
}
