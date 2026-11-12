/**
 * Cheap salience heuristics: flag messages the model should look at first when extracting claims
 * (PLAN §4.1 "pre-select candidate spans"). False positives are fine; the model decides.
 */
import type { TranscriptMessage } from '../types.ts';

/** User pushing back on something the agent said or did. */
const CORRECTION = /(?:^|[\s"'(])(?:no[,.!]|nope\b|actually\b|that'?s (?:not right|wrong|incorrect)|that is (?:not right|wrong|incorrect)|not what i (?:asked|meant|said)|wrong\b|incorrect\b|don'?t\b|do not\b|stop\b|instead\b|rather than\b|you (?:missed|forgot)\b)/i;
/** Durable preferences and standing instructions. */
const PREFERENCE = /\b(?:always|never|prefer(?:s|red)?|remember|from now on|going forward|make sure (?:to|you)|please use|we use|i (?:like|want) (?:it|you|to))\b/i;
/** Decisions taken in the conversation (user or assistant). */
const DECISION = /\b(?:let'?s (?:go with|use|do|stick with|keep)|let us (?:go with|use)|we(?:'ll| will) (?:go with|use)|(?:i|we)(?:'ve| have)? decided|decided to|decision:|going with|settled on|chose to|agreed (?:to|on))\b/i;
/** Failures in tool output. */
const FAILURE = /(?:\b(?:error|errors|exception|failed|failure|failing|fatal|traceback|panic(?:ked)?|segmentation fault|not found|cannot find|permission denied|denied)\b|\b[A-Za-z]+(?:Error|Exception)\b|ERR!|\[error\]|exit (?:code|status):? *[1-9]\d*|exited with (?:code )?[1-9]\d*|returned non-zero|command not found)/i;
/** Test-run summaries (pass or fail counts). */
const TEST_OUTCOME = /\b\d+\s+(?:passed|failed|failing|passing|skipped|errors?)\b|\btests?:\s+\d+|\b(?:PASS|FAIL)\s+\S+\.(?:test|spec)\.|\bOK \(\d+ tests?\)|\bRan \d+ tests?\b/;

function textOf(m: TranscriptMessage, kinds: readonly string[]): string {
  return m.parts
    .filter((p) => kinds.includes(p.kind))
    .map((p) => p.text)
    .join('\n')
    .replace(/[‘’ʼ]/g, "'");
}

/** Whether one message looks salient. */
export function isCandidate(m: TranscriptMessage): boolean {
  if (m.role === 'user') {
    const t = textOf(m, ['text']);
    if (CORRECTION.test(t) || PREFERENCE.test(t) || DECISION.test(t)) return true;
  }
  if (m.role === 'assistant' && DECISION.test(textOf(m, ['text']))) return true;
  const results = textOf(m, ['tool_result']);
  if (results && (FAILURE.test(results) || TEST_OUTCOME.test(results))) return true;
  return false;
}

/** `idx` of messages likely to contain salient information, in input order. */
export function findCandidates(msgs: TranscriptMessage[]): number[] {
  return msgs.filter(isCandidate).map((m) => m.idx);
}
