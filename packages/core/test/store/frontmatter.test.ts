import { describe, expect, it } from 'vitest';
import {
  extractLinks,
  isReservedPageName,
  isValidPageName,
  parsePage,
  serializePage,
  slugify,
  threadPageName,
} from '../../src/store/frontmatter.ts';
import type { Page } from '../../src/types.ts';

const SAMPLE = [
  '---',
  'title: Test database setup',
  'kind: howto',
  'volatile: true',
  'confidence: verified',
  'verified_at: 2026-11-11',
  'sources:',
  '  - { harness: opencode, session: ses_123, msgs: "40-52" }',
  '  - { harness: claude-code, session: 0f9c-uuid, msgs: "7" }',
  'links: [ci-pipeline, env-vars]',
  '---',
  '',
  'Run `docker compose up db` before tests. See [[ci-pipeline]] and [[env-vars|the env page]].',
  '',
].join('\n');

describe('parsePage', () => {
  it('parses all fields', () => {
    const p = parsePage('test-db-setup', SAMPLE);
    expect(p.name).toBe('test-db-setup');
    expect(p.meta).toEqual({
      title: 'Test database setup',
      kind: 'howto',
      volatile: true,
      confidence: 'verified',
      verified_at: '2026-11-11',
      sources: [
        { harness: 'opencode', session: 'ses_123', msgs: '40-52' },
        { harness: 'claude-code', session: '0f9c-uuid', msgs: '7' },
      ],
      links: ['ci-pipeline', 'env-vars'],
    });
    expect(p.body).toBe('Run `docker compose up db` before tests. See [[ci-pipeline]] and [[env-vars|the env page]].');
  });

  it('tolerates CRLF and a BOM', () => {
    const p = parsePage('test-db-setup', '﻿' + SAMPLE.replace(/\n/g, '\r\n'));
    const q = parsePage('test-db-setup', SAMPLE);
    expect(p).toEqual(q);
    expect(p.body).not.toContain('\r');
  });

  it('applies defaults when front matter is missing', () => {
    const p = parsePage('no-fm', '# Heading here\n\nText with [[a]] and [[b]] and [[a]].\n');
    expect(p.meta).toEqual({
      title: 'Heading here',
      kind: 'fact',
      volatile: false,
      confidence: 'unverified',
      sources: [],
      links: ['a', 'b'],
    });
    expect(p.body).toBe('# Heading here\n\nText with [[a]] and [[b]] and [[a]].');
  });

  it('falls back to the name as title and ignores invalid fields', () => {
    const md = [
      '---',
      'kind: banana',
      'confidence: maybe',
      'volatile: "yes"',
      'verified_at: not-a-date',
      'sources:',
      '  - { harness: other, session: x, msgs: "1" }',
      '  - { harness: codex, session: s1 }',
      '  - { harness: codex, session: s1, msgs: 3 }',
      '  - just a string',
      '---',
      'Body.',
    ].join('\n');
    const p = parsePage('my-page', md);
    expect(p.meta.title).toBe('my-page');
    expect(p.meta.kind).toBe('fact');
    expect(p.meta.confidence).toBe('unverified');
    expect(p.meta.volatile).toBe(true);
    expect(p.meta.verified_at).toBeUndefined();
    expect(p.meta.sources).toEqual([{ harness: 'codex', session: 's1', msgs: '3' }]);
    expect(p.meta.links).toEqual([]);
  });

  it('survives broken YAML', () => {
    const p = parsePage('broken', '---\ntitle: [unclosed\n---\nStill a body [[x]]\n');
    expect(p.meta.title).toBe('broken');
    expect(p.body).toBe('Still a body [[x]]');
    expect(p.meta.links).toEqual(['x']);
  });

  it('treats unterminated front matter as body', () => {
    const p = parsePage('p', '---\ntitle: x\nno end');
    expect(p.meta.title).toBe('p');
    expect(p.body).toBe('---\ntitle: x\nno end');
  });

  it('accepts thread kind', () => {
    expect(parsePage('t', '---\nkind: thread\n---\nx').meta.kind).toBe('thread');
  });
});

describe('serializePage', () => {
  const page: Page = {
    name: 'test-db-setup',
    meta: {
      title: 'Test database setup',
      kind: 'howto',
      volatile: false,
      confidence: 'verified',
      verified_at: '2026-11-11',
      sources: [{ harness: 'opencode', session: 'ses_123', msgs: '40-52' }],
      links: ['stale-link'],
    },
    body: 'See [[ci-pipeline]] and [[env-vars]].',
  };

  it('writes keys in fixed order with flow-style sources and recomputed links', () => {
    const md = serializePage(page);
    expect(md).toBe(
      [
        '---',
        'title: Test database setup',
        'kind: howto',
        'volatile: false',
        'confidence: verified',
        'verified_at: 2026-11-11',
        'sources:',
        '  - { harness: opencode, session: ses_123, msgs: "40-52" }',
        'links: [ ci-pipeline, env-vars ]',
        '---',
        '',
        'See [[ci-pipeline]] and [[env-vars]].',
        '',
      ].join('\n'),
    );
  });

  it('round-trips', () => {
    const md = serializePage(page);
    const back = parsePage(page.name, md);
    expect(back.body).toBe(page.body);
    expect(back.meta).toEqual({ ...page.meta, links: ['ci-pipeline', 'env-vars'] });
    expect(serializePage(back)).toBe(md);
  });

  it('round-trips CRLF input to identical output', () => {
    const md = serializePage(page);
    expect(serializePage(parsePage(page.name, md.replace(/\n/g, '\r\n')))).toBe(md);
  });

  it('quotes tricky scalars safely', () => {
    const p: Page = {
      name: 'x',
      meta: {
        title: 'Colon: "quotes" # and hash',
        kind: 'fact',
        volatile: false,
        confidence: 'unverified',
        sources: [{ harness: 'codex', session: '12345', msgs: '7' }],
        links: [],
      },
      body: 'b',
    };
    const md = serializePage(p);
    expect(md).not.toContain('verified_at');
    expect(md).toContain('sources:\n  - { harness: codex, session: "12345", msgs: "7" }');
    const back = parsePage('x', md);
    expect(back.meta.title).toBe(p.meta.title);
    expect(back.meta.sources).toEqual(p.meta.sources);
  });

  it('handles empty sources, links and body', () => {
    const md = serializePage({
      name: 'e',
      meta: { title: '', kind: 'fact', volatile: false, confidence: 'unverified', sources: [], links: [] },
      body: '',
    });
    expect(md).toBe('---\ntitle: e\nkind: fact\nvolatile: false\nconfidence: unverified\nsources: []\nlinks: []\n---\n');
    expect(md.endsWith('\n')).toBe(true);
  });
});

describe('extractLinks', () => {
  it('handles labels, order and uniqueness', () => {
    expect(extractLinks('[[b]] then [[a|label]] then [[b|again]] and [[ c ]]')).toEqual(['b', 'a', 'c']);
  });
  it('ignores code', () => {
    const body = 'Use [[real]].\n```bash\nif [[ -f x ]]; then echo; fi\n```\nInline `[[ -z "$a" ]]` too. [[after]]';
    expect(extractLinks(body)).toEqual(['real', 'after']);
  });
  it('ignores empty and malformed links', () => {
    expect(extractLinks('[[]] [[ ]] [x] [[a\nb]]')).toEqual([]);
  });
});

describe('page names', () => {
  it('validates names', () => {
    for (const ok of ['a', 'test-db-setup', 'a1', '0', 'x'.repeat(80), 'thread-codex-abc']) {
      expect(isValidPageName(ok), ok).toBe(true);
    }
    for (const bad of ['', '-a', 'a-', 'A', 'a_b', 'a b', 'x'.repeat(81), 'a/b', '../x', 'é']) {
      expect(isValidPageName(bad), bad).toBe(false);
    }
  });

  it('slugifies text into valid names', () => {
    expect(slugify('Test DB: Setup!')).toBe('test-db-setup');
    expect(slugify('  Café   crème ')).toBe('cafe-creme');
    expect(slugify('***')).toBe('page');
    const long = slugify('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(isValidPageName(long)).toBe(true);
  });

  it('rejects Windows reserved device names on every platform', () => {
    for (const bad of ['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9']) {
      expect(isValidPageName(bad), bad).toBe(false);
      expect(isReservedPageName(bad.toUpperCase()), bad).toBe(true);
    }
    for (const ok of ['console', 'con-page', 'com10', 'lpt', 'auxiliary', 'nul1', 'com', 'a-con']) {
      expect(isValidPageName(ok), ok).toBe(true);
    }
    expect(slugify('CON')).toBe('con-page');
    expect(slugify('Lpt1')).toBe('lpt1-page');
    expect(isValidPageName(slugify('aux'))).toBe(true);
  });

  it('thread page names: sanitized ids get a stable hash suffix so distinct ids never collide', () => {
    const dot = threadPageName('codex', 'a.b');
    const dash = threadPageName('codex', 'a-b');
    expect(dash).toBe('thread-codex-a-b'); // already clean: unchanged
    expect(dot).toMatch(/^thread-codex-a-b-[0-9a-f]{6}$/);
    expect(dot).not.toBe(dash);
    expect(threadPageName('codex', 'a.b')).toBe(dot); // stable
    expect(threadPageName('codex', 'A_B')).not.toBe(dot);
    for (const n of [dot, dash, threadPageName('opencode', 'ses_X'), threadPageName('codex', '')]) {
      expect(isValidPageName(n), n).toBe(true);
    }
    // Long sanitized ids that differ only past the truncation point stay distinct and ≤ 80 chars.
    const l1 = threadPageName('codex', 'X'.repeat(200) + '.1');
    const l2 = threadPageName('codex', 'X'.repeat(200) + '.2');
    expect(l1.length).toBeLessThanOrEqual(80);
    expect(isValidPageName(l1)).toBe(true);
    expect(l1).not.toBe(l2);
  });

  it('builds thread page names', () => {
    expect(threadPageName('opencode', 'ses_ABC123')).toMatch(/^thread-opencode-ses-abc123-[0-9a-f]{6}$/);
    expect(threadPageName('claude-code', '0f9c1e2a-1111-2222-3333-444455556666')).toBe(
      'thread-claude-code-0f9c1e2a-1111-2222-3333-444455556666',
    );
    const a = threadPageName('codex', 'x'.repeat(200));
    const b = threadPageName('codex', 'x'.repeat(199) + 'y');
    expect(a.length).toBeLessThanOrEqual(80);
    expect(isValidPageName(a)).toBe(true);
    expect(isValidPageName(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(threadPageName('codex', 'x'.repeat(200))).toBe(a);
  });
});
