# The AGENTS.md / CLAUDE.md line

Not every host passes an MCP server's `instructions` to the model, and some shorten them. One line in your project's
instruction file makes sure the agent loads memory at the start of a task, whatever the host does.

Add this to `AGENTS.md` (or `CLAUDE.md`) in your project root:

```markdown
At the start of a task, call the memory_index tool of the agent-dream MCP server; save durable learnings with memory_note; suggest /dream when the thread gets long.
```

That is all. Keep it to one line: long instruction files are followed less reliably, and the details live in the tool
descriptions and in memory itself.

## Which file each host reads

| Host | File | Notes |
|---|---|---|
| opencode | `AGENTS.md` in the project (or `~/.config/opencode/AGENTS.md` for all projects) | Falls back to `CLAUDE.md` when there is no `AGENTS.md`. |
| Codex | `AGENTS.md` from the repository root down to the current directory (or `~/.codex/AGENTS.md`) | `AGENTS.override.md` takes precedence in the same directory. |
| Claude Code | `CLAUDE.md`, or `AGENTS.md` when there is no `CLAUDE.md` | Reading `AGENTS.md` directly needs a recent Claude Code (the docs say v2.1.277 or later). If you have a `CLAUDE.md`, put the line there or add `@AGENTS.md` to import it. |
| VS Code / Copilot | `AGENTS.md` or `.github/copilot-instructions.md` | Which files are read depends on the agent harness selected in VS Code. |

## Variations

- **Host without MCP prompts** (for example Codex): replace "suggest /dream" with "suggest running a dream with the
  agent-dream tools".
- **Different server name.** If you registered the server under another name, use that name in the line.

## Sources

- opencode rules: https://opencode.ai/docs/rules/
- Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Claude Code memory: https://code.claude.com/docs/en/memory
- VS Code custom instructions: https://code.visualstudio.com/docs/copilot/customization/custom-instructions

Checked on 2026-11-11.
