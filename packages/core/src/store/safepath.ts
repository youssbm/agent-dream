/**
 * Containment checks for everything written under `.dream/`.
 *
 * A hostile checkout (or a confused user) can turn `.dream/` itself, or a folder inside it, into a symlink or a
 * Windows junction that points somewhere else. Every write/delete goes through these checks first:
 *  - `realpath(.dream)` must be exactly `<realpath(project)>/.dream`;
 *  - every directory between `.dream/` and the target is a real directory (lstat: not a symlink/junction) whose
 *    realpath stays inside `realpath(.dream)`;
 *  - the target file itself is not a symlink.
 * Violations throw `DreamError('PATH_OUTSIDE_MEMORY')`.
 */
import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { DreamError } from '../types.ts';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** Resolved, forward-slash, no trailing slash, lowercased on case-insensitive platforms. */
export function normPath(p: string): string {
  let s = path.resolve(p).replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
}

/** True when `child` equals `parent` or lies below it (both already real paths). */
export function isInside(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

function refuse(message: string): never {
  throw new DreamError('PATH_OUTSIDE_MEMORY', message);
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (err) {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Verify that `dreamDir` is a real directory directly inside its parent (the project): not a symlink/junction and
 * `realpath(dreamDir) === realpath(dirname(dreamDir)) / basename(dreamDir)`. Returns `realpath(dreamDir)`.
 */
export async function checkDreamRoot(dreamDir: string): Promise<string> {
  const abs = path.resolve(dreamDir);
  const st = await lstatOrNull(abs);
  if (!st) refuse(`Memory folder ${abs} does not exist`);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    refuse(`Memory folder ${abs} is a symlink/junction or not a directory; refusing to write through it`);
  }
  const realParent = await realpath(path.dirname(abs));
  const realDream = await realpath(abs);
  if (normPath(realDream) !== normPath(path.join(realParent, path.basename(abs)))) {
    refuse(`Memory folder ${abs} resolves to ${realDream}, outside the project; refusing to write`);
  }
  return realDream;
}

/**
 * Ensure every segment of `rel` (forward-slash path relative to `dreamDir`, '' = the root itself) is a real
 * directory inside `realDream`. Missing segments are created when `create` is set; otherwise returns false when
 * a segment is missing. Returns true when the whole chain exists and is safe.
 */
export async function ensureSafeDir(
  dreamDir: string,
  realDream: string,
  rel: string,
  create = true,
): Promise<boolean> {
  let cur = path.resolve(dreamDir);
  const segs = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  for (const seg of segs) {
    if (seg === '..') refuse(`Refusing path with '..': ${rel}`);
    cur = path.join(cur, seg);
    let st = await lstatOrNull(cur);
    if (!st) {
      if (!create) return false;
      try {
        await mkdir(cur);
      } catch (err) {
        if (errCode(err) !== 'EEXIST') throw err;
      }
      st = await lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      refuse(`${cur} is a symlink/junction or not a directory; refusing to write through it`);
    }
  }
  const real = await realpath(cur);
  if (!isInside(real, realDream)) refuse(`${cur} resolves to ${real}, outside the memory folder`);
  return true;
}

/** Refuse when `file` exists and is a symlink (or junction). Missing files are fine. */
export async function assertNotLink(file: string): Promise<void> {
  const st = await lstatOrNull(file);
  if (st?.isSymbolicLink()) refuse(`${file} is a symlink; refusing to write through it`);
}
