# Vegito — Delivery Report

Date: 2026-06-13 · Version: 0.1.0 · Repo: `vegito/` (24 commits, clean tree)

## Verdict

The goal gate was: *"the goal is considered complete if and only if Vegito is
delivered and thoroughly and comprehensively tested on all grounds."*

**Delivered.** All 44 task-board tasks are complete. Every checkbox in
`vegito-notes/ACCEPTANCE.md` (sections A–D) is satisfied with evidence below.
The final suite: **764 tests, 119 suites, 0 failures**; coverage **99.18%
lines / 92.08% branches / 96.41% functions**; zero runtime dependencies;
typecheck + constitution lint clean.

## What was delivered

Vegito is three products in one binary, per the mission definition:

1. **A Big Harness** — a general agentic CLI (REPL + headless) on par with the
   harnesses it studied: streaming agent loop, full tool belt, permission
   engine, context management with compaction, persistent sessions,
   skills/hooks/commands/memory, and multi-agent orchestration.
2. **A Meta-Harness (the Forge)** — `vegito forge` interviews a user (or
   ingests their docs) and synthesizes a complete domain pack: agents, skills,
   commands, rubrics, memory seeds, onboarding. Works fully offline
   (deterministic templates) or LLM-amplified. Two exemplar packs shipped,
   both produced by the Forge itself.
3. **An Evolution Engine** — `vegito evolve` mines session transcripts for
   friction (observe), drafts concrete pack patches (propose), optionally
   LLM-reviews them, and applies them only through a consent gate with version
   bump, provenance stamp, and one-command revert.

## Acceptance evidence

### A. Product completeness (the Big Harness)

| Criterion | Evidence |
|---|---|
| CLI: REPL + headless | `src/ui/` (repl, headless, runtime, render; `cli/args.ts` + `cli/dispatch.ts`); E2E `test/integration/cli-e2e.test.ts` runs the bin as a subprocess |
| Provider layer | `src/providers/` — Anthropic wire, OpenAI-compatible wire, deterministic ScriptedWire; catalog + profiles + alias resolution; retry, stream repair, failover chain, credential pool with health states; `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` honored for gateways/local endpoints |
| Agentic loop | `src/kernel/` — reducer-based turn engine, parallel tool calls, abort propagation, recovery ladder (`recovery.ts`), max-iteration + budget guards; `test/integration/loop-e2e.test.ts` |
| Core tools | `src/tools/builtin/` — read, write, edit, glob, grep, ls, walk, bash (timeout + output caps), todo, fetch, memory, skill, agent (subagent spawn) |
| Permissions | `src/permissions/` — frozen modes (plan/ask/auto/bypass), per-tool rules, allow/deny lists, session grants, shell command analysis that parses compound commands; a single decision gate every tool passes through |
| Context manager | `src/context/` — token accounting, 3-tier prompt assembly, threshold compaction with structured summary + tail preservation, file-state staleness tracking; byte-stability proven by `test/integration/golden-cache.test.ts` |
| Sessions | `src/sessions/` — append-only JSONL transcripts, resume, fork-by-pointer, replay-fold (state derivable from transcript alone), persistent memory dir |
| Harness primitives | `src/extend/` — SKILL.md skills with frontmatter + progressive disclosure, lifecycle hooks, slash commands, VEGITO.md project rules, packs, MCP client — all behind one extension registry |
| Multi-agent | `src/agents/` — spawn with role + tool restriction, file-based task board with atomic claim (1000-concurrent-claimer race test), messaging, detached fan-out; `test/integration/agents-e2e.test.ts` |

### B. The Meta-Harness (the Forge)

| Criterion | Evidence |
|---|---|
| `vegito forge` synthesizes complete packs | `src/forge/` — spec IR, interview elicitation, doc ingest (`--from`), pure generator; emits manifest, agents, skills, commands, rubrics, memory seeds, onboarding |
| Pack lifecycle | validate → install → list → run → evolve → export; deep semantic validation in `src/extend/pack-validate.ts`; `test/integration/pack-lifecycle.test.ts` |
| Offline + LLM-amplified generation | three archetype templates (tutor-team, review-team, content-studio) generate deterministically with `--offline`; `enrich.ts` amplifies personas when a provider is available |
| Evolution engine | `src/evolve/` — observe/propose/review/apply, consent-gated, version bump + provenance + revert; `test/integration/evolve-acceptance.test.ts` |
| ≥2 exemplar packs, Forge-produced | `packs/ielts` (tutor-team) and `packs/code-review` (review-team); `test/integration/exemplar-packs.test.ts` loads and exercises both |

### C. Testing (all grounds)

- **Unit**: 94 test files mirror every organ (`test/unit/` covers kernel, lib,
  providers, tools, permissions, context, sessions, extend, agents, forge,
  evolve, config, trace, ui).
- **Integration**: full agentic episodes against the scripted provider —
  multi-turn tool use, compaction mid-session, permission denials, subagent
  fan-out, forge→validate→install→answer, evolve acceptance, provider
  failover, golden-cache byte stability.
- **E2E**: the CLI binary run as a subprocess — headless `run`, piped REPL
  (two scripted turns, unknown slash command, EOF), Ctrl-C interrupt, exit
  codes.
- **Adversarial**: `test/adversarial/adversarial.test.ts` — malformed CLI
  args, provider errors, context overflow / runaway loops, hook failures,
  broken pack manifests, path traversal, permission escalation.
- **Coverage**: 99.18% lines / 92.08% branches / 96.41% functions (threshold
  was ≥80%).
- **Live smoke**: performed best-effort; full record below.

### D. Documentation & delivery

`README.md` (vision + quickstart), `ARCHITECTURE.md`, `USER_GUIDE.md`,
`PACK_AUTHORING.md` — all in repo. This file is the delivery report. All
task-board tasks (original 11, expanded to 44) are completed.

## The transcendence ledger

Per acceptance D: each organ, the harness(es) it fuses, and what is *further
beyond* any of them.

| Organ | Fuses | Further beyond |
|---|---|---|
| `kernel/` loop | Claude Code's single-threaded reducer turn; Codex's turn lifecycle + submission queue; opencode's event bus | The recovery ladder is *data* (a typed escalation table), not scattered catch blocks; every loop state is reachable offline via the scripted wire |
| `providers/` | opencode's multi-provider catalog; Codex's wire client; Claude Code's retry/failover discipline | One neutral message algebra both wires compile into; the deterministic ScriptedWire is a first-class provider, so the entire product tests offline; credential pool with 401-dead / 429-cooling health states |
| `tools/` | Claude Code's tool belt; Codex's sandbox caution; opencode's registry | A single execution pipeline — schema validate → permission gate → budget → hooks → execute — that no tool can bypass; safety floor holds even in bypass mode |
| `permissions/` | Claude Code's modes; Codex's approval policies; opencode's per-tool rules | One frozen decision gate; shell analysis parses compound commands (`a && b; c`) so `bash` can't smuggle a denied action past a prefix rule |
| `context/` | Claude Code's compaction + prompt assembly; Hermes' context discipline | Prefix-cache stability is a *tested invariant* (golden-cache byte-for-byte test), not a hope; file-state tracking invalidates stale reads |
| `sessions/` | Claude Code JSONL transcripts; Codex rollout files; Hermes session/distribution model | Fork-by-pointer (zero-copy branching) and replay-fold: state is always derivable from the transcript, so crashes can't corrupt a session |
| `extend/` | Claude Code skills/hooks/commands/CLAUDE.md; opencode plugins; MCP | One registry for every extension kind; the *pack* as the atomic unit of distribution, deep-validated semantically (duplicate agents, dangling prompts, rubric budgets) |
| `agents/` | Claude Code subagents + task tools | File-based board with atomic claim proven under a 1000-claimer race; child agent specs are byte-stable for caching |
| `ui/` | Claude Code REPL; Codex headless/JSON modes | `dispatch()` is a pure function over injected ports (stdout, home, cwd, signal, REPL input) — the whole CLI runs offline in unit tests |
| `forge/` | **No equivalent in any studied harness** | The meta-harness: interviews or ingests docs, then emits a validated, runnable domain pack; deterministic offline, amplified online |
| `evolve/` | **No equivalent in any studied harness** | Observed friction becomes consent-gated pack patches with provenance and revert — the harness improves itself without ever self-modifying silently |
| `lib/` + zero-dep stance | Codex's lean-core instinct | `dependencies: {}` permanently: JSONL, JSON-schema validation, ids, hashing, async utilities all in-tree; supply-chain surface is zero |

## Final security review

Three real defects were found by the final review process and fixed with TDD
(failing test first, then the fix; all are in the suite now):

1. **Credential-file write floor bypassed via tee** (`057ecd7`) — the
   non-bypassable safety floor on credential paths could be sidestepped in
   bypass mode through shell redirection; floor now enforced for `bash`
   writes in every mode.
2. **HookBus dead-wired** (`55a47d4`) — hooks were constructed but never
   threaded into the tool executor, so PreToolUse/PostToolUse guardrails were
   silently inert. Wired and covered end-to-end (a blocking hook now provably
   stops a write).
3. **Alias sent on the wire** (`c7d92e1`) — `--model haiku` put the alias,
   not the catalog id, in the request body; gateways 400 on it. Found by live
   smoke; `buildCallModel` now resolves to the canonical id everywhere.

Standing posture, verified: no secrets in the repo or history; env reads
confined to `src/config/` + `src/providers/credentials.ts` and enforced by the
constitution linter on every `npm run check`; credentials never logged;
adversarial tests cover path traversal and permission escalation; malformed
extension config (e.g. broken hooks.json) aborts loudly rather than silently
dropping guardrails.

## Live smoke record (best-effort, per acceptance C)

Environment: the sandbox routes `ANTHROPIC_BASE_URL` to a third-party reseller
gateway; direct `api.anthropic.com` returns 403 from here.

- Honoring the override required a product fix (`99ef5d4`); after it, the
  live path — catalog resolution, credential headers, streaming SSE parse,
  usage accounting, turn lifecycle, JSON event stream — ran **end-to-end
  against the real gateway** with `claude-fable-5`.
- The gateway injects a ~3.5k-token hidden prefix (constant `cacheRead=3568`
  on every call) and **stochastically refuses agent-shaped requests**
  (`stop_reason:"refusal"`, empty content, usage 2 in / 1 out). A raw `curl`
  with a byte-identical body reproduces the refusal exactly, and plain
  prompts pass — proving the block is gateway policy, not Vegito's wire.
- `claude-sonnet-4-6` and `claude-haiku-4-5` fail at connection level through
  this gateway ("fetch failed"); only `claude-fable-5` is served.
- Net: the live path is verified working; visible-text completions through
  this particular gateway are environment-limited. The smoke also paid for
  itself by surfacing defect #3 above.

## Honest limits

- The TUI is a line-oriented REPL, not a full-screen terminal UI; LSP and
  voice integration are researched (notes in `vegito-notes/explorations/`)
  but not built.
- LLM-amplified forge enrichment and evolve review are implemented and tested
  against the scripted wire; sustained live-model validation awaits a less
  restrictive endpoint.
- Provider auth currently reads `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`;
  `ANTHROPIC_AUTH_TOKEN` (Bearer) and per-profile custom endpoints (e.g.
  DeepSeek's Anthropic-compatible API) are the natural next increment on the
  already-shipped `baseUrlFromEnv` + catalog-override seams.
