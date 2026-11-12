/**
 * Rendering and chunking of (filtered) transcripts into bounded, model-sized slices.
 *
 * Rendered format (see `Chunk.text`): every message starts on its own line as `[#<idx> <role>] `, followed by
 * its parts, one per line: text as is, tool calls as `→ tool <name>: <args>`, tool results as
 * `← <name>: <text>`, reasoning as `(reasoning) <text>`.
 */
import type { Chunk, TranscriptMessage, TranscriptPart } from '../types.ts';
import { findCandidates } from './candidates.ts';

/** Estimated tokens for `text`: characters / 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One part as text (see module doc for the format). */
export function renderPart(p: TranscriptPart): string {
  switch (p.kind) {
    case 'tool_call':
      return `→ tool ${p.tool ?? '?'}: ${p.text}`;
    case 'tool_result':
      return `← ${p.tool ?? 'result'}: ${p.text}`;
    case 'reasoning':
      return `(reasoning) ${p.text}`;
    default:
      return p.text;
  }
}

/** `[#<idx> <role>] ` followed by the rendered parts, newline-separated. */
export function renderMessage(m: TranscriptMessage): string {
  return `[#${m.idx} ${m.role}] ${m.parts.map(renderPart).join('\n')}`;
}

/** Options for {@link chunkMessages}. */
export interface ChunkOptions {
  /** Token budget per chunk (estimated with {@link estimateTokens}). */
  chunkTokens: number;
  /** Only messages with `idx >= fromIdx` are chunked (e.g. watermark + 1). */
  fromIdx?: number;
}

/** Split one oversized rendered message into pieces of at most `maxChars`, preferring line boundaries. */
function splitRendered(m: TranscriptMessage, rendered: string, maxChars: number): string[] {
  const contPrefix = `[#${m.idx} ${m.role}] (continued) `;
  const pieces: string[] = [];
  let cur = '';
  const budget = (): number => Math.max(1, maxChars - (pieces.length === 0 ? 0 : contPrefix.length));
  const flush = (): void => {
    if (cur === '') return;
    pieces.push(pieces.length === 0 ? cur : contPrefix + cur);
    cur = '';
  };
  for (const line of rendered.split('\n')) {
    let rest = line;
    for (;;) {
      const room = budget() - (cur === '' ? 0 : cur.length + 1);
      if (rest.length <= room) {
        cur = cur === '' ? rest : `${cur}\n${rest}`;
        break;
      }
      if (cur !== '') {
        flush();
        continue;
      }
      // A single line longer than a whole chunk: hard split.
      const b = budget();
      cur = rest.slice(0, b);
      rest = rest.slice(b);
      flush();
      if (rest === '') break;
    }
  }
  flush();
  return pieces;
}

/**
 * Greedily pack whole messages (in order, `idx >= fromIdx`) into chunks of at most `chunkTokens`
 * estimated tokens. A message that alone exceeds the budget is split into several chunks at line
 * boundaries (all with that message's idx; continuation pieces are marked `(continued)`). A new chunk
 * also starts whenever the session changes. Each chunk lists its candidate idx values.
 */
export function chunkMessages(msgs: TranscriptMessage[], opts: ChunkOptions): Chunk[] {
  const maxChars = Math.max(16, Math.floor(opts.chunkTokens)) * 4;
  const from = opts.fromIdx ?? Number.NEGATIVE_INFINITY;
  const chunks: Chunk[] = [];
  let group: TranscriptMessage[] = [];
  let texts: string[] = [];
  let size = 0;

  const make = (members: TranscriptMessage[], text: string, candidates: number[]): Chunk => {
    const first = members[0]!;
    const last = members[members.length - 1]!;
    return {
      id: `${first.harness}:${first.session}:${first.idx}-${last.idx}`,
      harness: first.harness,
      session: first.session,
      fromIdx: first.idx,
      toIdx: last.idx,
      text,
      tokens: estimateTokens(text),
      candidates,
    };
  };
  const flush = (): void => {
    if (group.length > 0) chunks.push(make(group, texts.join('\n'), findCandidates(group)));
    group = [];
    texts = [];
    size = 0;
  };

  for (const m of msgs) {
    if (m.idx < from) continue;
    const prev = group[0];
    if (prev && (prev.session !== m.session || prev.harness !== m.harness)) flush();
    const r = renderMessage(m);
    if (r.length > maxChars) {
      flush();
      const cands = findCandidates([m]);
      for (const piece of splitRendered(m, r, maxChars)) chunks.push(make([m], piece, cands));
      continue;
    }
    const added = group.length === 0 ? r.length : size + 1 + r.length;
    if (added > maxChars) flush();
    size = group.length === 0 ? r.length : size + 1 + r.length;
    group.push(m);
    texts.push(r);
  }
  flush();
  return chunks;
}

/** Unicode format characters (zero-width spaces/joiners, bidi controls, soft hyphen, tag chars, BOM…). */
const FORMAT_CHARS = /\p{Cf}/gu;
/** Characters skipped when deciding whether a bracket starts a delimiter look-alike. */
const IGNORABLE = /^[\s\p{Cf}\p{M}]$/u;
/**
 * Opening-bracket look-alikes: every char whose NFKC form is `<` (`<`, `﹤`, `＜`) plus visually similar
 * angle brackets a model could read as `<` (`〈`, `〈`, `⟨`, `❮`, `˂`, `ᐸ`, `⧼`), and the HTML entities `&lt;`,
 * `&#60;`, `&#x3c;`.
 */
const BRACKETS = /[<﹤＜〈〈⟨❮˂ᐸ⧼]|&(?:lt|#0*60|#x0*3c);/giu;
/** Up to 8 non-alphanumeric chars (a `/` or look-alike, `\`, …) then the reserved tag prefix. */
const TAG_PREFIX = /^[^\p{L}\p{N}]{0,8}untrusted/u;
/** Neutralized bracket. */
const SAFE_BRACKET = '‹';
/** How far past a bracket the scanner looks (raw code units) before giving up. */
const SCAN_LIMIT = 4096;

/** NFKD → drop marks/format/space → NFKC → lowercase: the "skeleton" a reader would see. */
function skeleton(ch: string): string {
  return ch.normalize('NFKD').replace(/[\s\p{Cf}\p{M}]/gu, '').normalize('NFKC').toLowerCase();
}

/** True when the text after a bracket at `start` reads (after normalization) as `untrusted…` / `/untrusted…`. */
function startsReservedTag(text: string, start: number): boolean {
  let seen = '';
  const end = Math.min(text.length, start + SCAN_LIMIT);
  for (let j = start; j < end; ) {
    const cp = text.codePointAt(j)!;
    const ch = String.fromCodePoint(cp);
    j += ch.length;
    if (IGNORABLE.test(ch)) continue;
    seen += skeleton(ch);
    if (seen.length >= 17) break; // 8 leading punctuation + "untrusted"
    if (/[\p{L}\p{N}]/u.test(seen) && !'untrusted'.startsWith(seen.replace(/^[^\p{L}\p{N}]*/u, ''))) break;
  }
  return TAG_PREFIX.test(seen);
}

/**
 * Make untrusted text safe to place between `<untrusted-…>` delimiters: removes all Unicode format
 * characters (`\p{Cf}`) and replaces with `‹` every `<` or `<` look-alike that — ignoring whitespace,
 * combining marks and format chars, after NFKC + lowercasing — opens something reading as `untrusted…` or
 * `/untrusted…` (e.g. `</untrusted​-transcript>`, `＜／ＵＮＴＲＵＳＴＥＤ-transcript＞`). The text cannot
 * close the wrapper early or open a fake one, whatever the wrapper kind.
 */
export function neutralizeUntrusted(text: string): string {
  const clean = text.replace(FORMAT_CHARS, '');
  return clean.replace(BRACKETS, (m: string, offset: number) =>
    startsReservedTag(clean, offset + m.length) ? SAFE_BRACKET : m,
  );
}

function escapeAttr(s: string): string {
  return neutralizeUntrusted(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ');
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/i;

/**
 * Wrap arbitrary untrusted text (transcript excerpts, evidence quotes, session titles, notes, search
 * snippets…) as `<untrusted-<kind> k="v" …>\n<text>\n</untrusted-<kind>>`. Attribute values are
 * escaped; the text is passed through {@link neutralizeUntrusted}. `kind` and attribute names must match
 * `[a-z][a-z0-9_-]*` (case-insensitive); typical kinds: `transcript`, `note`, `quote`, `title`, `snippet`.
 * @throws Error when `kind` or an attribute name is not a plain identifier (a programming error).
 */
export function wrapUntrustedText(kind: string, attrs: Record<string, string>, text: string): string {
  if (!NAME_RE.test(kind)) throw new Error(`invalid untrusted kind: ${JSON.stringify(kind)}`);
  let head = `<untrusted-${kind}`;
  for (const [k, v] of Object.entries(attrs)) {
    if (!NAME_RE.test(k)) throw new Error(`invalid attribute name: ${JSON.stringify(k)}`);
    head += ` ${k}="${escapeAttr(String(v))}"`;
  }
  return `${head}>\n${neutralizeUntrusted(text)}\n</untrusted-${kind}>`;
}

/**
 * Wrap a chunk in `<untrusted-transcript harness="…" session="…" msgs="from-to">` … `</untrusted-transcript>`
 * delimiters (see {@link wrapUntrustedText}; the same neutralization applies).
 */
export function wrapUntrusted(chunk: Chunk): string {
  return wrapUntrustedText(
    'transcript',
    { harness: chunk.harness, session: chunk.session, msgs: `${chunk.fromIdx}-${chunk.toIdx}` },
    chunk.text,
  );
}
