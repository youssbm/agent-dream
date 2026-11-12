/**
 * Low-level, read-only file helpers for JSONL transcript stores.
 *
 * Lines are split on `\n` only (a trailing `\r` is stripped). `node:readline` is deliberately not used:
 * it also breaks lines at U+2028/U+2029, which are legal unescaped inside JSON strings and do occur in
 * real transcripts.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

type ZstdFactory = () => zlib.ZstdDecompress;

/** `zlib.createZstdDecompress` when this Node build has it (≥ 22.15 / 23.8), else undefined. */
function zstdFactory(): ZstdFactory | undefined {
  const f = (zlib as { createZstdDecompress?: ZstdFactory }).createZstdDecompress;
  return typeof f === 'function' ? f : undefined;
}

/** Whether `.zst`-compressed transcripts can be read on this Node version. */
export function zstdSupported(): boolean {
  return zstdFactory() !== undefined;
}

/** Whether a path names a zstd-compressed file. */
export function isZstd(file: string): boolean {
  return file.endsWith('.zst');
}

/**
 * Resource limits. Real stores have lines up to ~7 MB (inline base64 images) and zstd rollouts that
 * decompress to ~0.7 GB at a ~1.4× ratio; a crafted file must not be able to exhaust memory or time.
 */
export const LIMITS = {
  /** Full reads: lines longer than this (UTF-16 units) are replaced by an omitted-record notice. */
  maxLineChars: 16 * 1024 * 1024,
  /** Head reads (listing metadata): reading stops at a line longer than this. */
  headMaxLineChars: 8 * 1024 * 1024,
  /** Head reads: at most this many decompressed bytes are read. */
  headMaxBytes: 64 * 1024 * 1024,
  /** Full reads of compressed files: decompressed output is capped at max(floor, ratio × compressed size)… */
  fullMinBytes: 64 * 1024 * 1024,
  fullMaxRatio: 200,
  /** …and never more than this. */
  fullMaxBytes: 4 * 1024 * 1024 * 1024,
} as const;

/** `type` of the synthetic record {@link readLines} yields in place of content it refused to read. */
export const OMITTED_TYPE = 'agent-dream:omitted';

/** Options for {@link readLines}. */
export interface ReadLinesOptions {
  /** Lines longer than this are never buffered whole. Default {@link LIMITS.maxLineChars}. */
  maxLineChars?: number;
  /**
   * What to do with an over-long line: `'stub'` (default) yields an {@link OMITTED_TYPE} record line in its
   * place and continues; `'stop'` ends the stream.
   */
  onLongLine?: 'stub' | 'stop';
  /**
   * Stop after this many bytes have been read (decompressed bytes for `.zst`). Default: unlimited for plain
   * files; for compressed files max(LIMITS.fullMinBytes, LIMITS.fullMaxRatio × file size) capped at
   * LIMITS.fullMaxBytes. In `'stub'` mode an {@link OMITTED_TYPE} line is yielded when the cap is hit.
   */
  maxBytes?: number;
  /** Set to true when reading stopped early because of a limit. */
  status?: { limited?: boolean };
}

/** The text notice for an {@link OMITTED_TYPE} record, or undefined for any other record. */
export function omittedNotice(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== OMITTED_TYPE) return undefined;
  if (rec.reason === 'line_too_long') return `[transcript record omitted: ${String(rec.chars)} chars, too large to read]`;
  return `[rest of transcript omitted: read limit of ${String(rec.bytes)} bytes reached]`;
}

/**
 * Stream the lines of a (possibly `.zst`-compressed) text file. Stops reading as soon as the consumer
 * breaks out of the loop. Empty lines are skipped. Memory stays bounded by `maxLineChars` per line even for
 * crafted input (an over-long line is counted, never buffered whole), and compressed input is capped at
 * `maxBytes` of output (see {@link ReadLinesOptions}).
 */
export async function* readLines(file: string, opts: ReadLinesOptions = {}): AsyncGenerator<string> {
  const maxLine = opts.maxLineChars ?? LIMITS.maxLineChars;
  const stub = (opts.onLongLine ?? 'stub') === 'stub';
  const zst = isZstd(file);
  let maxBytes = opts.maxBytes ?? Infinity;
  if (opts.maxBytes === undefined && zst) {
    const size = (await statOrNull(file))?.size ?? 0;
    maxBytes = Math.min(LIMITS.fullMaxBytes, Math.max(LIMITS.fullMinBytes, size * LIMITS.fullMaxRatio));
  }
  const raw = fs.createReadStream(file, { highWaterMark: 1 << 16 });
  let source: Readable = raw;
  let decomp: zlib.ZstdDecompress | undefined;
  if (zst) {
    const make = zstdFactory();
    if (!make) {
      raw.destroy();
      throw new Error('zstd decompression is not available in this Node.js version');
    }
    decomp = make();
    raw.on('error', (e) => decomp?.destroy(e));
    raw.pipe(decomp);
    source = decomp;
  }
  const decoder = new StringDecoder('utf8');
  // Pieces of the current, unfinished line (kept as a list so very long lines stay linear-time).
  let pending: string[] = [];
  let pendingChars = 0;
  /** Length of the current line once it exceeded maxLine (its text is no longer kept), else -1. */
  let overflow = -1;
  const omittedLine = (chars: number): string => JSON.stringify({ type: OMITTED_TYPE, reason: 'line_too_long', chars });
  /** Append a piece of the current line; false when the line just became over-long. */
  const append = (piece: string): boolean => {
    if (overflow >= 0) {
      overflow += piece.length;
      return true;
    }
    if (pendingChars + piece.length > maxLine) {
      overflow = pendingChars + piece.length;
      pending = [];
      pendingChars = 0;
      return false;
    }
    if (piece !== '') {
      pending.push(piece);
      pendingChars += piece.length;
    }
    return true;
  };
  /** Complete the current line; returns the line, an omitted-notice line, or null (blank). */
  const finish = (): string | null => {
    if (overflow >= 0) {
      const n = overflow;
      overflow = -1;
      return omittedLine(n);
    }
    let line = pending.length === 1 ? pending[0]! : pending.join('');
    pending = [];
    pendingChars = 0;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line.trim() === '' ? null : line;
  };
  let bytes = 0;
  try {
    for await (const chunk of source) {
      let buf = chunk as Buffer | string;
      const len = typeof buf === 'string' ? Buffer.byteLength(buf) : buf.length;
      let hitCap = false;
      if (bytes + len > maxBytes) {
        hitCap = true;
        if (typeof buf !== 'string') buf = buf.subarray(0, Math.max(0, maxBytes - bytes));
      }
      bytes += len;
      const text = typeof buf === 'string' ? buf : decoder.write(buf);
      let start = 0;
      let nl = text.indexOf('\n');
      while (nl !== -1) {
        if (!append(text.slice(start, nl)) && !stub) {
          if (opts.status) opts.status.limited = true;
          return;
        }
        const line = finish();
        if (line !== null) yield line;
        start = nl + 1;
        nl = text.indexOf('\n', start);
      }
      if (start < text.length && !append(text.slice(start)) && !stub) {
        if (opts.status) opts.status.limited = true;
        return;
      }
      if (hitCap) {
        // The partial line at the cap is dropped; tell the reader the rest is missing.
        if (opts.status) opts.status.limited = true;
        if (stub) yield JSON.stringify({ type: OMITTED_TYPE, reason: 'size_limit', bytes: maxBytes });
        return;
      }
    }
    if (!append(decoder.end()) && !stub) {
      if (opts.status) opts.status.limited = true;
      return;
    }
    const last = finish();
    if (last !== null) yield last;
  } finally {
    raw.destroy();
    decomp?.destroy();
  }
}

/** Parse one JSONL line into an object; null for invalid JSON or non-objects. */
export function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read up to `maxLines` parsed records from the start of a file, stopping early once `maxChars` characters
 * have been consumed (a line in progress is finished, so one large first line is still returned — up to
 * {@link LIMITS.headMaxLineChars}; reading stops at a longer line, and after {@link LIMITS.headMaxBytes}
 * decompressed bytes).
 */
export async function readHeadRecords(
  file: string,
  maxLines: number,
  maxChars = 4 * 1024 * 1024,
): Promise<{ records: Record<string, unknown>[]; complete: boolean }> {
  const records: Record<string, unknown>[] = [];
  let chars = 0;
  let lines = 0;
  const status: { limited?: boolean } = {};
  let complete = true;
  for await (const line of readLines(file, { maxLineChars: LIMITS.headMaxLineChars, onLongLine: 'stop', maxBytes: LIMITS.headMaxBytes, status })) {
    lines++;
    chars += line.length + 1;
    const rec = parseJsonObject(line);
    if (rec) records.push(rec);
    if (lines >= maxLines || chars >= maxChars) {
      complete = false;
      break;
    }
  }
  return { records, complete: complete && !status.limited };
}

/** Parsed records from the last `bytes` bytes of an uncompressed file (the first, partial line is dropped). */
export async function readTailRecords(file: string, size: number, bytes = 64 * 1024): Promise<Record<string, unknown>[]> {
  if (size <= 0) return [];
  const start = Math.max(0, size - bytes);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out: Record<string, unknown>[] = [];
    for (const l of lines) {
      const rec = l.trim() ? parseJsonObject(l.replace(/\r$/, '')) : null;
      if (rec) out.push(rec);
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `fs.stat` that returns null instead of throwing. */
export async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** Session ids are used to build file names; reject anything that could escape a directory. */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) && !id.includes('..');
}

/** ISO string for a ms epoch / Date / parsable string; undefined when not a valid time. */
export function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v) : v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** Parse an ISO `since` option to ms; undefined when absent or invalid. */
export function sinceMs(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const t = Date.parse(since);
  return Number.isNaN(t) ? undefined : t;
}
