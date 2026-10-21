import { setImmediate } from "node:timers/promises";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText } from "./harness.ts";

function payload(context: TranscriptContext): Record<string, unknown> {
	const user = context.messages.findLast((message) => message.role === "user");
	return JSON.parse(getMessageText(user)) as Record<string, unknown>;
}

function publicAssistantTexts(events: AgentSessionEvent[]): string[] {
	return events.flatMap((event) =>
		(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
		event.message.role === "assistant"
			? [getMessageText(event.message)]
			: [],
	);
}

const clear = JSON.stringify({ clear: true, needsContext: false, issues: [] });

describe("AgentSession humanized output", () => {
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		vi.stubEnv("PI_HUMANIZE", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function setup(settings: Partial<Settings> = {}, customTools: ToolDefinition[] = []) {
		const harness = await createHarness({
			models: [{ id: "main" }, { id: "reader" }],
			settings: {
				humanize: { enabled: true },
				cacheWarming: "off",
				retry: { enabled: false },
				compaction: { enabled: false },
				...settings,
			},
		});
		cleanups.push(harness.cleanup);
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			tools: customTools.map((tool) => tool.name),
			customTools,
		});
		cleanups.push(() => session.dispose());
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			// Snapshot at delivery time: later mutations must not hide an early draft leak.
			events.push(structuredClone(event));
		});
		return { harness, session, events };
	}

	it("rewrites before public delivery and saves the same approved text", async () => {
		const { harness, session, events } = await setup();
		const draft = "The FCP is complete.";
		const rewritten = "The configuration update is complete.";
		const phases: unknown[] = [];
		harness.setResponses([
			fauxAssistantMessage(draft),
			(context) => {
				const request = payload(context);
				phases.push(request.phase);
				expect(request.draft).toBe(draft);
				expect(request.visibleMessages).toContainEqual({ role: "user", text: "Update the configuration." });
				expect(getCurrentTools(context.messages)).toEqual([]);
				expect(publicAssistantTexts(events).filter(Boolean)).toEqual([]);
				return fauxAssistantMessage(
					JSON.stringify({
						clear: false,
						needsContext: false,
						issues: ["Replace the unexplained FCP abbreviation."],
					}),
				);
			},
			(context) => {
				const request = payload(context);
				phases.push(request.phase);
				expect(request.execution).toBeUndefined();
				expect(request.evidence).toBeUndefined();
				return fauxAssistantMessage(JSON.stringify({ text: rewritten }));
			},
			(context) => {
				const request = payload(context);
				phases.push(request.phase);
				expect(request.draft).toBe(rewritten);
				expect(JSON.stringify(context)).not.toContain("FCP");
				return fauxAssistantMessage(clear);
			},
		]);

		await session.prompt("Update the configuration.");

		expect(phases).toEqual(["review", "rewrite", "review"]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(publicAssistantTexts(events).join("\n")).not.toContain(draft);
		expect(publicAssistantTexts(events)).toContain(rewritten);
		expect(getMessageText(session.messages.findLast((message) => message.role === "assistant"))).toBe(rewritten);
		const persisted = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(persisted?.type === "message" ? getMessageText(persisted.message) : undefined).toBe(rewritten);
	});

	it("looks up tool records only after confusion and keeps every reader pass blind", async () => {
		const hiddenFact = "INTERNAL_FACT: ERP means the scheduled export retry process.";
		const hiddenThought = "PRIVATE_THOUGHT_SENTINEL";
		const toolArguments = { record: "private-export-record" };
		const executed: unknown[] = [];
		const lookup: ToolDefinition = {
			name: "lookup_record",
			label: "Lookup record",
			description: "Read a local execution record",
			parameters: Type.Object({ record: Type.String() }),
			execute: async (_id, args) => {
				executed.push(args);
				return { content: [{ type: "text", text: hiddenFact }], details: {} };
			},
		};
		const { harness, session } = await setup({}, [lookup]);
		const phases: unknown[] = [];
		const rewritten = "The scheduled export retry process is now aligned with the requested schedule.";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("lookup_record", toolArguments)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxThinking(hiddenThought), { type: "text", text: "ERP is aligned." }]),
			(context) => {
				const request = payload(context);
				phases.push(request.phase);
				expect(JSON.stringify(context)).not.toContain("INTERNAL_FACT");
				expect(JSON.stringify(context)).not.toContain(hiddenThought);
				expect(JSON.stringify(context)).not.toContain("private-export-record");
				return fauxAssistantMessage(JSON.stringify({ clear: false, needsContext: true, issues: ["What is ERP?"] }));
			},
			(context) => {
				const request = payload(context);
				phases.push(request.phase);
				expect(JSON.stringify(request)).toContain(hiddenFact);
				expect(JSON.stringify(request)).not.toContain(hiddenThought);
				return fauxAssistantMessage(JSON.stringify({ facts: ["ERP is the scheduled export retry process."] }));
			},
			(context) => {
				phases.push(payload(context).phase);
				return fauxAssistantMessage(JSON.stringify({ text: rewritten }));
			},
			(context) => {
				const request = payload(context);
				phases.push(request.phase);
				expect(request.draft).toBe(rewritten);
				expect(request.evidence).toBeUndefined();
				expect(request.execution).toBeUndefined();
				expect(request.issues).toBeUndefined();
				expect(JSON.stringify(context)).not.toContain("INTERNAL_FACT");
				expect(JSON.stringify(context)).not.toContain(hiddenThought);
				return fauxAssistantMessage(clear);
			},
		]);

		await session.prompt("Check the export schedule.");

		expect(phases).toEqual(["review", "lookup", "rewrite", "review"]);
		expect(executed).toEqual([toolArguments]);
		expect(harness.faux.state.callCount).toBe(6);
		expect(getMessageText(session.messages.findLast((message) => message.role === "assistant"))).toBe(rewritten);
	});

	it("reviews a tool-bearing update without changing the tool call or its arguments", async () => {
		const executed: unknown[] = [];
		const echo: ToolDefinition = {
			name: "echo",
			label: "Echo",
			description: "Echo a value",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (id, args) => {
				executed.push({ id, args });
				return { content: [{ type: "text", text: "Echo complete." }], details: {} };
			},
		};
		const { harness, session, events } = await setup({}, [echo]);
		const args = { value: "literal_123" };
		harness.setResponses([
			fauxAssistantMessage(
				[{ type: "text", text: "Starting the ECP." }, fauxToolCall("echo", args, { id: "echo-call" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				JSON.stringify({ clear: false, needsContext: false, issues: ["Explain the next action."] }),
			),
			fauxAssistantMessage(JSON.stringify({ text: "I will echo the value now." })),
			fauxAssistantMessage(clear),
			fauxAssistantMessage("The value was echoed successfully."),
			fauxAssistantMessage(clear),
		]);

		await session.prompt("Echo literal_123.");

		expect(executed).toEqual([{ id: "echo-call", args }]);
		expect(publicAssistantTexts(events).join("\n")).not.toContain("ECP");
		expect(publicAssistantTexts(events)).toContain("I will echo the value now.");
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("keeps ordinary streaming when disabled", async () => {
		const { harness, session, events } = await setup({ humanize: { enabled: false } });
		harness.setResponses([fauxAssistantMessage("The original answer.")]);

		await session.prompt("Hello.");

		expect(harness.faux.state.callCount).toBe(1);
		expect(publicAssistantTexts(events)).toContain("The original answer.");
		expect(events.some((event) => event.type === "message_update")).toBe(true);
	});

	it("uses prior visible dialogue without hidden extension context on continuation", async () => {
		const { harness, session } = await setup();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "In this task, ERP means export retry process." }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("I will use that definition."));
		harness.sessionManager.appendCustomMessageEntry("private-context", "HIDDEN_CONTEXT_SENTINEL", false);
		session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("ERP is configured."),
			(context) => {
				const request = payload(context);
				expect(request.visibleMessages).toEqual([
					{ role: "user", text: "In this task, ERP means export retry process." },
					{ role: "assistant", text: "I will use that definition." },
					{ role: "user", text: "Configure ERP." },
				]);
				expect(JSON.stringify(context)).not.toContain("HIDDEN_CONTEXT_SENTINEL");
				return fauxAssistantMessage(clear);
			},
		]);

		await session.prompt("Configure ERP.");

		expect(harness.faux.state.callCount).toBe(2);
		expect(getMessageText(session.messages.findLast((message) => message.role === "assistant"))).toBe(
			"ERP is configured.",
		);
	});

	it("does not release a rejected draft or execute its tool when review fails", async () => {
		let executions = 0;
		const echo: ToolDefinition = {
			name: "echo",
			label: "Echo",
			description: "Echo a value",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "Executed." }], details: {} };
			},
		};
		const { harness, session, events } = await setup({}, [echo]);
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: "UNREVIEWED_SENTINEL" }, fauxToolCall("echo", { value: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("This is not valid review JSON."),
		]);

		await session.prompt("Echo x.");

		expect(executions).toBe(0);
		expect(publicAssistantTexts(events).join("\n")).not.toContain("UNREVIEWED_SENTINEL");
		const final = session.messages.findLast((message) => message.role === "assistant");
		expect(final?.role === "assistant" ? final.stopReason : undefined).toBe("error");
	});

	it("does not send internal compaction summaries through the reader", async () => {
		const { harness, session } = await setup({ compaction: { enabled: false, keepRecentTokens: 8 } });
		for (let index = 0; index < 3; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `Earlier request ${index}.` }],
				timestamp: Date.now(),
			});
			harness.sessionManager.appendMessage(fauxAssistantMessage(`Earlier answer ${index}.`));
		}
		session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("Internal summary with an unexplained abbreviation ABC.")]);

		const result = await session.compact();

		expect(result.summary).toContain("ABC");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not record a late review completion in a replacement session", async () => {
		const { harness, session, events } = await setup();
		const originalSessionId = harness.sessionManager.getSessionId();
		let started!: () => void;
		const readerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let complete!: (message: AssistantMessage) => void;
		const lateResponse = new Promise<AssistantMessage>((resolve) => {
			complete = resolve;
		});
		let readerSessionId: string | undefined;
		harness.setResponses([
			fauxAssistantMessage("HELD_DRAFT_SENTINEL"),
			(_context, options) => {
				readerSessionId = options?.sessionId;
				started();
				// Simulate a provider that does not settle until after cancellation.
				return lateResponse;
			},
		]);

		const prompt = session.prompt("Explain the update.");
		await readerStarted;
		expect(readerSessionId?.startsWith(`${originalSessionId}:humanize:`)).toBe(true);
		await session.abort();
		await prompt;
		harness.sessionManager.newSession();
		const replacementSessionId = harness.sessionManager.getSessionId();
		expect(replacementSessionId).not.toBe(originalSessionId);
		const replacementEntries = harness.sessionManager.getBranch();

		complete(fauxAssistantMessage(clear));
		// Let the late provider response drain through the SDK's internal completion callback.
		await setImmediate();

		expect(harness.sessionManager.getSessionId()).toBe(replacementSessionId);
		expect(harness.sessionManager.getBranch()).toEqual(replacementEntries);
		expect(publicAssistantTexts(events).join("\n")).not.toContain("HELD_DRAFT_SENTINEL");
	});

	it("routes the reader to the configured model with an independent request id", async () => {
		const { harness, session } = await setup({ humanize: { enabled: true, provider: "faux", model: "reader" } });
		const requestedModels: string[] = [];
		const requestIds: Array<string | undefined> = [];
		harness.setResponses([
			(_context, options, _state, model) => {
				requestedModels.push(model.id);
				requestIds.push(options?.sessionId);
				return fauxAssistantMessage("The update is complete.");
			},
			(context, options, _state, model) => {
				requestedModels.push(model.id);
				requestIds.push(options?.sessionId);
				expect(getCurrentTools(context.messages)).toEqual([]);
				return fauxAssistantMessage(clear);
			},
		]);

		await session.prompt("Update the configuration.");

		expect(requestedModels).toEqual(["main", "reader"]);
		expect(requestIds[0]).toBe(harness.sessionManager.getSessionId());
		expect(requestIds[1]).not.toBe(requestIds[0]);
	});
});
