/** All scripted dream-bench scenarios, in report order. */
import type { Scenario } from '../harness.ts';
import { factRetentionSummarize, factRetentionVerbatim } from './fact-retention.ts';
import { noOutsideWrites } from './no-outside-writes.ts';
import { plantedError } from './planted-error.ts';
import { poisoning } from './poisoning.ts';
import { protocolRobustness } from './protocol.ts';
import { safetyNet } from './safety-net.ts';
import { sizeDiscipline } from './size-discipline.ts';

export const SCENARIOS: readonly Scenario[] = [
  plantedError,
  factRetentionVerbatim,
  factRetentionSummarize,
  sizeDiscipline,
  poisoning,
  protocolRobustness,
  noOutsideWrites,
  safetyNet,
];
