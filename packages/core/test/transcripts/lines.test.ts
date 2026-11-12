import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, OMITTED_TYPE, isSafeId, mapPool, omittedNotice, parseJsonObject, readHeadRecords, readLines, readTailRecords, toIso, zstdSupported } from '../../src/transcripts/lines.ts';
import { CodexAdapter } from '../../src/transcripts/codex.ts';
import { compactArgs, contentText, isInjectedText, shellJoin } from '../../src/transcripts/normalize.ts';
import { tempDir } from './helpers.ts';

async function collect(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const l of readLines(file)) out.push(l);
  return out;
}

describe('readLines', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ dir, cleanup } = await tempDir()));
  afterAll(() => cleanup());

  it('splits on \\n only, strips \\r, skips blank lines, keeps U+2028 inside lines', async () => {
    const f = path.join(dir, 'a.jsonl');
    await fsp.writeFile(f, 'one\r\n\n  \ntwo still two too\nthree');
    expect(await collect(f)).toEqual(['one', 'two still two too', 'three']);
  });

  it('handles lines much longer than the read buffer and multibyte characters across chunks', async () => {
    const f = path.join(dir, 'b.jsonl');
    const big = 'é'.repeat(200_000) + '→' + 'x'.repeat(70_000);
    await fsp.writeFile(f, `${big}\nend\n`);
    const lines = await collect(f);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(big);
    expect(lines[1]).toBe('end');
  });

  it('stops reading when the consumer breaks', async () => {
    const f = path.join(dir, 'c.jsonl');
    await fsp.writeFile(f, Array.from({ length: 10_000 }, (_, i) => `{"i":${i}}`).join('\n'));
    const head = await readHeadRecords(f, 3);
    expect(head.records).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(head.complete).toBe(false);
    const all = await readHeadRecords(path.join(dir, 'a.jsonl'), 100);
    expect(all.complete).toBe(true);
  });

  it('reads parsed records from the tail, dropping the partial first line', async () => {
    const f = path.join(dir, 'd.jsonl');
    const content = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(50) })).join('\n') + '\n';
    await fsp.writeFile(f, content);
    const recs = await readTailRecords(f, Buffer.byteLength(content), 300);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[recs.length - 1]).toMatchObject({ i: 99 });
    expect(recs.every((r) => typeof r.i === 'number')).toBe(true);
    expect(await readTailRecords(f, 0)).toEqual([]);
  });

  it.runIf(zstdSupported())('decompresses .zst files', async () => {
    const f = path.join(dir, 'e.jsonl.zst');
    const compress = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
    await fsp.writeFile(f, compress(Buffer.from('{"a":1}\n{"b":2}\n')));
    expect(await collect(f)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('replaces over-long lines with an omitted-record notice (never buffering them) and continues', async () => {
    const f = path.join(dir, 'long.jsonl');
    await fsp.writeFile(f, `{"a":1}\n{"big":"${'x'.repeat(5000)}"}\r\n{"b":2}\n${'y'.repeat(3000)}`);
    const out: string[] = [];
    for await (const l of readLines(f, { maxLineChars: 1000 })) out.push(l);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe('{"a":1}');
    expect(out[2]).toBe('{"b":2}');
    const notice = parseJsonObject(out[1]!)!;
    expect(notice).toMatchObject({ type: OMITTED_TYPE, reason: 'line_too_long', chars: 5011 });
    expect(omittedNotice(notice)).toBe('[transcript record omitted: 5011 chars, too large to read]');
    expect(parseJsonObject(out[3]!)).toMatchObject({ type: OMITTED_TYPE, chars: 3000 });
    expect(omittedNotice({ type: 'user' })).toBeUndefined();
    // 'stop' mode ends the stream at the long line and reports it.
    const status: { limited?: boolean } = {};
    const stopped: string[] = [];
    for await (const l of readLines(f, { maxLineChars: 1000, onLongLine: 'stop', status })) stopped.push(l);
    expect(stopped).toEqual(['{"a":1}']);
    expect(status.limited).toBe(true);
  });

  it('caps the bytes read', async () => {
    const f = path.join(dir, 'cap.jsonl');
    await fsp.writeFile(f, Array.from({ length: 1000 }, (_, i) => `{"i":${i}}`).join('\n'));
    const out: string[] = [];
    for await (const l of readLines(f, { maxBytes: 100 })) out.push(l);
    expect(out.length).toBeLessThan(15);
    expect(parseJsonObject(out[out.length - 1]!)).toMatchObject({ type: OMITTED_TYPE, reason: 'size_limit', bytes: 100 });
    expect(omittedNotice(parseJsonObject(out[out.length - 1]!)!)).toMatch(/read limit of 100 bytes/);
  });

  it.runIf(zstdSupported())('survives a zstd decompression bomb (head and full reads stay bounded)', async () => {
    // ~80 MB of one JSON line, compressed to a few KB.
    const zdir = path.join(dir, 'bomb');
    await fsp.mkdir(zdir);
    const f = path.join(zdir, 'rollout-2026-05-01T09-00-00-dddd0001-0000-4000-8000-000000000001.jsonl.zst');
    const compress = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
    const body = Buffer.alloc(80 * 1024 * 1024, 0x61);
    Buffer.from('{"type":"session_meta","payload":{"id":"x","x":"').copy(body);
    await fsp.writeFile(f, compress(body));
    expect((await fsp.stat(f)).size).toBeLessThan(64 * 1024);

    const rssBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    const head = await readHeadRecords(f, 1);
    expect(head).toEqual({ records: [], complete: false });
    // Full read: the line is counted, not buffered; output stops at the ratio cap (64 MB floor for tiny files).
    const all = await collect(f);
    expect(all).toHaveLength(1);
    expect(parseJsonObject(all[0]!)).toMatchObject({ type: OMITTED_TYPE, reason: 'size_limit', bytes: LIMITS.fullMinBytes });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(400 * 1024 * 1024);
    expect(Date.now() - t0).toBeLessThan(15_000);

    const codex = new CodexAdapter({ root: zdir });
    expect(await codex.listSessions()).toEqual([]);
    const msgs = await codex.readSession('dddd0001-0000-4000-8000-000000000001');
    expect(msgs).toEqual([
      { harness: 'codex', session: 'dddd0001-0000-4000-8000-000000000001', idx: 0, role: 'system', parts: [{ kind: 'other', text: `[rest of transcript omitted: read limit of ${LIMITS.fullMinBytes} bytes reached]` }] },
    ]);
  }, 60_000);
});

describe('small helpers', () => {
  it('mapPool keeps order and bounds concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });

  it('isSafeId rejects traversal and separators', () => {
    expect(isSafeId('c0de0001-0000-4000-8000-000000000001')).toBe(true);
    expect(isSafeId('ses_ABC.123')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a\\b', '..', '.hidden', 'a..b']) expect(isSafeId(bad)).toBe(false);
  });

  it('toIso accepts ms, Date and strings', () => {
    expect(toIso(Date.UTC(2026, 0, 2))).toBe('2026-01-02T00:00:00.000Z');
    expect(toIso('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(toIso('nonsense')).toBeUndefined();
    expect(toIso(undefined)).toBeUndefined();
  });

  it('compactArgs renders commands plainly and other args as JSON', () => {
    expect(compactArgs({ command: 'npm test', description: 'run', timeout: 5 })).toBe('npm test');
    expect(compactArgs('{"command":"ls -la","workdir":"/x"}')).toBe('ls -la');
    expect(compactArgs({ command: ['bash', '-lc', 'echo hi'] })).toBe('echo hi');
    expect(compactArgs({ file_path: '/a', limit: 3 })).toBe('{"file_path":"/a","limit":3}');
    expect(compactArgs('*** Begin Patch')).toBe('*** Begin Patch');
    expect(compactArgs('{not json')).toBe('{not json');
    expect(compactArgs(undefined)).toBe('');
    expect(shellJoin(['git', 'commit', '-m', 'a b'])).toBe('git commit -m "a b"');
  });

  it('contentText flattens content items', () => {
    expect(contentText('plain')).toBe('plain');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'tool_reference', tool_name: 'X' }, { type: 'input_text', text: 'b' }])).toBe('a\n[image]\n[tool_reference X]\nb');
    expect(contentText(null)).toBe('');
  });

  it('isInjectedText recognizes harness-injected context but not user words', () => {
    expect(isInjectedText('<environment_context>\n<cwd>/x</cwd>\n</environment_context>')).toBe(true);
    expect(isInjectedText('<system-reminder>be nice</system-reminder>')).toBe(true);
    expect(isInjectedText('# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>…')).toBe(true);
    expect(isInjectedText('<foo_block>anything</foo_block>')).toBe(true);
    expect(isInjectedText('<image name=[Image #1]></image>')).toBe(false);
    expect(isInjectedText('<command-name>/dream</command-name>')).toBe(false);
    expect(isInjectedText('no, use <b>bold</b> here')).toBe(false);
    expect(isInjectedText('<b>a</b> and <b>b</b>')).toBe(false);
  });
});
