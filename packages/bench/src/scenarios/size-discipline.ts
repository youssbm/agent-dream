/**
 * PLAN §9 #4 — size discipline.
 *
 * - The oracle first submits an index over the line cap, then one over the byte cap, then one with a
 *   dangling link: each is rejected with the numbers / the bad link. A compliant index is then accepted.
 * - The oracle writes bloated pages (more page text than source text): lint reports the wiki/source ratio.
 */
import type { Scenario } from '../harness.ts';
import { defaultIndex, writeTarget } from '../oracle.ts';
import type { Oracle } from '../oracle.ts';
import { longStory, ref } from '../transcripts.ts';
import { threadBody, transcriptRanges } from './common.ts';

const BLOAT_PAGES = ['reconciliation-design', 'reconciliation-ledger', 'reconciliation-exports'];

/** ~11 KB of repetitive prose: under the 12 KB oversized-page limit, but three of them dwarf the source. */
function bloatedBody(page: string): string {
  const others = BLOAT_PAGES.filter((n) => n !== page).map((n) => `[[${n}]]`).join(', ');
  const para =
    'The reconciliation process compares provider settlement rows with ledger rows every night and reports the ' +
    'unmatched rows, which this page restates in full detail for completeness and redundancy. ';
  let body = `Notes on ${page.replace(/-/g, ' ')}. Related: ${others}.\n\n`;
  while (body.length < 11_000) body += para;
  return body + '\n';
}

export const sizeDiscipline: Scenario = {
  id: 'size-discipline',
  plan: '#4',
  title: 'Index caps are enforced with numbers; bloated wiki triggers the size-ratio lint',
  async run(ctx) {
    const p = await ctx.project('main');
    const s = longStory(p.projectDir);
    p.sessions = s.sessions;
    ctx.note(`source: ${s.chars} chars of transcript prose`);

    const src = [ref(s.harness, s.session, 0, s.lastIdx)];
    const oracle: Oracle = {
      extract: ({ step }) => ({
        claims: transcriptRanges(step).map((r) => ({
          text: 'Billing reconciliation runs as a nightly batch for now; streaming was deferred.',
          kind: 'decision',
          sources: [ref(r.harness, r.session, r.from, r.to)],
        })),
      }),
      outline: () => ({ targets: BLOAT_PAGES.map((page) => ({ page, op: 'create', reason: 'bloated on purpose' })) }),
      write_page: ({ step }) => {
        const t = writeTarget(step);
        return {
          op: {
            op: t.op,
            page: t.page,
            body: bloatedBody(t.page),
            meta: { title: t.page.replace(/-/g, ' '), kind: 'overview', volatile: false, confidence: 'verified' },
            sources: src,
            reason: 'restating the discussion at length',
          },
        };
      },
      gap_fill: ({ step, memo }) => {
        memo.gapInput = step.input;
        return { ops: [] };
      },
      thread_state: () => ({ body: threadBody('Design billing reconciliation.', '- Nightly batch chosen for now.', BLOAT_PAGES) }),
      promote: ({ step, attempt, rejection, memo }) => {
        const log = (memo.promote as { attempt: number; reason?: string; details?: string[] }[] | undefined) ?? [];
        if (rejection) log.push({ attempt: attempt - 1, reason: rejection.reason, details: rejection.details });
        memo.promote = log;
        if (attempt === 0) {
          // 260 lines: over the 200-line cap.
          const lines = Array.from({ length: 260 }, (_, i) => `- note ${i + 1}: something that belongs on a page`);
          return { index: defaultIndex(step, lines) };
        }
        if (attempt === 1) {
          // 60 lines of ~600 bytes: under the line cap, over the 25 KB byte cap.
          const lines = Array.from({ length: 60 }, (_, i) => `- detail ${i + 1}: ${'x'.repeat(600)}`);
          return { index: defaultIndex(step, lines) };
        }
        if (attempt === 2) {
          return { index: defaultIndex(step, ['- [[no-such-page]] — a page that does not exist']) };
        }
        return { index: defaultIndex(step) };
      },
    };

    const r = await ctx.drive(p, oracle, { maxAttempts: 5 });
    const log = (r.memo.promote as { reason?: string; details?: string[] }[] | undefined) ?? [];
    const text = (i: number): string => `${log[i]?.reason ?? ''} ${(log[i]?.details ?? []).join(' ')}`;
    ctx.check('over-long index rejected', log.length >= 1, text(0));
    ctx.check('line-cap rejection states the numbers (lines and cap)', /\b2\d\d\b/.test(text(0)) && text(0).includes('200'), text(0));
    ctx.check('over-large index rejected', log.length >= 2, text(1));
    ctx.check('byte-cap rejection states the cap', /25600|25 ?KB|25,600/i.test(text(1)), text(1));
    ctx.check('dangling index link rejected', log.length >= 3 && text(2).includes('no-such-page'), text(2));
    ctx.check('compliant index accepted (exactly 3 promote rejections)', r.rejections.filter((x) => x.name === 'promote').length === 3);
    ctx.check('no other step rejected', r.rejections.every((x) => x.name === 'promote'), r.rejections.map((x) => `${x.label}: ${x.reason}`).join(' | '));

    const commit = r.commit;
    ctx.check('commit applied', commit?.outcome === 'applied', `outcome=${commit?.outcome} ${commit?.stagedReason ?? ''}`);
    const index = await p.index();
    const lines = index.split(/\r?\n/).length;
    const bytes = Buffer.byteLength(index, 'utf8');
    ctx.check('stored index within caps', lines <= 200 && bytes <= 25 * 1024, `${lines} lines, ${bytes} bytes`);
    ctx.check(
      'summary reports index size',
      commit?.summary.indexLines !== undefined && commit.summary.indexLines <= 200 && commit.summary.indexBytes <= 25 * 1024,
      `${commit?.summary.indexLines} lines / ${commit?.summary.indexBytes} bytes`,
    );

    const status = await p.service().memoryStatus();
    const ratio = status.lintIssues.find((i) => i.type === 'wiki_source_ratio');
    ctx.check('lint reports wiki/source ratio for bloated pages', !!ratio, JSON.stringify(status.lintIssues.map((i) => i.type)));
    if (ratio) ctx.note(`lint: ${ratio.message}`);
    const gapInput = typeof r.memo.gapInput === 'string' ? r.memo.gapInput : '';
    ctx.note(gapInput ? `gap_fill offered: ${/ratio|larger than/i.test(gapInput) ? 'mentions size ratio' : 'other issues'}` : 'gap_fill not offered');
    ctx.check(
      'commit message surfaces the size-ratio issue',
      /ratio|larger than (its )?source/i.test(commit?.message ?? ''),
      commit?.message,
    );
  },
};
