# Vegito

## English

**Vegito turns a domain request into a runnable, validated, evolvable AI harness.**

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

### Why Vegito Exists

Most agent tools give you a powerful general-purpose assistant.

Vegito asks a different question:

> What if the agent could design the right harness for the task before doing the task?

A TOEFL tutor, a data science team, and an admissions counselor should not share the
same prompt, tools, memory, evaluation criteria, or workflow.

Vegito treats the harness itself as the product. It compiles a domain request into a
structured pack that can be loaded and used immediately:

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

### What Makes Vegito Different

**Meta-harness first.** Vegito's core identity is not self-evolution. Self-evolution is
a downstream mechanism. The primary goal is to generate high-quality, domain-specific
harnesses from user intent.

```text
user need -> domain blueprint -> runnable harness -> validated workflow -> improvement loop
```

**Runtime-ready harnesses.** A native-generated pack can include commands, roles,
memory, validators, evals, and tool permissions that Vegito can run directly:

```sh
vegito repl --pack generated/toefl-live
vegito run --pack generated/data-live -p "Analyze this churn dataset"
vegito packs validate generated/admissions-counselor
vegito packs validate-output generated/admissions-counselor output.md
```

**Validation, not just vibes.** Vegito harnesses can include rubric prompts, required
signals, score gates, artifact checks, validator scripts, and eval cases. This makes
generated harnesses inspectable and testable instead of opaque prompt blobs.

**Memory as a harness primitive.** Different harnesses need different memory. A TOEFL
tutor should remember score history and recurring weaknesses. A data science harness
should remember dataset assumptions, schema risks, causal rejections, and artifact
status. An admissions counselor should remember applicant profile, target schools,
deadlines, essays, recommendation status, financial aid constraints, and next actions.

**Safe evolution.** Vegito can observe real sessions and propose improvements to a
harness, but evolution is gated by permission checks, provenance, rollback, validators,
evals, and no uncontrolled source self-rewrite.

### Current Examples

This repository includes generated harnesses such as:

**TOEFL Speaking Coach**

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

**Customer Churn Data Science Team**

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

**US Undergraduate Admissions Counselor**

```sh
vegito repl --pack generated/admissions-counselor
```

Commands:

```text
/admissions-profile-review
/admissions-school-list
/admissions-essay-plan
```

### Quickstart

```sh
npm install
npm run install:local
vegito
```

For live DeepSeek calls:

```sh
export DEEPSEEK_API_KEY=<your_api_key>
```

Run a one-shot task:

```sh
vegito run -p "explain what this repo does"
```

Generate an offline pack:

```sh
vegito forge --offline --archetype tutor-team --domain "IELTS writing and speaking" \
  --name ielts --out packs/ielts
```

Validate and evolve a pack:

```sh
vegito packs validate packs/ielts
vegito evolve packs/ielts --session <session-id>
```

## 中文

**Vegito 会把一个领域需求编译成可运行、可验证、可持续演化的 AI harness。**

Vegito 是一个实验性的 TypeScript agent harness。它可以为真实领域生成、运行、
验证并演化专用 AI 工作流。

它不是只提供一个固定的通用助手，而是为你的具体需求构建合适的助手系统：

- TOEFL / IELTS 教练 harness
- 数据科学分析团队 harness
- 美国本科申请顾问 harness
- 金融顾问 harness
- 代码审查团队 harness
- 其他任何领域专用 workflow harness

Vegito 生成的 harness 不只是 prompt 文件。一个 Vegito pack 可以包含：

- 角色化 agents
- slash commands
- memory policy
- tool grants
- rubrics
- hard validators
- eval cases
- onboarding
- artifact requirements
- evolution hooks

目标很简单：

> 把用户需求变成一个可运行、可检查、可改进的 agent harness。

### Vegito 为什么存在

大多数 agent 工具都会给你一个强大的通用助手。

Vegito 问的是另一个问题：

> 如果 agent 在执行任务之前，能先为这个任务设计正确的 harness，会怎样？

TOEFL 教练、数据科学团队、申请顾问不应该共享同一套 prompt、工具、记忆、
评估标准和工作流。

Vegito 把 harness 本身当成产品。它会把领域需求编译成结构化 pack，并且这个
pack 可以立即加载和使用：

```sh
vegito forge --native \
  --domain "US undergraduate admissions counselor" \
  --name admissions-counselor

vegito repl --pack generated/admissions-counselor
```

然后使用领域专用命令：

```text
/admissions-profile-review
/admissions-school-list
/admissions-essay-plan
```

### Vegito 的不同之处

**Meta-harness first。** Vegito 的核心定位不是自进化。自进化只是下游机制。
它的主要目标是从用户意图生成高质量的领域专用 harness。

```text
用户需求 -> 领域蓝图 -> 可运行 harness -> 可验证 workflow -> 改进闭环
```

**生成后即可运行。** native-generated pack 可以包含 commands、roles、memory、
validators、evals 和 tool permissions，Vegito 可以直接加载运行：

```sh
vegito repl --pack generated/toefl-live
vegito run --pack generated/data-live -p "Analyze this churn dataset"
vegito packs validate generated/admissions-counselor
vegito packs validate-output generated/admissions-counselor output.md
```

**验证，而不只是感觉。** Vegito harness 可以包含 rubric prompts、required signals、
score gates、artifact checks、validator scripts 和 eval cases。这样生成的 harness
是可检查、可测试的，而不是不透明的 prompt blob。

**把记忆作为 harness 原语。** 不同领域需要不同记忆。TOEFL 教练应该记住分数历史
和反复出现的弱点；数据科学 harness 应该记住数据集假设、schema 风险、因果推断拒绝
和 artifact 状态；申请顾问应该记住申请人资料、目标学校、截止日期、文书、推荐信、
经济资助限制和下一步行动。

**安全演化。** Vegito 可以观察真实 session，并提出 harness 改进建议。但演化过程
受到 permission checks、provenance、rollback、validators、evals 约束，不会默默改写
核心系统源码。

### 当前示例

这个仓库包含一些已经生成的 harness：

**TOEFL 口语教练**

```sh
vegito repl --pack generated/toefl-live
```

命令：

```text
/toefl-diagnose
/toefl-drill
/toefl-review
/toefl-full-test
/toefl-explain-rubric
```

**客户流失数据科学团队**

```sh
vegito repl --pack generated/data-live
```

命令：

```text
/churn-run-pipeline
/churn-quality-gates
/churn-inspect-schema
/churn-eda
/churn-causal-review
```

**美国本科申请顾问**

```sh
vegito repl --pack generated/admissions-counselor
```

命令：

```text
/admissions-profile-review
/admissions-school-list
/admissions-essay-plan
```

### 快速开始

```sh
npm install
npm run install:local
vegito
```

如果要调用 DeepSeek：

```sh
export DEEPSEEK_API_KEY=<your_api_key>
```

运行一次性任务：

```sh
vegito run -p "explain what this repo does"
```

生成离线 pack：

```sh
vegito forge --offline --archetype tutor-team --domain "IELTS writing and speaking" \
  --name ielts --out packs/ielts
```

验证和演化 pack：

```sh
vegito packs validate packs/ielts
vegito evolve packs/ielts --session <session-id>
```

## Documentation

For a first local setup, see [GETTING_STARTED.md](./GETTING_STARTED.md). For a Chinese,
command-first walkthrough for users and other agents, start with [USAGE.md](./USAGE.md).
Full command reference and configuration are in [USER_GUIDE.md](./USER_GUIDE.md). To
build or hand-write a pack, see [PACK_AUTHORING.md](./PACK_AUTHORING.md).

## Requirements

- Node >= 22.18. Node 24 LTS is recommended.
- No runtime dependencies.
- A provider API key only when using live model calls. Offline commands and tests do
  not need one.

## Permission Modes

Every action that touches the filesystem, runs a command, or reaches the network passes
through one gate. The mode sets the gate's default posture:

| Mode | Posture |
| --- | --- |
| `default` | Reads allowed; writes/execute/network **ask** unless a rule allows them. |
| `acceptEdits` | In-workspace writes auto-allowed; out-of-workspace writes still ask. |
| `plan` | Read-only: any non-read action is denied. |
| `bypass` | Rules are skipped, but the floor still denies catastrophic commands and credential exfiltration. |

No mode, and no rule, can override the floor.

## Project Layout

```text
src/
  kernel/        the loop (async generator) + pure reducer + recovery + exit reasons
  context/       three-tier system prompt, diffing, compaction
  tools/         tool registry, budgets, and the builtin tools
  permissions/   the single gate: rules, shell parsing, workspace containment, ask broker
  providers/     vendor-neutral types, wire protocols (anthropic/openai/scripted), catalog
  agents/        child sessions, the task board, inter-agent messaging
  sessions/      JSONL transcript store, resume/fork, memory
  extend/        one registry for packs, skills, commands, hooks, MCP
  forge/         the pack generator (archetype templates -> spec -> files)
  evolve/        observation -> proposal -> gated, revertible mutation
  trace/         local JSONL telemetry, no-op by default
  config/        typed, layered configuration
  ui/            REPL, headless runner, CLI arg parsing and dispatch
packs/           shipped exemplar packs
generated/       generated domain harness examples
catalog/         model catalog data
test/            unit, integration, adversarial suites
```

## Testing

```sh
npm test
npm run check
npm run coverage
npm run test:adversarial
```

## Credential Safety

Use `.env.example` as the public template for local credentials. Real `.env` files,
local `.vegito/` configuration, generated build output, coverage output,
`node_modules/`, and the private `DeepSeek_Anthropic_Integration.md` note are ignored
by Git.

## Status

Vegito is experimental and under active development. Interfaces may change.

## License

MIT.
