/**
 * Safety net (PLAN §6.2): with ≥ 5 existing pages, a run that deletes 4 of them is staged instead of applied.
 * dream_review approve applies it, reject discards it, and dream_rollback restores the deleted pages.
 */
import type { BenchProject, Scenario, ScenarioContext, SeedPage } from '../harness.ts';
import { verifyPages, writeTarget } from '../oracle.ts';
import type { Oracle } from '../oracle.ts';
import { legacyStory, ref } from '../transcripts.ts';
import type { LegacyStory } from '../transcripts.ts';
import { errorOf, threadBody } from './common.ts';

const LEGACY = ['legacy-importer', 'legacy-cron', 'legacy-mapping', 'legacy-admin'];
const KEEP = ['billing-overview', 'dev-server'];
const QUOTE = 'its cron job, its mapping table and its admin screen are all gone now';

function seedPages(): SeedPage[] {
  const old = [ref('claude-code', 'cc-old-000001', 1, 2)];
  return [
    ...LEGACY.map((name) => ({
      name,
      body: `Notes about the ${name.replace(/-/g, ' ')}. Part of [[billing-overview]].\n`,
      meta: { title: name.replace(/-/g, ' '), sources: old },
    })),
    { name: 'billing-overview', body: `Billing overview. Legacy parts: ${LEGACY.map((n) => `[[${n}]]`).join(', ')}. Dev: [[dev-server]].\n`, meta: { title: 'Billing overview', kind: 'overview' as const, sources: old } },
    { name: 'dev-server', body: 'Run `npm run dev`; it listens on port 5173. See [[billing-overview]].\n', meta: { title: 'Dev server', sources: old } },
  ];
}

const SEED_INDEX = `# Project memory\n\n${[...LEGACY, ...KEEP].map((n) => `- [[${n}]] — ${n.replace(/-/g, ' ')}`).join('\n')}\n`;

function legacyOracle(s: LegacyStory): Oracle {
  const evidence = { quote: QUOTE, source: ref(s.harness, s.session, s.removalIdx) };
  return {
    extract: () => ({
      claims: [
        {
          text: 'The legacy importer, its cron job, mapping table and admin screen were removed.',
          kind: 'decision',
          sources: [ref(s.harness, s.session, s.removalIdx)],
        },
      ],
    }),
    verify: ({ step }) => ({
      verdicts: verifyPages(step).map((page) =>
        LEGACY.includes(page)
          ? { page, verdict: 'delete', evidence, reason: 'the legacy importer was removed' }
          : { page, verdict: 'keep', reason: 'still true' },
      ),
    }),
    outline: () => ({
      targets: [
        ...LEGACY.map((page) => ({ page, op: 'delete', reason: 'legacy importer removed' })),
        { page: 'billing-overview', op: 'update', reason: 'drop links to deleted legacy pages' },
      ],
    }),
    write_page: ({ step }) => {
      const t = writeTarget(step);
      if (t.page !== 'billing-overview') {
        return { op: { op: t.op, page: t.page, sources: [ref(s.harness, s.session, s.removalIdx)], reason: 'legacy importer removed' } };
      }
      return {
        op: {
          op: t.op,
          page: t.page,
          body: 'Billing overview. The legacy importer was removed (2026-11). Dev: [[dev-server]].\n',
          meta: { title: 'Billing overview', kind: 'overview', volatile: false, confidence: 'verified' },
          sources: [ref(s.harness, s.session, s.removalIdx, s.lastIdx)],
          reason: 'legacy parts removed',
        },
      };
    },
    thread_state: () => ({ body: threadBody('Remove the legacy importer.', '- Removed.', KEEP) }),
  };
}

async function stagedRun(ctx: ScenarioContext, label: string): Promise<{ p: BenchProject; jobId: string; staged: boolean }> {
  const p = await ctx.project(label);
  const s = legacyStory(p.projectDir);
  p.sessions = s.sessions;
  await p.seed(seedPages(), SEED_INDEX);
  const r = await ctx.drive(p, legacyOracle(s));
  ctx.check(`[${label}] drive had no rejections`, r.rejections.length === 0, r.rejections.map((x) => `${x.label}: ${x.reason} ${(x.details ?? []).join('; ')}`).join(' | '));
  const c = r.commit;
  ctx.check(`[${label}] deleting 4 of 6 pages → outcome staged`, c?.outcome === 'staged', `outcome=${c?.outcome}`);
  ctx.check(`[${label}] staged reason given`, !!c?.stagedReason, c?.stagedReason);
  const still = await Promise.all(LEGACY.map((n) => p.page(n)));
  ctx.check(`[${label}] nothing applied while staged`, still.every((x) => x !== null));
  const status = await p.service().memoryStatus();
  ctx.check(`[${label}] memory_status lists the staged job`, status.stagedJobs.includes(r.jobId), JSON.stringify(status.stagedJobs));
  return { p, jobId: r.jobId, staged: c?.outcome === 'staged' };
}

export const safetyNet: Scenario = {
  id: 'safety-net',
  plan: '§6.2',
  title: 'Mass deletion is staged; review approve/reject; rollback restores',
  async run(ctx) {
    // Approve + rollback.
    const a = await stagedRun(ctx, 'approve');
    const svc = a.p.service();
    const show = await svc.dreamReview({ action: 'show' });
    ctx.check('review show returns a diff naming the deleted pages', !!show.diff && LEGACY.every((n) => show.diff?.includes(`pages/${n}.md`)), show.diff?.slice(0, 400));
    const approve = await svc.dreamReview({ jobId: a.jobId, action: 'approve' });
    ctx.check('approve applies', approve.commit?.outcome === 'applied', `outcome=${approve.commit?.outcome}: ${approve.message}`);
    const gone = await Promise.all(LEGACY.map((n) => a.p.page(n)));
    ctx.check('legacy pages deleted after approve', gone.every((x) => x === null));
    ctx.check('kept pages remain', (await a.p.page('dev-server')) !== null && (await a.p.page('billing-overview')) !== null);
    const runs = await a.p.store().listRuns(5);
    ctx.note(`history after approve: ${runs.length} runs`);
    await svc.dreamRollback();
    const back = await Promise.all(LEGACY.map((n) => a.p.page(n)));
    ctx.check('rollback restores the deleted pages', back.every((x) => x !== null));
    const idx = await a.p.index();
    ctx.check('rollback restores the index', LEGACY.every((n) => idx.includes(`[[${n}]]`)), idx);

    // Reject.
    const b = await stagedRun(ctx, 'reject');
    const bsvc = b.p.service();
    const reject = await bsvc.dreamReview({ jobId: b.jobId, action: 'reject' });
    ctx.check('reject reports no commit', !reject.commit || reject.commit.outcome !== 'applied', reject.message);
    const kept = await Promise.all(LEGACY.map((n) => b.p.page(n)));
    ctx.check('reject leaves memory unchanged', kept.every((x) => x !== null));
    const status = await bsvc.memoryStatus();
    ctx.check('no staged jobs after reject', status.stagedJobs.length === 0, JSON.stringify(status.stagedJobs));
    const nothing = await errorOf(bsvc.dreamReview({ action: 'approve' }));
    ctx.check('approve with nothing staged → error', !!nothing, JSON.stringify(nothing));
  },
};
