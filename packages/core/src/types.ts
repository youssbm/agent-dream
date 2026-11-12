/**
 * agent-dream — shared contracts.
 *
 * This file is the single source of truth that every module is built against.
 * Owners: the orchestrator. Module owners MUST NOT change these types; if a
 * change is needed, report it and the orchestrator applies it.
 *
 * Hard rules for all core code:
 *  - No LLM calls, no network calls (no http/https/net/dns/fetch). Local fs and
 *    the local `git` binary only.
 *  - Transcripts are read-only. The only directory ever written is `<project>/.dream/`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Transcripts
// ─────────────────────────────────────────────────────────────────────────────

export type Harness = 'claude-code' | 'codex' | 'opencode';
export const HARNESSES: readonly Harness[] = ['claude-code', 'codex', 'opencode'] as const;

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export type PartKind = 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'file' | 'other';

export interface TranscriptPart {
  kind: PartKind;
  /** Plain text of the part. For tool calls: a compact rendering of name + args. */
  text: string;
  /** Tool name for tool_call / tool_result. */
  tool?: string;
  /** Set by the filter when `text` was shortened. */
  truncated?: boolean;
  /** Original length in characters before filtering. */
  originalChars?: number;
}

export interface TranscriptMessage {
  harness: Harness;
  session: string;
  /** 0-based position of this message inside the normalized session. Stable for a given transcript. */
  idx: number;
  role: Role;
  /** ISO 8601 timestamp when known. */
  ts?: string;
  parts: TranscriptPart[];
}

export interface SessionInfo {
  harness: Harness;
  /** Harness-native session id. */
  id: string;
  /** Working directory the session ran in, when known (absolute path). */
  cwd?: string;
  title?: string;
  /** ISO timestamps. */
  startedAt?: string;
  updatedAt: string;
  messageCount?: number;
  /** Where it was read from (file path or db path), for diagnostics only. */
  location?: string;
}

export interface ListSessionsOptions {
  /** Only sessions whose cwd is this directory (compare normalized, case-insensitive on Windows). */
  cwd?: string;
  /** Only sessions updated at or after this ISO time. */
  since?: string;
  limit?: number;
}

export interface TranscriptAdapter {
  readonly harness: Harness;
  /** True when this harness's session store exists on this machine. Never throws. */
  available(): Promise<boolean>;
  /** Most recently updated first. */
  listSessions(opts?: ListSessionsOptions): Promise<SessionInfo[]>;
  /** Full normalized transcript (unfiltered). Throws DreamError('SESSION_NOT_FOUND') if missing. */
  readSession(id: string): Promise<TranscriptMessage[]>;
}

/** A bounded slice of a filtered transcript handed to the model in one step. */
export interface Chunk {
  /** `${harness}:${session}:${fromIdx}-${toIdx}` */
  id: string;
  harness: Harness;
  session: string;
  fromIdx: number;
  toIdx: number;
  /**
   * Rendered text. Each message starts on its own line as `[#<idx> <role>] ` followed by its parts.
   * Tool calls render as `→ tool <name>: <args>`; tool results as `← <name>: <text>`.
   */
  text: string;
  /** Estimated tokens (chars / 4, rounded up). */
  tokens: number;
  /** idx values the candidate heuristics flagged as likely salient. */
  candidates: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory
// ─────────────────────────────────────────────────────────────────────────────

/** `msgs` is "40" or "40-52" (inclusive, message idx values). */
export interface SourceRef {
  harness: Harness;
  session: string;
  msgs: string;
}

export type PageKind =
  | 'fact'
  | 'rule'
  | 'decision'
  | 'howto'
  | 'trap'
  | 'preference'
  | 'overview'
  | 'thread';

export type Confidence = 'verified' | 'unverified';

export interface PageMeta {
  title: string;
  kind: PageKind;
  volatile: boolean;
  confidence: Confidence;
  /** YYYY-MM-DD */
  verified_at?: string;
  sources: SourceRef[];
  /** Page names this page links to (mirrors the [[links]] in the body; kept in sync on write). */
  links: string[];
}

/**
 * A memory page.
 * `name` is the slug: lowercase a–z, 0–9 and '-', 1–80 chars, e.g. `test-db-setup`.
 * Normal pages live at `.dream/pages/<name>.md`.
 * Thread pages use the name `thread-<harness>-<session>` (sanitized to the slug charset) and
 * live at `.dream/threads/<name>.md`. Links use `[[name]]` for both.
 */
export interface Page {
  name: string;
  meta: PageMeta;
  /** Markdown body without front matter. */
  body: string;
}

export interface DreamConfig {
  /** Max estimated tokens per chunk handed to the model. */
  chunkTokens: number;
  /** Max estimated tokens of model input per dream run. */
  runTokens: number;
  indexMaxLines: number;
  indexMaxBytes: number;
  applyMode: 'auto' | 'review';
  /** Auto-apply falls back to staging when deleted+rewritten existing pages exceed this share. */
  safetyNetRatio: number;
  /** Safety net only applies when at least this many pages already exist. */
  safetyNetMinPages: number;
  /** Lint: total page bytes / filtered source bytes processed so far must stay ≤ this. */
  maxWikiSourceRatio: number;
  /** Harnesses to read. Default: all available. */
  harnesses: Harness[];
  /** Days after which a non-volatile verified page is due for re-verification. */
  reverifyAfterDays: number;
  /** Days after which a volatile page is due for re-verification. */
  reverifyVolatileAfterDays: number;
}

export const DEFAULT_CONFIG: DreamConfig = {
  chunkTokens: 6000,
  runTokens: 150000,
  indexMaxLines: 200,
  indexMaxBytes: 25 * 1024,
  applyMode: 'auto',
  safetyNetRatio: 0.3,
  safetyNetMinPages: 5,
  maxWikiSourceRatio: 1.0,
  harnesses: ['claude-code', 'codex', 'opencode'],
  reverifyAfterDays: 30,
  reverifyVolatileAfterDays: 7,
};

/** Persistent cross-run state, `.dream/state.json` (committed with memory). */
export interface DreamState {
  version: 1;
  /** Highest message idx already processed, per `${harness}:${session}`. */
  watermarks: Record<string, number>;
  /** Total filtered source characters processed across all runs (for the size-ratio lint). */
  sourceChars: number;
  /** ISO time of the last committed run. */
  lastRunAt?: string;
  /** Read counters per page name (memory_read / resources), used to prioritize re-verification. */
  reads: Record<string, number>;
  /**
   * What the last committed run saw of each session, per `${harness}:${session}`: the last raw message idx and the
   * session's updatedAt. A session is unchanged only when its updatedAt matches and its watermark ≥ lastIdx.
   * Optional for backward compatibility with state written by earlier versions.
   */
  seen?: Record<string, { lastIdx: number; updatedAt: string }>;
  /**
   * Message ranges a run skipped (budget) and must re-offer, per `${harness}:${session}`, as inclusive [from, to] pairs.
   */
  skipped?: Record<string, [number, number][]>;
}

export interface NoteEntry {
  id: string;
  ts: string;
  text: string;
  /** Optional session the note came from. */
  source?: { harness?: Harness; session?: string };
}

/** One file-level change in a changeset (paths are relative to `.dream/`, forward slashes). */
export type FileChange =
  | { type: 'write'; path: string; content: string }
  | { type: 'delete'; path: string };

export interface RunRecord {
  /** git commit hash, or snapshot id when git is unavailable. */
  id: string;
  ts: string;
  message: string;
}

export interface LockHandle {
  release(): Promise<void>;
}

/** Durable memory folder. Implemented by `store/store.ts` (`MemoryStore`). */
export interface IMemoryStore {
  /** Absolute path of `.dream/`. */
  readonly dir: string;
  /** Creates the folder layout, default files, `.gitignore` for cache/jobs/lock, and history init. Idempotent. */
  init(): Promise<void>;
  exists(): Promise<boolean>;
  readConfig(): Promise<DreamConfig>;
  /** `MEMORY.md` contents ('' when missing). */
  readIndex(): Promise<string>;
  /** `dream.md` contents ('' when missing). */
  readInstructions(): Promise<string>;
  listPages(): Promise<Page[]>;
  /** Normal page or thread page by name; null when missing. */
  readPage(name: string): Promise<Page | null>;
  readState(): Promise<DreamState>;
  writeState(state: DreamState): Promise<void>;
  /** In-session notes not yet consumed by a dream. */
  readInbox(): Promise<NoteEntry[]>;
  addNote(note: Omit<NoteEntry, 'id' | 'ts'>): Promise<NoteEntry>;
  /** Path (relative to .dream/) a page would be stored at. */
  pagePath(name: string): string;
  /** Serialize a page to markdown with YAML front matter. */
  serializePage(page: Page): string;
  /** Apply file changes atomically-ish (write temp then rename), then record one history entry. */
  applyChanges(changes: FileChange[], message: string): Promise<RunRecord>;
  appendLog(markdown: string): Promise<void>;
  listRuns(limit?: number): Promise<RunRecord[]>;
  /** Revert the given run (default: latest) as a new history entry. Returns the new record. */
  rollback(runId?: string): Promise<RunRecord>;
  /** Exclusive lock on the memory folder. Throws DreamError('LOCKED') when held and not stale. */
  lock(ttlMs?: number): Promise<LockHandle>;
  /** Jobs directory helpers (job files are git-ignored). */
  readJob<T>(jobId: string): Promise<T | null>;
  writeJob<T>(jobId: string, job: T): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  listJobs(): Promise<string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quality: redaction, lint, search
// ─────────────────────────────────────────────────────────────────────────────

export interface RedactionResult {
  text: string;
  /** Number of secrets replaced. */
  count: number;
}

export type LintIssueType =
  | 'dangling_link'
  | 'orphan_page'
  | 'oversized_page'
  | 'index_too_long'
  | 'index_too_large'
  | 'index_dangling_link'
  | 'wiki_source_ratio'
  | 'duplicate_title'
  | 'missing_sources';

export interface LintIssue {
  type: LintIssueType;
  page?: string;
  /** e.g. the missing link target. */
  target?: string;
  message: string;
}

export interface LintInput {
  pages: Page[];
  index: string;
  config: DreamConfig;
  /** Total filtered source chars processed (state.sourceChars). */
  sourceChars: number;
}

export interface SearchHit {
  /** Page name, or `${harness}:${session}#${idx}` for transcript hits. */
  ref: string;
  kind: 'page' | 'transcript';
  title?: string;
  snippet: string;
  score: number;
  sources?: SourceRef[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Dream job protocol (model-facing)
// ─────────────────────────────────────────────────────────────────────────────

export type StepName =
  | 'plan' // S
  | 'extract' // M (one sub-step per chunk)
  | 'verify' // M+S (one sub-step per batch of pages)
  | 'patterns' // M
  | 'outline' // M (choose page targets)
  | 'write_page' // M (one sub-step per page target)
  | 'gap_fill' // S lists issues, M fixes (skipped when no issues)
  | 'thread_state' // M
  | 'promote' // M+S (index)
  | 'commit'; // S

export type ClaimKind = 'fact' | 'decision' | 'rule' | 'failure' | 'preference' | 'open_item' | 'trap';

export interface Claim {
  text: string;
  kind: ClaimKind;
  verbatim?: boolean;
  volatile?: boolean;
  sources: SourceRef[];
}

export type VerdictKind = 'keep' | 'correct' | 'unverified' | 'delete';

export interface Verdict {
  page: string;
  verdict: VerdictKind;
  /** Required for correct and delete; optional for keep. */
  evidence?: { quote: string; source: SourceRef };
  /** Required for correct: the corrected statement. */
  corrected?: string;
  reason?: string;
}

export interface Pattern {
  text: string;
  kind: 'recurring_failure' | 'repeated_correction' | 'stable_preference' | 'contradiction';
  sources: SourceRef[];
}

export type PageOpKind = 'create' | 'update' | 'delete' | 'rename' | 'merge';

export interface PageOp {
  op: PageOpKind;
  page: string;
  /** Full markdown body for create/update/merge (no front matter). */
  body?: string;
  /** Front matter fields (title, kind, volatile, confidence); sources/links are merged by the server. */
  meta?: Partial<Pick<PageMeta, 'title' | 'kind' | 'volatile' | 'confidence'>>;
  /** rename: new name. merge: target page that `page` is merged into (page is deleted). */
  into?: string;
  sources: SourceRef[];
  reason: string;
}

export interface OutlineTarget {
  page: string;
  op: PageOpKind;
  reason: string;
}

/** What the model receives for each step. */
export interface StepSpec {
  name: StepName;
  /** 1-based position in the overall run, and the planned total (total may grow/shrink). */
  index: number;
  total: number;
  /** Human-readable label, e.g. "extract 3/7 (claude-code:abc 120-188)". */
  label: string;
  /** What to do, written for the model. Always ends by stating how to submit (dream_step). */
  instructions: string;
  /**
   * Input material. Transcript text is ALWAYS wrapped in
   * `<untrusted-transcript ...>` … `</untrusted-transcript>` delimiters.
   */
  input: string;
  /** JSON Schema of the expected `output` argument for dream_step. */
  outputSchema: Record<string, unknown>;
}

export type JobStatus = 'step' | 'needs_confirmation' | 'ready_to_commit' | 'done' | 'error';

export interface BudgetInfo {
  usedTokens: number;
  limitTokens: number;
}

export interface StepResponse {
  jobId: string;
  status: JobStatus;
  step?: StepSpec;
  /** For needs_confirmation: candidate sessions to choose from. */
  candidates?: SessionInfo[];
  /** Short message for the model/user (what happened, what to do next). */
  message: string;
  /** Present when the previous submission was rejected; the same step is repeated. */
  rejection?: { reason: string; details?: string[] };
  budget: BudgetInfo;
}

export interface BeginArgs {
  harness?: Harness;
  session?: string;
  /** ISO time: also include other sessions for this project updated since then. */
  since?: string;
  /** 'thread' = only the selected session; 'project' = selected + sessions since watermark (default). */
  scope?: 'thread' | 'project';
  dry_run?: boolean;
  /** Resume an existing job instead of starting a new one. */
  resume?: string;
  /** Skip the session confirmation even if ambiguous. */
  confirm?: boolean;
}

export interface ChangeSummary {
  created: string[];
  updated: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
  /** Corrections and deletions with the evidence that justified them. */
  corrections: { page: string; verdict: VerdictKind; quote?: string; source?: SourceRef; corrected?: string }[];
  indexLines: number;
  indexBytes: number;
}

export interface CommitResult {
  jobId: string;
  /** applied = committed to history; staged = waiting in review; dry_run = nothing written. */
  outcome: 'applied' | 'staged' | 'dry_run';
  run?: RunRecord;
  /** Why it was staged instead of applied, when the safety net tripped. */
  stagedReason?: string;
  summary: ChangeSummary;
  index: string;
  threadPage?: string;
  message: string;
}

export interface ReviewResult {
  jobId: string;
  action: 'show' | 'approve' | 'reject';
  /** Unified-ish textual diff of staged changes (for show). */
  diff?: string;
  commit?: CommitResult;
  message: string;
}

export interface MemoryStatus {
  initialized: boolean;
  dir: string;
  lastRunAt?: string;
  pageCount: number;
  threadCount: number;
  indexLines: number;
  indexBytes: number;
  inboxCount: number;
  /** New sessions / messages since the last dream, per harness. */
  pending: { harness: Harness; session: string; newMessages: number; updatedAt: string }[];
  dueForReverify: string[];
  stagedJobs: string[];
  activeJobs: string[];
  availableHarnesses: Harness[];
  lintIssues: LintIssue[];
}

/**
 * The facade the MCP server talks to. Implemented by `engine/service.ts` (`DreamService`).
 * Every method is safe to call before `.dream/` exists (it is initialized lazily on first write).
 */
export interface IDreamService {
  memoryIndex(): Promise<string>;
  memorySearch(query: string, opts?: { includeTranscripts?: boolean; limit?: number }): Promise<SearchHit[]>;
  /** Returns serialized page markdown (with front matter) or null. Increments the read counter. */
  memoryRead(name: string): Promise<string | null>;
  memoryNote(text: string, source?: NoteEntry['source']): Promise<NoteEntry>;
  memoryStatus(): Promise<MemoryStatus>;
  listSessions(opts?: ListSessionsOptions & { harness?: Harness }): Promise<SessionInfo[]>;
  dreamBegin(args: BeginArgs): Promise<StepResponse>;
  /** Submit the output of the current step. Invalid output → same step with `rejection`. */
  dreamStep(jobId: string, output: unknown): Promise<StepResponse>;
  dreamCommit(jobId: string): Promise<CommitResult>;
  dreamReview(args: { jobId?: string; action: 'show' | 'approve' | 'reject' }): Promise<ReviewResult>;
  dreamRollback(runId?: string): Promise<RunRecord>;
  /** Text for MCP server `instructions`: usage note + capped index. */
  serverInstructions(): Promise<string>;
}

export interface DreamServiceOptions {
  /** Project directory; `.dream/` is created inside it. */
  projectDir: string;
  /** Override the adapters (tests). Default: all built-in adapters for the current user. */
  adapters?: TranscriptAdapter[];
  /** Override home directory used by built-in adapters (tests). */
  homeDir?: string;
  /** Clock (tests). */
  now?: () => Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dream traffic markers (so a dream never re-reads its own run as project knowledge)
// ─────────────────────────────────────────────────────────────────────────────

/** First line of the `dream` MCP prompt; a user message starting with it is a dream request, not project content. */
export const DREAM_PROMPT_FIRST_LINE = "Dream: consolidate this project's memory using the agent-dream tools.";
/** First line of the `resume` MCP prompt. */
export const RESUME_PROMPT_FIRST_LINE = 'Resume: load this project\'s memory with the agent-dream tools.';
/** Tool names of the dream protocol; calls to them (and their results) are dream traffic. */
export const DREAM_TOOL_NAMES = ['dream_begin', 'dream_step', 'dream_commit', 'dream_review', 'dream_rollback'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type DreamErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'NO_SESSIONS'
  | 'JOB_NOT_FOUND'
  | 'JOB_STATE'
  | 'LOCKED'
  | 'INVALID_OUTPUT'
  | 'INVALID_PAGE_NAME'
  | 'PATH_OUTSIDE_MEMORY'
  | 'HISTORY'
  | 'UNSUPPORTED_FORMAT'
  | 'NOTHING_STAGED';

export class DreamError extends Error {
  readonly code: DreamErrorCode;
  readonly details?: string[];
  constructor(code: DreamErrorCode, message: string, details?: string[]) {
    super(message);
    this.name = 'DreamError';
    this.code = code;
    this.details = details;
  }
}
