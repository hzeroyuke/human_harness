import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowPartial = args.includes("--allow-partial");
const paths = args.filter((arg) => arg !== "--allow-partial");
assert(paths.length >= 2, "Usage: node scripts/assemble-humanize-full-task.mjs [--allow-partial] output.json run1.json ...");
const [output, ...inputs] = paths;
const runs = await Promise.all(inputs.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))));
assert(new Set(runs.map((run) => run.id)).size === runs.length, "Duplicate run id");
assert(runs.every((run) => run.enabled === true), "Publish actual gated sessions: each before/after pair is one message in one run.");
assert(allowPartial || runs.every((run) => ["completed", "interrupted", "error"].includes(run.status)), "A run is still active");
assert(new Set(runs.map((run) => run.seedHash)).size === 1, "Runs used different seed projects");
const task = JSON.parse(await readFile(resolve(repo, "examples/humanize/full-task/schema/task.json"), "utf8"));
// Attach reproducible explanations without changing the saved original run or error.
const diagnosticsDirectory = resolve(repo, "examples/humanize/full-task/diagnostics");
const diagnosticFiles = (await readdir(diagnosticsDirectory)).filter((name) => name.endsWith(".json")).sort();
const attached = new Set();
for (const name of diagnosticFiles) {
	const annotation = JSON.parse(await readFile(resolve(diagnosticsDirectory, name), "utf8"));
	const run = runs.find((entry) => entry.id === annotation.runId);
	if (!run) continue;
	const round = run.rounds.find((entry) => entry.id === annotation.roundId);
	const event = round?.events.find((entry) => entry.id === annotation.messageId);
	assert(event?.review?.status === "failed", `Diagnostic ${name} has no matching failed message`);
	const identity = JSON.stringify([annotation.runId, annotation.roundId, annotation.messageId]);
	assert(!attached.has(identity), `Duplicate diagnostic for ${identity}`);
	attached.add(identity);
	const proof = annotation.protectionFailure;
	assert.equal(annotation.schemaVersion, 1);
	assert.equal(annotation.diagnostic?.source, "offline-replay");
	assert.equal(annotation.diagnostic?.kind, "protected-content");
	assert.equal(proof?.sourceSha256, run.source.humanizeSha256, `Diagnostic ${name} uses different source`);
	assert.equal(proof?.originalSha256, createHash("sha256").update(event.review.original).digest("hex"));
	const phase = event.review.phases[annotation.diagnostic.phaseIndex];
	assert.equal(phase?.phase, "rewrite");
	assert.equal(proof?.rewriteResponseSha256, createHash("sha256").update(phase.response).digest("hex"));
	assert.equal(proof?.requestsMatchSaved, true);
	assert.equal(proof?.reportMatchesSaved, true);
	assert.deepEqual(proof.report, event.review.report);
	event.review.diagnostic = annotation.diagnostic;
	event.review.protectionFailure = proof;
}
const models = [...new Set(runs.map((run) => run.modelId))].map((id) => ({ id, name: id }));
const data = {
	schemaVersion: 1,
	kind: "full-task",
	generatedAt: new Date().toISOString(),
	complete: !allowPartial,
	methodology: {
		comparison: "same-message-before-after",
		reviewPromptVersion: "reader-v2",
		systemPrompt: runs[0].systemPrompt,
		execution: "Actual createAgentSession with Humanize enabled; original provider response paired by message id with the SDK message_end output.",
		limitations: [
			"业务数据和待修复项目是实验夹具；读取、修改、测试和报表生成均真实执行，未预设原稿或工具结果。",
			"每条对照来自同一次执行的同一条消息；它不等于另跑一次关闭 Humanize 的完整会话。",
			"表达检查只检查是否容易理解；业务是否做对由独立验收说明，二者互不替代。",
			"有限模型和任务样本不能代表稳定通过率或模型排名；未改写、拦截和接口错误全部保留。",
			"Token 来自接口返回；耗时受代理和服务负载影响，配置中的零 cost 不表示免费。",
			"公开轨迹包含工具日志与待发送文字，不包含私有思考或认证信息。",
		],
	},
	task,
	models,
	runs,
};
await writeFile(resolve(output), `${JSON.stringify(data, null, 2)}\n`);
const messages = runs.flatMap((run) => run.rounds.flatMap((round) => round.events.filter((event) => event.review)));
console.log(JSON.stringify({ runs: runs.length, rounds: runs.reduce((sum, run) => sum + run.rounds.length, 0), messages: messages.length, rewritten: messages.filter((event) => event.review.status === "approved" && event.review.original !== event.review.final).length, unchanged: messages.filter((event) => event.review.status === "approved" && event.review.original === event.review.final).length, withheld: messages.filter((event) => event.review.status === "failed").length, complete: data.complete }));
