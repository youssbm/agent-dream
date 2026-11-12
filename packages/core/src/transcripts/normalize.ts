/**
 * Shared normalization helpers for the transcript adapters.
 *
 * Normalized shape (all harnesses):
 *  - user turns → role 'user'; harness-injected context (system prompts, environment blocks, reminders) → 'system';
 *  - assistant text, reasoning and tool calls → one 'assistant' message per uninterrupted run;
 *  - tool results → role 'tool' messages (consecutive results are merged), placed after the call.
 * `idx` is assigned sequentially in file/database order, so it is stable for a given transcript.
 */
import type { Harness, Role, TranscriptMessage, TranscriptPart } from '../types.ts';

/** Accumulates normalized messages and assigns `idx`. */
export class MessageBuilder {
  private readonly out: TranscriptMessage[] = [];
  private readonly harness: Harness;
  private readonly session: string;
  constructor(harness: Harness, session: string) {
    this.harness = harness;
    this.session = session;
  }

  /**
   * Append parts under `role`. Consecutive assistant (or tool) parts merge into the previous message so a
   * single model turn stays one message; user/system messages never merge. Empty part lists are ignored.
   */
  add(role: Role, parts: TranscriptPart[], ts?: string, opts?: { merge?: boolean }): void {
    const kept = parts.filter((p) => p.text !== '' || p.kind === 'tool_call');
    if (kept.length === 0) return;
    const last = this.out[this.out.length - 1];
    const mergeable = role === 'assistant' || role === 'tool';
    if (last && mergeable && last.role === role && opts?.merge !== false) {
      last.parts.push(...kept);
      if (!last.ts && ts) last.ts = ts;
      return;
    }
    const msg: TranscriptMessage = { harness: this.harness, session: this.session, idx: this.out.length, role, parts: kept };
    if (ts) msg.ts = ts;
    this.out.push(msg);
  }

  /** The messages built so far. */
  messages(): TranscriptMessage[] {
    return this.out;
  }
}

/** Narrow unknown → plain object. */
export function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Narrow unknown → string. */
export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Narrow unknown → array. */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Compact one-line-ish rendering of tool arguments. A JSON-encoded string is decoded first. Objects whose
 * only meaningful field is a shell command render as the command itself; everything else as compact JSON.
 */
export function compactArgs(input: unknown): string {
  let v = input;
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        v = JSON.parse(t);
      } catch {
        return v as string;
      }
    } else {
      return v as string;
    }
  }
  if (v === undefined || v === null) return '';
  const obj = asObject(v);
  if (obj) {
    const keys = Object.keys(obj);
    for (const k of ['command', 'cmd']) {
      const c = obj[k];
      const others = keys.filter((x) => x !== k && !['description', 'timeout', 'timeout_ms', 'workdir', 'cwd', 'justification', 'sandbox_permissions', 'yield_time_ms', 'max_output_tokens'].includes(x));
      if (others.length === 0) {
        if (typeof c === 'string') return c;
        if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return shellJoin(c as string[]);
      }
    }
  }
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/** Join argv for display; `["bash","-lc","npm test"]` → `npm test`. */
export function shellJoin(argv: string[]): string {
  if (argv.length === 3 && /^(?:ba|z|)sh$|^bash\.exe$|^pwsh(?:\.exe)?$|^powershell(?:\.exe)?$/i.test(argv[0]!.split(/[\\/]/).pop() ?? '') && /^-l?c$|^-Command$/i.test(argv[1]!)) {
    return argv[2]!;
  }
  return argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/**
 * Text of a tool result payload: a string, or an array of content items (`{type:'text'|'input_text'|
 * 'output_text', text}`, images, tool references…).
 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        out.push(item);
        continue;
      }
      const o = asObject(item);
      if (!o) continue;
      const text = asString(o.text);
      if (text !== undefined) out.push(text);
      else if (o.type === 'image' || o.type === 'input_image') out.push('[image]');
      else if (o.type === 'tool_reference') out.push(`[tool_reference ${asString(o.tool_name) ?? ''}]`.replace(' ]', ']'));
      else if (o.type === 'file') out.push(`[file ${asString(o.name) ?? asString(o.mime) ?? ''}]`.replace(' ]', ']'));
      else if (o.type === 'document') out.push('[document]');
    }
    return out.join('\n');
  }
  const o = asObject(content);
  if (o) {
    const text = asString(o.text) ?? asString(o.output);
    if (text !== undefined) return text;
    try {
      return JSON.stringify(o);
    } catch {
      return '';
    }
  }
  return content === undefined || content === null ? '' : String(content);
}

/** Tags of harness-injected context blocks that should be treated as role 'system', not as user words. */
const INJECTED_TAGS = new Set([
  'environment_context',
  'user_instructions',
  'developer_instructions',
  'system-reminder',
  'system_reminder',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'user-prompt-submit-hook',
  'codex_internal_context',
  'turn_aborted',
  'heartbeat',
  'permissions',
  'collaboration_mode',
  'skill',
  'skills_instructions',
  'realtime_delegation',
  'instructions',
]);

/**
 * Whether a user-role text is harness-injected context rather than something the user typed: a known
 * injected tag at the start, a single `<tag>…</tag>` block wrapping the whole text (other than images),
 * an AGENTS.md / instructions preamble, or Claude Code's local-command caveat.
 */
export function isInjectedText(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (/^#\s*AGENTS\.md instructions/i.test(t)) return true;
  if (/^Caveat: The messages below were generated by the user while running local commands/i.test(t)) return true;
  const open = /^<([A-Za-z_][\w-]*)\b[^>]*>/.exec(t);
  if (!open) return false;
  const tag = open[1]!;
  if (INJECTED_TAGS.has(tag.toLowerCase())) return true;
  if (/^image$/i.test(tag) || /^command-(name|message|args)$/i.test(tag)) return false;
  return t.endsWith(`</${tag}>`) && !t.slice(open[0].length, -(tag.length + 3)).includes(`<${tag}`);
}

/** Convenience constructors. */
export const part = {
  text: (text: string): TranscriptPart => ({ kind: 'text', text }),
  reasoning: (text: string): TranscriptPart => ({ kind: 'reasoning', text }),
  call: (tool: string, text: string): TranscriptPart => ({ kind: 'tool_call', tool, text }),
  result: (tool: string | undefined, text: string): TranscriptPart => (tool ? { kind: 'tool_result', tool, text } : { kind: 'tool_result', text }),
  file: (text: string): TranscriptPart => ({ kind: 'file', text }),
  other: (text: string): TranscriptPart => ({ kind: 'other', text }),
};
