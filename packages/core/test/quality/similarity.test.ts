import { describe, expect, it } from 'vitest';
import { normalizeForQuote, similarity } from '../../src/quality/similarity.ts';

describe('normalizeForQuote', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(normalizeForQuote('  Listening   on\n\t:5173  ')).toBe('listening on :5173');
  });

  it('maps typographic quotes and dashes to ASCII', () => {
    expect(normalizeForQuote('“Don’t” — use ‘pnpm’ – not npm − 1')).toBe(
      `"don't" - use 'pnpm' - not npm - 1`,
    );
  });

  it('applies NFKC (full-width, ligatures, non-breaking spaces)', () => {
    expect(normalizeForQuote('ＰＯＲＴ 5173')).toBe('port 5173');
    expect(normalizeForQuote('ﬁle')).toBe('file');
    expect(normalizeForQuote('é')).toBe('é');
  });

  it('removes zero-width characters and BOM', () => {
    expect(normalizeForQuote('﻿no​, it’s 5173')).toBe("no, it's 5173");
  });

  it('keeps backticks and other punctuation intact', () => {
    expect(normalizeForQuote('Run `npm test` -- --watch=false')).toBe('run `npm test` -- --watch=false');
  });

  it('treats CRLF and LF the same', () => {
    expect(normalizeForQuote('a\r\nb')).toBe(normalizeForQuote('a\nb'));
  });

  it('is deterministic', () => {
    const s = 'Mixed “Quotes”—and Spaces';
    expect(normalizeForQuote(s)).toBe(normalizeForQuote(s));
  });

  it('is idempotent on a varied corpus', () => {
    const corpus = [
      '',
      '   ',
      'plain ascii text',
      'ÅNGSTRÖM İstanbul ǅ ß ẞ',
      '① ⁵ ½ Ω Å',
      'ＡＢＣ 　 full-width　space',
      'quotes „‟″‶ dashes ‐‑‒﹘－',
      'combining ä ó İ̇',
      'emoji 🙂 and 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 math letters',
      'tabs\tand\r\nnewlines and separators',
      '­ soft hyphen and ⁠ word joiner',
      'error TS2345: Argument of type ‘string’ is not assignable',
    ];
    for (const s of corpus) {
      const once = normalizeForQuote(s);
      expect(normalizeForQuote(once)).toBe(once);
    }
  });

  it('is idempotent on pseudo-random unicode strings', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const ranges: [number, number][] = [
      [0x20, 0x7e],
      [0xa0, 0x24f],
      [0x300, 0x36f],
      [0x2000, 0x206f],
      [0x2100, 0x218f],
      [0x2460, 0x24ff],
      [0x3000, 0x303f],
      [0xfb00, 0xfb06],
      [0xff01, 0xff5e],
    ];
    for (let i = 0; i < 300; i++) {
      let s = '';
      const len = 1 + (rand() % 30);
      for (let j = 0; j < len; j++) {
        const [lo, hi] = ranges[rand() % ranges.length] as [number, number];
        s += String.fromCodePoint(lo + (rand() % (hi - lo + 1)));
      }
      const once = normalizeForQuote(s);
      expect(normalizeForQuote(once), JSON.stringify(s)).toBe(once);
    }
  });
});

const PAGE = [
  '# Dev server',
  '',
  'The dev server is started with `npm run dev` and listens on port 5173.',
  'Hot reload is handled by Vite; restart is rarely needed.',
  'Environment variables are read from `.env.local` at startup.',
  'The API proxy forwards `/api` requests to the backend on port 8080.',
  'Trap: `npm start` builds for production and is slow; use `npm run dev` instead.',
  'Related: [[ci-pipeline]], [[env-vars]].',
].join('\n');

describe('similarity', () => {
  it('is 1 for identical texts', () => {
    expect(similarity(PAGE, PAGE)).toBe(1);
    expect(similarity('a b c', 'a b c')).toBe(1);
  });

  it('is 1 for texts that differ only in case, quotes and whitespace', () => {
    expect(similarity('Use “pnpm”  here', 'use "pnpm" here')).toBe(1);
  });

  it('is 1 for two empty strings and 0 when only one is empty', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('   \n ', '')).toBe(1);
    expect(similarity('', 'something')).toBe(0);
    expect(similarity('something', '')).toBe(0);
  });

  it('is ~0 for disjoint texts', () => {
    expect(similarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
    expect(similarity(PAGE, 'Quarterly revenue grew while churn fell sharply.')).toBeLessThan(0.05);
  });

  it('is high (> 0.7) for a small edit of a page', () => {
    const edited = PAGE.replace('port 5173', 'port 5174');
    const s = similarity(PAGE, edited);
    expect(s).toBeGreaterThan(0.7);
    expect(s).toBeLessThan(1);
  });

  it('is high (> 0.7) for a one-word edit in a single long sentence', () => {
    const a = 'The dev server is started with npm run dev and it listens on port 3000 by default in this repo';
    const b = 'The dev server is started with npm run dev and it listens on port 5173 by default in this repo';
    expect(similarity(a, b)).toBeGreaterThan(0.7);
  });

  it('is high when a line is appended', () => {
    expect(similarity(PAGE, `${PAGE}\nAlso: the preview server uses port 4173.`)).toBeGreaterThan(0.7);
  });

  it('is low (< 0.5) for a rewrite of the same subject', () => {
    const rewrite = [
      '# Local development',
      '',
      'Start everything via docker compose; the frontend container exposes 3000.',
      'Configuration comes from compose overrides rather than dotfiles.',
      'Backend calls go straight to the gateway container.',
    ].join('\n');
    expect(similarity(PAGE, rewrite)).toBeLessThan(0.5);
  });

  it('is symmetric and within [0, 1]', () => {
    const pairs: [string, string][] = [
      [PAGE, PAGE.slice(0, 120)],
      ['a b c d', 'c d e f'],
      ['x\ny\nz', 'z\ny\nx'],
    ];
    for (const [a, b] of pairs) {
      const ab = similarity(a, b);
      expect(ab).toBeCloseTo(similarity(b, a), 10);
      expect(ab).toBeGreaterThanOrEqual(0);
      expect(ab).toBeLessThanOrEqual(1);
    }
  });

  it('rewards unchanged lines: reordered lines score 1, same words in new lines score lower', () => {
    expect(similarity('one two\nthree four\nfive six', 'five six\none two\nthree four')).toBe(1);
    expect(similarity('one two\nthree four\nfive six', 'one three\nfive two\nfour six')).toBeCloseTo(0.6, 5);
  });

  it('treats CRLF like LF', () => {
    expect(similarity(PAGE, PAGE.replace(/\n/g, '\r\n'))).toBe(1);
  });
});
