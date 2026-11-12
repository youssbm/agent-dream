/**
 * Turning a finished job into file changes.
 *
 * `projectPages` replays the job's verdicts and page ops over the current pages (pure, in memory); the
 * planner uses it for gap-fill/thread/promote inputs and validation, and `buildChanges` uses it to produce
 * the `FileChange[]`, the `ChangeSummary`, the new state/log/inbox, and the safety-net decision.
 */
import type {
  ChangeSummary,
  Confidence,
  DreamConfig,
  DreamState,
  FileChange,
  IMemoryStore,
  LintIssue,
  NoteEntry,
  Page,
  PageOp,
  SourceRef,
} from '../types.ts';
import { extractLinks, threadPageName } from '../store/frontmatter.ts';
import { redact } from '../quality/redact.ts';
import { lintMemory, indexStats } from '../quality/lint.ts';
import { similarity } from '../quality/similarity.ts';
import { neutralizeUntrusted } from '../transcripts/chunk.ts';
import type { Job, StoredClaim, StoredVerdict } from './job.ts';
import { refText } from './render.ts';

/** Result of replaying a job over the current pages. */
export interface Projection {
  /** Final pages (normal + thread) keyed by name. */
  pages: Map<string, Page>;
  base: Map<string, Page>;
  created: string[];
  /** Pages removed (merged-away pages included, rename sources excluded). */
  deleted: string[];
  renamed: { from: string; to: string }[];
  /** Pages written or re-verified by this run. */
  touched: Set<string>;
  threadPage?: string;
}

/** True for pages stored under threads/. */
export function isThreadPage(p: Page): boolean {
  return p.meta.kind === 'thread' || p.name.startsWith('thread-');
}

function clonePage(p: Page): Page {
  return { name: p.name, body: p.body, meta: { ...p.meta, sources: p.meta.sources.map((s) => ({ ...s })), links: [...p.meta.links] } };
}

/** Union of source refs, keeping first-seen order, deduplicated by harness/session/msgs. */
export function mergeSources(...lists: SourceRef[][]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const list of lists) {
    for (const s of list) {
      const key = refText(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ harness: s.harness, session: s.session, msgs: s.msgs });
    }
  }
  return out;
}

function range(msgs: string): { from: number; to: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(msgs);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return { from, to };
}

/** True when two refs point at overlapping messages of the same session. */
export function sourcesOverlap(a: SourceRef, b: SourceRef): boolean {
  if (a.harness !== b.harness || a.session !== b.session) return false;
  const ra = range(a.msgs);
  const rb = range(b.msgs);
  if (!ra || !rb) return false;
  return ra.from <= rb.to && rb.from <= ra.to;
}

/** Claims a page op relies on: the outline's claim ids for that page plus claims sharing a source span. */
export function relevantClaims(op: Pick<PageOp, 'page' | 'sources'>, job: Job): StoredClaim[] {
  const ids = new Set<string>();
  for (const t of job.results.targets) if (t.page === op.page || t.into === op.page) for (const id of t.claims ?? []) ids.add(id);
  return job.results.claims.filter(
    (c) => ids.has(c.id) || c.sources.some((cs) => op.sources.some((os) => sourcesOverlap(cs, os))),
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite `[[from]]` / `[[from|label]]` links to point at `to`. */
export function rewriteLinks(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`\\[\\[\\s*${escapeRe(from)}\\s*(\\||\\]\\])`, 'g'), (_m, tail: string) => `[[${to}${tail}`);
}

function titleFromName(name: string): string {
  const t = name.replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function lastVerdict(verdicts: StoredVerdict[], page: string): StoredVerdict | undefined {
  for (let i = verdicts.length - 1; i >= 0; i--) if (verdicts[i]?.page === page) return verdicts[i];
  return undefined;
}

/**
 * Replay verdicts, write ops, gap-fill ops and the thread page over `basePages`.
 * Pure: never touches disk. `today` is YYYY-MM-DD.
 */
export function projectPages(
  basePages: Page[],
  job: Job,
  today: string,
  opts: { includeGapOps?: boolean; includeThread?: boolean; appendCorrections?: boolean } = {},
): Projection {
  const base = new Map(basePages.map((p) => [p.name, p]));
  const pages = new Map(basePages.map((p) => [p.name, clonePage(p)]));
  const created = new Set<string>();
  const deleted = new Set<string>();
  const renamed: { from: string; to: string }[] = [];
  const touched = new Set<string>();

  // Verdicts: confidence / verified_at / evidence sources. A keep without (checked) evidence changes nothing.
  for (const v of job.results.verdicts) {
    const p = pages.get(v.page);
    if (!p) continue;
    if ((v.verdict === 'keep' || v.verdict === 'correct') && v.evidence) {
      p.meta.confidence = 'verified';
      p.meta.verified_at = today;
      if (v.evidence) p.meta.sources = mergeSources(p.meta.sources, [v.evidence.source]);
      touched.add(p.name);
    } else if (v.verdict === 'unverified') {
      p.meta.confidence = 'unverified';
      touched.add(p.name);
    }
  }

  const renameEverywhere = (from: string, to: string): void => {
    for (const p of pages.values()) {
      const body = rewriteLinks(p.body, from, to);
      if (body !== p.body) {
        p.body = body;
        p.meta.links = extractLinks(body);
        touched.add(p.name);
      }
    }
  };

  const remove = (name: string): void => {
    pages.delete(name);
    if (created.has(name)) created.delete(name);
    else if (base.has(name)) deleted.add(name);
  };

  /**
   * Written pages are verified only when the op cites at least one source of this job (checked in range by
   * validation) or the page has a verdict with checked evidence, and none of the claims it relies on failed
   * its verbatim check.
   */
  const confidenceFor = (op: PageOp, name: string): Confidence => {
    if (relevantClaims(op, job).some((c) => c.verbatimFailed)) return 'unverified';
    if (op.meta?.confidence === 'unverified') return 'unverified';
    const v = lastVerdict(job.results.verdicts, name) ?? lastVerdict(job.results.verdicts, op.page);
    if (v?.verdict === 'unverified') return 'unverified';
    const evidenced = !!v && (v.verdict === 'keep' || v.verdict === 'correct') && !!v.evidence;
    return op.sources.length > 0 || evidenced ? 'verified' : 'unverified';
  };

  const writeBody = (op: PageOp, name: string, body: string, extraSources: SourceRef[] = []): void => {
    const existing = pages.get(name);
    const sources = mergeSources(existing?.meta.sources ?? [], extraSources, op.sources);
    const confidence = confidenceFor(op, name);
    const page: Page = {
      name,
      body: body.replace(/\r\n/g, '\n').trim() + '\n',
      meta: {
        title: op.meta?.title ?? existing?.meta.title ?? titleFromName(name),
        kind: op.meta?.kind ?? existing?.meta.kind ?? 'fact',
        volatile: op.meta?.volatile ?? existing?.meta.volatile ?? false,
        confidence,
        verified_at: confidence === 'verified' ? today : existing?.meta.verified_at,
        sources,
        links: [],
      },
    };
    if (page.meta.verified_at === undefined) delete page.meta.verified_at;
    page.meta.links = extractLinks(page.body);
    if (!existing) {
      if (deleted.has(name)) deleted.delete(name);
      else if (!base.has(name)) created.add(name);
    }
    pages.set(name, page);
    touched.add(name);
  };

  const ops = [...job.results.ops, ...(opts.includeGapOps === false ? [] : job.results.gapOps)];
  for (const op of ops) {
    switch (op.op) {
      case 'create':
      case 'update':
        writeBody(op, op.page, op.body ?? pages.get(op.page)?.body ?? '');
        break;
      case 'delete':
        remove(op.page);
        break;
      case 'rename': {
        const src = pages.get(op.page);
        if (!src || !op.into || pages.has(op.into)) break;
        const moved = clonePage(src);
        moved.name = op.into;
        pages.delete(op.page);
        pages.set(op.into, moved);
        if (created.has(op.page)) {
          created.delete(op.page);
          created.add(op.into);
        } else {
          renamed.push({ from: op.page, to: op.into });
        }
        touched.add(op.into);
        renameEverywhere(op.page, op.into);
        break;
      }
      case 'merge': {
        if (!op.into) break;
        const src = pages.get(op.page);
        writeBody(op, op.into, op.body ?? pages.get(op.into)?.body ?? '', src?.meta.sources ?? []);
        remove(op.page);
        renameEverywhere(op.page, op.into);
        break;
      }
    }
  }

  // Corrections the model never rewrote: record the corrected statement in the page (final build only).
  for (const v of opts.appendCorrections ? job.results.verdicts : []) {
    if (v.verdict !== 'correct' || !v.corrected) continue;
    const p = pages.get(v.page);
    if (!p) continue;
    const rewritten = ops.some((o) => (o.page === v.page || o.into === v.page) && o.op !== 'delete');
    if (!rewritten) {
      p.body = `${p.body.trimEnd()}\n\nCorrection (${today}): ${v.corrected}\n`;
      touched.add(p.name);
    }
  }

  let threadPage: string | undefined;
  if (job.primary && job.results.thread && opts.includeThread !== false) {
    threadPage = threadPageName(job.primary.harness, job.primary.session);
    const sess = job.sessions.find((s) => s.primary);
    const existing = pages.get(threadPage);
    // Sources: exactly the ranges handed to the model in this job.
    const src: SourceRef[] = sess
      ? (sess.taken ?? []).map(([from, to]) => ({ harness: sess.harness, session: sess.session, msgs: from === to ? `${from}` : `${from}-${to}` }))
      : [];
    const body = job.results.thread.body.replace(/\r\n/g, '\n').trim() + '\n';
    const page: Page = {
      name: threadPage,
      body,
      meta: {
        // Never default to the harness session title: it is untrusted text.
        title: job.results.thread.title ?? existing?.meta.title ?? `Thread state ${today}`,
        kind: 'thread',
        volatile: true,
        confidence:
          !job.primary.degraded && (src.length > 0 || (existing?.meta.sources.length ?? 0) > 0) ? 'verified' : 'unverified',
        verified_at: today,
        sources: mergeSources(existing?.meta.sources ?? [], src),
        links: extractLinks(body),
      },
    };
    if (page.meta.confidence === 'unverified') delete page.meta.verified_at;
    if (!existing && !base.has(threadPage)) created.add(threadPage);
    pages.set(threadPage, page);
    touched.add(threadPage);
  }

  return { pages, base, created: [...created], deleted: [...deleted], renamed, touched, threadPage };
}

/** Everything `dream_commit` needs to write. */
export interface BuildInput {
  job: Job;
  store: IMemoryStore;
  config: DreamConfig;
  state: DreamState;
  basePages: Page[];
  baseIndex: string;
  inbox: NoteEntry[];
  /** Current log.md content ('' when missing). */
  logText: string;
  now: Date;
}

export interface BuildOutput {
  changes: FileChange[];
  summary: ChangeSummary;
  index: string;
  threadPage?: string;
  lint: LintIssue[];
  /** Set when auto-apply must fall back to staging. */
  stageReason?: string;
  newState: DreamState;
  redactions: number;
}

/** YYYY-MM-DD of a date (UTC). */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * State after committing `job` on top of `base`: watermarks advance to each planned session's processed end,
 * skipped ranges are replaced by the job's (removed when empty), `seen` records the session's last raw idx and
 * updatedAt, read counters follow renames/deletions. `reads` (optional) are merged in by max per page.
 */
export function nextState(
  base: DreamState,
  job: Job,
  opts: { renamed: { from: string; to: string }[]; deleted: string[]; now: Date; reads?: Record<string, number> },
): DreamState {
  const watermarks = { ...base.watermarks };
  const skipped: Record<string, [number, number][]> = { ...(base.skipped ?? {}) };
  const seen: Record<string, { lastIdx: number; updatedAt: string }> = { ...(base.seen ?? {}) };
  let addedChars = 0;
  for (const s of job.sessions) {
    if (s.taken === undefined || s.processedTo < 0) continue; // evidence-only session
    const key = `${s.harness}:${s.session}`;
    watermarks[key] = Math.max(watermarks[key] ?? -1, s.processedTo);
    if (s.skipped?.length) skipped[key] = s.skipped.map(([a, b]) => [a, b] as [number, number]);
    else delete skipped[key];
    seen[key] = { lastIdx: s.lastIdx, updatedAt: s.updatedAt };
    addedChars += s.filteredChars;
  }
  const reads = { ...base.reads };
  for (const [k, n] of Object.entries(opts.reads ?? {})) reads[k] = Math.max(reads[k] ?? 0, n);
  for (const r of opts.renamed) {
    if (reads[r.from] !== undefined) {
      reads[r.to] = (reads[r.to] ?? 0) + (reads[r.from] ?? 0);
      delete reads[r.from];
    }
  }
  for (const d of opts.deleted) delete reads[d];
  const out: DreamState = {
    version: 1,
    watermarks,
    sourceChars: base.sourceChars + addedChars,
    lastRunAt: opts.now.toISOString(),
    reads,
  };
  if (Object.keys(seen).length) out.seen = seen;
  if (Object.keys(skipped).length) out.skipped = skipped;
  return out;
}

/** state.json content. */
export function stateText(state: DreamState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** inbox.jsonl content after removing the notes the job consumed from `inbox` (the current inbox). */
export function inboxText(inbox: NoteEntry[], job: Job): string {
  const consumed = new Set(job.notes.map((n) => n.id));
  const remaining = inbox.filter((n) => !consumed.has(n.id));
  return remaining.map((n) => JSON.stringify(n)).join('\n') + (remaining.length ? '\n' : '');
}

/** Build the full change set for a finished job. Pure apart from `store.pagePath/serializePage`. */
export function buildChanges(input: BuildInput): BuildOutput {
  const { job, store, config, state, basePages, baseIndex, inbox, now } = input;
  const today = isoDay(now);
  const proj = projectPages(basePages, job, today, { appendCorrections: true });
  const index = job.results.index ?? baseIndex;

  // Changes for pages.
  const writes: FileChange[] = [];
  const deletes: FileChange[] = [];
  const updated: string[] = [];
  let redactions = 0;
  const write = (path: string, content: string): void => {
    const r = redact(content);
    redactions += r.count;
    writes.push({ type: 'write', path, content: r.text });
  };
  for (const [name, page] of proj.pages) {
    const before = proj.base.get(name);
    const text = store.serializePage(page);
    if (before && store.serializePage(before) === text) continue;
    write(store.pagePath(name), text);
    if (before) updated.push(name);
  }
  for (const name of proj.base.keys()) {
    if (!proj.pages.has(name)) deletes.push({ type: 'delete', path: store.pagePath(name) });
  }
  if (index !== baseIndex) write('MEMORY.md', index.endsWith('\n') ? index : `${index}\n`);

  // State.
  const newState = nextState(state, job, { renamed: proj.renamed, deleted: proj.deleted, now });
  write('state.json', stateText(newState));

  // Inbox.
  if (job.notes.length > 0) write('inbox.jsonl', inboxText(inbox, job));

  // Summary.
  const stats = indexStats(index);
  const corrections: ChangeSummary['corrections'] = job.results.verdicts
    .filter((v) => v.verdict === 'correct' || v.verdict === 'delete')
    .map((v) => {
      const c: ChangeSummary['corrections'][number] = { page: v.page, verdict: v.verdict };
      if (v.evidence) {
        c.quote = redact(v.evidence.quote).text;
        c.source = v.evidence.source;
      }
      if (v.corrected) c.corrected = redact(v.corrected).text;
      return c;
    });
  const summary: ChangeSummary = {
    created: proj.created.sort(),
    updated: updated.filter((n) => !proj.created.includes(n)).sort(),
    deleted: proj.deleted.sort(),
    renamed: proj.renamed,
    corrections,
    indexLines: stats.lines,
    indexBytes: stats.bytes,
  };

  // Lint on the final state.
  const lint = lintMemory({ pages: [...proj.pages.values()], index, config, sourceChars: newState.sourceChars });

  // Log entry (part of the same commit).
  const entry = logEntry(job, summary, lint, now);
  write('log.md', `${input.logText.trimEnd()}${input.logText.trim() ? '\n\n' : ''}${entry}\n`);

  // Safety net.
  let stageReason: string | undefined;
  if (config.applyMode === 'review') {
    stageReason = 'review mode is on (config.json applyMode = "review")';
  } else {
    const existing = basePages.filter((p) => !isThreadPage(p));
    if (existing.length >= config.safetyNetMinPages && existing.length > 0) {
      let changed = 0;
      for (const p of existing) {
        const after = proj.pages.get(p.name);
        if (!after) {
          if (!proj.renamed.some((r) => r.from === p.name)) changed++;
        } else if (similarity(p.body, after.body) < 0.5) {
          changed++;
        }
      }
      const ratio = changed / existing.length;
      if (ratio > config.safetyNetRatio) {
        stageReason =
          `safety net: this run would delete or rewrite ${changed} of ${existing.length} existing pages ` +
          `(${Math.round(ratio * 100)}% > ${Math.round(config.safetyNetRatio * 100)}%)`;
      }
    }
  }

  return {
    changes: [...deletes, ...writes],
    summary,
    index,
    threadPage: proj.threadPage,
    lint,
    stageReason,
    newState,
    redactions,
  };
}

function logEntry(job: Job, s: ChangeSummary, lint: LintIssue[], now: Date): string {
  const lines: string[] = [`## ${now.toISOString().slice(0, 16).replace('T', ' ')}Z — dream ${job.id}`];
  const rangesText = (rs: [number, number][]): string => rs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
  const sess = job.sessions
    .filter((x) => x.taken?.length)
    .map((x) => `${x.harness}:${x.session} (msgs ${rangesText(x.taken ?? [])})`);
  lines.push(`- sessions: ${sess.length ? sess.join(', ') : 'none'}`);
  const left = job.sessions.filter((x) => x.skipped?.length).map((x) => `${x.harness}:${x.session} (msgs ${rangesText(x.skipped ?? [])})`);
  if (left.length) lines.push(`- left for the next dream (budget): ${left.join(', ')}`);
  const counts = new Map<string, number>();
  for (const v of job.results.verdicts) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  const vtext = [...counts].map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  lines.push(`- claims: ${job.results.claims.length}; verdicts: ${vtext}; patterns: ${job.results.patterns.length}; notes consumed: ${job.notes.length}`);
  const list = (xs: string[]): string => (xs.length ? xs.join(', ') : '-');
  lines.push(`- created: ${list(s.created)}; updated: ${list(s.updated)}; deleted: ${list(s.deleted)}`);
  if (s.renamed.length) lines.push(`- renamed: ${s.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}`);
  if (s.corrections.length) {
    lines.push('- corrections:');
    for (const c of s.corrections) {
      lines.push(`  - ${c.page}: ${c.verdict}${c.corrected ? ` → ${c.corrected.replace(/\s+/g, ' ')}` : ''}${c.source ? ` (${refText(c.source)})` : ''}`);
      // Evidence is transcript text (untrusted): a marked blockquote, never inline prose.
      if (c.quote) lines.push(`    > [untrusted transcript quote] ${neutralizeUntrusted(c.quote.replace(/\s+/g, ' ').trim())}`);
    }
  }
  for (const l of job.log) lines.push(`- ${l}`);
  lines.push(`- index: ${s.indexLines} lines, ${s.indexBytes} bytes; lint issues: ${lint.length}`);
  return lines.join('\n');
}
