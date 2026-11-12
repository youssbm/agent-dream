# agent-dream in opencode

agent-dream can read opencode's own session store, so `/dream` works on opencode threads directly.

## Requirements

- Node.js 22.13 or newer on your PATH (`node --version`).
- `git` on your PATH is recommended (it gives memory a proper history; without it the server keeps snapshot copies).

## Add the server

Add an entry under `mcp.servers` in your project's `opencode.json` (or `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "agent-dream": {
        "type": "local",
        "command": ["npx", "-y", "agent-dream-mcp"]
      }
    }
  }
}
```

Or use the CLI, which writes to the project configuration (add `--global` for every project):

```sh
opencode mcp add agent-dream -- npx -y agent-dream-mcp
```

Notes:

- `command` is an array: the program, then its arguments.
- opencode starts local servers in the workspace directory unless you set `cwd`, so agent-dream uses that directory as the
  project and keeps memory in `<workspace>/.dream/`. To point it somewhere else, add `"--project", "/path/to/project"` to
  the command array, or set `"environment": { "AGENT_DREAM_PROJECT": "/path/to/project" }`.
- In a global config (`~/.config/opencode/opencode.json`), the workspace is whichever project you open, which is usually
  what you want.
- Use `"disabled": true` to keep the entry without starting the server.
- **Older opencode versions** placed servers directly under `mcp` (for example `"mcp": { "agent-dream": { "type": "local",
  "command": [...], "enabled": true } }`). Current docs say servers belong under `mcp.servers`. If your version rejects one
  form, try the other. *(The older form is from earlier opencode docs and was not re-checked.)*

## Check that it works

Start opencode in the project and ask: "Call the agent-dream memory_status tool." It should report the memory directory
(`dir`), and `availableHarnesses` should include `opencode`.

In opencode 2.x, MCP servers connect lazily, so `opencode mcp list` can print "No MCP servers configured" even though the
server works. Use the `memory_status` check above instead.

**Code Mode (opencode 2.x):** MCP tools are called through opencode's single `execute` tool (as
`tools["agent-dream"].dream_begin(...)` and so on), and only some of them appear in the inline tool catalog. The model finds
the rest with opencode's tool search. In testing it did so unaided; the server instructions carry the dream loop.

## Running a dream

opencode turns MCP prompts into slash commands named `<server>:<prompt>`. With the server named `agent-dream`:

- `/agent-dream:dream` runs a dream on the current thread. Arguments fill in order (`session`, `harness`, `dry_run`);
  quote values that contain spaces.
- `/agent-dream:resume` reads the index and the active thread page at the start of a new session.

You can always just ask instead: "Run a dream with the agent-dream tools." The tool descriptions carry the whole protocol.

When it finishes, the agent tells you memory is saved. Then run opencode's own `/compact`, or start a new session.

For a very long thread, start a **new** session and run the dream there with the old session's id (`dream_sessions` lists
recent ones). The old thread is read from disk in chunks, so the new session's context stays small.

## Loading memory in new sessions

- **Server instructions:** opencode adds MCP server instructions to the system prompt, so the usage note and the index reach
  the model automatically, as long as the agent's permissions allow at least one of the server's tools.
- **AGENTS.md:** add the [one-line snippet](../agents-md-snippet.md) to your project's `AGENTS.md`. opencode reads
  `AGENTS.md` (falling back to `CLAUDE.md`).
- **Skill (optional):** copy [`skill/agent-dream/`](../../skill/agent-dream/SKILL.md) to `.opencode/skills/agent-dream/`
  (project) or `~/.config/opencode/skills/agent-dream/` (global). opencode also reads `.claude/skills/` and
  `.agents/skills/`.
- **Resources:** opencode exposes MCP resources to the agent through its built-in resource tools, not as slash commands.
  The `memory_*` tools cover the same ground.

## Transcripts

agent-dream reads `~/.local/share/opencode/opencode.db` read-only with Node's built-in SQLite module. Child sessions
(subagents) are skipped. The database layout is internal to opencode and may change between releases; if it cannot be read,
`memory_status` will not list `opencode` under `availableHarnesses`.

## Verified vs not verified

| Fact | Status |
|---|---|
| `mcp.servers` entry with `type: "local"`, `command` array, `environment`, `cwd`, `disabled` | Verified (opencode docs) |
| Config file names and locations (`opencode.json(c)`, `~/.config/opencode/`) | Verified |
| `opencode mcp add <name> -- <command>` and `--global` | Verified |
| Default working directory is the workspace | Verified |
| MCP prompts become `/<server>:<prompt>`; `-` is kept in names | Verified; `/agent-dream:dream` and `/agent-dream:resume` listed and working in opencode 2.2.6 |
| Server instructions are added to the system prompt | Verified (docs, and observed in 2.2.6) |
| Skill directories | Verified |
| Older `mcp.<name>` + `enabled` format | Not re-verified |
| Location of `opencode.db` | Not in opencode's docs; observed at `~/.local/share/opencode/` on Windows; macOS/Linux not checked |
| Session tables | opencode 2.2.6 writes the v2 tables (`session_v2`, `session_message`); older v1 tables are also read |
| Tested end-to-end in a real opencode session | Yes: opencode 2.2.6 on Windows, 2026-11-11 (full dream by free-text request and by `/agent-dream:dream`, 0 rejections; a fresh session answered from memory) |

## Sources

- https://opencode.ai/docs/mcp-servers/
- https://opencode.ai/docs/config/
- https://opencode.ai/docs/skills/
- https://opencode.ai/docs/rules/

Checked on 2026-11-11.
