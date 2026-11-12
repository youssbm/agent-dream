/**
 * Compact text renderings of job material (claims, verdicts, patterns, page lists) for step inputs.
 * Everything here is bounded: callers pass a character budget and get a truncated block back.
 */
import type { Page, Pattern, SourceRef, TranscriptMessage, Harness, Chunk } from '../types.ts';
import { renderMessage, wrapUntrusted, wrapUntrustedText, estimateTokens } from '../transcripts/chunk.ts';
import type { StoredClaim, StoredVerdict } from './job.ts';

/** `claude-code:abc#40-52` */
export function refText(s: SourceRef): string {
  return `${s.harness}:${s.session}#${s.msgs}`;
}

export function refsText(sources: SourceRef[]): string {
  return sources.length ? sources.map(refText).join(', ') : 'no source';
}

/** Cut `text` to at most `max` characters, marking the cut. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 40);
  return `${text.slice(0, keep)}\n… [${text.length - keep} chars omitted]`;
}

/** Join lines until the character budget is used; notes how many were left out. */
export function capLines(lines: string[], max: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (used + l.length + 1 > max && out.length > 0) {
      out.push(`… [${lines.length - i} more omitted]`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join('\n');
}

export function claimLine(c: StoredClaim): string {
  const flags = [c.kind, c.verbatim ? 'verbatim' : '', c.volatile ? 'volatile' : '', c.verbatimFailed ? 'UNVERIFIED: exact text not found in source' : '']
    .filter(Boolean)
    .join(', ');
  return `${c.id} [${flags}] ${c.text.replace(/\s*\n\s*/g, ' ')} (${refsText(c.sources)})`;
}

export function claimsBlock(claims: StoredClaim[], max: number): string {
  if (claims.length === 0) return '(none)';
  return capLines(claims.map(claimLine), max);
}

export function verdictLine(v: StoredVerdict): string {
  const parts = [`${v.page}: ${v.verdict}`];
  if (v.corrected) parts.push(`→ ${v.corrected.replace(/\s*\n\s*/g, ' ')}`);
  if (v.reason) parts.push(`— ${v.reason.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (v.evidence) parts.push(`evidence:\n${quoteBlock(v.evidence.quote, v.evidence.source, 200)}`);
  return parts.join(' ');
}

/** An evidence quote (transcript text, untrusted) wrapped in `<untrusted-quote source="…">` delimiters. */
export function quoteBlock(quote: string, source: SourceRef | undefined, max = 600): string {
  const q = quote.replace(/\s+/g, ' ').trim();
  return wrapUntrustedText('quote', source ? { source: refText(source) } : {}, q.length > max ? `${q.slice(0, max)}…` : q);
}

export function verdictsBlock(verdicts: StoredVerdict[], max: number): string {
  if (verdicts.length === 0) return '(none)';
  return capLines(verdicts.map(verdictLine), max);
}

export function patternsBlock(patterns: Pattern[], max: number): string {
  if (patterns.length === 0) return '(none)';
  return capLines(
    patterns.map((p, i) => `p${i + 1} [${p.kind}] ${p.text.replace(/\s*\n\s*/g, ' ')} (${refsText(p.sources)})`),
    max,
  );
}

/** First meaningful line of a body, for one-line page summaries. */
export function firstLine(body: string, max = 100): string {
  for (const raw of body.split(/\r?\n/)) {
    const l = raw.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim();
    if (l) return l.length > max ? `${l.slice(0, max - 1)}…` : l;
  }
  return '';
}

export function pageListLine(p: Page): string {
  const summary = firstLine(p.body);
  return `- ${p.name} — ${p.meta.title} (${p.meta.kind}${p.meta.confidence === 'unverified' ? ', unverified' : ''})${summary ? `: ${summary}` : ''}`;
}

export function pageListBlock(pages: Page[], max: number): string {
  if (pages.length === 0) return '(no pages yet)';
  return capLines(
    [...pages].sort((a, b) => a.name.localeCompare(b.name)).map(pageListLine),
    max,
  );
}

/**
 * Render transcript messages of one session within [from, to] as an untrusted block.
 * `messages` are the filtered messages of that session.
 */
export function transcriptWindow(
  harness: Harness,
  session: string,
  messages: TranscriptMessage[],
  from: number,
  to: number,
  maxChars: number,
): string | null {
  const picked = messages.filter((m) => m.idx >= from && m.idx <= to);
  if (picked.length === 0) return null;
  const text = cap(picked.map((m) => renderMessage(m)).join('\n'), maxChars);
  const first = picked[0];
  const last = picked[picked.length - 1];
  if (!first || !last) return null;
  const chunk: Chunk = {
    id: `${harness}:${session}:${first.idx}-${last.idx}`,
    harness,
    session,
    fromIdx: first.idx,
    toIdx: last.idx,
    text,
    tokens: estimateTokens(text),
    candidates: [],
  };
  return wrapUntrusted(chunk);
}

/** Merge overlapping/adjacent inclusive ranges. */
export function mergeRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** Parse a transcript search ref `${harness}:${session}#${idx}`. */
export function parseTranscriptRef(ref: string): { harness: string; session: string; idx: number } | null {
  const colon = ref.indexOf(':');
  const hash = ref.lastIndexOf('#');
  if (colon < 1 || hash < colon) return null;
  const idx = Number(ref.slice(hash + 1));
  if (!Number.isInteger(idx)) return null;
  return { harness: ref.slice(0, colon), session: ref.slice(colon + 1, hash), idx };
}
