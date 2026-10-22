import assert from "node:assert/strict";
import test from "node:test";
import { reconcile } from "../src/reconcile.mjs";

test("one simple payment", () => {
	const report = reconcile(
		[{ id: "demo", amount: "10.00", createdAt: "2026-10-20T01:00:00Z" }],
		[{ eventId: "demo-pay", orderId: "demo", kind: "payment", state: "succeeded", amount: "10.00", occurredAt: "2026-10-20T02:00:00Z" }],
		{ date: "2026-10-20" },
	);
	assert.equal(report.totals.netCents, 1000);
	assert.equal(report.orders[0].status, "paid");
});
