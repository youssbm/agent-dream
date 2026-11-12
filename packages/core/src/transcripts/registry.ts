/** The built-in transcript adapters. */
import type { TranscriptAdapter } from '../types.ts';
import { ClaudeCodeAdapter } from './claude-code.ts';
import { CodexAdapter } from './codex.ts';
import { OpencodeAdapter } from './opencode.ts';

/**
 * One adapter per supported harness, in a fixed order: Claude Code, Codex, opencode.
 * `homeDir` (default: the current user's home) is where each harness's store is looked up.
 */
export function defaultAdapters(opts: { homeDir?: string } = {}): TranscriptAdapter[] {
  const o = opts.homeDir ? { homeDir: opts.homeDir } : {};
  return [new ClaudeCodeAdapter(o), new CodexAdapter(o), new OpencodeAdapter(o)];
}
