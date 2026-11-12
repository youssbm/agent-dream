/**
 * `agent-dream` bin entry: serves the dream MCP server over stdio.
 * stdout belongs to the MCP transport; every diagnostic goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DreamService } from '@agent-dream/core';
import { parseArgs, USAGE } from './args.ts';
import { createDreamServer, DEV_VERSION, loadInstructions } from './server.ts';

/** Injected by the bundler (scripts/build.mjs); undefined when running from source. */
declare const __AGENT_DREAM_VERSION__: string | undefined;

const VERSION: string =
  typeof __AGENT_DREAM_VERSION__ === 'string' && __AGENT_DREAM_VERSION__ !== '' ? __AGENT_DREAM_VERSION__ : DEV_VERSION;

function log(message: string, err?: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : err === undefined ? '' : String(err);
  process.stderr.write(`agent-dream: ${message}${detail ? `\n${detail}` : ''}\n`);
}

/** Keep stray console output from dependencies off the protocol stream. */
function protectStdout(): void {
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.trace = toStderr;
  console.dir = (obj: unknown): void => console.error(obj);
  console.table = (data: unknown): void => console.error(data);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), process.env, process.cwd());
  // --help / --version print to stdout: no MCP transport is running in these modes.
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`agent-dream: ${parsed.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  protectStdout();
  process.on('unhandledRejection', (reason) => log('unhandled rejection', reason));

  const service = new DreamService({ projectDir: parsed.projectDir });
  const instructions = await loadInstructions(service);
  const server = createDreamServer(service, { version: VERSION, instructions });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    server
      .close()
      .catch((err: unknown) => log('error while closing', err))
      .finally(() => process.exit(code));
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.stdin.on('end', () => shutdown(0));
  transport.onerror = (err) => log('transport error', err);

  await server.connect(transport);
  log(`v${VERSION} serving ${parsed.projectDir} over stdio`);
}

main().catch((err: unknown) => {
  log('fatal error', err);
  process.exit(1);
});
