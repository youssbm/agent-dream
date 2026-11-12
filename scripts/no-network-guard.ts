/**
 * Vitest setup file: makes any network use during tests fail loudly.
 * Enforces the "no outside calls" constraint (PLAN §1, bench test #9).
 * Local child processes (git) and stdio pipes / IPC paths are unaffected.
 */
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';

const fail = (what: string): never => {
  throw new Error(`[no-network-guard] network access attempted: ${what}`);
};

const describeArg = (arg: unknown): string => {
  try {
    return JSON.stringify(arg ?? '').slice(0, 120);
  } catch {
    return String(arg).slice(0, 120);
  }
};

const define = (obj: object, key: string, value: unknown): void => {
  try {
    Object.defineProperty(obj, key, { configurable: true, writable: true, value });
  } catch {
    /* ignore non-configurable */
  }
};

/** Replace `obj[key]` with a function that throws (only if it exists, unless `always`). */
const patch = (obj: object | undefined, key: string, label: string, always = false): void => {
  if (!obj) return;
  if (!always && typeof (obj as Record<string, unknown>)[key] !== 'function') return;
  define(obj, key, (...args: unknown[]) => fail(`${label}(${describeArg(args[0])})`));
};

/**
 * IPC / named pipe targets: `connect('/tmp/x.sock')`, `connect({ path })`. TCP (port/host) is blocked.
 * `net.connect()` hands Socket#connect its normalized args as an array (`[options, cb]`), so unwrap that.
 */
const isIpcTarget = (first: unknown): boolean => {
  const target: unknown = Array.isArray(first) ? first[0] : first;
  return (
    (typeof target === 'string' && Number.isNaN(Number(target))) ||
    (typeof target === 'object' && target !== null && typeof (target as { path?: unknown }).path === 'string')
  );
};

// net: Socket#connect is what every TCP client ends up calling; also guard the factory functions explicitly.
const origConnect = net.Socket.prototype.connect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded signature, we only inspect args[0]
(net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
  if (!isIpcTarget(args[0])) fail(`net.Socket.connect(${describeArg(args[0])})`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origConnect as any).apply(this, args);
};
for (const key of ['connect', 'createConnection'] as const) {
  const orig = net[key] as (...args: unknown[]) => net.Socket;
  define(net, key, (...args: unknown[]) => {
    if (!isIpcTarget(args[0])) fail(`net.${key}(${describeArg(args[0])})`);
    return orig.apply(net, args);
  });
}

// tls / http2 have no local-IPC use in this project.
patch(tls, 'connect', 'tls.connect');
patch(http2, 'connect', 'http2.connect');

// UDP
patch(dgram, 'createSocket', 'dgram.createSocket');

// DNS: callback API, promises API and both Resolver classes.
const DNS_FNS = ['lookup', 'lookupService', 'reverse', 'resolve', 'resolveAny', 'resolve4', 'resolve6', 'resolveCaa', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'resolveTlsa'];
for (const fn of DNS_FNS) {
  patch(dns, fn, `dns.${fn}`);
  patch(dns.promises, fn, `dns.promises.${fn}`);
  patch(dns.Resolver.prototype, fn, `dns.Resolver#${fn}`);
  patch(dns.promises.Resolver.prototype, fn, `dns.promises.Resolver#${fn}`);
}

// HTTP clients
patch(http, 'request', 'http.request');
patch(http, 'get', 'http.get');
patch(https, 'request', 'https.request');
patch(https, 'get', 'https.get');

// Web platform globals
patch(globalThis, 'fetch', 'fetch', true);
for (const ctor of ['WebSocket', 'EventSource', 'WebSocketStream'] as const) {
  if (ctor in globalThis) {
    define(globalThis, ctor, function blocked(url: unknown) {
      fail(`${ctor}(${describeArg(url)})`);
    });
  }
}

// Make `import { connect } from 'node:net'` (ESM named exports) see the patched functions too.
syncBuiltinESMExports();
