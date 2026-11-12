/**
 * dream-bench runner: runs scripted scenarios against the real `DreamService` and renders a results table.
 */
import { runScenario } from './harness.ts';
import type { RunOptions, Scenario, ScenarioResult } from './harness.ts';
import { SCENARIOS } from './scenarios/index.ts';

export { runScenario };
export type { RunOptions, Scenario, ScenarioResult };
export { SCENARIOS };

/** Run every scripted scenario (sequentially; each uses its own temp project). */
export async function runAll(opts: RunOptions & { only?: string[] } = {}): Promise<ScenarioResult[]> {
  const picked = opts.only?.length ? SCENARIOS.filter((s) => opts.only?.includes(s.id)) : SCENARIOS;
  const results: ScenarioResult[] = [];
  for (const s of picked) results.push(await runScenario(s, opts));
  return results;
}

/** Failure details of a result: failed checks and the error, one per line. */
export function failureDetails(r: ScenarioResult): string[] {
  const lines = r.checks.filter((c) => !c.ok).map((c) => `✗ ${c.label}${c.detail ? ` — ${c.detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (r.error) lines.push(`error: ${r.error}`);
  if (!r.error && r.checks.length === 0) lines.push('no checks recorded');
  return lines;
}

/** Markdown results table: scenario, PLAN ref, pass/fail, checks, steps, tokens, rejections, details. */
export function formatTable(results: ScenarioResult[]): string {
  const rows = [
    '| Scenario | PLAN | Result | Checks | Steps | Tokens | Rejections | Details |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const passed = r.checks.filter((c) => c.ok).length;
    const details = r.pass ? r.notes.join('; ') : [...failureDetails(r), ...r.notes].join('; ');
    rows.push(
      `| ${r.id} | ${r.plan} | ${r.pass ? 'PASS' : 'FAIL'} | ${passed}/${r.checks.length} | ${r.steps} | ${r.tokens} | ${r.rejections} | ${details.replace(/\|/g, '\\|').slice(0, 600)} |`,
    );
  }
  const ok = results.filter((r) => r.pass).length;
  rows.push('', `${ok}/${results.length} scenarios passed.`);
  return rows.join('\n');
}
