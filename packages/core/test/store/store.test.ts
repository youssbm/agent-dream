import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitAvailable } from '../../src/store/history.ts';
import { DEFAULT_INDEX, DEFAULT_INSTRUCTIONS, MemoryStore, validateChangePath } from '../../src/store/store.ts';
import { DEFAULT_CONFIG } from '../../src/types.ts';
import type { FileChange, Page } from '../../src/types.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dream-store-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args],
      { env, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(String(stdout))),
    );
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const hasGit = await gitAvailable();
const FIXED = new Date('2026-11-11T12:00:00.000Z');

function page(name: string, body: string, extra: Partial<Page['meta']> = {}): Page {
  return {
    name,
    meta: { title: name, kind: 'fact', volatile: false, confidence: 'unverified', sources: [], links: [], ...extra },
    body,
  };
}

// Run the store suite against both history backends (git only when available).
const backends: { label: string; git: boolean }[] = [
  ...(hasGit ? [{ label: 'git', git: true }] : []),
  { label: 'snapshot', git: false },
];

describe.each(backends)('MemoryStore ($label history)', ({ git: useGit }) => {
  const make = (dir = root) => new MemoryStore(dir, { now: () => FIXED, git: useGit });

  it('init creates the layout and default files, idempotently', async () => {
    const store = make();
    expect(await store.exists()).toBe(false);
    expect(await store.readIndex()).toBe('');
    expect(await store.readInstructions()).toBe('');
    expect(await store.listPages()).toEqual([]);
    expect(await store.listRuns()).toEqual([]);

    await store.init();
    expect(store.dir).toBe(path.join(path.resolve(root), '.dream'));
    expect(await store.exists()).toBe(true);
    for (const d of ['pages', 'threads', '.cache', '.jobs']) expect(await exists(path.join(store.dir, d))).toBe(true);
    expect(await store.readIndex()).toBe(DEFAULT_INDEX);
    expect(DEFAULT_INDEX.startsWith('# Memory index')).toBe(true);
    expect(await store.readInstructions()).toBe(DEFAULT_INSTRUCTIONS);
    const instrLines = DEFAULT_INSTRUCTIONS.trim().split('\n').length;
    expect(instrLines).toBeGreaterThanOrEqual(6);
    expect(instrLines).toBeLessThanOrEqual(10);
    expect(await store.readConfig()).toEqual(DEFAULT_CONFIG);
    expect(await store.readState()).toEqual({ version: 1, watermarks: {}, sourceChars: 0, reads: {} });
    expect(await store.readInbox()).toEqual([]);
    const gi = await readFile(path.join(store.dir, '.gitignore'), 'utf8');
    for (const l of ['.cache/', '.jobs/', '.lock', '.snapshots/']) expect(gi.split('\n')).toContain(l);

    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);

    // Customize, then re-init: nothing overwritten, no new run, no duplicate gitignore lines.
    await writeFile(path.join(store.dir, 'config.json'), JSON.stringify({ chunkTokens: 1234 }));
    await writeFile(path.join(store.dir, 'dream.md'), 'mine\n');
    await store.init();
    expect((await store.readConfig()).chunkTokens).toBe(1234);
    expect(await store.readInstructions()).toBe('mine\n');
    expect(await store.listRuns()).toHaveLength(1);
    expect(await readFile(path.join(store.dir, '.gitignore'), 'utf8')).toBe(gi);
  });

  it('does not create a project .gitignore outside a git repo, but appends to an existing one once', async () => {
    const plain = path.join(root, 'plain');
    await mkdir(plain);
    await make(plain).init();
    expect(await exists(path.join(plain, '.gitignore'))).toBe(false);

    const withIgnore = path.join(root, 'with-ignore');
    await mkdir(withIgnore);
    await writeFile(path.join(withIgnore, '.gitignore'), 'node_modules/');
    const s = make(withIgnore);
    await s.init();
    await s.init();
    expect(await readFile(path.join(withIgnore, '.gitignore'), 'utf8')).toBe('node_modules/\n.dream/\n');

    const crlf = path.join(root, 'crlf');
    await mkdir(crlf);
    await writeFile(path.join(crlf, '.gitignore'), 'dist/\r\n');
    await make(crlf).init();
    expect(await readFile(path.join(crlf, '.gitignore'), 'utf8')).toBe('dist/\r\n.dream/\r\n');

    const already = path.join(root, 'already');
    await mkdir(already);
    await writeFile(path.join(already, '.gitignore'), '/.dream\n');
    await make(already).init();
    expect(await readFile(path.join(already, '.gitignore'), 'utf8')).toBe('/.dream\n');
  });

  it('creates the project .gitignore when the project is a git repo', async () => {
    const proj = path.join(root, 'repo');
    await mkdir(path.join(proj, '.git'), { recursive: true }); // looks like a repo
    await make(proj).init();
    expect(await readFile(path.join(proj, '.gitignore'), 'utf8')).toBe('.dream/\n');
    const sub = path.join(proj, 'packages', 'app');
    await mkdir(sub, { recursive: true });
    await make(sub).init();
    expect(await readFile(path.join(sub, '.gitignore'), 'utf8')).toBe('.dream/\n');
  });

  it('applies changes, lists normal and thread pages, reads pages', async () => {
    const store = make();
    await store.init();
    const p = page('test-db', 'Run db first. See [[ci]].', {
      title: 'Test DB',
      sources: [{ harness: 'codex', session: 's1', msgs: '3-4' }],
    });
    const thread = page('thread-codex-s1', '## Goal\nShip it.\n', { kind: 'fact' });
    expect(store.pagePath('test-db')).toBe('pages/test-db.md');
    expect(store.pagePath('thread-codex-s1')).toBe('threads/thread-codex-s1.md');
    expect(store.pagePath('thread-safety')).toBe('pages/thread-safety.md');
    expect(() => store.pagePath('Bad Name')).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_NAME' }));

    const changes: FileChange[] = [
      { type: 'write', path: store.pagePath(p.name), content: store.serializePage(p) },
      { type: 'write', path: store.pagePath(thread.name), content: store.serializePage(thread) },
      { type: 'write', path: 'MEMORY.md', content: '# Memory index\n- [[test-db]] db setup\n' },
      { type: 'write', path: 'pages/ci.md', content: store.serializePage(page('ci', 'CI notes')) },
    ];
    const run = await store.applyChanges(changes, 'dream: two pages');
    expect(run.message).toBe('dream: two pages');
    const runs = await store.listRuns();
    expect(runs[0]?.id).toBe(run.id);
    expect(runs).toHaveLength(2);

    const pages = await store.listPages();
    expect(pages.map((x) => x.name)).toEqual(['ci', 'test-db', 'thread-codex-s1']);
    expect(pages[2]?.meta.kind).toBe('thread');
    const read = await store.readPage('test-db');
    expect(read?.meta.title).toBe('Test DB');
    expect(read?.meta.links).toEqual(['ci']);
    expect(read?.meta.sources).toEqual([{ harness: 'codex', session: 's1', msgs: '3-4' }]);
    expect((await store.readPage('thread-codex-s1'))?.meta.kind).toBe('thread');
    expect(await store.readPage('missing')).toBeNull();
    expect(await store.readPage('../MEMORY')).toBeNull();
    expect(await store.readIndex()).toContain('[[test-db]]');

    // No temp files left behind in tracked folders.
    expect((await readdir(path.join(store.dir, 'pages'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    // Delete + rollback.
    const del = await store.applyChanges([{ type: 'delete', path: 'pages/ci.md' }], 'dream: delete ci');
    expect(await store.readPage('ci')).toBeNull();
    const rb = await store.rollback(del.id);
    expect(rb.message).toContain('Revert');
    expect((await store.readPage('ci'))?.body).toBe('CI notes');
    expect((await store.listRuns(1))[0]?.id).toBe(rb.id);
  });

  it('rejects paths outside the allowed memory files without writing anything', async () => {
    const store = make();
    await store.init();
    const bad = [
      '../evil.md',
      'pages/../../evil.md',
      '/etc/passwd',
      'C:\\Windows\\x.md',
      'C:/x.md',
      '.cache/x.json',
      '.jobs/j.json',
      '.git/config',
      'config.json',
      'dream.md',
      'pages/Bad Name.md',
      'pages/x.txt',
      'pages/sub/x.md',
      'other/x.md',
      './MEMORY.md',
      'pages//x.md',
      '',
    ];
    for (const p of bad) {
      await expect(
        store.applyChanges([{ type: 'write', path: 'MEMORY.md', content: 'changed' }, { type: 'write', path: p, content: 'x' }], 'm'),
        p,
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_MEMORY' });
    }
    expect(await store.readIndex()).toBe(DEFAULT_INDEX);
    expect(await store.listRuns()).toHaveLength(1);
    expect(await exists(path.join(root, 'evil.md'))).toBe(false);

    for (const ok of ['MEMORY.md', 'state.json', 'log.md', 'inbox.jsonl', 'pages/a-b.md', 'threads/thread-codex-x.md', 'pages\\win.md']) {
      expect(() => validateChangePath(ok), ok).not.toThrow();
    }
    expect(validateChangePath('pages\\win.md')).toBe('pages/win.md');
  });

  it('applyChanges initializes lazily', async () => {
    const store = make();
    await store.applyChanges([{ type: 'write', path: 'pages/a.md', content: 'A' }], 'first');
    expect(await store.exists()).toBe(true);
    expect(await store.readInstructions()).toBe(DEFAULT_INSTRUCTIONS);
    expect((await store.listRuns()).map((r) => r.message)).toEqual(['first', 'agent-dream: initialize memory']);
  });

  it('reads and writes state, tolerating bad content', async () => {
    const store = make();
    await store.writeState({ version: 1, watermarks: { 'codex:s1': 41 }, sourceChars: 900, lastRunAt: FIXED.toISOString(), reads: { a: 2 } });
    expect(await store.readState()).toEqual({
      version: 1,
      watermarks: { 'codex:s1': 41 },
      sourceChars: 900,
      lastRunAt: FIXED.toISOString(),
      reads: { a: 2 },
    });
    await writeFile(path.join(store.dir, 'state.json'), '{bad');
    expect(await store.readState()).toEqual({ version: 1, watermarks: {}, sourceChars: 0, reads: {} });
    await writeFile(path.join(store.dir, 'state.json'), JSON.stringify({ watermarks: { x: 'no', y: 3 }, sourceChars: -1, reads: [] }));
    expect(await store.readState()).toEqual({ version: 1, watermarks: { y: 3 }, sourceChars: 0, reads: {} });
  });

  it('adds and reads inbox notes', async () => {
    const store = make();
    const a = await store.addNote({ text: 'dev server runs on 5173' });
    const b = await store.addNote({ text: 'multi\nline "quoted"', source: { harness: 'opencode', session: 'ses_1' } });
    expect(a.id).toMatch(/^[0-9a-f]{10}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.ts).toBe(FIXED.toISOString());
    expect(await store.readInbox()).toEqual([a, b]);
    // Garbage lines are skipped.
    await writeFile(path.join(store.dir, 'inbox.jsonl'), (await readFile(path.join(store.dir, 'inbox.jsonl'), 'utf8')) + 'garbage\n{"id":1}\n');
    expect(await store.readInbox()).toEqual([a, b]);
    await expect(store.addNote({ text: '   ' })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('appends to the log', async () => {
    const store = make();
    await store.appendLog('## 2026-11-11\n- run one');
    await store.appendLog('## 2026-11-12\r\n- run two\n\n');
    const log = await readFile(path.join(store.dir, 'log.md'), 'utf8');
    expect(log).toBe('# Dream log\n\n## 2026-11-11\n- run one\n\n## 2026-11-12\n- run two\n');
  });

  it('manages jobs', async () => {
    const store = make();
    expect(await store.listJobs()).toEqual([]);
    expect(await store.readJob('nope')).toBeNull();
    await store.writeJob('job_1', { step: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await store.writeJob('job-2', { step: 2, nested: { a: [1] } });
    expect(await store.readJob<{ step: number }>('job_1')).toEqual({ step: 1 });
    expect(await store.listJobs()).toEqual(['job-2', 'job_1']);
    await store.deleteJob('job_1');
    await store.deleteJob('job_1');
    expect(await store.listJobs()).toEqual(['job-2']);
    expect(await store.readJob('../config')).toBeNull();
    await expect(store.writeJob('../evil', {})).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await store.deleteJob('../config');
    expect(await exists(path.join(store.dir, 'config.json'))).toBe(true);
  });

  it('locks the memory folder', async () => {
    const store = make();
    const lock = await store.lock();
    await expect(make().lock()).rejects.toMatchObject({ code: 'LOCKED' });
    await lock.release();
    const again = await store.lock();
    await again.release();
  });

  it('job files, cache and lock are not part of history', async () => {
    const store = make();
    await store.init();
    await store.writeJob('j1', { a: 1 });
    const lock = await store.lock();
    await store.applyChanges([{ type: 'write', path: 'pages/a.md', content: 'A' }], 'run');
    await lock.release();
    if (useGit) {
      const files = (await git(store.dir, ['ls-files'])).trim().split('\n');
      expect(files.some((f) => f.startsWith('.jobs/') || f.startsWith('.cache/') || f === '.lock')).toBe(false);
      expect(files).toContain('pages/a.md');
    } else {
      const snaps = await readdir(path.join(store.dir, '.snapshots'));
      for (const s of snaps) {
        const m = JSON.parse(await readFile(path.join(store.dir, '.snapshots', s, 'manifest.json'), 'utf8')) as { files: string[] };
        expect(m.files.some((f) => f.startsWith('.jobs/') || f.startsWith('.cache/') || f === '.lock')).toBe(false);
      }
    }
  });
});

describe.skipIf(!hasGit)('MemoryStore inside a parent git repo', () => {
  it('keeps the parent repo untouched except for the .gitignore line', async () => {
    const proj = path.join(root, 'proj');
    await mkdir(proj);
    await git(proj, ['init', '-q']);
    await writeFile(path.join(proj, 'app.ts'), 'export {};\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-q', '-m', 'init']);
    const head = (await git(proj, ['rev-parse', 'HEAD'])).trim();

    const store = new MemoryStore(proj, { git: true });
    await store.init();
    await store.applyChanges([{ type: 'write', path: 'pages/a.md', content: 'A' }], 'dream: a');
    await store.rollback();

    expect((await git(proj, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await git(proj, ['log', '--oneline'])).trim().split('\n')).toHaveLength(1);
    // Only the new .gitignore shows up; .dream/ itself is ignored.
    expect((await git(proj, ['status', '--porcelain'])).trim()).toBe('?? .gitignore');
    expect(await readFile(path.join(proj, '.gitignore'), 'utf8')).toBe('.dream/\n');
    expect((await git(proj, ['diff', '--cached', '--name-only'])).trim()).toBe('');
    const dreamTop = (await git(store.dir, ['rev-parse', '--show-toplevel'])).trim();
    // Compare real paths: on some Windows hosts TEMP is an 8.3 short path (RUNNER~1) while git reports the long one.
    expect(realpathSync.native(path.resolve(dreamTop)).toLowerCase()).toBe(realpathSync.native(store.dir).toLowerCase());
    const messages = (await store.listRuns()).map((r) => r.message);
    expect(messages[0]).toContain('Revert "dream: a"');
    expect(messages.slice(1)).toEqual(['dream: a', 'agent-dream: initialize memory']);
    expect(await store.readPage('a')).toBeNull();
  });
});
