/**
 * Evidence checks: the server-side anti-hallucination guard. A verdict that corrects or deletes memory must
 * quote the transcript, and the quote must really be there, in the cited message range.
 */
import type { SourceRef, TranscriptMessage } from '../types.ts';
import { DreamError } from '../types.ts';
import { normalizeForQuote } from '../quality/similarity.ts';
import { renderMessage } from './chunk.ts';

/** Minimum / maximum quote length, in characters after {@link normalizeForQuote}. */
export const QUOTE_MIN_CHARS = 8;
export const QUOTE_MAX_CHARS = 600;

/** Parse `"40"` or `"40-52"` (inclusive idx range). Throws `DreamError('INVALID_OUTPUT')` on bad input. */
export function parseMsgRange(msgs: string): { from: number; to: number } {
  const m = /^\s*(\d{1,9})\s*(?:[-–]\s*(\d{1,9})\s*)?$/.exec(typeof msgs === 'string' ? msgs : '');
  if (!m) throw new DreamError('INVALID_OUTPUT', `Invalid message range "${String(msgs)}": expected "N" or "N-M".`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) throw new DreamError('INVALID_OUTPUT', `Invalid message range "${msgs}": end is before start.`);
  return { from, to };
}

/** Result of {@link checkQuote}. */
export interface QuoteCheck {
  ok: boolean;
  /** 'quote_too_short' | 'quote_too_long' | 'session_mismatch' | 'not_found_in_range' | 'invalid_range' */
  reason?: string;
}

/**
 * Whether `quote` occurs in the cited source. `messages` must be the **unfiltered** transcript (any number
 * of sessions; only those matching `source.harness` + `source.session` are considered). The quote is
 * normalized with `normalizeForQuote` and must be 8–600 chars long; it must be a substring of the normalized,
 * rendered text of the messages whose idx lies in `[from - 1, to + 1]` (one message of slack each side).
 */
export function checkQuote(messages: TranscriptMessage[], source: SourceRef, quote: string): QuoteCheck {
  const q = normalizeForQuote(typeof quote === 'string' ? quote : '');
  if (q.length < QUOTE_MIN_CHARS) return { ok: false, reason: 'quote_too_short' };
  if (q.length > QUOTE_MAX_CHARS) return { ok: false, reason: 'quote_too_long' };
  let range: { from: number; to: number };
  try {
    range = parseMsgRange(source.msgs);
  } catch {
    return { ok: false, reason: 'invalid_range' };
  }
  const own = messages.filter((m) => m.session === source.session && m.harness === source.harness);
  if (own.length === 0) return { ok: false, reason: 'session_mismatch' };
  const window = own.filter((m) => m.idx >= range.from - 1 && m.idx <= range.to + 1);
  if (window.length === 0) return { ok: false, reason: 'not_found_in_range' };
  const hay = normalizeForQuote(window.map(renderMessage).join('\n'));
  return hay.includes(q) ? { ok: true } : { ok: false, reason: 'not_found_in_range' };
}
