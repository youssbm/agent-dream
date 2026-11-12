/**
 * Path normalization used to match a session's working directory against the project directory.
 *
 * Harnesses record cwd in different spellings (`C:\Users\x\proj`, `C:/Users/x/proj`, `\\?\C:\…`,
 * `/home/x/proj/`). Windows-style paths are recognised on every platform, so fixtures and tests behave the
 * same on Linux and Windows.
 */
import path from 'node:path';

const WIN_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const WIN_UNC = /^[\\/]{2}(?![\\/?.])/;

/** True for `C:\…`, `C:/…`, `\\server\share` and verbatim `\\?\…` paths. */
function isWindowsStyle(p: string): boolean {
  return WIN_DRIVE.test(p) || WIN_UNC.test(p);
}

/** Strip Win32 verbatim prefixes: `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share` → `\\srv\share`. */
function stripVerbatim(p: string): string {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(p)) return '\\\\' + p.slice(8);
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return p.slice(4);
  return p;
}

function stripTrailing(p: string): string {
  // Keep roots: "/", "c:/", "//server/share/" → "//server/share".
  if (p === '/' || /^[a-z]:\/$/.test(p)) return p;
  return p.replace(/\/+$/, '') || '/';
}

/**
 * Canonical spelling of an absolute path: resolved, forward slashes, no trailing slash (except roots),
 * lowercase drive letter, verbatim prefix removed. Relative paths are resolved against `process.cwd()`.
 * Case is preserved (use {@link samePath} for comparisons).
 */
export function normalizePath(p: string): string {
  let s = stripVerbatim(p.trim());
  if (s === '') return s;
  if (isWindowsStyle(s)) {
    s = path.win32.normalize(s).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1);
    if (/^[a-z]:$/.test(s)) s += '/';
    return stripTrailing(s);
  }
  if (s.startsWith('/')) return stripTrailing(path.posix.normalize(s));
  // Relative (or something odd like "~"): resolve with the host's rules and normalize the result.
  const resolved = path.resolve(s);
  return resolved === s ? stripTrailing(s.replace(/\\/g, '/')) : normalizePath(resolved);
}

/**
 * Whether two paths name the same directory. Comparison is case-insensitive on Windows and whenever
 * either side is a Windows-style path; case-sensitive otherwise. Missing values never match.
 */
export function samePath(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;
  const insensitive = process.platform === 'win32' || isWindowsStyle(stripVerbatim(a.trim())) || isWindowsStyle(stripVerbatim(b.trim()));
  return insensitive && na.toLowerCase() === nb.toLowerCase();
}
