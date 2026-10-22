# 可视化轨迹与 GitHub Pages

可视化分支为 `feat/trajectory-explorer`。网页文件位于 `site/`。首页读取真实任务的 `site/data/full-task.json`，历史页 `archive.html` 读取旧批次的 `site/data/benchmark.json`；两者都使用相对路径，不依赖服务器、打包工具或外部字体。

首页逐条比较同一次实际 Pi 会话中的原始回复与 Humanize 最终放行的回复，按消息 ID 一一对应。不能用两个独立运行的不同回答推断改写效果。失败时最终稿为空，不会把未通过的候选文字冒充为已发送内容。表达检查与独立业务验收分别展示。

## 本地查看

已有本仓库的 clone 时，先切到可视化分支，再在仓库根目录启动静态服务器：

```bash
git switch feat/trajectory-explorer
python3 -m http.server 4173 --directory site
```

访问 [本地页面](http://localhost:4173)。通过 HTTP 打开页面，浏览器才能读取 JSON；直接双击 HTML 文件可能受到浏览器本地文件限制。

## 真实完整任务

任务由两轮连续用户需求组成，使用多文件 Node.js 项目和固定业务数据。每次模型尝试从相同的种子文件开始，在同一个会话中完成两轮工作；Humanize 在 SDK 的实际发送入口开启，主模型的每条文字都先审阅，再决定是否释放。没有人为预设原始回复、术语或工具执行结果。

工具只提供项目内读写、运行测试、生成报表和调用外部验收。原始输入与业务说明只读。Node 子进程使用权限限制，项目代码不能访问网络、运行其他进程或读写项目外文件；外部验收位于项目副本之外。验收会使用独立边界样例，不仅检查模型自己写的测试。

每条原稿在模型响应完成时记录；最终稿来自 SDK 实际发出的 `message_end`。盲审只收到可见对话和当前草稿；查证才可读真实工具记录；查证结果不会进入下一轮盲审。公开记录不包含私有思考、认证值或本机绝对路径。

完整脚本、任务规则、限制和运行命令见 [完整任务说明](../examples/humanize/full-task/README.md)。本批是有限样本的行为观察，不是模型排名或总体可读性评分。即使所有语句都原样通过，也保留这个结果；不为制造改善而强行改写。

## 多次尝试与文字数量

同一模型的每次尝试分别保存，页面默认选择该模型最新尝试，也可查看此前的中断或失败。汇总表逐次列出，不用成功重跑覆盖旧结果。分享链接包含模型、`runId`、轮次和消息 ID，确保原稿与最终稿来自同一执行。旧版仅含模型和消息 ID 的链接优先定位最早包含该消息的尝试，保留已分享的旧对照。

每轮显示主模型原始响应数、含文字响应数、纯工具响应数和实际工具调用数。一个响应可以请求多个工具；没有文字的工具响应不会制造“回复对比”。Gemini 首次尝试的两轮分别只有一条文字，但有 22 次和 7 次主模型响应，轨迹没有缺失。

“本次运行参数”展示实际时限、调用上限、上游推理强度及与前次尝试的差异。旧记录没有推理字段时显示“未记录”；未指定上游强度和显式 `low` 分别显示，不能把未指定解释成模型没有推理。扩大时间预算或指定不同推理强度的尝试不能混成统一通过率。失败消息仍只展示原稿、审核过程与停止原因；没有批准时最终稿为空。

## 历史合成背景数据说明

数据分为两种：

- 固定草稿：所有模型面对同一组用户输入、合成执行记录和原始回复，用于比较独立读者的行为。
- 模型生成：模型先根据用户输入及合成执行记录生成原始回复，再把这条原文送入实际审阅引擎。两侧展示的仍是同一条原文的关闭与开启结果。

执行记录描述的任务没有真实执行。模型的主回复、审阅、查证和改写是真实 API 调用。每轮盲审只得到可见对话与当前草稿，执行记录只在查证阶段提供；私有思考和认证数据不会写入公开数据。

每个模型和任务组合只做一次有限轮数的尝试；错误与不可用结果一起保存。这些轨迹可以揭示具体失败方式，不能当作稳定的模型排名或事实正确率。耗时包含当时的网络、代理和服务负载，token 用量来自接口；零占位 cost 不代表免费。

模型目录中的向量模型会显示为排除项。它们不能生成对话回复，不计入聊天模型覆盖率，也不生成审阅任务。

本批的 150 次尝试全部结束，但“执行完尝试”不等于“拿到有效对照”。120 组固定草稿均已尝试；30 次生成只有上线任务的 10 次获得草稿，数据分析任务的 15 次生成全部因连接错误失败。生成失败显示“未进入审阅”，不冒充可读性失败。详见[中文实测汇总](../examples/humanize/benchmark-summary.md)。

请求超时配置为 45 秒，但本批有 3 次生成在连接异常下实际持续约 505 秒才结束。因此该参数不是已验证的严格墙钟上限，耗时以每条轨迹记录为准。

重新运行测试（需本地代理与源码依赖已准备好）：

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  scripts/humanize-benchmark.ts
```

脚本默认使用 `http://127.0.0.1:4142/v1` 的本地 Copilot 代理。可通过 `HUMANIZE_BENCHMARK_BASE_URL`、`HUMANIZE_BENCHMARK_API_KEY`、`HUMANIZE_BENCHMARK_OUTPUT` 环境变量配置代理和输出位置；认证值不要提交到仓库。

默认输出文件已存在时，脚本保留已完成组合；上次中断的组合保留为失败，不自动重试。夹具或模型目录改变时会拒绝混用旧数据，应使用新的输出路径建立另一批测试。每批数据保留其时间、来源和失败记录。

## 发布前检查

```bash
node --test scripts/check-humanize-benchmark.test.mjs scripts/check-humanize-full-task.test.mjs \
  scripts/humanize-full-task-limits.test.mjs scripts/humanize-full-task-model-options.test.mjs \
  scripts/check-humanize-full-task-ui.test.mjs
node scripts/check-humanize-benchmark.mjs site/data/benchmark.json
node scripts/check-humanize-full-task.mjs site/data/full-task.json
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  --test scripts/replay-humanize-message.test.mjs
```

检查包括模型与任务组合覆盖、重复记录、固定草稿一致性、原始响应与解析结果一致性、盲审输入隔离、最终批准与展示文本一致性。失败和模型不可用算已尝试的组合，不算批准。检查不评价答案的事实正确性。

采集中可加 `--allow-partial` 检查已有记录；正在运行的记录不计入成功或失败。公开发布不允许这个参数：历史数据的 `methodology.complete`、真实任务数据的 `complete` 必须为 `true`，声明的模型尝试必须全部结束。提前停止会明确保留，后续未开始的轮次不能算已完成。

## 首次启用 Pages

仓库管理员在 [Settings → Pages](https://github.com/hzeroyuke/human_harness/settings/pages) 中把 **Build and deployment → Source** 设为 **GitHub Actions**。如果 `github-pages` 环境限制了可部署分支，还需允许 `feat/trajectory-explorer`。

随后推送该分支中的网站或发布工作流变更。`Trajectory Pages` 工作流先运行上述检查，再上传 `site/` 并部署。它只使用读取代码、写 Pages 与部署身份权限，不安装整个 Pi 仓库的依赖，也不在 CI 中调用模型。

若首次推送时 Pages 尚未启用，启用后在 [Actions](https://github.com/hzeroyuke/human_harness/actions) 里重跑失败的 `Trajectory Pages` 工作流。`workflow_dispatch` 也已声明；GitHub 的手动触发入口要求该工作流同时存在于默认分支，因此仅保存在功能分支时优先使用推送触发或重跑已有运行。

正常部署地址为 [hzeroyuke.github.io/human_harness](https://hzeroyuke.github.io/human_harness/)。只有部署任务成功且页面实际可访问时，才算发布完成。

GitHub 官方 `configure-pages` 明确要求首次自动启用使用不同于 `GITHUB_TOKEN` 的管理员令牌；这里使用设置页完成启用，不把令牌写入工作流。[官方配置参数](https://github.com/actions/configure-pages/blob/983d7736d9b0ae728b81ab479565c72886d7745b/action.yml)、[Pages 自定义工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

仅推送 `gh-pages` 分支不能替代首次启用。若以后改用分支发布，需要管理员在同一设置页选择 **Deploy from a branch → gh-pages → /(root)**；本仓库当前的方案是 GitHub Actions。
