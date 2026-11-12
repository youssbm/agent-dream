/**
 * PLAN §9 #2 — fact retention (the 41/57 vs 57/57 experiment, scripted).
 *
 * Twelve exact facts (commands, paths, versions, env var names) across three sessions in three harnesses.
 * - "verbatim" oracle: one writer per entity page, every fact quoted verbatim → all 12 survive verbatim.
 * - "summarizing" oracle: claims and pages paraphrase the facts while still flagging them verbatim → the
 *   server downgrades those claims, and the pages built on them end up `confidence: unverified`.
 */
import type { Claim } from '@agent-dream/core';
import type { Scenario } from '../harness.ts';
import { writeTarget } from '../oracle.ts';
import type { Oracle } from '../oracle.ts';
import { factsStory, ref } from '../transcripts.ts';
import type { ExactFact, FactEntity, FactsStory } from '../transcripts.ts';
import { claimsForStep, readAllMemoryText, threadBody } from './common.ts';

const ENTITIES: { page: FactEntity; title: string; summary: string }[] = [
  { page: 'build-and-test', title: 'Build and test', summary: 'How to build, test and lint the web app.' },
  { page: 'database', title: 'Database', summary: 'Local database, migrations and connection settings.' },
  { page: 'configuration', title: 'Configuration', summary: 'Where local configuration and env vars come from.' },
  { page: 'deploy-and-services', title: 'Deploy and services', summary: 'Preview deploys and auxiliary services.' },
];

function factClaims(story: FactsStory, mode: 'verbatim' | 'summarize'): Claim[] {
  return story.facts.map((f) => ({
    text: mode === 'verbatim' ? `\`${f.fact}\`` : f.paraphrase,
    kind: 'fact',
    verbatim: true,
    sources: [ref(f.harness, f.session, f.idx)],
  }));
}

function entityBody(entity: (typeof ENTITIES)[number], facts: ExactFact[], mode: 'verbatim' | 'summarize'): string {
  const others = ENTITIES.filter((e) => e.page !== entity.page).map((e) => `[[${e.page}]]`);
  const lines = [entity.summary, ''];
  for (const f of facts) lines.push(mode === 'verbatim' ? `- \`${f.fact}\`` : `- ${f.paraphrase}`);
  lines.push('', `Related: ${others.join(', ')}.`, '');
  return lines.join('\n');
}

/** One-writer-per-entity oracle. */
export function factsOracle(story: FactsStory, mode: 'verbatim' | 'summarize'): Oracle {
  const claims = factClaims(story, mode);
  return {
    extract: ({ step }) => ({ claims: claimsForStep(step, claims) }),
    outline: () => ({
      targets: ENTITIES.map((e) => ({ page: e.page, op: 'create', reason: `one page per entity: ${e.title}` })),
    }),
    write_page: ({ step }) => {
      const t = writeTarget(step);
      const entity = ENTITIES.find((e) => e.page === t.page);
      if (!entity) throw new Error(`unexpected write_page target ${t.page}`);
      const facts = story.facts.filter((f) => f.entity === entity.page);
      return {
        op: {
          op: t.op,
          page: t.page,
          body: entityBody(entity, facts, mode),
          meta: { title: entity.title, kind: 'fact', volatile: false, confidence: 'verified' },
          sources: facts.map((f) => ref(f.harness, f.session, f.idx)),
          reason: 'single writer for this entity',
        },
      };
    },
    thread_state: () => ({
      body: threadBody('Configure config, deploy and redis for previews.', '- Config, deploy and redis commands noted.', ENTITIES.map((e) => e.page)),
    }),
  };
}

async function runFacts(ctx: Parameters<Scenario['run']>[0], mode: 'verbatim' | 'summarize'): Promise<void> {
  const p = await ctx.project(mode);
  const story = factsStory(p.projectDir);
  p.sessions = story.sessions;
  ctx.check('story carries 12 exact facts', story.facts.length === 12, String(story.facts.length));
  const r = await ctx.drive(p, factsOracle(story, mode));
  ctx.check('drive completed without rejections', r.rejections.length === 0, r.rejections.map((x) => `${x.label}: ${x.reason}`).join(' | '));
  ctx.check('commit applied', r.commit?.outcome === 'applied', `outcome=${r.commit?.outcome} ${r.commit?.stagedReason ?? ''}`);
  ctx.check(
    'all four entity pages created',
    ENTITIES.every((e) => r.commit?.summary.created.includes(e.page)),
    `created=${r.commit?.summary.created.join(', ')}`,
  );

  const text = await readAllMemoryText(p.dreamDir);
  const retained = story.facts.filter((f) => text.includes(f.fact));
  ctx.note(`${mode}: ${retained.length}/${story.facts.length} facts retained verbatim`);

  const pages = await Promise.all(ENTITIES.map((e) => p.page(e.page)));
  const conf = pages.map((pg, i) => `${ENTITIES[i]?.page}=${pg?.meta.confidence}`).join(', ');
  if (mode === 'verbatim') {
    ctx.check(
      'all 12 facts present verbatim in pages',
      retained.length === story.facts.length,
      `missing: ${story.facts.filter((f) => !retained.includes(f)).map((f) => f.fact).join(' | ')}`,
    );
    ctx.check('each fact lives on its entity page', story.facts.every((f) => pages[ENTITIES.findIndex((e) => e.page === f.entity)]?.body.includes(f.fact)));
    ctx.check('verbatim pages stay verified', pages.every((pg) => pg?.meta.confidence === 'verified'), conf);
    ctx.check(
      'sessions from all three harnesses were read',
      ['claude-code', 'codex', 'opencode'].every((h) => pages.some((pg) => pg?.meta.sources.some((x) => x.harness === h))),
    );
  } else {
    ctx.check('paraphrased facts are not present verbatim (retention loss measured)', retained.length < story.facts.length, `${retained.length}/12`);
    ctx.check('pages built on paraphrased "verbatim" facts are unverified', pages.every((pg) => pg?.meta.confidence === 'unverified'), conf);
  }
}

export const factRetentionVerbatim: Scenario = {
  id: 'fact-retention-verbatim',
  plan: '#2',
  title: '12 exact facts across 3 harnesses survive verbatim (one writer per entity)',
  run: (ctx) => runFacts(ctx, 'verbatim'),
};

export const factRetentionSummarize: Scenario = {
  id: 'fact-retention-summarize',
  plan: '#2',
  title: 'Paraphrased "verbatim" facts are downgraded to unverified',
  run: (ctx) => runFacts(ctx, 'summarize'),
};
