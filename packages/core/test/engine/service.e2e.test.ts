import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DreamService } from '../../src/engine/service.ts';
import { MemoryStore } from '../../src/store/store.ts';
import { threadPageName } from '../../src/store/frontmatter.ts';
import type { StepResponse } from '../../src/types.ts';
import {
  drive,
  FakeAdapter,
  messages,
  now,
  page,
  plantedStory,
  seedPages,
  sessionInfo,
  storyScript,
  tempProject,
  THREAD_BODY,
  verifyPages,
  type TempProject,
} from './helpers.ts';

const SAVED = 'Memory saved. You can now /compact or start a new session; the index loads via memory_index.';

let proj: TempProject;
beforeEach(async () => {
  proj = await tempProject();
});
afterEach(async () => {
  await proj.cleanup();
});

function storyAdapter(dir: string, session = 'sess-a'): FakeAdapter {
  return new FakeAdapter('claude-code').add({
    info: sessionInfo('claude-code', session, dir, '2026-11-11T11:50:00.000Z'),
    messages: plantedStory('claude-code', session),
  });
}

async function seedWrongPort(dir: string): Promise<MemoryStore> {
  const store = new MemoryStore(dir, { now });
  await store.init();
  await seedPages(dir, [page('dev-server', 'The dev server runs on port `3000`.', { title: 'Dev server', volatile: true })]);
  return store;
}

function svc(dir: string, adapters: FakeAdapter[]): DreamService {
  return new DreamService({ projectDir: dir, adapters, now });
}

const read = (dir: string, rel: string): Promise<string> => readFile(path.join(dir, '.dream', rel), 'utf8');

describe('DreamService end to end', () => {
  it('runs begin → steps → commit and corrects the planted error with checked evidence', async () => {
    const store = await seedWrongPort(proj.dir);
    const service = svc(proj.dir, [storyAdapter(proj.dir)]);
    await service.memoryNote('The staging deploy needs VPN access.');

    const first = await service.dreamBegin({});
    expect(first.status).toBe('step');
    expect(first.step?.name).toBe('extract');
    expect(first.step?.index).toBe(1);
    expect(first.step?.input).toContain('<untrusted-transcript');
    expect(first.step?.input).toContain('The staging deploy needs VPN access.');
    expect(first.step?.input).toContain('Project guidance (dream.md)');
    expect(first.message).toContain('dream_step');
    expect(first.budget.usedTokens).toBeGreaterThan(0);

    const { last, seen } = await drive(service, first, storyScript());
    const names = seen.map((s) => s.step?.name).filter(Boolean);
    expect(names).toEqual(['extract', 'verify', 'patterns', 'outline', 'write_page', 'thread_state', 'promote']);
    const verify = seen.find((s) => s.step?.name === 'verify') as StepResponse;
    expect(verifyPages(verify)).toEqual(['dev-server']);
    expect(verify.step?.input).toContain('listening on :5173');
    expect(last.status).toBe('ready_to_commit');
    expect(last.message).toContain('dream_commit');
    // Budget = sum of handed-out inputs.
    const sum = seen.filter((s) => s.step).reduce((n, s) => n + Math.ceil((s.step?.input.length ?? 0) / 4), 0);
    expect(last.budget.usedTokens).toBe(sum);

    const result = await service.dreamCommit(first.jobId);
    expect(result.outcome).toBe('applied');
    expect(result.message.endsWith(SAVED)).toBe(true);
    expect(result.summary.updated).toContain('dev-server');
    expect(result.summary.corrections).toEqual([
      expect.objectContaining({ page: 'dev-server', verdict: 'correct', quote: 'listening on :5173' }),
    ]);
    const thread = threadPageName('claude-code', 'sess-a');
    expect(result.threadPage).toBe(thread);
    expect(result.summary.created).toContain(thread);

    const devPage = await store.readPage('dev-server');
    expect(devPage?.body).toContain('5173');
    expect(devPage?.body).not.toContain('port `3000`');
    expect(devPage?.meta.confidence).toBe('verified');
    expect(devPage?.meta.verified_at).toBe('2026-11-11');
    expect(devPage?.meta.sources.map((s) => `${s.session}#${s.msgs}`)).toEqual(expect.arrayContaining(['old-session#1-2', 'sess-a#2', 'sess-a#1-4']));
    const threadPage = await store.readPage(thread);
    expect(threadPage?.meta.kind).toBe('thread');
    expect(threadPage?.body).toContain('## Failed approaches and traps');
    expect(threadPage?.meta.sources).toEqual([{ harness: 'claude-code', session: 'sess-a', msgs: '0-5' }]);

    expect(await store.readIndex()).toContain(`[[${thread}]]`);
    const state = await store.readState();
    expect(state.watermarks['claude-code:sess-a']).toBe(5);
    expect(state.sourceChars).toBeGreaterThan(0);
    expect(state.lastRunAt).toBe('2026-11-11T12:00:00.000Z');
    expect(await store.readInbox()).toEqual([]);
    const log = await read(proj.dir, 'log.md');
    expect(log).toContain('dev-server: correct');
    expect(log).toContain('listening on :5173');
    expect(await store.listJobs()).toEqual([]);
    const runs = await store.listRuns();
    expect(runs[0]?.message).toMatch(/^dream: /);

    // Nothing new afterwards.
    const again = await svc(proj.dir, [storyAdapter(proj.dir)]).dreamBegin({});
    expect(again.status).toBe('done');
    expect(again.message).toContain('Nothing new');

    // Rollback restores the wrong page.
    await service.dreamRollback();
    expect((await store.readPage('dev-server'))?.body).toContain('3000');
  });

  it('rejects bad schema, hallucinated evidence and wrong targets without advancing', async () => {
    await seedWrongPort(proj.dir);
    const service = svc(proj.dir, [storyAdapter(proj.dir)]);
    const first = await service.dreamBegin({});
    const noStep = await service.dreamStep(first.jobId, { claims: [] });
    expect(noStep.rejection?.reason).toContain('output.step is missing');
    expect(noStep.rejection?.details?.[0]).toContain('"step": 1');
    expect(noStep.step?.index).toBe(1);
    const bad = await service.dreamStep(first.jobId, { step: 1, claims: 'nope' });
    expect(bad.rejection?.reason).toContain('outputSchema');
    expect(bad.step?.index).toBe(1);
    expect(bad.message).toContain('rejected');

    const badSource = await service.dreamStep(first.jobId, {
      step: 1,
      claims: [{ text: 'x', kind: 'fact', sources: [{ harness: 'codex', session: 'nope', msgs: '1' }] }],
    });
    expect(badSource.rejection?.details?.[0]).toContain('not part of this job');
    const pastEnd = await service.dreamStep(first.jobId, {
      step: 1,
      claims: [{ text: 'x', kind: 'fact', sources: [{ harness: 'claude-code', session: 'sess-a', msgs: '3-99' }] }],
    });
    expect(pastEnd.rejection?.details?.[0]).toContain('past the end');

    const script = storyScript();
    const verify = await service.dreamStep(first.jobId, { step: 1, ...(script.extract?.(first) as object) });
    expect(verify.step?.name).toBe('verify');

    const at = (o: object): object => ({ step: verify.step?.index, ...o });
    const hallucinated = await service.dreamStep(first.jobId, at({
      verdicts: [
        {
          page: 'dev-server',
          verdict: 'correct',
          corrected: 'The dev server runs on port 8080.',
          evidence: { quote: 'the server is listening on port 8080', source: { harness: 'claude-code', session: 'sess-a', msgs: '2' } },
        },
      ],
    }));
    expect(hallucinated.rejection?.details?.join(' ')).toContain('evidence quote not found');
    expect(hallucinated.step?.index).toBe(verify.step?.index);

    const noEvidence = await service.dreamStep(first.jobId, at({ verdicts: [{ page: 'dev-server', verdict: 'delete' }] }));
    expect(noEvidence.rejection?.details?.join(' ')).toContain('needs evidence');
    const missing = await service.dreamStep(first.jobId, at({ verdicts: [] }));
    expect(missing.rejection?.details?.join(' ')).toContain('missing verdicts');

    const ok = await service.dreamStep(first.jobId, at(script.verify?.(verify) as object));
    expect(ok.rejection).toBeUndefined();
    expect(ok.step?.name).toBe('patterns');
    const outline = await service.dreamStep(first.jobId, { step: ok.step?.index, patterns: [] });
    expect(outline.step?.name).toBe('outline');
    const oi = outline.step?.index;
    const badOutline = await service.dreamStep(first.jobId, {
      step: oi,
      targets: [
        { page: 'Bad Name', op: 'create', reason: 'r' },
        { page: 'missing', op: 'update', reason: 'r' },
        { page: 'thread-x', op: 'create', reason: 'r' },
        { page: 'dev-server', op: 'create', reason: 'r', claims: ['c99'] },
      ],
    });
    const details = badOutline.rejection?.details?.join('\n') ?? '';
    expect(details).toContain('not a valid page name');
    expect(details).toContain('does not exist');
    expect(details).toContain('reserved for thread pages');
    expect(details).toContain('already exists');
    expect(details).toContain('unknown claim ids c99');

    // Outline omits the corrected page: the server adds it.
    const write = await service.dreamStep(first.jobId, { step: oi, targets: [{ page: 'dev-workflow', op: 'create', reason: 'prefs', claims: ['c2'] }] });
    expect(write.message).toContain('Added 1 target');
    expect(write.step?.label).toContain('dev-server');
    const wi = write.step?.index;
    const wrongPage = await service.dreamStep(first.jobId, {
      step: wi,
      op: { op: 'update', page: 'dev-workflow', body: 'x', sources: [], reason: 'r' },
    });
    expect(wrongPage.rejection?.details?.[0]).toContain('must be "dev-server"');
    const frontMatter = await service.dreamStep(first.jobId, {
      step: wi,
      op: { op: 'update', page: 'dev-server', body: '---\ntitle: x\n---\nbody', sources: [], reason: 'r' },
    });
    expect(frontMatter.rejection?.details?.[0]).toContain('front matter');
  });

  it('promote enforces the index cap, links and the active thread link', async () => {
    await seedWrongPort(proj.dir);
    const service = svc(proj.dir, [storyAdapter(proj.dir)]);
    const first = await service.dreamBegin({});
    const script = storyScript();
    const { promote: _p, ...rest } = script;
    let resp = first;
    while (resp.status === 'step' && resp.step?.name !== 'promote') {
      const fn = rest[resp.step?.name ?? ''];
      resp = await service.dreamStep(resp.jobId, { step: resp.step?.index, ...(fn?.(resp) as object) });
    }
    expect(resp.step?.name).toBe('promote');
    const pi = resp.step?.index;
    const long = await service.dreamStep(resp.jobId, { step: pi, index: Array.from({ length: 300 }, (_, i) => `- line ${i}`).join('\n') });
    expect(long.rejection?.details?.join(' ')).toMatch(/301 lines|300 lines/);
    expect(long.rejection?.details?.join(' ')).toContain('cap is 200 lines');
    const dangling = await service.dreamStep(resp.jobId, { step: pi, index: '# Index\n- [[nowhere]]\n' });
    expect(dangling.rejection?.details?.join(' ')).toContain('[[nowhere]]');
    expect(dangling.rejection?.details?.join(' ')).toContain('active thread page');
    const thread = threadPageName('claude-code', 'sess-a');
    const ok = await service.dreamStep(resp.jobId, { step: pi, index: `# Index\n- [[${thread}]] — current\n- [[dev-server]] — port\n` });
    expect(ok.status).toBe('ready_to_commit');
  });

  it('is idempotent on re-submit and resumes from disk in a new service instance', async () => {
    await seedWrongPort(proj.dir);
    const adapter = storyAdapter(proj.dir);
    const s1 = svc(proj.dir, [adapter]);
    const first = await s1.dreamBegin({});
    const script = storyScript();
    const out1 = { step: 1, ...(script.extract?.(first) as object) };
    const second = await s1.dreamStep(first.jobId, out1);
    expect(second.step?.index).toBe(2);
    const replay = await s1.dreamStep(first.jobId, out1);
    expect(replay.step?.index).toBe(2);
    expect(replay.message).toContain('already accepted');
    expect(replay.rejection).toBeUndefined();
    const ahead = await s1.dreamStep(first.jobId, { step: 7, verdicts: [] });
    expect(ahead.message).toContain('current step is 2');
    const store = new MemoryStore(proj.dir);
    const job = await store.readJob<{ results: { claims: unknown[] } }>(first.jobId);
    expect(job?.results.claims).toHaveLength(2);

    // "Crash": a brand-new service continues the job.
    const s2 = svc(proj.dir, [storyAdapter(proj.dir)]);
    const resumed = await s2.dreamBegin({ resume: first.jobId });
    expect(resumed.message).toContain('Resumed');
    expect(resumed.step?.index).toBe(2);
    expect(resumed.step?.input).toBe(second.step?.input);
    const { last } = await drive(s2, resumed, script);
    expect(last.status).toBe('ready_to_commit');
    const commit = await s2.dreamCommit(first.jobId);
    expect(commit.outcome).toBe('applied');
    await expect(s2.dreamCommit(first.jobId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(s2.dreamBegin({ resume: 'dj-nope' })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });

  it('keeps verbatim claims whose exact text is missing, but as unverified', async () => {
    const service = svc(proj.dir, [storyAdapter(proj.dir)]);
    const first = await service.dreamBegin({});
    const src = { harness: 'claude-code', session: 'sess-a', msgs: '1-2' };
    const next = await service.dreamStep(first.jobId, {
      step: 1,
      claims: [{ text: 'Run the suite with `pnpm test:all --coverage`.', kind: 'fact', verbatim: true, sources: [src] }],
    });
    expect(next.rejection).toBeUndefined();
    expect(next.message).toContain('not found verbatim');
    expect(next.step?.name).toBe('patterns');
    await service.dreamStep(first.jobId, { step: 2, patterns: [] });
    const write = await service.dreamStep(first.jobId, { step: 3, targets: [{ page: 'testing', op: 'create', reason: 'how to test', claims: ['c1'] }] });
    expect(write.step?.input).toContain('UNVERIFIED');
    const script = storyScript();
    await drive(service, write, script);
    await service.dreamCommit(first.jobId);
    const store = new MemoryStore(proj.dir);
    expect((await store.readPage('testing'))?.meta.confidence).toBe('unverified');
    expect(await read(proj.dir, 'log.md')).toContain('verbatim claim(s) not found');
  });

  it('project scope reads other sessions; rename, gap fill and watermarks', async () => {
    const store = new MemoryStore(proj.dir, { now });
    await seedPages(proj.dir, [page('old-name', 'Linked from [[other]].'), page('other', 'See [[old-name]].')]);
    const adapter = storyAdapter(proj.dir).add({
      info: sessionInfo('claude-code', 'sess-b', proj.dir, '2026-11-10T09:00:00.000Z'),
      messages: messages('claude-code', 'sess-b', [
        ['user', 'Decided: we deploy with `make ship` from the main branch only.'],
        ['assistant', 'Understood, `make ship` from main.'],
      ]),
    });
    const service = svc(proj.dir, [adapter]);
    const first = await service.dreamBegin({});
    expect(first.message).toContain('1 other session');
    const script = storyScript();
    const extracts: string[] = [];
    script.extract = (resp) => {
      extracts.push(resp.step?.label ?? '');
      if (resp.step?.label.includes('sess-b')) {
        return { claims: [{ text: 'Deploy with `make ship` from main only.', kind: 'decision', verbatim: true, sources: [{ harness: 'claude-code', session: 'sess-b', msgs: '0' }] }] };
      }
      return { claims: [] };
    };
    script.verify = (resp) => ({ verdicts: verifyPages(resp).map((p) => ({ page: p, verdict: 'keep' })) });
    script.outline = () => ({
      targets: [
        { page: 'old-name', op: 'rename', into: 'new-name', reason: 'clearer' },
        { page: 'deploy', op: 'create', reason: 'deploy decision', claims: ['c1'] },
      ],
    });
    script.write_page = () => ({
      op: { op: 'create', page: 'deploy', body: 'Deploy with `make ship` from main. See [[ci-pipeline]].', meta: { title: 'Deploy', kind: 'decision' }, sources: [{ harness: 'claude-code', session: 'sess-b', msgs: '0' }], reason: 'r' },
    });
    let gapInput = '';
    script.gap_fill = (resp) => {
      gapInput = resp.step?.input ?? '';
      return { ops: [{ op: 'create', page: 'ci-pipeline', body: 'CI runs on push; deploy via [[deploy]].', sources: [{ harness: 'claude-code', session: 'sess-b', msgs: '0-1' }], reason: 'dangling link' }] };
    };
    const { last } = await drive(service, first, script);
    expect(extracts).toHaveLength(2);
    expect(gapInput).toContain('ci-pipeline');
    expect(last.status).toBe('ready_to_commit');
    const r = await service.dreamCommit(first.jobId);
    expect(r.outcome).toBe('applied');
    expect(r.summary.renamed).toEqual([{ from: 'old-name', to: 'new-name' }]);
    expect(r.summary.created).toEqual(expect.arrayContaining(['deploy', 'ci-pipeline']));
    expect(await store.readPage('old-name')).toBeNull();
    expect((await store.readPage('other'))?.body).toContain('[[new-name]]');
    const state = await store.readState();
    expect(state.watermarks).toEqual({ 'claude-code:sess-a': 5, 'claude-code:sess-b': 1 });
  });

  it('refuses to commit before the steps are done', async () => {
    const service = svc(proj.dir, [storyAdapter(proj.dir)]);
    const first = await service.dreamBegin({});
    await expect(service.dreamCommit(first.jobId)).rejects.toMatchObject({ code: 'JOB_STATE' });
  });

  it('asks for confirmation when sessions of different harnesses are equally recent', async () => {
    const cc = storyAdapter(proj.dir);
    const codex = new FakeAdapter('codex').add({
      info: sessionInfo('codex', 'cx-1', proj.dir, '2026-11-11T11:45:00.000Z'),
      messages: messages('codex', 'cx-1', [['user', 'hello there codex'], ['assistant', 'hi']]),
    });
    const service = svc(proj.dir, [cc, codex]);
    const r = await service.dreamBegin({});
    expect(r.status).toBe('needs_confirmation');
    expect(r.jobId).toBe('');
    expect(r.candidates?.map((c) => c.id)).toEqual(['sess-a', 'cx-1']);
    expect(r.message).toContain('dream_begin again');
    const confirmed = await service.dreamBegin({ confirm: true });
    expect(confirmed.status).toBe('step');
    expect(confirmed.message).toContain('claude-code:sess-a');
    expect(confirmed.message).toContain('1 other session');
    const explicit = await service.dreamBegin({ session: 'cx-1', scope: 'thread' });
    expect(explicit.status).toBe('step');
    expect(explicit.step?.label).toContain('codex:cx-1');
  });

  it('caps the run budget: prioritizes candidate chunks and logs the skipped ones', async () => {
    const store = new MemoryStore(proj.dir, { now });
    await store.init();
    const cfg = JSON.parse(await read(proj.dir, 'config.json')) as Record<string, unknown>;
    await writeFile(path.join(proj.dir, '.dream', 'config.json'), JSON.stringify({ ...cfg, chunkTokens: 200, runTokens: 1000 }));
    const specs: [ 'user' | 'assistant', string][] = [];
    for (let i = 0; i < 40; i++) {
      specs.push(['user', `${i === 30 ? "no, that's wrong: " : ''}request number ${i} ${'lorem ipsum dolor '.repeat(10)}`]);
    }
    const big = new FakeAdapter('claude-code').add({
      info: sessionInfo('claude-code', 'big', proj.dir, '2026-11-11T11:00:00.000Z'),
      messages: messages('claude-code', 'big', specs),
    });
    const service = svc(proj.dir, [big]);
    const first = await service.dreamBegin({});
    expect(first.status).toBe('step');
    expect(first.message).toContain('budget: skipped');
    const extracts = first.step?.total ?? 0;
    expect(extracts).toBeGreaterThan(0);
    const job = await store.readJob<{ steps: { name: string; tokens: number; data: { chunk?: { fromIdx: number; toIdx: number } } }[] }>(first.jobId);
    const ex = job?.steps.filter((s) => s.name === 'extract') ?? [];
    // Extraction is planned within 60% of runTokens (one chunk may slightly exceed it).
    expect(ex.reduce((n, s) => n + s.tokens, 0)).toBeLessThanOrEqual(600 + 50);
    expect(ex.length).toBeLessThan(10);
    // The chunk holding the user correction (#30) was kept.
    expect(ex.some((s) => (s.data.chunk?.fromIdx ?? 99) <= 30 && (s.data.chunk?.toIdx ?? -1) >= 30)).toBe(true);
  });

  it('dry run computes the summary but writes nothing', async () => {
    const store = await seedWrongPort(proj.dir);
    const runsBefore = (await store.listRuns()).length;
    const pageBefore = await read(proj.dir, 'pages/dev-server.md');
    const indexBefore = await store.readIndex();
    const service = svc(proj.dir, [storyAdapter(proj.dir)]);
    const first = await service.dreamBegin({ dry_run: true });
    expect(first.message).toContain('dry run');
    await drive(service, first, storyScript());
    const r = await service.dreamCommit(first.jobId);
    expect(r.outcome).toBe('dry_run');
    expect(r.summary.corrections).toHaveLength(1);
    expect(r.message).toContain('nothing was written');
    expect(await read(proj.dir, 'pages/dev-server.md')).toBe(pageBefore);
    expect(await store.readIndex()).toBe(indexBefore);
    expect((await store.listRuns()).length).toBe(runsBefore);
    expect((await store.readState()).watermarks).toEqual({});
  });

  describe('safety net', () => {
    async function massDelete(dir: string): Promise<{ service: DreamService; store: MemoryStore; jobId: string }> {
      const store = new MemoryStore(dir, { now });
      await store.init();
      const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
      await seedPages(dir, names.map((n) => page(n, `${n} notes`, n === 'alpha' || n === 'beta' ? { confidence: 'unverified', sources: [{ harness: 'claude-code', session: 'sess-a', msgs: '2' }] } : { verified_at: '2026-11-10' })));
      const service = svc(dir, [storyAdapter(dir)]);
      const first = await service.dreamBegin({});
      const script = storyScript();
      const ev = { quote: 'listening on :5173', source: { harness: 'claude-code', session: 'sess-a', msgs: '2' } };
      script.verify = (resp) => ({
        verdicts: verifyPages(resp).map((p) => (p === 'alpha' || p === 'beta' ? { page: p, verdict: 'delete', evidence: ev } : { page: p, verdict: 'keep' })),
      });
      script.outline = () => ({
        targets: [
          { page: 'alpha', op: 'delete', reason: 'obsolete' },
          { page: 'beta', op: 'delete', reason: 'obsolete' },
          { page: 'gamma', op: 'merge', into: 'delta', reason: 'same subject' },
        ],
      });
      script.write_page = (resp) => ({
        op: { op: 'merge', page: 'gamma', into: 'delta', body: 'gamma and delta notes', sources: [], reason: 'merge' },
      });
      script.promote = () => ({
        index: `# Index\n- [[${threadPageName('claude-code', 'sess-a')}]]\n- [[delta]]\n- [[epsilon]]\n- [[zeta]]\n`,
      });
      await drive(service, first, script);
      return { service, store, jobId: first.jobId };
    }

    it('stages a mass change, shows a diff and applies it on approve', async () => {
      const { service, store, jobId } = await massDelete(proj.dir);
      const r = await service.dreamCommit(jobId);
      expect(r.outcome).toBe('staged');
      expect(r.stagedReason).toContain('3 of 6');
      expect(await store.readPage('alpha')).not.toBeNull();
      const status = await service.memoryStatus();
      expect(status.stagedJobs).toEqual([jobId]);
      await expect(service.dreamStep(jobId, {})).rejects.toMatchObject({ code: 'JOB_STATE' });
      const resumed = await service.dreamBegin({ resume: jobId });
      expect(resumed.message).toContain('dream_review');

      const show = await service.dreamReview({ action: 'show' });
      expect(show.diff).toContain('--- a/pages/alpha.md');
      expect(show.diff).toContain('+++ /dev/null');
      expect(show.diff).toContain('+gamma and delta notes');
      const approve = await service.dreamReview({ jobId, action: 'approve' });
      expect(approve.commit?.outcome).toBe('applied');
      expect(approve.message).toContain('Memory saved');
      expect(await store.readPage('alpha')).toBeNull();
      expect(await store.readPage('gamma')).toBeNull();
      expect((await store.readPage('delta'))?.body).toContain('gamma and delta');
      await expect(service.dreamReview({ action: 'show' })).rejects.toMatchObject({ code: 'NOTHING_STAGED' });
    });

    it('discards staged changes on reject', async () => {
      const { service, store, jobId } = await massDelete(proj.dir);
      await service.dreamCommit(jobId);
      const rej = await service.dreamReview({ action: 'reject' });
      expect(rej.message).toContain('discarded');
      expect(await store.readPage('alpha')).not.toBeNull();
      expect(await store.listJobs()).toEqual([]);
      expect((await store.readState()).watermarks).toEqual({});
    });
  });

  it('degraded mode: no transcript → notes + own context, thread page unverified', async () => {
    const empty = new FakeAdapter('claude-code');
    const service = svc(proj.dir, [empty]);
    await service.memoryNote('Use pnpm, not npm, in this repo.');
    const first = await service.dreamBegin({ harness: 'claude-code', session: 'live-1' });
    expect(first.status).toBe('step');
    expect(first.message).toContain('No transcript is available');
    expect(first.step?.label).toContain('own context');
    expect(first.step?.input).toContain('No readable transcript');
    const script = storyScript('live-1');
    script.extract = () => ({ claims: [{ text: 'Use pnpm, not npm.', kind: 'preference', sources: [] }] });
    script.outline = () => ({ targets: [{ page: 'package-manager', op: 'create', reason: 'pref', claims: ['c1'] }] });
    script.write_page = () => ({
      op: { op: 'create', page: 'package-manager', body: 'Use `pnpm`, not `npm`.', meta: { title: 'Package manager', kind: 'preference' }, sources: [], reason: 'pref' },
    });
    script.thread_state = (resp) => {
      expect(resp.step?.instructions).toContain('own context');
      return { body: THREAD_BODY.replace('[[dev-server]]', '[[package-manager]]') };
    };
    const { last } = await drive(service, first, script);
    expect(last.status).toBe('ready_to_commit');
    const r = await service.dreamCommit(first.jobId);
    expect(r.outcome).toBe('applied');
    const store = new MemoryStore(proj.dir);
    const t = await store.readPage(threadPageName('claude-code', 'live-1'));
    expect(t?.meta.confidence).toBe('unverified');
    expect((await store.readPage('package-manager'))?.meta.confidence).toBe('unverified');
    expect(await store.readInbox()).toEqual([]);
  });

  it('memory tools: index, read (counts reads), search, note, status, sessions, instructions', async () => {
    const service = svc(proj.dir, [storyAdapter(proj.dir)]);
    expect(await service.memoryIndex()).toContain('empty');
    expect(await service.serverInstructions()).toContain('(empty');
    expect((await service.memoryStatus()).initialized).toBe(false);
    expect(await service.memorySearch('anything')).toEqual([]);
    expect(await service.memoryRead('dev-server')).toBeNull();
    await seedWrongPort(proj.dir);
    const md = await service.memoryRead('dev-server');
    expect(md).toContain('title: Dev server');
    await service.memoryRead('dev-server');
    const store = new MemoryStore(proj.dir);
    expect((await store.readState()).reads['dev-server']).toBe(2);
    await expect(service.memoryRead('../x')).rejects.toMatchObject({ code: 'INVALID_PAGE_NAME' });
    const hits = await service.memorySearch('dev server port', { includeTranscripts: true });
    expect(hits[0]?.ref).toBe('dev-server');
    expect(hits.some((h) => h.kind === 'transcript')).toBe(true);
    const note = await service.memoryNote('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB is the key');
    expect(note.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
    const status = await service.memoryStatus();
    expect(status.initialized).toBe(true);
    expect(status.pageCount).toBe(1);
    expect(status.inboxCount).toBe(1);
    expect(status.pending).toEqual([expect.objectContaining({ session: 'sess-a', newMessages: 6 })]);
    expect(status.availableHarnesses).toEqual(['claude-code']);
    expect((await service.listSessions()).map((s) => s.id)).toEqual(['sess-a']);
    expect(await service.listSessions({ harness: 'codex' })).toEqual([]);

    const big = Array.from({ length: 150 }, (_, i) => `- [[page-${i}]] — ${'x'.repeat(40)}`).join('\n');
    await writeFile(path.join(proj.dir, '.dream', 'MEMORY.md'), `# Index\n${big}\n`);
    const instr = await service.serverInstructions();
    expect(instr.length).toBeLessThanOrEqual(4000);
    expect(instr.slice(0, 512)).toContain('memory_index');
    expect(instr).toContain('index truncated');
    expect(instr).toContain('[[page-0]]');
  });
});
