import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../src/store/lock.ts';
import { DreamError } from '../../src/types.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dream-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** pid of a process that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid ?? 0));
  });
}

describe('acquireLock', () => {
  it('creates and releases the lock file', async () => {
    const lock = await acquireLock(dir);
    const info = JSON.parse(await readFile(path.join(dir, '.lock'), 'utf8')) as { pid: number; host: string };
    expect(info.pid).toBe(process.pid);
    expect(info.host).toBe(os.hostname());
    await lock.release();
    expect(await exists(path.join(dir, '.lock'))).toBe(false);
    await lock.release(); // idempotent
  });

  it('creates the directory when missing', async () => {
    const sub = path.join(dir, 'nested', '.dream');
    const lock = await acquireLock(sub);
    expect(await exists(path.join(sub, '.lock'))).toBe(true);
    await lock.release();
  });

  it('throws LOCKED on contention and succeeds after release', async () => {
    const a = await acquireLock(dir);
    await expect(acquireLock(dir)).rejects.toMatchObject({ code: 'LOCKED' });
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(DreamError);
    await a.release();
    const b = await acquireLock(dir);
    await b.release();
  });

  it('only one of many concurrent acquirers wins', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(dir)));
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as DreamError).code).toBe('LOCKED');
      else await r.value.release();
    }
  });

  it('takes over a lock older than the ttl', async () => {
    const old = { pid: process.pid, host: os.hostname(), time: Date.now() - 60_000, token: 'old' };
    await writeFile(path.join(dir, '.lock'), JSON.stringify(old));
    await expect(acquireLock(dir, 120_000)).rejects.toMatchObject({ code: 'LOCKED' });
    const lock = await acquireLock(dir, 30_000);
    const info = JSON.parse(await readFile(path.join(dir, '.lock'), 'utf8')) as { token: string };
    expect(info.token).not.toBe('old');
    await lock.release();
    expect((await readdir(dir)).filter((n) => n.startsWith('.lock'))).toEqual([]);
  });

  it('takes over a lock held by a dead process on this host', async () => {
    const pid = await deadPid();
    const held = { pid, host: os.hostname(), time: Date.now(), token: 'dead' };
    await writeFile(path.join(dir, '.lock'), JSON.stringify(held));
    const lock = await acquireLock(dir);
    await lock.release();
  });

  it('does not take over a fresh lock from another host even if the pid looks dead', async () => {
    const pid = await deadPid();
    const held = { pid, host: 'some-other-host.invalid', time: Date.now(), token: 'remote' };
    await writeFile(path.join(dir, '.lock'), JSON.stringify(held));
    await expect(acquireLock(dir)).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('treats an unreadable lock file by its age', async () => {
    const file = path.join(dir, '.lock');
    await writeFile(file, 'garbage');
    await expect(acquireLock(dir, 60_000)).rejects.toMatchObject({ code: 'LOCKED' });
    const past = new Date(Date.now() - 120_000);
    await utimes(file, past, past);
    const lock = await acquireLock(dir, 60_000);
    await lock.release();
  });

  it('release does not delete a lock taken over by someone else', async () => {
    const a = await acquireLock(dir);
    // Simulate a takeover by another holder.
    const other = { pid: process.pid, host: os.hostname(), time: Date.now(), token: 'other' };
    await writeFile(path.join(dir, '.lock'), JSON.stringify(other));
    await a.release();
    expect(await exists(path.join(dir, '.lock'))).toBe(true);
  });
});
