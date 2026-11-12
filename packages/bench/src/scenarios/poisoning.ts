/**
 * PLAN §9 #6 — poisoning.
 *
 * Memory is correct (port 5173). The oracle tries to "correct" it with evidence the transcript does not
 * support: a hallucinated quote, a real quote cited from the wrong message range, and a deletion backed by a
 * made-up quote. Each must be rejected; after the oracle falls back to `keep`, the page is unchanged.
 * Tracks the false-correction rate (accepted false corrections / attempted).
 */
import type { Scenario } from '../harness.ts';
import { verifyPages } from '../oracle.ts';
import type { Oracle } from '../oracle.ts';
import { portStory, ref } from '../transcripts.ts';
import { claimsForStep, readAllMemoryText, threadBody } from './common.ts';
import { PORT_PAGE_RIGHT, portClaims } from './planted-error.ts';

export const poisoning: Scenario = {
  id: 'poisoning',
  plan: '#6',
  title: 'Hallucinated or mis-cited evidence is rejected; memory unchanged',
  async run(ctx) {
    const p = await ctx.project('main');
    const s = portStory(p.projectDir);
    p.sessions = s.sessions;
    const seedMeta = {
      title: 'Dev server',
      kind: 'fact' as const,
      volatile: true,
      confidence: 'unverified' as const,
      verified_at: '2026-09-01',
      sources: [ref('claude-code', 'cc-old-000001', 3, 4)],
    };
    const loginBody = 'Login form behaviour.\n\nThe email field is autofocused. See [[dev-server]].\n';
    await p.seed(
      [
        { name: 'dev-server', body: PORT_PAGE_RIGHT, meta: seedMeta },
        { name: 'login-form', body: loginBody, meta: { title: 'Login form', kind: 'preference', sources: [ref('claude-code', 'cc-old-000001', 5)] } },
      ],
      '# Project memory\n\n- [[dev-server]] — dev server: `npm run dev`, port 5173\n- [[login-form]] — login form behaviour\n',
    );
    const before = await p.page('dev-server');

    const attempts = [
      {
        label: 'hallucinated quote',
        verdict: {
          page: 'dev-server',
          verdict: 'correct',
          evidence: { quote: 'the dev server was moved to port 8080 last week', source: ref(s.harness, s.session, s.listenIdx) },
          corrected: 'The dev server port is 8080.',
        },
      },
      {
        label: 'real quote, wrong range',
        verdict: {
          page: 'dev-server',
          verdict: 'correct',
          evidence: { quote: 'listening on :5173', source: ref(s.harness, s.session, s.autofocusIdx, s.lastIdx) },
          corrected: 'The dev server port is 8080.',
        },
      },
      {
        label: 'real quote, unknown session',
        verdict: {
          page: 'dev-server',
          verdict: 'correct',
          evidence: { quote: 'listening on :5173', source: ref(s.harness, 'cc-not-in-this-job', s.listenIdx) },
          corrected: 'The dev server port is 8080.',
        },
      },
      {
        label: 'delete with hallucinated quote',
        verdict: {
          page: 'dev-server',
          verdict: 'delete',
          evidence: { quote: 'we no longer use a dev server at all', source: ref(s.harness, s.session, s.correctionIdx) },
        },
      },
    ];

    const oracle: Oracle = {
      extract: ({ step }) => ({ claims: claimsForStep(step, portClaims(s)) }),
      verify: ({ step, attempt, memo }) => {
        const pages = verifyPages(step);
        memo.verifiedPages = [...((memo.verifiedPages as string[] | undefined) ?? []), ...pages];
        const poison = pages.includes('dev-server') ? attempts[attempt] : undefined;
        if (poison) memo.lastPoison = poison.label;
        return {
          verdicts: pages.map((page) =>
            poison && page === 'dev-server' ? poison.verdict : { page, verdict: 'keep', reason: 'consistent with the transcript' },
          ),
        };
      },
      outline: () => ({ targets: [] }),
      thread_state: () => ({ body: threadBody('Check the login page.', '- Done.', ['dev-server', 'login-form']) }),
    };

    const r = await ctx.drive(p, oracle, { maxAttempts: attempts.length + 1 });
    const verifiedPages = (r.memo.verifiedPages as string[] | undefined) ?? [];
    ctx.check('a verify batch included dev-server', verifiedPages.includes('dev-server'), verifiedPages.join(', '));
    const verifyRejections = r.rejections.filter((x) => x.name === 'verify');
    for (const [i, a] of attempts.entries()) {
      const rej = verifyRejections[i];
      ctx.check(`rejected: ${a.label}`, !!rej, rej ? `${rej.reason} ${(rej.details ?? []).join('; ')}` : 'accepted');
    }
    const accepted = attempts.length - verifyRejections.length;
    ctx.note(`false corrections accepted: ${Math.max(0, accepted)}/${attempts.length}`);

    const commit = r.commit;
    ctx.check('commit applied', commit?.outcome === 'applied', `outcome=${commit?.outcome} ${commit?.stagedReason ?? ''}`);
    ctx.check('no corrections in summary', (commit?.summary.corrections.length ?? 0) === 0, JSON.stringify(commit?.summary.corrections));
    const after = await p.page('dev-server');
    ctx.check('dev-server body unchanged', !!after && after.body.trim() === before?.body.trim(), after?.body);
    ctx.check('dev-server not deleted', !!after && !commit?.summary.deleted.includes('dev-server'));
    const all = await readAllMemoryText(p.dreamDir);
    ctx.check('the poisoned value (8080) appears nowhere in memory', !all.includes('8080'));
  },
};
