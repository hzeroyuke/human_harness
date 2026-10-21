import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import {
	HumanizeError,
	humanizeMessage,
	type HumanizeVisibleMessage,
} from "../packages/coding-agent/src/core/humanize.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";

const work = resolve(dirname(fileURLToPath(import.meta.url)), "../.artifacts/humanize");
await mkdir(work, { recursive: true });
const baseUrl = process.env.HUMANIZE_DEMO_BASE_URL ?? "http://127.0.0.1:4142/v1";
const provider = "humanize-local-demo";
const modelId = process.env.HUMANIZE_DEMO_MODEL ?? "gemini-3.8-flash";
const api = process.env.HUMANIZE_DEMO_API === "openai-responses" ? "openai-responses" : "openai-completions";
const credentials = AuthStorage.inMemory({ [provider]: { type: "api_key", key: "local-proxy" } });
const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
runtime.registerProvider(provider, {
	baseUrl,
	api,
	apiKey: "local-proxy",
	models: [
		{
			id: modelId,
			name: modelId,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		},
	],
});
const configuredModel = runtime.getModel(provider, modelId);
assert(configuredModel, "Configured proxy model must exist");
const model = configuredModel;

function text(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function draft(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api,
		provider,
		model: modelId,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

interface PhaseResult {
	phase: string;
	request: unknown;
	response: string;
	durationMs: number;
	stopReason: string;
	error?: string;
}

const results: Record<string, unknown> = { model: modelId, api, startedAt: new Date().toISOString() };
const caseNames: Record<string, string> = {
	jargon: "内部代号需要解释",
	ambiguous_reference: "指代不明需要补全",
	clear: "清楚的回复保持原样",
};
const markdown: string[] = [
	"# Pi Humanize：开启与关闭对照实测",
	"",
	`模型：${modelId}；协议：${api}；通过配置的反代地址调用。`,
	"",
	"每组使用同一份固定的待发送文本。用户输入和工具记录是测试夹具，未执行其中描述的工作；审阅、查证、改写、复审均调用真实模型。关闭时直接展示该固定文本，开启时通过实际 humanizeMessage 引擎。末尾另含真正 createAgentSession 的端到端调用。",
	"",
	"记录中的 token 数来自接口响应；cost 为本地模型配置的零占位值，不能用来推断实际计费。",
	"",
];
let errors = 0;

async function runCase(
	name: string,
	before: string,
	visibleMessages: HumanizeVisibleMessage[],
	execution: AgentMessage[],
) {
	const phases: PhaseResult[] = [];
	const common = {
		input: visibleMessages,
		executionFixture: execution,
		disabled: { output: before, reviewerCalls: 0 },
		before,
	};
	markdown.push(
		`## ${caseNames[name] ?? name}`,
		"",
		"用户输入：",
		"",
		...visibleMessages.map((message) => `${message.role}: ${message.text}`),
		"",
		"执行记录（合成测试夹具）：",
		"",
		"```json",
		JSON.stringify(execution, null, 2),
		"```",
		"",
		"关闭 Humanize 后显示：",
		"",
		before,
		"",
	);
	let traceReads = 0;
	const started = Date.now();
	try {
		const result = await humanizeMessage({
			message: draft(before),
			visibleMessages,
			getExecutionMessages: () => {
				traceReads++;
				return execution;
			},
			settings: { maxRevisions: 2, timeoutMs: 120_000, maxContextChars: 48_000 },
			complete: async (systemPrompt, payload, signal) => {
				const phase = String((payload as Record<string, unknown>).phase);
				if (phase === "review") {
					assert.deepEqual(Object.keys(payload as Record<string, unknown>).sort(), [
						"draft",
						"phase",
						"visibleMessages",
					]);
				}
				const context: Context = {
					messages: [
						{ role: "system", content: systemPrompt, timestamp: Date.now() },
						{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() },
					],
				};
				const callStarted = Date.now();
				const stream = runtime.streamSimple(model, context, {
					signal,
					sessionId: `humanize-live-${randomUUID()}`,
					maxTokens: 4096,
					timeoutMs: 45_000,
					maxRetries: 0,
					transport: "sse",
					cacheRetention: "none",
				});
				for await (const _event of stream) {
					/* Review text stays internal. */
				}
				const response = await stream.result();
				phases.push({
					phase,
					request: payload,
					response: text(response),
					durationMs: Date.now() - callStarted,
					stopReason: response.stopReason,
					error: response.errorMessage,
				});
				console.log(
					JSON.stringify({
						case: name,
						phase,
						stopReason: response.stopReason,
						durationMs: Date.now() - callStarted,
					}),
				);
				return response;
			},
		});
		const after = text(result.message);
		results[name] = {
			...common,
			ok: true,
			after,
			phases,
			traceReads,
			report: result.report,
			durationMs: Date.now() - started,
		};
		if (name === "clear") {
			assert.equal(after, before, "Clear text should remain unchanged");
			assert.equal(traceReads, 0, "Clear text must not access execution records");
		}
		if (name === "jargon" || name === "ambiguous_reference") {
			assert.equal(result.report.lookedUpContext, true, "Unknown internal definitions should trigger lookup");
			assert.notEqual(after, before, "Jargon draft should be clarified");
			assert.equal(phases[phases.length - 1]?.phase, "review", "The final check must be blind review");
		}
		markdown.push(
			"开启 Humanize 后显示：",
			"",
			after,
			"",
			`修订次数：${result.report.revisions}；辅助调用：${result.report.calls}；访问执行记录次数：${traceReads}。`,
			"",
		);
	} catch (error) {
		errors++;
		results[name] = {
			...common,
			ok: false,
			phases,
			traceReads,
			durationMs: Date.now() - started,
			error: error instanceof Error ? error.message : String(error),
			report: error instanceof HumanizeError ? error.report : undefined,
		};
		markdown.push(`运行失败：${error instanceof Error ? error.message : String(error)}`, "");
	}
	for (const [index, phase] of phases.entries()) {
		markdown.push(
			`步骤 ${index + 1}：${phase.phase}（${phase.durationMs}ms，${phase.stopReason}）`,
			"",
			"请求：",
			"",
			"```json",
			JSON.stringify(phase.request, null, 2),
			"```",
			"",
			"模型实际返回：",
			"",
			"````text",
			phase.response,
			"````",
			"",
		);
	}
	await writeFile(`${work}/live-humanize-results.json`, `${JSON.stringify(results, null, 2)}\n`);
	await writeFile(`${work}/live-humanize-results.md`, `${markdown.join("\n").trimEnd()}\n`);
}

await runCase(
	"jargon",
	"已完成蓝桥收口，进入玻璃窗阶段。",
	[{ role: "user", text: "导出任务现在是什么状态？请用日常语言告诉我进展。" }],
	[
		{
			...draft(""),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "demo-read", name: "read", arguments: { path: "status.json" } }],
		},
		{
			role: "toolResult",
			toolCallId: "demo-read",
			toolName: "read",
			isError: false,
			timestamp: Date.now(),
			content: [
				{
					type: "text",
					text: "蓝桥：失败后自动重试导出任务的流程。收口：已将该流程中所有仍在重试的导出任务处理完毕。玻璃窗：上线后持续观察日志、确认是否出现新增导出失败的阶段。状态：重试中的导出任务已处理完，正在观察后续导出，尚不能保证不会再失败。",
				},
			],
		},
	],
);

await runCase(
	"ambiguous_reference",
	"前者已切换，后者仍挂起；等那边恢复后再放行。",
	[{ role: "user", text: "我现在能用新版本了吗？还有什么没完成，请说清楚。" }],
	[
		{
			...draft(""),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "demo-status", name: "read", arguments: { path: "release-state.json" } }],
		},
		{
			role: "toolResult",
			toolCallId: "demo-status",
			toolName: "read",
			isError: false,
			timestamp: Date.now(),
			content: [
				{
					type: "text",
					text: "本次内部代指：前者=公司员工使用的测试网站；后者=普通用户使用的正式网站；那边=提供登录验证的外部服务；放行=允许普通用户登录新版本。当前状态：测试网站已经切换到新版本。正式网站仍使用旧版本，发布暂停，原因是外部登录验证服务故障。故障恢复后还需检查登录是否正常，检查通过才发布新版本；目前不能让普通用户使用新版本。",
				},
			],
		},
	],
);

await runCase(
	"clear",
	"导出任务已经完成，文件保存在 output.csv。",
	[{ role: "user", text: "请把数据导出到 output.csv，并告诉我是否完成。" }],
	[],
);

const sdkDir = `${work}/live-sdk-state`;
await mkdir(sdkDir, { recursive: true });
const settings = SettingsManager.inMemory({
	humanize: { enabled: true, timeoutMs: 120_000 },
	cacheWarming: "off",
	retry: { enabled: false },
	compaction: { enabled: false },
	enableAnalytics: false,
	enableInstallTelemetry: false,
});
const loader = new DefaultResourceLoader({
	cwd: sdkDir,
	agentDir: sdkDir,
	settingsManager: settings,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	systemPrompt: "你是一个简洁的中文助手。直接回答用户的问题，不要使用工具。",
});
await loader.reload();
const manager = SessionManager.inMemory(sdkDir);
const { session } = await createAgentSession({
	cwd: sdkDir,
	agentDir: sdkDir,
	model,
	modelRuntime: runtime,
	settingsManager: settings,
	sessionManager: manager,
	resourceLoader: loader,
	tools: [],
	thinkingLevel: "off",
});
try {
	const seenText: string[] = [];
	session.subscribe((event) => {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			seenText.push(text(event.message));
		}
	});
	await session.prompt("用一句日常中文解释什么是缓存。");
	const final = session.messages.findLast((message) => message.role === "assistant");
	assert(final?.role === "assistant");
	assert.equal(final.stopReason, "stop", final.errorMessage);
	const reports = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "humanize");
	assert(reports.length > 0, "SDK must persist a humanize review report");
	assert(
		reports.every(
			(entry) => entry.type === "custom" && (entry.data as Record<string, unknown>).status === "approved",
		),
		"SDK must persist an approved humanize report",
	);
	assert.equal(seenText[seenText.length - 1], text(final), "Displayed final text must equal the saved assistant text");
	results.sdk = { ok: true, after: text(final), displayedFinal: seenText[seenText.length - 1], reports };
	markdown.push(
		"## 实际 SDK 端到端验证",
		"",
		"用户输入：用一句日常中文解释什么是缓存。",
		"",
		"最终输出：",
		"",
		text(final),
		"",
		"持久化审阅报告：",
		"",
		"```json",
		JSON.stringify(reports, null, 2),
		"```",
		"",
	);
} catch (error) {
	errors++;
	results.sdk = { ok: false, error: error instanceof Error ? error.message : String(error) };
	markdown.push(
		"## 实际 SDK 端到端验证",
		"",
		`运行失败：${error instanceof Error ? error.message : String(error)}`,
		"",
	);
} finally {
	session.dispose();
}
results.finishedAt = new Date().toISOString();
await writeFile(`${work}/live-humanize-results.json`, `${JSON.stringify(results, null, 2)}\n`);
await writeFile(`${work}/live-humanize-results.md`, `${markdown.join("\n").trimEnd()}\n`);
console.log(JSON.stringify(results, null, 2));
process.exitCode = errors ? 1 : 0;
