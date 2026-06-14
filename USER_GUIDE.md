# User Guide

Vegito is driven by one command-line tool, `vegito`. This guide covers every command, the
permission model you operate under, and how to configure the system.

## Requirements

- **Node ≥ 22.18** (24 LTS recommended). There is nothing else to install — Vegito has no
  runtime dependencies, and `bin/vegito.js` can run the TypeScript source directly when
  `dist/` has not been built.

For a step-by-step local setup and first pack/evolution walkthrough, see
[GETTING_STARTED.md](./GETTING_STARTED.md).

## Commands

Run `vegito help` for the synopsis, `vegito version` for the version.

### `run` — one-shot, headless

```sh
vegito run -p "<prompt>" [--json] [--model <id>] [--mode <mode>] [--cwd <dir>] [--script <file>]
```

Runs a single turn to completion, prints the result, and exits with a status code that
reflects how the turn ended (`0` for a clean finish, non-zero for an error-class reason).
Use `--json` to emit one JSON object per line (the `LoopEvent` stream) instead of rendered
text — convenient for piping into other tools. `--script <file>` replaces the live
provider with the offline scripted wire (see *Offline & scripted runs* below).

```sh
vegito run -p "list the largest files in src and explain the biggest one"
vegito run --json -p "summarize the test suite" | jq 'select(.t == "text_delta")'
```

### `repl` — interactive

```sh
vegito repl [--model <id>] [--mode <mode>] [--cwd <dir>]
```

Starts an interactive session. The same `LoopEvent` stream that `run --json` serializes is
rendered as text here.

### `sessions` — history

```sh
vegito sessions list
vegito sessions resume <session-id>
vegito sessions fork <session-id> <record-id>
```

Sessions are append-only JSONL transcripts under `~/.vegito/sessions`. `list` shows what
you have; `resume` continues a session; `fork` branches from a specific record into a new
session so you can explore an alternative path without disturbing the original.

### `packs` — inspect domain packs

```sh
vegito packs list
vegito packs validate <dir>
vegito packs trust <pack>
```

`validate` runs the full manifest + filesystem check on a pack directory and reports every
problem (or confirms it is valid). Run it after editing a pack by hand. See
[PACK_AUTHORING.md](./PACK_AUTHORING.md). `trust` records explicit trust for a pack that
needs executable hooks; untrusted packs can still contribute persona, skills, commands,
and non-executable hooks.

### `forge` — generate a domain pack (the meta-harness)

```sh
vegito forge [--offline] [--archetype <id>] [--domain "<text>"] [--name <id>] \
             [--from <docs>] [--out <dir>]
```

Generates a complete pack — a team of role-specialized agents, grading rubrics with hard
validators, memory seeds, and onboarding — for a domain.

- `--offline` makes forging fully deterministic and provider-free. Requires `--domain`.
- `--archetype` selects the team shape: `tutor-team`, `review-team`, or `content-studio`.
  Defaults to `tutor-team`.
- `--domain` is the field the pack serves, e.g. `"IELTS writing and speaking"`.
- `--name` overrides the pack id (otherwise derived from the domain).
- `--from <docs>` infers the archetype and domain from a documents file instead of flags.
- `--out` is the output directory (otherwise `./<pack-name>`).

Without `--offline`, Vegito additionally makes one bounded model call to refine the
persona. That step is never required and never fatal — if no provider is available the
template persona is kept and a note is printed.

```sh
vegito forge --offline --archetype tutor-team \
  --domain "IELTS writing and speaking" --name ielts --out packs/ielts
```

### `evolve` — improve a pack from real use

```sh
vegito evolve <pack-dir> --session <session-id> [--mode <mode>] [--script <file>] [--apply]
vegito evolve eval <pack-dir>
vegito evolve revert <pack-dir>
```

`evolve <pack> --session <sid>` reviews a finished session, derives observations (friction,
rubric drift, a missing skill, a memory worth promoting), and turns them into concrete
proposals. By default this is review-only and does not modify the pack. Pass `--apply`
to apply the proposals the permission gate allows — bumping the pack version and writing
provenance and EvolutionRun records. `evolve eval <pack>` runs the non-mutating evaluation
entry point. `evolve revert <pack>` undoes the last applied batch, restoring the pack to
its prior bytes exactly.

```sh
vegito evolve packs/ielts --session 0c1f…
vegito evolve packs/ielts --session 0c1f… --mode acceptEdits --apply
vegito evolve revert packs/ielts
```

Evolution writes through the same permission gate as everything else; it is not a
privileged path. A proposal the gate denies is simply not applied.

## Permission modes

Every filesystem, command, and network action passes through one gate. The `--mode` flag
(or the `permissionMode` config key) sets its default posture:

| Mode | What happens |
| --- | --- |
| `default` | Reads are allowed. Writes, command execution, and network access **ask** for confirmation unless a rule allows them. |
| `acceptEdits` | Writes inside the workspace are auto-allowed. Writes that resolve *outside* the workspace still ask. Other actions follow `default`. |
| `plan` | Read-only. Any non-read action is denied. Use this to let the agent investigate without changing anything. |
| `bypass` | Configured rules are skipped. **The floor still applies** — catastrophic commands and credential exfiltration are denied regardless. |

The **floor** is a hardcoded, auditable list of catastrophes (e.g. recursive root deletion,
fork bombs, reading system credential files). No mode and no rule can override it. Anything
the command parser cannot understand fails closed to `ask`.

## Configuration

Configuration is layered, lowest to highest precedence:

1. **Built-in defaults**
2. `~/.vegito/config.json` (per-user)
3. `./.vegito/config.json` (per-project)
4. **CLI flags**

Each layer can only override known keys; unknown keys are warned about and dropped, never
silently carried.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | `deepseek-v4-pro` | Model id from the catalog. |
| `reasoningEffort` | `off` \| `low` \| `medium` \| `high` \| `max` | `max` | Thinking/reasoning effort sent with each model request. |
| `maxIterations` | integer | `50` | Maximum model calls per turn. |
| `permissionMode` | `default` \| `acceptEdits` \| `plan` \| `bypass` | `default` | Gate posture. |
| `trace` | boolean | `false` | Write a per-session trace log. |
| `catalogFiles` | string[] | `["catalog/models.json", "~/.vegito/models.json", "./.vegito/models.json"]` | Model catalog overlays. |
| `packRoots` | string[] | `["./packs", "~/.vegito/packs"]` | Pack discovery roots. |
| `trustedPacks` | string[] | `[]` | Packs trusted to run executable hooks. |
| `providerChains` | object | `{}` | Optional failover chains by tier/name. |
| `permissionRules` | object[] | `[]` | Additional permission rules. |
| `compaction` | object | `{ "maxTokens": 160000, "protectedTail": 8 }` | Context compaction limits. |
| `evolve.defaultApply` | boolean | `false` | Whether evolve applies by default. Keep false unless you want automatic pack mutation. |

Example `./.vegito/config.json`:

```json
{
  "model": "deepseek-v4-pro",
  "reasoningEffort": "max",
  "permissionMode": "acceptEdits",
  "maxIterations": 30
}
```

## State on disk

Vegito keeps its state under a per-user home directory, never in ambient environment
variables:

- `~/.vegito/sessions/` — JSONL session transcripts (`sessions list/resume/fork`).
- `~/.vegito/memory/` — durable cross-session memory notes (the `memory` builtin tool).
- `~/.vegito/config.json` and `./.vegito/config.json` — configuration layers.

## Offline & scripted runs

The `--script <file>` flag on `run` and `evolve` swaps the live provider for the scripted
wire, which plays back a recorded sequence of responses. This is how the test suite, the
offline forge path, and the offline evolve path all run with no network. The file is a
JSON-serialized list of steps; see the tests under `test/` for the exact shape.

## Exit codes

`run` (and the headless path generally) maps the turn's terminal reason to a process exit
code: a clean finish or a turn awaiting input exits `0`; an interruption exits `130` (the
SIGINT convention); error-class reasons (`max_iterations`, `budget_tokens`,
`denial_breaker`, `fatal_error`) exit with distinct non-zero codes. This makes Vegito
scriptable in pipelines and CI.
