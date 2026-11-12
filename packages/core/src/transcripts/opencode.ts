/**
 * opencode transcripts: SQLite database `~/.local/share/opencode/opencode.db` (`$XDG_DATA_HOME/opencode/…`),
 * opened strictly read-only through `node:sqlite` (loaded lazily; when unavailable the adapter reports
 * `available() === false`). Two schemas coexist and both are supported:
 *
 * v1 — `session`(id, directory, title, parent_id, time_created, time_updated [ms]),
 *      `message`(id, session_id, time_created, data JSON `{role, time, summary?, error?, …}`),
 *      `part`(id, message_id, session_id, data JSON) with `data.type`:
 *        `text` {text, synthetic?}, `reasoning` {text}, `tool` {tool, callID, state{status, input, output?, error?}},
 *        `file` {filename, mime, url}, `patch` {files[]}, and bookkeeping (`step-start`, `step-finish`, `compaction`, …).
 * v2 — `session_v2` (same session columns), `session_message`(id, session_id, type, seq, time_created, data):
 *        `user` {text, files?[]}, `assistant` {content[] of `text` {text} | `reasoning` {text} |
 *        `tool` {id, name, state{status, input, content?[] (text/file items), error?{message}}}, error?},
 *        `system` {text}, `synthetic` {text, metadata.source}, `compaction` {summary}, plus `idle`/`model-switched`
 *        (skipped); `session_part`(message_id, ordinal, type, call_id, data) — used when a message has no
 *        inline `content`.
 * A session is read from v2 when `session_message` has rows for it, else from v1. Child sessions
 * (`parent_id` set) are subagents and are not listed by default.
 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ListSessionsOptions, SessionInfo, TranscriptAdapter, TranscriptMessage, TranscriptPart } from '../types.ts';
import { DreamError } from '../types.ts';
import { samePath } from './paths.ts';
import { sinceMs, statOrNull, toIso } from './lines.ts';
import { MessageBuilder, asArray, asObject, asString, compactArgs, contentText, part } from './normalize.ts';
import type { AdapterOptions } from './claude-code.ts';

/** opencode specific options. */
export interface OpencodeAdapterOptions extends AdapterOptions {
  /** List child (subagent) sessions too. Default false. */
  includeChildren?: boolean;
  /** How long to keep retrying when the database is busy/locked (ms). Default 1500. */
  busyRetryMs?: number;
}

type SqliteModule = typeof import('node:sqlite');
type Row = Record<string, SQLInputValue>;

let sqliteModule: Promise<SqliteModule | null> | undefined;
/** `node:sqlite`, or null when this Node.js build lacks it. Loaded once, lazily. */
function loadSqlite(): Promise<SqliteModule | null> {
  sqliteModule ??= import('node:sqlite').then(
    (m) => m,
    () => null,
  );
  return sqliteModule;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SQLite busy timeout per attempt (blocks the event loop, so kept tiny). */
export const BUSY_TIMEOUT_MS = 20;

/** Whether the database currently has WAL/shared-memory/rollback-journal side files. */
async function hasSideFiles(dbPath: string): Promise<boolean> {
  for (const s of ['-wal', '-shm', '-journal']) if (await statOrNull(dbPath + s)) return true;
  return false;
}

function isBusy(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(msg);
}

interface SessionRow {
  id: string;
  directory?: string;
  title?: string;
  parent?: string;
  created?: number;
  updated?: number;
  v2: boolean;
}

/**
 * Reads opencode sessions from its SQLite database (read-only).
 *
 * `SessionInfo.messageCount` is left undefined: one database row expands into several normalized messages
 * (assistant text, tool call, tool result…), so a row count is not comparable with message idx values and
 * an exact count would require normalizing every session.
 *
 * idx stability: for a growing session, earlier idx values never shift. Every tool call is always followed
 * by its result message slot (`[pending]` while running, `[no output]` when empty) and compaction summaries
 * always occupy their slot (`[pending]` until written), so later updates to an existing row change message
 * text only, never the number of messages before later rows.
 */
export class OpencodeAdapter implements TranscriptAdapter {
  readonly harness = 'opencode' as const;
  /** Database file. */
  readonly dbPath: string;
  private readonly includeChildren: boolean;
  private readonly busyRetryMs: number;

  constructor(opts: OpencodeAdapterOptions = {}) {
    const xdg = !opts.homeDir && process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : undefined;
    this.dbPath =
      opts.dbPath ??
      (opts.root ? path.join(opts.root, 'opencode.db') : path.join(xdg ?? path.join(opts.homeDir ?? os.homedir(), '.local', 'share'), 'opencode', 'opencode.db'));
    this.includeChildren = opts.includeChildren ?? false;
    this.busyRetryMs = opts.busyRetryMs ?? 1500;
  }

  async available(): Promise<boolean> {
    try {
      if (!(await statOrNull(this.dbPath))?.isFile()) return false;
      if (!(await loadSqlite())) return false;
      return await this.withDb((db) => {
        const t = tables(db);
        return t.has('session') || t.has('session_v2');
      });
    } catch {
      return false;
    }
  }

  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionInfo[]> {
    if (!(await statOrNull(this.dbPath))?.isFile() || !(await loadSqlite())) return [];
    const since = sinceMs(opts.since);
    return this.withDb((db) => {
      const t = tables(db);
      const rows: SessionRow[] = [];
      const seen = new Set<string>();
      const read = (table: 'session_v2' | 'session', v2: boolean): void => {
        if (!t.has(table)) return;
        for (const r of db.prepare(`SELECT id, directory, title, parent_id, time_created, time_updated FROM ${table}`).all() as Row[]) {
          const id = String(r.id);
          if (seen.has(id)) continue;
          seen.add(id);
          rows.push({ id, directory: str(r.directory), title: str(r.title), parent: str(r.parent_id), created: num(r.time_created), updated: num(r.time_updated), v2 });
        }
      };
      read('session_v2', true);
      read('session', false);
      const picked = rows
        .filter((r) => this.includeChildren || !r.parent)
        .filter((r) => !opts.cwd || samePath(r.directory, opts.cwd))
        .filter((r) => since === undefined || (r.updated ?? r.created ?? 0) >= since)
        .sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0));
      const limited = opts.limit && opts.limit > 0 ? picked.slice(0, opts.limit) : picked;
      return limited.map((r) => {
        const info: SessionInfo = { harness: this.harness, id: r.id, updatedAt: toIso(r.updated ?? r.created ?? 0) ?? new Date(0).toISOString(), location: this.dbPath };
        if (r.directory) info.cwd = r.directory;
        if (r.title) info.title = r.title;
        const started = toIso(r.created);
        if (started) info.startedAt = started;
        return info;
      });
    });
  }

  async readSession(id: string): Promise<TranscriptMessage[]> {
    if (!(await statOrNull(this.dbPath))?.isFile() || !(await loadSqlite())) {
      throw new DreamError('SESSION_NOT_FOUND', `opencode session not found (no database at ${this.dbPath}): ${id}`);
    }
    const result = await this.withDb((db) => {
      const t = tables(db);
      if (t.has('session_message')) {
        const rows = db.prepare('SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq, time_created, id').all(id) as Row[];
        if (rows.length > 0) return readV2(db, t, id, rows);
      }
      if (t.has('message')) {
        const rows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(id) as Row[];
        const exists = rows.length > 0 || sessionExists(db, t, id);
        if (exists) return readV1(db, t, id, rows);
      } else if (sessionExists(db, t, id)) {
        return [];
      }
      return null;
    });
    if (!result) throw new DreamError('SESSION_NOT_FOUND', `opencode session not found: ${id}`);
    return result;
  }

  /**
   * Open read-only, run `fn`, close; retries briefly while the database is busy.
   *
   * Side files: a plain read-only connection to a WAL database creates `-wal`/`-shm` files and, being
   * read-only, cannot remove them on close (`mode=ro` URIs behave the same). So when no `-wal`/`-shm`/
   * `-journal` file exists (opencode is not running and the database is fully checkpointed) the database is
   * opened with `immutable=1`, which creates nothing; if that read fails for any reason it falls back to a
   * normal read-only connection. While opencode is running its side files already exist and the normal
   * read-only connection (which sees uncommitted-to-main WAL content) is used.
   *
   * Busy handling: SQLite's busy timeout blocks the event loop, so it is kept at {@link BUSY_TIMEOUT_MS};
   * longer waits happen in the async retry loop (up to `busyRetryMs`).
   */
  private async withDb<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    const sqlite = await loadSqlite();
    if (!sqlite) throw new Error('node:sqlite is not available');
    const deadline = Date.now() + this.busyRetryMs;
    let delay = 25;
    let tryImmutable = !(await hasSideFiles(this.dbPath));
    for (;;) {
      let db: DatabaseSync | undefined;
      const immutable = tryImmutable;
      try {
        let target: string | URL = this.dbPath;
        if (immutable) {
          target = pathToFileURL(this.dbPath);
          target.searchParams.set('immutable', '1');
        }
        db = new sqlite.DatabaseSync(target, { readOnly: true, timeout: BUSY_TIMEOUT_MS } as ConstructorParameters<SqliteModule['DatabaseSync']>[1]);
        const result = fn(db);
        // A writer that connected during an immutable read leaves side files: re-read under locking.
        if (immutable && (await hasSideFiles(this.dbPath))) throw new Error('database changed during immutable read');
        return result;
      } catch (e) {
        if (immutable) {
          // Possibly a writer started meanwhile: redo the read through a normal (locking) connection.
          tryImmutable = false;
          continue;
        }
        if (!isBusy(e) || Date.now() >= deadline) throw e;
      } finally {
        try {
          db?.close();
        } catch {
          /* already closed */
        }
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 400);
    }
  }
}

function tables(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[];
  return new Set(rows.map((r) => String(r.name)));
}

function sessionExists(db: DatabaseSync, t: Set<string>, id: string): boolean {
  for (const table of ['session_v2', 'session']) {
    if (t.has(table) && db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(id)) return true;
  }
  return false;
}

function str(v: SQLInputValue | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: SQLInputValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

function json(v: SQLInputValue | undefined): Record<string, unknown> {
  if (typeof v !== 'string') return {};
  try {
    return asObject(JSON.parse(v)) ?? {};
  } catch {
    return {};
  }
}

/** Result text of a tool that has not finished yet. */
export const PENDING_RESULT = '[pending]';
/** Result text of a finished tool that produced no output. */
export const EMPTY_RESULT = '[no output]';

/**
 * Tool state → result text: output / content items / error. Never empty, so every tool call always gets
 * its result message slot (see the idx stability note on {@link OpencodeAdapter}): `[pending]` while the
 * tool is still running, `[no output]` when it finished without output.
 */
function toolResultText(state: Record<string, unknown> | undefined): string {
  const err = state?.error;
  let text = '';
  if (state && (state.status === 'error' || err !== undefined)) {
    const msg = asString(err) ?? asString(asObject(err)?.message) ?? (err !== undefined ? contentText(err) : '');
    const out = state.output !== undefined ? contentText(state.output) : state.content !== undefined ? contentText(state.content) : '';
    return `[error] ${[msg, out].filter(Boolean).join('\n')}`.trimEnd();
  }
  if (state?.output !== undefined) text = contentText(state.output);
  else if (state?.content !== undefined) text = contentText(state.content);
  if (text !== '') return text;
  const done = state?.status === 'completed' || state?.status === 'done' || state?.status === 'success';
  return done ? EMPTY_RESULT : PENDING_RESULT;
}

function errorText(err: unknown): string | undefined {
  const o = asObject(err);
  if (!o) return asString(err);
  const msg = asString(o.message) ?? asString(asObject(o.data)?.message);
  const name = asString(o.name) ?? asString(o.type);
  if (!msg && !name) return undefined;
  return `[error] ${[name, msg].filter(Boolean).join(': ')}`;
}

function readV1(db: DatabaseSync, t: Set<string>, id: string, messages: Row[]): TranscriptMessage[] {
  const partsByMsg = new Map<string, Record<string, unknown>[]>();
  if (t.has('part')) {
    for (const r of db.prepare('SELECT message_id, id, data FROM part WHERE session_id = ? ORDER BY message_id, id').all(id) as Row[]) {
      const key = String(r.message_id);
      let list = partsByMsg.get(key);
      if (!list) partsByMsg.set(key, (list = []));
      list.push(json(r.data));
    }
  }
  const b = new MessageBuilder('opencode', id);
  for (const m of messages) {
    const data = json(m.data);
    const ts = toIso(num(m.time_created) ?? num(asObject(data.time)?.created as SQLInputValue));
    const role = data.role === 'assistant' ? 'assistant' : 'user';
    const parts = partsByMsg.get(String(m.id)) ?? [];
    if (role === 'assistant' && data.summary === true) {
      // Compaction summary written by the model: context, not a turn.
      // Always emitted (placeholder while the summary is still being written) so later idx values never shift.
      const text = parts.map((p) => (p.type === 'text' ? (asString(p.text) ?? '') : '')).filter(Boolean).join('\n');
      b.add('system', [part.text(`[compaction summary]\n${text || PENDING_RESULT}`)], ts);
      continue;
    }
    if (role === 'user') {
      const typed: TranscriptPart[] = [];
      const synthetic: TranscriptPart[] = [];
      for (const p of parts) {
        if (p.type === 'text') (p.synthetic === true ? synthetic : typed).push(part.text(asString(p.text) ?? ''));
        else if (p.type === 'file') typed.push(part.file(fileLabel(asString(p.filename), asString(p.mime))));
      }
      b.add('user', typed, ts);
      b.add('system', synthetic, ts);
      continue;
    }
    for (const p of parts) {
      switch (p.type) {
        case 'text':
          b.add('assistant', [part.text(asString(p.text) ?? '')], ts);
          break;
        case 'reasoning':
          b.add('assistant', [part.reasoning(asString(p.text) ?? '')], ts);
          break;
        case 'tool': {
          const tool = asString(p.tool) ?? 'tool';
          const state = asObject(p.state);
          b.add('assistant', [part.call(tool, compactArgs(state?.input))], ts);
          b.add('tool', [part.result(tool, toolResultText(state))], ts);
          break;
        }
        case 'file':
          b.add('assistant', [part.file(fileLabel(asString(p.filename), asString(p.mime)))], ts);
          break;
        case 'patch': {
          const files = asArray(p.files).filter((f): f is string => typeof f === 'string');
          if (files.length) b.add('assistant', [part.other(`[patch] ${files.join(', ')}`)], ts);
          break;
        }
        default:
          break;
      }
    }
    const err = errorText(data.error);
    if (err) b.add('assistant', [part.other(err)], ts);
  }
  return b.messages();
}

function readV2(db: DatabaseSync, t: Set<string>, id: string, rows: Row[]): TranscriptMessage[] {
  let partsByMsg: Map<string, Record<string, unknown>[]> | undefined;
  const sideParts = (msgId: string): Record<string, unknown>[] => {
    if (!partsByMsg) {
      partsByMsg = new Map();
      if (t.has('session_part')) {
        for (const r of db.prepare('SELECT message_id, ordinal, type, call_id, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal').all(id) as Row[]) {
          const d = json(r.data);
          if (d.type === undefined && typeof r.type === 'string') d.type = r.type;
          if (d.id === undefined && typeof r.call_id === 'string') d.id = r.call_id;
          const key = String(r.message_id);
          let list = partsByMsg.get(key);
          if (!list) partsByMsg.set(key, (list = []));
          list.push(d);
        }
      }
    }
    return partsByMsg.get(msgId) ?? [];
  };
  const b = new MessageBuilder('opencode', id);
  for (const r of rows) {
    const data = json(r.data);
    const ts = toIso(num(r.time_created) ?? num(asObject(data.time)?.created as SQLInputValue));
    switch (r.type) {
      case 'user': {
        const parts: TranscriptPart[] = [part.text(asString(data.text) ?? '')];
        for (const f of asArray(data.files)) {
          const o = asObject(f);
          if (o) parts.push(part.file(fileLabel(asString(o.name), asString(o.mime))));
        }
        b.add('user', parts, ts);
        break;
      }
      case 'assistant': {
        const content = Array.isArray(data.content) ? data.content : sideParts(String(r.id));
        for (const c of content) {
          const o = asObject(c);
          if (!o) continue;
          if (o.type === 'text') b.add('assistant', [part.text(asString(o.text) ?? '')], ts);
          else if (o.type === 'reasoning') b.add('assistant', [part.reasoning(asString(o.text) ?? '')], ts);
          else if (o.type === 'tool') {
            const tool = asString(o.name) ?? asString(o.tool) ?? 'tool';
            const state = asObject(o.state);
            b.add('assistant', [part.call(tool, compactArgs(state?.input))], ts);
            b.add('tool', [part.result(tool, toolResultText(state))], ts);
          } else if (o.type === 'file') {
            b.add('assistant', [part.file(fileLabel(asString(o.name), asString(o.mime)))], ts);
          }
        }
        const err = errorText(data.error);
        if (err) b.add('assistant', [part.other(err)], ts);
        break;
      }
      case 'system':
        b.add('system', [part.text(asString(data.text) ?? '')], ts);
        break;
      case 'synthetic': {
        const source = asString(asObject(data.metadata)?.source);
        const text = asString(data.text) ?? '';
        if (source === 'shell' || source === 'subagent') b.add('tool', [part.result(source, text)], ts);
        else b.add('system', [part.text(text)], ts);
        break;
      }
      case 'compaction': {
        // Always emitted (placeholder while the summary is still being written) so later idx values never shift.
        b.add('system', [part.text(`[compaction summary]\n${asString(data.summary) || PENDING_RESULT}`)], ts);
        break;
      }
      default:
        break;
    }
  }
  return b.messages();
}

function fileLabel(name: string | undefined, mime: string | undefined): string {
  return `[file${name ? ` ${name}` : ''}${mime ? ` (${mime})` : ''}]`;
}
