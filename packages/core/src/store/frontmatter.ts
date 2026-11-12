/**
 * Page (de)serialization: markdown with YAML front matter, page names, links.
 *
 * Page file format:
 * ```
 * ---
 * title: Test database setup
 * kind: fact
 * volatile: false
 * confidence: verified
 * verified_at: 2026-11-11
 * sources:
 *   - { harness: opencode, session: ses_123, msgs: "40-52" }
 * links: [ ci-pipeline, env-vars ]
 * ---
 *
 * Body markdown…
 * ```
 */
import { createHash } from 'node:crypto';
import { Document, Scalar, YAMLMap, YAMLSeq, parse as parseYaml } from 'yaml';
import { HARNESSES } from '../types.ts';
import type { Confidence, Harness, Page, PageKind, PageMeta, SourceRef } from '../types.ts';

/** All valid page kinds. */
export const PAGE_KINDS: readonly PageKind[] = [
  'fact',
  'rule',
  'decision',
  'howto',
  'trap',
  'preference',
  'overview',
  'thread',
];

const CONFIDENCES: readonly Confidence[] = ['verified', 'unverified'];

/** Max page name length. */
export const MAX_PAGE_NAME = 80;

const PAGE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/**
 * Windows reserved device names. A file `pages/con.md` cannot be added to git on Windows (and is unsafe to
 * create there), which would wedge history forever, so these names are rejected on every platform.
 */
const RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** True when `name` is a Windows reserved device name (case-insensitive). */
export function isReservedPageName(name: string): boolean {
  return typeof name === 'string' && RESERVED_NAME_RE.test(name.toLowerCase());
}

/**
 * True when `name` is a valid page slug: lowercase a–z, 0–9 and '-', 1–80 chars, no leading/trailing '-',
 * and not a Windows reserved device name (`con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`).
 */
export function isValidPageName(name: string): boolean {
  return typeof name === 'string' && PAGE_NAME_RE.test(name) && !RESERVED_NAME_RE.test(name);
}

/** Collapse anything outside the slug charset into single dashes, trimmed at both ends. */
function sanitizeSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Turn arbitrary text into a valid page name (≤ 80 chars).
 * Diacritics are stripped, everything else outside `[a-z0-9]` becomes '-'.
 * Returns `'page'` when nothing usable remains, so the result is always a valid name. Windows reserved device
 * names get a `-page` suffix (`con` → `con-page`).
 */
export function slugify(text: string): string {
  const slug = sanitizeSlug(String(text ?? ''))
    .slice(0, MAX_PAGE_NAME)
    .replace(/-+$/g, '');
  if (slug.length === 0) return 'page';
  return RESERVED_NAME_RE.test(slug) ? `${slug}-page` : slug;
}

function sha1Hex(text: string, len: number): string {
  return createHash('sha1').update(text).digest('hex').slice(0, len);
}

/** `head` cut so that `${head}-${suffix}` fits in MAX_PAGE_NAME, joined with the suffix. */
function withSuffix(head: string, suffix: string): string {
  const cut = head.slice(0, MAX_PAGE_NAME - suffix.length - 1).replace(/-+$/g, '');
  return cut.length > 0 ? `${cut}-${suffix}` : `thread-${suffix}`;
}

/**
 * Name of the thread-state page for a session: `thread-<harness>-<session>`, sanitized to the slug charset.
 * - Already-clean ids (e.g. UUIDs) map to exactly `thread-<harness>-<session>` (names stay stable).
 * - When sanitizing changed the id (case, `_`, `.`, …), a 6-hex hash of the raw session id is appended so
 *   distinct ids such as `a.b` and `a-b` never collide.
 * - Clean names longer than 80 chars are truncated and suffixed with an 8-hex hash of the full name.
 */
export function threadPageName(harness: Harness | string, session: string): string {
  const sess = String(session ?? '');
  const raw = `thread-${harness}-${sess}`;
  const slug = sanitizeSlug(raw);
  if (slug === raw) {
    return slug.length <= MAX_PAGE_NAME ? slug : withSuffix(slug, sha1Hex(raw, 8));
  }
  const hash = sha1Hex(sess, 6);
  const name = slug.length > 0 ? `${slug}-${hash}` : `thread-${hash}`;
  return name.length <= MAX_PAGE_NAME ? name : withSuffix(slug, hash);
}

/** Remove fenced code blocks and inline code spans so `[[ ... ]]` inside code (e.g. bash tests) isn't a link. */
function stripCode(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (m && m[1]) {
        fence = m[1];
        out.push('');
        continue;
      }
      out.push(line.replace(/(`+)[^`]*?\1/g, ''));
    } else {
      if (m && m[1] && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      out.push('');
    }
  }
  return out.join('\n');
}

/**
 * Wiki links in a page body: `[[name]]` and `[[name|label]]`.
 * Unique, in order of first appearance; links inside code blocks/spans are ignored.
 */
export function extractLinks(body: string): string[] {
  const text = stripCode(String(body ?? '').replace(/\r\n?/g, '\n'));
  const re = /\[\[([^[\]|\n]+?)(?:\|[^[\]\n]*)?\]\]/g;
  const seen = new Set<string>();
  const links: string[] = [];
  for (const m of text.matchAll(re)) {
    const name = (m[1] ?? '').trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    links.push(name);
  }
  return links;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return undefined;
}

function toDateString(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    if (m && m[1]) return m[1];
  }
  return undefined;
}

function toScalarString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function parseSources(v: unknown): SourceRef[] {
  if (!Array.isArray(v)) return [];
  const out: SourceRef[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const harness = item['harness'];
    const session = toScalarString(item['session']);
    const msgs = toScalarString(item['msgs']);
    if (typeof harness !== 'string' || !(HARNESSES as readonly string[]).includes(harness)) continue;
    if (!session || !msgs) continue;
    out.push({ harness: harness as Harness, session, msgs });
  }
  return out;
}

function parseLinks(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = toScalarString(item);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Split markdown into raw front matter YAML (or null when absent) and body. Input must be LF-normalized. */
function splitFrontMatter(text: string): { yaml: string | null; body: string } {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trimEnd() !== '---') return { yaml: null, body: text };
  for (let i = 1; i < lines.length; i++) {
    const l = (lines[i] ?? '').trimEnd();
    if (l === '---' || l === '...') {
      return { yaml: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
    }
  }
  return { yaml: null, body: text };
}

function normalizeBody(body: string): string {
  return body.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

/**
 * Parse a page file. Tolerates CRLF, a BOM, missing or invalid front matter.
 * Missing/invalid fields get defaults: title → first `# heading` or the name, kind 'fact', volatile false,
 * confidence 'unverified', sources [], links → extracted from the body.
 * The returned body has leading blank lines and trailing whitespace removed.
 */
export function parsePage(name: string, markdown: string): Page {
  const text = String(markdown ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  const { yaml, body: rawBody } = splitFrontMatter(text);
  let fm: Record<string, unknown> = {};
  if (yaml !== null) {
    try {
      const parsed: unknown = parseYaml(yaml);
      if (isRecord(parsed)) fm = parsed;
    } catch {
      fm = {};
    }
  }
  const body = normalizeBody(rawBody);

  const fmTitle = typeof fm['title'] === 'string' ? fm['title'].trim() : toScalarString(fm['title']);
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();
  const title = fmTitle && fmTitle.length > 0 ? fmTitle : heading && heading.length > 0 ? heading : name;

  const kindRaw = fm['kind'];
  const kind: PageKind =
    typeof kindRaw === 'string' && (PAGE_KINDS as readonly string[]).includes(kindRaw.trim())
      ? (kindRaw.trim() as PageKind)
      : 'fact';
  const confRaw = fm['confidence'];
  const confidence: Confidence =
    typeof confRaw === 'string' && (CONFIDENCES as readonly string[]).includes(confRaw.trim())
      ? (confRaw.trim() as Confidence)
      : 'unverified';

  const meta: PageMeta = {
    title,
    kind,
    volatile: toBool(fm['volatile']) ?? false,
    confidence,
    sources: parseSources(fm['sources']),
    links: parseLinks(fm['links']) ?? extractLinks(body),
  };
  const verified = toDateString(fm['verified_at']);
  if (verified) meta.verified_at = verified;
  return { name, meta, body };
}

/**
 * Serialize a page: front matter keys in fixed order (title, kind, volatile, confidence, verified_at, sources, links),
 * sources as flow-style objects, links recomputed from the body; then a blank line and the body. Ends with a newline.
 */
export function serializePage(page: Page): string {
  const body = normalizeBody(String(page.body ?? '').replace(/\r\n?/g, '\n'));
  const meta = page.meta;
  const obj: Record<string, unknown> = {
    title: meta.title && meta.title.trim().length > 0 ? meta.title.trim() : page.name,
    kind: (PAGE_KINDS as readonly string[]).includes(meta.kind) ? meta.kind : 'fact',
    volatile: meta.volatile === true,
    confidence: meta.confidence === 'verified' ? 'verified' : 'unverified',
  };
  const verified = toDateString(meta.verified_at);
  if (verified) obj['verified_at'] = verified;
  obj['sources'] = (meta.sources ?? []).map((s) => ({ harness: s.harness, session: s.session, msgs: s.msgs }));
  obj['links'] = extractLinks(body);

  const doc = new Document(obj);
  const sources = doc.get('sources');
  if (sources instanceof YAMLSeq) {
    for (const item of sources.items) {
      if (!(item instanceof YAMLMap)) continue;
      item.flow = true;
      const msgs: unknown = item.get('msgs', true);
      if (msgs instanceof Scalar) msgs.type = Scalar.QUOTE_DOUBLE;
    }
  }
  const links = doc.get('links');
  if (links instanceof YAMLSeq) links.flow = true;

  const yaml = doc.toString({ lineWidth: 0 });
  return `---\n${yaml}---\n${body.length > 0 ? `\n${body}\n` : ''}`;
}
