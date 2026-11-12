/**
 * In-memory `TranscriptAdapter` for dream-bench scenarios.
 *
 * Sessions are fully synthetic (built with {@link SessionBuilder}); nothing is read from the real
 * transcript stores on this machine. The adapter records every call so scenarios can assert that the
 * engine only ever reads transcripts.
 */
import path from 'node:path';
import { DreamError } from '@agent-dream/core';
import type {
  Harness,
  ListSessionsOptions,
  Role,
  SessionInfo,
  TranscriptAdapter,
  TranscriptMessage,
  TranscriptPart,
} from '@agent-dream/core';

/** A synthetic session: metadata plus its normalized, unfiltered messages. */
export interface FakeSession {
  info: SessionInfo;
  messages: TranscriptMessage[];
}

/** One recorded adapter call (for assertions). */
export interface AdapterCall {
  method: 'available' | 'listSessions' | 'readSession';
  arg?: unknown;
}

/** Path comparison used for the `cwd` filter: resolved, forward slashes, case-insensitive on Windows. */
function normPath(p: string): string {
  let s = path.resolve(p).replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** In-memory transcript adapter serving a fixed set of synthetic sessions for one harness. */
export class FakeAdapter implements TranscriptAdapter {
  readonly harness: Harness;
  readonly calls: AdapterCall[] = [];
  private readonly sessions: FakeSession[];

  constructor(harness: Harness, sessions: FakeSession[]) {
    this.harness = harness;
    this.sessions = sessions.filter((s) => s.info.harness === harness);
  }

  async available(): Promise<boolean> {
    this.calls.push({ method: 'available' });
    return true;
  }

  async listSessions(opts?: ListSessionsOptions): Promise<SessionInfo[]> {
    this.calls.push({ method: 'listSessions', arg: opts });
    let list = this.sessions.map((s) => ({ ...s.info }));
    if (opts?.cwd) {
      const want = normPath(opts.cwd);
      list = list.filter((s) => s.cwd !== undefined && normPath(s.cwd) === want);
    }
    if (opts?.since) {
      const since = Date.parse(opts.since);
      list = list.filter((s) => Date.parse(s.updatedAt) >= since);
    }
    list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    if (opts?.limit !== undefined) list = list.slice(0, opts.limit);
    return list;
  }

  async readSession(id: string): Promise<TranscriptMessage[]> {
    this.calls.push({ method: 'readSession', arg: id });
    const s = this.sessions.find((x) => x.info.id === id);
    if (!s) throw new DreamError('SESSION_NOT_FOUND', `fake ${this.harness} session not found: ${id}`);
    // Deep copy so the engine can never mutate the "ground truth".
    return s.messages.map((m) => ({ ...m, parts: m.parts.map((p) => ({ ...p })) }));
  }
}

/** Build one adapter per harness present in `sessions` (all harnesses get one, possibly empty). */
export function fakeAdapters(sessions: FakeSession[]): FakeAdapter[] {
  const harnesses: Harness[] = ['claude-code', 'codex', 'opencode'];
  return harnesses.map((h) => new FakeAdapter(h, sessions));
}

/**
 * Fluent builder for synthetic sessions. Message `idx` values are assigned in order starting at 0,
 * and each builder method returns the idx of the message it added so scenarios can cite exact ranges.
 */
export class SessionBuilder {
  readonly harness: Harness;
  readonly id: string;
  private readonly cwd: string;
  private readonly start: number;
  private readonly stepMs: number;
  private readonly title: string | undefined;
  private readonly msgs: TranscriptMessage[] = [];

  /**
   * @param startedAt ISO time of the first message; each further message is `stepMs` later.
   */
  constructor(opts: { harness: Harness; id: string; cwd: string; startedAt: string; stepMs?: number; title?: string }) {
    this.harness = opts.harness;
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.start = Date.parse(opts.startedAt);
    this.stepMs = opts.stepMs ?? 20_000;
    this.title = opts.title;
  }

  /** idx the next message will get. */
  get nextIdx(): number {
    return this.msgs.length;
  }

  private push(role: Role, parts: TranscriptPart[]): number {
    const idx = this.msgs.length;
    this.msgs.push({
      harness: this.harness,
      session: this.id,
      idx,
      role,
      ts: new Date(this.start + idx * this.stepMs).toISOString(),
      parts,
    });
    return idx;
  }

  user(text: string): number {
    return this.push('user', [{ kind: 'text', text }]);
  }

  assistant(text: string): number {
    return this.push('assistant', [{ kind: 'text', text }]);
  }

  /** Assistant message with optional text followed by one tool call. */
  toolCall(tool: string, args: string, text?: string): number {
    const parts: TranscriptPart[] = [];
    if (text) parts.push({ kind: 'text', text });
    parts.push({ kind: 'tool_call', tool, text: `${tool} ${args}` });
    return this.push('assistant', parts);
  }

  /** Tool result message (role 'tool'). */
  toolResult(tool: string, text: string): number {
    return this.push('tool', [{ kind: 'tool_result', tool, text }]);
  }

  /** Assistant reasoning (dropped by the filter; still part of the unfiltered transcript). */
  reasoning(text: string): number {
    return this.push('assistant', [{ kind: 'reasoning', text }]);
  }

  build(): FakeSession {
    const last = this.msgs[this.msgs.length - 1];
    const updatedAt = last?.ts ?? new Date(this.start).toISOString();
    return {
      info: {
        harness: this.harness,
        id: this.id,
        cwd: this.cwd,
        title: this.title,
        startedAt: new Date(this.start).toISOString(),
        updatedAt,
        messageCount: this.msgs.length,
        location: `fake://${this.harness}/${this.id}`,
      },
      messages: this.msgs.map((m) => ({ ...m, parts: m.parts.map((p) => ({ ...p })) })),
    };
  }
}
