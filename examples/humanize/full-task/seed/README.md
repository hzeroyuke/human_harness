# 网店日结工具

这是一个需要修复的旧脚本，不代表正确实现。不需要安装依赖，使用 Node.js 自带功能。

运行现有测试：`node --test test/*.test.mjs`

生成报表：`node src/cli.mjs --orders data/orders.json --events data/events.json --date 2026-10-20 --out reports`

## 业务口径

- 日期按北京时间（UTC+08:00）。只列出当天创建的订单；通知按 `occurredAt` 计算，晚于当天结束的通知暂不计入。
- 金额输入为非负十进制字符串，最多两位小数；不得把负数、空字符串、科学计数法、`NaN`、多于两位小数当成有效金额。内部以整数分计算。
- 只有 `state: "succeeded"` 的 `payment` / `refund` 通知有效。普通完全重复的 `eventId` 只处理一次。
- 找不到订单的通知列为 `orphan_event`；非法金额列为 `invalid_amount`。这两类都不能计入财务合计。属于其他日期订单的通知不算孤儿。
- `paymentCents` 为成功支付总额，`refundCents` 为成功退款总额，`netCents = paymentCents - refundCents`。
- `outstandingCents = max(amountCents - paymentCents, 0)`，表示原订单还没收齐的钱；退款不能再次记成欠款。`overpaidCents = max(paymentCents - amountCents, 0)`。
- 订单 `status`：有退款为 `refunded`；否则依次按未付款 `unpaid`、部分付款 `partial`、多付款 `overpaid`、收齐 `paid` 分类。它是报表类别，不自动触发催款或退款。
- 输出订单按 ID 排序；数字金额输出为整数分，CSV 金额固定两位小数、单位元。

## 文件与输出约定

订单输入：`[{"id":"...","createdAt":"ISO 时间","amount":"80.00"}]`

通知输入：`[{"eventId":"...","orderId":"...","kind":"payment|refund","state":"succeeded|failed|pending","amount":"30.00","occurredAt":"ISO 时间","receivedAt":"可选，接收时间"}]`

CLI 参数 `--orders`、`--events`、`--date`、`--out` 均为必填。输出目录不存在时需要创建。

JSON `<date>.json`：

```json
{
  "date": "2026-10-20",
  "timezone": "Asia/Shanghai",
  "totals": {
    "orderCount": 0, "orderCents": 0, "paymentCents": 0,
    "refundCents": 0, "netCents": 0, "outstandingCents": 0, "overpaidCents": 0
  },
  "orders": [{
    "id": "...", "amountCents": 0, "paymentCents": 0, "refundCents": 0,
    "netCents": 0, "outstandingCents": 0, "overpaidCents": 0, "status": "unpaid"
  }],
  "ignored": { "duplicates": 0, "notSucceeded": 0, "afterCutoff": 0, "outsideOrderDate": 0 },
  "issues": [{ "eventId": "...", "orderId": "...", "code": "orphan_event|invalid_amount" }]
}
```

忽略计数的判断顺序为：重复通知去重 → 非成功状态 → 日期晚于截止 → 找不到订单 → 订单不属于当天 → 金额验证。完全重复的成功通知也只计入一次重复计数。

CSV `<date>.csv` 首行固定为 `order_id,amount,payment,refund,net,status,outstanding,overpaid`，后续每个订单一行。不要把异常通知伪装成订单。

`summary.md` 是给运营的中文交接说明，须说明合计、需要处理的订单和异常通知，以及已经执行的检查与剩余限制。

## 当前代码

`src/money.mjs` 处理金额，`src/reconcile.mjs` 计算报表，`src/cli.mjs` 读写文件。现有测试只覆盖了最简单的一笔付款，不能说明真实数据正确；请补充回归测试。

`data/events-update.json` 是财务下一轮补来的通知文件，第一轮先使用 `data/events.json`。
