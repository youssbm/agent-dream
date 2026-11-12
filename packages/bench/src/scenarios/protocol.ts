/**
 * PLAN §9 #7 — protocol robustness.
 *
 * A model driving the protocol through tool calls will skip, repeat and garble steps, and may lose its context
 * mid-run (compaction, crash). The job must survive all of that and still complete correctly.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepResponse } from '@agent-dream/core';
import type { Scenario } from '../harness.ts';
import type { Oracle } from '../oracle.ts';
import { concurrentSessions, portStory } from '../transcripts.ts';
import type { PortStory } from '../transcripts.ts';
import { claimsForStep, errorOf } from './common.ts';
import { plantedErrorOracle, portClaims } from './planted-error.ts';

function freshPortOracle(s: PortStory): Oracle {
  return {
    ...plantedErrorOracle(s, { correct: false }),
    outline: () => ({
      targets: [
        { page: 'dev-server', op: 'create', reason: 'dev server facts' },
        { page: 'login-form', op: 'create', reason: 'login form preference' },
      ],
    }),
  };
}

export const protocolRobustness: Scenario = {
  id: 'protocol-robustness',
  plan: '#7',
  title: 'Skipped, repeated and malformed steps, and resume on a new service instance',
  async run(ctx) {
    const p = await ctx.project('main');
    const s = portStory(p.projectDir);
    p.sessions = s.sessions;
    const svc = p.service();

    const begin = await svc.dreamBegin({});
    ctx.check('begin returns a step', begin.status === 'step' && !!begin.step, `${begin.status}: ${begin.message}`);
    const first = begin.step;
    if (!first) return;
    const jobId = begin.jobId;
    ctx.check('first step is extract', first.name === 'extract', first.label);
    const good = { step: first.index, claims: claimsForStep(first, portClaims(s)) };

    // Commit too early.
    const early = await errorOf(svc.dreamCommit(jobId));
    ctx.check('dream_commit before ready_to_commit is refused (JOB_STATE)', early?.code === 'JOB_STATE', JSON.stringify(early));

    // Skipped step: the output claims to answer a later step.
    const skipped = await svc.dreamStep(jobId, { ...good, step: first.index + 1 });
    ctx.check(
      'wrong step index → same step repeated, no advance',
      skipped.status === 'step' && skipped.step?.index === first.index && skipped.step.name === first.name,
      `${skipped.step?.label}: ${skipped.message}`,
    );

    // Malformed outputs.
    const malformed1 = await svc.dreamStep(jobId, { step: first.index, claims: 'not an array' });
    ctx.check(
      'malformed output (wrong type) → rejection with details, same step',
      !!malformed1.rejection && (malformed1.rejection.details?.length ?? 0) > 0 && malformed1.step?.index === first.index,
      JSON.stringify(malformed1.rejection),
    );
    const malformed2 = await svc.dreamStep(jobId, { step: first.index, claims: [{ text: 'x', kind: 'gossip', sources: [{ harness: 'claude-code', session: s.session, msgs: 'two' }] }] });
    ctx.check(
      'malformed claim (bad enum, bad msgs) → rejection naming the fields',
      !!malformed2.rejection && /kind/.test(JSON.stringify(malformed2.rejection)) && /msgs/.test(JSON.stringify(malformed2.rejection)),
      JSON.stringify(malformed2.rejection),
    );
    const outOfRange = await svc.dreamStep(jobId, {
      step: first.index,
      claims: [{ text: 'A claim citing a message that does not exist.', kind: 'fact', sources: [{ harness: s.harness, session: s.session, msgs: '900-905' }] }],
    });
    ctx.check('claim citing an out-of-range msgs → rejected', !!outOfRange.rejection && outOfRange.step?.index === first.index, JSON.stringify(outOfRange.rejection));
    const notJson = await svc.dreamStep(jobId, '{"claims": [ this is not json');
    ctx.check('non-JSON string output → rejected', !!notJson.rejection && notJson.step?.index === first.index, JSON.stringify(notJson.rejection));

    // Valid submission advances.
    const ok = await svc.dreamStep(jobId, good);
    const afterOk = ok.step?.index;
    ctx.check('valid output advances', !ok.rejection && (ok.status === 'ready_to_commit' || (afterOk ?? 0) > first.index), `${ok.status} ${ok.step?.label}`);

    // Repeated submission (e.g. retry after a timeout) does not double-apply.
    const again = await svc.dreamStep(jobId, good);
    ctx.check(
      'repeated submission → current step returned, nothing re-applied',
      again.status === ok.status && again.step?.index === afterOk && !again.rejection,
      `${again.status} ${again.step?.label}: ${again.message}`,
    );
    const job = JSON.parse(await fs.readFile(path.join(p.dreamDir, '.jobs', `${jobId}.json`), 'utf8')) as { results?: { claims?: unknown[] } };
    const claimCount = job.results?.claims?.length;
    ctx.check('claims stored once', claimCount === undefined || claimCount === good.claims.length, `stored ${claimCount}, submitted ${good.claims.length}`);

    // Crash / compaction mid-job: a brand-new DreamService resumes from disk.
    let resumedFrom: number | undefined;
    ctx.record(1, 0); // the extract step driven by hand above
    const r = await ctx.drive(p, freshPortOracle(s), {
      startFrom: again,
      beforeSubmit: (resp: StepResponse) => {
        if (resumedFrom === undefined && resp.step?.name === 'outline') {
          resumedFrom = resp.step.index;
          return p.service();
        }
      },
    });
    const resumeEntry = r.trace.find((t) => t.label.startsWith('resume'));
    ctx.check('resume on a new instance returns the same step', !!resumeEntry && resumeEntry.next?.index === resumedFrom && resumeEntry.next?.name === 'outline', JSON.stringify(resumeEntry));
    ctx.check('job completes after resume', r.commit?.outcome === 'applied', `outcome=${r.commit?.outcome}`);
    ctx.check(
      'pages from before and after the resume are written',
      (await p.page('dev-server')) !== null && (await p.page('login-form')) !== null,
    );
    ctx.check('a thread page was written', !!r.commit?.threadPage && (await p.page(r.commit.threadPage)) !== null, r.commit?.threadPage);
    const stale = await errorOf(p.service().dreamStep(jobId, good));
    ctx.check('dream_step on a finished job → JOB_NOT_FOUND', stale?.code === 'JOB_NOT_FOUND', JSON.stringify(stale));
    const unknown = await errorOf(p.service().dreamCommit('dj-00000000-deadbeef'));
    ctx.check('dream_commit on an unknown job → JOB_NOT_FOUND', unknown?.code === 'JOB_NOT_FOUND', JSON.stringify(unknown));

    // Ambiguous session: two harnesses active within minutes → ask, then proceed with the chosen one.
    const q = await ctx.project('confirm');
    const c = concurrentSessions(q.projectDir);
    q.sessions = c.sessions;
    const qsvc = q.service();
    const ask = await qsvc.dreamBegin({});
    ctx.check('two harnesses active within 10 min → needs_confirmation', ask.status === 'needs_confirmation', `${ask.status}: ${ask.message}`);
    const cands = (ask.candidates ?? []).map((x) => `${x.harness}:${x.id}`);
    ctx.check(
      'candidates list both sessions',
      cands.includes(`${c.a.harness}:${c.a.session}`) && cands.includes(`${c.b.harness}:${c.b.session}`),
      cands.join(', '),
    );
    const chosen = await qsvc.dreamBegin({ harness: c.a.harness, session: c.a.session });
    ctx.check('begin with an explicit session proceeds', chosen.status === 'step', `${chosen.status}: ${chosen.message}`);
    const story = portStory(q.projectDir);
    const r2 = await ctx.drive(q, freshPortOracle(story), { startFrom: chosen });
    ctx.check(
      'thread page belongs to the chosen session',
      !!r2.commit?.threadPage && r2.commit.threadPage.includes(c.a.session.replace(/[^a-z0-9-]/g, '')),
      r2.commit?.threadPage,
    );
  },
};
