/**
 * Cost filter applied to normalized transcripts before they are chunked for the model (PLAN §4.1):
 * drop reasoning, shorten bulky tool output, stub file reads (the file is still on disk), collapse
 * retries, stub huge injected system context, drop empty messages, and collapse agent-dream's own runs
 * (so a dream never re-reads its own traffic as project knowledge). `idx` values are preserved, so
 * citations into the filtered view stay valid against the unfiltered transcript.
 */
import type { TranscriptMessage, TranscriptPart } from '../types.ts';
import { DREAM_PROMPT_FIRST_LINE, DREAM_TOOL_NAMES, RESUME_PROMPT_FIRST_LINE } from '../types.ts';

/** Stub text that replaces a span of dream traffic. */
export const DREAM_RUN_STUB = '[agent-dream dream run omitted]';

/** A dream protocol tool, bare or namespaced (`mcp__agent-dream__dream_step`, `agent-dream.dream_begin`, …). */
const DREAM_TOOL_RE = new RegExp(`(?:^|[._:-])(?:${DREAM_TOOL_NAMES.join('|')})$`);
/**
 * Code-execution tools (opencode Code Mode runs every tool through `execute`); only their arguments are
 * searched for dream calls, so e.g. a grep or file edit mentioning `dream_begin(` is not mistaken for one.
 */
const CODE_TOOL_RE = /(?:^|[._:-])(?:execute|exec|run_code|code|eval)$/i;
/** A dream protocol call inside code: `dream_step(` or `tools["agent-dream"].dream_…`. */
const DREAM_CALL_TEXT = new RegExp(`\\b(?:${DREAM_TOOL_NAMES.join('|')})\\s*\\(|tools\\s*\\[\\s*["'\`]agent-dream["'\`]\\s*\\]\\s*\\.\\s*dream_`);

/** Whether a message's text starts with the `dream` / `resume` MCP prompt. */
function isDreamPrompt(m: TranscriptMessage): boolean {
  if (m.role !== 'user' && m.role !== 'system') return false;
  return m.parts.some((p) => {
    const t = p.text.trimStart();
    return t.startsWith(DREAM_PROMPT_FIRST_LINE) || t.startsWith(RESUME_PROMPT_FIRST_LINE);
  });
}

/** Whether a part is a call of a dream protocol tool (directly, or through a code-execution tool). */
export function isDreamCall(p: TranscriptPart): boolean {
  if (p.kind !== 'tool_call') return false;
  const tool = p.tool ?? '';
  if (DREAM_TOOL_RE.test(tool)) return true;
  return CODE_TOOL_RE.test(tool) && DREAM_CALL_TEXT.test(p.text);
}

/**
 * Whether one message is itself dream traffic: the `dream` / `resume` prompt, an assistant message
 * calling a dream protocol tool, or the result of a dream protocol tool (when the tool name says so).
 */
export function isDreamTraffic(m: TranscriptMessage): boolean {
  if (isDreamPrompt(m)) return true;
  if (m.role === 'assistant') return m.parts.some(isDreamCall);
  if (m.role === 'tool') return m.parts.length > 0 && m.parts.every((p) => p.kind === 'tool_result' && DREAM_TOOL_RE.test(p.tool ?? ''));
  return false;
}

/**
 * Spans of dream traffic, as `start idx → member idx set`. A span starts at a dream/resume prompt, or at an
 * assistant message calling a dream tool — then also including the preceding genuine user message when the
 * dream call is the first tool call of the turn answering it (e.g. "run a dream") — and continues through
 * assistant/tool/system messages until the next genuine user message.
 */
function dreamSpans(msgs: TranscriptMessage[]): { starts: Set<number>; members: Set<number> } {
  const starts = new Set<number>();
  const members = new Set<number>();
  let inSpan = false;
  /** Position of the last genuine user message, and whether its turn has made a tool call yet. */
  let lastUser = -1;
  let turnHadCall = false;
  msgs.forEach((m, i) => {
    if (isDreamPrompt(m)) {
      if (!inSpan) starts.add(i);
      inSpan = true;
      members.add(i);
      lastUser = -1;
      return;
    }
    if (m.role === 'user') {
      inSpan = false;
      lastUser = i;
      turnHadCall = false;
      return;
    }
    if (!inSpan && m.role === 'assistant') {
      const calls = m.parts.filter((p) => p.kind === 'tool_call');
      const dreamAt = calls.findIndex(isDreamCall);
      if (dreamAt >= 0) {
        inSpan = true;
        if (lastUser >= 0 && !turnHadCall && dreamAt === 0 && !members.has(lastUser)) {
          // Only system messages may sit between the user message and this one.
          for (let j = lastUser; j < i; j++) members.add(j);
          starts.add(lastUser);
        } else {
          starts.add(i);
        }
      }
      if (calls.length > 0) turnHadCall = true;
    }
    if (inSpan) members.add(i);
  });
  return { starts, members };
}

/** Tunables for {@link filterMessages}. */
export interface FilterOptions {
  /** Tool results longer than this keep only a head and a tail. Default 1500. */
  maxToolResultChars?: number;
  /** Tool-call arguments longer than this keep only a head and a tail. Default 1000. */
  maxToolCallChars?: number;
  /** File-read results longer than this are replaced by a stub. Default 400. */
  fileReadStubMinChars?: number;
  /** System messages longer than this (in total) are replaced by a stub. Default 2000. */
  maxSystemChars?: number;
  /** Keep reasoning parts. Default false. */
  keepReasoning?: boolean;
  /** Collapse consecutive identical tool calls (keeping the last). Default true. */
  collapseRepeats?: boolean;
  /**
   * Keep agent-dream's own traffic (dream/resume prompts, dream tool calls and results). Default false: each
   * span is collapsed into one {@link DREAM_RUN_STUB} message (first idx kept, rest dropped).
   */
  keepDreamTraffic?: boolean;
}

/** Stub that replaces the output of a file read. */
export const FILE_READ_STUB = '[file contents omitted: still on disk]';

/** Tool names whose results are file contents. Compared case-insensitively. */
const FILE_READ_TOOLS = new Set(['read', 'read_file', 'readfile', 'view', 'open_file', 'cat', 'file_read', 'fs_read', 'read_text_file', 'read_many_files', 'notebookread']);
/** Shell commands that only print a file. */
const READ_COMMAND = /^\s*(?:cat|head|tail|less|more|bat|nl|type|Get-Content|gc|sed\s+-n)\b(?![^|;&]*[|;&]\s*\S)/i;

/** Keep the first and last characters of `text`, noting how much was cut. */
export function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = Math.max(0, max - head);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${omitted} chars omitted]\n${tail > 0 ? text.slice(text.length - tail) : ''}`.trimEnd();
}

function isFileRead(tool: string | undefined, lastArgs: string | undefined): boolean {
  if (tool && FILE_READ_TOOLS.has(tool.toLowerCase())) return true;
  if (tool && /(?:^|[._])(read_file|read|view_file|open_file)$/i.test(tool)) return true;
  return !!lastArgs && READ_COMMAND.test(lastArgs);
}

/**
 * Filter a normalized transcript for model consumption. Returns a new array (input is not mutated);
 * messages keep their `idx`; messages left empty are dropped.
 */
export function filterMessages(msgs: TranscriptMessage[], opts: FilterOptions = {}): TranscriptMessage[] {
  const maxResult = opts.maxToolResultChars ?? 1500;
  const maxCall = opts.maxToolCallChars ?? 1000;
  const stubMin = opts.fileReadStubMinChars ?? 400;
  const maxSystem = opts.maxSystemChars ?? 2000;
  const keepReasoning = opts.keepReasoning ?? false;
  const lastArgs = new Map<string, string>();

  let input = msgs;
  if (!opts.keepDreamTraffic) {
    const { starts, members } = dreamSpans(msgs);
    if (members.size > 0) {
      input = [];
      msgs.forEach((m, i) => {
        if (starts.has(i)) input.push({ ...m, parts: [{ kind: 'other', text: DREAM_RUN_STUB }] });
        else if (!members.has(i)) input.push(m);
      });
    }
  }

  const out: TranscriptMessage[] = input.map((m) => {
    if (m.role === 'system') {
      const total = m.parts.reduce((n, p) => n + p.text.length, 0);
      if (total > maxSystem) {
        return { ...m, parts: [{ kind: 'other', text: `[system context omitted: ${total} chars]`, truncated: true, originalChars: total }] };
      }
    }
    const parts: TranscriptPart[] = [];
    for (const p of m.parts) {
      if (p.kind === 'reasoning' && !keepReasoning) continue;
      const q: TranscriptPart = { ...p };
      if (p.kind === 'tool_call') {
        lastArgs.set(p.tool ?? '', p.text);
        if (p.text.length > maxCall) Object.assign(q, { text: headTail(p.text, maxCall), truncated: true, originalChars: p.originalChars ?? p.text.length });
      } else if (p.kind === 'tool_result') {
        const isError = /^\s*\[error\]/i.test(p.text);
        if (!isError && p.text.length > stubMin && isFileRead(p.tool, lastArgs.get(p.tool ?? ''))) {
          Object.assign(q, { text: FILE_READ_STUB, truncated: true, originalChars: p.originalChars ?? p.text.length });
        } else if (p.text.length > maxResult) {
          Object.assign(q, { text: headTail(p.text, maxResult), truncated: true, originalChars: p.originalChars ?? p.text.length });
        }
      }
      parts.push(q);
    }
    return { ...m, parts };
  });

  if (opts.collapseRepeats ?? true) collapseRepeats(out);
  return out.filter((m) => m.parts.some((p) => p.kind === 'tool_call' || p.text.trim() !== ''));
}

/**
 * Collapse runs of identical tool calls (same tool + same args, separated only by their own results):
 * earlier calls and their results are removed, the last call is annotated `(repeated ×N)`. Mutates
 * the (already copied) messages in place.
 */
function collapseRepeats(msgs: TranscriptMessage[]): void {
  type Ref = { mi: number; pi: number };
  const drop = new Set<string>();
  const annotate = new Map<string, number>();
  let prev: { call: Ref; tool?: string; text: string; results: Ref[]; count: number } | null = null;
  const key = (r: Ref): string => `${r.mi}:${r.pi}`;
  const finish = (): void => {
    if (prev && prev.count > 1) annotate.set(key(prev.call), prev.count);
    prev = null;
  };
  msgs.forEach((m, mi) => {
    if (m.role === 'user' || m.role === 'system') {
      finish();
      return;
    }
    m.parts.forEach((p, pi) => {
      if (p.kind === 'reasoning') return;
      if (p.kind === 'tool_call') {
        if (prev && prev.tool === p.tool && prev.text === p.text) {
          drop.add(key(prev.call));
          for (const r of prev.results) drop.add(key(r));
          prev = { call: { mi, pi }, tool: p.tool, text: p.text, results: [], count: prev.count + 1 };
        } else {
          finish();
          prev = { call: { mi, pi }, tool: p.tool, text: p.text, results: [], count: 1 };
        }
        return;
      }
      if (p.kind === 'tool_result' && prev && (p.tool === undefined || p.tool === prev.tool)) {
        prev.results.push({ mi, pi });
        return;
      }
      finish();
    });
  });
  finish();
  if (drop.size === 0 && annotate.size === 0) return;
  msgs.forEach((m, mi) => {
    const parts: TranscriptPart[] = [];
    m.parts.forEach((p, pi) => {
      const k = `${mi}:${pi}`;
      if (drop.has(k)) return;
      const n = annotate.get(k);
      parts.push(n ? { ...p, text: `${p.text} (repeated ×${n})` } : p);
    });
    m.parts = parts;
  });
}
