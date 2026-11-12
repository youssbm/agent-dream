import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from '../../src/args.ts';

const cwd = path.resolve('/work/cwd');

describe('parseArgs', () => {
  it('defaults to the current directory', () => {
    expect(parseArgs([], {}, cwd)).toEqual({ kind: 'run', projectDir: cwd });
  });

  it('uses AGENT_DREAM_PROJECT when set', () => {
    expect(parseArgs([], { AGENT_DREAM_PROJECT: 'sub' }, cwd)).toEqual({
      kind: 'run',
      projectDir: path.resolve(cwd, 'sub'),
    });
    expect(parseArgs([], { AGENT_DREAM_PROJECT: '  ' }, cwd)).toEqual({ kind: 'run', projectDir: cwd });
  });

  it('falls back to CLAUDE_PROJECT_DIR, after AGENT_DREAM_PROJECT', () => {
    expect(parseArgs([], { CLAUDE_PROJECT_DIR: 'claude' }, cwd)).toEqual({
      kind: 'run',
      projectDir: path.resolve(cwd, 'claude'),
    });
    expect(parseArgs([], { AGENT_DREAM_PROJECT: 'mine', CLAUDE_PROJECT_DIR: 'claude' }, cwd)).toEqual({
      kind: 'run',
      projectDir: path.resolve(cwd, 'mine'),
    });
  });

  it('--project wins over the env var, in both forms', () => {
    const env = { AGENT_DREAM_PROJECT: 'envdir' };
    const abs = path.resolve('/abs/proj');
    expect(parseArgs(['--project', abs], env, cwd)).toEqual({ kind: 'run', projectDir: abs });
    expect(parseArgs(['--project=rel'], env, cwd)).toEqual({ kind: 'run', projectDir: path.resolve(cwd, 'rel') });
    expect(parseArgs(['-p', 'x'], env, cwd)).toEqual({ kind: 'run', projectDir: path.resolve(cwd, 'x') });
  });

  it('handles --help and --version', () => {
    expect(parseArgs(['--help'], {}, cwd)).toEqual({ kind: 'help' });
    expect(parseArgs(['-h', '--project', 'x'], {}, cwd)).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'], {}, cwd)).toEqual({ kind: 'version' });
    expect(parseArgs(['-v'], {}, cwd)).toEqual({ kind: 'version' });
    expect(USAGE).toContain('--project');
  });

  it('reports errors for unknown or incomplete arguments', () => {
    expect(parseArgs(['--nope'], {}, cwd)).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--project'], {}, cwd)).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--project', '--help'], {}, cwd)).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--project='], {}, cwd)).toMatchObject({ kind: 'error' });
  });
});
