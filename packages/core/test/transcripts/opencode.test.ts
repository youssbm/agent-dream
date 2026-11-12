import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpencodeAdapter } from '../../src/transcripts/opencode.ts';
import { IDS, STORY, buildOpencodeDb, findMsg, tempDir, textOf } from './helpers.ts';

describe('OpencodeAdapter', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let dbPath: string;
  let adapter: OpencodeAdapter;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    dbPath = await buildOpencodeDb(path.join(dir, '.local', 'share', 'opencode', 'opencode.db'));
    adapter = new OpencodeAdapter({ homeDir: dir });
  });
  afterAll(() => cleanup());

  it('finds the database under the home dir and reports availability', async () => {
    expect(adapter.dbPath).toBe(dbPath);
    expect(await adapter.available()).toBe(true);
    const missing = new OpencodeAdapter({ dbPath: path.join(dir, 'missing.db') });
    expect(await missing.available()).toBe(false);
    expect(await missing.listSessions()).toEqual([]);
    await expect(missing.readSession('ses_x')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('reports unavailable for a file that is not an opencode database', async () => {
    const bogus = path.join(dir, 'bogus.db');
    await fsp.writeFile(bogus, 'not sqlite');
    expect(await new OpencodeAdapter({ dbPath: bogus }).available()).toBe(false);
  });

  it('lists v1 and v2 sessions newest first, without child sessions', async () => {
    const all = await adapter.listSessions();
    expect(all.map((s) => s.id)).toEqual([IDS.opencode.other, IDS.opencode.v2, IDS.opencode.v1, IDS.opencode.parts]);
    expect(all.find((s) => s.id === IDS.opencode.v2)).toMatchObject({
      harness: 'opencode',
      cwd: STORY.cwd,
      title: 'Dev server port (v2)',
      startedAt: '2026-05-01T09:00:00.000Z',
      updatedAt: '2026-05-01T09:40:00.000Z',
      location: dbPath,
    });
    // Rows ≠ normalized messages, so no (misleading) count is reported.
    expect(all.every((s) => s.messageCount === undefined)).toBe(true);
    const withChildren = await new OpencodeAdapter({ dbPath, includeChildren: true }).listSessions();
    expect(withChildren.map((s) => s.id)).toContain(IDS.opencode.child);
  });

  it('filters by cwd, since and limit', async () => {
    expect((await adapter.listSessions({ cwd: STORY.cwd })).map((s) => s.id)).toEqual([IDS.opencode.v2, IDS.opencode.v1]);
    expect((await adapter.listSessions({ cwd: 'C:\\users\\dev\\projects\\demo-app' })).map((s) => s.id)).toEqual([IDS.opencode.parts]);
    expect((await adapter.listSessions({ since: '2026-05-01T09:35:00Z' })).map((s) => s.id)).toEqual([IDS.opencode.other, IDS.opencode.v2]);
    expect((await adapter.listSessions({ limit: 1 })).map((s) => s.id)).toEqual([IDS.opencode.other]);
  });

  it('normalizes a v1 session (message + part tables)', async () => {
    const msgs = await adapter.readSession(IDS.opencode.v1);
    expect(msgs.map((m) => m.idx)).toEqual(msgs.map((_, i) => i));
    expect(msgs.map((m) => m.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user', 'system',
      'assistant', 'user', 'assistant', 'tool', 'assistant', 'system',
    ]);
    expect(msgs[1]!.parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(msgs[1]!.parts[2]).toMatchObject({ tool: 'read', text: JSON.stringify({ filePath: `${STORY.cwd}/package.json` }) });
    expect(msgs[2]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'read', text: STORY.packageJson });
    expect(textOf(msgs[3])).toBe(STORY.wrongClaim);
    expect(msgs[6]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'bash', text: STORY.devOutput });
    expect(textOf(msgs[8])).toBe(STORY.correction);
    expect(textOf(msgs[9])).toContain('Called the Read tool'); // synthetic part → system
    expect(textOf(msgs[13]).startsWith('[error] FAIL')).toBe(true);
    expect(msgs[14]!.parts.map((p) => p.kind)).toEqual(['other', 'text', 'other']);
    expect(textOf(msgs[14])).toContain('[patch]');
    expect(textOf(msgs[14])).toContain('[error] APIError: overloaded');
    expect(textOf(msgs[15])).toMatch(/^\[compaction summary\]/);
    expect(msgs[0]!.ts).toBe('2026-05-01T09:01:00.000Z');
  });

  it('prefers v2 rows (session_message) over a stale v1 copy', async () => {
    const msgs = await adapter.readSession(IDS.opencode.v2);
    expect(msgs.some((m) => textOf(m).includes('STALE V1'))).toBe(false);
    expect(msgs.map((m) => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user',
      'assistant', 'user', 'assistant', 'tool', 'assistant', 'tool', 'system',
    ]);
    expect(msgs[2]!.parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(msgs[3]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'read', text: STORY.packageJson });
    expect(msgs[7]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'bash', text: STORY.devOutput });
    expect(msgs[9]!.parts).toEqual([
      { kind: 'text', text: STORY.correction },
      { kind: 'file', text: '[file screenshot.png (image/png)]' },
    ]);
    expect(textOf(msgs[13]).startsWith('[error] FAIL')).toBe(true);
    expect(msgs[15]!.parts[0]).toMatchObject({ kind: 'tool_result', tool: 'subagent' });
    expect(textOf(msgs[16])).toContain('The dev server port is 5173.');
  });

  it('reads assistant content from session_part rows when not inline', async () => {
    const msgs = await adapter.readSession(IDS.opencode.parts);
    expect(msgs.map((m) => [m.role, textOf(m)])).toEqual([
      ['user', 'Which port does the dev server use?'],
      ['assistant', 'npm run dev'],
      ['tool', 'listening on :5173'],
      ['assistant', 'It listens on port 5173.'],
    ]);
  });

  it('reads child sessions directly and rejects unknown ids', async () => {
    expect(findMsg(await adapter.readSession(IDS.opencode.child), 'CHILD')).toBeDefined();
    await expect(adapter.readSession('ses_nope')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('never writes to the database', async () => {
    const before = await fsp.stat(dbPath);
    const bytes = await fsp.readFile(dbPath);
    await adapter.listSessions();
    await adapter.readSession(IDS.opencode.v2);
    const after = await fsp.stat(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await fsp.readFile(dbPath)).equals(bytes)).toBe(true);
  });

  it('retries briefly while the database is locked, then succeeds', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const writer = new DatabaseSync(dbPath);
    // A pending write (creates the -journal side file, so the reader uses a locking connection).
    writer.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE lock_probe (x);');
    await expect(new OpencodeAdapter({ dbPath, busyRetryMs: 0 }).listSessions()).rejects.toThrow(/locked|busy/i);
    const reading = new OpencodeAdapter({ dbPath, busyRetryMs: 3000 }).listSessions();
    setTimeout(() => {
      writer.exec('COMMIT;');
      writer.close();
    }, 150);
    expect((await reading).length).toBeGreaterThan(0);
  });

  it('leaves no -wal/-shm files behind on a WAL database when opencode is not running', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const wal = path.join(dir, 'wal', 'opencode.db');
    await buildOpencodeDb(wal);
    const w = new DatabaseSync(wal);
    w.exec('PRAGMA journal_mode = WAL;');
    w.close(); // last connection: checkpoints and removes its side files
    const side = async (): Promise<string[]> => (await fsp.readdir(path.dirname(wal))).filter((n) => n !== 'opencode.db').sort();
    expect(await side()).toEqual([]);
    const a = new OpencodeAdapter({ dbPath: wal });
    expect(await a.available()).toBe(true);
    expect((await a.listSessions()).length).toBeGreaterThan(0);
    expect((await a.readSession(IDS.opencode.v1)).length).toBeGreaterThan(0);
    expect(await side()).toEqual([]);

    // While opencode is running (side files exist) the reader also sees rows still only in the WAL.
    const running = new DatabaseSync(wal);
    running.exec(`PRAGMA wal_autocheckpoint = 0; UPDATE session SET title = 'Renamed live' WHERE id = '${IDS.opencode.v1}';`);
    try {
      expect(await side()).toEqual(['opencode.db-shm', 'opencode.db-wal']);
      const live = await a.listSessions();
      expect(live.find((s) => s.id === IDS.opencode.v1)?.title).toBe('Renamed live');
    } finally {
      running.close();
    }
  });
});
