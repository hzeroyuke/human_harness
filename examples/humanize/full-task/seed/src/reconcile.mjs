import { toCents } from "./money.mjs";

export function reconcile(orders, events, { date }) {
	const rows = orders
		.filter((order) => order.createdAt.slice(0, 10) === date)
		.map((order) => {
			const paymentCents = events
				.filter((event) => event.orderId === order.id)
				.reduce((sum, event) => sum + toCents(event.amount), 0);
			const amountCents = toCents(order.amount);
			return {
				id: order.id,
				amountCents,
				paymentCents,
				refundCents: 0,
				netCents: paymentCents,
				outstandingCents: Math.max(amountCents - paymentCents, 0),
				overpaidCents: Math.max(paymentCents - amountCents, 0),
				status: paymentCents >= amountCents ? "paid" : "unpaid",
			};
		});
	const totals = { orderCount: rows.length };
	for (const key of ["amountCents", "paymentCents", "refundCents", "netCents", "outstandingCents", "overpaidCents"]) {
		totals[key === "amountCents" ? "orderCents" : key] = rows.reduce((sum, row) => sum + row[key], 0);
	}
	return {
		date,
		timezone: "UTC",
		totals,
		orders: rows,
		ignored: { duplicates: 0, notSucceeded: 0, afterCutoff: 0, outsideOrderDate: 0 },
		issues: [],
	};
}
