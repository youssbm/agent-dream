import { describe, expect, it } from 'vitest';
import { searchPages, searchTranscripts } from '../../src/quality/search.ts';
import type { Page, TranscriptMessage, TranscriptPart } from '../../src/types.ts';

function page(name: string, title: string, body: string): Page {
  return {
    name,
    body,
    meta: {
      title,
      kind: 'fact',
      volatile: false,
      confidence: 'verified',
      sources: [{ harness: 'codex', session: 'rollout-1', msgs: '3-9' }],
      links: [],
    },
  };
}

const PAGES: Page[] = [
  page('dev-server', 'Dev server', 'The dev server listens on port 5173. Start it with `npm run dev`.'),
  page('test-db-setup', 'Test database setup', 'Run `docker compose up db` before `npm test`; tests fail with ECONNREFUSED 5432 otherwise.'),
  page('ci-pipeline', 'CI pipeline', 'GitHub Actions runs lint, typecheck and the test suite on ubuntu and windows.'),
  page(
    'long-notes',
    'Long notes',
    `${'Filler sentence about unrelated matters. '.repeat(20)}The deployment key detail: releases are tagged from main. ${'More filler text here. '.repeat(20)}`,
  ),
];

describe('searchPages', () => {
  it('finds a page by a body term', () => {
    const hits = searchPages(PAGES, 'docker');
    expect(hits[0]?.ref).toBe('test-db-setup');
    expect(hits[0]?.kind).toBe('page');
    expect(hits[0]?.title).toBe('Test database setup');
    expect(hits[0]?.sources).toEqual([{ harness: 'codex', session: 'rollout-1', msgs: '3-9' }]);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('boosts title matches above body-only matches', () => {
    // "pipeline" is in the CI title; put it in another page's body only.
    const pages = [...PAGES, page('other', 'Other', 'A data pipeline mention in the body only.')];
    const hits = searchPages(pages, 'pipeline');
    expect(hits.map((h) => h.ref).slice(0, 2)).toEqual(['ci-pipeline', 'other']);
  });

  it('supports prefix search', () => {
    expect(searchPages(PAGES, 'typech')[0]?.ref).toBe('ci-pipeline');
  });

  it('supports fuzzy search', () => {
    expect(searchPages(PAGES, 'databse')[0]?.ref).toBe('test-db-setup');
  });

  it('matches page names', () => {
    expect(searchPages(PAGES, 'setup').map((h) => h.ref)).toContain('test-db-setup');
  });

  it('ranks pages matching more query terms higher', () => {
    const hits = searchPages(PAGES, 'dev server port');
    expect(hits[0]?.ref).toBe('dev-server');
  });

  it('returns a ~200-char snippet around the first match', () => {
    const hit = searchPages(PAGES, 'deployment')[0];
    expect(hit?.ref).toBe('long-notes');
    expect(hit?.snippet).toContain('deployment');
    expect(hit?.snippet.startsWith('…')).toBe(true);
    expect(hit?.snippet.endsWith('…')).toBe(true);
    expect((hit?.snippet.length ?? 0)).toBeLessThanOrEqual(205);
    expect((hit?.snippet.length ?? 0)).toBeGreaterThan(150);
  });

  it('returns the whole body as snippet when short', () => {
    expect(searchPages(PAGES, 'docker')[0]?.snippet).toBe(PAGES[1]?.body);
  });

  it('respects the limit', () => {
    expect(searchPages(PAGES, 'the', 2)).toHaveLength(2);
    expect(searchPages(PAGES, 'the', 0)).toEqual([]);
  });

  it('returns [] for empty queries, no pages, or no matches', () => {
    expect(searchPages(PAGES, '')).toEqual([]);
    expect(searchPages(PAGES, '  ...  ')).toEqual([]);
    expect(searchPages([], 'docker')).toEqual([]);
    expect(searchPages(PAGES, 'kubernetes')).toEqual([]);
  });

  it('tolerates duplicate page names (first wins)', () => {
    const pages = [page('dup', 'First', 'alpha content'), page('dup', 'Second', 'alpha content too')];
    const hits = searchPages(pages, 'alpha');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('First');
  });
});

function msg(idx: number, role: TranscriptMessage['role'], parts: TranscriptPart[] | string, session = 's1'): TranscriptMessage {
  return {
    harness: 'claude-code',
    session,
    idx,
    role,
    parts: typeof parts === 'string' ? [{ kind: 'text', text: parts }] : parts,
  };
}

const MSGS: TranscriptMessage[] = [
  msg(0, 'user', 'Start the dev server please.'),
  msg(1, 'assistant', 'The dev server runs on port 3000.'),
  msg(2, 'tool', [{ kind: 'tool_result', tool: 'Bash', text: 'VITE ready\n  ➜  Local: http://localhost:5173/\n  listening on :5173' }]),
  msg(3, 'user', "No, it's 5173, not 3000. Remember the port."),
  msg(4, 'assistant', [{ kind: 'tool_call', tool: 'Edit', text: '{"file":"README.md"}' }]),
  msg(5, 'assistant', 'This report is unrelated.'),
  msg(6, 'user', 'port port port port', 's2'),
];

describe('searchTranscripts', () => {
  it('returns hits with harness:session#idx refs and single-message sources', () => {
    const hits = searchTranscripts(MSGS, '5173');
    expect(hits.map((h) => h.ref)).toEqual(['claude-code:s1#2', 'claude-code:s1#3']);
    expect(hits[0]?.kind).toBe('transcript');
    expect(hits[0]?.sources).toEqual([{ harness: 'claude-code', session: 's1', msgs: '2' }]);
    expect(hits[0]?.title).toBeUndefined();
  });

  it('ranks messages containing all terms first', () => {
    const hits = searchTranscripts(MSGS, 'port 5173');
    expect(hits[0]?.ref).toBe('claude-code:s1#3');
  });

  it('gives a phrase bonus', () => {
    const hits = searchTranscripts(MSGS, 'dev server');
    expect(hits.slice(0, 2).map((h) => h.ref).sort()).toEqual(['claude-code:s1#0', 'claude-code:s1#1']);
    expect(hits[0]?.score).toBeGreaterThan(2);
  });

  it('matches at word starts only ("port" does not match "report")', () => {
    const refs = searchTranscripts(MSGS, 'port').map((h) => h.ref);
    expect(refs).not.toContain('claude-code:s1#5');
    expect(refs).toContain('claude-code:s2#6');
  });

  it('weights repeated occurrences logarithmically', () => {
    const hits = searchTranscripts(MSGS, 'port');
    expect(hits[0]?.ref).toBe('claude-code:s2#6');
  });

  it('searches tool call names and tool result text', () => {
    expect(searchTranscripts(MSGS, 'Edit').map((h) => h.ref)).toContain('claude-code:s1#4');
    expect(searchTranscripts(MSGS, 'VITE')[0]?.ref).toBe('claude-code:s1#2');
  });

  it('is case-insensitive', () => {
    expect(searchTranscripts(MSGS, 'REMEMBER')[0]?.ref).toBe('claude-code:s1#3');
  });

  it('builds a windowed snippet around the first match for long messages', () => {
    const long = msg(9, 'tool', [
      { kind: 'tool_result', tool: 'Bash', text: `${'noise '.repeat(100)}FATAL: ECONNREFUSED 127.0.0.1:5432 ${'noise '.repeat(100)}` },
    ]);
    const hit = searchTranscripts([long], 'econnrefused')[0];
    expect(hit?.snippet).toContain('ECONNREFUSED');
    expect((hit?.snippet.length ?? 0)).toBeLessThanOrEqual(205);
    expect(hit?.snippet.startsWith('…')).toBe(true);
  });

  it('respects the limit and handles empty input', () => {
    expect(searchTranscripts(MSGS, 'port', 1)).toHaveLength(1);
    expect(searchTranscripts(MSGS, '')).toEqual([]);
    expect(searchTranscripts([], 'port')).toEqual([]);
    expect(searchTranscripts(MSGS, 'kubernetes')).toEqual([]);
  });

  it('handles regex metacharacters in queries', () => {
    expect(() => searchTranscripts(MSGS, 'a.*(b[c')).not.toThrow();
    expect(searchTranscripts(MSGS, 'it’s (5173)').length).toBeGreaterThan(0);
  });
});
