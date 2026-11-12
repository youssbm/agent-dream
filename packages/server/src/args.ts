/** Command-line parsing for the `agent-dream` bin (kept separate from main.ts so it can be tested without stdio). */
import path from 'node:path';

/** Result of {@link parseArgs}. */
export type ParsedArgs =
  | { kind: 'run'; projectDir: string }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

/** Usage text for `--help`. */
export const USAGE = `agent-dream — memory dreaming for coding agents (MCP server over stdio)

Usage:
  agent-dream [--project <dir>]

Options:
  --project, -p <dir>  Project directory whose memory lives in <dir>/.dream/
                       (default: $AGENT_DREAM_PROJECT, else $CLAUDE_PROJECT_DIR,
                       else the current directory)
  --version, -v        Print the version and exit
  --help, -h           Print this help and exit

Configure it in your agent as a local (stdio) MCP server, e.g. command "npx", args ["-y", "agent-dream"].
`;

/**
 * Parses CLI arguments (without the node/script prefix).
 * `--help` / `--version` win over everything else; unknown flags are errors.
 */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  cwd: string = process.cwd(),
): ParsedArgs {
  let project: string | undefined;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-v' || a === '-V') version = true;
    else if (a === '--project' || a === '-p') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('-')) return { kind: 'error', message: `${a} needs a directory` };
      project = v;
      i++;
    } else if (a.startsWith('--project=')) {
      const v = a.slice('--project='.length);
      if (v === '') return { kind: 'error', message: '--project needs a directory' };
      project = v;
    } else {
      return { kind: 'error', message: `unknown argument: ${a}` };
    }
  }
  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };
  // Precedence: --project, $AGENT_DREAM_PROJECT, $CLAUDE_PROJECT_DIR (set by Claude Code for MCP servers), cwd.
  const envProject = env.AGENT_DREAM_PROJECT?.trim() || env.CLAUDE_PROJECT_DIR?.trim() || undefined;
  const dir = project ?? envProject ?? cwd;
  return { kind: 'run', projectDir: path.resolve(cwd, dir) };
}
