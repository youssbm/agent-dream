/**
 * Search over memory pages (in-process MiniSearch index, rebuilt per call — memory is small) and over
 * normalized transcripts (simple term scoring). No embeddings (PLAN §4.3).
 */
import MiniSearch from 'minisearch';
import type { Page, SearchHit, TranscriptMessage, TranscriptPart } from '../types.ts';

/** Target snippet length in characters. */
const SNIPPET_CHARS = 200;
/** How much context to keep before the first match. */
const SNIPPET_LEAD = 60;

const QUERY_TERM = /[\p{L}\p{N}]+/gu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercased query terms, unique, in order. */
function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of query.toLowerCase().match(QUERY_TERM) ?? []) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Regex matching any of the terms at the start of a word (so "port" matches "ports" but not "report"). */
function termRegex(terms: string[], flags = 'giu'): RegExp | null {
  if (terms.length === 0) return null;
  const alt = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})`, flags);
}

/**
 * ~SNIPPET_CHARS characters of `text` around the first match of any term (whitespace collapsed),
 * with `…` marking cut ends. Falls back to the start of the text when nothing matches.
 */
function makeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const re = termRegex(terms);
  const pos = re ? flat.search(re) : -1;
  let start = pos < 0 ? 0 : Math.max(0, pos - SNIPPET_LEAD);
  let end = Math.min(flat.length, start + SNIPPET_CHARS);
  if (end - start < SNIPPET_CHARS) start = Math.max(0, end - SNIPPET_CHARS);
  // Snap to word boundaries where possible.
  if (start > 0) {
    const sp = flat.indexOf(' ', start);
    if (sp >= 0 && sp < start + 20 && (pos < 0 || sp < pos)) start = sp + 1;
  }
  if (end < flat.length) {
    const sp = flat.lastIndexOf(' ', end);
    if (sp > end - 20 && sp > start && (pos < 0 || sp > pos)) end = sp;
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

interface PageDoc {
  id: number;
  name: string;
  title: string;
  body: string;
}

/**
 * Full-text search over pages with MiniSearch: fields `title`, `body`, `name`; title boosted ×3 and
 * name ×2; prefix search and fuzzy 0.2; terms combined with OR (more matching terms rank higher).
 * Returns at most `limit` hits, best first. Duplicate page names: the first one wins.
 */
export function searchPages(pages: Page[], query: string, limit = 10): SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || limit <= 0) return [];

  const byId: Page[] = [];
  const docs: PageDoc[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.name)) continue;
    seen.add(page.name);
    byId.push(page);
    docs.push({ id: byId.length - 1, name: page.name, title: page.meta.title ?? '', body: page.body });
  }
  if (docs.length === 0) return [];

  const ms = new MiniSearch<PageDoc>({
    fields: ['title', 'body', 'name'],
    idField: 'id',
    searchOptions: { boost: { title: 3, name: 2 }, prefix: true, fuzzy: 0.2, combineWith: 'OR' },
  });
  ms.addAll(docs);

  const results = ms.search(terms.join(' '));
  const hits: SearchHit[] = [];
  for (const r of results.slice(0, limit)) {
    const page = byId[r.id as number];
    if (!page) continue;
    // Matched document terms (after prefix/fuzzy expansion) locate the snippet; query terms as fallback.
    const snippetTerms = [...new Set([...r.terms.map((t) => t.toLowerCase()), ...terms])];
    hits.push({
      ref: page.name,
      kind: 'page',
      title: page.meta.title,
      snippet: makeSnippet(page.body, snippetTerms),
      score: r.score,
      sources: page.meta.sources,
    });
  }
  return hits;
}

function renderPart(part: TranscriptPart): string {
  switch (part.kind) {
    case 'tool_call':
      return `→ tool ${part.tool ?? ''}: ${part.text}`;
    case 'tool_result':
      return `← ${part.tool ?? 'result'}: ${part.text}`;
    default:
      return part.text;
  }
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) {
    n++;
    if (n >= 50) break;
  }
  return n;
}

/**
 * Term search over transcript messages. Each message's parts are rendered to text; for every query term
 * that occurs at a word start, the score adds `1 + ln(occurrences)`; the sum is multiplied by the squared
 * share of query terms matched (so messages containing all terms rank first), plus a bonus of 2 when the
 * whole query appears as a phrase. Messages with no matching term are skipped. Ties keep input order.
 * `ref` is `${harness}:${session}#${idx}`; `sources` cites that single message.
 */
export function searchTranscripts(messages: TranscriptMessage[], query: string, limit = 10): SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || limit <= 0) return [];
  const termRes = terms.map((t) => termRegex([t], 'giu') as RegExp);
  const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim();

  const scored: { hit: SearchHit; order: number }[] = [];
  messages.forEach((msg, order) => {
    const text = msg.parts.map(renderPart).join('\n');
    if (!text.trim()) return;
    let matched = 0;
    let sum = 0;
    termRes.forEach((re) => {
      const n = countMatches(text, re);
      if (n > 0) {
        matched++;
        sum += 1 + Math.log(n);
      }
    });
    if (matched === 0) return;
    const coverage = matched / terms.length;
    let score = sum * coverage * coverage;
    if (terms.length > 1 && text.toLowerCase().replace(/\s+/g, ' ').includes(phrase)) score += 2;
    scored.push({
      order,
      hit: {
        ref: `${msg.harness}:${msg.session}#${msg.idx}`,
        kind: 'transcript',
        snippet: makeSnippet(text, terms),
        score,
        sources: [{ harness: msg.harness, session: msg.session, msgs: String(msg.idx) }],
      },
    });
  });

  scored.sort((a, b) => b.hit.score - a.hit.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.hit);
}
