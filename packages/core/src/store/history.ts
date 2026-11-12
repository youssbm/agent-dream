/**
 * Run history for the memory folder.
 *
 * - git (preferred): `.dream/` is its own repository. Every git invocation is pinned to that repository with
 *   `--git-dir`/`--work-tree`, inherited `GIT_*` variables are dropped, user/system git config, attributes and
 *   excludes are not read (no hooks, templates, filters, signing), an existing `.dream/.git` whose config could
 *   run commands (filter/diff/merge drivers, fsmonitor, hooksPath, includes, aliases, credential helpers, …) is
 *   refused, and after `init` we verify that the repository top level is `.dream/` itself, so the surrounding
 *   project repository is never touched.
 * - snapshot (fallback when git is missing): full copies of the tracked files in `.snapshots/<id>/`.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DreamError } from '../types.ts';
import type { RunRecord } from '../types.ts';
import { assertNotLink, checkDreamRoot, ensureSafeDir, normPath } from './safepath.ts';

/** Options for {@link History.revert}. */
export interface RevertOptions {
  /**
   * Called after the reverted files are on disk and before the revert is recorded, so callers can adjust files
   * (e.g. re-merge inbox notes) and have those edits land in the same history entry.
   */
  beforeCommit?: () => Promise<void>;
}

/** Run history of a memory folder. */
export interface History {
  readonly kind: 'git' | 'snapshot';
  /** Prepare the history store (git init / snapshots dir). Idempotent. */
  init(): Promise<void>;
  /** Record the current state of all tracked files as one run (empty runs allowed). */
  commit(message: string): Promise<RunRecord>;
  /** Most recent first. Default limit 20. */
  list(limit?: number): Promise<RunRecord[]>;
  /** Undo the given run (default: latest) as a new history entry; returns that entry. */
  revert(runId?: string, opts?: RevertOptions): Promise<RunRecord>;
}

export interface HistoryOptions {
  /** true = git, false = snapshot fallback, undefined = git when the binary is available. */
  git?: boolean;
  /** Clock used for timestamps (tests). */
  now?: () => Date;
}

/** Paths (top-level entries of `.dream/`) never recorded in history. */
export const UNTRACKED_TOP_LEVEL = ['.git', '.cache', '.jobs', '.snapshots', '.lock'] as const;

const AUTHOR_NAME = 'agent-dream';
const AUTHOR_EMAIL = 'agent-dream@localhost';
const PENDING_MESSAGE = 'agent-dream: save pending changes before rollback';
/** Folder inside `.git/` that must never exist; hooks/config/attributes/excludes are pointed into it. */
const SENTINEL_DIR = 'agent-dream-none';

/** Create the history for `dreamDir`, choosing git when available unless `opts.git` forces a backend. */
export async function createHistory(dreamDir: string, opts: HistoryOptions = {}): Promise<History> {
  const dir = path.resolve(dreamDir);
  const now = opts.now;
  const useGit = opts.git ?? (await gitAvailable());
  return useGit ? new GitHistory(dir, now) : new SnapshotHistory(dir, now ?? (() => new Date()));
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

let gitAvailableCache: Promise<boolean> | undefined;

/** True when a `git` binary can be executed. Cached per process. */
export function gitAvailable(): Promise<boolean> {
  gitAvailableCache ??= new Promise<boolean>((resolve) => {
    try {
      execFile('git', ['--version'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        resolve(!err && /git version/i.test(String(stdout)));
      });
    } catch {
      resolve(false);
    }
  });
  return gitAvailableCache;
}

async function realOrResolved(p: string): Promise<string> {
  try {
    return await realpath(p); // fs/promises realpath is the native (uv) implementation
  } catch {
    return path.resolve(p);
  }
}

/** True when both paths name the same directory (after realpath). */
async function samePathReal(a: string, b: string): Promise<boolean> {
  if (normPath(a) === normPath(b)) return true;
  return normPath(await realOrResolved(a)) === normPath(await realOrResolved(b));
}

function cleanMessage(message: string): string {
  const m = String(message ?? '').replace(/\r\n?/g, '\n').trim();
  return m.length > 0 ? m : 'agent-dream run';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

async function readTextOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Sections whose presence in `.dream/.git/config` is refused (any subsection). */
const FORBIDDEN_SECTIONS = new Set(['filter', 'diff', 'include', 'includeif', 'alias', 'credential']);
/** `[core]` keys refused in `.dream/.git/config`. */
const FORBIDDEN_CORE_KEYS = new Set(['fsmonitor', 'sshcommand', 'gitproxy', 'worktree']);

/**
 * Problems in a git config file that could make git run commands or redirect paths. Returns human-readable
 * entries (empty when the config is acceptable). `ownHooksPath` is the only `core.hooksPath` value tolerated.
 */
export function gitConfigProblems(text: string, ownHooksPath?: string): string[] {
  const problems = new Set<string>();
  let section = '';
  let hasSub = false;
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([A-Za-z0-9.-]*)\s*(?:"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (header) {
      const name = (header[1] ?? '').toLowerCase();
      const dot = name.indexOf('.');
      section = dot >= 0 ? name.slice(0, dot) : name;
      hasSub = dot >= 0 || header[2] !== undefined;
      if (FORBIDDEN_SECTIONS.has(section)) problems.add(`[${section}] section`);
      if (section === 'merge' && hasSub) problems.add('[merge "<driver>"] section');
      line = line.slice(header[0].length).trim();
      if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    } else if (line.startsWith('[')) {
      // Unparseable header: be conservative.
      problems.add(`unrecognized section header ${JSON.stringify(line.slice(0, 40))}`);
      section = '';
      hasSub = false;
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv || section !== 'core' || hasSub) continue;
    const key = (kv[1] ?? '').toLowerCase();
    if (FORBIDDEN_CORE_KEYS.has(key)) problems.add(`core.${key}`);
    if (key === 'hookspath') {
      const value = (kv[2] ?? '').trim().replace(/^"(.*)"$/, '$1');
      if (!ownHooksPath || normPath(value) !== normPath(ownHooksPath)) problems.add('core.hooksPath');
    }
  }
  return [...problems];
}

/** Problems in a `.gitattributes`-style file: any `filter=` or `diff=` attribute. */
export function gitAttributesProblems(text: string): string[] {
  const problems = new Set<string>();
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (/(?:^|\s)filter=/i.test(line)) problems.add('filter= attribute');
    if (/(?:^|\s)diff=/i.test(line)) problems.add('diff= attribute');
  }
  return [...problems];
}

// ─────────────────────────────────────────────────────────────────────────────
// git backend
// ─────────────────────────────────────────────────────────────────────────────

interface GitResult {
  stdout: string;
  stderr: string;
}

class GitHistory implements History {
  readonly kind = 'git' as const;
  private readonly dir: string;
  private readonly now: (() => Date) | undefined;
  private readonly gitDir: string;
  private readonly sentinel: string;

  constructor(dir: string, now?: () => Date) {
    this.dir = dir;
    this.now = now;
    this.gitDir = path.join(dir, '.git');
    this.sentinel = path.join(this.gitDir, SENTINEL_DIR);
  }

  private sentinelPath(name: string): string {
    return path.join(this.sentinel, name).replace(/\\/g, '/');
  }

  /** Environment for git: no inherited GIT_* overrides, no user/system config or attributes, no prompts. */
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^GIT_/i.test(k) && k.toUpperCase() !== 'GIT_EXEC_PATH') continue;
      env[k] = v;
    }
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['GIT_CONFIG_NOSYSTEM'] = '1';
    env['GIT_ATTR_NOSYSTEM'] = '1';
    env['GIT_CONFIG_GLOBAL'] = this.sentinelPath('global-config');
    env['GIT_OPTIONAL_LOCKS'] = '0';
    if (this.now) {
      const d = this.now().toISOString();
      env['GIT_AUTHOR_DATE'] = d;
      env['GIT_COMMITTER_DATE'] = d;
    }
    return env;
  }

  private baseArgs(pinned: boolean): string[] {
    const fwd = this.dir.replace(/\\/g, '/');
    const cfg: string[] = [
      'core.autocrlf=false',
      'core.safecrlf=false',
      'core.quotepath=false',
      'core.fsmonitor=false',
      `core.hooksPath=${this.sentinelPath('hooks')}`,
      `core.attributesFile=${this.sentinelPath('attributes')}`,
      `core.excludesFile=${this.sentinelPath('excludes')}`,
      'commit.gpgsign=false',
      'gc.auto=0',
      'i18n.logOutputEncoding=UTF-8',
      `safe.directory=${fwd}`,
      `user.name=${AUTHOR_NAME}`,
      `user.email=${AUTHOR_EMAIL}`,
    ];
    const args = ['-C', this.dir];
    for (const c of cfg) args.push('-c', c);
    if (pinned) args.push(`--git-dir=${this.gitDir}`, `--work-tree=${this.dir}`);
    return args;
  }

  private run(args: string[], opts: { pinned?: boolean; allowFail?: boolean } = {}): Promise<GitResult & { code: number }> {
    const full = [...this.baseArgs(opts.pinned ?? true), ...args];
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        full,
        { cwd: this.dir, env: this.env(), timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          if (err && !opts.allowFail) {
            const detail = String(stderr || err.message).trim();
            reject(new DreamError('HISTORY', `git ${args[0] ?? ''} failed in ${this.dir}: ${detail}`));
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        },
      );
    });
  }

  private refuse(why: string): never {
    throw new DreamError(
      'HISTORY',
      `Refusing to use the memory history in ${this.gitDir}: ${why}. Remove it, or delete .dream/.git to start a fresh history.`,
    );
  }

  /**
   * Safety checks before any git invocation: `.dream/` is a real folder inside the project, `.git` (when present)
   * is a real directory whose config cannot run commands, the sentinel folder does not exist, and
   * `.dream/.gitattributes` / `.git/info/attributes` declare no filter/diff drivers.
   */
  private async ready(): Promise<void> {
    await checkDreamRoot(this.dir);
    const st = await lstatOrNull(this.gitDir);
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) this.refuse('.git is a symlink, junction or file, not a directory');
      if (await lstatOrNull(this.sentinel)) this.refuse(`${SENTINEL_DIR} must not exist inside .git`);
      const config = await readTextOrNull(path.join(this.gitDir, 'config'));
      if (config !== null) {
        const problems = gitConfigProblems(config, this.sentinelPath('hooks'));
        if (problems.length > 0) this.refuse(`its config contains ${problems.join(', ')}`);
      }
      const info = await readTextOrNull(path.join(this.gitDir, 'info', 'attributes'));
      if (info !== null) {
        const problems = gitAttributesProblems(info);
        if (problems.length > 0) this.refuse(`.git/info/attributes contains ${problems.join(', ')}`);
      }
    }
    const attrs = await readTextOrNull(path.join(this.dir, '.gitattributes'));
    if (attrs !== null) {
      const problems = gitAttributesProblems(attrs);
      if (problems.length > 0) this.refuse(`.dream/.gitattributes contains ${problems.join(', ')}`);
    }
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.ready();
    if (!(await pathExists(this.gitDir))) {
      await this.run(['-c', 'init.defaultBranch=main', 'init', '-q'], { pinned: false });
      await this.ready();
    }
    // Isolation check: git discovery from .dream/ must resolve to .dream/ itself, never the project repo.
    const top = (await this.run(['rev-parse', '--show-toplevel'], { pinned: false })).stdout.trim();
    if (!(await samePathReal(top, this.dir))) {
      throw new DreamError('HISTORY', `git repository top level is ${top}, expected ${this.dir}; refusing to use it`);
    }
    const local: [string, string][] = [
      ['user.name', AUTHOR_NAME],
      ['user.email', AUTHOR_EMAIL],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
    ];
    for (const [k, v] of local) await this.run(['config', '--local', k, v]);
  }

  private async ensureRepo(): Promise<void> {
    if (!(await pathExists(this.gitDir))) await this.init();
    else await this.ready();
  }

  private async hasHead(): Promise<boolean> {
    const r = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  private async commitAll(message: string): Promise<RunRecord> {
    await this.run(['add', '-A']);
    const msgFile = path.join(this.gitDir, `AGENT_DREAM_COMMIT_MSG.${randomBytes(4).toString('hex')}`);
    await writeFile(msgFile, cleanMessage(message) + '\n', { encoding: 'utf8', flag: 'wx' });
    try {
      await this.run(['commit', '-q', '--no-verify', '--allow-empty', '--cleanup=whitespace', '-F', msgFile]);
    } finally {
      await rm(msgFile, { force: true });
    }
    const [rec] = await this.log(['-1']);
    if (!rec) throw new DreamError('HISTORY', 'commit succeeded but no HEAD found');
    return rec;
  }

  private async log(extra: string[]): Promise<RunRecord[]> {
    const r = await this.run(['log', '--format=%H%x1f%cI%x1f%B%x1e', ...extra]);
    const out: RunRecord[] = [];
    for (const rec of r.stdout.split('\x1e')) {
      const trimmed = rec.replace(/^\s+/, '');
      if (!trimmed) continue;
      const [id, ts, ...msg] = trimmed.split('\x1f');
      if (!id || !ts) continue;
      out.push({ id: id.trim(), ts: new Date(ts.trim()).toISOString(), message: msg.join('\x1f').trim() });
    }
    return out;
  }

  async commit(message: string): Promise<RunRecord> {
    await this.ensureRepo();
    return this.commitAll(message);
  }

  async list(limit = 20): Promise<RunRecord[]> {
    if (!(await pathExists(this.gitDir))) return [];
    await this.ready();
    if (!(await this.hasHead())) return [];
    const n = Math.max(1, Math.floor(limit));
    return this.log(['-n', String(n)]);
  }

  async revert(runId?: string, opts: RevertOptions = {}): Promise<RunRecord> {
    await this.ensureRepo();
    if (!(await this.hasHead())) throw new DreamError('HISTORY', 'Nothing to roll back: no runs recorded yet.');
    if (runId !== undefined && !/^[0-9a-fA-F]{4,64}$/.test(runId)) {
      throw new DreamError('HISTORY', `Invalid run id: ${runId}`);
    }
    const ref = runId ?? 'HEAD';
    const resolved = await this.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true });
    const target = resolved.stdout.trim();
    if (resolved.code !== 0 || !target) throw new DreamError('HISTORY', `Run not found: ${ref}`);

    // Uncommitted edits (e.g. read counters, inbox notes) are saved first so the revert sees a clean tree.
    const status = await this.run(['status', '--porcelain', '--untracked-files=all']);
    if (status.stdout.trim().length > 0) await this.commitAll(PENDING_MESSAGE);

    const subject = (await this.run(['log', '-1', '--format=%s', target])).stdout.trim();
    // -X theirs: on overlapping hunks prefer the pre-run content (the state being restored).
    const rv = await this.run(['revert', '--no-commit', '--strategy-option=theirs', target], { allowFail: true });
    if (rv.code !== 0) {
      await this.abortRevert();
      throw new DreamError('HISTORY', `Could not roll back ${target.slice(0, 12)}: ${rv.stderr.trim() || rv.stdout.trim()}`);
    }
    if (opts.beforeCommit) {
      try {
        await opts.beforeCommit();
      } catch (err) {
        await this.abortRevert();
        throw err;
      }
    }
    return this.commitAll(`Revert "${subject}"\n\nThis reverts commit ${target}.`);
  }

  private async abortRevert(): Promise<void> {
    await this.run(['revert', '--abort'], { allowFail: true });
    await this.run(['reset', '--hard', '-q', 'HEAD'], { allowFail: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// snapshot backend
// ─────────────────────────────────────────────────────────────────────────────

interface SnapshotManifest {
  id: string;
  seq: number;
  ts: string;
  message: string;
  files: string[];
}

const SNAPSHOT_DIR = '.snapshots';
const MANIFEST = 'manifest.json';

/**
 * True when `rel` is a safe tracked-file path: relative, forward slashes, no empty/`.`/`..` segments, no drive
 * letter or NUL, and not inside the untracked internals (`.git`, `.cache`, `.jobs`, `.snapshots`, `.lock*`).
 */
export function isSafeTrackedPath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 4096) return false;
  if (rel.includes('\0') || rel.includes('\\') || rel.includes(':')) return false;
  if (rel.startsWith('/') || path.isAbsolute(rel)) return false;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  const top = segs[0] ?? '';
  if ((UNTRACKED_TOP_LEVEL as readonly string[]).includes(top) || top.startsWith('.lock')) return false;
  return true;
}

/** Relative (forward-slash) paths of all tracked files under `dir`. */
async function listTrackedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const skipTop = new Set<string>(UNTRACKED_TOP_LEVEL);
  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rel === '' && (skipTop.has(e.name) || e.name.startsWith('.lock'))) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const childAbs = path.join(abs, e.name);
      // Symlinks/junctions are neither files nor directories here: never followed, never recorded.
      if (e.isDirectory()) await walk(childAbs, childRel);
      else if (e.isFile()) out.push(childRel);
    }
  }
  await walk(dir, '');
  return out.sort();
}

class SnapshotHistory implements History {
  readonly kind = 'snapshot' as const;
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly root: string;

  constructor(dir: string, now: () => Date) {
    this.dir = dir;
    this.now = now;
    this.root = path.join(dir, SNAPSHOT_DIR);
  }

  /** Verify `.dream/` and `.snapshots/` are real folders inside the project; returns realpath(.dream). */
  private async safeRoot(): Promise<string> {
    const real = await checkDreamRoot(this.dir);
    await ensureSafeDir(this.dir, real, SNAPSHOT_DIR);
    return real;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.safeRoot();
  }

  private async manifests(): Promise<SnapshotManifest[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const out: SnapshotManifest[] = [];
    for (const name of names) {
      try {
        const m = JSON.parse(await readFile(path.join(this.root, name, MANIFEST), 'utf8')) as SnapshotManifest;
        if (m && m.id === name && typeof m.seq === 'number' && Array.isArray(m.files)) out.push(m);
      } catch {
        /* skip incomplete snapshot */
      }
    }
    return out.sort((a, b) => b.seq - a.seq);
  }

  /** Throw unless every path in the manifest is a safe tracked path. */
  private assertManifestSafe(m: SnapshotManifest): void {
    const bad = m.files.filter((f) => !isSafeTrackedPath(f));
    if (bad.length > 0) {
      throw new DreamError(
        'PATH_OUTSIDE_MEMORY',
        `Snapshot ${m.id} lists unsafe paths (${bad.slice(0, 3).map((b) => JSON.stringify(b)).join(', ')}); refusing to restore it`,
      );
    }
  }

  async commit(message: string): Promise<RunRecord> {
    await mkdir(this.dir, { recursive: true });
    await this.safeRoot();
    const existing = await this.manifests();
    const seq = (existing[0]?.seq ?? 0) + 1;
    const date = this.now();
    const stamp = date.toISOString().replace(/[-:.]/g, '');
    const id = `${String(seq).padStart(6, '0')}-${stamp}-${randomBytes(3).toString('hex')}`;
    const target = path.join(this.root, id);
    const tmp = path.join(this.root, `.tmp-${id}`);
    const files = await listTrackedFiles(this.dir);
    for (const rel of files) {
      const dest = path.join(tmp, 'files', ...rel.split('/'));
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(this.dir, ...rel.split('/')), dest);
    }
    const manifest: SnapshotManifest = { id, seq, ts: date.toISOString(), message: cleanMessage(message), files };
    await mkdir(tmp, { recursive: true });
    await writeFile(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await rename(tmp, target);
    return { id, ts: manifest.ts, message: manifest.message };
  }

  async list(limit = 20): Promise<RunRecord[]> {
    const n = Math.max(1, Math.floor(limit));
    return (await this.manifests()).slice(0, n).map((m) => ({ id: m.id, ts: m.ts, message: m.message }));
  }

  /** True when the working files equal the snapshot's files byte for byte. */
  private async matches(m: SnapshotManifest): Promise<boolean> {
    this.assertManifestSafe(m);
    const files = await listTrackedFiles(this.dir);
    if (files.length !== m.files.length || files.some((f, i) => f !== m.files[i])) return false;
    for (const rel of files) {
      const [a, b] = await Promise.all([
        readFile(path.join(this.dir, ...rel.split('/'))),
        readFile(path.join(this.root, m.id, 'files', ...rel.split('/'))),
      ]);
      if (!a.equals(b)) return false;
    }
    return true;
  }

  /** Replace all tracked working files with the files of `m` (or with nothing when `m` is undefined). */
  private async restore(real: string, m: SnapshotManifest | undefined): Promise<void> {
    if (m) this.assertManifestSafe(m);
    for (const rel of await listTrackedFiles(this.dir)) {
      await rm(path.join(this.dir, ...rel.split('/')), { force: true });
    }
    if (!m) return;
    for (const rel of m.files) {
      const dest = path.join(this.dir, ...rel.split('/'));
      await ensureSafeDir(this.dir, real, path.posix.dirname(rel));
      await assertNotLink(dest);
      await copyFile(path.join(this.root, m.id, 'files', ...rel.split('/')), dest);
    }
  }

  /**
   * Restore the snapshot taken before the target run (or an empty state when the target is the first run),
   * then record that as a new snapshot. Pending unsaved edits are snapshotted first.
   * Unlike git, this restores the whole folder state, so later runs after the target are undone too.
   */
  async revert(runId?: string, opts: RevertOptions = {}): Promise<RunRecord> {
    const real = await this.safeRoot();
    let all = await this.manifests();
    if (all.length === 0) throw new DreamError('HISTORY', 'Nothing to roll back: no runs recorded yet.');
    if (runId !== undefined && !/^[A-Za-z0-9_-]+$/.test(runId)) throw new DreamError('HISTORY', `Invalid run id: ${runId}`);
    const target = runId === undefined ? all[0] : all.find((m) => m.id === runId);
    if (!target) throw new DreamError('HISTORY', `Run not found: ${runId}`);

    const latest = all[0];
    if (latest && !(await this.matches(latest))) {
      await this.commit(PENDING_MESSAGE);
      all = await this.manifests();
    }
    const previous = all.find((m) => m.seq < target.seq);
    if (previous) this.assertManifestSafe(previous);

    await this.restore(real, previous);
    if (opts.beforeCommit) {
      try {
        await opts.beforeCommit();
      } catch (err) {
        await this.restore(real, all[0]); // back to the state before the revert started
        throw err;
      }
    }
    const subject = target.message.split('\n')[0] ?? '';
    return this.commit(`Revert "${subject}"\n\nThis reverts snapshot ${target.id}.`);
  }
}
