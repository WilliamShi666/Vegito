# Vegito

**A meta-harness compiler for domain-specific AI agents.**

Vegito is an experimental TypeScript agent harness that can generate, run,
validate, and evolve specialized AI workflows for real domains.

Instead of shipping one fixed assistant, Vegito builds the assistant you need:

- a TOEFL / IELTS tutor harness
- a data science analysis team harness
- a US undergraduate admissions counselor harness
- a finance advisor harness
- a code review team harness
- any other domain-specific workflow harness

Generated harnesses are not just prompt files. A Vegito pack can include:

- role-specialized agents
- slash commands
- memory policy
- tool grants
- rubrics
- hard validators
- eval cases
- onboarding
- artifact requirements
- evolution hooks

The goal is simple:

> Turn a user need into a runnable, inspectable, improvable agent harness.

## Why Vegito Exists

Most agent tools give you a powerful general-purpose assistant.

Vegito asks a different question:

> What if the agent could design the right harness for the task before doing the task?

A TOEFL tutor, a data science team, and an admissions counselor should not share the
same prompt, tools, memory, evaluation criteria, or workflow.

Vegito treats the harness itself as the product.

It compiles a domain request into a structured pack that can be loaded and used
immediately:

```sh
vegito forge --native \
  --domain "US undergraduate admissions counselor" \
  --name admissions-counselor

vegito repl --pack generated/admissions-counselor
```

Then use domain-specific commands:

```text
/admissions-profile-review
/admissions-school-list
/admissions-essay-plan
```

## Vegito / Vegito 是什么

Vegito 是一个面向领域任务的 meta-harness 编译器，用来把“用户需求”变成
“可运行、可验证、可持续演化的 AI harness”。

它不是只给你一个通用助手，而是帮你构建适合具体领域的助手系统：

- 托福 / 雅思教练
- 数据科学分析团队
- 美国本科申请顾问
- 金融分析助手
- 代码审查团队
- 其他任何有明确工作流的领域

Vegito 生成的不是单一 prompt，而是一整套可执行的 pack：

- 角色化 agents
- slash commands
- memory policy
- tool grants
- rubrics
- validators
- eval cases
- onboarding
- artifact requirements
- evolution hooks

一句话概括：

> 把用户需求编译成一个可运行、可检查、可改进的 AI harness。

## What Makes Vegito Different

### 1. Meta-Harness First

Vegito's core identity is not self-evolution.

Self-evolution is a downstream mechanism.

The primary goal is to generate high-quality, domain-specific harnesses from user
intent.

```text
user need -> domain blueprint -> runnable harness -> validated workflow -> improvement loop
```

### 2. Runtime-Ready Harnesses

Generated harnesses are meant to work immediately.

A native-generated pack can include commands, roles, memory, validators, evals, and
tool permissions that Vegito can run directly:

```sh
vegito repl --pack generated/toefl-live
vegito run --pack generated/data-live -p "Analyze this churn dataset"
vegito packs validate generated/admissions-counselor
vegito packs validate-output generated/admissions-counselor output.md
```

### 3. Validation, Not Just Vibes

Vegito harnesses can include both soft and hard checks:

- rubric prompts
- required signals
- score gates
- artifact checks
- validator scripts
- eval cases

This makes generated harnesses inspectable and testable instead of opaque prompt blobs.

### 4. Memory as a Harness Primitive

Different harnesses need different memory.

A TOEFL tutor should remember score history and recurring weaknesses.

A data science harness should remember dataset assumptions, schema risks, causal
rejections, and artifact status.

An admissions counselor should remember applicant profile, target schools, deadlines,
essays, recommendation status, financial aid constraints, and next actions.

Vegito makes memory policy part of the generated harness.

### 5. Safe Evolution

Vegito can observe real sessions and propose improvements to a harness.

But evolution is gated:

- permission checks
- provenance
- rollback
- validators
- evals
- no uncontrolled source self-rewrite

The harness can improve, but not by silently mutating the core system.

## Current Examples

This repository includes generated harnesses such as:

### TOEFL Speaking Coach

```sh
vegito repl --pack generated/toefl-live
```

Commands:

```text
/toefl-diagnose
/toefl-drill
/toefl-review
/toefl-full-test
/toefl-explain-rubric
```

### Customer Churn Data Science Team

```sh
vegito repl --pack generated/data-live
```

Commands:

```text
/churn-run-pipeline
/churn-quality-gates
/churn-inspect-schema
/churn-eda
/churn-causal-review
```

### US Undergraduate Admissions Counselor

```sh
vegito repl --pack generated/admissions-counselor
```

Commands:

```text
/admissions-profile-review
/admissions-school-list
/admissions-essay-plan
```

## Quickstart

```sh
npm install
npm run install:local
vegito
```

For live DeepSeek calls:

```sh
export DEEPSEEK_API_KEY=<your_api_key>
```

For a headless task:

```sh
vegito run -p "explain what this repo does"
```

For an offline pack:

```sh
vegito forge --offline --archetype tutor-team --domain "IELTS writing and speaking" \
  --name ielts --out packs/ielts
```

For validation:

```sh
vegito packs validate packs/ielts
vegito evolve packs/ielts --session <session-id>
```

For a first local setup, see [GETTING_STARTED.md](./GETTING_STARTED.md). If you want a
Chinese, command-first walkthrough for users and other agents, start with
[USAGE.md](./USAGE.md). Full command reference and configuration are in
[USER_GUIDE.md](./USER_GUIDE.md). To build or hand-write a pack, see
[PACK_AUTHORING.md](./PACK_AUTHORING.md).

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

## Credential Safety

Use `.env.example` as the public template for local credentials. Real `.env`
files, local `.vegito/` configuration, generated build output, coverage output,
`node_modules/`, and the private `DeepSeek_Anthropic_Integration.md` note are
ignored by Git.

## License

MIT.
