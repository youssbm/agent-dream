/**
 * Claude Code transcripts: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`).
 *
 * Each line is a record with a `type`. Only `user` / `assistant` records carry conversation; everything else
 * (`system`, `attachment`, `summary`, `custom-title`, `queue-operation`, `file-history-*`, `api-request*`, …)
 * is skipped, except that `custom-title` / `summary` records provide the session title.
 * `message.content` is a string or a list of blocks: `text`, `thinking` / `redacted_thinking`, `tool_use`
 * (`id`, `name`, `input`), `tool_result` (`tool_use_id`, `content` string or blocks, `is_error`), `image`.
 * Records with `isSidechain: true` belong to subagents and are excluded by default (newer versions store
 * subagents in `<sessionId>/subagents/agent-*.jsonl`, which are never listed as sessions).
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { ListSessionsOptions, SessionInfo, TranscriptAdapter, TranscriptMessage, TranscriptPart } from '../types.ts';
import { DreamError } from '../types.ts';
import { samePath } from './paths.ts';
import { isSafeId, omittedNotice, parseJsonObject, readHeadRecords, readLines, readTailRecords, sinceMs, statOrNull, toIso } from './lines.ts';
import { MessageBuilder, asArray, asObject, asString, compactArgs, contentText, isInjectedText, part } from './normalize.ts';

/** Options shared by the built-in adapters. */
export interface AdapterOptions {
  /** Home directory to look in (default `os.homedir()`; tests point this at fixtures). */
  homeDir?: string;
  /** Explicit store root, overriding the default location derived from homeDir. */
  root?: string;
  /** opencode only: explicit database path. */
  dbPath?: string;
}

/** Claude Code specific options. */
export interface ClaudeCodeAdapterOptions extends AdapterOptions {
  /** Keep `isSidechain` (subagent) records when reading a session. Default false. */
  includeSidechains?: boolean;
}

interface FileMeta {
  cwd?: string;
  startedAt?: string;
  title?: string;
  hasMessages: boolean;
}

const HEAD_LINES = 60;

/**
 * Reads Claude Code session transcripts (read-only).
 *
 * `SessionInfo.messageCount` is left undefined (counting normalized messages would need a full read).
 * idx stability: records are append-only and each record is normalized on its own (consecutive assistant
 * records — e.g. the content blocks of one API message sharing `message.id` — merge into the previous
 * assistant message), so appending records only extends the last message or adds new ones.
 */
export class ClaudeCodeAdapter implements TranscriptAdapter {
  readonly harness = 'claude-code' as const;
  /** The `projects` directory scanned for sessions. */
  readonly root: string;
  private readonly includeSidechains: boolean;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    const envDir = !opts.homeDir && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : undefined;
    this.root = opts.root ?? (envDir ? path.join(envDir, 'projects') : path.join(opts.homeDir ?? os.homedir(), '.claude', 'projects'));
    this.includeSidechains = opts.includeSidechains ?? false;
  }

  async available(): Promise<boolean> {
    const st = await statOrNull(this.root);
    return !!st?.isDirectory();
  }

  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionInfo[]> {
    const files = await this.sessionFiles();
    const since = sinceMs(opts.since);
    const candidates = files.filter((f) => since === undefined || f.mtimeMs >= since).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
    const out: SessionInfo[] = [];
    // Files are visited newest first, so with a limit we can stop reading heads early.
    const BATCH = 16;
    for (let i = 0; i < candidates.length && out.length < limit; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const metas = await Promise.all(batch.map((f) => this.fileMeta(f.file, f.size).catch(() => null)));
      batch.forEach((f, j) => {
        const meta = metas[j];
        if (!meta || !meta.hasMessages || out.length >= limit) return;
        if (opts.cwd && !samePath(meta.cwd, opts.cwd)) return;
        const info: SessionInfo = { harness: this.harness, id: f.id, updatedAt: new Date(f.mtimeMs).toISOString(), location: f.file };
        if (meta.cwd) info.cwd = meta.cwd;
        if (meta.title) info.title = meta.title;
        if (meta.startedAt) info.startedAt = meta.startedAt;
        out.push(info);
      });
    }
    return out;
  }

  async readSession(id: string): Promise<TranscriptMessage[]> {
    const file = await this.findFile(id);
    if (!file) throw new DreamError('SESSION_NOT_FOUND', `Claude Code session not found: ${id}`);
    const b = new MessageBuilder(this.harness, id);
    const toolNames = new Map<string, string>();
    for await (const line of readLines(file)) {
      const rec = parseJsonObject(line);
      if (!rec) continue;
      const omitted = omittedNotice(rec);
      if (omitted) {
        b.add('system', [part.other(omitted)]);
        continue;
      }
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      if (rec.isSidechain === true && !this.includeSidechains) continue;
      const msg = asObject(rec.message);
      if (!msg) continue;
      const ts = toIso(rec.timestamp);
      if (rec.type === 'assistant') {
        b.add('assistant', assistantParts(msg.content, toolNames), ts);
        continue;
      }
      this.addUser(b, rec, msg.content, toolNames, ts);
    }
    return b.messages();
  }

  private addUser(b: MessageBuilder, rec: Record<string, unknown>, content: unknown, toolNames: Map<string, string>, ts?: string): void {
    const forcedSystem = rec.isMeta === true || rec.isCompactSummary === true;
    if (typeof content === 'string') {
      b.add(forcedSystem || isInjectedText(content) ? 'system' : 'user', [part.text(content)], ts);
      return;
    }
    const tool: TranscriptPart[] = [];
    const user: TranscriptPart[] = [];
    const system: TranscriptPart[] = [];
    for (const blk of asArray(content)) {
      const o = asObject(blk);
      if (!o) continue;
      if (o.type === 'tool_result') {
        const name = toolNames.get(asString(o.tool_use_id) ?? '');
        const text = contentText(o.content);
        tool.push(part.result(name, o.is_error === true && !/^\s*(error|\[error\])/i.test(text) ? `[error] ${text}` : text));
      } else if (o.type === 'text') {
        const text = asString(o.text) ?? '';
        (forcedSystem || isInjectedText(text) ? system : user).push(part.text(text));
      } else if (o.type === 'image') {
        user.push(part.file('[image]'));
      } else if (o.type === 'document') {
        user.push(part.file('[document]'));
      }
    }
    b.add('tool', tool, ts);
    b.add('system', system, ts);
    b.add('user', user, ts);
  }

  /** Top-level `<project>/<id>.jsonl` files with their stat info. */
  private async sessionFiles(): Promise<{ id: string; file: string; mtimeMs: number; size: number }[]> {
    let dirs: string[];
    try {
      dirs = (await fsp.readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(this.root, d.name));
    } catch {
      return [];
    }
    const out: { id: string; file: string; mtimeMs: number; size: number }[] = [];
    await Promise.all(
      dirs.map(async (dir) => {
        let names: string[];
        try {
          names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
        } catch {
          return;
        }
        await Promise.all(
          names.map(async (name) => {
            const file = path.join(dir, name);
            const st = await statOrNull(file);
            if (st) out.push({ id: name.slice(0, -'.jsonl'.length), file, mtimeMs: st.mtimeMs, size: st.size });
          }),
        );
      }),
    );
    return out;
  }

  private async findFile(id: string): Promise<string | null> {
    if (!isSafeId(id)) return null;
    let dirs: string[];
    try {
      dirs = (await fsp.readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const file = path.join(this.root, d, `${id}.jsonl`);
      const st = await statOrNull(file);
      if (st?.isFile()) return file;
    }
    return null;
  }

  /** cwd/start time from the head of the file, title from custom-title/summary records (head + tail). */
  private async fileMeta(file: string, size: number): Promise<FileMeta> {
    const head = await readHeadRecords(file, HEAD_LINES);
    const meta: FileMeta = { hasMessages: false };
    let title: string | undefined;
    let summary: string | undefined;
    const scan = (recs: Record<string, unknown>[]): void => {
      for (const r of recs) {
        if (r.type === 'custom-title' && asString(r.customTitle)) title = asString(r.customTitle);
        if (r.type === 'summary' && asString(r.summary)) summary = asString(r.summary);
        const isMsg = (r.type === 'user' || r.type === 'assistant') && r.isSidechain !== true;
        if (isMsg) meta.hasMessages = true;
        if (!meta.cwd && asString(r.cwd)) meta.cwd = asString(r.cwd);
        if (!meta.startedAt && isMsg) meta.startedAt = toIso(r.timestamp);
      }
    };
    scan(head.records);
    if (!head.complete) {
      // Session titles are (re)appended over time, so the newest one sits near the end of the file.
      scan(await readTailRecords(file, size));
      // A file whose head is all bookkeeping can still have messages further down.
      if (!meta.hasMessages) meta.hasMessages = true;
    }
    meta.title = title ?? summary;
    if (!meta.title) {
      const ct = await fsp.readFile(path.join(path.dirname(file), path.basename(file, '.jsonl'), 'custom-title.json'), 'utf8').catch(() => null);
      const parsed = ct ? parseJsonObject(ct) : null;
      if (parsed && asString(parsed.customTitle)) meta.title = asString(parsed.customTitle);
    }
    return meta;
  }
}

function assistantParts(content: unknown, toolNames: Map<string, string>): TranscriptPart[] {
  if (typeof content === 'string') return [part.text(content)];
  const parts: TranscriptPart[] = [];
  for (const blk of asArray(content)) {
    const o = asObject(blk);
    if (!o) continue;
    switch (o.type) {
      case 'text':
        parts.push(part.text(asString(o.text) ?? ''));
        break;
      case 'thinking':
        parts.push(part.reasoning(asString(o.thinking) ?? ''));
        break;
      case 'redacted_thinking':
        parts.push(part.reasoning('[redacted thinking]'));
        break;
      case 'tool_use':
      case 'server_tool_use': {
        const name = asString(o.name) ?? 'tool';
        const id = asString(o.id);
        if (id) toolNames.set(id, name);
        parts.push(part.call(name, compactArgs(o.input)));
        break;
      }
      case 'web_search_tool_result':
        parts.push(part.result('web_search', contentText(o.content)));
        break;
      default:
        break;
    }
  }
  return parts;
}
