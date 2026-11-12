import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHistory, gitAvailable } from '../../src/store/history.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dream-history-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Run git in a test repo (not the code under test). */
function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  env['GIT_TERMINAL_PROMPT'] = '0';
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
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

describe.skipIf(!hasGit)('git history', () => {
  it('commits, lists and reverts inside a project that is itself a git repo, leaving the parent untouched', async () => {
    const project = path.join(root, 'project');
    await mkdir(project);
    await git(project, ['init', '-q']);
    await writeFile(path.join(project, 'README.md'), 'hello\n');
    await writeFile(path.join(project, '.gitignore'), '.dream/\n');
    await git(project, ['add', '-A']);
    await git(project, ['commit', '-q', '-m', 'parent initial']);
    const parentHead = (await git(project, ['rev-parse', 'HEAD'])).trim();
    const parentLog = await git(project, ['log', '--oneline']);
    const parentConfig = await readFile(path.join(project, '.git', 'config'), 'utf8');

    const dreamDir = path.join(project, '.dream');
    const h = await createHistory(dreamDir, { git: true });
    expect(h.kind).toBe('git');
    await h.init();
    await h.init(); // idempotent
    expect(await exists(path.join(dreamDir, '.git'))).toBe(true);
    const top = (await git(dreamDir, ['rev-parse', '--show-toplevel'])).trim();
    expect(path.resolve(top).toLowerCase()).toBe(path.resolve(dreamDir).toLowerCase());
    const localName = (await git(dreamDir, ['config', '--local', 'user.name'])).trim();
    expect(localName).toBe('agent-dream');

    expect(await h.list()).toEqual([]);

    await mkdir(path.join(dreamDir, 'pages'));
    await writeFile(path.join(dreamDir, 'pages', 'a.md'), 'A1\n');
    const r1 = await h.commit('first run');
    expect(r1.id).toMatch(/^[0-9a-f]{40}$/);
    expect(r1.message).toBe('first run');
    expect(Number.isNaN(Date.parse(r1.ts))).toBe(false);

    await writeFile(path.join(dreamDir, 'pages', 'a.md'), 'A2\n');
    await writeFile(path.join(dreamDir, 'pages', 'b.md'), 'B\n');
    const r2 = await h.commit('# second run\n\nwith a markdown heading');
    expect(r2.message).toBe('# second run\n\nwith a markdown heading');

    const empty = await h.commit('nothing changed');
    expect(empty.id).not.toBe(r2.id);

    const runs = await h.list();
    expect(runs.map((r) => r.id)).toEqual([empty.id, r2.id, r1.id]);
    expect((await h.list(2)).length).toBe(2);

    // Revert run 2 explicitly.
    const rv = await h.revert(r2.id);
    expect(rv.message).toContain('Revert "# second run"');
    expect(rv.message).toContain(r2.id);
    expect(await readFile(path.join(dreamDir, 'pages', 'a.md'), 'utf8')).toBe('A1\n');
    expect(await exists(path.join(dreamDir, 'pages', 'b.md'))).toBe(false);

    // Revert the revert (default = latest).
    await h.revert();
    expect(await readFile(path.join(dreamDir, 'pages', 'a.md'), 'utf8')).toBe('A2\n');

    // Parent repo untouched: same HEAD, same log, clean status, same config.
    expect((await git(project, ['rev-parse', 'HEAD'])).trim()).toBe(parentHead);
    expect(await git(project, ['log', '--oneline'])).toBe(parentLog);
    expect((await git(project, ['status', '--porcelain'])).trim()).toBe('');
    expect(await readFile(path.join(project, '.git', 'config'), 'utf8')).toBe(parentConfig);
  });

  it('commits uncommitted edits before reverting and resolves overlapping hunks toward the restored state', async () => {
    const dreamDir = path.join(root, '.dream');
    const h = await createHistory(dreamDir, { git: true });
    await h.init();
    const state = (wm: number, reads: number) =>
      JSON.stringify({ version: 1, watermarks: { 'codex:s': wm }, sourceChars: wm * 10, reads: { p: reads } }, null, 2) + '\n';
    await writeFile(path.join(dreamDir, 'state.json'), state(0, 0));
    await writeFile(path.join(dreamDir, 'page.md'), 'old\n');
    await h.commit('init');
    await writeFile(path.join(dreamDir, 'state.json'), state(10, 0));
    await writeFile(path.join(dreamDir, 'page.md'), 'new\n');
    const run = await h.commit('run');
    // Uncommitted change touching the same file (read counter).
    await writeFile(path.join(dreamDir, 'state.json'), state(10, 3));
    await h.revert(run.id);
    expect(await readFile(path.join(dreamDir, 'page.md'), 'utf8')).toBe('old\n');
    const restored = JSON.parse(await readFile(path.join(dreamDir, 'state.json'), 'utf8')) as {
      watermarks: Record<string, number>;
    };
    expect(restored.watermarks['codex:s']).toBe(0);
    const msgs = (await h.list()).map((r) => r.message);
    expect(msgs[1]).toBe('agent-dream: save pending changes before rollback');
  });

  it('rejects bad or unknown run ids and empty history', async () => {
    const dreamDir = path.join(root, '.dream');
    const h = await createHistory(dreamDir, { git: true });
    await h.init();
    await expect(h.revert()).rejects.toMatchObject({ code: 'HISTORY' });
    await writeFile(path.join(dreamDir, 'x.md'), 'x\n');
    await h.commit('one');
    await expect(h.revert('--hard')).rejects.toMatchObject({ code: 'HISTORY' });
    await expect(h.revert('deadbeefdeadbeef')).rejects.toMatchObject({ code: 'HISTORY' });
  });

  it('respects .gitignore inside .dream and does not run user hooks', async () => {
    const dreamDir = path.join(root, '.dream');
    const h = await createHistory(dreamDir, { git: true });
    await h.init();
    await writeFile(path.join(dreamDir, '.gitignore'), '.cache/\n.jobs/\n.lock\n.snapshots/\n');
    await mkdir(path.join(dreamDir, '.cache'));
    await writeFile(path.join(dreamDir, '.cache', 'big.bin'), 'cache');
    await writeFile(path.join(dreamDir, '.lock'), '{}');
    // A failing pre-commit hook in the repo must not block or run.
    await mkdir(path.join(dreamDir, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(dreamDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(path.join(dreamDir, 'MEMORY.md'), '# Memory index\n');
    await h.commit('run');
    const files = (await git(dreamDir, ['ls-files'])).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'MEMORY.md']);
  });

  it('uses the injected clock for timestamps', async () => {
    const dreamDir = path.join(root, '.dream');
    const h = await createHistory(dreamDir, { git: true, now: () => new Date('2026-01-02T03:04:05.000Z') });
    await h.init();
    const r = await h.commit('timed');
    expect(r.ts).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('snapshot history (git disabled)', () => {
  it('commits, lists and reverts with snapshots', async () => {
    const dreamDir = path.join(root, '.dream');
    let t = Date.parse('2026-11-11T10:00:00.000Z');
    const h = await createHistory(dreamDir, { git: false, now: () => new Date((t += 1000)) });
    expect(h.kind).toBe('snapshot');
    await h.init();
    expect(await h.list()).toEqual([]);

    await mkdir(path.join(dreamDir, 'pages'), { recursive: true });
    await mkdir(path.join(dreamDir, '.cache'), { recursive: true });
    await mkdir(path.join(dreamDir, '.jobs'), { recursive: true });
    await writeFile(path.join(dreamDir, '.cache', 'c.txt'), 'cache');
    await writeFile(path.join(dreamDir, '.jobs', 'j.json'), '{}');
    await writeFile(path.join(dreamDir, '.lock'), '{}');
    await writeFile(path.join(dreamDir, 'MEMORY.md'), 'index v0\n');
    const r0 = await h.commit('init');

    await writeFile(path.join(dreamDir, 'pages', 'a.md'), 'A1\n');
    await writeFile(path.join(dreamDir, 'MEMORY.md'), 'index v1\n');
    const r1 = await h.commit('run 1');

    const manifest = JSON.parse(await readFile(path.join(dreamDir, '.snapshots', r1.id, 'manifest.json'), 'utf8')) as {
      files: string[];
    };
    expect(manifest.files).toEqual(['MEMORY.md', 'pages/a.md']);

    await writeFile(path.join(dreamDir, 'pages', 'a.md'), 'A2\n');
    await writeFile(path.join(dreamDir, 'pages', 'b.md'), 'B\n');
    const r2 = await h.commit('run 2');

    expect((await h.list()).map((r) => r.id)).toEqual([r2.id, r1.id, r0.id]);
    expect((await h.list(1)).map((r) => r.id)).toEqual([r2.id]);

    const rv = await h.revert();
    expect(rv.message).toContain('Revert "run 2"');
    expect(await readFile(path.join(dreamDir, 'pages', 'a.md'), 'utf8')).toBe('A1\n');
    expect(await exists(path.join(dreamDir, 'pages', 'b.md'))).toBe(false);
    // Untracked internals are preserved.
    expect(await readFile(path.join(dreamDir, '.cache', 'c.txt'), 'utf8')).toBe('cache');
    expect(await exists(path.join(dreamDir, '.jobs', 'j.json'))).toBe(true);
    expect(await exists(path.join(dreamDir, '.lock'))).toBe(true);

    // Revert run 1 explicitly → back to the init snapshot.
    await h.revert(r1.id);
    expect(await readFile(path.join(dreamDir, 'MEMORY.md'), 'utf8')).toBe('index v0\n');
    expect(await exists(path.join(dreamDir, 'pages', 'a.md'))).toBe(false);

    expect((await readdir(path.join(dreamDir, '.snapshots'))).some((n) => n.startsWith('.tmp-'))).toBe(false);
  });

  it('snapshots pending edits before reverting', async () => {
    const dreamDir = path.join(root, '.dream');
    const h = await createHistory(dreamDir, { git: false });
    await h.init();
    await writeFile(path.join(dreamDir, 'MEMORY.md'), 'v1\n');
    await h.commit('one');
    await writeFile(path.join(dreamDir, 'MEMORY.md'), 'v2\n');
    await h.commit('two');
    await writeFile(path.join(dreamDir, 'MEMORY.md'), 'v2-edited\n');
    await h.revert();
    expect(await readFile(path.join(dreamDir, 'MEMORY.md'), 'utf8')).toBe('v1\n');
    const msgs = (await h.list()).map((r) => r.message);
    expect(msgs[1]).toBe('agent-dream: save pending changes before rollback');
  });

  it('rejects bad ids and empty history', async () => {
    const dreamDir = path.join(root, '.dream');
    const h = await createHistory(dreamDir, { git: false });
    await h.init();
    await expect(h.revert()).rejects.toMatchObject({ code: 'HISTORY' });
    await h.commit('one');
    await expect(h.revert('../x')).rejects.toMatchObject({ code: 'HISTORY' });
    await expect(h.revert('nope')).rejects.toMatchObject({ code: 'HISTORY' });
  });
});
