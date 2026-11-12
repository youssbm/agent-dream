// Static half of the "no outside calls" guarantee (PLAN §1, §8, bench #9):
//  1. Runtime dependencies are limited to an allow-list (no LLM SDKs, no HTTP clients).
//  2. Our own source never references network modules (in any import/require/import()/createRequire form),
//     never uses fetch/WebSocket/XMLHttpRequest/EventSource or process.binding, and only spawns `git`.
//  3. The bundle imports no network built-ins (from the esbuild metafile written by build.mjs) and contains
//     no known LLM SDK markers.
//
// The source scan runs on a lexed copy of each file: comments are removed and the contents of string,
// template and regex literals are blanked, so prose in comments/strings can't trip it and code can't hide
// in a string. String literals are kept separately and checked by value.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Built-in modules that can reach the network (with or without `node:`), plus undici. */
const NETWORK_MODULES = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
  'inspector',
  'inspector/promises',
  'undici',
  '_http_agent',
  '_http_client',
  '_http_common',
  '_http_incoming',
  '_http_outgoing',
  '_http_server',
  '_tls_common',
  '_tls_wrap',
]);

/** True when `spec` names a network-capable module (`http`, `node:https`, `dns/promises`, `undici/…`). */
export function isNetworkModule(spec) {
  const s = String(spec).trim().replace(/^node:/, '');
  return NETWORK_MODULES.has(s) || s.startsWith('undici/');
}

/** Network globals that must not appear as identifiers (or as string keys, e.g. `globalThis['fetch']`). */
const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'WebSocketStream', 'XMLHttpRequest', 'EventSource'];
const CHILD_PROCESS_FNS = ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync', 'fork'];
const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function unescapeJs(raw) {
  return raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|\n|\r)|([\s\S]))/g, (_m, cp, u4, x2, nl, ch) => {
    if (cp) return String.fromCodePoint(parseInt(cp, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (nl) return '';
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[ch] ?? ch;
  });
}

/**
 * Lex JS/TS source. Returns `code` (same length as `src`; comments and the *contents* of string, template and
 * regex literals replaced by spaces, delimiters and newlines kept) and `strings`: every string literal and every
 * substitution-free template literal as `{ start, end, value }` (`start` = index of the opening quote).
 */
export function lex(src) {
  const out = src.split('');
  const strings = [];
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  /** Template nesting: one brace-depth counter per open `${`. */
  const braces = [];
  let regexAllowed = true;
  let i = 0;

  /** Scan template text starting just after a backtick or a closing `}` of a substitution. */
  const readTemplate = (from, startQuote) => {
    let j = from;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        blank(from, j);
        if (startQuote !== -1) strings.push({ start: startQuote, end: j + 1, value: unescapeJs(src.slice(from, j)) });
        regexAllowed = false;
        return j + 1;
      }
      if (c === '$' && src[j + 1] === '{') {
        blank(from, j);
        braces.push(0);
        regexAllowed = true;
        return j + 2;
      }
      j++;
    }
    blank(from, n);
    return n;
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      strings.push({ start: i, end: j + 1, value: unescapeJs(src.slice(i + 1, j)) });
      blank(i + 1, j);
      i = j + 1;
      regexAllowed = false;
      continue;
    }
    if (c === '`') {
      i = readTemplate(i + 1, i);
      continue;
    }
    if (c === '{') {
      if (braces.length) braces[braces.length - 1]++;
      regexAllowed = true;
      i++;
      continue;
    }
    if (c === '}') {
      if (braces.length && braces[braces.length - 1] === 0) {
        braces.pop();
        i = readTemplate(i + 1, -1);
        continue;
      }
      if (braces.length) braces[braces.length - 1]--;
      regexAllowed = false;
      i++;
      continue;
    }
    if (c === '/') {
      if (!regexAllowed) {
        regexAllowed = true;
        i++;
        continue;
      }
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      while (i < n && /[A-Za-z]/.test(src[i])) i++;
      regexAllowed = false;
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(src[j])) j++;
      regexAllowed = KEYWORDS_BEFORE_REGEX.has(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      regexAllowed = false;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) regexAllowed = !(c === ')' || c === ']');
    i++;
  }
  return { code: out.join(''), strings };
}

/**
 * Scan one source file. Returns a list of `{ line, message }` violations (empty when clean).
 * Exported for the regression tests in packages/core/test/quality/check-deps.test.ts.
 */
export function scanSource(src) {
  const { code, strings } = lex(src);
  const problems = [];
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const report = (idx, message) => problems.push({ line: lineOf(idx), message });
  const stringAt = new Map(strings.map((s) => [s.start, s]));
  /** The string literal starting at the first non-space index at or after `idx`, if any. */
  const literalAfter = (idx) => {
    let k = idx;
    while (k < code.length && /\s/.test(code[k])) k++;
    return stringAt.get(k);
  };

  // 1. Network modules referenced anywhere by value: import/require/import()/createRequire()()/getBuiltinModule,
  //    or a string later passed to one of them.
  for (const s of strings) {
    if (isNetworkModule(s.value)) report(s.start, `references network module "${s.value}"`);
    if (NETWORK_GLOBALS.includes(s.value)) report(s.start, `references network global "${s.value}" by name`);
  }

  // 2. Module loading must use a literal specifier so (1) can see it; no createRequire / process.binding.
  for (const m of code.matchAll(/(?<![\w$])(import|require|getBuiltinModule)\s*\(/g)) {
    if (!literalAfter(m.index + m[0].length)) report(m.index, `${m[1]}() with a non-literal module specifier`);
  }
  for (const m of code.matchAll(/(?<![\w$])createRequire(?![\w$])/g)) report(m.index, 'uses createRequire');
  for (const m of code.matchAll(/(?<![\w$])process\s*(?:\??\.\s*(?:binding|_linkedBinding)(?![\w$])|\[)/g)) {
    // `process[...]` hides the property name; `process.binding` reaches internal (network) bindings.
    report(m.index, 'uses process.binding / computed process property');
  }

  // 3. Network globals as identifiers (strings and comments are already blanked).
  for (const g of NETWORK_GLOBALS) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w$])${g}(?![\\w$])`, 'g'))) report(m.index, `uses ${g}`);
  }

  // 4. child_process: only `git`, via a statically imported function, never through a shell.
  const cpSpecs = strings.filter((s) => s.value.replace(/^node:/, '') === 'child_process');
  if (cpSpecs.length) {
    const fns = new Map(); // local name -> imported name
    const namespaces = new Set();
    const covered = new Set();
    const isCp = (idx) => {
      const s = literalAfter(idx);
      if (s && cpSpecs.includes(s)) {
        covered.add(s.start);
        return true;
      }
      return false;
    };
    const addNamed = (list, sep) => {
      for (const part of list.split(',')) {
        const [imported, local] = part.trim().replace(/^type\s+/, '').split(sep).map((x) => x.trim());
        if (imported) fns.set(local || imported, imported);
      }
    };
    // import { a, b as c } from 'child_process' / import cp, { a } from … / import * as cp from …
    for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([\w$]+\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+)|([\w$]+))\s*from\s*/g)) {
      if (!isCp(m.index + m[0].length)) continue;
      if (m[1]) namespaces.add(m[1].replace(/[\s,]/g, ''));
      if (m[2]) addNamed(m[2], /\s+as\s+/);
      if (m[3]) namespaces.add(m[3]);
      if (m[4]) namespaces.add(m[4]);
    }
    // const { a, b: c } = require('child_process') / const cp = require('child_process')
    for (const m of code.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]*)\}|([\w$]+))\s*=\s*require\s*\(/g)) {
      if (!isCp(m.index + m[0].length)) continue;
      if (m[1]) addNamed(m[1], ':');
      if (m[2]) namespaces.add(m[2]);
    }
    for (const s of cpSpecs) {
      if (!covered.has(s.start)) report(s.start, 'child_process must be loaded with a static import or `const … = require()` so its calls can be checked');
    }
    const checkCall = (idx, afterParen, fnName) => {
      if (fnName === 'fork') return report(idx, 'child_process.fork is not allowed (only git may be spawned)');
      const lit = literalAfter(afterParen);
      if (lit) {
        if (lit.value !== 'git') report(idx, `${fnName}("${lit.value}") — only git may be spawned`);
        return;
      }
      const rest = code.slice(afterParen).match(/^\s*([\w$]+)\s*[,)]/);
      if (!rest || !/^git/i.test(rest[1])) report(idx, `${fnName}() first argument must be the literal 'git' (or a git* variable)`);
    };
    for (const [local, imported] of fns) {
      if (!CHILD_PROCESS_FNS.includes(imported)) continue;
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))) {
        checkCall(m.index, m.index + m[0].length, imported);
      }
    }
    for (const ns of namespaces) {
      const re = new RegExp(`(?<![\\w$.])${ns.replace(/\$/g, '\\$')}\\s*\\.\\s*(${CHILD_PROCESS_FNS.join('|')})\\s*\\(`, 'g');
      for (const m of code.matchAll(re)) checkCall(m.index, m.index + m[0].length, m[1]);
    }
    for (const m of code.matchAll(/\bshell\s*:(?!\s*false\b)/g)) report(m.index, 'child_process with a shell option is not allowed');
  }

  return problems;
}

/** Network modules among the bundle's external imports (from dist/meta.json), plus any non-builtin external. */
export function checkBundleImports(externalImports) {
  const builtins = new Set(builtinModules.flatMap((b) => [b, `node:${b}`]));
  const problems = [];
  for (const imp of externalImports) {
    const p = typeof imp === 'string' ? imp : imp.path;
    if (isNetworkModule(p)) problems.push(`bundle imports network module "${p}"`);
    else if (!builtins.has(p) && !p.startsWith('node:')) problems.push(`bundle leaves non-builtin import "${p}" external`);
  }
  return problems;
}

const SOURCE_DIRS = ['packages/core/src', 'packages/server/src', 'packages/bench/src', 'scripts'];
/** The guard and this checker necessarily name the modules they police. */
const SKIP_FILES = new Set(['scripts/check-deps.mjs', 'scripts/no-network-guard.ts']);

function walk(dir, errors) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) walk(full, errors);
    else if (/\.(?:[cm]?ts|[cm]?js)$/.test(name) && !/\.d\.[cm]?ts$/.test(name) && !SKIP_FILES.has(rel)) {
      for (const p of scanSource(readFileSync(full, 'utf8'))) errors.push(`${rel}:${p.line}: ${p.message}`);
    }
  }
}

function main() {
  const errors = [];

  const ALLOWED_RUNTIME_DEPS = new Set(['@agent-dream/core', '@modelcontextprotocol/sdk', 'zod', 'yaml', 'minisearch']);
  for (const p of ['packages/core', 'packages/server', 'packages/bench']) {
    const pkg = JSON.parse(readFileSync(path.join(root, p, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!ALLOWED_RUNTIME_DEPS.has(dep)) errors.push(`${p}: runtime dependency "${dep}" is not on the allow-list`);
    }
  }

  for (const p of SOURCE_DIRS) if (existsSync(path.join(root, p))) walk(path.join(root, p), errors);

  const bundle = path.join(root, 'packages/server/dist/agent-dream.js');
  const meta = path.join(root, 'packages/server/dist/meta.json');
  if (existsSync(bundle)) {
    const src = readFileSync(bundle, 'utf8');
    for (const marker of ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', '@anthropic-ai/sdk', 'openai/resources']) {
      if (src.includes(marker)) errors.push(`bundle contains LLM marker "${marker}"`);
    }
    if (!existsSync(meta) || statSync(meta).mtimeMs + 1000 < statSync(bundle).mtimeMs) {
      errors.push('packages/server/dist/meta.json is missing or older than the bundle; run `npm run build`');
    } else {
      const { externalImports } = JSON.parse(readFileSync(meta, 'utf8'));
      if (!Array.isArray(externalImports)) errors.push('packages/server/dist/meta.json has no externalImports list');
      else errors.push(...checkBundleImports(externalImports));
    }
  } else {
    console.warn('bundle not built yet; skipping bundle scan');
  }

  if (errors.length) {
    console.error('check-deps FAILED:\n- ' + errors.join('\n- '));
    process.exit(1);
  }
  console.log(
    'check-deps OK: allow-listed runtime deps only; no network modules, network globals or non-git processes in source; ' +
      'no network built-ins or LLM markers in the bundle.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
