/**
 * Regression tests for scripts/no-network-guard.ts (loaded by vitest as a setup file for every test file).
 * Every network entry point must throw before any socket is opened; local IPC (pipes / unix sockets) must keep working.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net, { connect as namedConnect } from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { lookup as promisesLookup } from 'node:dns/promises';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';

const GUARD = /no-network-guard/;

describe('no-network-guard blocks network entry points', () => {
  it('net TCP connections (Socket#connect, connect, createConnection, ESM named export)', () => {
    expect(() => new net.Socket().connect(80, '127.0.0.1')).toThrow(GUARD);
    expect(() => net.connect(80, 'example.invalid')).toThrow(GUARD);
    expect(() => net.connect({ port: 80, host: 'example.invalid' })).toThrow(GUARD);
    expect(() => net.createConnection({ port: 443 })).toThrow(GUARD);
    expect(() => namedConnect(80, 'example.invalid')).toThrow(GUARD);
  });

  it('tls.connect and http2.connect', () => {
    expect(() => tls.connect(443, 'example.invalid')).toThrow(GUARD);
    expect(() => http2.connect('https://example.invalid')).toThrow(GUARD);
  });

  it('dgram.createSocket', () => {
    expect(() => dgram.createSocket('udp4')).toThrow(GUARD);
  });

  it('dns callback, promises and Resolver APIs', () => {
    const noop = (): void => {};
    expect(() => dns.lookup('example.invalid', noop)).toThrow(GUARD);
    expect(() => dns.resolve4('example.invalid', noop)).toThrow(GUARD);
    expect(() => dns.promises.lookup('example.invalid')).toThrow(GUARD);
    expect(() => dns.promises.resolveTxt('example.invalid')).toThrow(GUARD);
    expect(() => promisesLookup('example.invalid')).toThrow(GUARD);
    expect(() => new dns.Resolver().resolve4('example.invalid', noop)).toThrow(GUARD);
    expect(() => new dns.promises.Resolver().resolve6('example.invalid')).toThrow(GUARD);
  });

  it('http/https clients', () => {
    expect(() => http.get('http://example.invalid')).toThrow(GUARD);
    expect(() => http.request('http://example.invalid')).toThrow(GUARD);
    expect(() => https.get('https://example.invalid')).toThrow(GUARD);
    expect(() => https.request('https://example.invalid')).toThrow(GUARD);
  });

  it('fetch and WebSocket globals', () => {
    expect(() => fetch('https://example.invalid')).toThrow(GUARD);
    expect(() => globalThis['fetch']('https://example.invalid')).toThrow(GUARD);
    const g = globalThis as { WebSocket?: new (url: string) => unknown };
    if (g.WebSocket) {
      const WS = g.WebSocket;
      expect(() => new WS('ws://example.invalid')).toThrow(GUARD);
    }
  });
});

describe('no-network-guard keeps local IPC working', () => {
  it('connects to a local pipe / unix socket server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dream-guard-'));
    const pipe =
      process.platform === 'win32' ? `\\\\.\\pipe\\agent-dream-guard-${process.pid}-${Date.now()}` : path.join(dir, 'guard.sock');
    const server = net.createServer((sock) => sock.end('pong'));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipe, resolve);
      });
      const reply = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection({ path: pipe });
        let data = '';
        client.on('data', (d) => (data += String(d)));
        client.on('end', () => resolve(data));
        client.on('error', reject);
      });
      expect(reply).toBe('pong');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
