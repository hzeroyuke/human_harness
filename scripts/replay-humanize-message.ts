import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai/compat";
import {
	HumanizeError,
	humanizeMessage,
	type HumanizeVisibleMessage,
} from "../packages/coding-agent/src/core/humanize.ts";

export interface ReplaySelection {
	runId: string;
	roundId: string;
	messageId: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} 必须是对象`);
	return value as Record<string, unknown>;
}

function uniqueById(value: unknown, id: string, label: string): Record<string, unknown> {
	assert(Array.isArray(value), `${label} 必须是数组`);
	const matches = value.map((entry) => object(entry, label)).filter((entry) => entry.id === id);
	assert.equal(matches.length, 1, `${label} 必须恰好包含一个 ID 为 ${id} 的记录`);
	return matches[0];
}

function executionBefore(
	run: Record<string, unknown>,
	selection: ReplaySelection,
	savedExecution: unknown,
	api: AssistantMessage["api"],
): AgentMessage[] {
	assert(Array.isArray(savedExecution), "lookup 缺少保存的 execution");
	assert(Array.isArray(run.rounds), "缺少 rounds");
	const messages: AgentMessage[] = [];
	for (const entry of run.rounds) {
		const round = object(entry, "round");
		assert(Array.isArray(round.rawResponses), "缺少 rawResponses，不能重建执行记录");
		assert(Array.isArray(round.events), "缺少 events，不能重建执行记录");
		const events = round.events.map((value) => object(value, "event"));
		for (const value of round.rawResponses) {
			const raw = object(value, "rawResponse");
			if (round.id === selection.roundId && raw.id === selection.messageId) return messages;
			assert.equal(raw.state, "received", "缺少完整的先前响应，不能重建 execution");
			assert.equal(typeof raw.text, "string", "先前响应缺少文本");
			assert(Array.isArray(raw.toolCalls), "先前响应缺少 toolCalls");
			assert(
				raw.stopReason === "stop" || raw.stopReason === "toolUse" || raw.stopReason === "length",
				"暂不支持执行历史中的其他响应结束状态",
			);
			// The runner does not retain interleaving of text and tool blocks. Never
			// guess that ordering; the supported attempts have pure text or pure calls.
			assert(!(raw.text && raw.toolCalls.length), "暂不支持文字与工具调用混排的先前响应");
			const content: AssistantMessage["content"] = [];
			if (raw.text) {
				const visible = events.filter((event) => event.id === raw.id && event.type === "assistant");
				assert.equal(visible.length, 1, "先前文字响应缺少唯一的实际释放记录");
				assert(visible[0].isError !== true && typeof visible[0].text === "string", "暂不支持先前文字响应被拦截");
				content.push({ type: "text", text: visible[0].text });
			}
			const calls = raw.toolCalls.map((value) => {
				const call = object(value, "toolCall");
				assert(typeof call.id === "string" && typeof call.name === "string", "工具调用缺少 ID 或名称");
				return {
					type: "toolCall" as const,
					id: call.id,
					name: call.name,
					arguments: object(call.arguments, "arguments") as JsonObject,
				};
			});
			content.push(...calls);
			messages.push({
				role: "assistant",
				content,
				api,
				provider: "saved-response-replay",
				model: String(run.modelId),
				stopReason: raw.stopReason,
				timestamp: 0,
				usage: object(raw.usage, "raw.usage") as unknown as AssistantMessage["usage"],
			});
			for (const call of calls) {
				const executed = events.filter((event) => event.type === "tool" && event.id === call.id);
				let text: string;
				let isError = false;
				if (raw.stopReason === "length") {
					assert.equal(executed.length, 0, "length 响应中的工具不应实际执行");
					// The runner does not emit a tool event when the SDK rejects truncated
					// arguments. Require the actual saved SDK error, never invent a result.
					const expected = `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
					const saved: Record<string, unknown>[] = savedExecution
						.map((value) => object(value, "execution record"))
						.filter(
							(record) =>
								record.type === "tool_result" &&
								record.name === call.name &&
								record.isError === true &&
								record.text === expected,
						);
					assert.equal(saved.length, 1, "缺少唯一的已保存 SDK length 拒绝记录，不能推测工具结果");
					text = saved[0].text as string;
					isError = true;
				} else {
					assert.equal(executed.length, 1, "缺少唯一的实际工具执行记录");
					assert.equal(executed[0].name, call.name, "工具执行名称与调用不一致");
					assert.deepEqual(executed[0].arguments, call.arguments, "工具执行参数与调用不一致");
					assert("result" in executed[0], "工具结果尚未保存");
					// recordTool returns its captured result as JSON text even when the
					// action failed; that case is not an SDK-level tool error.
					text = JSON.stringify(executed[0].result);
				}
				messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text }],
					isError,
					timestamp: 0,
				});
			}
		}
	}
	throw new Error("执行记录中找不到目标消息");
}

/** Replay a first rewrite failure, or a second rewrite without lookup. No model calls. */
export async function replaySavedHumanize(input: unknown, selection: ReplaySelection) {
	const root = object(input, "输入");
	const run = "runs" in root ? uniqueById(root.runs, selection.runId, "runs") : root;
	assert.equal(run.id, selection.runId, "运行 ID 不匹配");
	assert.equal(run.enabled, true, "只支持已开启 Humanize 的记录");
	const api = run.api;
	assert(api === "openai-responses" || api === "openai-completions", "暂不支持此 provider API 的记录格式");
	const source = object(run.source, "source");
	const sourceBytes = await readFile(new URL("../packages/coding-agent/src/core/humanize.ts", import.meta.url));
	const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
	assert.equal(sourceSha256, source.humanizeSha256, "源码哈希不匹配：请使用产生这条轨迹的 humanize.ts");
	const round = uniqueById(run.rounds, selection.roundId, "rounds");
	const event = uniqueById(round.events, selection.messageId, "events");
	assert.equal(event.type, "assistant", "目标必须是 assistant 消息");
	assert.equal(event.sourceMessageId, event.id, "消息与原稿 ID 不匹配");
	assert.equal(event.errorStage, "humanize", "只支持 Humanize 阶段失败");
	assert.equal(event.text, "", "被拦截消息不应包含已释放文本");
	const review = object(event.review, "review");
	assert.equal(review.status, "failed", "只支持已失败的审阅");
	assert.equal(review.final, null, "被拦截消息不能有最终稿");
	const raw = uniqueById(round.rawResponses, selection.messageId, "rawResponses");
	assert.equal(raw.state, "received", "原始模型响应尚未完整收到");
	assert.equal(raw.stopReason, "stop", "只支持正常结束的纯文本原稿");
	assert.deepEqual(raw.toolCalls, [], "暂不支持原稿包含工具调用的情况");
	assert.equal(typeof raw.text, "string", "原稿缺少文本");
	assert.equal(raw.text, review.original, "review.original 与原始响应不同");
	const original = raw.text as string;
	assert(Array.isArray(review.phases), "缺少 phases");
	const hasLookup = review.phases.length === 3;
	const secondRewrite = review.phases.length === 4;
	assert.deepEqual(
		review.phases.map((phase) => object(phase, "phase").phase),
		hasLookup
			? ["review", "lookup", "rewrite"]
			: secondRewrite
				? ["review", "rewrite", "review", "rewrite"]
				: ["review", "rewrite"],
		"暂只支持 review → rewrite、review → lookup → rewrite 或无 lookup 的两次 review → rewrite；其他流程不做推测",
	);
	const phases = review.phases.map((value) => {
		const phase = object(value, "phase");
		assert.equal(phase.stopReason, "stop", "暂不支持未完整结束的审阅响应");
		assert.equal(typeof phase.response, "string", "缺少保存的响应");
		assert.equal(typeof phase.systemPrompt, "string", "缺少保存的系统提示");
		const request = object(phase.request, "phase.request");
		assert.equal(request.phase, phase.phase, "phase 与 request.phase 不一致");
		return {
			request,
			systemPrompt: phase.systemPrompt as string,
			response: phase.response as string,
			usage: object(phase.usage, "phase.usage") as unknown as AssistantMessage["usage"],
		};
	});
	const report = object(review.report, "report");
	assert.equal(report.calls, phases.length, "报告调用次数与保存的阶段数不同");
	assert.equal(report.revisions, secondRewrite ? 1 : 0, "报告的修订次数与保存的改写流程不同");
	assert.equal(report.lookedUpContext, hasLookup, "报告的 lookup 状态与保存的阶段不同");
	const limits = object(run.limits, "limits");
	assert.equal(typeof limits.maxRevisions, "number", "缺少 maxRevisions");
	assert.equal(typeof limits.reviewTimeoutMs, "number", "缺少 reviewTimeoutMs");

	// The blind reader sees only actual public history. Execution records are
	// reconstructed separately, and only supplied when the engine requests lookup.
	const visibleMessages: HumanizeVisibleMessage[] = [];
	let found = false;
	assert(Array.isArray(run.rounds), "缺少 rounds");
	for (const savedRound of run.rounds) {
		const candidateRound = object(savedRound, "round");
		assert(Array.isArray(candidateRound.events), "缺少 round.events");
		for (const savedEvent of candidateRound.events) {
			const candidate = object(savedEvent, "event");
			if (candidateRound.id === selection.roundId && candidate.id === selection.messageId) {
				found = true;
				break;
			}
			if (
				(candidate.type === "user" || (candidate.type === "assistant" && candidate.isError !== true)) &&
				typeof candidate.text === "string" &&
				candidate.text.trim()
			) {
				visibleMessages.push({ role: candidate.type, text: candidate.text });
			}
		}
		if (found) break;
	}
	assert(found, "找不到目标消息的位置");
	const rewriteIndex = phases.length - 1;
	const rewrittenResponse = phases[rewriteIndex].response;
	const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(rewrittenResponse.trim());
	const candidate = object(JSON.parse(fenced ? fenced[1] : rewrittenResponse), "改写响应");
	assert.deepEqual(Object.keys(candidate), ["text"], "暂只诊断合法的改写 JSON");
	assert.equal(typeof candidate.text, "string", "改写响应缺少 text");
	const rewritten = candidate.text as string;
	// These identify evidence only. The source engine below must independently
	// raise its protection error before an annotation can be emitted.
	const patterns = [
		/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g,
		/(?<!`)`[^`\n]+`(?!`)/g,
		/https?:\/\/[^\s<>"`]+/g,
		/(?:^|(?<=[\s("'`]))(?:\/|~\/|\.\.?\/)[^\s<>"'`),;]+/gm,
		/(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:%|ms|KB|MB|GB)?(?![\p{L}\p{N}_])/gu,
	];
	const missingLiterals = [
		...new Set(patterns.flatMap((pattern) => [...original.matchAll(pattern)].map((match) => match[0]))),
	].filter((literal) => !rewritten.includes(literal));
	assert(missingLiterals.length > 0, "没有发现丢失的受保护内容，不能生成该诊断");

	let calls = 0;
	let executionReads = 0;
	let requestMismatch: unknown;
	let reproduced: HumanizeError | undefined;
	try {
		await humanizeMessage({
			message: {
				role: "assistant",
				content: [{ type: "text", text: original }],
				api,
				provider: "saved-response-replay",
				model: String(run.modelId),
				stopReason: "stop",
				timestamp: 0,
				usage: object(raw.usage, "raw.usage") as unknown as AssistantMessage["usage"],
			},
			visibleMessages,
			getExecutionMessages: () => {
				try {
					assert(hasLookup, "没有保存 lookup，不得读取执行记录");
					assert.equal(++executionReads, 1, "暂只支持一次 lookup");
					return executionBefore(run, selection, phases[1].request.execution, api);
				} catch (error) {
					requestMismatch = error;
					throw error;
				}
			},
			settings: { maxRevisions: limits.maxRevisions as number, timeoutMs: limits.reviewTimeoutMs as number },
			complete: async (systemPrompt, payload) => {
				const phase = phases[calls++];
				try {
					assert(phase, "引擎请求了未保存的响应，不能继续重放");
					assert.equal(systemPrompt, phase.systemPrompt, "系统提示与已保存请求不一致");
					assert.deepEqual(payload, phase.request, "载荷与已保存请求不一致");
				} catch (error) {
					requestMismatch = error;
					throw error;
				}
				return {
					role: "assistant",
					content: [{ type: "text", text: phase.response }],
					api,
					provider: "saved-response-replay",
					model: String(run.modelId),
					stopReason: "stop",
					timestamp: 0,
					usage: phase.usage,
				};
			},
		});
	} catch (error) {
		if (requestMismatch) throw requestMismatch;
		assert(error instanceof HumanizeError, "没有得到可识别的引擎错误");
		reproduced = error;
	}
	assert(reproduced, "本地重放未失败，不能为原始轨迹添加失败诊断");
	assert.equal(reproduced.message, "Humanize revision changed protected technical content.", "重放不是内容保护失败");
	assert.equal(calls, phases.length, "保存响应未被恰好重放一次");
	assert.equal(executionReads, hasLookup ? 1 : 0, "执行记录访问次数与保存流程不同");
	assert.deepEqual(reproduced.report, report, "重放报告与原始报告不一致");
	const lostAmounts = missingLiterals.every(
		(literal) =>
			original.includes(`￥${literal}`) || original.includes(`¥${literal}`) || original.includes(`${literal} 元`),
	);
	// The numeric guard splits clock times into parts. Keep those exact literals
	// in the proof, but identify their original time context in the explanation.
	const lostTimes = [
		...new Set([...original.matchAll(/(?<!\d)(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?!\d)/g)].map((match) => match[0])),
	].filter((time) => !rewritten.includes(time) && missingLiterals.some((literal) => time.split(":").includes(literal)));
	const lostTimeParts =
		lostTimes.length > 0 && missingLiterals.every((literal) => lostTimes.some((time) => time.split(":").includes(literal)));
	const reason = lostAmounts
		? "改写稿丢失关键金额，被内容保护拦截"
		: lostTimeParts
			? "改写稿丢失时间信息，被内容保护拦截"
			: "改写稿丢失受保护内容，被内容保护拦截";
	const missingDescription = lostTimeParts
		? `时间 ${lostTimes.join("、")}（内容保护匹配到缺失的 ${missingLiterals.join("、")}）`
		: missingLiterals.length === 1
			? `${missingLiterals[0]}${lostAmounts ? " 元" : ""}`
			: `${missingLiterals.slice(0, 3).join("、")} 等 ${missingLiterals.length} 种${lostAmounts ? "金额" : "受保护内容"}`;
	return {
		schemaVersion: 1,
		...selection,
		diagnostic: {
			kind: "protected-content",
			source: "offline-replay",
			title: "改写稿被内容保护拦截",
			detail: `候选稿删除了原稿中的 ${missingDescription}。系统拒绝了这份候选稿，最终回复没有发出。此结论来自相同源码和已保存响应的本地重放，原始通用错误仍保留。`,
			phaseIndex: rewriteIndex,
		},
		protectionFailure: {
			verifiedBy: "saved-response-replay",
			reason,
			engineError: reproduced.message,
			missingLiterals,
			sourceSha256,
			originalSha256: createHash("sha256").update(original).digest("hex"),
			rewriteResponseSha256: createHash("sha256").update(rewrittenResponse).digest("hex"),
			requestsMatchSaved: true,
			reportMatchesSaved: true,
			report: reproduced.report,
			scope: "根据已保存响应离线重放；未重新调用模型或执行开发任务，不替代原始错误记录。",
		},
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [input, runId, roundId, messageId, outputFlag, output, ...extra] = process.argv.slice(2);
		assert(
			input &&
				runId &&
				roundId &&
				messageId &&
				extra.length === 0 &&
				(outputFlag === undefined || (outputFlag === "--output" && output)),
			"用法：replay-humanize-message.ts <run-or-dataset.json> <runId> <roundId> <messageId> [--output <new-file.json>]",
		);
		const annotation = await replaySavedHumanize(JSON.parse(await readFile(input, "utf8")), {
			runId,
			roundId,
			messageId,
		});
		const json = `${JSON.stringify(annotation, null, 2)}\n`;
		if (output) await writeFile(output, json, { flag: "wx" });
		else process.stdout.write(json);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
