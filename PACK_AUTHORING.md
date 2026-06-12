# Pack Authoring

A **pack** is a small harness: everything Vegito needs to act like a specialist in one
domain — a persona, a team of agents, grading rubrics with real validators, memory seeds,
and onboarding — bundled behind a single manifest. This guide is for writing or editing one
by hand. To generate one, use `vegito forge` (covered at the end).

## The fastest path: forge, then edit

You rarely start from a blank directory. Generate a working pack and edit it:

```sh
vegito forge --offline --archetype tutor-team \
  --domain "organic chemistry tutoring" --name ochem --out packs/ochem
vegito packs validate packs/ochem
```

Forge produces a complete, valid pack: `pack.json`, `persona.md`, an `agents/` team,
`rubrics/` (each a `.prompt.md` + a `.validator.mjs`), `onboarding.md`, and
`memory/seeds.md`. Edit the prompts and validators to taste, then re-validate.

### Archetypes

`--archetype` chooses the team shape:

| Archetype | Shape | Rubric |
| --- | --- | --- |
| `tutor-team` | examiner + coach (smart tier), drill-master (fast tier) | `band-score` |
| `review-team` | reviewer + auditor (smart tier), synthesizer (fast tier) | `severity-tagged` |
| `content-studio` | a content-production team | its production rubric |

`tutor-team` is the default. Run `vegito forge` with an unknown `--archetype` to see the
current list printed in the error.

## The manifest: `pack.json`

`pack.json` is the security boundary and the table of contents. It is JSON with
**`schema: 1`** — there is no other schema and no migration path, so an unknown schema is a
hard reject, not a best-effort parse.

```json
{
  "schema": 1,
  "name": "ochem",
  "version": "0.1.0",
  "description": "Organic chemistry tutoring team.",
  "persona": "./persona.md",
  "onboarding": "./onboarding.md",
  "grants": ["read", "write", "memory"],
  "modelTiers": { "smart": "best-available", "fast": "fast-cheap" },
  "agents": [
    {
      "name": "examiner",
      "model": "tier:smart",
      "tools": ["read", "grep"],
      "prompt": "./agents/examiner.md"
    }
  ],
  "rubrics": [
    {
      "name": "mechanism-check",
      "prompt": "./rubrics/mechanism-check.prompt.md",
      "validator": "./rubrics/mechanism-check.validator.mjs"
    }
  ],
  "memory": { "seeds": "./memory/seeds.md" }
}
```

### Fields

| Field | Required | Notes |
| --- | --- | --- |
| `schema` | yes | Must be the integer `1`. |
| `name` | yes | Pack id. Non-empty. |
| `version` | yes | Semver-ish string. `evolve` bumps it. Non-empty. |
| `description` | no | Defaults to `""`. |
| `persona` | no | Path to the system persona prepended to every agent. |
| `skills`, `commands`, `hooks` | no | Paths to directories of skills / slash-commands / lifecycle hooks. |
| `onboarding` | no | Path to a doc shown when the pack is first used. |
| `grants` | yes | Tool ids the pack may use. **Empty by default** — a pack gets no tools until named here, and even then they run under the normal permission gate. |
| `modelTiers` | yes | Tier name → resolution hint (e.g. `"best-available"`). **No vendor or model names** — that is what keeps packs portable. |
| `agents` | yes | The team (see below). May be empty. |
| `rubrics` | yes | The graders (see below). May be empty. |
| `memory` | no | `{ seeds?, promotion? }` — paths to seed notes and a promotion policy. |

### Agents

Each agent is `{ name, model, tools, prompt }`:

- **`name`** — unique within the pack (duplicates are a validation error).
- **`model`** — a **tier reference** like `"tier:smart"`, not a model id. The tier must be
  declared in `modelTiers`; the runtime maps tiers to the user's actual model chain. This
  indirection is why a pack written for one model family runs unchanged on another.
- **`tools`** — tool ids this agent may call (a subset of what makes sense; still gated).
- **`prompt`** — a `./`-relative path to the agent's instructions.

### Rubrics: the soft + hard pair

A rubric is `{ name, prompt, validator }`, and **both** the prompt and the validator are
required. This pairing is the whole point of a rubric:

- **`prompt`** (soft check) — a markdown file the model grades a candidate against.
- **`validator`** (hard check) — an executable (e.g. `.validator.mjs`) that the runtime
  spawns as `node <validator> "<candidate>"`. Exit `0` means pass, non-zero means fail. A
  validator turns a fuzzy "looks right" into a deterministic gate.

A rubric missing either half is reported as a validation problem — half a check is not a
check.

A minimal validator:

```js
// rubrics/band-score.validator.mjs
const candidate = process.argv[2] ?? '';
const m = candidate.match(/band\s*[:=]?\s*([0-9](?:\.5)?)/i);
if (!m) process.exit(1);
const score = Number(m[1]);
process.exit(score >= 0 && score <= 9 ? 0 : 1);
```

### Memory

`memory.seeds` points to starter notes the pack ships with; `memory.promotion` points to a
policy describing which session-level memories get promoted into the durable pack. `evolve`
uses these when it folds lessons from real sessions back into the pack.

## The two rules every path must obey

1. **`./`-relative, no `..`.** Every path a manifest declares (`persona`, `agents[].prompt`,
   `rubrics[].*`, `memory.seeds`, the directory keys, `onboarding`) must start with `./` and
   contain no `..` segment, and must resolve inside the pack root. A pack may describe its
   own files and nothing else — this is what makes installing an untrusted pack safe.
2. **No vendor names anywhere.** Models are referenced only through tiers. This keeps packs
   portable across providers and over time.

## The constraint budget

A prompt-bearing file (the persona and each agent prompt) may carry at most **five negative
constraints** — lines that lead with `don't`, `do not`, `never`, `avoid`, or `no `. Past
that, the model reliably loses the prohibitions in the noise, so validation flags it. Write
prompts as positive instructions; reserve prohibitions for the few that truly matter.

## Validating

```sh
vegito packs validate <dir>
```

`validate` runs, in order: JSON parse + `schema:1`, path safety, manifest semantics
(unique agent names, tier references resolve, every rubric has both halves), file existence
for every declared file, and the constraint budget on prompts. It returns **all** problems
at once, so fix the list and re-run. A clean pack reports valid.

## Evolving a pack from use

Once a pack has run real sessions, fold what you learned back in:

```sh
vegito evolve <dir> --session <session-id>
vegito evolve revert <dir>      # undo the last batch, byte-for-byte
```

`evolve` reads a finished session, proposes concrete improvements (a sharper rubric, a
missing skill, a memory worth promoting), applies the ones the permission gate allows,
bumps the version, and records provenance. `revert` restores the pack exactly. Evolution is
not privileged — it writes through the same gate as everything else.
