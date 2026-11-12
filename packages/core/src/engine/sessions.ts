/**
 * Transcript access for the engine: adapter lookup, session discovery and a bounded per-instance cache of
 * raw (unfiltered, for evidence checks) and filtered (for model input) messages.
 *
 * Cache entries are keyed by session and remember the `updatedAt` they were read at: a caller that knows a
 * newer `updatedAt` (from `listSessions`) gets a fresh read. The cache is an LRU of at most
 * {@link CACHE_MAX_SESSIONS} sessions / {@link CACHE_MAX_BYTES} estimated bytes.
 */
import type { DreamConfig, DreamState, Harness, SessionInfo, TranscriptAdapter, TranscriptMessage } from '../types.ts';
import { DREAM_PROMPT_FIRST_LINE, DREAM_TOOL_NAMES, DreamError, RESUME_PROMPT_FIRST_LINE } from '../types.ts';
import { DREAM_RUN_STUB, filterMessages, isDreamCall, isDreamTraffic } from '../transcripts/filter.ts';

export interface LoadedSession {
  harness: Harness;
  session: string;
  /** Unfiltered normalized messages (ground truth for quotes). */
  raw: TranscriptMessage[];
  /** Filtered messages (what the model sees). */
  filtered: TranscriptMessage[];
}

/** Max sessions kept in the cache. */
export const CACHE_MAX_SESSIONS = 8;
/** Max estimated bytes (UTF-16: 2 bytes per char of raw + filtered text) kept in the cache. */
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;

interface CacheEntry {
  updatedAt?: string;
  promise: Promise<LoadedSession>;
  bytes: number;
}

function estimateBytes(msgs: TranscriptMessage[]): number {
  let n = 0;
  for (const m of msgs) for (const p of m.parts) n += p.text.length * 2 + 32;
  return n + msgs.length * 64;
}

/** Session access over a set of adapters, with a bounded in-memory cache. */
export class SessionSource {
  private readonly cache = new Map<string, CacheEntry>();
  private availableP: Promise<TranscriptAdapter[]> | undefined;

  private readonly adapters: TranscriptAdapter[];

  constructor(adapters: TranscriptAdapter[]) {
    this.adapters = adapters;
  }

  /** Adapters whose store exists on this machine (checked once per instance). */
  available(): Promise<TranscriptAdapter[]> {
    this.availableP ??= (async () => {
      const out: TranscriptAdapter[] = [];
      for (const a of this.adapters) {
        try {
          if (await a.available()) out.push(a);
        } catch {
          /* treat as unavailable */
        }
      }
      return out;
    })();
    return this.availableP;
  }

  /** Available adapters restricted to the configured harnesses (and optionally one harness). */
  async enabled(config: DreamConfig, harness?: Harness): Promise<TranscriptAdapter[]> {
    const list = await this.available();
    return list.filter((a) => config.harnesses.includes(a.harness) && (!harness || a.harness === harness));
  }

  adapter(harness: Harness): TranscriptAdapter | undefined {
    return this.adapters.find((a) => a.harness === harness);
  }

  /** Sessions across adapters, most recently updated first. Adapter failures are skipped. */
  async list(
    adapters: TranscriptAdapter[],
    opts: { cwd?: string; since?: string; limit?: number },
  ): Promise<SessionInfo[]> {
    const all: SessionInfo[] = [];
    for (const a of adapters) {
      try {
        all.push(...(await a.listSessions({ cwd: opts.cwd, since: opts.since, limit: opts.limit })));
      } catch {
        /* skip a broken store */
      }
    }
    all.sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
    return opts.limit !== undefined ? all.slice(0, opts.limit) : all;
  }

  /** Number of cached sessions (tests/diagnostics). */
  get cachedSessions(): number {
    return this.cache.size;
  }

  /** Drop a cached session so the next load reads it again. */
  invalidate(harness: Harness, session: string): void {
    this.cache.delete(`${harness}:${session}`);
  }

  /**
   * Read (and cache) a session. When `updatedAt` is given and differs from the cached read, the session is
   * read again. Throws DreamError('SESSION_NOT_FOUND').
   */
  load(harness: Harness, session: string, updatedAt?: string): Promise<LoadedSession> {
    const key = `${harness}:${session}`;
    const hit = this.cache.get(key);
    if (hit && (updatedAt === undefined || hit.updatedAt === updatedAt)) {
      // LRU: move to the end.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.promise;
    }
    const entry: CacheEntry = { updatedAt, bytes: 0, promise: Promise.resolve(null as unknown as LoadedSession) };
    entry.promise = (async () => {
      const a = this.adapter(harness);
      if (!a) throw new DreamError('SESSION_NOT_FOUND', `No transcript adapter for harness ${harness}.`);
      const raw = await a.readSession(session);
      const filtered = filterMessages(raw);
      entry.bytes = estimateBytes(raw) + estimateBytes(filtered);
      this.evict(key);
      return { harness, session, raw, filtered };
    })();
    this.cache.delete(key);
    this.cache.set(key, entry);
    entry.promise.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    this.evict(key);
    return entry.promise;
  }

  /** Evict least recently used entries beyond the caps (never the entry just loaded). */
  private evict(keep: string): void {
    let bytes = 0;
    for (const e of this.cache.values()) bytes += e.bytes;
    for (const [k, e] of this.cache) {
      if (this.cache.size <= CACHE_MAX_SESSIONS && bytes <= CACHE_MAX_BYTES) break;
      if (k === keep) continue;
      this.cache.delete(k);
      bytes -= e.bytes;
    }
  }

  /** Like `load` but returns null instead of throwing. */
  async tryLoad(harness: Harness, session: string, updatedAt?: string): Promise<LoadedSession | null> {
    try {
      return await this.load(harness, session, updatedAt);
    } catch {
      return null;
    }
  }

  /** Find a session id across adapters (first adapter that can read it); always re-reads it. */
  async find(adapters: TranscriptAdapter[], session: string): Promise<LoadedSession | null> {
    for (const a of adapters) {
      this.invalidate(a.harness, session);
      const s = await this.tryLoad(a.harness, session);
      if (s) return s;
    }
    return null;
  }
}

// ─── watermarks, skipped ranges and dream traffic ──────────────────────────

/** `${harness}:${session}` */
export function sessionKey(s: { harness: Harness; session?: string; id?: string }): string {
  return `${s.harness}:${s.session ?? s.id ?? ''}`;
}

/** Highest raw idx of a loaded session (-1 when empty). */
export function lastIdx(loaded: LoadedSession): number {
  let max = -1;
  for (const m of loaded.raw) if (m.idx > max) max = m.idx;
  return max;
}

/**
 * Rule for skipping a session without reading it: the last committed run saw it at this exact `updatedAt`,
 * processed it up to the last message it saw, and left no skipped ranges.
 */
export function sessionUnchanged(state: DreamState, info: Pick<SessionInfo, 'harness' | 'id' | 'updatedAt'>): boolean {
  const key = `${info.harness}:${info.id}`;
  const seen = state.seen?.[key];
  const wm = state.watermarks[key];
  if (!seen || wm === undefined) return false;
  if (seen.updatedAt !== info.updatedAt) return false;
  if (wm < seen.lastIdx) return false;
  return !(state.skipped?.[key]?.length);
}

const DREAM_TOOL_RE = new RegExp(`(?:^|[^a-z0-9])(?:${DREAM_TOOL_NAMES.join('|')})$`, 'i');
const DREAM_BEGIN_RE = /(?:^|[^a-z0-9])dream_begin$/i;

function isDreamTool(tool: string | undefined): boolean {
  return !!tool && DREAM_TOOL_RE.test(tool);
}

function startsWithPrompt(m: TranscriptMessage): boolean {
  if (m.role !== 'user') return false;
  const text = m.parts.map((p) => p.text).join('\n').trimStart();
  return text.startsWith(DREAM_PROMPT_FIRST_LINE) || text.startsWith(RESUME_PROMPT_FIRST_LINE);
}

/**
 * True for messages that belong to a dream run rather than to the project's work: the dream/resume prompt,
 * and messages whose tool calls/results are all dream protocol tools.
 */
export function isDreamMessage(m: TranscriptMessage): boolean {
  if (startsWithPrompt(m) || isDreamTraffic(m)) return true;
  const tools = m.parts.filter((p) => p.kind === 'tool_call' || p.kind === 'tool_result');
  return tools.length > 0 && tools.every((p) => isDreamTool(p.tool));
}

/** A filtered message that only carries the filter's collapsed-dream-run stub. */
export function isDreamStub(m: TranscriptMessage): boolean {
  return m.parts.length > 0 && m.parts.every((p) => p.text.trim() === DREAM_RUN_STUB);
}

/** idx values of dream-run messages (see {@link isDreamMessage}). */
export function dreamTrafficIdx(raw: TranscriptMessage[]): Set<number> {
  const out = new Set<number>();
  for (const m of raw) if (isDreamMessage(m)) out.add(m.idx);
  return out;
}

/**
 * idx of the message that starts the in-flight dream in the current thread, or undefined: the last
 * `dream_begin` call after the watermark (moved back to the dream prompt message right before it, when there
 * is one), else the last dream prompt message. Only counts when no later user message exists (otherwise the
 * marker belongs to an older, finished dream and the work after it is real).
 */
export function dreamCutIdx(raw: TranscriptMessage[], watermark: number): number | undefined {
  let cut: number | undefined;
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i] as TranscriptMessage;
    if (m.idx <= watermark) break;
    if (m.parts.some((p) => p.kind === 'tool_call' && (DREAM_BEGIN_RE.test(p.tool ?? '') || (isDreamCall(p) && /dream_begin/.test(p.text))))) {
      cut = m.idx;
      for (let j = i - 1; j >= 0; j--) {
        const prev = raw[j] as TranscriptMessage;
        if (prev.idx <= watermark) break;
        if (prev.role === 'user') {
          if (startsWithPrompt(prev)) cut = prev.idx;
          break;
        }
      }
      break;
    }
  }
  if (cut === undefined) {
    for (let i = raw.length - 1; i >= 0; i--) {
      const m = raw[i] as TranscriptMessage;
      if (m.idx <= watermark) break;
      if (startsWithPrompt(m)) {
        cut = m.idx;
        break;
      }
    }
  }
  if (cut === undefined) return undefined;
  const c = cut;
  const laterUser = raw.some((m) => m.idx > c && m.role === 'user' && !isDreamMessage(m));
  return laterUser ? undefined : c;
}

/** Inclusive idx range. */
export interface IdxRange {
  from: number;
  to: number;
}

/** Merge overlapping/adjacent inclusive ranges, sorted. */
export function mergeIdxRanges(ranges: IdxRange[]): IdxRange[] {
  const sorted = ranges.filter((r) => r.from <= r.to).sort((a, b) => a.from - b.from);
  const out: IdxRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** What a session still needs dreaming: ranges, the planned end, and the messages in them. */
export interface PendingWork {
  /** Ranges to offer (re-offered skipped ranges first in idx order, then the new tail). */
  ranges: IdxRange[];
  /** Raw last idx of the session (becomes the watermark when the session is planned). */
  lastIdx: number;
  /** End of the new range (before the in-flight dream for the current thread). */
  end: number;
  /** Filtered, non-dream messages inside the ranges. */
  messages: TranscriptMessage[];
}

/** Pending work of a loaded session given the stored state. `current`: cut before the in-flight dream. */
export function pendingWork(loaded: LoadedSession, state: DreamState, current: boolean): PendingWork {
  const key = sessionKey(loaded);
  const wm = state.watermarks[key] ?? -1;
  const last = lastIdx(loaded);
  const cut = current ? dreamCutIdx(loaded.raw, wm) : undefined;
  const end = cut !== undefined ? cut - 1 : last;
  const skipped = (state.skipped?.[key] ?? []).map(([from, to]) => ({ from, to }));
  const ranges = mergeIdxRanges([...skipped, { from: wm + 1, to: end }]);
  const dream = dreamTrafficIdx(loaded.raw);
  const messages = loaded.filtered.filter(
    (m) => !dream.has(m.idx) && !isDreamStub(m) && ranges.some((r) => m.idx >= r.from && m.idx <= r.to),
  );
  return { ranges, lastIdx: last, end, messages };
}
