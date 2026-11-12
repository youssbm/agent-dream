# agent-dream in other MCP hosts

agent-dream is a plain MCP server over stdio. Any host that can launch a local MCP server and let the model call its tools
can use it. Nothing else is required: prompts, resources and server instructions are conveniences.

## The command

```sh
npx -y agent-dream                          # project = the directory the host starts it in
npx -y agent-dream --project /path/to/repo  # explicit project
```

| Option | Meaning |
|---|---|
| `--project <dir>` | Project whose `.dream/` folder holds memory. |
| `AGENT_DREAM_PROJECT` (env) | Same, used when `--project` is not given. |
| `--version`, `--help` | Print and exit. |

Requirements: Node.js 22.13 or newer, and preferably `git` on the PATH. The server speaks MCP over stdin/stdout only. It
writes logs to stderr, never opens a network connection, and never calls a model.

Most hosts accept a JSON entry shaped like one of these:

```json
{ "mcpServers": { "agent-dream": { "command": "npx", "args": ["-y", "agent-dream"] } } }
```

```json
{ "servers": { "agent-dream": { "type": "stdio", "command": "npx", "args": ["-y", "agent-dream"] } } }
```

Check your host's documentation for the exact file and key names. On native Windows, if the host cannot start `npx`
directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "agent-dream"]`.

## What your host needs to support

| MCP feature | Needed? | What you lose without it |
|---|---|---|
| Tools | **Yes** | Everything. |
| Prompts | No | No `/dream` or `/resume` command; ask the agent to "run a dream with the agent-dream tools" instead. |
| Server instructions | No | The index is not loaded automatically; use the [AGENTS.md line](../agents-md-snippet.md) so the agent calls `memory_index`. |
| Resources | No | Nothing important; `memory_index` and `memory_read` return the same content. |

The model must also be able to follow a multi-step tool protocol: call `dream_begin`, do the step it returns, submit with
`dream_step`, repeat, then `dream_commit`. Every tool result restates the next action, and invalid submissions are rejected
with the reasons, so a capable model can recover from mistakes.

## Transcripts

Dreaming re-reads transcripts from Claude Code, Codex or opencode for the same project directory on this machine. A host
whose transcripts agent-dream cannot read can still use the memory tools and `memory_note`, and can run a dream over sessions
from those three hosts. Adding a transcript adapter for another host is described in
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## Check that it works

Ask the agent to call `memory_status`. It reports the memory directory (`dir`), how many pages exist, which transcript stores
were found (`availableHarnesses`) and how many new messages are waiting (`pending`).

## Verified vs not verified

The two JSON shapes above are the common conventions used by Claude Code (`mcpServers`) and VS Code (`servers`). Whether a
given host accepts either is for that host's docs to say; nothing on this page was tested against a specific host.
