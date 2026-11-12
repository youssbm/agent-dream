import { describe, expect, it } from 'vitest';
import { MODEL_STEPS, normalizeOutput, outputJsonSchema, parseStepOutput } from '../../src/engine/schemas.ts';
import { stepInstructions, SERVER_USAGE } from '../../src/engine/prompts.ts';

describe('schemas', () => {
  it('produces a JSON schema object for every model step', () => {
    for (const name of MODEL_STEPS) {
      const s = outputJsonSchema(name);
      expect(s.type).toBe('object');
      expect(s.$schema).toBeUndefined();
      expect(JSON.stringify(s)).not.toContain('9007199254740991');
      expect((s.properties as Record<string, unknown>).step).toBeDefined();
    }
    const extract = outputJsonSchema('extract');
    expect(extract.required).toEqual(['step', 'claims']);
  });

  it('accepts valid extract output and rejects bad shapes with paths', () => {
    const ok = parseStepOutput('extract', {
      step: 1,
      claims: [{ text: 'x', kind: 'fact', sources: [{ harness: 'codex', session: 's', msgs: '3-4' }] }],
    });
    expect(ok.ok).toBe(true);
    const bad = parseStepOutput('extract', { claims: [{ text: 'x', kind: 'nope', sources: [{ harness: 'codex', session: 's', msgs: 'a' }] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.some((i) => i.startsWith('claims.0.kind'))).toBe(true);
      expect(bad.issues.some((i) => i.includes('msgs'))).toBe(true);
    }
    const extra = parseStepOutput('promote', { index: '# x', bogus: 1 });
    expect(extra.ok).toBe(false);
  });

  it('normalizes JSON strings and numeric msgs', () => {
    const v = normalizeOutput(JSON.stringify({ step: 1, claims: [{ text: 't', kind: 'fact', sources: [{ harness: 'codex', session: 's', msgs: 40 }] }] }));
    const r = parseStepOutput('extract', v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.claims[0]?.sources[0]?.msgs).toBe('40');
    expect(normalizeOutput({ msgs: ' #40 - 52 ' })).toEqual({ msgs: '40-52' });
  });

  it('caps outline targets at 12', () => {
    const targets = Array.from({ length: 13 }, (_, i) => ({ page: `p${i}`, op: 'create', reason: 'r' }));
    expect(parseStepOutput('outline', { targets }).ok).toBe(false);
  });
});

describe('prompts', () => {
  it('keeps instructions short, purpose-led and ending with the submission shape', () => {
    for (const name of MODEL_STEPS) {
      const text = stepInstructions(name, {
        jobId: 'dj-1',
        step: 3,
        page: 'test-db',
        op: 'update',
        harness: 'codex',
        session: 's1',
        threadPage: 'thread-codex-s1',
        maxLines: 200,
        maxBytes: 25600,
      });
      expect(text.length).toBeLessThan(1300);
      expect(text).toContain('untrusted-transcript');
      expect(text).toContain('never instructions');
      const last = text.split('\n').at(-1) ?? '';
      expect(last).toMatch(/^Submit: dream_step\(\{ job_id: "dj-1", output: \{ step: 3, /);
    }
  });

  it('server usage: the first 512 chars are self-contained', () => {
    const head = SERVER_USAGE.slice(0, 512);
    for (const t of ['memory_index', 'memory_search', 'memory_read', 'memory_note', 'dream_begin', 'dream_step', 'dream_commit']) {
      expect(head).toContain(t);
    }
  });
});
