# Pi Humanize：开启与关闭对照实测

模型：gemini-3.8-flash；协议：openai-completions；通过配置的反代地址调用。

每组使用同一份固定的待发送文本。用户输入和工具记录是测试夹具，未执行其中描述的工作；审阅、查证、改写、复审均调用真实模型。关闭时直接展示该固定文本，开启时通过实际 humanizeMessage 引擎。末尾另含真正 createAgentSession 的端到端调用。

记录中的 token 数来自接口响应；cost 为本地模型配置的零占位值，不能用来推断实际计费。

## 内部代号需要解释

用户输入：

user: 导出任务现在是什么状态？请用日常语言告诉我进展。

执行记录（合成测试夹具）：

```json
[
  {
    "role": "assistant",
    "content": [
      {
        "type": "toolCall",
        "id": "demo-read",
        "name": "read",
        "arguments": {
          "path": "status.json"
        }
      }
    ],
    "api": "openai-completions",
    "provider": "humanize-local-demo",
    "model": "gemini-3.8-flash",
    "stopReason": "toolUse",
    "timestamp": 1792586421758,
    "usage": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    }
  },
  {
    "role": "toolResult",
    "toolCallId": "demo-read",
    "toolName": "read",
    "isError": false,
    "timestamp": 1792586421758,
    "content": [
      {
        "type": "text",
        "text": "蓝桥：失败后自动重试导出任务的流程。收口：已将该流程中所有仍在重试的导出任务处理完毕。玻璃窗：上线后持续观察日志、确认是否出现新增导出失败的阶段。状态：重试中的导出任务已处理完，正在观察后续导出，尚不能保证不会再失败。"
      }
    ]
  }
]
```

关闭 Humanize 后显示：

已完成蓝桥收口，进入玻璃窗阶段。

开启 Humanize 后显示：

之前重试中的导出任务已经全部处理完毕。目前进入了持续观察阶段，正在查看日志以确认是否会出现新的导出失败，暂时还不能保证后续不会再失败。

修订次数：1；辅助调用：4；访问执行记录次数：1。

步骤 1：review（5782ms，stop）

请求：

```json
{
  "phase": "review",
  "visibleMessages": [
    {
      "role": "user",
      "text": "导出任务现在是什么状态？请用日常语言告诉我进展。"
    }
  ],
  "draft": "已完成蓝桥收口，进入玻璃窗阶段。"
}
```

模型实际返回：

````text
```json
{"clear":false,"needsContext":true,"issues":["The draft uses unexplained terms ('蓝桥收口', '玻璃窗阶段') whose meanings cannot be understood in the context of an export task, especially given the user's request for everyday language."]}
```
````

步骤 2：lookup（3649ms，stop）

请求：

```json
{
  "phase": "lookup",
  "issues": [
    "The draft uses unexplained terms ('蓝桥收口', '玻璃窗阶段') whose meanings cannot be understood in the context of an export task, especially given the user's request for everyday language."
  ],
  "execution": [
    {
      "type": "tool_call",
      "name": "read",
      "arguments": {
        "path": "status.json"
      }
    },
    {
      "type": "tool_result",
      "name": "read",
      "isError": false,
      "text": "蓝桥：失败后自动重试导出任务的流程。收口：已将该流程中所有仍在重试的导出任务处理完毕。玻璃窗：上线后持续观察日志、确认是否出现新增导出失败的阶段。状态：重试中的导出任务已处理完，正在观察后续导出，尚不能保证不会再失败。"
    }
  ]
}
```

模型实际返回：

````text
{"facts":["“蓝桥”指导出任务失败后自动重试的流程。","“收口”指已将自动重试流程中所有仍在重试的导出任务处理完毕。","“蓝桥收口”指重试中的导出任务已全部处理完毕。","“玻璃窗阶段”指上线后持续观察日志、确认是否出现新增导出失败的阶段。","当前状态为重试中的任务已处理完，正在观察后续导出情况，尚不能保证不会再失败。"]}
````

步骤 3：rewrite（4802ms，stop）

请求：

```json
{
  "phase": "rewrite",
  "visibleMessages": [
    {
      "role": "user",
      "text": "导出任务现在是什么状态？请用日常语言告诉我进展。"
    }
  ],
  "draft": "已完成蓝桥收口，进入玻璃窗阶段。",
  "issues": [
    "The draft uses unexplained terms ('蓝桥收口', '玻璃窗阶段') whose meanings cannot be understood in the context of an export task, especially given the user's request for everyday language."
  ],
  "evidence": [
    "“蓝桥”指导出任务失败后自动重试的流程。",
    "“收口”指已将自动重试流程中所有仍在重试的导出任务处理完毕。",
    "“蓝桥收口”指重试中的导出任务已全部处理完毕。",
    "“玻璃窗阶段”指上线后持续观察日志、确认是否出现新增导出失败的阶段。",
    "当前状态为重试中的任务已处理完，正在观察后续导出情况，尚不能保证不会再失败。"
  ]
}
```

模型实际返回：

````text
{"text":"之前重试中的导出任务已经全部处理完毕。目前进入了持续观察阶段，正在查看日志以确认是否会出现新的导出失败，暂时还不能保证后续不会再失败。"}
````

步骤 4：review（3685ms，stop）

请求：

```json
{
  "phase": "review",
  "visibleMessages": [
    {
      "role": "user",
      "text": "导出任务现在是什么状态？请用日常语言告诉我进展。"
    }
  ],
  "draft": "之前重试中的导出任务已经全部处理完毕。目前进入了持续观察阶段，正在查看日志以确认是否会出现新的导出失败，暂时还不能保证后续不会再失败。"
}
```

模型实际返回：

````text
{"clear":true,"needsContext":false,"issues":[]}
````

## 指代不明需要补全

用户输入：

user: 我现在能用新版本了吗？还有什么没完成，请说清楚。

执行记录（合成测试夹具）：

```json
[
  {
    "role": "assistant",
    "content": [
      {
        "type": "toolCall",
        "id": "demo-status",
        "name": "read",
        "arguments": {
          "path": "release-state.json"
        }
      }
    ],
    "api": "openai-completions",
    "provider": "humanize-local-demo",
    "model": "gemini-3.8-flash",
    "stopReason": "toolUse",
    "timestamp": 1792586439686,
    "usage": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    }
  },
  {
    "role": "toolResult",
    "toolCallId": "demo-status",
    "toolName": "read",
    "isError": false,
    "timestamp": 1792586439686,
    "content": [
      {
        "type": "text",
        "text": "本次内部代指：前者=公司员工使用的测试网站；后者=普通用户使用的正式网站；那边=提供登录验证的外部服务；放行=允许普通用户登录新版本。当前状态：测试网站已经切换到新版本。正式网站仍使用旧版本，发布暂停，原因是外部登录验证服务故障。故障恢复后还需检查登录是否正常，检查通过才发布新版本；目前不能让普通用户使用新版本。"
      }
    ]
  }
]
```

关闭 Humanize 后显示：

前者已切换，后者仍挂起；等那边恢复后再放行。

开启 Humanize 后显示：

目前普通用户还不能使用新版本。公司员工使用的测试网站已切换到新版本，但普通用户使用的正式网站仍使用旧版本，且发布已暂停。目前未完成的事项包括：需等待提供登录验证的外部服务故障恢复，恢复后还需检查登录是否正常，检查通过后才会发布正式网站的新版本。

修订次数：1；辅助调用：4；访问执行记录次数：1。

步骤 1：review（4480ms，stop）

请求：

```json
{
  "phase": "review",
  "visibleMessages": [
    {
      "role": "user",
      "text": "我现在能用新版本了吗？还有什么没完成，请说清楚。"
    }
  ],
  "draft": "前者已切换，后者仍挂起；等那边恢复后再放行。"
}
```

模型实际返回：

````text
```json
{"clear":false,"needsContext":true,"issues":["“前者”和“后者”具体指代什么不明，无法直接回答用户是否能使用新版本及哪些事项未完成。","“那边”指代不明，未说明具体依赖哪个系统、服务或团队的恢复。"]}
```
````

步骤 2：lookup（14359ms，stop）

请求：

```json
{
  "phase": "lookup",
  "issues": [
    "“前者”和“后者”具体指代什么不明，无法直接回答用户是否能使用新版本及哪些事项未完成。",
    "“那边”指代不明，未说明具体依赖哪个系统、服务或团队的恢复。"
  ],
  "execution": [
    {
      "type": "tool_call",
      "name": "read",
      "arguments": {
        "path": "release-state.json"
      }
    },
    {
      "type": "tool_result",
      "name": "read",
      "isError": false,
      "text": "本次内部代指：前者=公司员工使用的测试网站；后者=普通用户使用的正式网站；那边=提供登录验证的外部服务；放行=允许普通用户登录新版本。当前状态：测试网站已经切换到新版本。正式网站仍使用旧版本，发布暂停，原因是外部登录验证服务故障。故障恢复后还需检查登录是否正常，检查通过才发布新版本；目前不能让普通用户使用新版本。"
    }
  ]
}
```

模型实际返回：

````text
```json
{
  "facts": [
    "“前者”指公司员工使用的测试网站。",
    "“后者”指普通用户使用的正式网站。",
    "“那边”指提供登录验证的外部服务。",
    "测试网站已切换到新版本，正式网站仍使用旧版本且发布已暂停，普通用户目前不能使用新版本。",
    "未完成事项包括等待外部登录验证服务故障恢复，并在恢复后检查登录是否正常，检查通过后才会发布新版本。"
  ]
}
```
````

步骤 3：rewrite（9076ms，stop）

请求：

```json
{
  "phase": "rewrite",
  "visibleMessages": [
    {
      "role": "user",
      "text": "我现在能用新版本了吗？还有什么没完成，请说清楚。"
    }
  ],
  "draft": "前者已切换，后者仍挂起；等那边恢复后再放行。",
  "issues": [
    "“前者”和“后者”具体指代什么不明，无法直接回答用户是否能使用新版本及哪些事项未完成。",
    "“那边”指代不明，未说明具体依赖哪个系统、服务或团队的恢复。"
  ],
  "evidence": [
    "“前者”指公司员工使用的测试网站。",
    "“后者”指普通用户使用的正式网站。",
    "“那边”指提供登录验证的外部服务。",
    "测试网站已切换到新版本，正式网站仍使用旧版本且发布已暂停，普通用户目前不能使用新版本。",
    "未完成事项包括等待外部登录验证服务故障恢复，并在恢复后检查登录是否正常，检查通过后才会发布新版本。"
  ]
}
```

模型实际返回：

````text
{"text":"目前普通用户还不能使用新版本。公司员工使用的测试网站已切换到新版本，但普通用户使用的正式网站仍使用旧版本，且发布已暂停。目前未完成的事项包括：需等待提供登录验证的外部服务故障恢复，恢复后还需检查登录是否正常，检查通过后才会发布正式网站的新版本。"}
````

步骤 4：review（8214ms，stop）

请求：

```json
{
  "phase": "review",
  "visibleMessages": [
    {
      "role": "user",
      "text": "我现在能用新版本了吗？还有什么没完成，请说清楚。"
    }
  ],
  "draft": "目前普通用户还不能使用新版本。公司员工使用的测试网站已切换到新版本，但普通用户使用的正式网站仍使用旧版本，且发布已暂停。目前未完成的事项包括：需等待提供登录验证的外部服务故障恢复，恢复后还需检查登录是否正常，检查通过后才会发布正式网站的新版本。"
}
```

模型实际返回：

````text
{"clear":true,"needsContext":false,"issues":[]}
````

## 清楚的回复保持原样

用户输入：

user: 请把数据导出到 output.csv，并告诉我是否完成。

执行记录（合成测试夹具）：

```json
[]
```

关闭 Humanize 后显示：

导出任务已经完成，文件保存在 output.csv。

开启 Humanize 后显示：

导出任务已经完成，文件保存在 output.csv。

修订次数：0；辅助调用：1；访问执行记录次数：0。

步骤 1：review（3485ms，stop）

请求：

```json
{
  "phase": "review",
  "visibleMessages": [
    {
      "role": "user",
      "text": "请把数据导出到 output.csv，并告诉我是否完成。"
    }
  ],
  "draft": "导出任务已经完成，文件保存在 output.csv。"
}
```

模型实际返回：

````text
```json
{"clear":true,"needsContext":false,"issues":[]}
```
````

## 实际 SDK 端到端验证

用户输入：用一句日常中文解释什么是缓存。

最终输出：

缓存就像是把常用的东西随手放在手边，下次用时直接拿，不用每次都大费周章地跑去仓库翻找。

持久化审阅报告：

```json
[
  {
    "type": "custom",
    "customType": "humanize",
    "data": {
      "status": "approved",
      "revisions": 0,
      "calls": 1,
      "lookedUpContext": false,
      "usage": {
        "input": 328,
        "output": 13,
        "cacheRead": 0,
        "cacheWrite": 0,
        "reasoning": 0,
        "totalTokens": 341,
        "cost": {
          "input": 0,
          "output": 0,
          "cacheRead": 0,
          "cacheWrite": 0,
          "total": 0
        }
      }
    },
    "id": "ffd254e7",
    "parentId": "c245f2e4",
    "timestamp": "2026-10-21T12:41:36.907Z"
  }
]
```
