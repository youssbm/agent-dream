# agent-dream in Codex

agent-dream can read Codex's session files, so a dream can process Codex threads directly. Codex does not (as far as its
docs say) turn MCP prompts into slash commands, so you start a dream by asking for it.

## Requirements

- Node.js 22.13 or newer on your PATH (`node --version`).
- `git` on your PATH is recommended.

## Add the server

With the CLI:

```sh
codex mcp add agent-dream -- npx -y agent-dream-mcp
```

Or add a table to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-dream]
command = "npx"
args = ["-y", "agent-dream-mcp"]
```

The Codex CLI, desktop app and IDE extension share this file. You can also put the same table in a project's
`.codex/config.toml`; Codex only reads project-scoped config for trusted projects.

Useful optional fields:

| Field | Use |
|---|---|
| `cwd` | Directory to start the server in. agent-dream uses its start directory as the project unless told otherwise. |
| `env` | For example `env = { AGENT_DREAM_PROJECT = "/path/to/project" }`. |
| `startup_timeout_sec` | Default 10. The first `npx` run downloads the package; raise this if the server times out on first start. |
| `tool_timeout_sec` | Default 60. |
| `enabled` | `false` keeps the entry but does not start the server. |

**Which project does it use?** agent-dream keeps memory in `<project>/.dream/`, where the project is `--project`, else
`AGENT_DREAM_PROJECT`, else the directory the server was started in. The Codex docs do not say which directory a server
starts in when `cwd` is not set. Check with `memory_status` (below); if `dir` is not your project, set `cwd` or add
`"--project", "/path/to/project"` to `args`.

Run `codex mcp list` to see configured servers, or `/mcp` inside the Codex TUI to see active ones.

## Check that it works

Start Codex in the project and ask: "Call the agent-dream memory_status tool." Check that `dir` is
`<your project>/.dream` and that `availableHarnesses` includes `codex`.

## Running a dream

Ask in plain words:

> Run a dream with the agent-dream tools.

The tool descriptions explain the loop (`dream_begin` → `dream_step` … → `dream_commit`), so the model can run it without
any slash command. To dream a particular session, say so: "Run a dream on session `<id>`" (`dream_sessions` lists recent
sessions with their ids).

When it finishes, the agent tells you memory is saved. Then run Codex's `/compact`, or start a new session.

For a very long thread, start a **new** session and ask it to dream the old session by id. The old thread is read from disk
in chunks, so the new session's context stays small.

If you want a `/`-style shortcut, install the [skill](../../skill/agent-dream/SKILL.md) (below) and pick it with `/skills`.

## Loading memory in new sessions

- **Server instructions:** Codex reads the `instructions` an MCP server returns at startup and uses them as guidance for that
  server. The Codex docs advise keeping the first 512 characters self-contained, so do not rely on the index arriving this
  way in full.
- **AGENTS.md:** add the [one-line snippet](../agents-md-snippet.md) to `AGENTS.md` in your repository (or
  `~/.codex/AGENTS.md` for all projects). Since there is no `/dream` command in Codex, you may prefer the variation that says
  "suggest running a dream with the agent-dream tools".
- **Skill (optional):** copy [`skill/agent-dream/`](../../skill/agent-dream/SKILL.md) to `.agents/skills/agent-dream/` in
  your repository, or to `~/.agents/skills/agent-dream/` for all projects.

## Transcripts

agent-dream reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` read-only. Encrypted reasoning items are skipped, and
injected environment/instruction messages are treated as system messages. The format is internal to Codex and may change; if
it cannot be read, `memory_status` will not list `codex` under `availableHarnesses`. v0.1 is built to read `~/.codex/sessions`;
a custom `CODEX_HOME` may not be picked up.

## Windows

If the server fails to start on native Windows, try `command = "cmd"` with `args = ["/c", "npx", "-y", "agent-dream-mcp"]`.
*(Not verified for Codex; this is the usual workaround for `npx` launched without a shell.)*

## Verified vs not verified

| Fact | Status |
|---|---|
| `[mcp_servers.<name>]` with `command`, `args`, `env`, `cwd`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled` | Verified (Codex docs) |
| `~/.codex/config.toml`, project `.codex/config.toml` for trusted projects | Verified |
| `codex mcp add <name> -- <command>`, `codex mcp list`, `/mcp` | Verified |
| Server instructions are read; first 512 characters matter most | Verified |
| MCP prompts as slash commands | Not supported according to the current docs (not mentioned; an open feature request exists) |
| Default working directory of an MCP server without `cwd` | Not verified |
| Skill directories (`.agents/skills`, `~/.agents/skills`) and `/skills` | Verified |
| AGENTS.md locations | Verified |
| `cmd /c` workaround on Windows | Not verified |
| Tested end-to-end in a real Codex session | Not yet (v0.1 pre-release) |

## Sources

- https://learn.chatgpt.com/docs/extend/mcp?surface=cli (redirected from https://developers.openai.com/codex/mcp)
- https://learn.chatgpt.com/docs/cli/slash-commands/
- https://learn.chatgpt.com/docs/build-skills (redirected from https://developers.openai.com/codex/skills)
- https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Feature request for MCP prompts in Codex: https://github.com/openai/codex/issues/8342 (not fetched directly; seen in search
  results)

Checked on 2026-11-11.
