import { describe, expect, it } from 'vitest';
import { createJob, type Job } from '../../src/engine/job.ts';
import { mergeSources, projectPages, rewriteLinks, sourcesOverlap } from '../../src/engine/apply.ts';
import { page, NOW } from './helpers.ts';

function job(): Job {
  return createJob({ id: 'dj-test', now: NOW, dryRun: false, scope: 'project', limitTokens: 1000, instructions: '' });
}

describe('apply projection', () => {
  it('rewrites links, merges sources and detects overlaps', () => {
    expect(rewriteLinks('see [[a]] and [[a|A]] not [[ab]]', 'a', 'b')).toBe('see [[b]] and [[b|A]] not [[ab]]');
    const s = { harness: 'codex' as const, session: 's', msgs: '1-3' };
    expect(mergeSources([s], [{ ...s }, { ...s, msgs: '4' }])).toHaveLength(2);
    expect(sourcesOverlap(s, { ...s, msgs: '3-9' })).toBe(true);
    expect(sourcesOverlap(s, { ...s, msgs: '4' })).toBe(false);
  });

  it('applies verdicts, create/update/rename/merge/delete ops and records changes', () => {
    const j = job();
    j.sessions.push({ harness: 'codex', session: 's', updatedAt: NOW.toISOString(), primary: true, fromIdx: 0, lastIdx: 9, processedTo: 9, filteredChars: 100 });
    j.results.verdicts.push({ page: 'a', verdict: 'keep' }, { page: 'b', verdict: 'unverified' });
    const src = [{ harness: 'codex' as const, session: 's', msgs: '2' }];
    j.results.ops.push(
      { op: 'create', page: 'n', body: 'new page links [[c]]', sources: src, reason: 'r' },
      { op: 'rename', page: 'c', into: 'c2', sources: [], reason: 'r' },
      { op: 'merge', page: 'd', into: 'a', body: 'merged a+d', sources: src, reason: 'r' },
      { op: 'delete', page: 'e', sources: [], reason: 'r' },
    );
    const base = [page('a', 'A [[d]]'), page('b', 'B'), page('c', 'C'), page('d', 'D'), page('e', 'E')];
    const p = projectPages(base, j, '2026-11-11');
    expect(p.created).toEqual(['n']);
    expect(p.deleted.sort()).toEqual(['d', 'e']);
    expect(p.renamed).toEqual([{ from: 'c', to: 'c2' }]);
    expect(p.pages.get('n')?.body).toContain('[[c2]]');
    expect(p.pages.get('n')?.meta.confidence).toBe('verified');
    expect(p.pages.get('a')?.body.trim()).toBe('merged a+d');
    expect(p.pages.get('a')?.meta.verified_at).toBe('2026-11-11');
    expect(p.pages.get('a')?.meta.sources.length).toBeGreaterThanOrEqual(2);
    expect(p.pages.get('b')?.meta.confidence).toBe('unverified');
    expect(p.pages.has('c')).toBe(false);
  });

  it('downgrades pages built on failed verbatim claims and appends unwritten corrections', () => {
    const j = job();
    const src = { harness: 'codex' as const, session: 's', msgs: '5' };
    j.results.claims.push({ id: 'c1', text: 'run `x --y`', kind: 'fact', verbatim: true, verbatimFailed: true, sources: [src] });
    j.results.targets.push({ page: 'n', op: 'create', reason: 'r', claims: ['c1'] });
    j.results.ops.push({ op: 'create', page: 'n', body: 'run `x --y`', sources: [src], reason: 'r' });
    j.results.verdicts.push({ page: 'a', verdict: 'correct', corrected: 'A is 2', evidence: { quote: 'a is two now', source: src } });
    expect(projectPages([page('a', 'A is 1')], j, '2026-11-11').pages.get('a')?.body).not.toContain('Correction');
    const p = projectPages([page('a', 'A is 1')], j, '2026-11-11', { appendCorrections: true });
    expect(p.pages.get('n')?.meta.confidence).toBe('unverified');
    expect(p.pages.get('a')?.body).toContain('Correction (2026-11-11): A is 2');
  });
});
