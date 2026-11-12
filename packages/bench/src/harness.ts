/**
 * Scenario plumbing: temp projects, fake adapters, seeding memory, checks and stats.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DreamService, MemoryStore, serializePage } from '@agent-dream/core';
import type { DreamConfig, IDreamService, Page, PageMeta } from '@agent-dream/core';
import { fakeAdapters } from './fake-adapter.ts';
import type { FakeAdapter, FakeSession } from './fake-adapter.ts';
import { drive, DriveError, formatTrace } from './oracle.ts';
import type { DriveOptions, DriveResult, Oracle } from './oracle.ts';

/** Fixed clock for every scenario (memory dates are deterministic). */
export const BENCH_NOW = '2026-11-11T12:00:00.000Z';

/** A page to pre-seed into `.dream/` before the dream runs. */
export interface SeedPage {
  name: string;
  body: string;
  meta?: Partial<PageMeta>;
}

/** One temp project with its own fake home dir and fake transcript stores. */
export interface BenchProject {
  readonly label: string;
  readonly root: string;
  readonly projectDir: string;
  readonly homeDir: string;
  readonly dreamDir: string;
  sessions: FakeSession[];
  /** Adapters handed to the most recent service (call log for assertions). */
  adapters: FakeAdapter[];
  /** A brand-new DreamService over this project (same adapters content, fresh instances). */
  service(): IDreamService;
  store(): MemoryStore;
  /** Write pages + index through the real store (one history entry). */
  seed(pages: SeedPage[], index: string): Promise<void>;
  /** Merge fields into `.dream/config.json`. */
  writeConfig(partial: Partial<DreamConfig>): Promise<void>;
  page(name: string): Promise<Page | null>;
  index(): Promise<string>;
}

export interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

/** Context passed to a scenario's `run`. */
export interface ScenarioContext {
  /** Create a temp project (optionally with sessions; they can also be assigned later). */
  project(label: string, sessions?: (projectDir: string) => FakeSession[]): Promise<BenchProject>;
  /** Record a pass/fail check. */
  check(label: string, ok: boolean, detail?: string): void;
  /** Drive a dream job with an oracle and record its stats. */
  drive(p: BenchProject, oracle: Oracle, opts?: DriveOptions): Promise<DriveResult>;
  /** Count steps/tokens of a manually driven job. */
  record(steps: number, tokens: number): void;
  /** Free-text note for the results table. */
  note(text: string): void;
}

export interface Scenario {
  /** Short id, e.g. "planted-error". */
  id: string;
  /** PLAN §9 test number(s) covered, e.g. "#1". */
  plan: string;
  title: string;
  run(ctx: ScenarioContext): Promise<void>;
}

export interface ScenarioResult {
  id: string;
  plan: string;
  title: string;
  pass: boolean;
  checks: Check[];
  notes: string[];
  error?: string;
  steps: number;
  tokens: number;
  rejections: number;
  durationMs: number;
}

const DEFAULT_META: PageMeta = {
  title: '',
  kind: 'fact',
  volatile: false,
  confidence: 'verified',
  verified_at: '2026-10-01',
  sources: [],
  links: [],
};

/** Create a temp project; returns it plus a cleanup function. */
export async function createProject(label: string, sessions: FakeSession[] = []): Promise<{ project: BenchProject; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dream-bench-${label}-`));
  const projectDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  const now = (): Date => new Date(BENCH_NOW);

  const project: BenchProject = {
    label,
    root,
    projectDir,
    homeDir,
    dreamDir: path.join(projectDir, '.dream'),
    sessions,
    adapters: [],
    service() {
      this.adapters = fakeAdapters(this.sessions);
      return new DreamService({ projectDir, homeDir, adapters: this.adapters, now });
    },
    store() {
      return new MemoryStore(projectDir, { now });
    },
    async seed(pages, index) {
      const store = this.store();
      await store.init();
      const changes = pages.map((p) => {
        const meta: PageMeta = { ...DEFAULT_META, title: p.name.replace(/-/g, ' '), ...p.meta };
        const page: Page = { name: p.name, meta, body: p.body };
        return { type: 'write' as const, path: store.pagePath(p.name), content: serializePage(page) };
      });
      changes.push({ type: 'write', path: 'MEMORY.md', content: index });
      await store.applyChanges(changes, 'bench: seed memory');
    },
    async writeConfig(partial) {
      const store = this.store();
      await store.init();
      const file = path.join(this.dreamDir, 'config.json');
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      } catch {
        current = {};
      }
      await fs.writeFile(file, JSON.stringify({ ...current, ...partial }, null, 2) + '\n', 'utf8');
    },
    async page(name) {
      return this.store().readPage(name);
    },
    async index() {
      return this.store().readIndex();
    },
  };
  const cleanup = async (): Promise<void> => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { project, cleanup };
}

/** Options for running scenarios. */
export interface RunOptions {
  /** Keep temp dirs for inspection (default false). */
  keep?: boolean;
}

/** Run one scenario: never throws; failures become a failed result. */
export async function runScenario(scenario: Scenario, opts: RunOptions = {}): Promise<ScenarioResult> {
  const started = Date.now();
  const checks: Check[] = [];
  const notes: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  let steps = 0;
  let tokens = 0;
  let rejections = 0;
  let error: string | undefined;

  const ctx: ScenarioContext = {
    async project(label, sessions) {
      const { project, cleanup } = await createProject(`${scenario.id}-${label}`);
      cleanups.push(cleanup);
      if (sessions) project.sessions = sessions(project.projectDir);
      return project;
    },
    check(label, ok, detail) {
      checks.push(detail === undefined ? { label, ok } : { label, ok, detail });
    },
    async drive(p, oracle, driveOpts) {
      try {
        const r = await drive(p.service(), oracle, driveOpts);
        steps += r.stepsHandedOut;
        tokens += r.tokens;
        rejections += r.rejections.length;
        return r;
      } catch (e) {
        if (e instanceof DriveError) throw new Error(`${e.message}\ntrace: ${formatTrace(e.trace)}`);
        throw e;
      }
    },
    record(s, t) {
      steps += s;
      tokens += t;
    },
    note(text) {
      notes.push(text);
    },
  };

  try {
    await scenario.run(ctx);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    if (!opts.keep) for (const c of cleanups) await c().catch(() => undefined);
  }
  const pass = !error && checks.length > 0 && checks.every((c) => c.ok);
  const result: ScenarioResult = {
    id: scenario.id,
    plan: scenario.plan,
    title: scenario.title,
    pass,
    checks,
    notes,
    steps,
    tokens,
    rejections,
    durationMs: Date.now() - started,
  };
  if (error) result.error = error;
  return result;
}
