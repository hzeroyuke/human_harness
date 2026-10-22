# 真实开发任务实测：每条原稿与最终稿一一对应

本批包含 **6 个模型、9 次真实尝试**。在最初四模型记录上，增加 GPT-6 Astra、GPT-5.6 Sol，并补跑 Grok 与 MAI，另加入一次显式 low 推理强度的 Grok 对照。每次都从同一份有错误的网店对账项目开始，读取代码、修改文件、运行测试、生成报表，再尝试继续第二轮财务补单需求。业务数据为合成夹具，执行过程与回复是真实模型运行；旧失败不会被新尝试覆盖。

共开始 16 轮任务，记录 318 次工具操作、34 条经过 Humanize 的文字消息：7 条改写后放行、23 条原样放行、4 条被拦截。另外有 2 次主模型响应未完成，未计入审核失败。左侧原稿来自该次执行的同一条模型响应；右侧只展示 SDK 实际放行的对应文字。失败候选稿不能作为最终稿。

[打开完整轨迹](https://hzeroyuke.github.io/human_harness/) · [全部原始记录](../../../site/data/full-task.json) · [运行方法与验收口径](README.md)

## 各次尝试分别保留

| 模型 / 尝试 | 审核总时限 | 第 1 轮业务 | 第 2 轮业务 | 改写放行 | 原样放行 | 审核拦截 | 主模型未完成 | 执行状态 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| [gemini-3.8-flash · 第 1 次](https://hzeroyuke.github.io/human_harness/?model=gemini-3.8-flash&runId=gemini-3.8-flash-complete-v1&round=1#comparison) | 120 秒 | 19/19 | 24/24 | 0 | 2 | 0 | 0 | 两轮执行结束 |
| [gpt-6.1-sol · 第 1 次](https://hzeroyuke.github.io/human_harness/?model=gpt-6.1-sol&runId=gpt-6.1-sol-complete-v1&round=1#comparison) | 120 秒 | 19/19 | 24/24 | 3 | 4 | 0 | 0 | 两轮执行结束 |
| [mai-code-1.1-flash · 第 1 次](https://hzeroyuke.github.io/human_harness/?model=mai-code-1.1-flash&runId=mai-code-1.1-flash-complete-v1&round=1#comparison) | 120 秒 | 19/19 | 未开始 | 0 | 0 | 1 | 0 | 提前停止 |
| [mai-code-1.1-flash · 第 2 次](https://hzeroyuke.github.io/human_harness/?model=mai-code-1.1-flash&runId=mai-code-1.1-flash-extended-v1&round=1#comparison) | 300 秒 | 19/19 | 24/24 | 1 | 0 | 1 | 1 | 提前停止 |
| [grok-4.7 · 第 1 次](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-complete-v1&round=1#comparison) | 120 秒 | 5/19 | 未开始 | 0 | 2 | 1 | 0 | 提前停止 |
| [grok-4.7 · 第 2 次](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-extended-v1&round=1#comparison) | 300 秒 | 19/19 | 24/24 | 0 | 6 | 0 | 1 | 提前停止 |
| [grok-4.7 · 第 3 次](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-low-v1&round=1#comparison) | 300 秒 | 19/19 | 24/24 | 0 | 4 | 1 | 0 | 提前停止 |
| [gpt-6-astra · 第 1 次](https://hzeroyuke.github.io/human_harness/?model=gpt-6-astra&runId=gpt-6-astra-extended-v1&round=1#comparison) | 300 秒 | 19/19 | 24/24 | 1 | 5 | 0 | 0 | 两轮执行结束 |
| [gpt-5.6-sol · 第 1 次](https://hzeroyuke.github.io/human_harness/?model=gpt-5.6-sol&runId=gpt-5.6-sol-extended-v1&round=1#comparison) | 300 秒 | 19/19 | 24/24 | 2 | 0 | 0 | 0 | 两轮执行结束 |

第一次四模型尝试采用默认配置；后续尝试采用更长的运行预算：单条审核总时限由 120 秒提高到 300 秒，单请求超时参数由 90 秒提高到 180 秒，每轮执行上限由 12 分钟提高到 30 分钟，主模型调用上限由 45 提高到 60；最多改写仍是两次。任务、种子、核心审阅源码和主 Agent 提示不变，参数与源码哈希逐次记录。这些尝试不能合并成同条件通过率，也不能仅凭一次重跑归因于延长时限。

验收器放在模型可修改的项目之外。第 1 轮有 19 项，第 2 轮有 24 项，覆盖日期、金额精度、通知过滤、重复与冲突、退款、迟到数据、手续费和实际交付文件；项目自己写的测试只占其中一项。验收通过、回复获准发送和人是否觉得更好读，分别判断。

## 这次补测的结果

- [gpt-6-astra](https://hzeroyuke.github.io/human_harness/?model=gpt-6-astra&runId=gpt-6-astra-extended-v1&round=1#comparison)：两轮执行结束；第一轮 19/19，第二轮 24/24。
- [gpt-5.6-sol](https://hzeroyuke.github.io/human_harness/?model=gpt-5.6-sol&runId=gpt-5.6-sol-extended-v1&round=1#comparison)：两轮执行结束；第一轮 19/19，第二轮 24/24。
- [grok-4.7](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-extended-v1&round=1#comparison)：提前停止；第一轮 19/19，第二轮 24/24。
- [mai-code-1.1-flash](https://hzeroyuke.github.io/human_harness/?model=mai-code-1.1-flash&runId=mai-code-1.1-flash-extended-v1&round=1#comparison)：提前停止；第一轮 19/19，第二轮 24/24。
- Grok 较低推理强度对照 [grok-4.7](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-low-v1&round=1#comparison)：提前停止；第一轮 19/19，第二轮 24/24。

### Gemini 并没有少跑

最初 Gemini 两轮共 29 次主模型响应，其中 27 次只有工具调用，只有两轮结尾各一条文字。第一轮为 **22 次响应 / 21 次纯工具响应 / 28 次工具操作**，第二轮为 **7 / 6 / 6**；两条文字都有同 ID 的独立审阅和最终输出，均原样放行。页面逐轮展示，所以每轮只有一条回复对照是实际行为，不是轨迹丢失。新版界面显示这些计数，并提供全部原始响应入口。

### Grok 三次尝试分别停在哪里

首次失败消息的三段审核分别为 51.480 秒、63.949 秒和 4.576 秒，合计 **120.005 秒**，与当时单条审核总时限 120 秒精确吻合。最后复审为 aborted，没有批准结论。原记录未保留内部超时标志，因此这是结合时限与阶段耗时得到的解释，不能说已经独立证实模型服务故障。此前尚未执行的修改代码工具随该条消息一起被拦截，业务结果停在 5/19。

新的 Grok 尝试使用上表记录的较长预算，结果单独保存。[查看新尝试](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-extended-v1&round=1#comparison)；[查看原中断消息](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-complete-v1&round=1&message=r1-message-6#comparison)。

第二次 Grok 两轮业务检查均通过，但第二轮最后的主模型响应以「length」结束，只留下 23 字符的半句：“补单已按北京时间 2026-10-20 的实际”。这条原始响应没有进入 Humanize 审阅，也没有发给用户。应归为主模型生成被截断，不能算作表达不清或审核失败。原始通用错误仍保留，网页另行展示响应结束状态。第一次的审核中止与第二次的生成截断不是同一个问题。

第二次第一轮还有一次主模型请求实际持续 **458.585 秒**，超过当时传入的 180 秒请求超时参数。第三次明确指定「reasoning.effort=low」，该条件同时用于主模型和全部审阅调用，其他时间限额保持与第二次一致。第二次未向上游指定推理强度；不能断言它使用了高强度，也不能仅凭单次结果把耗时差异全部归因于推理配置。

第三次同样通过 19/19、24/24，第一轮最终回复正常发送，第二轮最后一条仍被拦截。其四次审阅/改写响应均正常结束，总计 **130.562 秒**，未耗尽 300 秒审核预算。这次独立读者要求回复列出每笔新增付款的通知编号，并在没有查证的情况下，把缺少编号的说明改成“不能确认已正确入账”，使本来正确的金额结论带上无依据的疑虑。两次候选稿又从原文 864 字符扩到 1136、1395 字符。最后一稿删除了原文中的 **23:59:59**，没有通过内容保护；最终版本没有发送。相同核心源码已离线重放全部四次保存响应，并核对请求和报告，确认触发点在第二次改写的保护检查；详见 [独立诊断文件](diagnostics/grok-low-protection.json)。[查看 Grok low 最后这条消息](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-low-v1&round=2&message=r2-message-7#comparison)。这说明降低推理强度没有解决本次审核边界和改写保真问题。

### MAI 为什么业务做完仍没有最终回复

补测第一轮 19/19，第二轮 24/24；第二轮最后的改写删掉了说明冲突通知所需的旧金额 **150.00 元**，触发数字保护。相同核心源码离线重放了盲审、查证、改写三次保存响应，并逐字核对查证执行记录和报告，确认这个原因。最终稿为空，不能拿候选改写冒充实际发送稿。[查看 MAI 被拦截消息](https://hzeroyuke.github.io/human_harness/?model=mai-code-1.1-flash&runId=mai-code-1.1-flash-extended-v1&round=2&message=r2-message-12#comparison)，补充诊断保存在 [独立诊断文件](diagnostics/mai-extended-protection.json)。

MAI 此前还有一次「length」截断的工具请求，SDK 拒绝执行不完整参数，随后模型继续完成开发。这个主模型错误与最终金额保护拦截分别计数。

## 新模型也暴露了过度解释

Astra 首轮的过程说明提到“项目第一轮口径”和“后续补单”，独立读者据此查阅项目文件，并经历两次改写、三次盲审。最终从 **101 字符增长到 771 字符**，补出了背景，也加入大量规则和未来需求的说明。[查看 Astra 原稿与实际发送稿](https://hzeroyuke.github.io/human_harness/?model=gpt-6-astra&runId=gpt-6-astra-extended-v1&round=1&message=r1-message-3#comparison)。获准发送并不意味着这段长解释更适合用户。

5.6 Sol 首轮的“外部业务验收”被要求说明具体含义，最终补成自动化验收程序及全部 19 项检查明细，回复从 **898 字符增长到 1876 字符**。[查看 5.6 Sol 对照](https://hzeroyuke.github.io/human_harness/?model=gpt-5.6-sol&runId=gpt-5.6-sol-extended-v1&round=1&message=r1-message-11#comparison)。澄清自动化与人工验收的区别有用，但把完整清单放进正文是否合适，仍需人判断；这里不把所有改写统称为改善。

## 例一：补上用户没见过的文件背景

GPT 第一轮第 1 条可见消息，内部对应 ID 为 r1-message-3。[打开逐条对照](https://hzeroyuke.github.io/human_harness/?model=gpt-6.1-sol&runId=gpt-6.1-sol-complete-v1&round=1&message=r1-message-3#comparison)。

原稿：

> 我会先运行旧脚本复现错误，再按项目口径修复并补测试。这次使用 `data/events.json`，不混入第二轮补单文件；报表会把未收齐款、已退款和人工核查记录分开列出。

实际发送稿：

> 我会先运行旧脚本复现错误，再按项目说明修复并补充、运行回归测试。本次先使用你指定的 `data/orders.json` 和 `data/events.json`；README 将 `data/events-update.json` 列为财务下一轮补来的通知文件，是否需要纳入本次尚未确认，暂不混入。报表会把未收齐款、已退款和人工核查记录分开列出。

独立读者指出“第二轮补单文件”没有出现在用户可见的对话里。随后查阅工具记录，确认它来自 README，再补上文件名与背景，最后用新的盲审上下文批准。这是可直接观察的补充解释，不依赖用另一次随机回答作参照。

## 例二：原本清楚的回复不必强行改写

Gemini 的两轮最终回复均原样通过。[第一轮](https://hzeroyuke.github.io/human_harness/?model=gemini-3.8-flash&runId=gemini-3.8-flash-complete-v1&round=1&message=r1-message-22#comparison)和[第二轮](https://hzeroyuke.github.io/human_harness/?model=gemini-3.8-flash&runId=gemini-3.8-flash-complete-v1&round=2&message=r2-message-7#comparison)的左右原文完全相同，每条增加一次独立审阅。保留这类结果是为了观察功能实际做了什么，不能把每次改写都当成改善。

## 例三：程序完成，改写稿仍可能被拦截

MAI 第一轮业务验收通过 19/19，但最后回复的改写稿删去了 430.20、20.00、410.20 等 13 种金额。内容保护拒绝了该候选稿，没有最终发送文字，第二轮没有开始。[查看原稿、候选改写与具体诊断](https://hzeroyuke.github.io/human_harness/?model=mai-code-1.1-flash&runId=mai-code-1.1-flash-complete-v1&round=1&message=r1-message-16#comparison)。

原始轨迹只返回了通用错误。页面中的具体原因来自同一源码和已保存响应的离线重放，核对了全部提示、请求和报告；它被单独标为“本地复现诊断”，未替换原始错误。复现方法见 [README](README.md#离线复现被拦截消息)。

## 例四：复审调用中止，不代表读者否决了改写稿

Grok 的前两条消息原样通过。第 3 条消息已产生改写稿，但随后的复审调用以 aborted 结束，返回流没有正常结束，也没有得到批准决定，因此没有发出该条回复。当时仅运行了旧程序并生成报表，业务验收为 5/19，后续修改代码的工具调用没有执行，第二轮未开始。[查看完整停止位置](https://hzeroyuke.github.io/human_harness/?model=grok-4.7&runId=grok-4.7-complete-v1&round=1&message=r1-message-6#comparison)。这条记录应读作“复审调用中止”，不能解释成“改写之后仍然看不懂”。


## 已观察到的局限

- MAI 补测第二轮将原来的第一轮测试改成新数据与手续费参数，未按需求保留旧场景再增加新场景。外部验收另有第一轮回归检查且通过，但 24/24 不代表所有交付要求都完成；项目自己的测试检查只验证可以成功运行。
- MAI 补测第一轮把“状态不成功或未满足时间要求”的通知说成单独列出，实际报表对此只有分类计数，这个改写表述仍不够准确。
- 种子项目已包含第二轮渠道说明和补单文件，模型可以提前读取；Grok 第二次尝试第一轮就读取并实现了部分第二轮逻辑。因此这是连续两轮开发，不是对完全未知追加需求的盲测。Grok 第二次保留了第一轮 10 项测试并新增 2 项；Astra 从 14 项增加到 25 项，5.6 Sol 从 3 项增加到 5 项。
- Grok low 第一轮读文件后直接修改实现，没有按用户要求先运行旧程序复现；运行器的初始验收不能代替 Agent 的这一步。它保留了第一轮 4 项测试、第二轮新增 2 项，但第二轮中文说明缺少新旧差额解释，包含差额的最后回复又未发送，因此没有完成全部交接要求。
- 审核会发现用户没见过的定义，但也可能要求过多细节，显著增加回复长度。当前没有独立的人类偏好评分，无法证明每条改写更好。
- GPT-6.1 Sol 第一轮曾把一句“下面把……列清楚”扩成长交付说明；第二轮也曾在没有查证的情况下增加“现有结果未明确”的保留语。两种局限都完整保留在逐条轨迹中。
- 同一模型同时担任主 Agent 和独立读者，靠分离上下文保证初审不看工具记录；不是不同模型之间的交叉评审。
- 请求超时参数不是已验证的严格墙钟上限。旧 Grok 两次主调用为 121.597 秒、252.221 秒，超过当时的 90 秒配置；新尝试也保留实际耗时。
- 这里只是一个两轮任务的有限样本，不是总体效果、稳定通过率或模型排名。更早的 150 次合成背景实验完整保留在[历史页](https://hzeroyuke.github.io/human_harness/archive.html)。

数据生成时间：2026-10-22T03:37:21.880Z。每条新分享链接包含模型、运行 ID、轮次和消息 ID，避免不同尝试中相同消息编号被混配。原始失败、候选改写和最终批准均可展开查看。
