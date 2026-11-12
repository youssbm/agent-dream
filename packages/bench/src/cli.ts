/**
 * dream-bench CLI (dev tool; console output is fine here).
 *
 *   node packages/bench/src/cli.ts [--only id,id] [--keep] [--json] [--verbose]
 *
 * Runs the scripted scenarios with networking blocked and prints the results table to stdout.
 * Exit code 1 when any scenario fails.
 */
import '../../../scripts/no-network-guard.ts';
import { failureDetails, formatTable, runAll, SCENARIOS } from './run.ts';

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'dream-bench: scripted dream scenarios against the real engine (no LLM, no network).\n' +
        '  --only <id,id>  run only these scenarios\n  --keep          keep temp project dirs\n' +
        '  --json          print JSON results\n  --verbose       print every check\n' +
        `scenarios: ${SCENARIOS.map((s) => s.id).join(', ')}\n`,
    );
    return 0;
  }
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? '').split(',').filter(Boolean) : undefined;
  const results = await runAll({ keep: argv.includes('--keep'), only });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    process.stdout.write(formatTable(results) + '\n');
    for (const r of results) {
      if (argv.includes('--verbose')) {
        process.stdout.write(`\n## ${r.id} (${r.durationMs} ms)\n`);
        for (const c of r.checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.label}${!c.ok && c.detail ? ` — ${c.detail}` : ''}\n`);
        if (r.error) process.stdout.write(`error: ${r.error}\n`);
      } else if (!r.pass) {
        process.stderr.write(`\n${r.id}:\n  ${failureDetails(r).join('\n  ')}\n`);
      }
    }
  }
  return results.every((r) => r.pass) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`dream-bench crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 2;
  },
);
