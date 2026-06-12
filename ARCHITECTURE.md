# Architecture

Vegito is one agent harness with three faces — a general agent, a meta-harness that
forges domain packs, and an evolution loop that improves those packs through use. This
document describes how the pieces fit, the invariants that hold across all of them, and
the capabilities that are genuinely new ("further beyond" the harnesses it was distilled
from).

## The constitution

A small set of rules holds everywhere. They are enforced mechanically by
`scripts/constitution.mjs` (run as `npm run lint:constitution`), so they cannot quietly
erode:

- **Zero runtime dependencies.** `dependencies: {}`. Only `node:*` built-ins and relative
  imports are allowed in `src/`. The supply chain is the Node standard library.
- **No build step in development.** Node ≥ 22.18 strips types natively; source and tests
  run as `.ts`. `tsconfig` sets `erasableSyntaxOnly` — no enums, no namespaces, no
  constructor parameter properties. String-literal unions are used throughout instead.
- **`exactOptionalPropertyTypes`.** An optional property is *absent*, never `undefined`.
  Code includes optional keys with a conditional spread rather than passing `undefined`.
- **File size cap.** No source file exceeds 800 lines; the design favors many small,
  high-cohesion files.
- **Environment access is confined.** `process.env` may only be read in `src/config/` and
  `src/providers/credentials.ts`. The rest of the system receives typed config, never the
  ambient environment.
- **No hardcoded model or vendor tables.** Model identifiers live in catalog *data*
  (`catalog/`), not in code. The type system is vendor-neutral.
- **Pack manifests are `schema: 1`.** A single, validated schema version.

The payoff is a system you can hold in your head: one way to do each thing, and a linter
that fails the build when a shortcut is taken.

## The layers

```
┌─────────────────────────── UI clients (fold over events) ───────────────────────────┐
│  repl (native text)   │   headless (JSONL stream)   │   tests (scripted)            │
└──────────▲───────────────────────▲──────────────────────────▲───────────────────────┘
           │ LoopEvent stream (typed, serializable)            │ commands (queue)
┌──────────┴───────────────────────┴──────────────────────────┴───────────────────────┐
│ KERNEL  loop.ts (async generator) → reducer.ts (pure) → effects at edges             │
│         recovery registry · error algebra · exit reasons                             │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ context/        tools/           permissions/      agents/          sessions/        │
│ 3-tier prompt   registry+gate    single gate       child sessions   JSONL log        │
│ diff·compact    budgets·builtin  rules·shell·ask   board·messaging   memory          │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ providers/  vendor-neutral types · WireProtocol (anthropic|openai|scripted)          │
│             ProviderProfile · catalog (data) · failover chains · credential pool     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ extend/  one registry: packs · skills · commands · hooks · MCP                       │
│ forge/   pack generator        evolve/  observation → proposal → gated mutation      │
│ trace/   local JSONL, no-op by default        config/  typed layers, no env bridge   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Kernel — the loop and the reducer

The turn engine is split in two so the hard logic is pure.

- `kernel/reducer.ts` is a **pure function** `(state, event) → state`. It imports no
  `node:*` modules at all — it cannot perform an effect. Every state transition (a user
  message, a streamed text delta, a tool call appearing, tool results arriving) is a
  reduction over a typed event. Because it is pure, the entire conversation state machine
  is exhaustively unit-testable with plain data.
- `kernel/loop.ts` is an **async generator** that drives a turn: it assembles a request,
  calls the model, folds streamed `ProviderEvent`s through the reducer, executes any tool
  calls the model requested, and loops until the model stops or a bound is hit. It
  `yield`s `LoopEvent`s — the same typed, serializable stream that the REPL renders, the
  headless runner serializes to JSONL, and tests assert against.

Effects live only at the edges (the model call, tool execution). A turn ends with a typed
`ExitReason` — `end_turn`, `awaiting_input`, `max_iterations`, `budget_tokens`,
`denial_breaker`, `interrupted`, or `fatal_error` — which the UI maps to a process exit
code.

**Recovery** is a registry of strategies tried in order when a model call throws: honor a
server's `Retry-After`, then (last resort) compact the context and retry once on an
overflow error. If no strategy proposes a retry, the turn surfaces `fatal_error` rather
than throwing. Two consecutive recovery ceilings or repeated permission denials trip
circuit breakers so the loop can never spin.

### Context — the three-tier prompt

The system prompt is assembled from tiers with different cache lifetimes: a stable
identity/constitution tier, a slower-moving environment/pack tier, and the live message
history. Containment of cost is a *tested property*: golden byte-hash tests over
multi-turn sequences mean a change that would silently bust the provider's prompt cache
fails the build. When history grows past budget, compaction summarizes older turns while
preserving the head and the most recent exchanges.

### Tools and permissions — one gate

Every tool is described by a `ToolSpec` whose `permission(input)` returns a `PermKey`:
`{ tool, action: 'read' | 'write' | 'execute' | 'network', target? }`. Before a tool runs,
that key passes through **one engine** (`permissions/engine.ts`). The decision order is
fixed and auditable:

1. **Floor** — a short, hardcoded list of catastrophes (root deletion, fork bombs,
   credential exfiltration, reading system credential files). A floor hit denies *even in
   bypass mode*. Command floors run on the raw string before tokenization, so obfuscation
   that defeats the tokenizer still trips either the floor or the tokenizer's own
   fail-closed `ask`.
2. **Bash** — a parsed command is checked stage by stage; the worst stage wins, and an
   unparseable command fails closed to `ask`.
3. **Rules** — user/pack-configurable allow/ask/deny patterns; most restrictive wins.
4. **Mode default** — what the active permission mode does when nothing else matched.

Workspace containment is computed by resolving a path the way the kernel will actually
traverse it (canonicalizing each existing prefix segment before applying `..`, so a
symlink cannot smuggle a path outside), then comparing with `path.relative` — never a
string prefix, so `/work` and `/work2` are correctly distinct.

The builtin tools are `read`, `write`, `edit`, `ls`, `glob`, `grep`, `bash`, `fetch`,
`todo`, `memory`, `skill`, and `agent` (spawn a sub-agent). Each declares its own
permission key; none can reach the filesystem or network except through the gate.

### Providers — vendor-neutral by construction

Internal types (`NeutralRequest`, `NeutralMsg`, `Block`, `ProviderEvent`) name nothing
vendor-specific. A `WireProtocol` adapts them to a concrete API; the repo ships
`anthropic`, `openai`-compatible, and `scripted` wires. Because the core only ever sees
neutral types, an ordered **failover chain** of `(provider, model)` pairs can switch
mid-conversation when one provider errors, and a three-state **credential pool** can
rotate keys — neither requires the conversation to know which vendor is answering. Model
metadata is catalog data, not code.

The **scripted wire** plays back a list of responses, errors, and stalls. Every
integration test — and the entire offline forge and evolve paths — drives the *real* loop
through it. No network, and no mocks of Vegito's own code.

### Sessions — an append-only log

A session is a JSONL transcript: messages are appended, never mutated. `resume` replays a
session; `fork` branches from any record into a new session, so you can explore an
alternative without losing the original. `resolve` materializes a session's neutral
message history for replay into a new request. Memory is layered (episodic → curated →
synthesis) with an explicit promotion policy.

### Extensibility — one registry

Packs, skills, slash-commands, hooks, and MCP servers all install into a single
`ExtensionRegistry`. There is no parallel plugin system. A **hook** is a user executable
wired to a lifecycle event by an exit-code contract (`0` = ok and inject stdout as
context; `2` = block and return stderr to the model; anything else = warn). Hooks are
augmentation *over* the permission gate, never a replacement: a crashed, slow, or missing
hook degrades to a non-blocking warning rather than wedging the loop, and a hook can never
grant an action the gate would deny.

### Multi-agent — one primitive

A sub-agent is just another session with its own context, spawned via the `agent` tool.
Coordination is a shared **task board** plus inter-agent **messaging** — one orchestration
primitive, not a separate framework bolted onto the single-agent path.

## The Forge (meta-harness)

`vegito forge` turns a domain description into a complete pack. The flow converges on one
intermediate form:

```
flags / interview / --from <docs>   →   ForgePlan   →   ForgeSpec   →   FileMap   →   disk
                                       (archetype +     (resolved,      (path →
                                        params)         prompts inline)  content)
```

- A **`ForgeSpec`** is the resolved description of a pack *before* it becomes files:
  prompts are inline text, tiers are abstract names, validators are source bodies. It is
  pure — no IO, no provider — which is what makes both the archetype templates and the
  generator unit-testable.
- An **archetype** is a pure function `(params) → ForgeSpec`. The repo ships
  `tutor-team`, `review-team`, and `content-studio`.
- `generate.ts` turns any `ForgeSpec` into a `FileMap` (`./pack.json`, `./persona.md`,
  `./agents/<slug>.md`, `./rubrics/<slug>.prompt.md` + `.validator.mjs`, `./onboarding.md`,
  `./memory/seeds.md`) whose `pack.json` references every file by `./`-relative path —
  exactly the shape the pack loader and validator expect.

The offline path (`--offline`, or any path through the scripted wire) is fully
deterministic and provider-free. An optional online step makes one bounded model call to
*enrich* a persona; it is never required and never fatal. The two shipped exemplar packs
(`packs/ielts`, `packs/code-review`) are the Forge's own output, and a test re-forges them
and asserts the result is byte-identical to what is committed — the packs can never
silently drift from the generator that is supposed to produce them.

### Prompt hygiene: the constraint budget

A forged (or evolved) prompt may carry at most a small number of *negative* constraints
("don't…", "never…", "avoid…"). Past that budget, additional negatives are dropped while
positive guidance is always admitted. This encodes a small-harness lesson: a wall of
prohibitions degrades a model more than it constrains it.

## The evolution loop

No studied harness closes the loop from observed friction back to a durable improvement.
Vegito's `evolve` pipeline is three pure-cored stages plus one gated effect:

```
observe(session)          →  raw observations  (a reviewer reads the transcript)
propose(observations)     →  proposals         (pure routing: friction → persona edit,
                                                 rubric drift → rubric edit, missing skill
                                                 → onboarding edit, memory candidate →
                                                 promotion)
applyProposals(proposals) →  gated mutation     (snapshot → mutate → validate → on failure
                                                 roll back; on success bump version + write
                                                 a provenance record)
revert()                  →  byte-identical undo of the last applied batch
```

The crucial property: **evolution is not a backdoor.** Every file an evolution would write
passes through the *same* permission engine as any other write (via an `evolve`-tooled
`PermKey`). A proposal the gate denies is simply not applied. Each applied batch records a
`ProvenanceRecord` — the proposals, the observations and session ids that motivated them,
the version bump, and a byte-snapshot of every touched file — so `evolve revert` restores
the pack to its prior bytes exactly, and you can always trace *why* a pack changed.

## What is "further beyond"

The capabilities below are the ones no harness in the studied corpus has. They are the
reason Vegito is a fusion *and* a transcendence, not just a re-implementation:

1. **The Forge.** Hosting extensions is common; *generating* a complete, validated,
   role-structured pack from a domain description is not.
2. **The evolution engine.** Observations → proposals → permission gate → versioned,
   revertible mutations with provenance. The loop is closed.
3. **Single-path constitution.** One loop, one state model, one orchestration primitive,
   one registry, one gate — and a linter that keeps it that way.
4. **Cache stability as a tested property.** Golden byte-hash tests over multi-turn
   sequences; a busted prompt cache is a failing build.
5. **Provider failover with credential pooling.** Ordered `(provider, model)` chains and
   three-state credentials, surviving mid-conversation because internal types are
   vendor-neutral.
6. **Zero-dependency core.** A smaller supply chain than any studied harness. Every
   adapter is an optional, fail-soft seam.
7. **Honest safety.** Every mechanism ships to every user; no wall is claimed that isn't
   load-bearing; everything unparseable fails closed.

See [USER_GUIDE.md](./USER_GUIDE.md) to drive the system and [PACK_AUTHORING.md](./PACK_AUTHORING.md)
to build on it.
