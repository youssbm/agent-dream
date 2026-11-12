/**
 * Codex transcripts ("rollouts"): `~/.codex/sessions/YYYY/MM/DD/rollout-<local-time>-<uuid>.jsonl`, plus
 * `~/.codex/archived_sessions/`. Older rollouts may be zstd-compressed (`.jsonl.zst`); they are read when
 * this Node.js build supports zstd (≥ 22.15 / 23.8) and skipped otherwise. `$CODEX_HOME` replaces `~/.codex`.
 *
 * Each line is `{timestamp, type, payload}`. The first is `session_meta` (`payload.id`, `cwd`, `timestamp`,
 * `source`; subagent threads carry `source.subagent`, `thread_source: 'subagent'`, `parent_thread_id`).
 * Conversation lives in `response_item` records whose `payload.type` is:
 *  - `message` (`role` user/assistant/developer/system, `content[]` of `input_text`/`output_text`/`input_image`);
 *  - `function_call` (`name`, optional `namespace`, `arguments` JSON string, `call_id`) / `function_call_output`
 *    (`call_id`, `output` string or content items);
 *  - `custom_tool_call` (`name`, `input` string) / `custom_tool_call_output`; `local_shell_call` (`action.command[]`);
 *  - `web_search_call`; `agent_message` (inter-agent text); `reasoning` (encrypted; only a plain summary is kept).
 * Everything else (`event_msg`, `turn_context`, `world_state`, `token_usage_record`, `compacted`, …) is skipped.
 * `~/.codex/session_index.jsonl` (`{id, thread_name, updated_at}`) supplies titles.
 * The legacy format (no `payload` wrapper; first line `{id, timestamp, instructions}`) is also understood.
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { ListSessionsOptions, SessionInfo, TranscriptAdapter, TranscriptMessage, TranscriptPart } from '../types.ts';
import { DreamError } from '../types.ts';
import { samePath } from './paths.ts';
import { isSafeId, isZstd, mapPool, omittedNotice, parseJsonObject, readHeadRecords, readLines, sinceMs, statOrNull, toIso, zstdSupported } from './lines.ts';
import { MessageBuilder, asArray, asObject, asString, compactArgs, contentText, isInjectedText, part, shellJoin } from './normalize.ts';
import type { AdapterOptions } from './claude-code.ts';

/** Codex specific options. */
export interface CodexAdapterOptions extends AdapterOptions {
  /** List subagent threads too (default false: they are part of their parent's work). */
  includeSubagents?: boolean;
}

interface RolloutFile {
  id: string;
  file: string;
  mtimeMs: number;
}

interface RolloutMeta {
  id?: string;
  cwd?: string;
  startedAt?: string;
  subagent: boolean;
}

const ROLLOUT = /^rollout-.*\.jsonl(?:\.zst)?$/;
const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const ITEM_TYPES = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call', 'reasoning', 'agent_message']);

/**
 * Rollout heads never change once written, so parsed metadata is cached per file path for the life of the
 * process (keeps repeated `listSessions` calls cheap on stores with thousands of rollouts).
 */
const headCache = new Map<string, RolloutMeta>();

/**
 * Reads Codex rollout transcripts (read-only).
 *
 * `SessionInfo.messageCount` is left undefined (counting normalized messages would need a full read).
 * idx stability: rollouts are append-only and each record is normalized on its own, so appending records
 * only extends the last message or adds new ones.
 */
export class CodexAdapter implements TranscriptAdapter {
  readonly harness = 'codex' as const;
  /** Directories scanned for rollouts. */
  readonly roots: string[];
  private readonly codexHome?: string;
  private readonly includeSubagents: boolean;
  private readonly fileById = new Map<string, string>();

  constructor(opts: CodexAdapterOptions = {}) {
    if (opts.root) {
      this.roots = [opts.root];
    } else {
      const home = !opts.homeDir && process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(opts.homeDir ?? os.homedir(), '.codex');
      this.codexHome = home;
      this.roots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
    }
    this.includeSubagents = opts.includeSubagents ?? false;
  }

  async available(): Promise<boolean> {
    for (const r of this.roots) if ((await statOrNull(r))?.isDirectory()) return true;
    return false;
  }

  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionInfo[]> {
    const since = sinceMs(opts.since);
    const files = (await this.rolloutFiles()).filter((f) => since === undefined || f.mtimeMs >= since).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
    const titles = await this.titles();
    const out: SessionInfo[] = [];
    const BATCH = 32;
    for (let i = 0; i < files.length && out.length < limit; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const metas = await mapPool(batch, 16, (f) => readMeta(f.file).catch(() => null));
      batch.forEach((f, j) => {
        const meta = metas[j];
        if (!meta || out.length >= limit) return;
        if (meta.subagent && !this.includeSubagents) return;
        if (opts.cwd && !samePath(meta.cwd, opts.cwd)) return;
        const id = meta.id ?? f.id;
        const info: SessionInfo = { harness: this.harness, id, updatedAt: new Date(f.mtimeMs).toISOString(), location: f.file };
        if (meta.cwd) info.cwd = meta.cwd;
        if (meta.startedAt) info.startedAt = meta.startedAt;
        const title = titles.get(id);
        if (title) info.title = title;
        out.push(info);
      });
    }
    return out;
  }

  async readSession(id: string): Promise<TranscriptMessage[]> {
    const file = await this.findFile(id);
    if (!file) throw new DreamError('SESSION_NOT_FOUND', `Codex session not found: ${id}`);
    if (isZstd(file) && !zstdSupported()) {
      throw new DreamError('UNSUPPORTED_FORMAT', `Codex session ${id} is zstd-compressed and this Node.js version cannot decompress it (needs ≥ 22.15).`);
    }
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
      let item: Record<string, unknown> | undefined;
      if (rec.type === 'response_item') item = asObject(rec.payload);
      else if (rec.payload === undefined && typeof rec.type === 'string' && ITEM_TYPES.has(rec.type)) item = rec; // legacy
      if (!item) continue;
      addItem(b, item, toolNames, toIso(rec.timestamp));
    }
    return b.messages();
  }

  /** All rollout files under the roots (deduplicated by id; the newest file wins). */
  private async rolloutFiles(): Promise<RolloutFile[]> {
    const found: RolloutFile[] = [];
    const zstdOk = zstdSupported();
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const subdirs: string[] = [];
      const names: string[] = [];
      for (const e of entries) {
        if (e.isDirectory() && depth < 4) subdirs.push(path.join(dir, e.name));
        else if (e.isFile() && ROLLOUT.test(e.name) && (zstdOk || !isZstd(e.name))) names.push(e.name);
      }
      await mapPool(names, 32, async (name) => {
        const file = path.join(dir, name);
        const st = await statOrNull(file);
        if (!st) return;
        const id = UUID_AT_END.exec(name)?.[1] ?? name.replace(/\.jsonl(?:\.zst)?$/, '');
        found.push({ id, file, mtimeMs: st.mtimeMs });
      });
      await Promise.all(subdirs.map((d) => walk(d, depth + 1)));
    };
    await Promise.all(this.roots.map((r) => walk(r, 0)));
    const byId = new Map<string, RolloutFile>();
    for (const f of found) {
      const prev = byId.get(f.id);
      if (!prev || f.mtimeMs > prev.mtimeMs || (f.mtimeMs === prev.mtimeMs && !isZstd(f.file))) byId.set(f.id, f);
    }
    this.fileById.clear();
    for (const f of byId.values()) this.fileById.set(f.id, f.file);
    return [...byId.values()];
  }

  private async findFile(id: string): Promise<string | null> {
    if (!isSafeId(id)) return null;
    const cached = this.fileById.get(id);
    if (cached && (await statOrNull(cached))) return cached;
    await this.rolloutFiles();
    const direct = this.fileById.get(id);
    if (direct) return direct;
    // Legacy rollouts without a uuid in the name: match on the session_meta id.
    for (const file of this.fileById.values()) {
      if (UUID_AT_END.test(file)) continue;
      const meta = await readMeta(file).catch(() => null);
      if (meta?.id === id) return file;
    }
    return null;
  }

  /** id → thread name from `session_index.jsonl` (later lines win). */
  private async titles(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.codexHome) return map;
    const file = path.join(this.codexHome, 'session_index.jsonl');
    if (!(await statOrNull(file))) return map;
    try {
      for await (const line of readLines(file)) {
        const r = parseJsonObject(line);
        const id = asString(r?.id);
        const name = asString(r?.thread_name);
        if (id && name) map.set(id, name);
      }
    } catch {
      /* titles are optional */
    }
    return map;
  }
}

/** Parse the session_meta at the head of a rollout (cached). */
async function readMeta(file: string): Promise<RolloutMeta | null> {
  const hit = headCache.get(file);
  if (hit) return hit;
  // The header is always the first line (it can be tens of KB because it embeds the base instructions).
  const { records } = await readHeadRecords(file, 1);
  let meta: RolloutMeta | null = null;
  for (const r of records) {
    if (r.type === 'session_meta') {
      const p = asObject(r.payload) ?? {};
      const source = p.source;
      const subagent =
        p.thread_source === 'subagent' || !!asString(p.parent_thread_id) || (!!asObject(source) && 'subagent' in (source as object)) || source === 'subagent';
      meta = { subagent };
      const id = asString(p.id);
      if (id) meta.id = id;
      const cwd = asString(p.cwd);
      if (cwd) meta.cwd = cwd;
      const started = toIso(p.timestamp) ?? toIso(r.timestamp);
      if (started) meta.startedAt = started;
      break;
    }
    if (r.type === undefined && asString(r.id) && r.timestamp !== undefined) {
      // Legacy header: {id, timestamp, instructions, git?} — no cwd recorded.
      meta = { id: asString(r.id), subagent: false };
      const started = toIso(r.timestamp);
      if (started) meta.startedAt = started;
      break;
    }
  }
  if (meta) {
    if (headCache.size > 20000) headCache.clear();
    headCache.set(file, meta);
  }
  return meta;
}

/** Text items of a message's content list, each classified as injected or not. */
function messageTexts(content: unknown): { text: string; image: boolean }[] {
  const out: { text: string; image: boolean }[] = [];
  if (typeof content === 'string') return [{ text: content, image: false }];
  for (const c of asArray(content)) {
    const o = asObject(c);
    if (!o) continue;
    if (o.type === 'input_image' || o.type === 'image') out.push({ text: '[image]', image: true });
    else if (typeof o.text === 'string') out.push({ text: o.text, image: false });
  }
  return out;
}

/** Tool output payload → text (string, `{output, metadata.exit_code}` JSON string, or content items). */
function outputText(output: unknown): string {
  if (typeof output === 'string') {
    const t = output.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      const o = parseJsonObject(t);
      const inner = asString(o?.output);
      if (o && inner !== undefined) {
        const code = asObject(o.metadata)?.exit_code;
        return typeof code === 'number' && code !== 0 ? `${inner}\n[exit code ${code}]` : inner;
      }
    }
    return output;
  }
  const o = asObject(output);
  if (o && typeof o.content === 'string') return o.content;
  return contentText(output);
}

function addItem(b: MessageBuilder, p: Record<string, unknown>, toolNames: Map<string, string>, ts?: string): void {
  switch (p.type) {
    case 'message': {
      const role = asString(p.role);
      const texts = messageTexts(p.content);
      if (role === 'assistant') {
        b.add('assistant', texts.map((t) => (t.image ? part.file(t.text) : part.text(t.text))), ts);
      } else if (role === 'user') {
        const injected = texts.filter((t) => !t.image && isInjectedText(t.text));
        const typed = texts.filter((t) => t.image || !isInjectedText(t.text));
        b.add('system', injected.map((t) => part.text(t.text)), ts);
        b.add('user', typed.map((t) => (t.image ? part.file(t.text) : part.text(t.text))), ts);
      } else {
        // developer / system: harness instructions.
        b.add('system', texts.map((t) => part.text(t.text)), ts);
      }
      return;
    }
    case 'reasoning': {
      const parts: TranscriptPart[] = [];
      for (const s of [...asArray(p.summary), ...asArray(p.content)]) {
        const text = asString(asObject(s)?.text);
        if (text) parts.push(part.reasoning(text));
      }
      b.add('assistant', parts, ts);
      return;
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = asString(p.name) ?? 'tool';
      const ns = asString(p.namespace);
      const tool = ns ? `${ns}.${name}` : name;
      const callId = asString(p.call_id);
      if (callId) toolNames.set(callId, tool);
      b.add('assistant', [part.call(tool, compactArgs(p.type === 'function_call' ? p.arguments : p.input))], ts);
      return;
    }
    case 'local_shell_call': {
      const action = asObject(p.action);
      const cmd = asArray(action?.command).filter((x): x is string => typeof x === 'string');
      const callId = asString(p.call_id);
      if (callId) toolNames.set(callId, 'local_shell');
      b.add('assistant', [part.call('local_shell', cmd.length ? shellJoin(cmd) : compactArgs(action))], ts);
      return;
    }
    case 'web_search_call': {
      const action = asObject(p.action);
      b.add('assistant', [part.call('web_search', asString(action?.query) ?? compactArgs(action))], ts);
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = asString(p.call_id);
      const tool = (callId && toolNames.get(callId)) || asString(p.name);
      b.add('tool', [part.result(tool, outputText(p.output))], ts);
      return;
    }
    case 'agent_message': {
      const texts = asArray(p.content)
        .map((c) => asString(asObject(c)?.text))
        .filter((t): t is string => !!t);
      const author = asString(p.author);
      b.add('tool', texts.map((t) => part.result(author ? `agent:${author}` : 'agent', t)), ts);
      return;
    }
    default:
      return;
  }
}

/** Test hook: forget cached rollout heads. */
export function clearCodexHeadCache(): void {
  headCache.clear();
}
