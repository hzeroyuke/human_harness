import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import type { HumanizeReport } from "../packages/coding-agent/src/core/humanize.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession, type ToolDefinition } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { readFullTaskLimits } from "./humanize-full-task-limits.ts";

// One process runs one independently seeded, two-round SDK session. Every paired
// original/approved message comes from one request in this enabled session.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(repo, "examples/humanize/full-task");
const modelId = process.env.HUMANIZE_TASK_MODEL ?? "gemini-3.8-flash";
const enabled = process.env.HUMANIZE_TASK_MODE === "on";
const runId = process.env.HUMANIZE_TASK_RUN_ID ?? `${modelId}-${enabled ? "on" : "off"}-${Date.now()}`;
assert(/^[a-zA-Z0-9._-]+$/.test(runId), "Invalid run id");
const workspace = resolve(repo, ".artifacts/full-task", runId, "workspace");
const outputPath = resolve(process.env.HUMANIZE_TASK_OUTPUT ?? resolve(repo, ".artifacts/full-task", `${runId}.json`));
const baseUrl = process.env.HUMANIZE_TASK_BASE_URL ?? "http://127.0.0.1:4142/v1";
const api = process.env.HUMANIZE_TASK_API === "openai-responses" ? "openai-responses" : "openai-completions";
assert(process.env.PI_HUMANIZE === undefined, "Unset PI_HUMANIZE: this experiment controls the setting explicitly.");
const limits = readFullTaskLimits(process.env);

interface Acceptance {
	passed: boolean;
	total: number;
	passedCount: number;
	checks: { id: string; label: string; passed: boolean; expected?: unknown; actual?: unknown; detail?: string }[];
	summary: unknown;
}
interface Phase {
	phase: string;
	request: unknown;
	systemPrompt: string;
	response: string;
	stopReason: string;
	durationMs: number;
	usage?: AssistantMessage["usage"];
	error?: string;
}
interface Event {
	id: string;
	sourceMessageId?: string;
	type: "user" | "assistant" | "tool" | "test";
	at: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	result?: unknown;
	isError?: boolean;
	durationMs?: number;
	errorStage?: "main-response" | "humanize" | "recording";
	review?: {
		status: "approved" | "failed";
		original: string;
		final: string | null;
		report?: HumanizeReport;
		phases: Phase[];
	};
}
interface RawResponse {
	id: string;
	state: "pending" | "received" | "unavailable";
	text: string;
	toolCalls: { id: string; name: string; arguments: unknown }[];
	stopReason: string;
	durationMs: number;
	usage?: AssistantMessage["usage"];
	error?: string;
}
interface Round {
	id: string;
	status: "running" | "completed" | "interrupted" | "error";
	durationMs: number;
	error?: string;
	initialAcceptance?: Acceptance;
	acceptance: Acceptance;
	events: Event[];
	files: { path: string; before: string | null; after: string | null }[];
	rawResponses: RawResponse[];
}
interface Task {
	id: string;
	title: string;
	description: string;
	rounds: { id: string; title: string; prompt: string; acceptance: string[]; reportCommand: string[] }[];
}
const taskSource = await readFile(resolve(fixture, "schema/task.json"), "utf8");
const task = JSON.parse(taskSource) as Task;
const systemPrompt =
	"你是负责交付一个现有小项目的开发助手。按用户需求阅读项目说明、检查代码和数据、修改实现、补充回归测试、实际运行测试和报表，并在完成后用中文向用户交代结果与限制。工具只允许访问当前实验项目；数据与业务说明只读。可使用 run_project 的 tests、report、acceptance 操作；acceptance 是独立于你编写测试的外部业务验收。遇到验收失败请检查原因并修复，不要修改输入数据或虚报成功。没有网络、npm 安装或任意 shell 工具。";
const emptyAcceptance = (): Acceptance => ({
	passed: false,
	total: 0,
	passedCount: 0,
	checks: [],
	summary: "尚未验收",
});
const started = Date.now();
const run = {
	id: runId,
	modelId,
	enabled,
	api,
	startedAt: new Date(started).toISOString(),
	finishedAt: "",
	durationMs: 0,
	status: "running" as "running" | "completed" | "interrupted" | "error",
	error: undefined as string | undefined,
	systemPrompt,
	seedHash: "",
	reviewPromptVersion: "reader-v2",
	source: {
		humanizeSha256: createHash("sha256")
			.update(await readFile(resolve(repo, "packages/coding-agent/src/core/humanize.ts")))
			.digest("hex"),
		runnerSha256: createHash("sha256")
			.update(await readFile(fileURLToPath(import.meta.url)))
			.digest("hex"),
		taskSha256: createHash("sha256").update(taskSource).digest("hex"),
		limitsConfigSha256: createHash("sha256")
			.update(await readFile(new URL("./humanize-full-task-limits.ts", import.meta.url)))
			.digest("hex"),
	},
	limits,
	rounds: [] as Round[],
};
let pendingWrite = Promise.resolve();
let recordingClosed = false;
function checkpoint(): void {
	if (recordingClosed) return;
	const json = `${JSON.stringify(run, null, 2).replaceAll(workspace, "<workspace>").replaceAll(repo, "<repo>")}\n`;
	pendingWrite = pendingWrite.then(() => writeFile(outputPath, json));
}
function log(value: unknown): void {
	console.log(JSON.stringify({ run: runId, ...(value as Record<string, unknown>) }));
}
function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
async function snapshot(): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new Error("Workspace symlinks are not supported");
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) files.set(relative(workspace, path), await readFile(path, "utf8"));
		}
	}
	await walk(workspace);
	return files;
}
await mkdir(dirname(outputPath), { recursive: true });
try {
	await lstat(workspace);
	throw new Error("Run workspace already exists; use a new run id to retain prior attempts.");
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
await cp(resolve(fixture, "seed"), workspace, { recursive: true });
const seed = await snapshot();
run.seedHash = createHash("sha256")
	.update(JSON.stringify([...seed].sort(([a], [b]) => a.localeCompare(b))))
	.digest("hex");
for (const folder of ["src", "test", "tests", "reports"]) await mkdir(resolve(workspace, folder), { recursive: true });
checkpoint();

let activeRound: Round;
let roundIndex = 0;
let agentCalls = 0;
interface Capture {
	round: Round;
	raw: RawResponse;
	original?: AssistantMessage;
	phases: Phase[];
	reportStartIndex: number;
	delivered: boolean;
}
let activeCapture: Capture | undefined;
let abortSession: () => void = () => {};
const writableRoots = ["src", "test", "tests", "reports"];
async function safePath(path: string, writing = false): Promise<string> {
	if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === "..") || path.includes("\0"))
		throw new Error("Use a relative path inside this project.");
	const absolute = resolve(workspace, path);
	if (!absolute.startsWith(`${workspace}${sep}`)) throw new Error("Path must name a file inside this project.");
	if (writing && !writableRoots.some((folder) => path.startsWith(`${folder}/`)) && path !== "README.md")
		throw new Error(
			"Only src/, test/, tests/, reports/ and README.md may be edited; inputs and business rules are read-only.",
		);
	let parent = absolute;
	while (parent !== workspace) {
		try {
			const actual = await realpath(parent);
			if (actual !== workspace && !actual.startsWith(`${workspace}${sep}`))
				throw new Error("Path escapes the project.");
			break;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			parent = dirname(parent);
		}
	}
	return absolute;
}
async function executeNode(
	args: string[],
	trustedVerifier = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const permissions = [
		"--permission",
		`--allow-fs-read=${workspace}`,
		...(trustedVerifier ? [`--allow-fs-read=${fixture}`, "--allow-child-process"] : []),
		...writableRoots.map((folder) => `--allow-fs-write=${resolve(workspace, folder)}`),
	];
	return new Promise((done) => {
		const child = spawn(process.execPath, [...permissions, ...args], {
			cwd: workspace,
			env: { PATH: dirname(process.execPath), LANG: "en_US.UTF-8", TZ: "UTC", NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), trustedVerifier ? 120_000 : 20_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.length > 100_000) child.kill("SIGKILL");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 100_000) child.kill("SIGKILL");
		});
		child.on("error", (error) => {
			stderr += error.message;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ exitCode: code ?? -1, stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 100_000) });
		});
	});
}
async function acceptance(): Promise<Acceptance> {
	const result = await executeNode([resolve(fixture, "verify.mjs"), workspace, String(roundIndex + 1)], true);
	try {
		const raw = JSON.parse(result.stdout) as { passed: boolean; checks: Acceptance["checks"]; summary: unknown };
		assert(Array.isArray(raw.checks));
		assert.equal(typeof raw.passed, "boolean");
		assert.equal(
			raw.passed,
			raw.checks.every((check) => check.passed === true),
		);
		assert.equal(result.exitCode, raw.passed ? 0 : 1);
		return { ...raw, total: raw.checks.length, passedCount: raw.checks.filter((check) => check.passed).length };
	} catch {
		return {
			passed: false,
			total: 1,
			passedCount: 0,
			checks: [
				{
					id: "verifier-error",
					label: "外部验收程序完成",
					passed: false,
					detail: `${result.stdout}\n${result.stderr}`,
				},
			],
			summary: "验收程序未能返回结果",
		};
	}
}
async function report(): Promise<unknown> {
	const command = task.rounds[roundIndex].reportCommand;
	assert.equal(command[0], "node");
	return executeNode(command.slice(1));
}
async function recordTool(id: string, name: string, args: unknown, action: () => Promise<unknown>) {
	const begin = Date.now();
	const round = activeRound;
	const event: Event = { id, type: "tool", at: new Date(begin).toISOString(), name, arguments: args };
	round.events.push(event);
	try {
		event.result = await action();
	} catch (error) {
		event.isError = true;
		event.result = error instanceof Error ? error.message : String(error);
	}
	event.durationMs = Date.now() - begin;
	checkpoint();
	log({ round: round.id, tool: name, durationMs: event.durationMs, error: event.isError ?? false });
	return { content: [{ type: "text" as const, text: JSON.stringify(event.result) }], details: {} };
}
function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition<T> {
	return tool;
}
const customTools: ToolDefinition[] = [
	defineTool({
		name: "list_files",
		label: "列出项目文件",
		description: "List files in this isolated project.",
		parameters: Type.Object({}),
		async execute(id, args) {
			return recordTool(id, "list_files", args, async () => [...(await snapshot()).keys()].sort());
		},
	}),
	defineTool({
		name: "read_file",
		label: "读取项目文件",
		description: "Read a UTF-8 project file by relative path.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(id, args) {
			return recordTool(id, "read_file", args, async () => readFile(await safePath(args.path), "utf8"));
		},
	}),
	defineTool({
		name: "write_file",
		label: "写入项目文件",
		description:
			"Write complete UTF-8 contents to src/, test/, tests/, reports/ or README.md. Data and business rules are read-only.",
		parameters: Type.Object({ path: Type.String(), content: Type.String({ maxLength: 100_000 }) }),
		async execute(id, args) {
			return recordTool(id, "write_file", args, async () => {
				const path = await safePath(args.path, true);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, args.content);
				return { path: args.path, bytes: Buffer.byteLength(args.content) };
			});
		},
	}),
	defineTool({
		name: "run_project",
		label: "运行项目检查",
		description:
			"Run tests (node --test), report (current round's input through src/cli.mjs), or acceptance (external business assertions). No arbitrary shell, network or subprocesses are available. Run report before acceptance to check generated artifacts.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("tests"), Type.Literal("report"), Type.Literal("acceptance")]),
		}),
		async execute(id, args) {
			return recordTool(id, "run_project", args, async () => {
				if (args.action === "report") return report();
				if (args.action === "acceptance") return acceptance();
				const paths = [...(await snapshot()).keys()].filter((path) =>
					/^(?:test|tests)\/.*\.(?:test|spec)\.(?:m?js)$/.test(path),
				);
				if (paths.length === 0)
					return { exitCode: 1, stderr: "No test/*.test.mjs or tests/*.test.mjs files exist." };
				return executeNode(["--test", "--test-isolation=none", ...paths.sort()]);
			});
		},
	}),
];

const provider = "humanize-full-task";
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
			maxTokens: 12_000,
		},
	],
});
const model = runtime.getModel(provider, modelId);
assert(model);
const manager = SessionManager.inMemory(workspace);
const streamSimple = runtime.streamSimple.bind(runtime);
runtime.streamSimple = (selected, context, options) => {
	const begin = Date.now();
	const isReview = options?.sessionId?.includes(":humanize:") === true;
	let phase: Phase | undefined;
	let capture: Capture;
	if (isReview) {
		assert(activeCapture && !activeCapture.delivered, "Review must belong to an unfinished main response");
		capture = activeCapture;
		const user = context.messages.find((message) => message.role === "user");
		const system = context.messages.find((message) => message.role === "system");
		assert(user && typeof user.content === "string");
		const payload = JSON.parse(user.content) as Record<string, unknown>;
		if (payload.phase === "review")
			assert.deepEqual(Object.keys(payload).sort(), ["draft", "phase", "visibleMessages"]);
		phase = {
			phase: String(payload.phase),
			request: payload,
			systemPrompt: system && typeof system.content === "string" ? system.content : "",
			response: "",
			stopReason: "pending",
			durationMs: 0,
		};
		capture.phases.push(phase);
	} else {
		agentCalls++;
		const raw: RawResponse = {
			id: `r${activeRound.id}-message-${agentCalls}`,
			state: "pending",
			text: "",
			toolCalls: [],
			stopReason: "pending",
			durationMs: 0,
		};
		capture = {
			round: activeRound,
			raw,
			phases: [],
			reportStartIndex: manager.getEntries().length,
			delivered: false,
		};
		activeCapture = capture;
		capture.round.rawResponses.push(raw);
		if (agentCalls > run.limits.maxAgentCallsPerRound) abortSession();
	}
	// Every callback closes over its own request and round. A late provider result
	// cannot overwrite the next message's original draft or attach to another round.
	const stream = streamSimple(selected, context, {
		...options,
		timeoutMs: run.limits.requestTimeoutMs,
		maxRetries: 0,
		transport: "sse",
		cacheRetention: "none",
		maxTokens: isReview ? 8192 : 12_000,
	});
	void stream
		.result()
		.then((message) => {
			if (recordingClosed || capture.delivered) return;
			if (phase) {
				Object.assign(phase, {
					response: textOf(message),
					stopReason: message.stopReason,
					durationMs: Date.now() - begin,
					usage: message.usage,
					error: message.errorMessage,
				});
			} else {
				capture.original = message;
				Object.assign(capture.raw, {
					state: "received",
					text: textOf(message),
					toolCalls: message.content
						.filter((block) => block.type === "toolCall")
						.map((block) => ({ id: block.id, name: block.name, arguments: block.arguments })),
					stopReason: message.stopReason,
					durationMs: Date.now() - begin,
					usage: message.usage,
					error: message.errorMessage,
				});
			}
			checkpoint();
			log({
				round: capture.round.id,
				messageId: capture.raw.id,
				phase: phase?.phase ?? "agent",
				stopReason: message.stopReason,
				durationMs: Date.now() - begin,
			});
		})
		.catch((error: unknown) => {
			if (recordingClosed || capture.delivered) return;
			const detail = error instanceof Error ? error.message : String(error);
			if (phase) Object.assign(phase, { stopReason: "error", error: detail, durationMs: Date.now() - begin });
			else Object.assign(capture.raw, { state: "unavailable", error: detail, durationMs: Date.now() - begin });
			checkpoint();
		});
	return stream;
};
const settings = SettingsManager.inMemory({
	humanize: {
		enabled,
		maxRevisions: run.limits.maxRevisions,
		timeoutMs: run.limits.reviewTimeoutMs,
		maxContextChars: 48_000,
	},
	cacheWarming: "off",
	retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: run.limits.requestTimeoutMs } },
	compaction: { enabled: false },
	enableAnalytics: false,
	enableInstallTelemetry: false,
});
const loader = new DefaultResourceLoader({
	cwd: workspace,
	agentDir: workspace,
	settingsManager: settings,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	systemPrompt,
});
await loader.reload();
const { session } = await createAgentSession({
	cwd: workspace,
	agentDir: workspace,
	model,
	modelRuntime: runtime,
	settingsManager: settings,
	sessionManager: manager,
	resourceLoader: loader,
	tools: customTools.map((tool) => tool.name),
	customTools,
	thinkingLevel: "off",
});
abortSession = () => {
	void session.abort();
};
session.subscribe((event) => {
	if (event.type !== "message_end" || event.message.role !== "assistant") return;
	const capture = activeCapture;
	assert(capture && !capture.delivered, "Every delivered assistant message must have a unique source request");
	const message = event.message;
	const original = capture.original;
	const text = textOf(message);
	capture.delivered = true;
	if (capture.raw.state === "pending") {
		capture.raw.state = "unavailable";
		capture.raw.error = "Provider response did not settle before public completion or cancellation.";
	}
	if (!text && message.stopReason === "toolUse") {
		checkpoint();
		return;
	}
	const result: Event = {
		id: capture.raw.id,
		sourceMessageId: capture.raw.id,
		type: "assistant",
		at: new Date().toISOString(),
		text,
		isError: !["stop", "toolUse"].includes(message.stopReason),
	};
	const validOriginal = original && ["stop", "toolUse"].includes(original.stopReason) && textOf(original).trim();
	if (enabled && validOriginal && capture.phases.length > 0) {
		const entries = manager
			.getEntries()
			.slice(capture.reportStartIndex)
			.filter((entry) => entry.type === "custom" && entry.customType === "humanize");
		assert(entries.length <= 1, "A source response must not consume another response's review report");
		const entry = entries[0];
		const report = entry?.type === "custom" ? (entry.data as HumanizeReport) : undefined;
		result.review = {
			status: result.isError ? "failed" : "approved",
			original: capture.raw.text,
			final: result.isError ? null : text,
			report,
			phases: structuredClone(capture.phases),
		};
		if (result.isError) result.errorStage = "humanize";
	} else if (result.isError) {
		result.errorStage = original ? "main-response" : "recording";
	}
	if (result.isError) result.result = message.errorMessage ?? "模型输出未完成";
	capture.round.events.push(result);
	checkpoint();
});

try {
	for (const [index, requirement] of task.rounds.entries()) {
		roundIndex = index;
		agentCalls = 0;
		activeCapture = undefined;
		const roundStarted = Date.now();
		activeRound = {
			id: requirement.id,
			status: "running",
			durationMs: 0,
			acceptance: emptyAcceptance(),
			events: [],
			files: [],
			rawResponses: [],
		};
		run.rounds.push(activeRound);
		const before = await snapshot();
		activeRound.initialAcceptance = await acceptance();
		activeRound.events.push({
			id: `r${requirement.id}-user`,
			type: "user",
			at: new Date().toISOString(),
			text: requirement.prompt,
		});
		checkpoint();
		log({
			round: requirement.id,
			started: true,
			initialChecks: `${activeRound.initialAcceptance.passedCount}/${activeRound.initialAcceptance.total}`,
		});
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			abortSession();
		}, run.limits.roundTimeoutMs);
		const limitError = () =>
			expired
				? `达到本轮时限（${run.limits.roundTimeoutMs / 1_000} 秒）`
				: agentCalls > run.limits.maxAgentCallsPerRound
					? `超过本轮 ${run.limits.maxAgentCallsPerRound} 次主模型调用上限`
					: undefined;
		try {
			await session.prompt(requirement.prompt);
			const final = session.messages.findLast((message) => message.role === "assistant");
			const interruption = limitError();
			activeRound.status = interruption
				? "interrupted"
				: final?.role === "assistant" && final.stopReason === "stop"
					? "completed"
					: "error";
			if (activeRound.status !== "completed")
				activeRound.error =
					interruption ??
					(final?.role === "assistant"
						? (final.errorMessage ?? `输出结束原因：${final.stopReason}`)
						: "没有完成的模型回复");
		} catch (error) {
			const interruption = limitError();
			activeRound.status = interruption ? "interrupted" : "error";
			activeRound.error = interruption ?? (error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(timer);
		}
		// Do not generate missing deliverables for the agent. External checks observe
		// exactly the files it left behind, even if its final message was withheld.
		activeRound.acceptance = await acceptance();
		activeRound.events.push({
			id: `r${requirement.id}-acceptance`,
			type: "test",
			at: new Date().toISOString(),
			name: "外部业务验收",
			result: activeRound.acceptance,
			isError: !activeRound.acceptance.passed,
		});
		const after = await snapshot();
		for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
			if (before.get(path) !== after.get(path))
				activeRound.files.push({ path, before: before.get(path) ?? null, after: after.get(path) ?? null });
		}
		activeRound.durationMs = Date.now() - roundStarted;
		checkpoint();
		log({
			round: requirement.id,
			status: activeRound.status,
			checks: `${activeRound.acceptance.passedCount}/${activeRound.acceptance.total}`,
			files: activeRound.files.length,
		});
		if (activeRound.status !== "completed") break;
	}
	run.status =
		run.rounds.length === task.rounds.length && run.rounds.every((round) => round.status === "completed")
			? "completed"
			: "interrupted";
} catch (error) {
	run.status = "error";
	run.error = error instanceof Error ? error.message : String(error);
} finally {
	session.dispose();
	run.finishedAt = new Date().toISOString();
	run.durationMs = Date.now() - started;
	checkpoint();
	recordingClosed = true;
	await pendingWrite;
	log({ finished: true, status: run.status, durationMs: run.durationMs, output: outputPath });
}
