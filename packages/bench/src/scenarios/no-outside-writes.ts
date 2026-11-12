/**
 * PLAN §9 #9 — no outside calls.
 *
 * Network use is blocked process-wide by `scripts/no-network-guard.ts` (vitest setup file; also imported by the
 * bench CLI), so any connection attempt fails the run. This scenario adds the filesystem half: a full dream plus
 * every memory tool writes nothing outside `<project>/.dream/` — the rest of the project and the (fake) home dir
 * are byte-identical before and after.
 *
 * Also checks redaction on the write path: a secret the model copies into a page never reaches disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Scenario } from '../harness.ts';
import { writeTarget } from '../oracle.ts';
import { portStory } from '../transcripts.ts';
import { diffTrees, readAllMemoryText, snapshotTree } from './common.ts';
import { plantedErrorOracle } from './planted-error.ts';

/** Synthetic, pattern-shaped fake credentials (not real keys). */
const FAKE_AWS_KEY = 'AKIA' + 'BENCHFAKEKEY0000';
const FAKE_GH_TOKEN = 'ghp_' + 'benchFakeToken0000000000000000000000';

export const noOutsideWrites: Scenario = {
  id: 'no-outside-writes',
  plan: '#9',
  title: 'Nothing is written outside .dream/; secrets are redacted on write',
  async run(ctx) {
    const p = await ctx.project('main');
    const s = portStory(p.projectDir);
    p.sessions = s.sessions;

    // A realistic project and home dir to watch.
    await fs.mkdir(path.join(p.projectDir, 'src', 'pages'), { recursive: true });
    await fs.writeFile(path.join(p.projectDir, 'package.json'), '{ "name": "larkspur-web", "private": true }\n');
    await fs.writeFile(path.join(p.projectDir, 'src', 'pages', 'Login.tsx'), 'export const Login = () => null;\n');
    await fs.mkdir(path.join(p.homeDir, '.claude', 'projects'), { recursive: true });
    await fs.writeFile(path.join(p.homeDir, '.claude', 'settings.json'), '{}\n');
    await fs.mkdir(path.join(p.homeDir, '.codex'), { recursive: true });
    await fs.writeFile(path.join(p.homeDir, '.codex', 'config.toml'), '# fake\n');

    const projBefore = await snapshotTree(p.projectDir, ['.dream']);
    const homeBefore = await snapshotTree(p.homeDir);

    const base = plantedErrorOracle(s, { correct: false });
    const r = await ctx.drive(p, {
      ...base,
      outline: () => ({
        targets: [
          { page: 'dev-server', op: 'create', reason: 'dev server facts' },
          { page: 'login-form', op: 'create', reason: 'login form preference' },
        ],
      }),
      write_page: (call) => {
        const t = writeTarget(call.step);
        const out = base.write_page?.(call) as { op: { body: string } };
        if (t.page === 'dev-server') {
          out.op.body += `\nDeploy credentials seen in a log: AWS_ACCESS_KEY_ID ${FAKE_AWS_KEY}, token ${FAKE_GH_TOKEN}\n`;
        }
        return out;
      },
    });
    ctx.check('commit applied', r.commit?.outcome === 'applied', `outcome=${r.commit?.outcome}`);

    // Exercise the read/note tools too.
    const svc = p.service();
    await svc.memoryIndex();
    await svc.memorySearch('dev server', { includeTranscripts: true });
    await svc.memoryRead('dev-server');
    await svc.memoryNote('Bench note: nothing to see.', { harness: s.harness, session: s.session });
    await svc.memoryStatus();
    await svc.listSessions({});
    await svc.serverInstructions();

    const projAfter = await snapshotTree(p.projectDir, ['.dream']);
    const homeAfter = await snapshotTree(p.homeDir);
    const projDiff = diffTrees(projBefore, projAfter);
    const homeDiff = diffTrees(homeBefore, homeAfter);
    ctx.check('project files outside .dream/ untouched', projDiff.length === 0, projDiff.join(', '));
    ctx.check('home dir untouched', homeDiff.length === 0, homeDiff.join(', '));
    const top = (await fs.readdir(p.projectDir)).sort();
    ctx.check('only .dream/ was added to the project root', top.join(',') === ['.dream', 'package.json', 'src'].join(','), top.join(','));
    const rootEntries = (await fs.readdir(p.root)).sort();
    ctx.check('nothing written next to the project', rootEntries.join(',') === 'home,project', rootEntries.join(','));

    const all = await readAllMemoryText(p.dreamDir);
    ctx.check('fake AWS key redacted before write', !all.includes(FAKE_AWS_KEY), FAKE_AWS_KEY);
    ctx.check('fake GitHub token redacted before write', !all.includes(FAKE_GH_TOKEN));
    ctx.check('redaction marker present', all.includes('[REDACTED'));
    const sources = (await p.page('dev-server'))?.meta.sources ?? [];
    ctx.check('page cites its transcript source', sources.some((x) => x.session === s.session), JSON.stringify(sources));
  },
};
