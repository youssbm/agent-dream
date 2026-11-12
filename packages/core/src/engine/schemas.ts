/**
 * Zod schemas for every model-driven dream step, and their JSON Schema form (`StepSpec.outputSchema`).
 *
 * The schemas validate *shape* only. Semantic checks (sessions in the job, msgs ranges, evidence quotes,
 * page existence, caps) live in `validate.ts`.
 */
import { z } from 'zod';
import type { StepName } from '../types.ts';

const harness = z.enum(['claude-code', 'codex', 'opencode']);

/** `msgs` is "40" or "40-52" (message idx values from the `[#idx]` markers). */
export const sourceRefSchema = z
  .object({
    harness,
    session: z.string().min(1),
    msgs: z.string().regex(/^\d+(-\d+)?$/, 'msgs must look like "40" or "40-52"'),
  })
  .strict();

const stepField = z.number().int().describe('Required: echo of the current step index (StepSpec.index), so a retried submission is never applied twice.');

const pageName = z.string().min(1).max(80);

export const claimSchema = z
  .object({
    text: z.string().min(1).max(2000),
    kind: z.enum(['fact', 'decision', 'rule', 'failure', 'preference', 'open_item', 'trap']),
    verbatim: z.boolean().optional(),
    volatile: z.boolean().optional(),
    sources: z.array(sourceRefSchema).max(10),
  })
  .strict();

export const verdictSchema = z
  .object({
    page: pageName,
    verdict: z.enum(['keep', 'correct', 'unverified', 'delete']),
    evidence: z.object({ quote: z.string(), source: sourceRefSchema }).strict().optional(),
    corrected: z.string().min(1).max(2000).optional(),
    reason: z.string().max(1000).optional(),
  })
  .strict();

export const patternSchema = z
  .object({
    text: z.string().min(1).max(2000),
    kind: z.enum(['recurring_failure', 'repeated_correction', 'stable_preference', 'contradiction']),
    sources: z.array(sourceRefSchema).max(20),
  })
  .strict();

const opKind = z.enum(['create', 'update', 'delete', 'rename', 'merge']);

export const outlineTargetSchema = z
  .object({
    page: pageName,
    op: opKind,
    reason: z.string().min(1).max(500),
    into: pageName.optional().describe('rename: the new name; merge: the page this one is folded into.'),
    claims: z.array(z.string()).max(50).optional().describe('Ids of the claims this page should hold, e.g. ["c1","c4"].'),
  })
  .strict();

export const pageOpSchema = z
  .object({
    op: opKind,
    page: pageName,
    body: z.string().max(40_000).optional(),
    meta: z
      .object({
        title: z.string().min(1).max(200).optional(),
        kind: z.enum(['fact', 'rule', 'decision', 'howto', 'trap', 'preference', 'overview']).optional(),
        volatile: z.boolean().optional(),
        confidence: z.enum(['verified', 'unverified']).optional(),
      })
      .strict()
      .optional(),
    into: pageName.optional(),
    sources: z.array(sourceRefSchema).max(40),
    reason: z.string().min(1).max(1000),
  })
  .strict();

/** Output schemas per model-driven step. */
export const stepOutputSchemas = {
  extract: z.object({ step: stepField, claims: z.array(claimSchema).max(60) }).strict(),
  verify: z.object({ step: stepField, verdicts: z.array(verdictSchema).max(20) }).strict(),
  patterns: z.object({ step: stepField, patterns: z.array(patternSchema).max(20) }).strict(),
  outline: z.object({ step: stepField, targets: z.array(outlineTargetSchema).max(12) }).strict(),
  write_page: z.object({ step: stepField, op: pageOpSchema }).strict(),
  gap_fill: z.object({ step: stepField, ops: z.array(pageOpSchema).max(10) }).strict(),
  thread_state: z
    .object({ step: stepField, body: z.string().min(1).max(40_000), title: z.string().min(1).max(200).optional() })
    .strict(),
  promote: z.object({ step: stepField, index: z.string().min(1).max(200_000) }).strict(),
} as const;

export type ModelStepName = keyof typeof stepOutputSchemas;
export type StepOutput<N extends ModelStepName> = z.infer<(typeof stepOutputSchemas)[N]>;

export const MODEL_STEPS: readonly ModelStepName[] = Object.keys(stepOutputSchemas) as ModelStepName[];

/** True for steps the model performs (as opposed to server-only steps like plan/commit). */
export function isModelStep(name: StepName): name is ModelStepName {
  return name in stepOutputSchemas;
}

/** Drop the safe-integer bounds zod adds to every `.int()` (pure noise for the model). */
function stripNoise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNoise);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'minimum' || k === 'maximum') && Math.abs(Number(x)) === Number.MAX_SAFE_INTEGER) continue;
      out[k] = stripNoise(x);
    }
    return out;
  }
  return v;
}

const jsonSchemaCache = new Map<ModelStepName, Record<string, unknown>>();

/** JSON Schema (draft 2020-12) of the `output` argument for `dream_step` at this step. */
export function outputJsonSchema(name: ModelStepName): Record<string, unknown> {
  let cached = jsonSchemaCache.get(name);
  if (!cached) {
    cached = stripNoise(z.toJSONSchema(stepOutputSchemas[name], { io: 'input' })) as Record<string, unknown>;
    delete cached.$schema;
    jsonSchemaCache.set(name, cached);
  }
  return structuredClone(cached);
}

/**
 * Lenient pre-pass applied before schema validation: accepts output passed as a JSON string, and numeric
 * `msgs` values (40 → "40"). Returns a new value; never throws.
 */
export function normalizeOutput(output: unknown): unknown {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return output;
    }
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'msgs' && typeof x === 'number') out[k] = String(x);
        else if (k === 'msgs' && typeof x === 'string') out[k] = x.replace(/\s+/g, '').replace(/^#/, '');
        else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Result of parsing a step output. */
export type ParseResult<N extends ModelStepName> =
  | { ok: true; value: StepOutput<N> }
  | { ok: false; issues: string[] };

/** Validate `output` against the step's schema; issues are short `path: message` strings. */
export function parseStepOutput<N extends ModelStepName>(name: N, output: unknown): ParseResult<N> {
  const schema = stepOutputSchemas[name];
  const res = schema.safeParse(normalizeOutput(output));
  if (res.success) return { ok: true, value: res.data as StepOutput<N> };
  const issues = res.error.issues.slice(0, 20).map((i) => {
    const path = i.path.length ? i.path.join('.') : '(output)';
    return `${path}: ${i.message}`;
  });
  return { ok: false, issues };
}
