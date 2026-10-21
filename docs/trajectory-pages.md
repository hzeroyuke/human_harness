# 可视化轨迹与 GitHub Pages

可视化分支为 `feat/trajectory-explorer`。网页文件位于 `site/`，使用相对路径读取 `site/data/benchmark.json`，不依赖服务器、打包工具或外部字体。

页面比较的是同一条原始回复：关闭时直接显示原文，开启时显示经过 Humanize 审阅的版本。失败时不会把未通过的草稿冒充为改写结果。

## 本地查看

已有本仓库的 clone 时，先切到可视化分支，再在仓库根目录启动静态服务器：

```bash
git switch feat/trajectory-explorer
python3 -m http.server 4173 --directory site
```

访问 [本地页面](http://localhost:4173)。通过 HTTP 打开页面，浏览器才能读取 JSON；直接双击 HTML 文件可能受到浏览器本地文件限制。

## 测试数据说明

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
node --test scripts/check-humanize-benchmark.test.mjs
node scripts/check-humanize-benchmark.mjs site/data/benchmark.json
```

检查包括模型与任务组合覆盖、重复记录、固定草稿一致性、原始响应与解析结果一致性、盲审输入隔离、最终批准与展示文本一致性。失败和模型不可用算已尝试的组合，不算批准。检查不评价答案的事实正确性。

采集中可加 `--allow-partial` 检查已有记录；`state: "running"` 的记录单独计为待完成，不计入成功或失败。公开发布不允许这个参数，必须有全部预期组合、全部记录结束，并把 `methodology.complete` 标记为 `true`。

## 首次启用 Pages

仓库管理员在 [Settings → Pages](https://github.com/hzeroyuke/human_harness/settings/pages) 中把 **Build and deployment → Source** 设为 **GitHub Actions**。如果 `github-pages` 环境限制了可部署分支，还需允许 `feat/trajectory-explorer`。

随后推送该分支中的网站或发布工作流变更。`Trajectory Pages` 工作流先运行上述检查，再上传 `site/` 并部署。它只使用读取代码、写 Pages 与部署身份权限，不安装整个 Pi 仓库的依赖，也不在 CI 中调用模型。

若首次推送时 Pages 尚未启用，启用后在 [Actions](https://github.com/hzeroyuke/human_harness/actions) 里重跑失败的 `Trajectory Pages` 工作流。`workflow_dispatch` 也已声明；GitHub 的手动触发入口要求该工作流同时存在于默认分支，因此仅保存在功能分支时优先使用推送触发或重跑已有运行。

正常部署地址为 [hzeroyuke.github.io/human_harness](https://hzeroyuke.github.io/human_harness/)。只有部署任务成功且页面实际可访问时，才算发布完成。

GitHub 官方 `configure-pages` 明确要求首次自动启用使用不同于 `GITHUB_TOKEN` 的管理员令牌；这里使用设置页完成启用，不把令牌写入工作流。[官方配置参数](https://github.com/actions/configure-pages/blob/983d7736d9b0ae728b81ab479565c72886d7745b/action.yml)、[Pages 自定义工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

仅推送 `gh-pages` 分支不能替代首次启用。若以后改用分支发布，需要管理员在同一设置页选择 **Deploy from a branch → gh-pages → /(root)**；本仓库当前的方案是 GitHub Actions。
