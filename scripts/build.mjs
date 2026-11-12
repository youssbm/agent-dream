// Bundles the MCP server into one dependency-free ESM file: packages/server/dist/agent-dream.js
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'packages/server/package.json'), 'utf8'));
const outfile = path.join(root, 'packages/server/dist/agent-dream.js');
mkdirSync(path.dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'packages/server/src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  legalComments: 'inline',
  metafile: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __agentDreamCreateRequire } from 'node:module';",
      'const require = __agentDreamCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: { __AGENT_DREAM_VERSION__: JSON.stringify(pkg.version) },
  alias: { '@agent-dream/core': path.join(root, 'packages/core/src/index.ts') },
  logLevel: 'info',
});

try {
  chmodSync(outfile, 0o755);
} catch {
  /* windows */
}
for (const f of ['LICENSE', 'README.md']) copyFileSync(path.join(root, f), path.join(root, 'packages/server', f));

// Write the bundle's external imports (node: builtins) for scripts/check-deps.mjs, which fails on network modules.
const externals = new Map();
for (const out of Object.values(result.metafile.outputs)) {
  for (const imp of out.imports ?? []) if (imp.external) externals.set(`${imp.path}\0${imp.kind}`, { path: imp.path, kind: imp.kind });
}
const externalImports = [...externals.values()].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
writeFileSync(
  path.join(path.dirname(outfile), 'meta.json'),
  JSON.stringify({ bundle: path.basename(outfile), externalImports }, null, 2) + '\n',
);
console.log('external imports in bundle:', [...new Set(externalImports.map((i) => i.path))].sort().join(', '));
