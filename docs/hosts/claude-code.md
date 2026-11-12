# agent-dream in Claude Code

agent-dream reads Claude Code's session transcripts, and Claude Code shows MCP prompts as slash commands, so `/dream` is a
real command here.

## Requirements

- Node.js 22.13 or newer on your PATH (`node --version`).
- `git` on your PATH is recommended.

## Add the server

From your project directory:

```sh
claude mcp add --transport stdio --scope project agent-dream -- npx -y agent-dream
```

Everything after `--` is the server command. Scopes:

| Scope | Stored in | Who gets it |
|---|---|---|
| `local` (default) | `~/.claude.json`, for this project | Only you, only this project |
| `project` | `.mcp.json` in the project root | Everyone who opens the project (Claude Code asks each person to approve it) |
| `user` | `~/.claude.json` | You, in every project |

Or write `.mcp.json` yourself:

```json
{
  "mcpServers": {
    "agent-dream": {
      "command": "npx",
      "args": ["-y", "agent-dream"]
    }
  }
}
```

An entry without `type` is a stdio server.

**Which project does it use?** agent-dream keeps memory in `<project>/.dream/`, where the project is `--project`, else the
`AGENT_DREAM_PROJECT` environment variable, else the directory the server was started in. Claude Code's docs say it passes
`CLAUDE_PROJECT_DIR` (the project root) to the server, but they do not promise the working directory. Check with
`memory_status` (below). If `dir` is wrong, pin it:

```sh
claude mcp add --transport stdio --env AGENT_DREAM_PROJECT=/path/to/project agent-dream -- npx -y agent-dream
```

(Keep at least one option, such as `--transport stdio`, between `--env` and the server name; otherwise the CLI reads the
name as another `KEY=value` pair.)

### Windows

Claude Code's docs have recommended wrapping `npx` with `cmd /c` on native Windows (not WSL) when a server fails with
"Connection closed":

```json
{
  "mcpServers": {
    "agent-dream": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "agent-dream"]
    }
  }
}
```

Writing this in `.mcp.json` avoids shell quoting problems with `/c` on the `claude mcp add` command line. *(Whether the
wrapper is still required in current Claude Code versions is not verified; try without it first.)*

## Check that it works

Run `/mcp` in Claude Code to see the server's status, then ask: "Call the agent-dream memory_status tool." Check that `dir`
is `<your project>/.dream` and that `availableHarnesses` includes `claude-code`.

## Running a dream

Type `/` and look for the agent-dream prompts. Claude Code lists them as `/agent-dream:dream (MCP)` and
`/agent-dream:resume (MCP)`, and also accepts the long form:

```text
/mcp__agent-dream__dream
/mcp__agent-dream__resume
```

Arguments go after the command, separated by spaces, in order (`session`, then `dry_run`). You can also simply ask: "Run a
dream with the agent-dream tools."

When it finishes, Claude tells you memory is saved. Then run `/compact`, or start a new session; `/agent-dream:resume` picks
the thread back up.

For a very long thread, start a **new** session and dream the old one by id (`dream_sessions` lists recent sessions). The
old thread is read from disk in chunks, so the new session's context stays small.

**Large tool results.** Claude Code warns when an MCP tool result exceeds 10,000 tokens and, by default, moves results
over 25,000 tokens or 50,000 characters into a file that Claude reads on demand. A dream step stays under that with the
default `chunkTokens` (6,000). If you raise `chunkTokens` a lot, expect steps to arrive as files.

## Loading memory in new sessions

- **Server instructions:** Claude Code loads MCP server instructions at session start, cut at 4,096 characters. The usage
  note fits; a large index will be cut, which is one reason for the line below.
- **CLAUDE.md / AGENTS.md:** add the [one-line snippet](../agents-md-snippet.md). Claude Code reads `CLAUDE.md`, and reads
  `AGENTS.md` instead when there is no `CLAUDE.md` (recent versions).
- **Skill (optional):** copy [`skill/agent-dream/`](../../skill/agent-dream/SKILL.md) to `.claude/skills/agent-dream/`
  (project) or `~/.claude/skills/agent-dream/` (all projects).
- **Resources:** type `@` to reference MCP resources, in the form `@agent-dream:memory://index`. *(The exact rendering of
  agent-dream's resource names in the `@` menu was not checked.)*

### agent-dream and Claude Code's auto memory

Claude Code has its own auto memory, which loads the first 200 lines or 25 KB of its `MEMORY.md`. The two can coexist:
auto memory is what Claude notes as it works; agent-dream is a verified, transcript-checked layer kept in the project's
`.dream/` folder that other hosts can share. agent-dream does not read or modify Claude Code's auto memory.

## Transcripts

agent-dream reads `~/.claude/projects/<project>/<session>.jsonl` read-only. Subagent (sidechain) messages are left out of
the main thread. The format is internal to Claude Code and may change between releases.

## Verified vs not verified

| Fact | Status |
|---|---|
| `claude mcp add [options] <name> -- <command> [args...]`, `--transport stdio`, `--env`, `--scope local/project/user` | Verified (Claude Code docs) |
| `.mcp.json` with `mcpServers`; no `type` means stdio | Verified |
| Where each scope is stored | Verified |
| MCP prompts listed as `/server:prompt (MCP)`, and `/mcp__server__prompt` also works; `-` is kept in server names | Verified (rule); the exact names for agent-dream are inferred from it |
| Resources referenced with `@server:protocol://path` | Verified |
| Server instructions load at session start, cut at 4,096 characters | Verified |
| Tool output limits (10k warning, 25k tokens, 50,000 characters) | Verified |
| `CLAUDE_PROJECT_DIR` is set for the server process | Verified |
| Working directory of the server process | Not verified |
| `cmd /c` wrapper still required on native Windows | Not verified (docs and issue reports disagree) |
| Skill and CLAUDE.md/AGENTS.md locations | Verified |
| Tested end-to-end in a real Claude Code session | Not yet (v0.1 pre-release) |

## Sources

- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/memory

Checked on 2026-11-11.
