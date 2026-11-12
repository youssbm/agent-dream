# agent-dream in VS Code (GitHub Copilot)

VS Code can run agent-dream's tools, so Copilot can read and write memory. **agent-dream v0.1 cannot read Copilot's chat
transcripts**, so a dream started from VS Code can only process sessions recorded by Claude Code, Codex or opencode for the
same project on the same machine. If you use only Copilot, you get the memory tools and notes, but not transcript-checked
dreaming. See [Limitations](#limitations).

VS Code's MCP setup has changed recently: it now distinguishes the **Copilot** agent harness from the older **Local**
harness, which its docs mark as deprecated (scheduled for removal in February 2027). The two read different config files.

## Requirements

- Node.js 22.13 or newer on your PATH (`node --version`).
- `git` on your PATH is recommended.

## Add the server

### Copilot harness (current)

User-wide, in `~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`):

```json
{
  "mcpServers": {
    "agent-dream": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-dream-mcp", "--project", "/path/to/project"],
      "tools": ["*"]
    }
  }
}
```

A user-wide entry serves every workspace, so either pass `--project` as above or set `cwd` (this file supports it) to the
project you want memory for.

Per workspace, the same `mcpServers` object can go in a `.mcp.json` file at the workspace root. VS Code only offers this
when the experimental setting `chat.mcp.workspaceRootConfig.enabled` is on, and that file does not support `cwd`.

### Local harness (deprecated): `.vscode/mcp.json`

```json
{
  "servers": {
    "agent-dream": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-dream-mcp"]
    }
  }
}
```

Here `cwd` defaults to the workspace folder, so memory lands in `<workspace>/.dream/` without extra arguments. The
**MCP: Open User Configuration** command opens the user-level file in this same `servers` format.

**Which project does it use?** agent-dream keeps memory in `<project>/.dream/`, where the project is `--project`, else the
`AGENT_DREAM_PROJECT` environment variable, else the directory the server was started in. Check with `memory_status`.

## Check that it works

In chat, ask: "Call the agent-dream memory_status tool." Check that `dir` is `<your project>/.dream`.
`availableHarnesses` lists which other hosts' transcripts were found on this machine.

## Running a dream

- **Local harness:** MCP prompts appear as slash commands named `/mcp.<server>.<prompt>`, so `/mcp.agent-dream.dream` and
  `/mcp.agent-dream.resume`. VS Code asks for arguments in a dialog.
- **Copilot harness:** VS Code's docs say the `/mcp.<server>.<prompt>` picker is not available in Copilot sessions. Ask in
  plain words instead ("Run a dream with the agent-dream tools"), or install the skill below.

Because Copilot transcripts are not read in v0.1, a dream from VS Code needs a session from a supported host. Use
`dream_sessions` to see which sessions agent-dream can find for this project, and name one ("dream session `<id>`").

## Loading memory in new sessions

- **Server instructions:** whether VS Code passes MCP server instructions to the model is not stated in its docs. Do not
  rely on it.
- **AGENTS.md:** add the [one-line snippet](../agents-md-snippet.md). In the Copilot harness, VS Code reads `AGENTS.md` or
  `.github/copilot-instructions.md`.
- **Skill (optional):** copy [`skill/agent-dream/`](../../skill/agent-dream/SKILL.md) to `.github/skills/agent-dream/`
  (project) or `~/.copilot/skills/agent-dream/` (personal). VS Code also lists `.claude/skills/` and `.agents/skills/` as
  project locations.
- **Resources:** in the Local harness, **MCP: Browse Resources** (and, where supported, Add Context → MCP Resources) shows
  `memory://index` and the pages. In Copilot sessions, use the `memory_*` tools instead.

## Limitations

- No Copilot transcript adapter in v0.1. If you know where and how Copilot stores chat sessions on disk, an adapter is a
  welcome contribution (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).
- Prompts and resources depend on the harness, as described above.

## Verified vs not verified

| Fact | Status |
|---|---|
| Copilot `mcpServers` format with `type: "stdio"`, `command`, `args`, `env`, `cwd`, `tools` | Verified (VS Code MCP configuration reference) |
| `~/.copilot/mcp-config.json` / `$COPILOT_HOME`; workspace `.mcp.json` behind `chat.mcp.workspaceRootConfig.enabled`; no `cwd` there | Verified |
| `.vscode/mcp.json` `servers` format, `cwd` defaults to the workspace folder | Verified |
| Local harness deprecated, removal planned February 2027 | Verified |
| `/mcp.<server>.<prompt>` in Local harness sessions, not in Copilot sessions | Verified (VS Code MCP developer guide) |
| Server instructions passed to the model | Not verified (not mentioned in VS Code docs) |
| Skill and instruction-file locations | Verified |
| Where Copilot stores chat transcripts | Not investigated for v0.1 |
| Tested end-to-end in VS Code | Not yet (v0.1 pre-release) |

## Sources

- https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- https://code.visualstudio.com/api/extension-guides/ai/mcp
- https://code.visualstudio.com/docs/agent-customization/agent-skills
- https://code.visualstudio.com/docs/copilot/customization/custom-instructions

Checked on 2026-11-11.
