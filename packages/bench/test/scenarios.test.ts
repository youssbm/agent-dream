/**
 * Runs every scripted dream-bench scenario against the real DreamService (no LLM; network blocked by the
 * vitest setup file).
 */
import { describe, expect, it } from 'vitest';
import { failureDetails, formatTable, runScenario, SCENARIOS } from '../src/run.ts';
import type { ScenarioResult } from '../src/run.ts';

const results: ScenarioResult[] = [];

describe('dream-bench scripted scenarios', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.plan} ${scenario.id}: ${scenario.title}`, async () => {
      const r = await runScenario(scenario);
      results.push(r);
      expect(failureDetails(r), formatTable([r])).toEqual([]);
      expect(r.pass).toBe(true);
    }, 60_000);
  }

  it('renders a results table', () => {
    const table = formatTable(results);
    expect(table).toContain('| Scenario | PLAN | Result |');
    for (const r of results) expect(table).toContain(`| ${r.id} |`);
  });
});
