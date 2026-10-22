# 完整开发任务：网店日结对账

这里没有预设模型回复，也没有伪造工具日志。`seed/` 是一个确实有错误的、能运行的 Node.js 小项目。实验运行器将它复制到独立工作目录，让 Pi 读取、修改和执行，然后以相同会话继续第二轮需求。

- 第一轮：修复日期、重复通知、退款、异常通知及金额计算，补测试，交付 JSON、CSV 和中文说明。
- 第二轮：处理迟到的补单、同一通知 ID 的冲突版本和逐笔手续费，同时保留第一轮行为。
- 任务与原始用户需求：`schema/task.json`。
- 独立业务验收：`node verify.mjs <workspace> <1|2>`。验收器放在可写工作目录之外；它运行真正的 CLI、核对实际产物，并运行项目自己的测试。

验收器的 `passed` 是业务任务是否完成。它与 Humanize 的“原始回复是否让人理解、是否需要改写、改写能否放行”是两个不同维度。

验收覆盖真实业务输入及独立边界样例；这不是安全沙箱，也不能防御恶意项目代码。实验只给模型处理这份合成业务项目的权限，不使用真实订单或账户信息。

本批 4 个模型的结果、逐条对应示例与观察到的局限见 [中文实测记录](results.md)。

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

每个模型只运行一次实际开启 Humanize 的会话，在同一个工作目录继续两轮需求。页面中的“原稿 / 最终稿”来自这一次执行中的同一条消息，使用同一个消息 ID 一对一配对：原稿是审阅前捕获的真实候选回复，最终稿是审阅后实际放行的内容。没有把两次独立运行的不同回复拼成对比，也没有预写一份故意难懂的答案。若审阅未能放行，该条消息没有最终稿，应展示被拦截原因。

因此，这个对比能观察 Humanize 对每条实际回复的影响，不能证明关闭功能后整个开发过程会走同样的路线。读文件、改代码、运行测试和生成产物都是真实执行；订单、通知和业务情境是为实验设计的合成数据。

## 验收口径

第一轮有 19 项验收，第二轮有 24 项。外部验收器不能由任务中的 Agent 修改；它用独立输入调用项目 CLI，核对业务数字、日期边界、异常处理和交付文件，并执行项目回归测试。验收器只在临时 `reports/.acceptance-*` 目录中生成自己的测试产物，完成后删除；不会替 Agent 生成应交付的 `reports/summary.md` 或正式报表。

正式模型实验开始前，用独立人工参考实现检查过验收器：第一轮 19/19，第二轮 24/24。参考实现仅用于确认验收条件可达，没有放进 `seed/`，也不作为模型执行轨迹发布。这不是对模型完成率的统计。

`summary.md` 的自动检查仅覆盖存在、非空和包含中文，不代表其内容已经过事实核查。业务验收通过、回复被 Humanize 放行，以及人是否觉得更好理解，必须分开观察。模型接口错误、开发未完成和回复审阅未放行也应分别展示。

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

当前脚本仅支持正常结束、无工具调用的原稿，且审阅流程恰好为 `review → rewrite`、首次改写被内容保护拒绝。需要 lookup、缺失响应、取消、超时、无效 JSON、源码不一致或报告无法吻合的情况会明确退出，不会伪造执行历史或推测失败原因。

针对真实保存响应的回归检查：

```sh
node --permission --allow-fs-read=. \
  --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --test-isolation=none --test scripts/replay-humanize-message.test.mjs
```
