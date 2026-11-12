/**
 * Regression tests for the static "no outside calls" scanner in scripts/check-deps.mjs (security review P9/P12
 * follow-up): every import/require form, aliased fetch, process.binding and non-git child processes must be caught,
 * while comments, prose strings, regex literals and git calls must not trip it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Problem {
  line: number;
  message: string;
}
interface CheckDeps {
  scanSource(src: string): Problem[];
  isNetworkModule(spec: string): boolean;
  checkBundleImports(imports: (string | { path: string; kind: string })[]): string[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let mod: CheckDeps;

beforeAll(async () => {
  // Non-literal specifier: the script is plain .mjs without type declarations.
  const url = pathToFileURL(path.join(repoRoot, 'scripts/check-deps.mjs')).href;
  mod = (await import(url)) as CheckDeps;
});

const CP = "import { execFile, spawn, execSync, exec, fork } from 'node:child_process';\n";

const MUST_FLAG: { name: string; src: string; expect: RegExp }[] = [
  { name: 'side-effect import', src: "import 'node:net';", expect: /network module "node:net"/ },
  { name: 'default import without node:', src: "import net from 'net';", expect: /network module "net"/ },
  { name: 'named import from dns/promises', src: "import { lookup } from 'node:dns/promises';", expect: /"node:dns\/promises"/ },
  { name: 'dynamic import()', src: "const h = await import('node:https');", expect: /"node:https"/ },
  { name: 'dynamic import with template literal', src: 'const h = await import(`http2`);', expect: /"http2"/ },
  { name: 'require', src: "const tls = require('tls');", expect: /"tls"/ },
  { name: 'export from', src: "export { connect } from 'node:tls';", expect: /"node:tls"/ },
  {
    name: 'createRequire(...)(...)',
    src: "import { createRequire } from 'node:module';\nconst x = createRequire(import.meta.url)('http');",
    expect: /createRequire|"http"/,
  },
  {
    name: 'createRequire alias',
    src: "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nr('dgram');",
    expect: /"dgram"/,
  },
  { name: 'getBuiltinModule', src: "const n = process.getBuiltinModule('node:net');", expect: /"node:net"/ },
  { name: 'specifier via variable', src: "const m = 'node:http';\nawait import(m);", expect: /non-literal/ },
  { name: 'escaped specifier', src: "require('\\x68ttps');", expect: /"https"/ },
  { name: 'inspector', src: "import inspector from 'node:inspector';", expect: /"node:inspector"/ },
  { name: 'undici', src: "import { request } from 'undici';", expect: /"undici"/ },
  { name: 'fetch call', src: 'await fetch(url);', expect: /uses fetch/ },
  { name: 'aliased globalThis.fetch', src: 'const f = globalThis.fetch;\nf(url);', expect: /uses fetch/ },
  { name: "globalThis['fetch']", src: "const f = globalThis['fetch'];", expect: /network global "fetch"/ },
  { name: 'WebSocket', src: "new WebSocket('ws://x');", expect: /uses WebSocket/ },
  { name: 'EventSource', src: "new EventSource('/events');", expect: /uses EventSource/ },
  { name: 'process.binding', src: "process.binding('tcp_wrap');", expect: /process\.binding/ },
  { name: 'computed process property', src: "process['bin' + 'ding']('tcp_wrap');", expect: /process\.binding|computed/ },
  { name: 'execFile curl', src: CP + "execFile('curl', ['https://x']);", expect: /execFile\("curl"\)/ },
  { name: 'execFile wget', src: CP + "execFile('wget', []);", expect: /"wget"/ },
  { name: 'spawn nc', src: CP + "spawn('nc', ['host', '80']);", expect: /"nc"/ },
  { name: 'spawn powershell', src: CP + "spawn('powershell', ['-c', 'Invoke-WebRequest x']);", expect: /"powershell"/ },
  { name: 'execSync Invoke-WebRequest', src: CP + "execSync('Invoke-WebRequest https://x');", expect: /Invoke-WebRequest/ },
  { name: 'exec through a shell, even git', src: CP + "exec('git status');", expect: /"git status"/ },
  { name: 'fork', src: CP + "fork('./worker.js');", expect: /fork is not allowed/ },
  { name: 'non-git variable', src: CP + 'execFile(cmd, args);', expect: /first argument/ },
  { name: 'shell option', src: CP + "execFile('git', ['status'], { shell: true });", expect: /shell/ },
  { name: 'renamed import', src: "import { execFile as run } from 'node:child_process';\nrun('curl', []);", expect: /"curl"/ },
  { name: 'namespace import', src: "import * as cp from 'child_process';\ncp.spawn('nc', []);", expect: /"nc"/ },
  { name: 'require destructure', src: "const { spawn: s } = require('child_process');\ns('curl');", expect: /"curl"/ },
  { name: 'dynamic child_process import', src: "const cp = await import('node:child_process');", expect: /static import/ },
];

const MUST_PASS: { name: string; src: string }[] = [
  {
    name: 'comments mentioning forbidden things',
    src: "// import 'node:net'; fetch(url)\n/* require('http'); new WebSocket(x); process.binding('x') */\nexport const a = 1;",
  },
  { name: 'prose strings', src: "const s = 'we never fetch anything over http';\nconst t = \"WebSocket support: none\";" },
  { name: 'regex literal with quotes and fetch', src: "const re = /fetch\\(['\"]http['\"]\\)/g;\nconst x = a / b / c;" },
  { name: 'template with substitution', src: 'const msg = `call ${name} then fetch ${url}`;' },
  { name: 'identifiers containing fetch', src: 'prefetch(); obj.fetchAll(); const fetched = refetchCount;' },
  { name: 'git via execFile', src: CP + "execFile('git', ['status'], { cwd, windowsHide: true }, cb);\nexecFile(\n  'git',\n  args,\n);" },
  { name: 'git binary variable', src: CP + 'execFile(gitPath, args, cb);\nspawn(GIT_BIN, args);' },
  { name: 'RegExp#exec in a child_process file', src: CP + "const m = /x/.exec(text);\nre.exec(s);\nexecFile('git', []);" },
  { name: 'local module imports', src: "import { DatabaseSync } from 'node:sqlite';\nconst m = await import('node:sqlite');\ntype D = import('node:fs').Dirent;" },
  { name: 'process.env and process.argv', src: "const p = process.env['AGENT_DREAM_PROJECT'] ?? process.argv[2];" },
  { name: 'shell: false', src: CP + "execFile('git', [], { shell: false });" },
];

describe('check-deps scanSource — flags', () => {
  it.each(MUST_FLAG)('$name', ({ src, expect: re }) => {
    const problems = mod.scanSource(src);
    expect(problems.map((p) => p.message).join('\n')).toMatch(re);
  });
});

describe('check-deps scanSource — clean code passes', () => {
  it.each(MUST_PASS)('$name', ({ src }) => {
    expect(mod.scanSource(src)).toEqual([]);
  });

  it('reports 1-based line numbers', () => {
    const problems = mod.scanSource("const a = 1;\n\nimport 'node:net';");
    expect(problems[0]?.line).toBe(3);
  });
});

describe('check-deps lexer stays in sync on every repo source file', () => {
  // If the lexer mis-reads a string/regex/template boundary it would blank real code and miss violations.
  // Appending a fetch call to each real file and expecting it to be found proves the lexer re-synchronised.
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(?:ts|mjs)$/.test(name)) files.push(full);
    }
  };
  for (const d of ['packages/core/src', 'packages/server/src', 'packages/bench/src', 'scripts']) walk(path.join(repoRoot, d));

  it('finds source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('detects an appended fetch() in every file', () => {
    const missed = files.filter((f) => {
      const problems = mod.scanSource(fs.readFileSync(f, 'utf8') + '\n;fetch(1);\n');
      return !problems.some((p) => p.message === 'uses fetch');
    });
    expect(missed).toEqual([]);
  });
});

describe('check-deps bundle import check', () => {
  it('fails on network built-ins and non-builtin externals', () => {
    const problems = mod.checkBundleImports([
      { path: 'node:fs', kind: 'import-statement' },
      { path: 'node:http', kind: 'import-statement' },
      { path: 'https', kind: 'require-call' },
      { path: 'node:dns/promises', kind: 'dynamic-import' },
      'undici',
      'left-pad',
    ]);
    expect(problems.join('\n')).toMatch(/"node:http"/);
    expect(problems.join('\n')).toMatch(/"https"/);
    expect(problems.join('\n')).toMatch(/"node:dns\/promises"/);
    expect(problems.join('\n')).toMatch(/"undici"/);
    expect(problems.join('\n')).toMatch(/non-builtin import "left-pad"/);
    expect(problems).toHaveLength(5);
  });

  it('accepts the local built-ins the server uses', () => {
    expect(
      mod.checkBundleImports(['buffer', 'process', 'node:child_process', 'node:crypto', 'node:fs/promises', 'node:sqlite', 'node:zlib']),
    ).toEqual([]);
  });

  it('isNetworkModule covers prefixed, unprefixed and sub-path forms', () => {
    for (const s of ['http', 'node:https', 'http2', 'net', 'tls', 'dgram', 'dns', 'node:dns/promises', 'inspector', 'undici/x']) {
      expect(mod.isNetworkModule(s), s).toBe(true);
    }
    for (const s of ['node:fs', 'path', 'child_process', 'worker_threads', 'netlify', 'node:sqlite']) {
      expect(mod.isNetworkModule(s), s).toBe(false);
    }
  });
});
