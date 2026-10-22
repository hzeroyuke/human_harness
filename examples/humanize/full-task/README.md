# 完整开发任务：网店日结对账

这里没有预设模型回复，也没有伪造工具日志。`seed/` 是一个确实有错误的、能运行的 Node.js 小项目。实验运行器将它复制到独立工作目录，让 Pi 读取、修改和执行，然后以相同会话继续第二轮需求。

- 第一轮：修复日期、重复通知、退款、异常通知及金额计算，补测试，交付 JSON、CSV 和中文说明。
- 第二轮：处理迟到的补单、同一通知 ID 的冲突版本和逐笔手续费，同时保留第一轮行为。
- 任务与原始用户需求：`schema/task.json`。
- 独立业务验收：`node verify.mjs <workspace> <1|2>`。验收器放在可写工作目录之外；它运行真正的 CLI、核对实际产物，并运行项目自己的测试。

种子目录已经包含渠道补充说明和第二轮数据，模型可以在第一轮提前读取。因此第二轮是连续追加的用户需求，不是对完全未知规则的盲测；所有尝试起点相同，真实读取顺序保留在工具轨迹中。

验收器的 `passed` 表示预先定义的自动业务检查是否全部通过，不覆盖所有自然语言交付要求。它与 Humanize 的“原始回复是否让人理解、是否需要改写、改写能否放行”是两个不同维度。

验收覆盖真实业务输入及独立边界样例；这不是安全沙箱，也不能防御恶意项目代码。实验只给模型处理这份合成业务项目的权限，不使用真实订单或账户信息。

各模型、各次尝试的结果、逐条对应示例与观察到的局限见 [中文实测记录](results.md)。

## 复现实验

这个实验运行器需要 Node.js 25.2 或以上，本次使用 25.2.1。它依赖 `--permission`、默认拒绝网络访问的权限行为，以及 `--test-isolation=none`。这是完整任务实验的要求；Pi 本体的 Node.js 22.19 最低版本要求保持不变。

从仓库根目录执行，先确保本机 Copilot 反代可用。每次运行使用新的 `HUMANIZE_TASK_RUN_ID`，避免覆盖已有记录。

```sh
HUMANIZE_TASK_MODEL=gemini-3.8-flash \
HUMANIZE_TASK_MODE=on \
HUMANIZE_TASK_RUN_ID=gemini-full-20261022-01 \
node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/humanize-full-task.ts
```

本批 GPT、MAI 和 Grok 模型使用 Responses 接口，例如：

```sh
HUMANIZE_TASK_MODEL=gpt-6.1-sol \
HUMANIZE_TASK_API=openai-responses \
HUMANIZE_TASK_MODE=on \
HUMANIZE_TASK_RUN_ID=gpt-full-20261022-01 \
node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/humanize-full-task.ts
```

测试 MAI 时，将模型改为 `mai-code-1.1-flash`，同时更换运行 ID；接口仍用 `openai-responses`。可调用的模型取决于本机反代当时提供的列表。

每次尝试运行一个实际开启 Humanize 的会话，在独立工作目录中继续两轮需求。同一模型可以有多次尝试；新的尝试从相同种子重新开始，保留旧尝试的失败与中断，不续接或覆盖旧数据。页面可选择具体尝试，分享链接用 `runId` 固定该次执行。页面中的“原稿 / 最终稿”来自这一次执行中的同一条消息，使用同一个消息 ID 一对一配对：原稿是审阅前捕获的真实候选回复，最终稿是审阅后实际放行的内容。没有把两次独立运行的不同回复拼成对比，也没有预写一份故意难懂的答案。若审阅未能放行，该条消息没有最终稿，应展示被拦截原因。

因此，这个对比能观察 Humanize 对每条实际回复的影响，不能证明关闭功能后整个开发过程会走同样的路线。读文件、改代码、运行测试和生成产物都是真实执行；订单、通知和业务情境是为实验设计的合成数据。

## 运行限额与补测条件

首次四模型尝试使用默认限额。补测 Astra、5.6 Sol、Grok 和 MAI 时，保持种子项目、用户需求、核心审阅源码、主 Agent 提示及两次改写上限不变，扩大运行时间预算。网页可查看每次实际记录的限额，不能将不同条件的尝试混成统一通过率。

| 环境变量 | 默认值 | 补测值 | 允许上限 |
|---|---:|---:|---:|
| `HUMANIZE_TASK_REVIEW_TIMEOUT_MS` | 120000 | 300000 | 300000 |
| `HUMANIZE_TASK_REQUEST_TIMEOUT_MS` | 90000 | 180000 | 300000 |
| `HUMANIZE_TASK_ROUND_TIMEOUT_MS` | 720000 | 1800000 | 3600000 |
| `HUMANIZE_TASK_MAX_AGENT_CALLS` | 45 | 60 | 200 |

前三项单位为毫秒，最后一项为每轮主模型调用次数。审核总时限覆盖同一条消息的审阅、查证、改写和复审，并非每个阶段各有这么多时间。非正整数、空值或超出上限会在创建实验目录前报错。请求超时是传给 provider 的参数，已有记录表明它不总是严格的墙钟上限；实际耗时仍单独保存。

```sh
HUMANIZE_TASK_MODEL=gpt-6-astra \
HUMANIZE_TASK_API=openai-responses \
HUMANIZE_TASK_MODE=on \
HUMANIZE_TASK_RUN_ID=astra-extended-20261022-01 \
HUMANIZE_TASK_REVIEW_TIMEOUT_MS=300000 \
HUMANIZE_TASK_REQUEST_TIMEOUT_MS=180000 \
HUMANIZE_TASK_ROUND_TIMEOUT_MS=1800000 \
HUMANIZE_TASK_MAX_AGENT_CALLS=60 \
node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/humanize-full-task.ts
```

测试 `gpt-5.6-sol`、`grok-4.7` 或 `mai-code-1.1-flash` 时替换模型和运行 ID。配置解析源码也记录 SHA-256；旧记录保留旧运行器哈希和限额。

推理强度通过可选的 `HUMANIZE_TASK_REASONING=low|medium|high` 指定。未设置时保持旧行为：不向上游发送推理强度参数，不能据此断言模型没有推理。显式配置同时用于主 Agent、盲审、查证和改写，记录在 `reasoning` 字段。Grok 第三次尝试使用 `low`，其他限额与补测相同；重跑时在上述命令中增加 `HUMANIZE_TASK_REASONING=low` 并更换模型及运行 ID。

参数解析和实际请求格式分别测试；后者使用本地响应替身拦截 provider 的 HTTP 请求，不访问代理。Pages 仅运行无需安装依赖的解析测试。

```sh
node --test scripts/humanize-full-task-limits.test.mjs scripts/humanize-full-task-model-options.test.mjs
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --test scripts/humanize-full-task-model-options-wire.test.mjs
```

## 为什么 Gemini 每轮只有一条回复

页面中的“文字消息”不是模型请求次数。Gemini 首次完整任务共调用主模型 29 次，其中 27 次只请求工具执行，只有两轮结束时各产生一条非空文字。第一轮 22 次响应、21 次纯工具响应、28 次工具操作；第二轮 7 次响应、6 次纯工具响应、6 次工具操作。两条文字都经过独立盲审，并原样放行。

工具响应及执行结果保留在原始响应和工具轨迹中；界面不会为没有文字的响应补写一段话。每条带文字的真实响应则必须有同 ID 的放行或拦截记录，发布校验会拒绝漏配、跨尝试配对或用未批准候选稿充当最终稿。

## 验收口径

第一轮有 19 项验收，第二轮有 24 项。外部验收器不能由任务中的 Agent 修改；它用独立输入调用项目 CLI，核对业务数字、日期边界、异常处理和交付文件，并执行项目回归测试。验收器只在临时 `reports/.acceptance-*` 目录中生成自己的测试产物，完成后删除；不会替 Agent 生成应交付的 `reports/summary.md` 或正式报表。

正式模型实验开始前，用独立人工参考实现检查过验收器：第一轮 19/19，第二轮 24/24。参考实现仅用于确认验收条件可达，没有放进 `seed/`，也不作为模型执行轨迹发布。这不是对模型完成率的统计。

`summary.md` 的自动检查仅覆盖存在、非空和包含中文，不代表其内容已经过事实核查。项目自己的测试检查只验证运行成功，不能保证模型保留了旧测试并补足新场景；例如 MAI 补测第二轮替换了旧场景，虽然外部业务检查为 24/24，这一交付要求仍未满足。业务验收通过、回复被 Humanize 放行，以及人是否觉得更好理解，必须分开观察。模型接口错误、开发未完成和回复审阅未放行也应分别展示。

## 离线复现被拦截消息

MAI 的第一轮开发通过了 19/19 项业务验收，但最后一条回复的改写稿删除了收款 430.20 元、退款 20.00 元、净收款 410.20 元等关键金额。改写 JSON 本身合法；源码中的内容保护检查拒绝了它，因此没有最终稿，第二轮也没有开始。

原始运行只保存了通用错误。`diagnostics/mai-protection.json` 是独立的补充诊断：将已保存的原稿和两次审阅响应交给相同哈希的源码离线重放，确认触发 `Humanize revision changed protected technical content.`。脚本同时核对每次系统提示、请求载荷和最终报告，未重新请求模型或执行开发任务，也没有改写原始轨迹。

从仓库根目录执行下列命令可重新计算诊断。默认只向标准输出写 JSON；Node 权限仅允许读取仓库，没有网络或子进程权限。

```sh
node --permission --allow-fs-read=. \
  --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  scripts/replay-humanize-message.ts \
  site/data/full-task.json mai-code-1.1-flash-complete-v1 1 r1-message-16
```

第一个参数也可以是原始单次运行 JSON。其后三个参数依次是运行 ID、轮次 ID 和消息 ID。可选 `--output <新文件.json>` 只允许创建新文件，需另外授予该路径的写权限；已有文件不会被覆盖。网页按这三个 ID 附加诊断，保留原始错误，显示为“本地复现诊断”。

MAI 补测的第二轮另有一条被拦截消息：先盲审，再查证执行记录，改写删掉了说明冲突通知所需的旧金额 **150.00 元**。`diagnostics/mai-extended-protection.json` 单独记录这一原因，保留原始失败数据。

```sh
node --permission --allow-fs-read=. \
  --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  scripts/replay-humanize-message.ts \
  site/data/full-task.json mai-code-1.1-flash-extended-v1 2 r2-message-12
```

Grok 第三次尝试（显式 `low` 推理强度）的第二轮经过盲审、改写、复审和第二次改写，最后一个候选稿删除了原文中的时间 **23:59:59**。相同核心源码离线重放四次保存响应，并核对请求和报告，确认在第二次改写的内容保护处停止。数字匹配规则报告的缺失项是 `23`、`59`，诊断同时展示其完整时间上下文；见 [独立诊断文件](diagnostics/grok-low-protection.json)。

```sh
node --permission --allow-fs-read=. \
  --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  scripts/replay-humanize-message.ts \
  site/data/full-task.json grok-4.7-low-v1 2 r2-message-7
```

当前脚本仅支持正常结束、无工具调用的原稿，以及三种精确的保护失败流程：`review → rewrite`、`review → lookup → rewrite` 的首次改写被拒绝，或 `review → rewrite → review → rewrite` 的第二次改写被拒绝。查证输入从原始响应、实际工具事件和已放行文字重建，再与当时发送的截断载荷逐字核对，不能直接相信记录中的查证载荷。缺失响应、额外查证、取消、超时、无效 JSON、源码不一致或报告无法吻合的情况会明确退出，不会伪造执行历史或推测失败原因。

针对真实保存响应的回归检查：

```sh
node --permission --allow-fs-read=. \
  --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --test-isolation=none --test scripts/replay-humanize-message.test.mjs
```
