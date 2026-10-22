import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatMoney } from "./money.mjs";
import { reconcile } from "./reconcile.mjs";

const args = process.argv.slice(2);
const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2].slice(2), args[index * 2 + 1]]));
const orders = JSON.parse(readFileSync(options.orders, "utf8"));
const events = JSON.parse(readFileSync(options.events, "utf8"));
const report = reconcile(orders, events, { date: options.date });
mkdirSync(options.out, { recursive: true });
writeFileSync(join(options.out, `${options.date}.json`), `${JSON.stringify(report, null, 2)}\n`);
const csv = ["order_id,amount,payment,refund,net,status,outstanding,overpaid"];
for (const row of report.orders) {
	csv.push([row.id, formatMoney(row.amountCents), formatMoney(row.paymentCents), formatMoney(row.refundCents), formatMoney(row.netCents), row.status, formatMoney(row.outstandingCents), formatMoney(row.overpaidCents)].join(","));
}
writeFileSync(join(options.out, `${options.date}.csv`), `${csv.join("\n")}\n`);
console.log(JSON.stringify({ json: `${options.out}/${options.date}.json`, csv: `${options.out}/${options.date}.csv` }));
