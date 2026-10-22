import { setImmediate } from "node:timers/promises";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxThinking,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { HUMANIZE_TRACE_TYPE, type HumanizeTrace } from "../../src/core/humanize-records.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText } from "./harness.ts";

const clear = JSON.stringify({ clear: true, needsContext: false, issues: [] });
function request(context: TranscriptContext): Record<string, unknown> {
	return JSON.parse(getMessageText(context.messages.findLast((message) => message.role === "user"))) as Record<
		string,
		unknown
	>;
}

describe("AgentSession opt-in Humanize traces", () => {
	const cleanups: Array<() => void> = [];
	beforeEach(() => vi.stubEnv("PI_HUMANIZE", ""));
	afterEach(() => {
		vi.unstubAllEnvs();
		while (cleanups.length) cleanups.pop()?.();
	});
	async function setup(
		humanize: Settings["humanize"] = { enabled: true, record: true },
		extensions: ExtensionFactory[] = [],
	) {
		const harness = await createHarness({
			models: [{ id: "main" }, { id: "reader" }],
			settings: { humanize, cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } },
		});
		cleanups.push(harness.cleanup);
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader({
				extensionsResult: await createTestExtensionsResult(extensions, harness.tempDir),
			}),
			tools: [],
		});
		cleanups.push(() => session.dispose());
		await session.bindExtensions({});
		const traces = () =>
			harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === HUMANIZE_TRACE_TYPE ? [entry.data as HumanizeTrace] : [],
				);
		return { harness, session, traces };
	}

	it("records exact original/final and all review phases while staying out of model context", async () => {
		const { harness, session, traces } = await setup({
			enabled: true,
			record: true,
			provider: "faux",
			model: "reader",
		});
		harness.setResponses([
			fauxAssistantMessage([fauxThinking("PRIVATE_THOUGHT"), { type: "text", text: "FCP is complete." }]),
			(context) => {
				expect(request(context)).toMatchObject({ phase: "review", draft: "FCP is complete." });
				expect(JSON.stringify(context)).not.toContain("PRIVATE_THOUGHT");
				return fauxAssistantMessage(
					JSON.stringify({ clear: false, needsContext: false, issues: ["Explain FCP."] }),
				);
			},
			fauxAssistantMessage(JSON.stringify({ text: "The configuration update is complete." })),
			fauxAssistantMessage(clear),
		]);
		await session.prompt("Update the configuration.");
		const [trace] = traces();
		expect(traces()).toHaveLength(1);
		expect(trace).toMatchObject({
			sessionId: harness.sessionManager.getSessionId(),
			original: "FCP is complete.",
			final: "The configuration update is complete.",
			reviewedFinal: "The configuration update is complete.",
			deliveryChanged: false,
			status: "approved",
			error: null,
			readerModel: { provider: "faux", id: "reader" },
		});
		expect(trace.phases.map((phase) => phase.phase)).toEqual(["review", "rewrite", "review"]);
		for (const phase of trace.phases) {
			expect(phase.durationMs).toBeGreaterThanOrEqual(0);
			expect(phase.usage).toBeDefined();
			expect(phase.response).not.toBeNull();
		}
		expect(trace.report).toMatchObject({ status: "approved", revisions: 1, calls: 3 });
		expect(harness.sessionManager.getEntry(trace.messageEntryId)).toMatchObject({
			type: "message",
			message: { content: expect.arrayContaining([{ type: "text", text: trace.final }]) },
		});
		expect(JSON.stringify(trace)).not.toContain("PRIVATE_THOUGHT");
		expect(JSON.stringify(harness.sessionManager.buildSessionContext())).not.toContain(trace.traceId);
	});

	it.each([{ enabled: true }, { enabled: true, record: false }, { enabled: false, record: true }])(
		"does not record when disabled or opted out: %j",
		async (settings) => {
			const { harness, session, traces } = await setup(settings);
			harness.setResponses(
				settings.enabled
					? [fauxAssistantMessage("Done."), fauxAssistantMessage(clear)]
					: [fauxAssistantMessage("Done.")],
			);
			await session.prompt("Update.");
			expect(traces()).toEqual([]);
		},
	);

	it("records failed review with the original but no released final, and distinguishes missing reader from main API failure", async () => {
		const { harness, session, traces } = await setup();
		harness.setResponses([fauxAssistantMessage("Held draft."), fauxAssistantMessage("Invalid JSON")]);
		await session.prompt("Explain.");
		expect(traces()[0]).toMatchObject({
			original: "Held draft.",
			status: "failed",
			final: null,
			reviewedFinal: null,
			report: { status: "failed", calls: 1 },
		});
		expect(traces()[0].error).toBeTruthy();
		expect(traces()[0].phases[0].response).toBe("Invalid JSON");
		const missing = await setup({ enabled: true, record: true, model: "not-configured" });
		missing.harness.setResponses([fauxAssistantMessage("Another held draft.")]);
		await missing.session.prompt("Explain.");
		expect(missing.traces()[0]).toMatchObject({
			status: "failed",
			final: null,
			readerModel: null,
			phases: [],
			error: "Humanize reader model is not configured.",
		});
		const upstream = await setup();
		upstream.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Main API failed" }),
		]);
		await upstream.session.prompt("Explain.");
		expect(upstream.traces()).toEqual([]);
	});

	it("freezes cancelled traces and prevents late completions from leaking into a replacement session", async () => {
		const { harness, session, traces } = await setup();
		let started!: () => void;
		const readerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let complete!: (message: AssistantMessage) => void;
		const late = new Promise<AssistantMessage>((resolve) => {
			complete = resolve;
		});
		harness.setResponses([
			fauxAssistantMessage("Held draft."),
			() => {
				started();
				return late;
			},
		]);
		const prompt = session.prompt("Explain.");
		await readerStarted;
		await session.abort();
		await prompt;
		const saved = traces()[0];
		expect(saved).toMatchObject({ status: "failed", final: null, original: "Held draft." });
		const frozen = structuredClone(saved);
		harness.sessionManager.newSession();
		const replacement = harness.sessionManager.getBranch();
		complete(fauxAssistantMessage(clear));
		await setImmediate();
		expect(saved).toEqual(frozen);
		expect(harness.sessionManager.getBranch()).toEqual(replacement);
		expect(traces()).toEqual([]);
	});
	it("keeps two identical drafts linked to separate turns when trace entries advance the leaf", async () => {
		const endedIds: string[] = [];
		const { harness, session, traces } = await setup({ enabled: true, record: true }, [
			(pi) => {
				pi.on("turn_end", (event) => {
					endedIds.push(event.messageEntryId);
				});
			},
		]);
		harness.setResponses([
			fauxAssistantMessage("Done."),
			fauxAssistantMessage(clear),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage(clear),
		]);
		await session.prompt("First request.");
		await session.prompt("Second request.");
		const saved = traces();
		expect(saved).toHaveLength(2);
		expect(saved.map((trace) => trace.messageEntryId)).toEqual(endedIds);
		expect(new Set(saved.map((trace) => trace.traceId)).size).toBe(2);
		expect(saved[1].visibleMessages).toEqual([
			{ role: "user", text: "First request." },
			{ role: "assistant", text: "Done." },
			{ role: "user", text: "Second request." },
		]);
		expect(saved[0].original).toBe(saved[1].original);
	});

	it("links the message_end extension replacement to the original trace", async () => {
		const { harness, session, traces } = await setup({ enabled: true, record: true }, [
			(pi) => {
				pi.on("message_end", (event) => {
					if (event.message.role === "assistant")
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "Extension changed the visible answer." }],
							},
						};
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("Approved answer."), fauxAssistantMessage(clear)]);
		await session.prompt("Explain.");
		expect(traces()).toHaveLength(1);
		expect(traces()[0]).toMatchObject({
			original: "Approved answer.",
			reviewedFinal: "Approved answer.",
			final: "Extension changed the visible answer.",
			deliveryChanged: true,
		});
	});

	it("records lookup from the exact readable snapshot only after the blind reader requests it", async () => {
		const { harness, session, traces } = await setup();
		harness.sessionManager.appendMessage(fauxAssistantMessage(fauxThinking("PRIVATE_THOUGHT")));
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			isError: false,
			timestamp: 1,
			content: [
				{ type: "text", text: "PRIVATE_EXECUTION: FCP means file configuration patch." },
				{ type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE" },
			],
		});
		session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("FCP is complete."),
			(context) => {
				expect(JSON.stringify(context)).not.toContain("PRIVATE_EXECUTION");
				return fauxAssistantMessage(JSON.stringify({ clear: false, needsContext: true, issues: ["Explain FCP."] }));
			},
			(context) => {
				expect(request(context).phase).toBe("lookup");
				expect(JSON.stringify(request(context))).toContain("PRIVATE_EXECUTION");
				return fauxAssistantMessage(JSON.stringify({ facts: ["FCP means file configuration patch."] }));
			},
			fauxAssistantMessage(JSON.stringify({ text: "The file configuration patch is complete." })),
			fauxAssistantMessage(clear),
		]);
		await session.prompt("Explain the completed update.");
		const [trace] = traces();
		expect(trace.status).toBe("approved");
		expect(trace.phases.map((phase) => phase.phase)).toEqual(["review", "lookup", "rewrite", "review"]);
		expect(JSON.stringify(trace.executionMessages)).toContain("PRIVATE_EXECUTION");
		expect(JSON.stringify(trace)).not.toContain("PRIVATE_THOUGHT");
		expect(JSON.stringify(trace)).not.toContain("PRIVATE_IMAGE");
		expect(JSON.stringify(trace.phases[0])).not.toContain("PRIVATE_EXECUTION");
	});

	it("records timeouts without accepting a late approval", async () => {
		const { harness, session, traces } = await setup({ enabled: true, record: true, timeoutMs: 10 });
		let complete!: (message: AssistantMessage) => void;
		const late = new Promise<AssistantMessage>((resolve) => {
			complete = resolve;
		});
		harness.setResponses([fauxAssistantMessage("Held draft."), () => late]);
		await session.prompt("Explain.");
		const saved = traces()[0];
		expect(saved).toMatchObject({ status: "failed", final: null, reviewedFinal: null });
		expect(saved.error?.toLowerCase()).toContain("timed out");
		const frozen = structuredClone(saved);
		complete(fauxAssistantMessage(clear));
		await setImmediate();
		expect(saved).toEqual(frozen);
	});
	it("keeps an incomplete main reply as a diagnostic failure with zero reader calls", async () => {
		const { harness, session, traces } = await setup();
		harness.setResponses([fauxAssistantMessage("Truncated draft.", { stopReason: "length" })]);
		await session.prompt("Explain.");
		expect(traces()).toHaveLength(1);
		expect(traces()[0]).toMatchObject({
			original: "Truncated draft.",
			originalMessage: { stopReason: "length" },
			status: "failed",
			final: null,
			reviewedFinal: null,
			phases: [],
			report: { calls: 0 },
			error: "Humanize requires a completed text message.",
		});
		expect(harness.faux.state.callCount).toBe(1);
	});
});
