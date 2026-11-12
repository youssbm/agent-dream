import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizePath, samePath } from '../../src/transcripts/paths.ts';
import { defaultAdapters } from '../../src/transcripts/registry.ts';
import { ClaudeCodeAdapter } from '../../src/transcripts/claude-code.ts';
import { CodexAdapter } from '../../src/transcripts/codex.ts';
import { OpencodeAdapter } from '../../src/transcripts/opencode.ts';

describe('normalizePath', () => {
  it('normalizes Windows paths on any platform', () => {
    expect(normalizePath('C:\\Users\\Dev\\Proj\\')).toBe('c:/Users/Dev/Proj');
    expect(normalizePath('C:/Users/Dev/Proj')).toBe('c:/Users/Dev/Proj');
    expect(normalizePath('\\\\?\\C:\\Users\\Dev\\Proj')).toBe('c:/Users/Dev/Proj');
    expect(normalizePath('C:\\Users\\Dev\\..\\Dev\\.\\Proj')).toBe('c:/Users/Dev/Proj');
    expect(normalizePath('C:\\')).toBe('c:/');
    expect(normalizePath('\\\\server\\share\\dir\\')).toBe('//server/share/dir');
    expect(normalizePath('\\\\?\\UNC\\server\\share\\dir')).toBe('//server/share/dir');
  });

  it('normalizes POSIX paths', () => {
    expect(normalizePath('/home/dev/proj/')).toBe('/home/dev/proj');
    expect(normalizePath('/home/dev//proj/./x/..')).toBe('/home/dev/proj');
    expect(normalizePath('/')).toBe('/');
  });

  it('resolves relative paths against the current directory', () => {
    expect(normalizePath('some/rel')).toBe(normalizePath(path.resolve('some/rel')));
    expect(normalizePath('')).toBe('');
  });
});

describe('samePath', () => {
  it('compares Windows paths case- and slash-insensitively', () => {
    expect(samePath('C:\\Users\\Dev\\Proj', 'c:/users/dev/proj/')).toBe(true);
    expect(samePath('\\\\?\\C:\\Users\\Dev\\Proj', 'C:/Users/Dev/Proj')).toBe(true);
    expect(samePath('C:\\Users\\Dev\\Proj', 'C:\\Users\\Dev\\Proj2')).toBe(false);
  });

  it('is case-sensitive for POSIX paths on POSIX hosts', () => {
    expect(samePath('/home/dev/proj', '/home/dev/proj/')).toBe(true);
    expect(samePath('/home/dev/Proj', '/home/dev/proj')).toBe(process.platform === 'win32');
  });

  it('never matches missing values', () => {
    expect(samePath(undefined, '/x')).toBe(false);
    expect(samePath('/x', null)).toBe(false);
    expect(samePath('', '')).toBe(false);
  });
});

describe('defaultAdapters', () => {
  it('returns the three built-in adapters rooted at homeDir', () => {
    const home = path.join(path.sep, 'tmp', 'fake-home');
    const list = defaultAdapters({ homeDir: home });
    expect(list.map((a) => a.harness)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(list[0]).toBeInstanceOf(ClaudeCodeAdapter);
    expect((list[0] as ClaudeCodeAdapter).root).toBe(path.join(home, '.claude', 'projects'));
    expect((list[1] as CodexAdapter).roots).toEqual([path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')]);
    expect((list[2] as OpencodeAdapter).dbPath).toBe(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  });

  it('reports nothing available for an empty home', async () => {
    const list = defaultAdapters({ homeDir: path.join(path.sep, 'definitely', 'not', 'here') });
    for (const a of list) {
      expect(await a.available()).toBe(false);
      expect(await a.listSessions()).toEqual([]);
    }
  });
});
