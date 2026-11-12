/**
 * PLAN §9 #1 — planted error (the Mt. Moon analogue).
 *
 * Memory says the dev server port is 3000; the transcript shows `listening on :5173` and the user correcting
 * "no, it's 5173". The oracle submits a `correct` verdict quoting the transcript. Expected: the page is
 * corrected, the summary lists the correction with its quote, and a follow-up lookup finds port 5173.
 */
import type { Claim } from '@agent-dream/core';
import type { Scenario } from '../harness.ts';
import { verifyPages, writeTarget } from '../oracle.ts';
import type { Oracle } from '../oracle.ts';
import { portStory, ref } from '../transcripts.ts';
import type { PortStory } from '../transcripts.ts';
import { claimsForStep, threadBody } from './common.ts';

export const PORT_PAGE_WRONG =
  'How to run the dev server.\n\nStart it with `npm run dev`. The dev server port is 3000 (http://localhost:3000).\n';
export const PORT_PAGE_RIGHT =
  'How to run the dev server.\n\nStart it with `npm run dev`; it prints `listening on :5173`. The dev server port is 5173 (http://localhost:5173).\n\nRelated: [[login-form]].\n';
export const CORRECTION_QUOTE = "no, it's 5173. The dev server port is 5173, not 3000";

/** Claims a careful model would extract from the port story. */
export function portClaims(s: PortStory): Claim[] {
  return [
    {
      text: 'The dev server listens on port 5173: `listening on :5173`',
      kind: 'fact',
      verbatim: true,
      volatile: true,
      sources: [ref(s.harness, s.session, s.listenIdx)],
    },
    {
      text: 'User corrected the agent: the dev server port is 5173, not 3000.',
      kind: 'fact',
      volatile: true,
      sources: [ref(s.harness, s.session, s.correctionIdx)],
    },
    {
      text: 'The login form autofocuses the email field (`src/pages/Login.tsx`).',
      kind: 'preference',
      sources: [ref(s.harness, s.session, s.autofocusIdx, s.lastIdx)],
    },
  ];
}

/** The oracle for the planted-error story (also reused by #9). */
export function plantedErrorOracle(s: PortStory, opts: { correct: boolean }): Oracle {
  return {
    extract: ({ step }) => ({ claims: claimsForStep(step, portClaims(s)) }),
    verify: ({ step, memo }) => {
      const pages = verifyPages(step);
      memo.verifiedPages = [...((memo.verifiedPages as string[] | undefined) ?? []), ...pages];
      return {
        verdicts: pages.map((page) =>
          page === 'dev-server' && opts.correct
            ? {
                page,
                verdict: 'correct',
                evidence: { quote: CORRECTION_QUOTE, source: ref(s.harness, s.session, s.correctionIdx) },
                corrected: 'The dev server port is 5173 (`listening on :5173`), not 3000.',
                reason: 'the transcript shows the server listening on 5173 and the user corrected 3000',
              }
            : { page, verdict: 'keep', reason: 'consistent with the transcript' },
        ),
      };
    },
    outline: () => ({
      targets: [
        { page: 'dev-server', op: 'update', reason: 'apply the verified port correction' },
        { page: 'login-form', op: 'create', reason: 'new UI preference from this session' },
      ],
    }),
    write_page: ({ step }) => {
      const t = writeTarget(step);
      if (t.page === 'dev-server') {
        return {
          op: {
            op: t.op,
            page: t.page,
            body: PORT_PAGE_RIGHT,
            meta: { title: 'Dev server', kind: 'fact', volatile: true, confidence: 'verified' },
            sources: [ref(s.harness, s.session, s.listenIdx), ref(s.harness, s.session, s.correctionIdx)],
            reason: 'port corrected from 3000 to 5173',
          },
        };
      }
      return {
        op: {
          op: t.op,
          page: t.page,
          body: 'Login form behaviour.\n\nThe email field is autofocused (`src/pages/Login.tsx`). See [[dev-server]] to run it.\n',
          meta: { title: 'Login form', kind: 'preference', volatile: false, confidence: 'verified' },
          sources: [ref(s.harness, s.session, s.autofocusIdx, s.lastIdx)],
          reason: 'new preference',
        },
      };
    },
    thread_state: () => ({
      title: 'Check the login page',
      body: threadBody(
        'Check the login page in the dev server.',
        '- Dev server confirmed on port 5173; email field autofocus done.',
        ['dev-server', 'login-form'],
      ),
    }),
  };
}

export const plantedError: Scenario = {
  id: 'planted-error',
  plan: '#1',
  title: 'Planted error is corrected with a quoted transcript line',
  async run(ctx) {
    const p = await ctx.project('main');
    const s = portStory(p.projectDir);
    p.sessions = s.sessions;
    await p.seed(
      [
        {
          name: 'dev-server',
          body: PORT_PAGE_WRONG,
          meta: {
            title: 'Dev server',
            kind: 'fact',
            volatile: true,
            confidence: 'unverified',
            verified_at: '2026-09-01',
            sources: [ref('claude-code', 'cc-old-000001', 3, 4)],
          },
        },
      ],
      '# Project memory\n\n- [[dev-server]] — dev server: `npm run dev`, port 3000\n',
    );

    const r = await ctx.drive(p, plantedErrorOracle(s, { correct: true }));
    const verifiedPages = (r.memo.verifiedPages as string[] | undefined) ?? [];
    ctx.check('a verify batch included dev-server', verifiedPages.includes('dev-server'), `verify pages: ${verifiedPages.join(', ')}`);
    ctx.check('drive reached ready_to_commit with no rejections', r.rejections.length === 0, r.rejections.map((x) => `${x.label}: ${x.reason} ${(x.details ?? []).join('; ')}`).join(' | '));
    const commit = r.commit;
    ctx.check('commit applied', commit?.outcome === 'applied', `outcome=${commit?.outcome} ${commit?.stagedReason ?? ''}`);

    const corr = commit?.summary.corrections.find((c) => c.page === 'dev-server');
    ctx.check('summary.corrections lists dev-server as correct', corr?.verdict === 'correct', JSON.stringify(commit?.summary.corrections));
    ctx.check('correction carries the transcript quote', !!corr?.quote && corr.quote.includes('5173'), `quote=${corr?.quote}`);

    const page = await p.page('dev-server');
    ctx.check('page now says 5173', !!page && page.body.includes('5173'), page?.body);
    ctx.check('page no longer says port 3000', !!page && !/port is 3000|localhost:3000/.test(page.body), page?.body);
    ctx.check('page confidence verified, verified_at today', page?.meta.confidence === 'verified' && page.meta.verified_at === '2026-11-11', `${page?.meta.confidence} ${page?.meta.verified_at}`);
    ctx.check(
      'page sources include the correcting session',
      !!page?.meta.sources.some((x) => x.session === s.session),
      JSON.stringify(page?.meta.sources),
    );

    // Follow-up task: a new session asks "what port is the dev server on?" using only memory tools.
    const svc = p.service();
    const index = await svc.memoryIndex();
    ctx.check('index no longer carries the wrong port', !index.includes('3000'), index);
    const hits = await svc.memorySearch('dev server port');
    const top = hits[0];
    ctx.check('memory_search("dev server port") returns dev-server first', top?.ref === 'dev-server', JSON.stringify(hits.map((h) => h.ref)));
    const md = top ? await svc.memoryRead(top.ref) : null;
    const port = /port is (\d{2,5})/.exec(md ?? '')?.[1];
    ctx.check('follow-up answer from memory is 5173', port === '5173', `answer=${port}`);
  },
};
