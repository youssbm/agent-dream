import { describe, expect, it } from 'vitest';
import { indexStats, lintMemory } from '../../src/quality/lint.ts';
import { DEFAULT_CONFIG, type LintInput, type LintIssue, type Page, type PageMeta } from '../../src/types.ts';

const SRC = [{ harness: 'opencode' as const, session: 'ses_1', msgs: '1-4' }];

function page(name: string, body: string, meta: Partial<PageMeta> = {}): Page {
  return {
    name,
    body,
    meta: {
      title: meta.title ?? name,
      kind: meta.kind ?? 'fact',
      volatile: meta.volatile ?? false,
      confidence: meta.confidence ?? 'verified',
      sources: meta.sources ?? SRC,
      links: meta.links ?? [],
      ...(meta.verified_at ? { verified_at: meta.verified_at } : {}),
    },
  };
}

function lint(partial: Partial<LintInput>): LintIssue[] {
  return lintMemory({ pages: [], index: '', config: DEFAULT_CONFIG, sourceChars: 0, ...partial });
}

const ofType = (issues: LintIssue[], type: LintIssue['type']) => issues.filter((i) => i.type === type);

describe('indexStats', () => {
  it('counts lines and UTF-8 bytes', () => {
    expect(indexStats('')).toEqual({ lines: 0, bytes: 0 });
    expect(indexStats('one')).toEqual({ lines: 1, bytes: 3 });
    expect(indexStats('one\ntwo')).toEqual({ lines: 2, bytes: 7 });
    expect(indexStats('one\ntwo\n')).toEqual({ lines: 2, bytes: 8 });
    expect(indexStats('one\r\ntwo\r\n')).toEqual({ lines: 2, bytes: 10 });
    expect(indexStats('\n')).toEqual({ lines: 1, bytes: 1 });
    expect(indexStats('a\n\nb')).toEqual({ lines: 3, bytes: 4 });
    expect(indexStats('é—🙂')).toEqual({ lines: 1, bytes: 2 + 3 + 4 });
  });
});

describe('lintMemory', () => {
  it('returns no issues for a healthy memory', () => {
    const pages = [
      page('dev-server', 'Runs on 5173. See [[env-vars]].'),
      page('env-vars', 'Read from `.env.local`. Back to [[dev-server|the dev server]].'),
      page('thread-opencode-ses-1', 'Goal: fix the port. [[dev-server]]', { kind: 'thread', sources: [] }),
    ];
    const index = '# Memory\n- [[dev-server]] — port and startup\n- [[thread-opencode-ses-1]] — active thread\n';
    expect(lint({ pages, index, sourceChars: 50_000 })).toEqual([]);
  });

  it('reports dangling links in pages; thread pages count as existing', () => {
    const pages = [
      page('a', 'See [[b]], [[missing-one]] and [[missing-one|again]], plus [[thread-codex-x]].'),
      page('b', 'Back to [[a]].'),
      page('thread-codex-x', 'thread', { kind: 'thread', sources: [] }),
    ];
    const issues = lint({ pages, index: '[[a]]' });
    const dangling = ofType(issues, 'dangling_link');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toMatchObject({ page: 'a', target: 'missing-one' });
    expect(dangling[0]?.message).toContain('missing-one');
  });

  it('also checks names listed only in meta.links', () => {
    const pages = [page('a', 'no links in body', { links: ['ghost'] })];
    const issues = lint({ pages, index: '[[a]]' });
    expect(ofType(issues, 'dangling_link')).toEqual([expect.objectContaining({ page: 'a', target: 'ghost' })]);
  });

  it('reports index dangling links', () => {
    const issues = lint({ pages: [page('a', 'x')], index: '- [[a]]\n- [[nope]]\n- [[nope|label]]' });
    const d = ofType(issues, 'index_dangling_link');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ target: 'nope' });
    expect(d[0]?.page).toBeUndefined();
  });

  it('reports orphan pages; self-links do not count; thread pages are exempt', () => {
    const pages = [
      page('linked', 'body'),
      page('lonely', 'I link to myself: [[lonely]]'),
      page('thread-claude-code-abc', 'state', { kind: 'thread', sources: [] }),
    ];
    const issues = lint({ pages, index: '[[linked]]' });
    expect(ofType(issues, 'orphan_page').map((i) => i.page)).toEqual(['lonely']);
  });

  it('treats an inbound link from another page as non-orphan', () => {
    const pages = [page('hub', 'See [[leaf]]'), page('leaf', 'leaf')];
    const issues = lint({ pages, index: '[[hub]]' });
    expect(ofType(issues, 'orphan_page')).toEqual([]);
  });

  it('reports pages whose body exceeds 12 KB (UTF-8 bytes)', () => {
    const ok = page('ok', 'x'.repeat(12 * 1024));
    const big = page('big', 'x'.repeat(12 * 1024 + 1));
    const multibyte = page('multibyte', 'é'.repeat(6 * 1024 + 1)); // 2 bytes each → 12290 bytes
    const issues = lint({ pages: [ok, big, multibyte], index: '[[ok]] [[big]] [[multibyte]]' });
    expect(ofType(issues, 'oversized_page').map((i) => i.page)).toEqual(['big', 'multibyte']);
  });

  it('reports index over the line and byte caps', () => {
    const config = { ...DEFAULT_CONFIG, indexMaxLines: 3, indexMaxBytes: 20 };
    const index = 'line one\nline two\nline three\nline four\n';
    const issues = lint({ index, config });
    expect(ofType(issues, 'index_too_long')).toHaveLength(1);
    expect(ofType(issues, 'index_too_long')[0]?.message).toContain('4 lines');
    expect(ofType(issues, 'index_too_large')).toHaveLength(1);
    expect(lint({ index: 'a\nb\nc\n', config: { ...config, indexMaxBytes: 100 } })).toEqual([]);
  });

  it('checks the wiki/source ratio only when sourceChars > 20,000', () => {
    const pages = [page('a', 'x'.repeat(30_000))];
    const index = '[[a]]';
    const config = { ...DEFAULT_CONFIG, maxWikiSourceRatio: 1.0 };
    // Below threshold: never reported.
    expect(ofType(lint({ pages, index, config, sourceChars: 20_000 }), 'wiki_source_ratio')).toEqual([]);
    // Above threshold, ratio 30000/25000 = 1.2 > 1.0.
    const over = ofType(lint({ pages, index, config, sourceChars: 25_000 }), 'wiki_source_ratio');
    expect(over).toHaveLength(1);
    expect(over[0]?.message).toContain('1.20');
    // Ratio 30000/40000 = 0.75 ≤ 1.0.
    expect(ofType(lint({ pages, index, config, sourceChars: 40_000 }), 'wiki_source_ratio')).toEqual([]);
  });

  it('reports duplicate titles case-insensitively on each later page', () => {
    const pages = [
      page('one', 'a', { title: 'Test DB setup' }),
      page('two', 'b', { title: 'test db SETUP ' }),
      page('three', 'c', { title: 'Test DB Setup' }),
      page('four', 'd', { title: 'Something else' }),
    ];
    const issues = lint({ pages, index: '[[one]] [[two]] [[three]] [[four]]' });
    const dups = ofType(issues, 'duplicate_title');
    expect(dups.map((d) => [d.page, d.target])).toEqual([
      ['two', 'one'],
      ['three', 'one'],
    ]);
  });

  it('reports pages without sources, except thread pages', () => {
    const pages = [
      page('sourced', 'a'),
      page('unsourced', 'b', { sources: [] }),
      page('thread-opencode-z', 'c', { kind: 'thread', sources: [] }),
    ];
    const issues = lint({ pages, index: '[[sourced]] [[unsourced]]' });
    expect(ofType(issues, 'missing_sources').map((i) => i.page)).toEqual(['unsourced']);
  });

  it('detects thread pages by name prefix even if kind is not thread', () => {
    const pages = [page('thread-codex-q', 'no sources, no inbound', { kind: 'fact', sources: [] })];
    expect(lint({ pages })).toEqual([]);
  });

  it('orders issues: index issues first, then per page in input order', () => {
    const pages = [page('b', '[[zzz]]', { sources: [] }), page('a', 'a')];
    const issues = lint({ pages, index: '[[missing]]' });
    expect(issues.map((i) => `${i.type}:${i.page ?? ''}`)).toEqual([
      'index_dangling_link:',
      'dangling_link:b',
      'orphan_page:b',
      'missing_sources:b',
      'orphan_page:a',
    ]);
  });

  it('is deterministic', () => {
    const pages = [page('x', '[[y]]'), page('y', '[[q]]', { sources: [] })];
    const input: LintInput = { pages, index: '[[x]]', config: DEFAULT_CONFIG, sourceChars: 0 };
    expect(lintMemory(input)).toEqual(lintMemory(input));
  });
});
