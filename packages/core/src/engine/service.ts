/**
 * `DreamService`: the facade the MCP server talks to (memory tools + the dream job protocol).
 *
 * The dream job is a persisted state machine (see job.ts / steps.ts): `dreamBegin` plans the extract steps,
 * each `dreamStep` validates and stores one output and plans what comes next, `dreamCommit` turns the
 * results into one history commit (or stages them for review). The lock is only held while mutating.
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { DreamError } from '../types.ts';
import type {
  BeginArgs,
  Chunk,
  CommitResult,
  DreamConfig,
  DreamState,
  FileChange,
  Harness,
  IDreamService,
  ListSessionsOptions,
  LockHandle,
  MemoryStatus,
  NoteEntry,
  ReviewResult,
  RunRecord,
  SearchHit,
  SessionInfo,
  StepResponse,
  DreamServiceOptions,
  ChangeSummary,
  LintIssue,
} from '../types.ts';
import { MemoryStore } from '../store/store.ts';
import { isValidPageName, threadPageName } from '../store/frontmatter.ts';
import { redact } from '../quality/redact.ts';
import { indexStats, lintMemory } from '../quality/lint.ts';
import { searchPages, searchTranscripts } from '../quality/search.ts';
import { defaultAdapters } from '../transcripts/registry.ts';
import { chunkMessages, wrapUntrustedText } from '../transcripts/chunk.ts';
import { samePath } from '../transcripts/paths.ts';
import type { Job, JobSession, StagedChanges } from './job.ts';
import { chargeBudget, createJob, currentStep, displayTotal, isJob, newJobId, refreshTotal } from './job.ts';
import { normalizeOutput, outputJsonSchema, parseStepOutput } from './schemas.ts';
import {
  INDEX_FRAMING,
  INDEX_TRUNCATED_LINE,
  SAVED_SUFFIX,
  SERVER_INSTRUCTIONS_MAX,
  SERVER_USAGE,
  readyMessage,
  rejectionMessage,
  stagedMessage,
  stepMessage,
} from './prompts.ts';
import {
  SessionSource,
  mergeIdxRanges,
  pendingWork,
  sessionUnchanged,
  type IdxRange,
  type LoadedSession,
} from './sessions.ts';
import { acceptOutput, advance, buildExtractSteps, dueForReverify, EXTRACT_SHARE, extractOverheadTokens, type PlanContext } from './steps.ts';
import { buildChanges, inboxText, isoDay, isThreadPage, nextState, stateText } from './apply.ts';
import { changesDiff } from './review.ts';
import { quoteBlock, refText } from './render.ts';

/** Sessions of different harnesses updated this close together make the "current thread" ambiguous. */
const AMBIGUITY_MS = 10 * 60 * 1000;
/** Max other sessions read per dream_begin (scope 'project'). */
const MAX_OTHER_SESSIONS = 20;
/** Jobs untouched for this long are deleted by dream_begin. */
export const JOB_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** memory_status reads at most this many changed sessions to count their new messages (others report -1). */
const STATUS_READ_LIMIT = 10;
/** How long a call waits for the memory folder lock held by another call/process. */
const LOCK_WAIT_MS = 3000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Replace every string inside a JSON-like value by its redacted form (in place for objects/arrays). */
function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value).text as T;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = redactDeep(value[i]);
    return value;
  }
  if (isRecord(value)) {
    const rec: Record<string, unknown> = value;
    for (const k of Object.keys(rec)) rec[k] = redactDeep(rec[k]);
    return value;
  }
  return value;
}

function redactTitle(info: SessionInfo): SessionInfo {
  return info.title === undefined ? info : { ...info, title: redact(info.title).text };
}

function toPairs(ranges: IdxRange[]): [number, number][] {
  return ranges.map((r) => [r.from, r.to]);
}

/** Cut an index to the configured caps at a line boundary. */
function capIndex(index: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  const lines = index.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let bytes = 0;
  for (const l of lines) {
    const b = Buffer.byteLength(l, 'utf8') + 1;
    if (out.length >= maxLines || bytes + b > maxBytes) return { text: out.join('\n'), truncated: true };
    out.push(l);
    bytes += b;
  }
  return { text: out.join('\n'), truncated: false };
}

/** The dream service. See {@link IDreamService}. */
export class DreamService implements IDreamService {
  readonly projectDir: string;
  readonly store: MemoryStore;
  private readonly now: () => Date;
  private readonly sessions: SessionSource;
  private initialized = false;
  /** Serializes mutating calls of this instance (the file lock covers other processes). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: DreamServiceOptions) {
    this.projectDir = path.resolve(opts.projectDir);
    this.now = opts.now ?? (() => new Date());
    this.store = new MemoryStore(this.projectDir, { now: this.now });
    this.sessions = new SessionSource(opts.adapters ?? defaultAdapters({ homeDir: opts.homeDir }));
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    this.initialized = true;
  }

  /**
   * Run `fn` holding the memory folder lock. Calls on this instance queue behind each other (so a duplicate
   * dream_step submitted concurrently sees the step already advanced); a lock held by another process is
   * waited for briefly before failing with LOCKED.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensureInit();
      const handle = await this.acquireLock();
      try {
        return await fn();
      } finally {
        await handle.release();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async acquireLock(): Promise<LockHandle> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let wait = 25; ; wait = Math.min(wait * 2, 400)) {
      try {
        return await this.store.lock();
      } catch (err) {
        if (!(err instanceof DreamError) || err.code !== 'LOCKED' || Date.now() + wait > deadline) throw err;
        await sleep(wait);
      }
    }
  }

  /** `${harness}:${session}` of every session that ran in this project. */
  private async projectSessionKeys(config: DreamConfig): Promise<Set<string>> {
    const list = await this.sessions.list(await this.sessions.enabled(config), { cwd: this.projectDir });
    return new Set(list.map((s) => `${s.harness}:${s.id}`));
  }

  private async planContext(): Promise<PlanContext> {
    const now = this.now();
    const [config, pages, index, state] = await Promise.all([
      this.store.readConfig(),
      this.store.listPages(),
      this.store.readIndex(),
      this.store.readState(),
    ]);
    return {
      config,
      now,
      today: isoDay(now),
      pages,
      index,
      state,
      sessions: this.sessions,
      serialize: (p) => this.store.serializePage(p),
      projectSessions: () => this.projectSessionKeys(config),
    };
  }

  private async loadJob(jobId: string): Promise<Job> {
    const raw = await this.store.readJob<unknown>(jobId);
    if (!isJob(raw)) {
      throw new DreamError(
        'JOB_NOT_FOUND',
        `No dream job "${jobId}". Call dream_begin to start a new one (memory_status lists active and staged jobs).`,
      );
    }
    return raw;
  }

  /**
   * Persist the job. Nothing secret reaches `.jobs/`: step inputs are redacted when planned (steps.ts) and
   * every model result, note and log line is redacted here before the write.
   */
  private async saveJob(job: Job): Promise<void> {
    job.updatedAt = this.now().toISOString();
    for (const s of job.steps) {
      if (s.redacted) continue;
      s.input = redact(s.input).text;
      s.redacted = true;
    }
    redactDeep(job.results);
    redactDeep(job.notes);
    redactDeep(job.log);
    for (const s of job.sessions) if (s.title !== undefined) s.title = redact(s.title).text;
    await this.store.writeJob(job.id, job);
  }

  /** Delete jobs untouched for {@link JOB_EXPIRY_MS} (they hold transcript excerpts), with a log.md line each. */
  private async expireJobs(): Promise<void> {
    const cutoff = this.now().getTime() - JOB_EXPIRY_MS;
    const expired: string[] = [];
    for (const id of await this.store.listJobs()) {
      const j = await this.store.readJob<unknown>(id);
      if (!isJob(j)) continue;
      const t = Date.parse(j.updatedAt ?? j.createdAt);
      if (Number.isNaN(t) || t >= cutoff) continue;
      await this.store.deleteJob(id);
      expired.push(`- ${this.now().toISOString().slice(0, 10)}: expired dream job ${id} (${j.status}, untouched since ${j.updatedAt ?? j.createdAt}).`);
    }
    if (expired.length) await this.store.appendLog(expired.join('\n'));
  }

  /** Build the StepResponse for the job's current state. */
  private respond(job: Job, extra: { prefix?: string; rejection?: StepResponse['rejection'] } = {}): StepResponse {
    const budget = { ...job.budget };
    const prefix = extra.prefix ? `${extra.prefix} ` : '';
    if (job.status === 'staged') {
      return { jobId: job.id, status: 'ready_to_commit', message: prefix + stagedMessage(job.id), budget };
    }
    if (job.status === 'ready_to_commit') {
      return { jobId: job.id, status: 'ready_to_commit', message: prefix + readyMessage(job.id), budget };
    }
    const step = currentStep(job);
    if (!step) {
      return {
        jobId: job.id,
        status: 'error',
        message: `${prefix}The job has no current step. Call dream_begin with { resume: "${job.id}" } to re-plan it.`,
        budget,
      };
    }
    const res: StepResponse = {
      jobId: job.id,
      status: 'step',
      step: {
        name: step.name,
        index: job.cursor + 1,
        total: displayTotal(job),
        label: step.label,
        instructions: step.instructions,
        input: step.input,
        outputSchema: outputJsonSchema(step.name),
      },
      message: prefix + (extra.rejection ? rejectionMessage(job.id, step.label) : stepMessage(job.id, step.label, job.cursor + 1)),
      budget,
    };
    if (extra.rejection) res.rejection = extra.rejection;
    return res;
  }

  // ─── memory tools ──────────────────────────────────────────────────────────

  async memoryIndex(): Promise<string> {
    const index = (await this.store.exists()) ? await this.store.readIndex() : '';
    if (index.trim()) return index;
    return '# Memory index\n\n(empty: no dream has run yet. Save durable learnings with memory_note; run the dream prompt or ask to "dream" to build memory.)\n';
  }

  async memorySearch(query: string, opts: { includeTranscripts?: boolean; limit?: number } = {}): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const pages = (await this.store.exists()) ? await this.store.listPages() : [];
    const hits = searchPages(pages, query, limit).map((h) => ({ ...h, snippet: redact(h.snippet).text }));
    if (!opts.includeTranscripts) return hits;
    const config = await this.store.readConfig();
    const sessions = await this.sessions.list(await this.sessions.enabled(config), { cwd: this.projectDir, limit: 5 });
    const tHits: SearchHit[] = [];
    for (const s of sessions) {
      const loaded = await this.sessions.tryLoad(s.harness, s.id, s.updatedAt);
      if (loaded) tHits.push(...searchTranscripts(loaded.filtered, query, limit));
    }
    tHits.sort((a, b) => b.score - a.score);
    // Transcript text is untrusted and may hold secrets: redact, then wrap in delimiters.
    const wrapped = tHits.slice(0, limit).map((h) => ({
      ...h,
      snippet: wrapUntrustedText('snippet', { ref: h.ref }, redact(h.snippet).text),
    }));
    return [...hits, ...wrapped];
  }

  async memoryRead(name: string): Promise<string | null> {
    const n = String(name ?? '').trim();
    if (n === 'index' || n === 'MEMORY.md') return this.memoryIndex();
    if (!isValidPageName(n)) {
      throw new DreamError('INVALID_PAGE_NAME', `Invalid page name ${JSON.stringify(name)}: use a page slug (see memory_index) or "index".`);
    }
    if (!(await this.store.exists())) return null;
    const page = await this.store.readPage(n);
    if (!page) return null;
    try {
      const state = await this.store.readState();
      state.reads[n] = (state.reads[n] ?? 0) + 1;
      await this.store.writeState(state);
    } catch {
      /* read counters are best effort */
    }
    return this.store.serializePage(page);
  }

  async memoryNote(text: string, source?: NoteEntry['source']): Promise<NoteEntry> {
    if (typeof text !== 'string' || !text.trim()) throw new DreamError('INVALID_OUTPUT', 'memory_note needs non-empty text.');
    await this.ensureInit();
    return this.store.addNote(source ? { text: redact(text.trim()).text, source } : { text: redact(text.trim()).text });
  }

  async memoryStatus(): Promise<MemoryStatus> {
    const initialized = await this.store.exists();
    const config = await this.store.readConfig();
    const available = (await this.sessions.available()).map((a) => a.harness);
    const status: MemoryStatus = {
      initialized,
      dir: this.store.dir,
      pageCount: 0,
      threadCount: 0,
      indexLines: 0,
      indexBytes: 0,
      inboxCount: 0,
      pending: [],
      dueForReverify: [],
      stagedJobs: [],
      activeJobs: [],
      availableHarnesses: available,
      lintIssues: [],
    };
    const state = initialized ? await this.store.readState() : undefined;
    if (initialized && state) {
      const [pages, index, inbox, jobs] = await Promise.all([
        this.store.listPages(),
        this.store.readIndex(),
        this.store.readInbox(),
        this.store.listJobs(),
      ]);
      status.lastRunAt = state.lastRunAt;
      status.pageCount = pages.filter((p) => !isThreadPage(p)).length;
      status.threadCount = pages.length - status.pageCount;
      const st = indexStats(index);
      status.indexLines = st.lines;
      status.indexBytes = st.bytes;
      status.inboxCount = inbox.length;
      status.dueForReverify = dueForReverify(pages, config, this.now());
      status.lintIssues = lintMemory({ pages, index, config, sourceChars: state.sourceChars });
      for (const id of jobs) {
        const j = await this.store.readJob<unknown>(id);
        if (!isJob(j)) continue;
        (j.status === 'staged' ? status.stagedJobs : status.activeJobs).push(id);
      }
    }
    // Pending work: sessions not provably unchanged since the last committed run (see sessionUnchanged).
    // newMessages counts filtered, non-dream messages not yet dreamed (re-offered skipped ranges included);
    // it is -1 (unknown) for changed sessions beyond the first STATUS_READ_LIMIT, which are not read.
    const base: DreamState = state ?? { version: 1, watermarks: {}, sourceChars: 0, reads: {} };
    const sessions = await this.sessions.list(await this.sessions.enabled(config), { cwd: this.projectDir, limit: 20 });
    let reads = 0;
    for (const s of sessions) {
      if (sessionUnchanged(base, s)) continue;
      if (reads >= STATUS_READ_LIMIT) {
        status.pending.push({ harness: s.harness, session: s.id, newMessages: -1, updatedAt: s.updatedAt });
        continue;
      }
      reads++;
      const loaded = await this.sessions.tryLoad(s.harness, s.id, s.updatedAt);
      if (!loaded) continue;
      const fresh = pendingWork(loaded, base, false).messages.length;
      if (fresh > 0) status.pending.push({ harness: s.harness, session: s.id, newMessages: fresh, updatedAt: s.updatedAt });
    }
    return status;
  }

  async listSessions(opts: ListSessionsOptions & { harness?: Harness } = {}): Promise<SessionInfo[]> {
    const config = await this.store.readConfig();
    const adapters = await this.sessions.enabled(config, opts.harness);
    const list = await this.sessions.list(adapters, { cwd: opts.cwd ?? this.projectDir, since: opts.since, limit: opts.limit ?? 20 });
    return list.map(redactTitle);
  }

  async serverInstructions(): Promise<string> {
    const config = await this.store.readConfig();
    const raw = (await this.store.exists()) ? (await this.store.readIndex()).trim() : '';
    if (!raw) return `${SERVER_USAGE}\n\n## Memory index (MEMORY.md)\n(empty: no dream has run yet)`;
    // Memory is data written by earlier sessions (or shipped with a cloned repo): frame it as notes.
    const header = `${SERVER_USAGE}\n\n## Memory index (MEMORY.md)\n${INDEX_FRAMING}\n\n`;
    let { text, truncated } = capIndex(raw, config.indexMaxLines, config.indexMaxBytes);
    const room = SERVER_INSTRUCTIONS_MAX - header.length - INDEX_TRUNCATED_LINE.length - 1;
    if (text.length > SERVER_INSTRUCTIONS_MAX - header.length) {
      const cut = text.slice(0, Math.max(0, room));
      const nl = cut.lastIndexOf('\n');
      text = nl > 0 ? cut.slice(0, nl) : cut;
      truncated = true;
    }
    return truncated ? `${header}${text}\n${INDEX_TRUNCATED_LINE}` : `${header}${text}`;
  }

  // ─── dream protocol ────────────────────────────────────────────────────────

  async dreamBegin(args: BeginArgs = {}): Promise<StepResponse> {
    if (args.resume) return this.resume(args.resume);
    await this.ensureInit();
    await this.withLock(() => this.expireJobs());
    const ctx = await this.planContext();
    const { config, state } = ctx;
    const limitTokens = config.runTokens;
    const all = await this.sessions.enabled(config);
    const pool = args.harness ? all.filter((a) => a.harness === args.harness) : all;

    // 1. Resolve the current thread (primary session). Only sessions of this project are read.
    let primaryInfo: SessionInfo | undefined;
    let primary: LoadedSession | null = null;
    let degradedWhy: string | undefined;
    if (args.session) {
      const listed = await this.sessions.list(pool, { cwd: this.projectDir });
      primaryInfo = listed.find((s) => s.id === args.session);
      if (primaryInfo) {
        primary = await this.sessions.tryLoad(primaryInfo.harness, primaryInfo.id, primaryInfo.updatedAt);
        if (!primary) degradedWhy = `the transcript of ${primaryInfo.harness}:${primaryInfo.id} could not be read`;
      } else {
        primary = await this.sessions.find(pool, args.session);
        if (primary) {
          const p = primary;
          const anywhere = await this.sessions.list(pool.filter((a) => a.harness === p.harness), {});
          const info = anywhere.find((s) => s.id === p.session);
          if (info?.cwd && !samePath(info.cwd, this.projectDir)) {
            throw new DreamError(
              'SESSION_NOT_FOUND',
              `Session "${args.session}" ran in a different project directory; a dream only reads sessions of this project. ` +
                'Call dream_begin without `session` (or with a session listed by dream_sessions).',
            );
          }
          primaryInfo = info;
        } else {
          degradedWhy = `session "${args.session}"${args.harness ? ` (${args.harness})` : ''} was not found in any readable transcript store`;
        }
      }
    } else {
      const recent = await this.sessions.list(pool, { cwd: this.projectDir, limit: 10 });
      const top = recent[0];
      if (!top) {
        degradedWhy = 'no transcript of this project was found in a readable store';
      } else {
        const rival = recent.find((s) => s.harness !== top.harness);
        if (rival && !args.confirm && Math.abs(Date.parse(top.updatedAt) - Date.parse(rival.updatedAt)) <= AMBIGUITY_MS) {
          return {
            jobId: '',
            status: 'needs_confirmation',
            candidates: recent.slice(0, 5).map(redactTitle),
            message:
              'Several sessions from different tools were active within 10 minutes, so the current thread is ambiguous. ' +
              'Next: ask the user which one is this conversation, then call dream_begin again with { session: "<id>", harness: "<harness>" } ' +
              '(or with { confirm: true } to use the most recent one).',
            budget: { usedTokens: 0, limitTokens },
          };
        }
        primaryInfo = top;
        primary = await this.sessions.tryLoad(top.harness, top.id, top.updatedAt);
        if (!primary) degradedWhy = `the transcript of ${top.harness}:${top.id} could not be read`;
      }
    }

    // 2. Plan extraction within the budget: primary first, then other sessions of this project (sessions with
    //    ranges skipped by earlier runs first, then newest first). Every pending range is either handed to the
    //    model or recorded as skipped, so nothing is lost when the budget runs out.
    const extractBudget = Math.floor(limitTokens * EXTRACT_SHARE);
    const instructions = await this.store.readInstructions();
    const overhead = extractOverheadTokens(instructions);
    const cost = (c: Chunk): number => c.tokens + overhead;
    let used = 0;
    let full = false;
    const sessions: JobSession[] = [];
    const selected: Chunk[] = [];
    const log: string[] = [];
    const consider = (loaded: LoadedSession, info: SessionInfo | undefined, isPrimary: boolean): void => {
      const key = `${loaded.harness}:${loaded.session}`;
      const work = pendingWork(loaded, state, isPrimary);
      const wm = state.watermarks[key] ?? -1;
      const reoffer = (c: Chunk): boolean => c.toIdx <= wm;
      const chunks = work.ranges.flatMap((r) =>
        chunkMessages(
          work.messages.filter((m) => m.idx >= r.from && m.idx <= r.to),
          { chunkTokens: config.chunkTokens },
        ),
      );
      const total = chunks.reduce((n, c) => n + cost(c), 0);
      let take: Chunk[];
      if (used + total <= extractBudget) {
        take = chunks;
      } else {
        // Over budget: re-offered ranges first, then the chunks with the most salient messages.
        full = true;
        const ranked = [...chunks].sort(
          (a, b) =>
            Number(reoffer(b)) - Number(reoffer(a)) || b.candidates.length - a.candidates.length || b.toIdx - a.toIdx,
        );
        take = [];
        let room = extractBudget - used;
        for (const c of ranked) {
          if (cost(c) <= room || (selected.length === 0 && take.length === 0)) {
            take.push(c);
            room -= cost(c);
          }
        }
        take.sort((a, b) => a.fromIdx - b.fromIdx);
      }
      used += take.reduce((n, c) => n + cost(c), 0);
      selected.push(...take);
      const left = chunks.filter((c) => !take.includes(c));
      const taken = mergeIdxRanges(take.map((c) => ({ from: c.fromIdx, to: c.toIdx })));
      // A message split over several chunks counts as read only when all its pieces were taken.
      const skipped = mergeIdxRanges(left.map((c) => ({ from: c.fromIdx, to: c.toIdx })));
      if (left.length) {
        log.push(`budget: skipped ${left.length} chunk(s) of ${key} (msgs ${toPairs(skipped).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')}); the next dream re-offers them.`);
      }
      sessions.push({
        harness: loaded.harness,
        session: loaded.session,
        title: info?.title,
        cwd: info?.cwd,
        updatedAt: info?.updatedAt ?? this.now().toISOString(),
        primary: isPrimary,
        fromIdx: work.ranges[0]?.from ?? wm + 1,
        lastIdx: work.lastIdx,
        // Everything up to the raw last idx is read now or recorded in `skipped` (filtered-out messages and the
        // in-flight dream of the current thread count as processed).
        processedTo: work.lastIdx,
        filteredChars: take.reduce((n, c) => n + c.text.length, 0),
        taken: toPairs(taken).filter(([a, b]) => !skipped.some((s) => s.from <= a && b <= s.to)),
        skipped: toPairs(skipped),
      });
    };
    if (primary) consider(primary, primaryInfo, true);
    if ((args.scope ?? 'project') === 'project') {
      const others = (await this.sessions.list(all, { cwd: this.projectDir, since: args.since, limit: MAX_OTHER_SESSIONS + 1 })).filter(
        (info) => !(primary && info.harness === primary.harness && info.id === primary.session) && !sessionUnchanged(state, info),
      );
      const hasSkipped = (info: SessionInfo): number => Number(!!state.skipped?.[`${info.harness}:${info.id}`]?.length);
      others.sort((a, b) => hasSkipped(b) - hasSkipped(a));
      let deferred = 0;
      for (const info of others) {
        if (full) {
          deferred++;
          continue;
        }
        const loaded = await this.sessions.tryLoad(info.harness, info.id, info.updatedAt);
        if (loaded) consider(loaded, info, false);
      }
      if (deferred) log.push(`budget: ${deferred} other session(s) left for the next dream.`);
    }

    // 3. Decide what this run does.
    const notes = await this.store.readInbox();
    const degraded = degradedWhy !== undefined;
    const due = dueForReverify(ctx.pages, config, ctx.now);
    if (selected.length === 0 && notes.length === 0 && !degraded && due.length === 0) {
      return {
        jobId: '',
        status: 'done',
        message:
          'Nothing new to dream about: every session of this project is processed up to its watermark, the inbox is empty and no page is due for re-verification. Memory is up to date; nothing to do. Tell the user memory is current.',
        budget: { usedTokens: 0, limitTokens },
      };
    }

    const job = createJob({
      id: newJobId(ctx.now),
      now: ctx.now,
      dryRun: !!args.dry_run,
      scope: args.scope ?? 'project',
      limitTokens,
      instructions,
    });
    job.sessions = sessions;
    job.notes = notes;
    job.pagesAtBegin = ctx.pages.filter((p) => !isThreadPage(p)).length;
    job.log.push(...log);
    if (degraded) {
      const harness = args.harness ?? primaryInfo?.harness ?? config.harnesses[0] ?? 'claude-code';
      const session = args.session ?? primaryInfo?.id ?? `local-${isoDay(ctx.now).replace(/-/g, '')}`;
      job.primary = { harness, session, degraded: true };
      job.log.push(`degraded: ${degradedWhy}; thread page written from the model's own context (unverified).`);
    } else if (primary) {
      const sess = sessions.find((s) => s.primary);
      const hasNew = !!sess?.taken?.length;
      const threadExists = ctx.pages.some((p) => p.name === threadPageName(primary.harness, primary.session));
      if (hasNew || !threadExists) job.primary = { harness: primary.harness, session: primary.session };
    }
    buildExtractSteps(job, selected, notes, degraded);
    if (job.steps.length === 0) await advance(job, ctx);
    refreshTotal(job);
    if (job.steps.length === 0) {
      return {
        jobId: '',
        status: 'done',
        message:
          'Nothing new to dream about: no new transcript messages or notes, and the pages due for re-verification have no matching transcript material. Memory is unchanged; nothing to do. Tell the user memory is current.',
        budget: { usedTokens: 0, limitTokens },
      };
    }
    chargeBudget(job);

    const intro: string[] = [`Dream job ${job.id} started${job.dryRun ? ' (dry run: nothing will be written)' : ''}.`];
    const primaryText = job.primary ? `${job.primary.harness}:${job.primary.session}` : primary ? `${primary.harness}:${primary.session}` : '';
    if (primaryText) intro.push(`Current thread: ${primaryText}.`);
    if (degraded) {
      intro.push(
        `No transcript is available (${degradedWhy}), so this run works from inbox notes, existing pages and your own context; the thread page will be marked unverified.`,
      );
    }
    const otherCount = sessions.filter((s) => !s.primary && s.taken?.length).length;
    if (otherCount) intro.push(`Also reading ${otherCount} other session(s) of this project.`);
    if (log.length) intro.push(log.join(' '));
    const unfinished: string[] = [];
    for (const id of await this.store.listJobs()) {
      const other = await this.store.readJob<unknown>(id);
      if (isJob(other) && other.status === 'step') unfinished.push(id);
    }
    if (unfinished.length) {
      intro.push(`(Unfinished older job(s): ${unfinished.slice(0, 3).join(', ')}; resume one with dream_begin { resume } if this new job was not intended.)`);
    }
    await this.withLock(() => this.saveJob(job));
    return this.respond(job, { prefix: intro.join(' ') });
  }

  private async resume(jobId: string): Promise<StepResponse> {
    const job = await this.loadJob(jobId);
    if (job.status === 'step' && !currentStep(job)) {
      return this.withLock(async () => {
        const fresh = await this.loadJob(jobId);
        await advance(fresh, await this.planContext());
        chargeBudget(fresh);
        await this.saveJob(fresh);
        return this.respond(fresh, { prefix: `Resumed job ${jobId}.` });
      });
    }
    return this.respond(job, { prefix: `Resumed job ${jobId}.` });
  }

  async dreamStep(jobId: string, output: unknown): Promise<StepResponse> {
    return this.withLock(async () => {
      const job = await this.loadJob(jobId);
      if (job.status === 'staged') throw new DreamError('JOB_STATE', stagedMessage(job.id));
      if (job.status === 'ready_to_commit') return this.respond(job, { prefix: 'All steps are already done.' });
      const ctx = await this.planContext();
      const step = currentStep(job);
      if (!step) {
        await advance(job, ctx);
        chargeBudget(job);
        await this.saveJob(job);
        return this.respond(job);
      }
      const index = job.cursor + 1;
      const norm = normalizeOutput(output);
      const echoed = isRecord(norm) && typeof norm['step'] === 'number' ? norm['step'] : undefined;
      if (echoed === undefined) {
        return this.respond(job, {
          rejection: {
            reason: 'output.step is missing',
            details: [`Include "step": ${index} in output (the current step index, StepSpec.index); it makes a retried submission safe.`],
          },
        });
      }
      if (echoed !== index) {
        const why =
          echoed < index
            ? `Step ${echoed} was already accepted (nothing was applied twice); the current step is ${index}.`
            : `output.step is ${echoed} but the current step is ${index}; nothing was applied.`;
        return this.respond(job, { prefix: why });
      }
      const parsed = parseStepOutput(step.name, norm);
      if (!parsed.ok) {
        return this.respond(job, { rejection: { reason: 'output does not match outputSchema', details: parsed.issues } });
      }
      const res = await acceptOutput(job, step, parsed.value, ctx);
      if (res.issues.length) {
        return this.respond(job, { rejection: { reason: 'output failed validation', details: res.issues } });
      }
      job.cursor++;
      await advance(job, ctx);
      chargeBudget(job);
      await this.saveJob(job);
      return this.respond(job, { prefix: `Step ${index} accepted.${res.note ? ` ${res.note}` : ''}` });
    });
  }

  async dreamCommit(jobId: string): Promise<CommitResult> {
    return this.withLock(async () => {
      const job = await this.loadJob(jobId);
      if (job.status === 'staged') throw new DreamError('JOB_STATE', stagedMessage(job.id));
      if (job.status !== 'ready_to_commit') {
        const step = currentStep(job);
        throw new DreamError(
          'JOB_STATE',
          `Job ${job.id} is not ready to commit: step ${job.cursor + 1} (${step?.label ?? 'pending'}) is still open. ` +
            `Finish it with dream_step, or call dream_begin with { resume: "${job.id}" } to see it again.`,
        );
      }
      const ctx = await this.planContext();
      const [inbox, logText] = await Promise.all([
        this.store.readInbox(),
        readFile(path.join(this.store.dir, 'log.md'), 'utf8').catch(() => ''),
      ]);
      const built = buildChanges({
        job,
        store: this.store,
        config: ctx.config,
        state: ctx.state,
        basePages: ctx.pages,
        baseIndex: ctx.index,
        inbox,
        logText,
        now: ctx.now,
      });
      const base = { jobId: job.id, summary: built.summary, index: built.index, threadPage: built.threadPage };
      if (job.dryRun) {
        await this.store.deleteJob(job.id);
        return {
          ...base,
          outcome: 'dry_run',
          message: `Dry run: nothing was written. Would have: ${summaryText(built.summary)}${lintText(built.lint)} Run dream again without dry_run to apply.`,
        };
      }
      if (built.stageReason) {
        const staged: StagedChanges = {
          changes: built.changes,
          summary: built.summary,
          index: built.index,
          threadPage: built.threadPage,
          reason: built.stageReason,
          baseRun: (await this.store.listRuns(1))[0]?.id,
          stagedAt: ctx.now.toISOString(),
        };
        job.status = 'staged';
        job.staged = staged;
        await this.saveJob(job);
        return {
          ...base,
          outcome: 'staged',
          stagedReason: built.stageReason,
          message:
            `Changes staged, not applied: ${built.stageReason}. Staged: ${summaryText(built.summary)} ` +
            `Show the user, then call dream_review with { job_id: "${job.id}", action: "show" }, then "approve" or "reject".`,
        };
      }
      const run = await this.store.applyChanges(built.changes, `dream: ${commitLine(built.summary)} (${job.id})`);
      await this.store.deleteJob(job.id);
      return {
        ...base,
        outcome: 'applied',
        run,
        message: `Dream applied as run ${run.id.slice(0, 12)}: ${summaryText(built.summary)}${lintText(built.lint)} ${SAVED_SUFFIX}`,
      };
    });
  }

  async dreamReview(args: { jobId?: string; action: 'show' | 'approve' | 'reject' }): Promise<ReviewResult> {
    const job = await this.findStaged(args.jobId);
    const staged = job.staged as StagedChanges;
    if (args.action === 'show') {
      return {
        jobId: job.id,
        action: 'show',
        diff: await changesDiff(this.store.dir, staged.changes),
        message:
          `Staged because: ${staged.reason}. Changes: ${summaryText(staged.summary)} ` +
          `Show the diff to the user, then call dream_review with { job_id: "${job.id}", action: "approve" } or "reject".`,
      };
    }
    return this.withLock(async () => {
      const fresh = await this.findStaged(job.id);
      const st = fresh.staged as StagedChanges;
      if (args.action === 'reject') {
        await this.store.deleteJob(fresh.id);
        return {
          jobId: fresh.id,
          action: 'reject',
          message: 'Staged changes discarded; memory is unchanged and watermarks did not move, so the next dream re-reads these messages. Tell the user nothing was changed.',
        };
      }
      const latest = (await this.store.listRuns(1))[0]?.id;
      if (st.baseRun && latest && latest !== st.baseRun) {
        throw new DreamError(
          'JOB_STATE',
          `Memory changed since these changes were staged (latest run ${latest.slice(0, 12)}). Reject them with dream_review { job_id: "${fresh.id}", action: "reject" } and dream again.`,
        );
      }
      const changes = await this.refreshStaged(fresh, st);
      const run = await this.store.applyChanges(changes, `dream: ${commitLine(st.summary)} (${fresh.id}, reviewed)`);
      await this.store.deleteJob(fresh.id);
      const commit: CommitResult = {
        jobId: fresh.id,
        outcome: 'applied',
        run,
        summary: st.summary,
        index: st.index,
        threadPage: st.threadPage,
        message: `Approved changes applied as run ${run.id.slice(0, 12)}: ${summaryText(st.summary)} ${SAVED_SUFFIX}`,
      };
      return { jobId: fresh.id, action: 'approve', commit, message: commit.message };
    });
  }

  /**
   * Staged changes with state.json and inbox.jsonl recomputed against the current files: notes saved and pages
   * read after staging are kept (current inbox minus the notes this job consumed; current state plus this
   * job's watermarks/seen/skipped).
   */
  private async refreshStaged(job: Job, st: StagedChanges): Promise<FileChange[]> {
    const [inbox, state] = await Promise.all([this.store.readInbox(), this.store.readState()]);
    const out = st.changes.filter((c) => c.path !== 'state.json' && c.path !== 'inbox.jsonl');
    const newState = nextState(state, job, { renamed: st.summary.renamed, deleted: st.summary.deleted, now: this.now() });
    out.push({ type: 'write', path: 'state.json', content: stateText(newState) });
    if (job.notes.length > 0) out.push({ type: 'write', path: 'inbox.jsonl', content: redact(inboxText(inbox, job)).text });
    return out;
  }

  private async findStaged(jobId?: string): Promise<Job> {
    if (jobId) {
      const job = await this.store.readJob<unknown>(jobId);
      if (isJob(job) && job.status === 'staged' && job.staged) return job;
      throw new DreamError('NOTHING_STAGED', `Job ${jobId} has no staged changes. memory_status lists staged jobs.`);
    }
    if (await this.store.exists()) {
      let best: Job | undefined;
      for (const id of await this.store.listJobs()) {
        const j = await this.store.readJob<unknown>(id);
        if (isJob(j) && j.status === 'staged' && j.staged && (!best || (best.staged?.stagedAt ?? '') < j.staged.stagedAt)) best = j;
      }
      if (best) return best;
    }
    throw new DreamError('NOTHING_STAGED', 'There are no staged dream changes to review.');
  }

  async dreamRollback(runId?: string): Promise<RunRecord> {
    return this.withLock(() => this.store.rollback(runId));
  }

  /** Effective configuration (for diagnostics/tests). */
  readConfig(): Promise<DreamConfig> {
    return this.store.readConfig();
  }
}

function summaryText(s: ChangeSummary): string {
  const parts: string[] = [];
  const list = (label: string, xs: string[]): void => {
    if (xs.length) parts.push(`${label} ${xs.join(', ')}`);
  };
  list('created', s.created);
  list('updated', s.updated);
  list('deleted', s.deleted);
  if (s.renamed.length) parts.push(`renamed ${s.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}`);
  if (s.corrections.length) {
    parts.push(
      `corrections: ${s.corrections
        .map(
          (c) =>
            `${c.page} ${c.verdict}${c.corrected ? ` → "${c.corrected}"` : ''}${c.source ? ` (${refText(c.source)})` : ''}` +
            (c.quote ? `, evidence:\n${quoteBlock(c.quote, c.source)}\n` : ''),
        )
        .join('; ')}`,
    );
  }
  parts.push(`index ${s.indexLines} lines / ${s.indexBytes} bytes`);
  return `${parts.join('; ')}.`;
}

function commitLine(s: ChangeSummary): string {
  return `+${s.created.length} ~${s.updated.length} -${s.deleted.length} pages, ${s.corrections.length} correction(s)`;
}

function lintText(issues: LintIssue[]): string {
  if (issues.length === 0) return '';
  const shown = issues.slice(0, 5).map((i) => i.message).join(' ');
  return ` Lint: ${issues.length} issue(s) left for the next dream: ${shown}${issues.length > 5 ? ' …' : ''}`;
}
