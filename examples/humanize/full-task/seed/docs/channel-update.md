# 财务第二轮补单的接口约定

第一轮先按 README 生成报表；接到第二轮需求时再使用本文约定。

同一个 `eventId` 的多个版本，以 `orderId`、`amount`、`kind`、`state`、`occurredAt` 比较。`receivedAt` 只是接收时间，不参与比较。发现冲突时，在过滤状态和日期之前隔离整个 ID，`issues` 添加一项 `{eventId, orderId, code: "conflicting_duplicate"}`；不要只丢弃后一条，也不要把该组作为普通重复通知计数。无冲突的完全重复仍沿用普通去重规则。

CLI 新参数 `--fee-bps 60` 表示费率为万分之六十，即 0.6%；不传默认为零。手续费只对通过所有验证并最终入账的成功支付计收，逐笔四舍五入到整数分后相加。退款不产生新的手续费，也不退还原手续费。

JSON 的 `totals` 和每个订单增加 `feeCents`、`settlementCents`；`settlementCents = netCents - feeCents`。原有 `netCents` 含义不变，仍为收款减退款，不得静默改成扣手续费后的金额。

CSV 保留原有八列并依次追加 `fee,settlement`，均为固定两位小数的元金额。零费率下可以保留新增列。

人工核查只说明“这组通知有矛盾，需要核对渠道账单”，不能凭脚本替财务决定哪一个版本是真的。补来的 `e20` 是独立通知，不属于 `e05` 冲突组。
