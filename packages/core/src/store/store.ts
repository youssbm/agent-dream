/**
 * The durable memory folder `<project>/.dream/`.
 *
 * Layout:
 * ```
 * .dream/
 *   MEMORY.md     capped index
 *   pages/        normal pages  (<name>.md)
 *   threads/      thread pages  (thread-<harness>-<session>.md)
 *   dream.md      user-editable guidance for dreaming
 *   log.md        append-only run log
 *   config.json   settings (written on init only when missing)
 *   state.json    watermarks, read counters
 *   inbox.jsonl   in-session notes
 *   .cache/ .jobs/ .lock .snapshots/   (git-ignored)
 * ```
 */
import { randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, DreamError, HARNESSES } from '../types.ts';
import type {
  DreamConfig,
  DreamState,
  FileChange,
  Harness,
  IMemoryStore,
  LockHandle,
  NoteEntry,
  Page,
  RunRecord,
} from '../types.ts';
import { loadConfig, CONFIG_FILE } from './config.ts';
import { isValidPageName, parsePage, serializePage as serializePageMd } from './frontmatter.ts';
import { createHistory } from './history.ts';
import type { History } from './history.ts';
import { acquireLock, DEFAULT_LOCK_TTL_MS } from './lock.ts';
import { assertNotLink, checkDreamRoot, ensureSafeDir } from './safepath.ts';

/** Name of the memory folder inside a project. */
export const DREAM_DIR_NAME = '.dream';

/** Default `MEMORY.md` written on init. */
export const DEFAULT_INDEX = '# Memory index\n\nMaintained by agent-dream: one line per entry, each linking to a page.\n';

/** Default `dream.md` written on init. */
export const DEFAULT_INSTRUCTIONS = `# What matters in this project's memory

Edit this file to steer what dreaming keeps. Keep it short.

- Decisions and why they were made, including the alternatives that were rejected.
- Traps and failed approaches, so they are not tried again.
- Commands, setup steps and conventions that are not obvious from the repository.
- The user's preferences about how work should be done.
- Skip anything that can be re-derived quickly from the code, git history or docs.
`;

/** Default `log.md` written on init. */
export const DEFAULT_LOG = '# Dream log\n';

/** Contents of `.dream/.gitignore`. */
export const DREAM_GITIGNORE_LINES = ['.cache/', '.jobs/', '.lock', '.lock.*', '.snapshots/'] as const;

/** A fresh empty state. */
export function defaultState(): DreamState {
  return { version: 1, watermarks: {}, sourceChars: 0, reads: {} };
}

const TOP_LEVEL_FILES = new Set(['MEMORY.md', 'state.json', 'log.md', 'inbox.jsonl']);
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const THREAD_NAME_RE = new RegExp(`^thread-(?:${HARNESSES.join('|')})-`);

export interface MemoryStoreOptions {
  /** Clock (tests). */
  now?: () => Date;
  /** Force the history backend: true = git, false = snapshots. Default: git when available. */
  git?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return null;
    throw err;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Write a file only if it does not exist yet (race-safe). */
async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: 'wx' });
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
  }
}

/** Rename with a few retries for transient Windows sharing violations. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const c = errCode(err);
      if (i >= 5 || (c !== 'EPERM' && c !== 'EBUSY' && c !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Own entries of a record, minus keys that would be unsafe to assign on a plain object. */
function safeEntries(r: Record<string, unknown>): [string, unknown][] {
  return Object.entries(r).filter(([k]) => k !== '__proto__');
}

/**
 * Sanitize a parsed state.json into a DreamState (defaults for anything invalid). The optional `seen` and
 * `skipped` maps are kept (validated) when present and omitted when absent, so older state files keep loading.
 */
export function sanitizeState(raw: unknown): DreamState {
  const s = defaultState();
  if (!isRecord(raw)) return s;
  if (isRecord(raw['watermarks'])) {
    for (const [k, v] of safeEntries(raw['watermarks'])) {
      if (isFiniteNumber(v)) s.watermarks[k] = v;
    }
  }
  if (isFiniteNumber(raw['sourceChars']) && raw['sourceChars'] >= 0) {
    s.sourceChars = raw['sourceChars'];
  }
  if (typeof raw['lastRunAt'] === 'string') s.lastRunAt = raw['lastRunAt'];
  if (isRecord(raw['reads'])) {
    for (const [k, v] of safeEntries(raw['reads'])) {
      if (isFiniteNumber(v)) s.reads[k] = v;
    }
  }
  if (isRecord(raw['seen'])) {
    const seen: NonNullable<DreamState['seen']> = {};
    for (const [k, v] of safeEntries(raw['seen'])) {
      if (isRecord(v) && isFiniteNumber(v['lastIdx']) && typeof v['updatedAt'] === 'string') {
        seen[k] = { lastIdx: v['lastIdx'], updatedAt: v['updatedAt'] };
      }
    }
    s.seen = seen;
  }
  if (isRecord(raw['skipped'])) {
    const skipped: NonNullable<DreamState['skipped']> = {};
    for (const [k, v] of safeEntries(raw['skipped'])) {
      if (!Array.isArray(v)) continue;
      const ranges: [number, number][] = [];
      for (const r of v as unknown[]) {
        if (Array.isArray(r) && r.length === 2 && isFiniteNumber(r[0]) && isFiniteNumber(r[1])) ranges.push([r[0], r[1]]);
      }
      skipped[k] = ranges;
    }
    s.skipped = skipped;
  }
  return s;
}

/** Serialize inbox entries as JSON lines ('' when empty). */
function serializeInbox(entries: NoteEntry[]): string {
  return entries.length === 0 ? '' : entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

async function readBufferOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
}

function parseNote(line: string): NoteEntry | null {
  try {
    const v: unknown = JSON.parse(line);
    if (!isRecord(v) || typeof v['id'] !== 'string' || typeof v['ts'] !== 'string' || typeof v['text'] !== 'string') {
      return null;
    }
    const note: NoteEntry = { id: v['id'], ts: v['ts'], text: v['text'] };
    if (isRecord(v['source'])) {
      const src: NonNullable<NoteEntry['source']> = {};
      const h = v['source']['harness'];
      const sess = v['source']['session'];
      if (typeof h === 'string' && (HARNESSES as readonly string[]).includes(h)) src.harness = h as Harness;
      if (typeof sess === 'string') src.session = sess;
      if (src.harness !== undefined || src.session !== undefined) note.source = src;
    }
    return note;
  } catch {
    return null;
  }
}

/**
 * Validate and normalize a change path (relative to `.dream/`). Returns the normalized forward-slash path.
 * Allowed: `MEMORY.md`, `state.json`, `log.md`, `inbox.jsonl`, `pages/<name>.md`, `threads/<name>.md`.
 */
export function validateChangePath(p: unknown): string {
  const bad = (why: string): never => {
    throw new DreamError('PATH_OUTSIDE_MEMORY', `Refusing to write ${JSON.stringify(p)}: ${why}`);
  };
  if (typeof p !== 'string' || p.length === 0) return bad('empty path');
  if (p.includes('\0')) return bad('contains NUL');
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || path.isAbsolute(p)) return bad('absolute path');
  const segs = s.split('/');
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) return bad('must be a plain relative path');
  if (segs[0] === '.cache' || segs[0] === '.jobs' || segs[0] === '.git' || segs[0] === '.snapshots') {
    return bad('internal folder');
  }
  if (segs.length === 1 && TOP_LEVEL_FILES.has(s)) return s;
  if (segs.length === 2 && (segs[0] === 'pages' || segs[0] === 'threads')) {
    const file = segs[1] ?? '';
    if (file.endsWith('.md') && isValidPageName(file.slice(0, -3))) return s;
    return bad('page files must be <valid-name>.md');
  }
  return bad('not an allowed memory file');
}

/** Ensure `file` (a .gitignore) contains `line`-equivalent ignore of `.dream/`; returns true if changed. */
async function ensureGitignoreHasDream(file: string, createIfMissing: boolean): Promise<boolean> {
  try {
    // Never append through a symlinked project .gitignore (it could point anywhere).
    if ((await lstat(file)).isSymbolicLink()) return false;
  } catch {
    /* missing: handled below */
  }
  const existing = await readText(file);
  if (existing === null) {
    if (!createIfMissing) return false;
    await writeIfMissing(file, `${DREAM_DIR_NAME}/\n`);
    return true;
  }
  const covered = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => /^(?:\/|\*\*\/)?\.dream\/?$/.test(l));
  if (covered) return false;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : eol;
  await appendFile(file, `${sep}${DREAM_DIR_NAME}/${eol}`, 'utf8');
  return true;
}

/** True when `dir` or one of its ancestors contains `.git`. */
async function insideGitRepo(dir: string): Promise<boolean> {
  let cur = path.resolve(dir);
  for (;;) {
    if (await pathExists(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** Durable memory folder. See {@link IMemoryStore} for the method contracts. */
export class MemoryStore implements IMemoryStore {
  readonly dir: string;
  readonly projectDir: string;
  private readonly now: () => Date;
  private readonly gitOpt: boolean | undefined;
  private historyP: Promise<History> | undefined;
  /** Serializes read-modify-write operations (inbox, log, state, applyChanges, rollback) within this instance. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(projectDir: string, opts: MemoryStoreOptions = {}) {
    this.projectDir = path.resolve(projectDir);
    this.dir = path.join(this.projectDir, DREAM_DIR_NAME);
    this.now = opts.now ?? (() => new Date());
    this.gitOpt = opts.git;
  }

  private abs(rel: string): string {
    return path.join(this.dir, ...rel.split('/'));
  }

  /** Run `fn` after every previously serialized operation of this store has finished. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Verify `.dream/` is a real folder inside the project and that the folder `relDir` (relative, '' = root) is a
   * real directory inside it (created when missing and `create`). Throws PATH_OUTSIDE_MEMORY otherwise.
   * Returns false only when `create` is false and the folder is missing.
   */
  private async safeDir(relDir: string, create = true): Promise<boolean> {
    const real = await checkDreamRoot(this.dir);
    const rel = relDir === '.' ? '' : relDir;
    return ensureSafeDir(this.dir, real, rel, create);
  }

  /** The history backend (created lazily). */
  history(): Promise<History> {
    this.historyP ??= createHistory(this.dir, { git: this.gitOpt, now: this.now });
    return this.historyP;
  }

  async init(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true });
    try {
      await mkdir(this.dir);
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
    }
    for (const sub of ['pages', 'threads', '.cache', '.jobs']) await this.safeDir(sub);
    await writeIfMissing(this.abs('MEMORY.md'), DEFAULT_INDEX);
    await writeIfMissing(this.abs('dream.md'), DEFAULT_INSTRUCTIONS);
    await writeIfMissing(this.abs('log.md'), DEFAULT_LOG);
    await writeIfMissing(this.abs(CONFIG_FILE), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    await writeIfMissing(this.abs('state.json'), JSON.stringify(defaultState(), null, 2) + '\n');
    await writeIfMissing(this.abs('inbox.jsonl'), '');
    // Keep empty page folders in history (git does not track empty directories).
    await writeIfMissing(this.abs('pages/.gitkeep'), '');
    await writeIfMissing(this.abs('threads/.gitkeep'), '');
    await this.ensureDreamGitignore();
    await this.ensureProjectGitignore();
    const history = await this.history();
    await history.init();
    if ((await history.list(1)).length === 0) await history.commit('agent-dream: initialize memory');
  }

  private async ensureDreamGitignore(): Promise<void> {
    const file = this.abs('.gitignore');
    const existing = (await readText(file)) ?? '';
    const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = DREAM_GITIGNORE_LINES.filter((l) => !have.has(l));
    if (missing.length === 0) return;
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await this.writeAtomic('.gitignore', existing + sep + missing.join('\n') + '\n');
  }

  private async ensureProjectGitignore(): Promise<void> {
    const file = path.join(this.projectDir, '.gitignore');
    const isRepo = await insideGitRepo(this.projectDir);
    if ((await pathExists(file)) || isRepo) await ensureGitignoreHasDream(file, isRepo);
  }

  /** Initialize when the folder does not exist yet (lazy init on first write). */
  private async ensureInit(): Promise<void> {
    if (!(await isDir(this.dir))) await this.init();
  }

  async exists(): Promise<boolean> {
    return isDir(this.dir);
  }

  readConfig(): Promise<DreamConfig> {
    return loadConfig(this.dir);
  }

  async readIndex(): Promise<string> {
    return ((await readText(this.abs('MEMORY.md'))) ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  async readInstructions(): Promise<string> {
    return ((await readText(this.abs('dream.md'))) ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  private async readPagesIn(sub: 'pages' | 'threads'): Promise<Page[]> {
    let names: string[];
    try {
      names = await readdir(this.abs(sub));
    } catch {
      return [];
    }
    const out: Page[] = [];
    for (const file of names.sort()) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (!isValidPageName(name)) continue;
      const text = await readText(this.abs(`${sub}/${file}`));
      if (text === null) continue;
      const page = parsePage(name, text);
      if (sub === 'threads') page.meta.kind = 'thread';
      out.push(page);
    }
    return out;
  }

  /** Normal pages (sorted by name) followed by thread pages (meta.kind 'thread'). */
  async listPages(): Promise<Page[]> {
    return [...(await this.readPagesIn('pages')), ...(await this.readPagesIn('threads'))];
  }

  async readPage(name: string): Promise<Page | null> {
    if (!isValidPageName(name)) return null;
    const order: ('pages' | 'threads')[] = THREAD_NAME_RE.test(name) ? ['threads', 'pages'] : ['pages', 'threads'];
    for (const sub of order) {
      const text = await readText(this.abs(`${sub}/${name}.md`));
      if (text === null) continue;
      const page = parsePage(name, text);
      if (sub === 'threads') page.meta.kind = 'thread';
      return page;
    }
    return null;
  }

  async readState(): Promise<DreamState> {
    const text = await readText(this.abs('state.json'));
    if (text === null) return defaultState();
    try {
      return sanitizeState(JSON.parse(text.replace(/^﻿/, '')) as unknown);
    } catch {
      return defaultState();
    }
  }

  async writeState(state: DreamState): Promise<void> {
    await this.serialize(async () => {
      await this.ensureInit();
      await this.writeAtomic('state.json', JSON.stringify(sanitizeState(state), null, 2) + '\n');
    });
  }

  async readInbox(): Promise<NoteEntry[]> {
    const text = await readText(this.abs('inbox.jsonl'));
    if (!text) return [];
    const out: NoteEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const n = parseNote(line);
      if (n) out.push(n);
    }
    return out;
  }

  async addNote(note: Omit<NoteEntry, 'id' | 'ts'>): Promise<NoteEntry> {
    if (typeof note?.text !== 'string' || note.text.trim().length === 0) {
      throw new DreamError('INVALID_OUTPUT', 'Note text must be a non-empty string.');
    }
    const entry: NoteEntry = { id: randomBytes(5).toString('hex'), ts: this.now().toISOString(), text: note.text };
    if (note.source && (note.source.harness !== undefined || note.source.session !== undefined)) {
      const src: NonNullable<NoteEntry['source']> = {};
      if (note.source.harness !== undefined) src.harness = note.source.harness;
      if (note.source.session !== undefined) src.session = note.source.session;
      entry.source = src;
    }
    return this.serialize(async () => {
      await this.ensureInit();
      const existing = await this.readOwnText('inbox.jsonl');
      const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      await this.writeAtomic('inbox.jsonl', `${existing}${sep}${JSON.stringify(entry)}\n`);
      return entry;
    });
  }

  /** Read a memory file for rewriting: refuses symlinks, '' when missing. */
  private async readOwnText(rel: string): Promise<string> {
    await this.safeDir(path.posix.dirname(rel));
    await assertNotLink(this.abs(rel));
    return (await readText(this.abs(rel))) ?? '';
  }

  /** `threads/<name>.md` for thread page names (`thread-<harness>-…`), else `pages/<name>.md`. */
  pagePath(name: string): string {
    if (!isValidPageName(name)) throw new DreamError('INVALID_PAGE_NAME', `Invalid page name: ${JSON.stringify(name)}`);
    return THREAD_NAME_RE.test(name) ? `threads/${name}.md` : `pages/${name}.md`;
  }

  serializePage(page: Page): string {
    return serializePageMd(page);
  }

  /**
   * Write `content` to `rel` via a temp file in `.cache/tmp/` and rename. Refuses (PATH_OUTSIDE_MEMORY) when
   * `.dream/`, a folder on the way, or `.cache/tmp` is a symlink/junction, or when the target is a symlink.
   */
  private async writeAtomic(rel: string, content: string | Buffer): Promise<void> {
    const dest = this.abs(rel);
    await this.safeDir(path.posix.dirname(rel));
    await this.safeDir('.cache/tmp');
    await assertNotLink(dest);
    const tmp = this.abs(`.cache/tmp/${path.basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, content, typeof content === 'string' ? { encoding: 'utf8', flag: 'wx' } : { flag: 'wx' });
    try {
      await renameWithRetry(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Delete `rel` (missing is fine) after the same containment checks as {@link writeAtomic}. */
  private async removeOwn(rel: string): Promise<void> {
    if (!(await this.safeDir(path.posix.dirname(rel), false))) return;
    await rm(this.abs(rel), { force: true }); // rm on a symlink removes the link itself, never the target
  }

  /**
   * Validate every path first (nothing is written when one is invalid), then write/delete in order and record one
   * history entry. Failure-safe: the previous contents of every touched file are backed up in `.cache/tmp/` and
   * restored when a write or the history commit fails, so the working tree matches the last recorded run; then the
   * error is rethrown. Does not take the lock — callers that need exclusivity hold `lock()` around this call.
   */
  async applyChanges(changes: FileChange[], message: string): Promise<RunRecord> {
    if (!Array.isArray(changes)) throw new DreamError('INVALID_OUTPUT', 'changes must be an array');
    const planned = changes.map((c) => {
      const p = validateChangePath(c?.path);
      if (c.type === 'write') {
        if (typeof c.content !== 'string') throw new DreamError('INVALID_OUTPUT', `No content for ${p}`);
        return { type: 'write' as const, path: p, content: c.content };
      }
      if (c.type === 'delete') return { type: 'delete' as const, path: p };
      throw new DreamError('INVALID_OUTPUT', `Unknown change type for ${p}`);
    });
    return this.serialize(async () => {
      await this.ensureInit();
      // Containment checks for every target before anything is touched.
      for (const c of planned) {
        await this.safeDir(path.posix.dirname(c.path));
        await assertNotLink(this.abs(c.path));
      }
      await this.safeDir('.cache/tmp');
      const backupRel = `.cache/tmp/backup-${process.pid}-${randomBytes(4).toString('hex')}`;
      const backupDir = this.abs(backupRel);
      await mkdir(backupDir);
      const backups = new Map<string, Buffer | null>();
      try {
        for (const c of planned) {
          if (!backups.has(c.path)) {
            const prev = await readBufferOrNull(this.abs(c.path));
            backups.set(c.path, prev);
            if (prev) await writeFile(path.join(backupDir, String(backups.size)), prev, { flag: 'wx' });
          }
          if (c.type === 'write') await this.writeAtomic(c.path, c.content);
          else await this.removeOwn(c.path);
        }
        const rec = await (await this.history()).commit(message);
        await rm(backupDir, { recursive: true, force: true });
        return rec;
      } catch (err) {
        try {
          for (const [rel, prev] of [...backups.entries()].reverse()) {
            if (prev) await this.writeAtomic(rel, prev);
            else await this.removeOwn(rel);
          }
          await rm(backupDir, { recursive: true, force: true });
        } catch (restoreErr) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new DreamError(
            'HISTORY',
            `${msg}; restoring the previous files also failed (${String(restoreErr)}); backups are in ${backupDir}`,
          );
        }
        throw err;
      }
    });
  }

  async appendLog(markdown: string): Promise<void> {
    const text = String(markdown ?? '').replace(/\r\n?/g, '\n').trim();
    if (text.length === 0) {
      await this.ensureInit();
      return;
    }
    await this.serialize(async () => {
      await this.ensureInit();
      const existing = await this.readOwnText('log.md');
      const sep = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      await this.writeAtomic('log.md', `${existing}${sep}${text}\n`);
    });
  }

  async listRuns(limit?: number): Promise<RunRecord[]> {
    if (!(await this.exists())) return [];
    return (await this.history()).list(limit);
  }

  /**
   * Revert a run (default: latest) as a new history entry. Inbox notes and read counters written after that run
   * are not lost: the current inbox entries are merged back into the restored inbox (union by id) and read counters
   * become the per-page maximum of current and restored, inside the same history entry.
   */
  async rollback(runId?: string): Promise<RunRecord> {
    return this.serialize(async () => {
      await this.ensureInit();
      await this.safeDir('');
      const curInbox = await this.readInbox();
      const curState = await this.readState();
      return (await this.history()).revert(runId, {
        beforeCommit: () => this.mergeAfterRevert(curInbox, curState),
      });
    });
  }

  /** Re-merge inbox entries and read counters captured before a revert into the restored files. */
  private async mergeAfterRevert(curInbox: NoteEntry[], curState: DreamState): Promise<void> {
    const restoredInbox = await this.readInbox();
    const have = new Set(restoredInbox.map((n) => n.id));
    const extra = curInbox.filter((n) => !have.has(n.id));
    if (extra.length > 0) {
      const merged = [...restoredInbox, ...extra]
        .map((n, i) => ({ n, i }))
        .sort((a, b) => (a.n.ts < b.n.ts ? -1 : a.n.ts > b.n.ts ? 1 : a.i - b.i))
        .map((x) => x.n);
      await this.writeAtomic('inbox.jsonl', serializeInbox(merged));
    }
    const restoredState = await this.readState();
    const reads = { ...restoredState.reads };
    let changed = false;
    for (const [k, v] of Object.entries(curState.reads)) {
      if (!Object.hasOwn(reads, k) || v > (reads[k] ?? 0)) {
        reads[k] = v;
        changed = true;
      }
    }
    if (changed) {
      await this.writeAtomic('state.json', JSON.stringify(sanitizeState({ ...restoredState, reads }), null, 2) + '\n');
    }
  }

  async lock(ttlMs: number = DEFAULT_LOCK_TTL_MS): Promise<LockHandle> {
    await this.ensureInit();
    await this.safeDir('');
    await assertNotLink(this.abs('.lock'));
    return acquireLock(this.dir, ttlMs);
  }

  private jobFile(jobId: string): string {
    return this.abs(`.jobs/${jobId}.json`);
  }

  async readJob<T>(jobId: string): Promise<T | null> {
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return null;
    const text = await readText(this.jobFile(jobId));
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async writeJob<T>(jobId: string, job: T): Promise<void> {
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
      throw new DreamError('JOB_NOT_FOUND', `Invalid job id: ${JSON.stringify(jobId)}`);
    }
    await this.ensureInit();
    await this.writeAtomic(`.jobs/${jobId}.json`, JSON.stringify(job, null, 2) + '\n');
  }

  async deleteJob(jobId: string): Promise<void> {
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return;
    if (!(await this.exists())) return;
    await this.removeOwn(`.jobs/${jobId}.json`);
  }

  /** Job ids, most recently written first. */
  async listJobs(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.abs('.jobs'));
    } catch {
      return [];
    }
    const withTime: { id: string; t: number }[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!JOB_ID_RE.test(id)) continue;
      try {
        withTime.push({ id, t: (await stat(this.jobFile(id))).mtimeMs });
      } catch {
        /* removed meanwhile */
      }
    }
    return withTime.sort((a, b) => b.t - a.t || a.id.localeCompare(b.id)).map((x) => x.id);
  }
}
