# Vegito 启动与使用教程

**Last Updated:** 2026-06-14

这份文档面向第一次接触 Vegito 的同事，目标是让你能在本地启动项目、跑一个任务、创建并使用 pack、理解 session 和自进化的基本流程。

## 1. 项目是什么

Vegito 是一个 TypeScript agent harness。它有三种主要用法：

1. 普通 agent：用 `vegito run` 或 `vegito repl` 让模型完成任务。
2. Pack meta-harness：用 `vegito forge` 生成某个领域的小助手配置包。
3. Self-evolvement harness：用 `vegito evolve` 从真实 session 里提炼经验，并把经验安全地写回 pack。

一个 pack 可以理解成“领域小助手配置包”。它通常包含：

- `pack.json`：pack 清单，声明 persona、rubric、agent、memory 等文件。
- `persona.md`：助手的角色和行为规则。
- `rubrics/`：评分或验收规则。
- `memory/`：长期记忆和可沉淀的用户/任务模式。
- `agents/`：pack 内的子角色，例如 coach、examiner、reviewer。

Vegito 的自进化默认改的是 pack，不是直接改 Vegito 主程序源码。

## 2. 环境要求

- Node.js `>= 22.18`，推荐 Node 24 LTS。
- npm。
- 如果要连接真实模型，需要配置 provider API key。

项目零运行时依赖，开发时可以直接运行 TypeScript 源码。`bin/vegito.js` 会优先加载 `dist/cli.js`，如果没有构建产物，就回退到 `src/cli.ts`。

## 3. 安装依赖

在项目根目录运行：

```sh
cd /home/ubuntu/Building\ the\ Ultimate\ Harness/vegito
npm install
```

如果依赖已经存在，可以跳过这一步。

## 4. 本地启动方式

推荐先把当前仓库安装成用户级命令：

```sh
npm run install:local
```

这个命令会创建 `~/.local/bin/vegito`。你的环境里 `~/.local/bin` 已经在 `PATH`
中，所以安装后可以直接运行：

```sh
vegito
```

无参数的 `vegito` 会进入交互式 REPL。更复杂的功能继续把参数写在 `vegito`
后面：

```sh
vegito help
vegito version
vegito run -p "Summarize this repository in five bullets"
vegito repl --pack packs/ielts
vegito evolve packs/ielts --session <session-id>
```

如果还没有安装本地命令，也可以从仓库内直接调用：

```sh
node bin/vegito.js help
```

## 5. 配置模型

Vegito 的配置来自四层，后面的优先级更高：

1. 内置默认值。
2. `~/.vegito/config.json`。
3. 项目内 `./.vegito/config.json`。
4. CLI flags，例如 `--model`、`--mode`、`--cwd`。

当前默认模型是 `deepseek-v4-pro`，通过 DeepSeek 官方 Anthropic-compatible API
调用，默认 `reasoningEffort` 是 `max`。模型数据来自 `catalog/models.json` 和配置里的
catalog overlay。

### 使用 DeepSeek V4

DeepSeek 通过 Anthropic-compatible API 接入。`deepseek-v4-pro` 和
`deepseek-v4-flash` 的官方 base URL 已经写在 `catalog/models.json`，通常只需要设置
API key。不要把 key 写进文档、测试 fixture 或提交记录。只在 shell 环境里设置：

```sh
export ANTHROPIC_AUTH_TOKEN=<your DeepSeek API key>
```

Vegito also accepts `ANTHROPIC_API_KEY` for Anthropic-compatible providers. If both are
set, `ANTHROPIC_API_KEY` wins.

默认 `vegito`、`vegito repl`、`vegito run` 都会使用 `deepseek-v4-pro`。也可以显式选择模型：

```sh
vegito run --model deepseek-v4-pro -p "Reply with exactly: vegito ok"
```

也可以给某个项目写本地配置：

```sh
mkdir -p .vegito
printf '%s\n' '{"model":"deepseek-v4-pro","reasoningEffort":"max","permissionMode":"default","maxIterations":30}' > .vegito/config.json
```

如果你明确要走公司代理或其它兼容网关，再额外设置：

```sh
export ANTHROPIC_BASE_URL=https://your-proxy.example/anthropic
```

当前 catalog 里有两个 DeepSeek V4 模型：

- `deepseek-v4-pro`
- `deepseek-v4-flash`

两者都配置为 1,000,000 token context window 和 384,000 max output。

## 6. 跑一个 one-shot 任务

`run` 是一次性任务，适合脚本和 CI：

```sh
vegito run -p "Summarize this repository in five bullets"
```

常用参数：

- `--model <id>`：指定模型。
- `--mode default|acceptEdits|plan|bypass`：指定权限模式。
- `--cwd <dir>`：指定工作目录。
- `--json`：输出 JSONL 事件流，方便脚本消费。
- `--pack <name-or-path>`：加载某个 pack 的 persona、skills、commands、hooks 等运行时上下文。

例如在只读模式下让它分析项目：

```sh
vegito run --mode plan -p "Inspect the project and explain the main modules"
```

## 7. 启动交互式 REPL

`repl` 是交互式会话：

```sh
vegito
```

启动后会看到类似：

```text
vegito repl ready - session <session-id>
vegito>
```

看到 `vegito>` 后，直接输入你的问题并回车。如果终端长时间没有其它输出，通常是 REPL 正在等你输入，而不是项目卡死。

加载 pack 启动：

```sh
vegito repl --pack packs/ielts
```

REPL 产生的 transcript 会写入 `~/.vegito/sessions/`，后续可以 resume、fork，也可以作为 `evolve` 的输入。

## 8. 查看和恢复 session

```sh
vegito sessions list
vegito sessions resume <session-id>
vegito sessions fork <session-id> <record-id>
```

session 是 Vegito 自进化的重要输入。`evolve` 会读取一个已有 session，让 reviewer 模型分析这次运行里有什么可沉淀的经验。

## 9. 创建一个 pack

用 `forge --offline` 可以完全离线、确定性地生成 pack：

```sh
vegito forge --offline \
  --archetype tutor-team \
  --domain "IELTS writing and speaking" \
  --name ielts \
  --out packs/ielts
```

生成后先校验：

```sh
vegito packs validate packs/ielts
```

然后用这个 pack 跑任务：

```sh
vegito run --pack packs/ielts \
  -p "Score this IELTS Task 2 introduction and give one concrete next drill."
```

如果要检验 Vegito 原生的 meta-harness 能力，而不是使用内置 archetype，可以用
`forge --native` 让模型先生成领域 blueprint，再由 Vegito 编译成可运行 pack：

```sh
vegito forge --native \
  --domain "US undergraduate admissions counselor" \
  --name admissions-counselor

vegito packs validate generated/admissions-counselor
vegito repl --pack generated/admissions-counselor
```

Native 生成的 pack 如果声明了 slash commands，可以直接在 REPL 里输入，例如
`/admissions-profile-review ...`。如果你把一次回答保存成文件，还可以跑 rubric
validator：

```sh
vegito packs validate-output generated/admissions-counselor admissions-output.md
```

## 10. 使用自进化 harness

自进化的安全默认值是 review-only：没有 `--apply` 时，它只打印 observations/proposals，不改文件。

基本流程：

1. 用某个 pack 跑一次真实 session。
2. 通过 `sessions list` 找到 session id。
3. 对这个 session 运行 `evolve`。
4. 先 review-only 看 proposal。
5. 确认后加 `--apply`，让 Vegito 通过权限 gate 和 pack 校验后写回 pack。

示例：

```sh
vegito run --pack packs/ielts \
  -p "Run a short speaking practice and give feedback."

vegito sessions list

vegito evolve packs/ielts --session <session-id>

vegito evolve packs/ielts --session <session-id> \
  --mode acceptEdits \
  --apply
```

应用成功后，Vegito 会：

- append-only 写入 `persona.md`、rubric prompt、onboarding 或 `memory/*.md` 等允许的 pack 文件。
- bump `pack.json` 里的版本号。
- 写 `.evolve/provenance.jsonl`，记录这次变更来自哪个 session、哪些 observations、修改前快照是什么。
- 写 `.evolve/runs.jsonl`，记录 EvolutionRun、candidate decisions、metrics 和 activation evidence。

如果想撤销最近一次演化：

```sh
vegito evolve revert packs/ielts
```

## 11. 权限模式怎么选

| Mode | 适用场景 |
| --- | --- |
| `default` | 日常使用。读允许，写/执行/网络默认 ask。 |
| `acceptEdits` | 你明确允许 Vegito 在 workspace 内改文件，例如 `evolve --apply`。 |
| `plan` | 只读分析，不允许写。 |
| `bypass` | 跳过普通规则，但硬安全底线仍然生效。谨慎使用。 |

自进化示例一般用 `--mode acceptEdits --apply`，因为它需要写 pack 文件。但 pack 路径校验、credential floor、危险命令 floor 仍然会生效。

## 12. 验证项目是否健康

常用验证命令：

```sh
npm run typecheck
npm run lint:constitution
npm audit --audit-level=low
npm test
```

更完整的测试矩阵：

```sh
npm run test:unit
npm run test:integration
npm run test:adversarial
npm run test:e2e
npm run test:golden
npm run coverage
```

`test:e2e` 和 `test:golden` 目录当前可能没有测试文件，脚本会返回 0/0。这表示当前目录为空，不表示失败。

## 13. DeepSeek E2E 产物在哪里

已经跑过的 DeepSeek E2E 结果记录在：

- 总报告：`../vegito-notes/e2e-results.md`
- 运行根目录：`../vegito-notes/e2e-runs/2026-06-13-deepseek`

三个场景：

- `coding-langgraph/`：Coding/LangGraph-style Python 项目。
- `white-collar-skills/`：白领技能 pack，生成 brief 和 follow-up email。
- `toefl-2026/`：TOEFL 2026 pack，并完成一次真实 evolve cycle。

TOEFL 自进化样例里，`toefl-pack/.evolve/runs.jsonl` 记录了两个 accepted candidates：

- 一个把 learned constraint 激活到 `system_prompt` 的 `persona.md`。
- 一个把长期错误模式激活到 `memory/l3.md`。

## 14. 常见问题

### `unknown model`

先确认模型是否在 catalog 中：

```sh
grep -n "deepseek-v4" catalog/models.json
```

如果你通过 `--cwd` 在外部项目运行，Vegito 仍会加载包内默认 catalog，再叠加 `~/.vegito/models.json` 和项目 `.vegito/models.json`。

### provider 401 或 403

通常是 API key 错误或过期。重新设置环境变量，不要把 key 写入 repo：

```sh
export ANTHROPIC_AUTH_TOKEN=<new key>
```

### `evolve` 没有改文件

检查三点：

1. 是否传了 `--apply`。
2. session 是否真的有可提炼的 observations。
3. 当前权限模式是否允许写 pack 目录。

### pack 校验失败

运行：

```sh
vegito packs validate <pack-dir>
```

先修复 `pack.json`、路径、缺失文件或 schema 问题，再重新运行。
