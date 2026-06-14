# Vegito

**The fusion agent harness.** Vegito is a zero-runtime-dependency TypeScript agent
harness with three faces:

1. **A general agent** — coding and general work driven from a terminal REPL or a
   headless one-shot command, on par with the harnesses it was distilled from.
2. **A meta-harness** — `vegito forge` generates a complete *domain pack* (a team of
   role-specialized agents, skills, grading rubrics, memory seeds, and onboarding) for
   any field, as data over the same interfaces the core uses.
3. **An evolving system** — `vegito evolve` reviews real sessions, proposes versioned
   improvements to a pack and its memory, and applies them through the same permission
   gate that governs every other write. Nothing about a pack is frozen; it improves
   through use, and every change is revertible with provenance.

Vegito is named for the fusion: it is meant to be the synthesis of the agent harnesses
studied to build it (Claude Code, Codex, Hermes, opencode) *and* something further
beyond — capabilities none of them has. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
design and the "transcendence ledger" of what is new.

## Why it is different

- **One of everything.** One loop, one state model, one orchestration primitive for
  sub-agents, one extension registry, one permission gate. The structural advantage is
  *absence*: no dual systems, no migration debt, no flag forests.
- **Zero runtime dependencies.** `dependencies: {}`, forever. The whole product runs on
  the Node standard library. Every external adapter is an optional, fail-soft seam.
- **No build step in development.** Node ≥ 22.18 strips TypeScript types natively, so the
  source and the tests run as `.ts` directly. The only `devDependencies` are `typescript`
  and `@types/node`.
- **Safety is honest.** Every mechanism ships to every user. The permission gate is the
  one real boundary; hooks and rules layer over it but can never weaken it. Anything
  unparseable fails closed.
- **The Forge.** Every studied harness can *host* extensions; none can *generate* them.
  Vegito interviews you (or ingests a domain description) and emits a complete, validated
  pack — offline, deterministically, in one sitting.
- **The evolution loop.** No studied harness closes the loop from observed friction back
  to a durable, gated, revertible improvement. Vegito does.

## Requirements

- **Node ≥ 22.18** (24 LTS recommended). No other runtime dependency.

## Quickstart

Default live runs use DeepSeek's official `deepseek-v4-pro` Anthropic-compatible
profile with `reasoningEffort: "max"`. Set `ANTHROPIC_AUTH_TOKEN` or
`ANTHROPIC_API_KEY` in your shell; never commit provider credentials.

```sh
# Start an interactive session.
vegito

# Run a one-shot task headlessly (prints the answer, exits with a status code).
vegito run -p "explain what this repo does"

# Forge a domain pack — here, an IELTS tutor team — fully offline and deterministic.
vegito forge --offline --archetype tutor-team --domain "IELTS writing and speaking" \
  --name ielts --out packs/ielts

# Check that a pack is well-formed.
vegito packs validate packs/ielts

# Review a finished session and let Vegito propose improvements to a pack
# without mutating anything.
vegito evolve packs/ielts --session <session-id>

# Apply accepted proposals through the permission gate.
vegito evolve packs/ielts --session <session-id> --mode acceptEdits --apply

# Undo the last batch of applied improvements.
vegito evolve revert packs/ielts
```

For a first local setup, see [GETTING_STARTED.md](./GETTING_STARTED.md). Full command
reference and configuration are in [USER_GUIDE.md](./USER_GUIDE.md). To build or
hand-write a pack, see [PACK_AUTHORING.md](./PACK_AUTHORING.md).

## Permission modes

Every action that touches the filesystem, runs a command, or reaches the network passes
through one gate. The mode sets the gate's default posture:

| Mode | Posture |
| --- | --- |
| `default` | Reads allowed; writes/execute/network **ask** unless a rule allows them. |
| `acceptEdits` | In-workspace writes auto-allowed; out-of-workspace writes still ask. |
| `plan` | Read-only: any non-read action is denied. |
| `bypass` | Rules are skipped — but the **floor** (catastrophic commands, credential exfiltration) still denies. |

No mode, and no rule, can override the floor.

## Project layout

```
src/
  kernel/        the loop (async generator) + pure reducer + recovery + exit reasons
  context/       three-tier system prompt, diffing, compaction
  tools/         tool registry, budgets, and the builtin tools
  permissions/   the single gate: rules, shell parsing, workspace containment, ask broker
  providers/     vendor-neutral types, wire protocols (anthropic/openai/scripted), catalog
  agents/        child sessions, the task board, inter-agent messaging
  sessions/      JSONL transcript store, resume/fork, memory
  extend/        one registry for packs, skills, commands, hooks, MCP
  forge/         the pack generator (archetype templates → spec → files)
  evolve/        observation → proposal → gated, revertible mutation
  trace/         local JSONL telemetry, no-op by default
  config/        typed, layered configuration
  ui/            REPL, headless runner, CLI arg parsing and dispatch
packs/           shipped exemplar packs (forged, not hand-written)
catalog/         model catalog data
test/            unit, integration, adversarial suites
```

## Testing

```sh
npm test                 # full suite, runs .ts directly, no build
npm run check            # typecheck + constitution lint + full suite
npm run coverage         # line/branch coverage
npm run test:adversarial # the hostile-input suite
```

## License

MIT.
