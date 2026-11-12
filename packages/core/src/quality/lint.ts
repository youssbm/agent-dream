/**
 * Memory linter: link integrity, orphans, size caps and the wiki/source ratio (PLAN §2, §6 gap-fill).
 * Pure and deterministic; issues are returned in a stable order (index issues first, then per page in input order).
 */
import type { LintInput, LintIssue, Page } from '../types.ts';
import { extractLinks } from '../store/frontmatter.ts';

/** Body size above which a page should be split. */
export const MAX_PAGE_BODY_BYTES = 12 * 1024;
/** The wiki/source ratio is only meaningful once enough transcript has been processed. */
export const MIN_SOURCE_CHARS_FOR_RATIO = 20_000;

/**
 * `[[name]]` and `[[name|label]]` targets in order of first appearance, unique.
 * Delegates to the store's `extractLinks` so lint and storage agree (e.g. both ignore `[[ … ]]` inside code).
 */
function linksIn(markdown: string): string[] {
  return extractLinks(markdown);
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isThreadPage(page: Page): boolean {
  return page.meta.kind === 'thread' || page.name.startsWith('thread-');
}

/** Outgoing links of a page: body links first, then any extra names listed in `meta.links`. */
function pageLinks(page: Page): string[] {
  const out = linksIn(page.body);
  const seen = new Set(out);
  for (const l of page.meta.links ?? []) {
    const t = l.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Size of the index: `lines` = number of lines (a trailing newline does not start a new line; '' → 0;
 * CRLF counts as one line break), `bytes` = UTF-8 byte length.
 */
export function indexStats(index: string): { lines: number; bytes: number } {
  const bytes = utf8Bytes(index);
  if (index.length === 0) return { lines: 0, bytes };
  const breaks = index.match(/\r\n|\r|\n/g)?.length ?? 0;
  const endsWithBreak = /(?:\r\n|\r|\n)$/.test(index);
  return { lines: endsWithBreak ? breaks : breaks + 1, bytes };
}

/**
 * Lint the memory folder.
 *
 * - `index_too_long` / `index_too_large`: index over `config.indexMaxLines` / `config.indexMaxBytes`.
 * - `index_dangling_link`: index links to a page that does not exist.
 * - `dangling_link`: a page links to a page that does not exist (thread pages count as existing).
 * - `orphan_page`: a non-thread page with no inbound link from another page or from the index.
 * - `oversized_page`: body larger than 12 KB (UTF-8).
 * - `missing_sources`: a non-thread page with no source references.
 * - `duplicate_title`: two or more pages share a title (case-insensitive); reported on each later page,
 *   with `target` = the first page that has the title.
 * - `wiki_source_ratio`: total page body bytes / max(sourceChars, 1) exceeds `config.maxWikiSourceRatio`
 *   (only checked when sourceChars > 20,000).
 */
export function lintMemory(input: LintInput): LintIssue[] {
  const { pages, index, config, sourceChars } = input;
  const issues: LintIssue[] = [];
  const names = new Set(pages.map((p) => p.name));

  // Index.
  const stats = indexStats(index);
  if (stats.lines > config.indexMaxLines) {
    issues.push({
      type: 'index_too_long',
      message: `MEMORY.md has ${stats.lines} lines; the cap is ${config.indexMaxLines}. Move detail into pages and keep one line per entry.`,
    });
  }
  if (stats.bytes > config.indexMaxBytes) {
    issues.push({
      type: 'index_too_large',
      message: `MEMORY.md is ${stats.bytes} bytes; the cap is ${config.indexMaxBytes}. Move detail into pages.`,
    });
  }
  const indexLinks = linksIn(index);
  for (const target of indexLinks) {
    if (!names.has(target)) {
      issues.push({
        type: 'index_dangling_link',
        target,
        message: `MEMORY.md links to [[${target}]], which does not exist.`,
      });
    }
  }

  // Inbound links (self-links don't count).
  const inbound = new Set<string>(indexLinks);
  const outgoing = new Map<string, string[]>();
  for (const page of pages) {
    const links = pageLinks(page);
    outgoing.set(page.name, links);
    for (const l of links) if (l !== page.name) inbound.add(l);
  }

  const firstByTitle = new Map<string, string>();
  let totalBodyBytes = 0;

  for (const page of pages) {
    const thread = isThreadPage(page);
    const bodyBytes = utf8Bytes(page.body);
    totalBodyBytes += bodyBytes;

    for (const target of outgoing.get(page.name) ?? []) {
      if (!names.has(target)) {
        issues.push({
          type: 'dangling_link',
          page: page.name,
          target,
          message: `[[${page.name}]] links to [[${target}]], which does not exist.`,
        });
      }
    }

    if (!thread && !inbound.has(page.name)) {
      issues.push({
        type: 'orphan_page',
        page: page.name,
        message: `[[${page.name}]] has no inbound links from the index or any other page.`,
      });
    }

    if (bodyBytes > MAX_PAGE_BODY_BYTES) {
      issues.push({
        type: 'oversized_page',
        page: page.name,
        message: `[[${page.name}]] body is ${bodyBytes} bytes (limit ${MAX_PAGE_BODY_BYTES}); split it into smaller linked pages.`,
      });
    }

    if (!thread && (page.meta.sources ?? []).length === 0) {
      issues.push({
        type: 'missing_sources',
        page: page.name,
        message: `[[${page.name}]] has no sources; cite the transcript messages it is based on or mark it unverified.`,
      });
    }

    const titleKey = (page.meta.title ?? '').trim().toLowerCase();
    if (titleKey) {
      const first = firstByTitle.get(titleKey);
      if (first === undefined) {
        firstByTitle.set(titleKey, page.name);
      } else {
        issues.push({
          type: 'duplicate_title',
          page: page.name,
          target: first,
          message: `[[${page.name}]] has the same title as [[${first}]] ("${page.meta.title.trim()}"); merge them or retitle one.`,
        });
      }
    }
  }

  if (sourceChars > MIN_SOURCE_CHARS_FOR_RATIO) {
    const ratio = totalBodyBytes / Math.max(sourceChars, 1);
    if (ratio > config.maxWikiSourceRatio) {
      issues.push({
        type: 'wiki_source_ratio',
        message: `Pages total ${totalBodyBytes} bytes for ${sourceChars} source chars (ratio ${ratio.toFixed(2)} > ${config.maxWikiSourceRatio}); merge and prune pages.`,
      });
    }
  }

  return issues;
}
