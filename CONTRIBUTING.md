# Contributing to agent-dream

Thanks for helping. Bug reports, host setup notes, transcript adapters and fixes are all welcome.

## Setup

You need Node.js 22.13 or newer (CI runs 22.x and 24.x on Linux and Windows) and `git`.

```sh
git clone https://github.com/youssbm/agent-dream.git
cd agent-dream
npm install
npm run check
```

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over all packages |
| `npm test` | Vitest, with networking blocked |
| `npm run build` | Bundles the server into `packages/server/dist/agent-dream.js` |
| `npm run check:deps` | Dependency allow-list and no-network source scan |
| `npm run check` | All of the above; this is what CI runs |

To try a local build in a host, point the host at the bundle instead of `npx`:
`node /path/to/agent-dream/packages/server/dist/agent-dream.js --project /path/to/some/project`.

## Layout

```
packages/core/     store, transcript adapters, quality checks (redaction, lint, search), dream engine
packages/server/   MCP tools, prompts, resources and the agent-dream bin
packages/bench/    evaluation harness
fixtures/          synthetic transcripts used by tests
docs/              host guides and design notes
skill/             the optional Agent Skill
```

Shared types and interfaces live in `packages/core/src/types.ts`. Changes there affect every module, so open an issue or
explain the reason clearly in the pull request.

## Ground rules

**No network, no LLM.** The server must never open a network connection or call a model; all judgment comes from the host's
model through tool calls. Concretely:

- do not import `http`, `https`, `http2`, `net`, `tls`, `dns` or `dgram`, and do not call `fetch`;
- runtime dependencies are limited to an allow-list in `scripts/check-deps.mjs`; adding one needs a good reason;
- tests run with a guard (`scripts/no-network-guard.ts`) that throws on network use.

Running the local `git` binary through `node:child_process` (no shell) is fine.

**Nothing on stdout.** stdout carries the MCP protocol. Library code must not log; the bin may write to stderr.

**Only `.dream/` is written.** Transcript stores are read-only. Every write goes through the memory store, which validates
paths.

**Cross-platform.** Use `node:path`, store relative paths with forward slashes, and handle CRLF input. CI runs on Windows.

**TypeScript.** Strict mode, ESM, `.ts` extensions in relative imports, `import type` for type-only imports, Node
built-ins as `node:fs` and so on. Avoid `any`.

## Fixtures must be synthetic

Transcripts on your machine contain your code, your conversations and possibly secrets. **Never commit real transcript
content**, even "scrubbed". Look at real files only to learn their structure (record types, field names), then write small
synthetic fixtures by hand under `fixtures/transcripts/<harness>/`. For SQLite stores, build the fixture database in the
test setup (or commit a small SQL script), not a binary file.

Fixtures include a "planted error" story that several tests reuse: memory claims one thing (for example a dev server on port
3000), and the transcript later shows the truth (`listening on :5173`, and the user saying it's 5173). Please keep that
story working when you change fixtures.

## Adding a transcript adapter

An adapter teaches agent-dream to read another host's sessions. It implements `TranscriptAdapter` from
`packages/core/src/types.ts`:

```ts
interface TranscriptAdapter {
  readonly harness: Harness;
  available(): Promise<boolean>;                               // store exists here; never throws
  listSessions(opts?: ListSessionsOptions): Promise<SessionInfo[]>; // newest first; filter by cwd and since
  readSession(id: string): Promise<TranscriptMessage[]>;        // full, unfiltered, normalized
}
```

Guidelines:

1. Put it in `packages/core/src/transcripts/<harness>.ts` with a constructor that accepts overrides
   (`{ homeDir?, root? }`, plus a path option if the store is a single file) so tests can point it at fixtures.
2. **Read-only, always.** Open databases in read-only mode, never write next to the store, and cope with a store that is
   busy or locked by the running host.
3. **Fast listing.** Stores can hold thousands of large files. Read only what you need for metadata (first lines, file
   mtime) in `listSessions`; stream lines in `readSession`.
4. **Normalize.** Produce `TranscriptMessage`s with stable, 0-based `idx` values (evidence quotes cite them, so the same
   transcript must always give the same numbering), roles `user`/`assistant`/`system`/`tool`, and parts of kind `text`,
   `tool_call`, `tool_result`, `reasoning`, `file` or `other`. Injected environment or instruction messages become `system`.
5. **Match the project.** Fill `SessionInfo.cwd` from the transcript itself and compare with `samePath` from
   `transcripts/paths.ts`.
6. **Leave out subagents** (child or sidechain sessions) from `listSessions` by default.
7. Register it in `transcripts/registry.ts`, add the harness name to the `Harness` type (this is a contract change, so say so
   in the PR), and document where the store lives and which host versions you tested.
8. Add tests under `packages/core/test/transcripts/` with synthetic fixtures: listing, cwd filtering, reading, normalization
   and subagent exclusion.

If you cannot write the adapter but know where a host keeps its sessions and in what format, an issue describing the
structure (not the content) is useful too.

## Host guides

Host behaviour changes often. When you update `docs/hosts/*.md`, check the host's official documentation, cite the URL at the
bottom of the page, and mark anything you could not verify. Reports from real use ("tested with opencode 1.x on macOS:
prompts appear as …") are very welcome.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`, optionally with a scope (`feat(core): …`).
- Keep pull requests focused, include tests for behaviour changes, and make sure `npm run check` passes.
- By contributing you agree that your work is licensed under the [MIT License](LICENSE).
