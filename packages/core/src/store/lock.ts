/**
 * Exclusive lock on a memory folder via a `.lock` file created with the `wx` flag.
 *
 * Taking over a stale lock is serialized by a second, short-lived mutex file (`.lock.takeover`, also created with
 * `wx`): only the process holding it may remove a stale `.lock`, and it re-checks that the lock it removes is
 * byte-for-byte the one it judged stale. A lock that was put aside by mistake is restored with `link`, which never
 * overwrites a lock someone else created meanwhile.
 */
import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DreamError } from '../types.ts';
import type { LockHandle } from '../types.ts';

/** Lock file name inside `.dream/`. */
export const LOCK_FILE = '.lock';

/** Mutex file held only while a stale lock is being taken over. */
export const TAKEOVER_FILE = '.lock.takeover';

/** Default time after which a lock is considered stale. */
export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/** A takeover mutex older than this was left behind by a crashed process and may be removed. */
const TAKEOVER_STALE_MS = 30_000;

interface LockInfo {
  pid: number;
  host: string;
  time: number;
  token: string;
}

function parseLockInfo(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    if (typeof v.pid === 'number' && typeof v.time === 'number' && typeof v.host === 'string' && typeof v.token === 'string') {
      return { pid: v.pid, host: v.host, time: v.time, token: v.token };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** True when a process with this pid exists (on this host). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

function lockedError(who?: string): DreamError {
  return new DreamError('LOCKED', `Memory folder is locked by ${who ?? 'another process'}. Try again later.`);
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

/** Create `file` with `content` exclusively; false when it already exists. */
async function createExclusive(file: string, content: string): Promise<boolean> {
  try {
    await writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return false;
    throw err;
  }
}

/** Put `aside` back at `file` without overwriting a file created there meanwhile. */
async function restoreAside(aside: string, file: string): Promise<void> {
  try {
    await link(aside, file);
    await unlink(aside).catch(() => undefined);
    return;
  } catch (err) {
    if (isErrno(err, 'EEXIST')) {
      await unlink(aside).catch(() => undefined);
      return;
    }
  }
  // Hard links unsupported on this file system: best effort, only when the slot is still empty.
  if ((await readOrNull(file)) === null) await rename(aside, file).catch(() => undefined);
}

type TakeoverResult = 'acquired' | 'retry' | 'busy';

/**
 * Under the takeover mutex: remove the stale lock (only if it still has `staleContent`) and create ours.
 */
async function takeOver(dreamDir: string, staleContent: string, content: string): Promise<TakeoverResult> {
  const file = path.join(dreamDir, LOCK_FILE);
  const mutex = path.join(dreamDir, TAKEOVER_FILE);
  if (!(await createExclusive(mutex, JSON.stringify({ pid: process.pid, time: Date.now() })))) {
    try {
      if (Date.now() - (await stat(mutex)).mtimeMs > TAKEOVER_STALE_MS) {
        await unlink(mutex); // left behind by a crashed process
        return 'retry';
      }
    } catch {
      return 'retry'; // released meanwhile
    }
    return 'busy';
  }
  try {
    const aside = `${file}.stale-${randomBytes(4).toString('hex')}`;
    try {
      await rename(file, aside);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return 'retry';
      // Windows: the lock file is open elsewhere right now; treat as contention.
      if (isErrno(err, 'EPERM') || isErrno(err, 'EBUSY') || isErrno(err, 'EACCES')) return 'busy';
      throw err;
    }
    if ((await readOrNull(aside)) !== staleContent) {
      // Not the lock we judged stale (released and re-acquired meanwhile): put it back untouched.
      await restoreAside(aside, file);
      return 'retry';
    }
    await unlink(aside).catch(() => undefined);
    return (await createExclusive(file, content)) ? 'acquired' : 'retry';
  } finally {
    await unlink(mutex).catch(() => undefined);
  }
}

/**
 * Acquire the exclusive lock on `dreamDir`. The lock file holds pid, host, time and a random token.
 * An existing lock is taken over when it is older than `ttlMs`, unreadable and older than `ttlMs`,
 * or held by a dead pid on this host. Otherwise throws `DreamError('LOCKED')`.
 * The lock is not re-entrant: a second acquire in the same process also throws.
 */
export async function acquireLock(dreamDir: string, ttlMs: number = DEFAULT_LOCK_TTL_MS): Promise<LockHandle> {
  await mkdir(dreamDir, { recursive: true });
  const file = path.join(dreamDir, LOCK_FILE);
  const info: LockInfo = { pid: process.pid, host: os.hostname(), time: Date.now(), token: randomBytes(12).toString('hex') };
  const content = JSON.stringify(info);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(file, content)) return verified(file, info.token);

    // Lock exists: decide whether it is stale.
    let existing: string | null;
    let mtimeMs: number;
    try {
      existing = await readOrNull(file);
      if (existing === null) continue; // released meanwhile; retry
      mtimeMs = (await stat(file)).mtimeMs;
    } catch (err) {
      if (isErrno(err, 'ENOENT')) continue;
      throw err;
    }
    const held = parseLockInfo(existing);
    const now = Date.now();
    const stale = held
      ? now - held.time > ttlMs || (held.host === os.hostname() && held.pid !== process.pid && !pidAlive(held.pid))
      : now - mtimeMs > ttlMs;
    if (!stale) {
      throw lockedError(held ? `pid ${held.pid} on ${held.host} since ${new Date(held.time).toISOString()}` : undefined);
    }

    const r = await takeOver(dreamDir, existing, content);
    if (r === 'acquired') return verified(file, info.token);
    if (r === 'busy') throw lockedError();
  }
  throw new DreamError('LOCKED', 'Could not acquire the memory folder lock. Try again later.');
}

/** Re-read the lock after creating it and confirm it still carries our token. */
async function verified(file: string, token: string): Promise<LockHandle> {
  const cur = parseLockInfo((await readOrNull(file)) ?? '');
  if (!cur || cur.token !== token) throw lockedError();
  return makeHandle(file, token);
}

function makeHandle(file: string, token: string): LockHandle {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const cur = parseLockInfo(await readFile(file, 'utf8'));
        if (cur && cur.token === token) await unlink(file);
      } catch {
        /* already gone */
      }
    },
  };
}
