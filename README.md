# agent-dream

Memory "dreaming" for any coding agent, delivered as an MCP server.

`/dream` is a durable alternative to `/compact`. The agent re-reads past session transcripts, corrects its memory notes
against what actually happened, reorganizes them into small linked pages, writes a thread-state page so the current line of
work survives compaction, and keeps a small index that loads into every new session. It uses only the model your current
thread is already running and makes no outside LLM calls. Because it is a standard MCP server, it works with opencode, Codex,
Claude Code, Copilot/VS Code and any other MCP-capable harness.

Inspired by Anthropic's research post
[The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory).

**Status:** early design. Nothing to install yet.

## License

[MIT](LICENSE)
