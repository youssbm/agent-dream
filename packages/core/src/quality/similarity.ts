/**
 * Text normalization and similarity helpers.
 *
 * `normalizeForQuote` is the canonical form used by the anti-hallucination evidence check: a quote the
 * model submits and the transcript text it cites are both normalized with it before the substring test.
 * `similarity` estimates how much of a page survived an update (used by the auto-apply safety net).
 */

/** Typographic single quotes / primes → ASCII apostrophe. */
const SINGLE_QUOTES = /[‘’‚‛′‵ʼʹ]/g;
/** Typographic double quotes → ASCII double quote. */
const DOUBLE_QUOTES = /[“”„‟″‶«»ʺ]/g;
/** Hyphens, dashes and minus signs → ASCII hyphen-minus. */
const DASHES = /[‐‑‒–—―−⸺⸻﹘﹣－]/g;
/** Zero-width and BOM characters, removed entirely. */
const INVISIBLE = /[​‌‍⁠﻿­]/g;
/** Any whitespace (after NFKC most exotic spaces are already U+0020). */
const WHITESPACE = /\s+/gu;

function normalizeOnce(s: string): string {
  return s
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .toLowerCase()
    .normalize('NFKC')
    .replace(WHITESPACE, ' ')
    .trim();
}

/**
 * Canonical form for quote matching: Unicode NFKC, zero-width characters removed, typographic quotes and
 * dashes mapped to ASCII, lowercased, whitespace runs collapsed to one space, trimmed.
 *
 * Deterministic and idempotent: `normalizeForQuote(normalizeForQuote(x)) === normalizeForQuote(x)`
 * (the pipeline is re-applied until it reaches a fixed point, which guards against rare case-mapping
 * results that are not themselves NFKC-stable).
 */
export function normalizeForQuote(s: string): string {
  let current = normalizeOnce(s);
  for (let i = 0; i < 4; i++) {
    const next = normalizeOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

const TOKEN = /[\p{L}\p{N}_]+/gu;

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.match(TOKEN) ?? []);
}

function lineList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => normalizeForQuote(l))
    .filter((l) => l.length > 0);
}

/** |A ∩ B| / |A ∪ B| over sets; 1 when both are empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Multiset Dice coefficient over lines: 2·|A ∩ B| / (|A| + |B|); 1 when both are empty. */
function lineDice(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      common++;
      counts.set(l, c - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * Similarity of two texts in [0, 1].
 *
 * Formula:
 * ```
 *   T = Jaccard(tokens(a), tokens(b))          tokens = unique [\p{L}\p{N}_]+ runs of normalizeForQuote(text)
 *   L = Dice(lines(a), lines(b))               lines  = non-empty normalized lines, as a multiset
 *   m = min(lineCount(a), lineCount(b))
 *   w = 0.4 · clamp((m − 1) / 2, 0, 1)         0 for one-line texts, 0.2 for two lines, 0.4 for ≥ 3 lines
 *   similarity = (1 − w) · T + w · L
 * ```
 * Token overlap measures shared vocabulary; line overlap rewards unchanged lines in multi-line pages (and
 * penalizes rewrites that reuse the same words). Line overlap is down-weighted for very short texts, where
 * one changed word would otherwise change the only line.
 *
 * Identical texts (after normalization) → 1. Both empty → 1. Exactly one empty → 0. No shared tokens and
 * no shared lines → 0.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeForQuote(a);
  const nb = normalizeForQuote(b);
  if (na === nb && lineList(a).join('\n') === lineList(b).join('\n')) return 1;
  if (na.length === 0 || nb.length === 0) return 0;

  const t = jaccard(tokenSet(na), tokenSet(nb));
  const la = lineList(a);
  const lb = lineList(b);
  const m = Math.min(la.length, lb.length);
  const w = 0.4 * Math.min(1, Math.max(0, (m - 1) / 2));
  const l = lineDice(la, lb);
  const s = (1 - w) * t + w * l;
  return Math.min(1, Math.max(0, s));
}
