import { deepStrictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(process.argv[2] ?? "");
const round = Number(process.argv[3]);
if (!process.argv[2] || ![1, 2].includes(round) || !existsSync(join(workspace, "src/cli.mjs"))) {
	console.log(JSON.stringify({ passed: false, error: "Usage: node verify.mjs <workspace> <1|2>; workspace must contain src/cli.mjs" }));
	process.exit(2);
}

const fixture = dirname(fileURLToPath(import.meta.url));
const checks = [];
const date = "2026-10-20";
const reports = join(workspace, "reports");
mkdirSync(reports, { recursive: true });
const temporary = mkdtempSync(join(reports, ".acceptance-"));

function check(id, label, actual, expected) {
	let passed = true;
	try { deepStrictEqual(actual, expected); } catch { passed = false; }
	checks.push({ id, label, passed, expected, actual: actual ?? null });
}

function pick(source, keys) {
	return Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));
}

function runCli(name, orders, events, feeBps = 0) {
	const directory = join(temporary, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "orders.json"), JSON.stringify(orders));
	writeFileSync(join(directory, "events.json"), JSON.stringify(events));
	const args = [
		"--permission", `--allow-fs-read=${workspace}`, `--allow-fs-write=${directory}`,
		join(workspace, "src/cli.mjs"), "--orders", join(directory, "orders.json"),
		"--events", join(directory, "events.json"), "--date", date, "--out", join(directory, "output"),
		...(feeBps ? ["--fee-bps", String(feeBps)] : []),
	];
	const processResult = spawnSync(process.execPath, args, {
		cwd: workspace, encoding: "utf8", timeout: 10_000, maxBuffer: 256_000,
		env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TZ: "UTC" },
	});
	let report = null;
	let csv = null;
	let parseError = null;
	try {
		report = JSON.parse(readFileSync(join(directory, "output", `${date}.json`), "utf8"));
		csv = readFileSync(join(directory, "output", `${date}.csv`), "utf8");
	} catch (error) {
		parseError = error instanceof Error ? error.message.replaceAll(workspace, "<workspace>") : "could not read report";
	}
	return { report, csv, exitCode: processResult.status, error: parseError ?? processResult.stderr.slice(-2000) };
}

function byId(report, id) {
	return Array.isArray(report?.orders) ? report.orders.find((order) => order.id === id) : undefined;
}

function event(eventId, orderId, amount, occurredAt = "2026-10-20T02:00:00Z", kind = "payment", extra = {}) {
	return { eventId, orderId, amount, occurredAt, kind, state: "succeeded", ...extra };
}

function expectedTotals(updated) {
	return {
		orderCount: 7, orderCents: 55520, paymentCents: updated ? 55520 : 43020,
		refundCents: updated ? 6990 : 2000, netCents: updated ? 48530 : 41020,
		outstandingCents: updated ? 0 : 15500, overpaidCents: updated ? 0 : 3000,
	};
}

function csvRows(csv) {
	if (typeof csv !== "string") return null;
	const [header, ...lines] = csv.trim().split(/\r?\n/);
	return { header: header.split(","), rows: lines.map((line) => line.split(",")) };
}

try {
	const seedOrders = JSON.parse(readFileSync(join(fixture, "seed/data/orders.json"), "utf8"));
	const seedEvents = JSON.parse(readFileSync(join(fixture, `seed/data/${round === 1 ? "events" : "events-update"}.json`), "utf8"));
	const current = runCli("main", seedOrders, seedEvents, round === 2 ? 60 : 0);
	const report = current.report;
	const totals = expectedTotals(round === 2);
	check("cli", "CLI 真正运行并生成可解析报表", { exitCode: current.exitCode, report: report !== null, csv: current.csv !== null }, { exitCode: 0, report: true, csv: true });
	if (current.error) checks.at(-1).detail = current.error;
	check("date", "报表使用北京时间且包含正确的七笔订单", { ...pick(report, ["date", "timezone"]), ids: report?.orders?.map((order) => order.id) }, { date, timezone: "Asia/Shanghai", ids: ["O1001", "O1002", "O1003", "O1004", "O1005", "O1006", "O1007"] });
	check("totals", "支付、退款、净额、未收款和多付款分别汇总", pick(report?.totals, Object.keys(totals)), totals);
	check("duplicate", "重复通知没有让 O1001 多收一遍", byId(report, "O1001")?.paymentCents, 19990);
	check("partial", round === 1 ? "O1002 只收 30 元，仍需收 50 元" : "迟到的补单补齐 O1002 的 80 元", pick(byId(report, "O1002"), ["paymentCents", "outstandingCents", "status"]), { paymentCents: round === 1 ? 3000 : 8000, outstandingCents: round === 1 ? 5000 : 0, status: round === 1 ? "partial" : "paid" });
	check("refund", "退款单 O1003 不被当成再次欠款", pick(byId(report, "O1003"), ["paymentCents", "refundCents", "netCents", "outstandingCents", "status"]), { paymentCents: 5000, refundCents: 2000, netCents: 3000, outstandingCents: 0, status: "refunded" });
	check("overpayment", round === 1 ? "O1004 多付 30 元，明确列出" : "冲突通知被移出后，O1004 的独立 120 元付款入账", pick(byId(report, "O1004"), ["paymentCents", "overpaidCents", "status"]), { paymentCents: round === 1 ? 15000 : 12000, overpaidCents: round === 1 ? 3000 : 0, status: round === 1 ? "overpaid" : "paid" });
	check("unpaid-or-late", round === 1 ? "非法金额与次日付款没有填平当天欠款" : "按发生时间接收两笔迟到的当日付款", [byId(report, "O1005")?.paymentCents, byId(report, "O1007")?.paymentCents], round === 1 ? [0, 0] : [3500, 7000]);
	check("precision", "0.10 元加 0.20 元恰好为 30 分", pick(byId(report, "O1006"), ["paymentCents", "netCents", "status"]), { paymentCents: 30, netCents: 30, status: "paid" });
	check("ignored", "重复、非成功和过截止时间的通知分别计数", pick(report?.ignored, ["duplicates", "notSucceeded", "afterCutoff", "outsideOrderDate"]), { duplicates: 1, notSucceeded: 2, afterCutoff: 2, outsideOrderDate: 0 });
	const issues = Array.isArray(report?.issues) ? report.issues.map((issue) => `${issue.eventId}:${issue.code}`).sort() : null;
	check("issues", "异常通知保留可追踪 ID，不能计入合计", issues, round === 1 ? ["e09:orphan_event", "e13:invalid_amount"] : ["e05:conflicting_duplicate", "e09:orphan_event", "e13:invalid_amount"]);
	const csv = csvRows(current.csv);
	const expectedHeader = ["order_id", "amount", "payment", "refund", "net", "status", "outstanding", "overpaid", ...(round === 2 ? ["fee", "settlement"] : [])];
	const relevantHeader = csv?.header?.slice(0, expectedHeader.length);
	const o1006 = csv?.rows.find((row) => row[0] === "O1006");
	check("csv", "CSV 包含七笔有序订单，金额固定两位小数", { header: relevantHeader, ids: csv?.rows.map((row) => row[0]), smallOrder: o1006?.slice(0, 8), validAmounts: csv?.rows.every((row) => [1, 2, 3, 4, 6, 7, ...(round === 2 ? [8, 9] : [])].every((index) => /^-?\d+\.\d{2}$/.test(row[index] ?? ""))) }, { header: expectedHeader, ids: ["O1001", "O1002", "O1003", "O1004", "O1005", "O1006", "O1007"], smallOrder: ["O1006", "0.30", "0.30", "0.00", "0.30", "paid", "0.00", "0.00"], validAmounts: true });

	const boundary = runCli("boundary", [
		{ id: "before", amount: "1.00", createdAt: "2026-10-19T15:59:59.999Z" },
		{ id: "start", amount: "1.00", createdAt: "2026-10-19T16:00:00.000Z" },
		{ id: "end", amount: "1.00", createdAt: "2026-10-20T15:59:59.999Z" },
		{ id: "after", amount: "1.00", createdAt: "2026-10-20T16:00:00.000Z" },
	], [
		event("start-pay", "start", "1.00", "2026-10-19T16:00:00.000Z"),
		event("end-pay", "end", "1.00", "2026-10-20T15:59:59.999Z"),
		event("late-pay", "end", "9.00", "2026-10-20T16:00:00.000Z"),
		event("other-order", "before", "1.00", "2026-10-20T01:00:00.000Z"),
	]);
	check("boundary-case", "独立样例：北京时间当天开始和结束的毫秒边界", { exitCode: boundary.exitCode, ids: boundary.report?.orders?.map((order) => order.id), paymentCents: boundary.report?.totals?.paymentCents, outsideOrderDate: boundary.report?.ignored?.outsideOrderDate, afterCutoff: boundary.report?.ignored?.afterCutoff }, { exitCode: 0, ids: ["end", "start"], paymentCents: 200, outsideOrderDate: 1, afterCutoff: 1 });
	const amounts = runCli("amounts", [{ id: "amounts", amount: "4.40", createdAt: "2026-10-20T01:00:00Z" }], [
		event("ten", "amounts", "0.10"), event("twenty", "amounts", "0.20"), event("four-ten", "amounts", "4.10"), event("refund", "amounts", "0.10", undefined, "refund"),
		...["-1.00", "", "1e2", "NaN", "0.001"].map((amount, index) => event(`bad-${index}`, "amounts", amount)),
	]);
	check("amount-case", "独立样例：拒绝非法金额，4.10 元不丢一分钱，退款不制造欠款", { totals: pick(amounts.report?.totals, ["paymentCents", "refundCents", "netCents", "outstandingCents"]), invalid: amounts.report?.issues?.filter((issue) => issue.code === "invalid_amount").length }, { totals: { paymentCents: 440, refundCents: 10, netCents: 430, outstandingCents: 0 }, invalid: 5 });

	const inputFiles = ["orders.json", "events.json", "events-update.json"];
	check("input-unchanged", "原始业务输入未被修改来迎合结果", inputFiles.every((name) => {
		try { return createHash("sha256").update(readFileSync(join(workspace, "data", name))).digest("hex") === createHash("sha256").update(readFileSync(join(fixture, "seed/data", name))).digest("hex"); } catch { return false; }
	}), true);
	const testFiles = ["test", "tests"].flatMap((directory) => {
		const path = join(workspace, directory);
		if (!existsSync(path)) return [];
		return readdirSync(path).filter((name) => /\.test\.(mjs|js)$/.test(name)).map((name) => join(directory, name));
	});
	const tests = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${workspace}`, `--allow-fs-write=${reports}`, "--test", "--test-isolation=none", ...testFiles], { cwd: workspace, encoding: "utf8", timeout: 15_000, maxBuffer: 256_000, env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TZ: "UTC" } });
	check("project-tests", "项目回归测试实际执行并通过", { hasTests: testFiles.length > 0, exitCode: tests.status }, { hasTests: true, exitCode: 0 });
	checks.at(-1).detail = `${tests.stdout}${tests.stderr}`.slice(-4000).replaceAll(workspace, "<workspace>");
	let deliveredJson = null;
	let deliveredCsv = null;
	let deliveredSummary = "";
	try { deliveredJson = JSON.parse(readFileSync(join(reports, `${date}.json`), "utf8")); } catch { /* Recorded as a failed delivery check. */ }
	try { deliveredCsv = readFileSync(join(reports, `${date}.csv`), "utf8"); } catch { /* Recorded below. */ }
	try { deliveredSummary = readFileSync(join(reports, "summary.md"), "utf8"); } catch { /* Recorded below. */ }
	check("delivered-json", "已交付 JSON 对应当前轮数据且包含真实计算结果", { ...pick(deliveredJson, ["date", "timezone"]), totals: pick(deliveredJson?.totals, Object.keys(totals)), ...(round === 2 ? { fees: pick(deliveredJson?.totals, ["feeCents", "settlementCents"]) } : {}) }, { date, timezone: "Asia/Shanghai", totals, ...(round === 2 ? { fees: { feeCents: 333, settlementCents: 48197 } } : {}) });
	check("delivered-csv", "已交付 CSV 与重新执行的当前结果一致", deliveredCsv?.replaceAll("\r\n", "\n").trim() ?? null, current.csv?.replaceAll("\r\n", "\n").trim() ?? "<expected CSV>");
	check("summary", "存在给运营的中文交接说明", { nonempty: deliveredSummary.trim().length >= 80, chinese: /[\u4e00-\u9fff]/.test(deliveredSummary) }, { nonempty: true, chinese: true });

	if (round === 2) {
		check("fee-total", "逐笔手续费为 3.33 元，预计到账 481.97 元", pick(report?.totals, ["feeCents", "settlementCents"]), { feeCents: 333, settlementCents: 48197 });
		check("refund-update", "新增退款后 O1001 净收 150 元，原支付手续费不退", pick(byId(report, "O1001"), ["refundCents", "netCents", "feeCents", "settlementCents"]), { refundCents: 4990, netCents: 15000, feeCents: 120, settlementCents: 14880 });
		const oldEvents = JSON.parse(readFileSync(join(fixture, "seed/data/events.json"), "utf8"));
		const regression = runCli("round1-regression", seedOrders, oldEvents);
		check("first-round-regression", "仍能用旧文件按零手续费生成第一轮正确报表", { totals: pick(regression.report?.totals, Object.keys(expectedTotals(false))), feeCents: regression.report?.totals?.feeCents ?? 0, settlementCents: regression.report?.totals?.settlementCents ?? regression.report?.totals?.netCents }, { totals: expectedTotals(false), feeCents: 0, settlementCents: 41020 });
		const feeCase = runCli("fee-rounding", [{ id: "fee", amount: "5.00", createdAt: "2026-10-20T01:00:00Z" }], [event("a", "fee", "0.83"), event("b", "fee", "0.83"), event("c", "fee", "0.84"), event("half", "fee", "2.50"), event("refund", "fee", "1.00", undefined, "refund")], 60);
		check("fee-rounding-case", "独立样例：逐笔舍入、半分进一分、退款不退费", pick(feeCase.report?.totals, ["paymentCents", "refundCents", "feeCents", "settlementCents"]), { paymentCents: 500, refundCents: 100, feeCents: 3, settlementCents: 397 });
		const conflict = runCli("conflict", [{ id: "conflict", amount: "10.00", createdAt: "2026-10-20T01:00:00Z" }], [
			event("same", "conflict", "10.00", undefined, "payment", { receivedAt: "2026-10-21T00:00:00Z" }),
			event("same", "conflict", "10.00", undefined, "payment", { receivedAt: "2026-10-22T00:00:00Z" }),
			event("bad", "conflict", "7.00"), event("bad", "conflict", "9.00"), event("bad", "conflict", "7.00"),
		]);
		check("conflict-case", "独立样例：接收时间变化不冲突，有金额冲突则隔离整个 ID", { paymentCents: conflict.report?.totals?.paymentCents, issues: conflict.report?.issues?.map((issue) => `${issue.eventId}:${issue.code}`).sort() }, { paymentCents: 1000, issues: ["bad:conflicting_duplicate"] });
	}
} catch (error) {
	checks.push({ id: "verification-error", label: "验收器完成检查", passed: false, expected: "no exception", actual: error instanceof Error ? error.message.replaceAll(workspace, "<workspace>") : String(error) });
} finally {
	rmSync(temporary, { recursive: true, force: true });
}

const passedChecks = checks.filter((item) => item.passed).length;
const result = { schemaVersion: 1, round, passed: passedChecks === checks.length, summary: { passedChecks, totalChecks: checks.length }, checks };
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;
