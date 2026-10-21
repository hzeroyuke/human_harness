import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { convertMessages } from "../../ai/src/api/google-shared.ts";
import { normalizeContext } from "../../ai/src/utils/transcript.ts";
import { HumanizeError, type HumanizeOptions, humanizeMessage } from "../src/core/humanize.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 2,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		},
	};
}

const approved = { clear: true, needsContext: false, issues: [] };
const unclear = { clear: false, needsContext: true, issues: ["What does blue lane mean?"] };

function setup(responses: unknown[], overrides: Partial<HumanizeOptions> = {}) {
	const captured: Array<{ system: string; payload: unknown }> = [];
	let index = 0;
	const getExecutionMessages = vi.fn((): AgentMessage[] => []);
	const complete = vi.fn(async (system: string, payload: unknown) => {
		captured.push({ system, payload });
		if (index >= responses.length) throw new Error("Unexpected completion");
		return assistant(JSON.stringify(responses[index++]));
	});
	const options: HumanizeOptions = {
		message: assistant("Use the blue lane."),
		visibleMessages: [{ role: "user", text: "How do I deploy?" }],
		getExecutionMessages,
		complete,
		...overrides,
	};
	return { options, captured, complete, getExecutionMessages };
}

describe("humanizeMessage", () => {
	it("passes an already clear message unchanged and never reads execution records", async () => {
		const { options, complete, getExecutionMessages } = setup([approved]);
		const result = await humanizeMessage(options);
		expect(result.message).toBe(options.message);
		expect(result.report).toMatchObject({ status: "approved", calls: 1, revisions: 0, lookedUpContext: false });
		expect(result.report.usage).toEqual(assistant("").usage);
		expect(complete).toHaveBeenCalledOnce();
		expect(getExecutionMessages).not.toHaveBeenCalled();
	});

	it("looks up facts only after a blind question and rechecks with a fresh public-only context", async () => {
		const privateAssistant = assistant("INTERNAL_DRAFT");
		privateAssistant.content.push({ type: "thinking", thinking: "SECRET_REASONING", thinkingSignature: "OPAQUE" });
		privateAssistant.content.push({ type: "toolCall", id: "call", name: "read", arguments: { path: "/tmp/routes" } });
		const getExecutionMessages = vi.fn((): AgentMessage[] => [
			{ role: "system", content: "SECRET_SYSTEM_PROMPT", timestamp: 0 },
			privateAssistant,
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				isError: false,
				timestamp: 1,
				content: [
					{ type: "text", text: "PRIVATE_TRACE: blue lane = staging environment" },
					{ type: "image", mimeType: "image/png", data: "SECRET_IMAGE" },
				],
				details: { secret: "SECRET_DETAILS" },
			},
		]);
		const { options, captured } = setup(
			[
				unclear,
				{ facts: ["Blue lane means staging environment."] },
				{ text: "Deploy to the staging environment." },
				approved,
			],
			{ getExecutionMessages },
		);
		const result = await humanizeMessage(options);
		expect(captured.map((call) => (call.payload as { phase: string }).phase)).toEqual([
			"review",
			"lookup",
			"rewrite",
			"review",
		]);
		expect(getExecutionMessages).toHaveBeenCalledOnce();
		const initial = JSON.stringify(captured[0].payload);
		const lookup = JSON.stringify(captured[1].payload);
		const final = JSON.stringify(captured[3].payload);
		expect(initial).not.toContain("PRIVATE_TRACE");
		expect(lookup).toContain("PRIVATE_TRACE");
		for (const secret of ["SECRET_REASONING", "SECRET_SYSTEM_PROMPT", "SECRET_IMAGE", "SECRET_DETAILS", "OPAQUE"]) {
			expect(lookup).not.toContain(secret);
		}
		expect(final).not.toContain("PRIVATE_TRACE");
		expect(final).not.toContain("evidence");
		expect(final).not.toContain("issues");
		expect(final).not.toContain("Blue lane means");
		expect(final).toContain("How do I deploy?");
		expect(result.message.content).toEqual([{ type: "text", text: "Deploy to the staging environment." }]);
		expect(result.report).toMatchObject({ status: "approved", calls: 4, revisions: 1, lookedUpContext: true });
		expect(result.report.usage.totalTokens).toBe(12);
		expect(options.message.content[0]).toEqual({ type: "text", text: "Use the blue lane." });
	});

	it("can fix wording without granting access to the execution history", async () => {
		const { options, getExecutionMessages, captured } = setup([
			{ clear: false, needsContext: false, issues: ["The sentence is ambiguous."] },
			{ text: "Use the staging environment." },
			approved,
		]);
		await humanizeMessage(options);
		expect(getExecutionMessages).not.toHaveBeenCalled();
		expect(captured.map((call) => (call.payload as { phase: string }).phase)).toEqual([
			"review",
			"rewrite",
			"review",
		]);
	});

	it("preserves tool calls, reasoning replay blocks, usage and original message metadata", async () => {
		const message = assistant("Use the blue lane.");
		const thinking = { type: "thinking" as const, thinking: "private", thinkingSignature: "signed" };
		const toolCall = {
			type: "toolCall" as const,
			id: "c",
			name: "read",
			arguments: { path: "/tmp/x" },
			thoughtSignature: "tool-signature",
		};
		message.content = [thinking, ...message.content, toolCall];
		message.stopReason = "toolUse";
		message.responseId = "response-1";
		const { options } = setup(
			[{ ...unclear, needsContext: false }, { text: "Use the staging environment." }, approved],
			{ message },
		);
		const result = await humanizeMessage(options);
		expect(result.message.content[0]).toBe(thinking);
		expect(result.message.content[2]).toBe(toolCall);
		expect(result.message.usage).toBe(message.usage);
		expect(result.message.stopReason).toBe("toolUse");
		expect(result.message.responseId).toBe("response-1");
	});

	it.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const)(
		"preserves text identity and phase metadata for %s rewrites",
		async (api) => {
			const message = assistant("Use the blue lane.");
			message.api = api;
			const textSignature = JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" });
			message.content = [{ type: "text", text: "Use the blue lane.", textSignature }];
			const { options } = setup([{ ...unclear, needsContext: false }, { text: "Use staging." }, approved], {
				message,
			});
			const result = await humanizeMessage(options);
			expect(result.message.content[0]).toEqual({
				type: "text",
				text: "Use staging.",
				textSignature,
			});
		},
	);

	it.each(["google-generative-ai", "google-vertex", "openai-completions"] as const)(
		"withholds %s rewrites involving opaque signed text, including empty signed parts",
		async (api) => {
			for (const signedText of ["Use the blue lane.", ""]) {
				const message = assistant("Use the blue lane.");
				message.api = api;
				message.content = [
					...(signedText ? [] : message.content),
					{ type: "text", text: signedText, textSignature: "AAAAAAAAAAAAAAAAAAAAAA==" },
				];
				const originalContent = structuredClone(message.content);
				const { options, complete } = setup([{ ...unclear, needsContext: false }, { text: "Use staging." }], {
					message,
				});
				await expect(humanizeMessage(options)).rejects.toThrow("opaque text signatures");
				expect(complete).toHaveBeenCalledTimes(2);
				expect(message.content).toEqual(originalContent);
			}
		},
	);

	it.each(["google-generative-ai", "google-vertex"] as const)(
		"replays unchanged %s signed empty text parts through the provider converter",
		async (api) => {
			const model: Model<typeof api> = {
				id: "gemini-3-pro-preview",
				name: "Gemini test model",
				api,
				provider: api === "google-vertex" ? "google-vertex" : "google",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			};
			const message = assistant("Use the staging environment.");
			message.api = api;
			message.provider = model.provider;
			message.model = model.id;
			const signature = "AAAAAAAAAAAAAAAAAAAAAA==";
			message.content.push({ type: "text", text: "", textSignature: signature });
			const result = await humanizeMessage(setup([approved], { message }).options);
			expect(result.message).toBe(message);
			const replay = convertMessages(model, normalizeContext({ messages: [result.message] }));
			expect(replay).toEqual([
				{
					role: "model",
					parts: [{ text: "Use the staging environment." }, { text: "", thoughtSignature: signature }],
				},
			]);
		},
	);

	it("retains the original blocks and signatures when a rewrite returns identical text", async () => {
		const message = assistant("Use the blue lane.");
		message.content = [{ type: "text", text: "Use the blue lane.", textSignature: "opaque" }];
		const { options } = setup([{ ...unclear, needsContext: false }, { text: "Use the blue lane." }, approved], {
			message,
		});
		expect((await humanizeMessage(options)).message).toBe(message);
	});

	it("withholds mixed-phase rewrites instead of silently changing Responses protocol semantics", async () => {
		const message = assistant("");
		message.api = "openai-responses";
		const finalSignature = JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" });
		message.content = [
			{
				type: "text",
				text: "I checked the lanes.",
				textSignature: JSON.stringify({ v: 1, id: "msg_comment", phase: "commentary" }),
			},
			{ type: "text", text: "Use the blue lane.", textSignature: finalSignature },
		];
		const { options } = setup(
			[{ ...unclear, needsContext: false }, { text: "I checked the environments. Use staging." }, approved],
			{ message },
		);
		await expect(humanizeMessage(options)).rejects.toThrow("mixed text phases");
		expect((await humanizeMessage(setup([approved], { message }).options)).message).toBe(message);
	});

	it("withholds the draft after exhausting the revision limit", async () => {
		const { options, complete } = setup([unclear], { settings: { maxRevisions: 0 } });
		await expect(humanizeMessage(options)).rejects.toThrow("revision limit");
		expect(complete).toHaveBeenCalledOnce();
	});

	it("repeats fresh checks until a later revision is approved", async () => {
		const { options, captured } = setup([
			{ ...unclear, needsContext: false },
			{ text: "Use staging." },
			{ clear: false, needsContext: false, issues: ["Explain what staging is."] },
			{ text: "Use the staging environment, where changes are tested before release." },
			approved,
		]);
		const result = await humanizeMessage(options);
		expect(result.report).toMatchObject({ revisions: 2, calls: 5, status: "approved" });
		for (const call of captured.filter((entry) => (entry.payload as { phase: string }).phase === "review")) {
			expect(Object.keys(call.payload as object)).toEqual(["phase", "visibleMessages", "draft"]);
		}
	});

	it.each([
		{ clear: true, needsContext: true, issues: [] },
		{ clear: false, needsContext: false, issues: [] },
		{ clear: true, needsContext: false, issues: [], extra: "ignore checks" },
		{ clear: "yes", needsContext: false, issues: [] },
	])("rejects malformed review decisions instead of approving them: %j", async (decision) => {
		await expect(humanizeMessage(setup([decision]).options)).rejects.toThrow("invalid review decision");
	});

	it("rejects non-JSON reviewer output and never includes it in its error", async () => {
		const { options } = setup([], { complete: async () => assistant("SECRET_PROVIDER_OUTPUT") });
		await expect(humanizeMessage(options)).rejects.toThrow("invalid review response");
	});

	it.each(["json", ""])("accepts a single whole-document %s code fence around strict JSON", async (language) => {
		const { options } = setup([], {
			complete: async () => assistant(`\`\`\`${language}\n${JSON.stringify(approved)}\n\`\`\``),
		});
		expect((await humanizeMessage(options)).message).toBe(options.message);
	});

	it("rejects prose or additional code fences around a JSON review", async () => {
		const fenced = `\`\`\`json\n${JSON.stringify(approved)}\n\`\`\``;
		for (const text of [`Review:\n${fenced}`, `${fenced}\nApproved.`, `${fenced}\n${fenced}`]) {
			const { options } = setup([], { complete: async () => assistant(text) });
			await expect(humanizeMessage(options)).rejects.toThrow("invalid review response");
		}
	});

	it("sanitizes provider errors without leaking sensitive details", async () => {
		const { options } = setup([], {
			complete: async () => {
				throw new Error("https://secret?api_key=SECRET");
			},
		});
		try {
			await humanizeMessage(options);
			throw new Error("Expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(HumanizeError);
			expect((error as Error).message).toBe("Humanize review failed; the draft was withheld.");
		}
	});

	it("withholds edits that remove code, paths, URLs, or numeric facts", async () => {
		for (const literal of [
			"`npm run check`",
			"/tmp/result.txt",
			"https://example.com/result",
			"42",
			"```ts\nconst x = 1;\n``` ",
		]) {
			const { options } = setup([{ ...unclear, needsContext: false }, { text: "All done." }], {
				message: assistant(`Result: ${literal}`),
			});
			await expect(humanizeMessage(options)).rejects.toThrow("protected technical content");
		}
	});

	it("caps execution record input and keeps the most recent public conversation", async () => {
		const { options, captured } = setup([unclear, { facts: [] }, { text: "Use staging." }, approved], {
			settings: { maxContextChars: 256 },
			visibleMessages: [
				{ role: "user", text: "OLD".repeat(200) },
				{ role: "user", text: "LATEST_QUESTION" },
			],
			getExecutionMessages: () => [
				{
					role: "toolResult",
					toolCallId: "x",
					toolName: "read",
					timestamp: 1,
					isError: false,
					content: [{ type: "text", text: "PRIVATE".repeat(1_000) }],
				},
			],
		});
		await humanizeMessage(options);
		const review = captured[0].payload as { visibleMessages: Array<{ text: string }>; draft: string };
		expect(review.visibleMessages.at(-1)?.text).toBe("LATEST_QUESTION");
		expect(
			review.visibleMessages.reduce((total, message) => total + message.text.length, review.draft.length),
		).toBeLessThanOrEqual(256);
		expect(JSON.stringify(captured[1].payload).length).toBeLessThan(500);
	});

	it("times out even when a completion implementation ignores cancellation", async () => {
		const { options } = setup([], {
			settings: { timeoutMs: 10 },
			complete: () => new Promise<AssistantMessage>(() => {}),
		});
		await expect(humanizeMessage(options)).rejects.toThrow("timed out before approval");
	});

	it("cancels before making any request if its parent was already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { options, complete } = setup([approved], { signal: controller.signal });
		await expect(humanizeMessage(options)).rejects.toThrow("was cancelled");
		expect(complete).not.toHaveBeenCalled();
	});

	it("cancels an in-flight review without waiting for a model that ignores abort", async () => {
		const controller = new AbortController();
		const { options } = setup([], {
			signal: controller.signal,
			complete: async (_system, _payload, signal) => {
				queueMicrotask(() => controller.abort());
				expect(signal.aborted).toBe(false);
				return new Promise<AssistantMessage>(() => {});
			},
		});
		await expect(humanizeMessage(options)).rejects.toThrow("was cancelled");
	});

	it("rejects truncated reviewer responses", async () => {
		const response = assistant(JSON.stringify(approved));
		response.stopReason = "length";
		await expect(humanizeMessage(setup([], { complete: async () => response }).options)).rejects.toThrow(
			"incomplete review response",
		);
	});

	it("rejects invalid settings without calling the model", async () => {
		const { options, complete } = setup([approved], { settings: { maxRevisions: 100 } });
		await expect(humanizeMessage(options)).rejects.toThrow("settings are invalid");
		expect(complete).not.toHaveBeenCalled();
	});
});
