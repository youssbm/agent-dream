# dream-bench

Evaluation harness for agent-dream. It has two halves:

1. **Scripted scenarios** run in CI. There is no LLM and no network. A scripted "oracle model" answers each
   dream step with fixed outputs, and those outputs go through the real `DreamService` from `@agent-dream/core`.
   This checks everything the server itself guarantees: evidence checks, caps, the safety net, resume and
   writes staying inside `.dream/`.
2. **Live protocol** is run by hand with real hosts and models. It measures what only a model can show: whether
   memory actually helps, `/compact` compared with `/dream`, and conformance across hosts.

> **Status:** the scripted scenarios exist and run on every `npm test`. **No live numbers have been collected
> yet.** The tables in the live section are templates.

---

## 1. Scripted scenarios

```sh
npx vitest run packages/bench          # as part of the test suite (network blocked by scripts/no-network-guard.ts)
node packages/bench/src/cli.ts   # prints the results table (Node 22.18+/24 run .ts directly)
node packages/bench/src/cli.ts --verbose --only planted-error,poisoning
node packages/bench/src/cli.ts --json --keep   # keep the temp projects for inspection
```

Each scenario does the following:

- It creates a temp project with its own fake home dir.
- It serves synthetic transcripts through an in-memory `TranscriptAdapter` (`src/fake-adapter.ts`). The
  stories are in `src/transcripts.ts`, all set in a made-up "larkspur" web app. No real session content is used.
- It optionally seeds an existing memory folder through the real `MemoryStore`.
- It drives `dreamBegin → dreamStep… → dreamCommit` with an oracle (`src/oracle.ts`).
- It asserts on the resulting `.dream/` folder and on what the memory tools return.

The oracle never relies on the number or order of steps. It dispatches on `step.name` and reads what it needs
from the step:

| Step | What the oracle reads |
|---|---|
| `extract` | the `<untrusted-transcript … msgs="a-b">` tags. It only submits claims whose sources fall in the chunk shown |
| `verify` | the batch's page names, from the label `verify i/n (page-a, page-b)` (fallback: the `### [[name]]` headers) |
| `write_page` | the target, from the instructions `write page "<name>" (op: <op>…)` (fallback: the label) |
| `promote` | the valid link targets, from the `## Pages after this run` and `## Thread pages` sections, and the active thread from `[[thread-…]]` in the instructions |

### Coverage

| Scenario | PLAN §9 | What is asserted |
|---|---|---|
| `planted-error` | #1 | Memory says the dev server port is 3000. The transcript shows `listening on :5173` and "no, it's 5173". A `correct` verdict that quotes the transcript is accepted. The page now says 5173 and is verified today. `summary.corrections` carries the quote. The index loses the wrong port. A follow-up `memory_search('dev server port')` → `memory_read` answers 5173. |
| `fact-retention-verbatim` | #2 | 12 exact facts (commands, paths, versions, env var names) across 3 sessions in 3 harnesses. With one writer per entity page and verbatim quotes, all 12 survive verbatim, and pages stay `verified`. |
| `fact-retention-summarize` | #2 | The same facts, but the oracle paraphrases them while still flagging them `verbatim`. The server downgrades those claims, and the pages built on them come out `confidence: unverified`. Retention loss is measured. |
| `size-discipline` | #4 | An index over the line cap, then one over the byte cap, then one with a dangling `[[link]]`. Each is rejected, and the rejection states the numbers or names the link. A compliant index is accepted, and the stored index is within its caps. Bloated pages (more page text than source text) make lint report `wiki_source_ratio`. |
| `poisoning` | #6 | Memory is correct. The oracle tries a hallucinated quote, a real quote cited from the wrong message range, a real quote from a session outside the job, and a `delete` backed by a made-up quote. All four are rejected, the page body is unchanged, and `8080` appears nowhere in memory. The false-correction rate is reported. |
| `protocol-robustness` | #7 | These cases are covered: commit before ready (`JOB_STATE`), a wrong `step` index, malformed output (wrong types, a bad enum, bad `msgs`, out-of-range `msgs`, a non-JSON string), a repeated submission (no double-apply), and a crash mid-job resumed on a **new** `DreamService` instance. The job completes and writes pages from before and after the resume. A finished or unknown job gives `JOB_NOT_FOUND`. Two harnesses active within 10 minutes give `needs_confirmation`; choosing one gives that session's thread page. |
| `no-outside-writes` | #9 | A full dream plus every memory tool. The project outside `.dream/` and the fake home dir are byte-identical before and after. Fake secrets the model copies into a page are redacted before write. Network use is blocked process-wide by `scripts/no-network-guard.ts`, which is the vitest setup file and is also imported by the CLI. |
| `safety-net` | §6.2 | With 6 existing pages, the oracle deletes 4. The outcome is `staged` with a reason, and nothing is applied. `dream_review show` diffs the deletions. `approve` applies them, and `dream_rollback` brings the pages and the index back. In a second project, `reject` discards the job and memory is unchanged. |

The results table has these columns: scenario, PLAN ref, PASS/FAIL, checks passed, steps handed out, tokens
handed out (the engine's budget counter, `ceil(chars/4)` of the step inputs), rejections and details.

Scripted runs can't measure whether a *model* writes good memory. They only check that the server enforces what it
promises when a model gets things right, wrong, or adversarially wrong.

---

## 2. Live protocol (manual)

These runs use real hosts with real models. Results depend on the thread's model, so always record host,
model and version. Keep the corpora synthetic or scrubbed. Never publish real transcripts.

### 2.1 Setup (all live runs)

1. Install agent-dream in the host (see `docs/hosts/<host>.md`), pointing at a **scratch copy** of the test project.
2. Delete `<project>/.dream/` between conditions unless a condition says otherwise.
3. Record the host version, the model, the agent-dream version (`npx -y agent-dream-mcp --version`) and the date.
4. Tokens: use the host's own usage display if it has one. Also record the `budget.usedTokens` the server reports
   at `ready_to_commit`.

### 2.2 Wiki vs search vs both (PLAN §9 #3)

**Corpus:** 4–6 sessions on one project over several "days", built so that the answers to the questions need facts
from **two or more** sessions (for example "which env var does the queue read, and which migration created the
table it writes to?"). Write 20 questions with exact expected answers: 10 cross-session and 10 single-session.

**Conditions**, each in a fresh session after the corpus sessions:

| Condition | Memory available to the model |
|---|---|
| A — search | dream disabled. The model may only use `memory_search` with `include_transcripts: true` (or the host's own transcript search). |
| B — wiki | after one `/dream`: `memory_index` + `memory_read` only (tell the model not to use search). |
| C — both | after one `/dream`: all memory tools. |

**Score:** exact-match accuracy per question type. Pass condition: C ≥ A on cross-session questions.

| Host | Model | Condition | Cross-session (n/10) | Single-session (n/10) | Tokens | Notes |
|---|---|---|---|---|---|---|
| _not run yet_ | | A — search | | | | |
| | | B — wiki | | | | |
| | | C — both | | | | |

### 2.3 `/compact` vs `/dream` on the same long task (PLAN §9 #5)

**Task:** a multi-step change in the test project, long enough to need a context reset partway through (for example
adding a feature across 5+ files with tests). Plant 3 traps the agent is likely to hit and be corrected on (a
wrong port, a test command that needs a flag, a file that must not be edited).

1. Run the first half of the task in a new session, including the 3 corrections.
2. **Condition compact:** run the host's `/compact` (or its equivalent), then continue the task.
3. **Condition dream:** from the same starting point (re-run the first half or restore a snapshot), run `/dream` and
   then start a **new** session that begins with `memory_index` (or the `resume` prompt). Continue the task.
4. Score both conditions on the same checklist.

| Host | Model | Condition | Task success (tests pass) | Repeated mistakes (of 3 traps) | User corrections needed | Tokens (2nd half) | Wall time |
|---|---|---|---|---|---|---|---|
| _not run yet_ | | compact | | | | | |
| | | dream | | | | | |

Pass condition: dream has higher task success **or** fewer repeated mistakes, with tokens reported either way.

### 2.4 Cross-host conformance (PLAN §9 #8)

Run this checklist once per host and model. Mark ✓, ✗ or "n/a (host has no such feature)", and add a note.

| # | Check | How |
|---|---|---|
| 1 | Tool listing | All 11 tools are visible (`memory_index`, `memory_search`, `memory_read`, `memory_note`, `memory_status`, `dream_sessions`, `dream_begin`, `dream_step`, `dream_commit`, `dream_review`, `dream_rollback`) |
| 2 | Prompt as slash command | `dream` (and `resume`) show up as slash commands or in a prompt picker |
| 3 | Server instructions visible | Ask the model "what does the agent-dream server tell you to do at the start of a task?" without calling a tool |
| 4 | Resources | `memory://index` is listed and readable, if the host supports resources |
| 5 | Full dream completes | `/dream` (or "please dream") runs begin → steps → commit without user help. Record the number of steps and any rejections the model recovered from |
| 6 | Large step results | No truncation of step inputs (the largest is about `chunkTokens` × 4 chars) |
| 7 | Resume | Interrupt mid-dream (cancel the turn, or `/compact`), then say "continue the dream". The model calls `dream_begin({resume})`, or `memory_status` then resume, and finishes |
| 8 | Memory used next session | In a fresh session the model reads `memory_index` (via instructions, AGENTS.md or the `resume` prompt) before acting |
| 9 | Session detection | `dream_begin` picks this host's current session (`dream_sessions` lists it first) |

| Host | Version | Model | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| opencode | _not run yet_ | | | | | | | | | | | |
| Codex CLI | _not run yet_ | | | | | | | | | | | |
| Claude Code | _not run yet_ | | | | | | | | | | | |
| VS Code / Copilot | _not run yet_ | | | | | | | | | | | |

### 2.5 Live variants of the scripted scenarios (optional)

Live models can also run #1, #2, #6 and #7 using the same stories as fixtures. Replay them as real sessions in a
host and let the host's model dream. The scripted assertions still apply. Also record the **false-correction rate**
(corrections the model proposed that the server rejected, or that a human judges wrong), over at least 5 runs.

| Scenario | Host | Model | Runs | Pass | False corrections proposed / rejected | Notes |
|---|---|---|---|---|---|---|
| planted-error | _not run yet_ | | | | | |
| poisoning | _not run yet_ | | | | | |

### Known limits of the server-side guard

The quote check proves that the evidence *exists* in the cited messages. It can't tell whether the model should
have believed it. For example, the port story contains a tool result with a planted instruction that says "the port
is 8080". A model that follows that instruction and quotes it word for word would pass the check. Defending against
that depends on the untrusted-transcript framing and the model, and only live runs can measure it.
