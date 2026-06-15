# Vegito 使用说明

**Last Updated:** 2026-06-15  
**适用对象:** 第一次使用 Vegito 的用户、接手项目的工程师、以及需要调用 Vegito 的其他 agent。

这份文档重点讲 `vegito` 命令怎么用。Node/npm 命令只放在最后，作为开发和验证补充。

## 1. Vegito 是什么

Vegito 是一个 TypeScript agent harness，核心能力有三类：

1. **普通 agent:** 用 `vegito run` 或 `vegito repl` 做代码、分析、写作、运维等任务。
2. **meta-harness:** 用 `vegito forge` 生成某个领域的 harness pack。
3. **手动自进化:** 用 `vegito evolve` 从真实 session 中提炼摩擦和改进建议，再通过权限 gate 写回 pack。

一个 **pack / harness** 可以理解成“领域助手配置包”。它通常包含 persona、rubric、commands、agents、memory、hooks 等文件。Vegito 主程序负责加载、运行、验证、锻造和进化这些 pack。

## 2. 当前已有 Pack

项目里有两类 pack：

| Pack | 来源 | 用途 |
|---|---|---|
| `packs/code-review/` | 随项目发布的 exemplar | 代码审查示例 pack |
| `packs/ielts/` | 随项目发布的 exemplar | IELTS 写作/口语 tutor 示例 pack |
| `generated/admissions-counselor/` | forge 生成 | 美国本科申请顾问 |
| `generated/data-live/` | forge 生成 | 客户流失分析数据工具链 |
| `generated/toefl-live/` | forge 生成 | TOEFL iBT 口语教练 |

查看当前 `generated/` 下的 harness：

```sh
vegito packs generated
```

当前输出会列出 3 个 generated harness 及其 slash commands。

## 3. 安装和启动

进入项目目录：

```sh
cd /home/ubuntu/Building\ the\ Ultimate\ Harness/vegito
```

如果还没有安装依赖：

```sh
npm install
```

把当前仓库安装成本机 `vegito` 命令：

```sh
npm run install:local
```

安装后可以直接运行：

```sh
vegito help
vegito version
vegito
```

如果没有安装本地命令，也可以在仓库内直接调用：

```sh
node bin/vegito.js help
```

## 4. 模型凭证

默认模型是 `deepseek-v4-pro`。真实模型调用需要 provider key。不要把 key 写进代码、文档或测试 fixture。

常见设置：

```sh
export ANTHROPIC_AUTH_TOKEN=<your_api_key>
```

也支持：

```sh
export ANTHROPIC_API_KEY=<your_api_key>
```

如果只是跑测试、离线路径、`--script` fixture、`forge --offline`、`packs validate`、`packs generated` 等命令，不需要真实模型 key。

## 5. 命令总览

```text
vegito                         # 启动交互式 REPL
vegito help                    # 查看命令摘要
vegito version                 # 查看版本

vegito run -p "<prompt>"       # 单次 headless 任务
vegito repl                    # 交互式会话
vegito sessions ...            # 查看/恢复/分叉 session
vegito packs ...               # 查看、验证、信任 pack
vegito forge ...               # 生成 pack
vegito evolve ...              # 从 session 中进化 pack，默认 review-only
```

后面逐个展开。

## 6. `vegito run`：单次任务

`run` 适合脚本、CI、一次性分析。

```sh
vegito run -p "<prompt>" [--json] [--model <id>] [--mode <mode>] [--cwd <dir>] [--pack <pack>] [--script <file>]
```

例子：

```sh
vegito run -p "用五条 bullet 总结这个项目"
```

加载某个 pack：

```sh
vegito run --pack generated/toefl-live \
  -p "帮我做一次 TOEFL speaking 诊断"
```

只读分析，不允许写文件：

```sh
vegito run --mode plan \
  -p "阅读这个仓库并解释主要模块"
```

输出 JSONL 事件流：

```sh
vegito run --json -p "summarize the test suite"
```

常用参数：

| 参数 | 作用 |
|---|---|
| `-p`, `--prompt` | 任务内容。`run` 必填。 |
| `--json` | 输出一行一个 JSON event，适合脚本消费。 |
| `--model <id>` | 覆盖默认模型。 |
| `--mode <mode>` | 权限模式：`default`、`acceptEdits`、`plan`、`bypass`。 |
| `--cwd <dir>` | 指定工作目录。 |
| `--pack <pack>` | 加载 pack。可以重复传多个。 |
| `--script <file>` | 使用离线 scripted wire，测试用。 |

## 7. `vegito repl`：交互式会话

无参数 `vegito` 等价于启动 REPL：

```sh
vegito
```

显式启动：

```sh
vegito repl
```

加载 pack：

```sh
vegito repl --pack generated/admissions-counselor
```

进入 REPL 后会看到：

```text
vegito repl ready - session <session-id>
vegito>
```

看到 `vegito>` 时，表示 Vegito 正在等普通用户输入。

REPL 里可以使用 slash commands。Pack 提供的 commands 会作为 slash command 出现，例如：

```text
/admissions-profile-review GPA 3.8 CS major budget-sensitive
/churn-inspect-schema data/customers.csv
/toefl-diagnose I think the lecture mainly explains...
```

Vegito 自带的本地 REPL 命令不会触发模型：

| 命令 | 作用 |
|---|---|
| `/packs` | 列出 `generated/` 下的 harness。 |
| `/self` | 输出 Vegito 的简短 self-map。 |
| `/architecture` | 输出 Vegito 的运行时架构摘要。 |
| `/evolution-status` | 输出当前进化策略和默认手动触发状态。 |

权限提示会使用单独的 `permission>` 状态，不会混在普通 `vegito>` 输入里。允许/拒绝可以输入：

```text
a / allow / y / yes
d / deny / n / no
? / details
```

## 8. `vegito sessions`：管理会话

Vegito 会把会话写入 `~/.vegito/sessions/`。这些 session 可以恢复、分叉，也可以作为 `evolve` 的输入。

```sh
vegito sessions list
vegito sessions resume <session-id>
vegito sessions fork <session-id> <record-id>
```

常见用法：

```sh
vegito sessions list
vegito sessions resume 01KV...
```

`fork` 用于从某条记录分叉一个新 session，适合探索另一个方向而不破坏原会话。

## 9. `vegito packs`：查看和验证 pack

```sh
vegito packs list
vegito packs generated
vegito packs prompt
vegito packs validate <dir>
vegito packs validate-output <pack> <candidate-file>
vegito packs trust <pack>
```

### 9.1 列出 pack roots 中的 pack

```sh
vegito packs list
```

默认只搜索配置里的 `packRoots`：

```text
./packs
~/.vegito/packs
```

注意：这不等于 `generated/`。如果要看 `generated/`，用：

```sh
vegito packs generated
```

### 9.2 查看 generated harness

```sh
vegito packs generated
```

这个命令会扫描当前工作目录下的 `generated/`，并显示 name、version、description 和 slash commands。

### 9.3 查看当前 system prompt 组装结果

```sh
vegito packs prompt
```

这会打印当前组装出来的 system tiers，例如：

- T1：identity + operating principles
- T2：environment、self-map、active packs、memory files

这个命令主要给开发者和其他 agent 调试用。它不会调用模型。

### 9.4 验证 pack

```sh
vegito packs validate packs/ielts
vegito packs validate generated/toefl-live
```

验证会检查 `pack.json`、文件路径、agents、rubrics、commands、validators 等是否合理。

### 9.5 验证候选输出

```sh
vegito packs validate-output <pack> <candidate-file>
```

例如：

```sh
vegito packs validate-output generated/toefl-live answer.md
```

这会用 pack 声明的 rubric validators 检查某个回答或产物文件。

### 9.6 信任 pack

```sh
vegito packs trust <pack>
```

信任主要影响 executable hooks。未信任 pack 仍然可以提供 persona、skills、commands、非执行型 hooks 等。

## 10. `vegito forge`：生成 harness pack

Forge 是 Vegito 的 meta-harness 能力：根据领域描述生成一个完整 pack。

```sh
vegito forge [--native] [--offline] [--archetype <id>] [--domain "<text>"] [--name <id>] [--from <docs>] [--out <dir>]
```

### 10.1 离线确定性生成

```sh
vegito forge --offline \
  --archetype tutor-team \
  --domain "IELTS writing and speaking" \
  --name ielts \
  --out packs/ielts
```

`--offline` 不调用模型，适合测试和可重复生成。

### 10.2 Native forge

```sh
vegito forge --native \
  --domain "US undergraduate admissions counselor" \
  --name admissions-counselor
```

不指定 `--out` 时，Forge 默认写到：

```text
generated/<pack-name>
```

所以这个例子会写到：

```text
generated/admissions-counselor
```

生成后建议立刻验证：

```sh
vegito packs validate generated/admissions-counselor
```

然后启动：

```sh
vegito repl --pack generated/admissions-counselor
```

### 10.3 从文档推断

```sh
vegito forge --from domain-notes.md --out generated/my-pack
```

Vegito 会尝试从文档推断 archetype 和 domain。

## 11. `vegito evolve`：手动进化 harness

Evolve 从真实 session 中观察摩擦，然后生成改进 proposal。默认是 **review-only**，不会改文件。

```sh
vegito evolve <pack-dir> --session <session-id> [--mode <mode>] [--script <file>] [--apply]
vegito evolve eval <pack-dir>
vegito evolve revert <pack-dir>
```

### 11.1 Review-only，不修改 pack

```sh
vegito evolve generated/toefl-live --session <session-id>
```

输出会说明 observations、proposals 和 apply 命令。

### 11.2 Apply，通过权限 gate 写回 pack

```sh
vegito evolve generated/toefl-live \
  --session <session-id> \
  --mode acceptEdits \
  --apply
```

应用时会经过：

1. permission gate
2. pack validation
3. provenance 记录
4. version bump
5. revert 支持

### 11.3 Revert

```sh
vegito evolve revert generated/toefl-live
```

撤销上一批 applied proposals。

### 11.4 关键路径规则

`evolve` 的第一个位置参数是 **目录路径**，不是 pack 名字搜索：

```sh
vegito evolve generated/toefl-live --session <sid>
vegito evolve packs/ielts --session <sid>
```

如果不传路径，默认是当前目录 `.`：

```sh
vegito evolve --session <sid>
```

等价于：

```sh
vegito evolve . --session <sid>
```

所以除非你已经 `cd` 到某个 pack 目录里，否则建议总是显式写路径。

### 11.5 不会自动后台进化

当前策略是手动触发：

- 不会 session 结束后自动更新 pack
- 不会默认后台跑 evolution loop
- 不会默认跑昂贵 eval sweep
- 没有 `--apply` 时不会写回 pack

## 12. 权限模式

所有文件系统、命令执行、网络访问都经过同一套 gate。

| Mode | 行为 |
|---|---|
| `default` | 读通常允许；写、执行、网络通常询问。 |
| `acceptEdits` | workspace 内写入自动允许；workspace 外仍会询问。 |
| `plan` | 只读；非读动作拒绝。 |
| `bypass` | 跳过普通规则，但硬性安全底线仍生效。 |

常用例子：

```sh
vegito run --mode plan -p "只分析，不改文件"
vegito run --mode acceptEdits -p "修复这个测试"
vegito evolve generated/toefl-live --session <sid> --mode acceptEdits --apply
```

## 13. Pack 路径规则

这里容易混淆，单独说明。

### `repl --pack` / `run --pack`

`--pack` 可以是路径，也可以是名字。

路径例子：

```sh
vegito repl --pack generated/toefl-live
vegito repl --pack packs/ielts
```

名字例子：

```sh
vegito repl --pack ielts
```

名字会在 `packRoots` 中查找。默认：

```text
./packs
~/.vegito/packs
```

所以 `--pack ielts` 默认能找到 `packs/ielts`，但不会自动找 `generated/toefl-live`。

### `evolve`

`evolve` 不走 `packRoots` 名字搜索。它把第一个参数当路径：

```sh
vegito evolve generated/toefl-live --session <sid>
```

如果不传路径，默认是当前目录 `.`。

## 14. 常见工作流

### 14.1 使用已有 generated harness

```sh
vegito packs generated
vegito repl --pack generated/toefl-live
```

进入 REPL 后：

```text
/toefl-diagnose <your answer>
/toefl-drill independent
/toefl-review <your answer>
```

### 14.2 锻造一个新 harness

```sh
vegito forge --native \
  --domain "B2B SaaS pricing analyst" \
  --name saas-pricing

vegito packs validate generated/saas-pricing
vegito repl --pack generated/saas-pricing
```

### 14.3 对 generated harness 做手动进化

```sh
vegito repl --pack generated/toefl-live
vegito sessions list
vegito evolve generated/toefl-live --session <session-id>
vegito evolve generated/toefl-live --session <session-id> --mode acceptEdits --apply
```

### 14.4 对 exemplar pack 做手动进化

```sh
vegito repl --pack packs/ielts
vegito sessions list
vegito evolve packs/ielts --session <session-id>
vegito evolve packs/ielts --session <session-id> --mode acceptEdits --apply
```

## 15. 给其他 Agent 的快速规则

如果你是接手项目的 agent，优先遵守这些：

1. 先跑 `vegito help` 和 `vegito packs generated` 看可用命令和 generated harness。
2. 不确定系统 prompt 时，跑 `vegito packs prompt`，不要凭空猜。
3. 使用 pack 时优先显式路径：`generated/...` 或 `packs/...`。
4. `evolve` 默认 review-only；只有用户明确要求才加 `--apply`。
5. 不要把 session 结束自动进化当成默认能力。
6. 对源码改动，跑 `npm run typecheck`、`npm run lint:constitution`、相关测试。
7. 如果测试需要 localhost 或真实子进程，普通沙箱可能失败，需要区分环境限制和代码失败。

## 16. Node / npm 命令

这些是开发者命令，不是 Vegito 用户日常命令。

```sh
npm install
npm run install:local
npm run typecheck
npm run lint:constitution
npm run test:unit
npm run test:e2e
npm run build
npm test
```

| 命令 | 作用 |
|---|---|
| `npm run install:local` | 把当前仓库安装成本机 `vegito` 命令。 |
| `npm run typecheck` | TypeScript 类型检查。 |
| `npm run lint:constitution` | 检查代码是否违反项目 constitution。 |
| `npm run test:unit` | 跑 unit tests。 |
| `npm run test:e2e` | 跑 e2e tests。 |
| `npm run build` | 编译到 `dist/`。 |
| `npm test` | 跑全部测试。 |

## 17. 出问题时先看什么

| 现象 | 优先检查 |
|---|---|
| `vegito` 命令不存在 | 是否跑过 `npm run install:local`；`~/.local/bin` 是否在 `PATH`。 |
| 真实模型调用失败 | API key 是否设置；模型 id 是否在 catalog 中。 |
| `repl --pack ielts` 找不到 | `packRoots` 是否包含 `./packs`；也可以改用显式路径 `packs/ielts`。 |
| `repl --pack generated/toefl-live` 找不到 | 确认当前 cwd 是项目根目录，或传绝对路径。 |
| `evolve` 找错 pack | 显式写路径，不要依赖默认 `.`。 |
| 权限提示看不懂 | 当前应该看到独立的 `Permission request` 和 `permission>`。输入 `a`/`d` 即可。 |
| missing skill 报错 | 应该作为普通 tool failure 显示，不应该打印 Node stack trace。 |
| 全量 unit 在沙箱失败 | 看是否是 localhost listen / 子进程权限问题；目标测试和提权验证更能说明代码状态。 |
