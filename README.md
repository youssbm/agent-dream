# agent-dream

Memory "dreaming" for coding agents, as a standard MCP server.

`/compact` shrinks the current context, and the summary dies with the session. **`/dream` writes durable memory instead.**
Your agent re-reads past session transcripts, checks its existing notes against what actually happened, fixes or drops the
wrong ones, organizes what it learned into small linked pages, records where the current line of work stands, and keeps a
short index that the next session loads. Run `/dream`, then `/compact` or start fresh, and nothing important is lost.

- **Uses your current model.** The server never calls an LLM. The model you are already running does the thinking, one
  small step at a time, through ordinary tool calls.
- **Checks its corrections.** A note can only be corrected or deleted with an exact quote from the transcript, and the
  server verifies that the quote is really there.
- **Works across hosts.** One memory folder per project, shared by opencode, Codex, Claude Code, VS Code/Copilot and any
  other MCP host.
- **Local only.** No network, no API keys. Memory lives in `<project>/.dream/`, git-ignored, with its own history.

The approach follows Anthropic's post [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory).

> **Status: v0.1, pre-release.** The test suite drives full dream runs with scripted model outputs (in-process and over
> real stdio against the built bundle), and a full dream has been run end-to-end in opencode 2.2.6 with a real model.
> Codex, Claude Code and VS Code have not been tested end-to-end yet, and there are no benchmark results yet.
> Expect rough edges and changes.

## How it works

```
  your coding agent (opencode, Codex, Claude Code, VS Code, ...)
    │  the current model makes every judgment call
    │  MCP over stdio: tools · prompts · resources · instructions
    ▼
  agent-dream server (deterministic: no LLM, no network)
    ├─ reads transcripts (read-only) ── ~/.claude/projects, ~/.codex/sessions, opencode.db
    ├─ filters and chunks them, hands the model one step at a time
    ├─ validates each answer, checks quoted evidence against the transcript
    └─ writes only <project>/.dream/ ── pages, thread pages, MEMORY.md, history
```

A dream is a job made of steps. `dream_begin` returns the first step (instructions, input, expected JSON output). The
model does it and submits with `dream_step`; the server checks the output and returns the next step, or the same step with
reasons if it was wrong. The steps are: **plan → extract claims → verify existing pages → find cross-session patterns →
outline → write pages (one per step) → fix gaps → write the thread page → rewrite the index → commit.** Jobs are saved to
disk, so an interrupted dream can be resumed.

Details: [docs/how-it-works.md](docs/how-it-works.md).

## Install

Requires **Node.js 22.13+**. `git` on your PATH is recommended (memory history; without it, snapshot copies are used).
The npm package is [`agent-dream-mcp`](https://www.npmjs.com/package/agent-dream-mcp) (one self-contained file, no
dependencies). The server is started by your host with:

```sh
npx -y agent-dream-mcp   # optional: --project <dir>  (default: $AGENT_DREAM_PROJECT, else $CLAUDE_PROJECT_DIR, else the start directory)
```

| Host | Minimal setup | `/dream` | Transcripts read | Guide |
|---|---|---|---|---|
| opencode | `opencode mcp add agent-dream -- npx -y agent-dream-mcp` | `/agent-dream:dream` | yes | [opencode](docs/hosts/opencode.md) |
| Claude Code | `claude mcp add --transport stdio --scope project agent-dream -- npx -y agent-dream-mcp` | `/agent-dream:dream` | yes | [Claude Code](docs/hosts/claude-code.md) |
| Codex | `codex mcp add agent-dream -- npx -y agent-dream-mcp` | ask "run a dream" | yes | [Codex](docs/hosts/codex.md) |
| VS Code / Copilot | `mcpServers` entry in `~/.copilot/mcp-config.json` | `/mcp.agent-dream.dream` (Local harness) or ask | not yet | [VS Code](docs/hosts/vscode-copilot.md) |
| Anything else with MCP tools | see guide | ask "run a dream" | — | [Other hosts](docs/hosts/other.md) |

Then add one line to your project's `AGENTS.md` or `CLAUDE.md` so every session starts by loading memory
([why and where](docs/agents-md-snippet.md)):

```markdown
At the start of a task, call the memory_index tool of the agent-dream MCP server; save durable learnings with memory_note; suggest /dream when the thread gets long.
```

Optionally install the [skill](skill/agent-dream/SKILL.md), which tells the agent when to read memory, when to take notes
and how to run a dream.

## Using it

1. Work as usual. The agent reads `MEMORY.md` at the start and can save quick notes with `memory_note`.
2. When a thread gets long, or a piece of work is done, run `/dream` (or ask "run a dream"). The agent walks the steps;
   it may ask you which session to dream if several were active recently.
3. You get a summary: pages created, updated and deleted, and each correction with the quote that justified it.
4. Run `/compact` or start a new session. `/resume` (where prompts are supported) reads the index and the thread page back.

For a very long thread, start a fresh session and dream the old one by id, so the dream does not eat the old thread's
remaining context. `dream_sessions` lists recent sessions.

## MCP surface

| Tool | Purpose |
|---|---|
| `memory_index` | The index (`MEMORY.md`). |
| `memory_search` | Search pages; `include_transcripts` also searches transcripts. Returns names, snippets, sources. |
| `memory_read` | One page or thread page by name (or `index`). |
| `memory_note` | Save a short note to the inbox; the next dream organizes it. |
| `memory_status` | Last dream, new messages since, pages due for re-check, staged/active jobs, lint issues. |
| `dream_sessions` | Recent sessions for this project, across supported hosts. |
| `dream_begin` | Start (or `resume`) a dream job. Options: `harness`, `session`, `since`, `scope`, `dry_run`, `confirm`. |
| `dream_step` | Submit the current step's output; get the next step. |
| `dream_commit` | Apply the finished job, or stage it for review. |
| `dream_review` | `show` / `approve` / `reject` staged changes. |
| `dream_rollback` | Undo a dream run (latest by default). |

| Prompt | Purpose |
|---|---|
| `dream` | Run the dream loop (args: `session`, `dry_run`) and finish by telling you memory is saved. |
| `resume` | Load the index and the active thread page at the start of a session. |

Resources: `memory://index`, `memory://page/{name}`, `memory://thread/{name}`. The server's `instructions` carry a short
usage note and the index.

Only tools are required. Prompts, resources and instructions are used where the host supports them.

## Memory folder

```
.dream/
  MEMORY.md     index loaded every session (max 200 lines / 25 KB)
  pages/        one subject per page, linked with [[page-name]]
  threads/      one state page per dreamed session
  dream.md      your notes on what matters in this project (edit it)
  log.md        what each dream changed, with evidence
  config.json   settings (below)
  state.json    progress per session, read counts
  inbox.jsonl   notes waiting for the next dream
```

A page is Markdown with front matter: `title`, `kind` (fact, rule, decision, howto, trap, preference, overview, thread),
`volatile`, `confidence` (verified/unverified), `verified_at`, `sources` (harness, session, message range) and `links`.
Thread pages hold the goal, decisions with reasons, current state, open questions, files touched, failed approaches, and
related pages. See [page format](docs/how-it-works.md#page-format) and [thread pages](docs/how-it-works.md#thread-pages).

## Configuration

`.dream/config.json` is created with defaults on first use. Invalid values are ignored.

| Field | Default | Meaning |
|---|---|---|
| `chunkTokens` | `6000` | Max estimated tokens of transcript per step. |
| `runTokens` | `150000` | Max estimated tokens of input per dream run. |
| `indexMaxLines` | `200` | Line cap for `MEMORY.md`. |
| `indexMaxBytes` | `25600` | Byte cap for `MEMORY.md` (25 KB). |
| `applyMode` | `"auto"` | `"auto"` applies each run; `"review"` stages every run for `dream_review`. |
| `safetyNetRatio` | `0.3` | Stage instead of apply when a run would delete or heavily rewrite more than this share of pages. |
| `safetyNetMinPages` | `5` | The safety net only applies once this many pages exist. |
| `maxWikiSourceRatio` | `1.0` | Lint: warn when memory grows larger than the transcript text it came from. |
| `harnesses` | all three | Which transcript stores to read: `"claude-code"`, `"codex"`, `"opencode"`. |
| `reverifyAfterDays` | `30` | Re-check a page after this many days. |
| `reverifyVolatileAfterDays` | `7` | Re-check a page marked `volatile` after this many days. |

Token counts are estimates (characters ÷ 4). Each dream token is billed at your current model's rate.

## Safety and privacy

- **No outside calls.** The server makes no network connections and calls no model. CI checks the dependency list and the
  source for network use, and tests run with networking blocked.
- **Transcripts are read-only and untrusted.** They are never modified. Transcript text is handed to the model inside
  marked "untrusted" blocks, with instructions not to follow anything written there.
- **Evidence-checked corrections.** `correct` and `delete` verdicts must quote the transcript; the server rejects quotes
  that are not in the cited messages.
- **Secrets redacted.** Common key and token formats are replaced with `[REDACTED:<kind>]` before anything is written.
  This is pattern-based and will not catch everything.
- **Auto-apply, with a safety net.** Each run is one commit in `.dream/`'s own git history (never your project's). Once
  there are 5+ pages, a run that would delete or rewrite more than 30% of them is staged for review instead. `dream_rollback` undoes any run.
- **Stays on your machine.** `.dream/` is added to your project's `.gitignore`.
- **Not a sandbox.** The server only writes inside `.dream/`, but your agent still has its own file tools. Review the
  dream summary as you would any agent change.

## Limitations

- **An MCP server cannot compact your context.** After a dream, run your host's `/compact` or start a new session yourself.
- **No fresh child session.** A dream runs inside the current thread and spends its context. For long threads, dream from
  a new session by session id.
- **Uneven host support.** Prompts (`/dream`), server instructions and resources are optional MCP features and hosts differ.
  Codex has no MCP prompt commands; VS Code shows them only in its deprecated Local harness. The tools work everywhere.
- **Transcript formats are host internals.** Supported in v0.1: Claude Code (`~/.claude/projects`), Codex
  (`~/.codex/sessions`) and opencode (`~/.local/share/opencode/opencode.db`, read-only). They can change with host
  updates. No Copilot adapter yet.
- **Sessions are matched by working directory.** A session started in a subdirectory of the project is not picked up.
- **Quality depends on your model.** The server validates structure and evidence, not judgment. A weaker model may
  need more retries and write weaker pages.
- **Sharing with a team is not streamlined.** `.dream/` contains its own git repository, so committing it inside your
  project repo does not work cleanly. You can push `.dream/` to a separate remote if you want to share it.
- **No benchmark results yet.** A small evaluation harness (`packages/bench`) exists; results will be published when there
  are real numbers.

## Development

```sh
git clone https://github.com/youssefbm2008/agent-dream.git
cd agent-dream
npm install
npm run check      # typecheck, tests, bundle, no-network dependency check
```

Layout: `packages/core` (store, transcript adapters, quality checks, dream engine), `packages/server` (MCP wiring; published
as `agent-dream-mcp`), `packages/bench` (evaluation), `fixtures/` (synthetic transcripts). See
[CONTRIBUTING.md](CONTRIBUTING.md), including how to add a transcript adapter for another host.

## License

[MIT](LICENSE)
