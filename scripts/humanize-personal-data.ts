import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { HumanizeError, humanizeMessage, type HumanizeReport } from "../packages/coding-agent/src/core/humanize.ts";
import type { HumanizeFeedback, HumanizeTrace, HumanizeTracePhase } from "../packages/coding-agent/src/core/humanize-records.ts";

export type PersonalFeedback = HumanizeFeedback;

export interface PersonalSample {
	id: string;
	source: { sessionId: string; traceEntryId: string; traceSha256: string; sessionSha256: string };
	trace: HumanizeTrace;
	feedback: PersonalFeedback[];
}

export interface PersonalDataset {
	schemaVersion: 1;
	kind: "humanize-personal-samples";
	exportedAt: string;
	selection: { problemsOnly: boolean; keepNormal: number };
	sources: { sessionId: string; sha256: string; inheritedTraces: number; inheritedFeedback: number }[];
	samples: PersonalSample[];
}

export interface PersonalReplayResult {
	sourceTraceId: string;
	sourceSessionId: string;
	sourceTraceSha256: string;
	originalSha256: string;
	oldFinal: string | null;
	newFinal: string | null;
	status: "approved" | "failed";
	phases: HumanizeTracePhase[];
	report: HumanizeReport | null;
	error: string | null;
	durationMs: number;
	usage: Usage | null;
}

export interface PersonalReplay {
	schemaVersion: 1;
	kind: "humanize-personal-replay";
	id: string;
	startedAt: string;
	finishedAt: string;
	sourceDatasetSha256: string;
	coreSha256: string;
	readerModel: { provider: string; id: string; api: string };
	results: PersonalReplayResult[];
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function requireValue(condition: unknown, description: string): asserts condition {
	if (!condition) throw new Error(`个人样本无效：${description}`);
}

function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validUsage(value: unknown): boolean {
	return record(value) && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => finiteNonnegative(value[key])) &&
		record(value.cost) && ["input", "output", "cacheRead", "cacheWrite", "total"].every(key => finiteNonnegative((value.cost as Record<string, unknown>)[key]));
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("个人样本必须是完整 JSON，不能包含 undefined。");
	return serialized;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(value: unknown): string {
	return sha256(canonical(value));
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) freeze(item);
		Object.freeze(value);
	}
	return value;
}

function assistantText(message: { content: unknown[] }): string {
	return message.content.filter(record).filter(block => block.type === "text").map(block => block.text).join("\n");
}

function validateAssistant(value: unknown, completed = true): asserts value is AssistantMessage {
	requireValue(record(value) && value.role === "assistant" && Array.isArray(value.content), "缺少原始 AssistantMessage");
	requireValue(nonempty(value.api) && nonempty(value.provider) && nonempty(value.model), "原稿模型标识缺失");
	requireValue(finiteNonnegative(value.timestamp) && validUsage(value.usage), "原稿时间或用量无效");
	requireValue((completed ? ["stop", "toolUse"] : ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]).includes(String(value.stopReason)), "助手响应结束状态无效；原稿必须是完成的文字响应");
	for (const block of value.content) {
		requireValue(record(block), "原稿内容块无效");
		if (block.type === "text") {
			requireValue(typeof block.text === "string" && (block.textSignature === undefined || typeof block.textSignature === "string"), "原稿文字块无效");
		} else {
			requireValue(block.type === "toolCall" && nonempty(block.id) && nonempty(block.name) && record(block.arguments), "原稿仅允许文字和工具调用记录");
		}
	}
}

export function validateTrace(value: unknown): asserts value is HumanizeTrace {
	requireValue(record(value) && value.schemaVersion === 1, "不支持的 trace schemaVersion");
	for (const key of ["traceId", "sessionId", "messageEntryId", "createdAt", "completedAt"]) requireValue(nonempty(value[key]), `trace.${key} 缺失`);
	requireValue(value.contextLeafId === null || nonempty(value.contextLeafId), "contextLeafId 缺失");
	requireValue(finiteNonnegative(value.durationMs), "trace.durationMs 无效");
	validateAssistant(value.originalMessage, value.status !== "failed");
	requireValue(nonempty(value.original) && value.original === assistantText(value.originalMessage), "original 与 originalMessage 不对应");
	requireValue(record(value.model) && value.model.provider === value.originalMessage.provider && value.model.id === value.originalMessage.model && value.model.api === value.originalMessage.api, "原稿模型与 trace.model 不对应");
	requireValue(value.readerModel === null || (record(value.readerModel) && ["provider", "id", "api"].every(key => nonempty((value.readerModel as Record<string, unknown>)[key]))), "readerModel 无效");
	requireValue(Array.isArray(value.visibleMessages) && value.visibleMessages.every(message => record(message) && ["user", "assistant"].includes(String(message.role)) && typeof message.text === "string"), "可见上下文缺失或无效，不能猜补");
	requireValue(record(value.settings), "缺少原审阅设置");
	for (const [key, min, max] of [["maxRevisions", 0, 5], ["timeoutMs", 1, 300000], ["maxContextChars", 256, 200000]] as const) {
		const setting = value.settings[key];
		requireValue(typeof setting === "number" && Number.isInteger(setting) && setting >= min && setting <= max, `settings.${key} 无效`);
	}
	requireValue(record(value.contextSnapshot) && value.contextSnapshot.maxChars === Number(value.settings.maxContextChars) * 4 && typeof value.contextSnapshot.visibleComplete === "boolean" && typeof value.contextSnapshot.executionComplete === "boolean" && ["complete", "size-limit"].includes(String(value.contextSnapshot.executionReason)), "上下文快照说明缺失或不一致");
	requireValue(value.executionMessages === null || Array.isArray(value.executionMessages), "执行快照缺失；必须显式为数组或 null");
	requireValue(value.contextSnapshot.executionComplete === (value.executionMessages !== null), "执行快照完整性标记不一致");
	if (Array.isArray(value.executionMessages)) {
		for (const message of value.executionMessages) {
			requireValue(record(message) && Array.isArray(message.content), "执行记录无效");
			if (message.role === "assistant") validateAssistant(message, false);
			else requireValue(message.role === "toolResult" && nonempty(message.toolName) && typeof message.isError === "boolean" && message.content.every(block => record(block) && block.type === "text" && typeof block.text === "string"), "执行快照仅允许助手和工具结果的文本记录");
		}
	}
	requireValue(Array.isArray(value.phases) && value.phases.every(phase => record(phase) && ["review", "lookup", "rewrite"].includes(String(phase.phase)) && typeof phase.systemPrompt === "string" && Object.hasOwn(phase, "request") && (phase.response === null || typeof phase.response === "string") && (phase.stopReason === null || typeof phase.stopReason === "string") && finiteNonnegative(phase.durationMs)), "审阅阶段无效");
	requireValue(value.status === "approved" || value.status === "failed", "trace.status 无效");
	requireValue(value.report === null || (record(value.report) && ["approved", "failed"].includes(String(value.report.status)) && finiteNonnegative(value.report.calls) && finiteNonnegative(value.report.revisions) && typeof value.report.lookedUpContext === "boolean" && validUsage(value.report.usage)), "report 无效");
	for (const key of ["final", "reviewedFinal", "error"]) requireValue(value[key] === null || typeof value[key] === "string", `trace.${key} 缺失或无效`);
	requireValue(typeof value.deliveryChanged === "boolean", "deliveryChanged 缺失");
	requireValue(value.status !== "approved" || typeof value.reviewedFinal === "string", "批准记录缺少 reviewedFinal");
	requireValue(record(value.source) && nonempty(value.source.packageVersion) && ["typescript", "javascript", "unavailable"].includes(String(value.source.format)) && (value.source.humanizeSha256 === null || (typeof value.source.humanizeSha256 === "string" && /^[a-f0-9]{64}$/.test(value.source.humanizeSha256))), "原审阅引擎的源码标识缺失");
}

function validateFeedback(value: unknown): asserts value is PersonalFeedback {
	requireValue(record(value) && value.schemaVersion === 1, "feedback schemaVersion 无效");
	for (const key of ["traceId", "sessionId", "messageEntryId", "createdAt"]) requireValue(nonempty(value[key]), `feedback.${key} 缺失`);
	requireValue(["good", "bad", "failed"].includes(String(value.rating)), "反馈 rating 无效");
	requireValue(Array.isArray(value.tags) && value.tags.every(tag => ["lost-facts", "unclear", "too-long"].includes(String(tag))), "反馈 tags 无效");
	requireValue(typeof value.note === "string" && typeof value.expected === "string", "反馈说明无效");
}

export function isProblemSample(sample: PersonalSample): boolean {
	return sample.trace.status === "failed" || sample.feedback.some(item => item.rating !== "good" || item.tags.length > 0);
}

export function exportPersonalSamples(
	sessions: readonly string[],
	options: { problemsOnly?: boolean; keepNormal?: number; exportedAt?: string } = {},
): PersonalDataset {
	const keepNormal = options.keepNormal ?? 0;
	requireValue(Number.isSafeInteger(keepNormal) && keepNormal >= 0, "keepNormal 必须为非负整数");
	requireValue(options.problemsOnly || keepNormal === 0, "--keep-normal 仅与 --problems-only 一起使用");
	const sources: PersonalDataset["sources"] = [];
	const samples: PersonalSample[] = [];
	const seenSessions = new Set<string>();
	const seenTraces = new Set<string>();
	for (const text of sessions) {
		const entries: Record<string, unknown>[] = [];
		for (const [index, line] of text.split(/\r?\n/).entries()) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { throw new Error(`会话 JSONL 第 ${index + 1} 行无效；未修改原文件。`); }
			requireValue(record(parsed), `会话第 ${index + 1} 行不是对象`);
			entries.push(parsed);
		}
		const header = entries[0];
		requireValue(header?.type === "session" && nonempty(header.id), "缺少 session header");
		requireValue(!seenSessions.has(header.id), "输入中存在重复 sessionId");
		seenSessions.add(header.id);
		const sessionSha256 = sha256(text);
		const source = { sessionId: header.id, sha256: sessionSha256, inheritedTraces: 0, inheritedFeedback: 0 };
		sources.push(source);
		const byId = new Map<string, Record<string, unknown>>();
		for (const entry of entries.slice(1)) {
			requireValue(nonempty(entry.id) && entry.type !== "session" && !byId.has(entry.id), "会话 entryId 缺失或重复");
			byId.set(entry.id, entry);
		}
		const feedback: PersonalFeedback[] = [];
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== "humanize_feedback") continue;
			validateFeedback(entry.data);
			if (entry.data.sessionId !== header.id) {
				requireValue(nonempty(header.parentSession), "反馈 sessionId 与文件不符，且会话没有分支来源");
				source.inheritedFeedback++;
				continue;
			}
			feedback.push(entry.data);
		}
		const sessionSamples: PersonalSample[] = [];
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== "humanize_trace") continue;
			validateTrace(entry.data);
			const trace = entry.data;
			if (trace.sessionId !== header.id) {
				requireValue(nonempty(header.parentSession), "trace sessionId 与文件不符，且会话没有分支来源");
				source.inheritedTraces++;
				continue;
			}
			requireValue(!seenTraces.has(trace.traceId), "traceId 重复");
			seenTraces.add(trace.traceId);
			const saved = byId.get(trace.messageEntryId);
			requireValue(saved?.type === "message" && record(saved.message) && saved.message.role === "assistant" && Array.isArray(saved.message.content), "trace 未关联到真实助手消息 entryId");
			const storedMessage = saved.message as { content: unknown[]; stopReason?: unknown };
			const sent = storedMessage.stopReason === "error" || storedMessage.stopReason === "aborted" ? null : assistantText(storedMessage) || null;
			requireValue(trace.final === sent, "trace.final 与对应消息实际文字不一致");
			const attached = feedback.filter(item => item.traceId === trace.traceId);
			requireValue(attached.every(item => item.messageEntryId === trace.messageEntryId), "反馈指向的消息与 trace 不一致");
			sessionSamples.push({ id: trace.traceId, source: { sessionId: trace.sessionId, traceEntryId: String(entry.id), traceSha256: fingerprint(trace), sessionSha256 }, trace, feedback: attached });
		}
		requireValue(feedback.every(item => sessionSamples.some(sample => sample.id === item.traceId)), "反馈引用了本会话不存在的 trace");
		samples.push(...sessionSamples);
	}
	samples.sort((left, right) => left.trace.createdAt.localeCompare(right.trace.createdAt) || left.id.localeCompare(right.id));
	let normalRemaining = keepNormal;
	const selected = options.problemsOnly ? samples.filter(sample => isProblemSample(sample) || normalRemaining-- > 0) : samples;
	return freeze({ schemaVersion: 1, kind: "humanize-personal-samples", exportedAt: options.exportedAt ?? new Date().toISOString(), selection: { problemsOnly: options.problemsOnly ?? false, keepNormal }, sources, samples: selected });
}

export function validateDataset(value: unknown): asserts value is PersonalDataset {
	requireValue(record(value) && value.schemaVersion === 1 && value.kind === "humanize-personal-samples", "必须提供个人样本导出文件");
	requireValue(Array.isArray(value.sources) && Array.isArray(value.samples), "samples 或 sources 缺失");
	const sourceById = new Map<string, string>();
	for (const source of value.sources) {
		requireValue(record(source) && nonempty(source.sessionId) && typeof source.sha256 === "string" && /^[a-f0-9]{64}$/.test(source.sha256) && !sourceById.has(source.sessionId), "会话来源无效或重复");
		sourceById.set(source.sessionId, source.sha256);
	}
	const seen = new Set<string>();
	for (const sample of value.samples) {
		requireValue(record(sample) && nonempty(sample.id) && !seen.has(sample.id) && record(sample.source), "样本 ID 缺失或重复");
		seen.add(sample.id);
		validateTrace(sample.trace);
		requireValue(sample.id === sample.trace.traceId && sample.source.sessionId === sample.trace.sessionId && nonempty(sample.source.traceEntryId), "样本来源与 trace identity 不匹配");
		requireValue(sample.source.traceSha256 === fingerprint(sample.trace), "trace 指纹不匹配，源样本已经变化");
		requireValue(sample.source.sessionSha256 === sourceById.get(sample.trace.sessionId), "session 指纹不匹配");
		requireValue(Array.isArray(sample.feedback), "缺少 feedback 数组");
		for (const feedback of sample.feedback) {
			validateFeedback(feedback);
			requireValue(feedback.traceId === sample.id && feedback.sessionId === sample.trace.sessionId && feedback.messageEntryId === sample.trace.messageEntryId, "反馈 identity 不匹配");
		}
	}
}

export interface PersonalReader {
	model: PersonalReplay["readerModel"];
	complete: (systemPrompt: string, payload: unknown, signal: AbortSignal) => Promise<AssistantMessage>;
}

/** No agent loop or tool executor is available here. Saved calls are inert lookup data. */
export async function replayPersonalSamples(
	dataset: PersonalDataset,
	reader: PersonalReader,
	options: { sourceDatasetSha256: string; coreSha256: string; traceIds?: readonly string[]; signal?: AbortSignal },
): Promise<PersonalReplay> {
	validateDataset(dataset);
	for (const key of ["provider", "id", "api"] as const) requireValue(nonempty(reader.model[key]), `重放 readerModel.${key} 不能为空`);
	for (const hash of [options.sourceDatasetSha256, options.coreSha256]) requireValue(/^[a-f0-9]{64}$/.test(hash), "重放源指纹无效");
	const wanted = options.traceIds ? new Set(options.traceIds) : null;
	requireValue(!wanted || wanted.size === options.traceIds?.length, "--trace-id 重复");
	requireValue(!wanted || [...wanted].every(id => dataset.samples.some(sample => sample.id === id)), "--trace-id 在样本中不存在");
	const selected = structuredClone(dataset.samples.filter(sample => !wanted || wanted.has(sample.id)));
	requireValue(selected.length > 0, "没有可重放的样本");
	const startedAt = new Date().toISOString();
	const results: PersonalReplayResult[] = [];
	for (const sourceSample of selected) {
		// Work on a copy even when a test/provider mutates its input. The export remains immutable.
		const sample = structuredClone(sourceSample);
		const trace = sample.trace;
		const started = performance.now();
		const phases: HumanizeTracePhase[] = [];
		let failure: string | null = null;
		let closed = false;
		let report: HumanizeReport | null = null;
		let newFinal: string | null = null;
		try {
			const outcome = await humanizeMessage({
				message: trace.originalMessage,
				visibleMessages: trace.visibleMessages,
				settings: trace.settings,
				signal: options.signal,
				getExecutionMessages: () => {
					if (trace.executionMessages === null) {
						failure = "审阅需要执行上下文，但原样本未完整保存该快照；未补造上下文，也未执行任务。";
						throw new Error(failure);
					}
					return trace.executionMessages;
				},
				complete: async (systemPrompt, request, signal) => {
					const phaseStarted = performance.now();
					const phaseName = record(request) ? request.phase : null;
					if (phaseName !== "review" && phaseName !== "lookup" && phaseName !== "rewrite") throw new Error("未知审阅阶段");
					const phase: HumanizeTracePhase = { phase: phaseName, systemPrompt, request: structuredClone(request), response: null, stopReason: null, durationMs: 0 };
					phases.push(phase);
					const abort = () => {
						if (!closed) { phase.durationMs = Math.round(performance.now() - phaseStarted); phase.error = "审阅调用已取消或超时。"; }
					};
					signal.addEventListener("abort", abort, { once: true });
					try {
						const response = await reader.complete(systemPrompt, structuredClone(request), signal);
						if (closed || signal.aborted) throw new Error("审阅调用已结束");
						phase.response = response.stopReason === "error" || response.stopReason === "aborted" ? null : assistantText(response);
						phase.stopReason = response.stopReason;
						phase.usage = structuredClone(response.usage);
						if (response.stopReason === "error" || response.stopReason === "aborted") {
							failure = "审阅模型返回错误或中断；未保存可能含认证信息的上游错误正文。";
							phase.error = failure;
						} else if (!phase.response?.trim()) {
							failure = "审阅模型返回空文本，无法形成审阅决定。";
							phase.error = failure;
						}
						return response;
					} catch {
						if (!closed && !signal.aborted) {
							failure = "审阅模型调用失败；未保存可能含认证信息的上游异常正文。";
							phase.error = failure;
						}
						throw new Error("Reader request failed");
					} finally {
						signal.removeEventListener("abort", abort);
						if (!closed) phase.durationMs = Math.round(performance.now() - phaseStarted);
					}
				},
			});
			report = outcome.report;
			newFinal = assistantText(outcome.message);
		} catch (error) {
			if (error instanceof HumanizeError) { report = error.report; failure ??= error.message; }
			else failure ??= "个人样本重放失败；原样本保持不变。";
		} finally { closed = true; }
		results.push({ sourceTraceId: sample.id, sourceSessionId: trace.sessionId, sourceTraceSha256: sample.source.traceSha256, originalSha256: fingerprint(trace.originalMessage), oldFinal: trace.final, newFinal, status: newFinal === null ? "failed" : "approved", phases, report, error: failure, durationMs: Math.round(performance.now() - started), usage: report?.usage ?? null });
	}
	return freeze({ schemaVersion: 1, kind: "humanize-personal-replay", id: randomUUID(), startedAt, finishedAt: new Date().toISOString(), sourceDatasetSha256: options.sourceDatasetSha256, coreSha256: options.coreSha256, readerModel: structuredClone(reader.model), results });
}
