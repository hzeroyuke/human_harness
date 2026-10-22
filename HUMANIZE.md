# Pi Humanize

给 Pi 增加一个独立的读者 Agent：每次主 Agent 要发出文字，先检查只看用户可见对话的人能否读懂，再决定是否需要补充解释。

这是基于 [Pi](https://github.com/earendil-works/pi) 的源码开发分支，保留上游历史与 MIT 许可。正常 CLI、SDK、JSON、RPC 均通过同一输出入口。

## 启动

需要 Node.js 22.19 或更新版本。

```bash
git clone git@github.com:hzeroyuke/human_harness.git
cd human_harness
npm ci --ignore-scripts
npm run hydrate:model-data
./pi-humanize.sh
```

`hydrate:model-data` 下载上游运行需要的模型目录。这个启动脚本默认开启审阅。Pi 的模型与登录配置沿用原有配置；也可以使用 `/login` 配置模型。审阅默认使用当前主模型，但每次都是独立请求，没有共享的对话历史。

从另一个项目启动时，保持当前工作目录即可：

```bash
cd /path/to/your-project
/path/to/human_harness/pi-humanize.sh
```

单次关闭：`PI_HUMANIZE=0 ./pi-humanize.sh`。原来的 `./pi-test.sh` 与 SDK 默认保持普通 Pi 行为；也可通过设置开启。

## 一个例子

用户：现在处理到哪了？

主 Agent 草稿：已完成蓝桥收敛，进入 R2。

读者：蓝桥和 R2 是什么？用户从未看到这些定义。

查询工具执行记录后，修改为：已修复登录页刷新后丢失登录状态的问题。接下来会检查退出登录和重新登录是否正常。

新的读者只看用户问题和这段新回复；读得懂才发给用户。例子仅说明流程，实际改写取决于执行记录与所选模型。

## 工作流程

1. 暂存完整回复，不把未审阅的流式文字发给界面。
2. 新建读者上下文，只包含当前分支的用户文字、之前显示的助手文字和本次草稿。
3. 读者返回具体的理解问题；本来清楚的回复原样通过。
4. 只有需要核实背景时，独立查询调用才读取工具调用和工具结果。系统提示、思考文本和隐藏的扩展消息不会进入查询。
5. 独立编辑调用根据问题和查到的事实改写。纯表达问题可直接改写，无需读取执行过程。
6. 再启动一个完全不知内部过程的读者检查新版本。最多改写 2 轮，默认总审阅时限 90 秒。
7. 通过后，统一输出并保存改写版本。工具名、工具参数、调用 ID、思考块保持原样。

查询与改写都没有执行工具的权限。每轮读者都没有看过查询结果，避免“自己已经知道背景，所以以为用户也读得懂”。

## 配置

在 Pi 的 `settings.json` 或项目 `.pi/settings.json` 中配置：

```json
{
  "humanize": {
    "enabled": true,
    "maxRevisions": 2,
    "timeoutMs": 90000,
    "maxContextChars": 48000
  }
}
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 普通 Pi 入口是否开启；Humanize 启动脚本默认开启 |
| `record` | `false` | 可选本地逐条记录，用于原稿配对、个人反馈和重放 |
| `maxRevisions` | `2` | 最多改写次数，范围 0–5；0 表示只检查 |
| `timeoutMs` | `90000` | 单条消息审阅的总时限，范围 1–300000 毫秒 |
| `maxContextChars` | `48000` | 每阶段输入的文字预算，范围 256–200000 字符；较早的对话可能被截断 |
| `provider` | 主模型的 provider | 可选的审阅模型提供方 |
| `model` | 主模型 ID | 可选的审阅模型 ID |

`PI_HUMANIZE=1` 强制开启，`PI_HUMANIZE=0` 强制关闭，优先于配置。模型可单独选择，例如 `"provider": "my-provider", "model": "reader-model-id"`，需要先在 Pi 中配置好该模型。

SDK 使用 `SettingsManager.inMemory({ humanize: { enabled: true } })`，传给 `createAgentSession` 的 `settingsManager`。

## Copilot 本地代理

可在独立的 agent 配置目录放置 `models.json`，不需要提交凭据。例如代理提供 `/v1/chat/completions` 时：

```json
{
  "providers": {
    "copilot-proxy": {
      "baseUrl": "http://127.0.0.1:4142/v1",
      "api": "openai-completions",
      "apiKey": "local-proxy",
      "models": [{
        "id": "gemini-3.8-flash",
        "name": "Copilot proxy",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 8192,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
      }]
    }
  }
}
```

模型 ID 以本机代理实际返回的列表为准。随后运行：

```bash
PI_CODING_AGENT_DIR=/path/to/proxy-config ./pi-humanize.sh \
  --provider copilot-proxy --model gemini-3.8-flash
```

## 行为与限制

- 开启后，每条有文字的助手消息至少多一次模型调用；需要查背景和改写时会更多。文字会在审阅后整段显示，因此首字等待时间更长。
- 覆盖主模型的最终回复和工具调用前的说明文字。纯工具调用无需可读性审阅。工具结果、扩展自定义 UI 消息、扩展在 `message_end` 之后替换的文字不属于此入口。
- 盲审只检查文字；图片附件不传给审阅模型。较长历史按字符预算截取，可能增加补充解释。执行查询使用已记录的工具过程，不读取模型的私有思考链。
- 原有 provider 原始流事件回调在审阅开启时暂停，避免调试扩展提前显示草稿。标准会话事件仍正常输出。
- 超时、取消、无效 JSON、改写超过次数、技术字面量被改动时，停止本次回复并显示错误；不会悄悄放行未审阅草稿，也不会执行被拦住回复中的工具。上游 API 错误诊断仍保留。
- 提示词要求保留事实、完成状态、不确定性、语言及格式；代码、URL、路径与数字还会做字面量检查。模型判断仍可能出错，这不是事实正确性的保证。
- 审阅 token 用量单独写入会话 `usage` 记录，`humanize` 自定义记录保存轮数、是否查过背景和通过状态。默认不保存原稿与审阅详情；开启 `record` 后，额外的 `humanize_trace` 记录保存逐条配对与阶段信息，`humanize_feedback` 保存个人评价。这些附加记录不进入主模型上下文。详见 [个人反馈指南](docs/personal-feedback.md)。
- 原文直接通过时，所有文字块和签名都保持不变。改写支持保留 OpenAI Responses 的同一消息阶段元数据；如果一条回复混有多个阶段，或其他 provider 的文字块带有不透明签名（例如 Gemini 的续聊标记），则停止改写并返回错误，避免破坏下一轮对话。工具及思考块的签名不变。

## 验证

```bash
npm run check
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/humanize.test.ts test/humanize-stream.test.ts \
  test/suite/agent-session-humanize.test.ts
```

测试覆盖：盲审上下文隔离、按需查证、多轮修改、原文不提前显示、工具参数完整、会话持久化、取消与超时、错误阻断、内部压缩请求不被审阅、关闭时保持原流程。
