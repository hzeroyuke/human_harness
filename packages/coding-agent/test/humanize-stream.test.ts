import { setImmediate } from "node:timers/promises";
import { type AssistantMessage, type AssistantMessageEvent, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { describe, expect, it, vi } from "vitest";
import { humanizeStream } from "../src/core/humanize-stream.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function finish(source: AssistantMessageEventStream, message: AssistantMessage): void {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		source.push({ type: "error", reason: message.stopReason, error: message });
	} else if (message.stopReason !== "pending") {
		source.push({ type: "done", reason: message.stopReason, message });
	}
	source.end(message);
}

async function collect(source: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of source) events.push(event);
	return events;
}

describe("humanizeStream", () => {
	it("holds all provider events until the final text passes review", async () => {
		const source = new AssistantMessageEventStream();
		const decision = deferred<AssistantMessage>();
		const review = vi.fn(() => decision.promise);
		const output = humanizeStream(source, review);
		const received: AssistantMessageEvent[] = [];
		const collecting = (async () => {
			for await (const event of output) received.push(event);
		})();
		const original = fauxAssistantMessage("Hidden-term draft");
		source.push({ type: "start", partial: original });
		source.push({ type: "text_delta", contentIndex: 0, delta: "Hidden-term draft", partial: original });
		await setImmediate();
		expect(received).toEqual([]);
		expect(review).not.toHaveBeenCalled();
		finish(source, original);
		await setImmediate();
		expect(review).toHaveBeenCalledOnce();
		expect(received).toEqual([]);
		const approved = { ...original, content: [{ type: "text" as const, text: "Plain explanation" }] };
		decision.resolve(approved);
		expect(await output.result()).toEqual(approved);
		await collecting;
		expect(JSON.stringify(received)).not.toContain("Hidden-term draft");
		expect(received.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("replays ordered text, thinking and tool events with unchanged protocol metadata", async () => {
		const message = fauxAssistantMessage("");
		message.stopReason = "toolUse";
		message.responseId = "response-1";
		message.usage = { ...message.usage, output: 42 };
		message.content = [
			{ type: "thinking", thinking: "Consider evidence", thinkingSignature: "thinking-signature" },
			{ type: "text", text: "I will read the file.", textSignature: "text-signature" },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "notes.md", options: { limit: 2 } },
				thoughtSignature: "tool-signature",
				namespace: "tools",
			},
			{ type: "text", text: "Then explain it." },
		];
		const source = new AssistantMessageEventStream();
		const output = humanizeStream(source, async (draft) => draft);
		finish(source, message);
		const events = await collect(output);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		const start = events.find((event) => event.type === "start");
		expect(start?.partial.content).toEqual([]);
		const textStart = events.find((event) => event.type === "text_start");
		expect(textStart?.partial.content[textStart.contentIndex]).toEqual({
			type: "text",
			text: "",
			textSignature: "text-signature",
		});
		const thinkingStart = events.find((event) => event.type === "thinking_start");
		expect(thinkingStart?.partial.content[0]).toEqual({
			type: "thinking",
			thinking: "",
			thinkingSignature: "thinking-signature",
		});
		const toolEnd = events.find((event) => event.type === "toolcall_end");
		expect(toolEnd?.toolCall).toEqual(message.content[2]);
		expect(toolEnd?.toolCall).not.toBe(message.content[2]);
		expect(await output.result()).toEqual(message);
	});

	it("passes tool-only messages without paying for a review", async () => {
		const message = fauxAssistantMessage("");
		message.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }];
		message.stopReason = "toolUse";
		const review = vi.fn(async (draft: AssistantMessage) => draft);
		const source = new AssistantMessageEventStream();
		const output = humanizeStream(source, review);
		finish(source, message);
		const events = await collect(output);
		expect(review).not.toHaveBeenCalled();
		expect(events.some((event) => event.type === "toolcall_end")).toBe(true);
		expect((await output.result()).stopReason).toBe("toolUse");
	});

	it("preserves redacted thinking without emitting a reasoning delta", async () => {
		const message = fauxAssistantMessage("");
		message.content = [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }];
		const source = new AssistantMessageEventStream();
		const output = humanizeStream(source, async (draft) => draft);
		finish(source, message);
		const events = await collect(output);
		expect(events.map((event) => event.type)).toEqual(["start", "thinking_start", "thinking_end", "done"]);
		expect(await output.result()).toEqual(message);
	});

	it.each(["error", "aborted"] as const)("withholds partial content after provider %s", async (stopReason) => {
		const message = fauxAssistantMessage("Unreviewed partial text");
		message.content.push({ type: "toolCall", id: "unfinished", name: "write", arguments: {} });
		message.stopReason = stopReason;
		message.errorMessage = "Provider stopped";
		const review = vi.fn(async (draft: AssistantMessage) => draft);
		const source = new AssistantMessageEventStream();
		const output = humanizeStream(source, review);
		source.push({ type: "start", partial: message });
		finish(source, message);
		const events = await collect(output);
		expect(review).not.toHaveBeenCalled();
		expect(events).toHaveLength(1);
		expect(await output.result()).toMatchObject({ content: [], stopReason, errorMessage: "Provider stopped" });
		expect(JSON.stringify(events)).not.toContain("Unreviewed partial text");
		expect(JSON.stringify(events)).not.toContain("unfinished");
	});

	it("does not publish either the draft or exception text when review fails", async () => {
		const source = new AssistantMessageEventStream();
		const output = humanizeStream(source, async () => {
			throw new Error("Unreviewed private draft in an exception");
		});
		const original = fauxAssistantMessage("Unreviewed private draft");
		original.content.push({ type: "toolCall", id: "call-1", name: "write", arguments: {} });
		original.stopReason = "toolUse";
		finish(source, original);
		const events = await collect(output);
		expect(await output.result()).toMatchObject({ content: [], stopReason: "error", usage: original.usage });
		expect(JSON.stringify(events)).not.toContain("Unreviewed private draft");
		expect(JSON.stringify(events)).not.toContain("call-1");
		expect((await output.result()).errorMessage).toContain("withheld");
	});

	it("cancels promptly while a reviewer ignores cancellation", async () => {
		const controller = new AbortController();
		const decision = deferred<AssistantMessage>();
		const review = vi.fn(() => decision.promise);
		const source = new AssistantMessageEventStream();
		const output = humanizeStream(source, review, controller.signal);
		const original = fauxAssistantMessage("Unreviewed draft");
		finish(source, original);
		await setImmediate();
		expect(review).toHaveBeenCalledOnce();
		controller.abort();
		const events = await collect(output);
		expect(await output.result()).toMatchObject({ stopReason: "aborted", content: [] });
		decision.resolve(original);
		await setImmediate();
		expect(events).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("Unreviewed draft");
	});

	it("handles an already aborted request without invoking review", async () => {
		const controller = new AbortController();
		controller.abort();
		const source = new AssistantMessageEventStream();
		const review = vi.fn(async (draft: AssistantMessage) => draft);
		const output = humanizeStream(source, review, controller.signal);
		expect(await output.result()).toMatchObject({ stopReason: "aborted", content: [] });
		expect(review).not.toHaveBeenCalled();
		finish(source, fauxAssistantMessage("Ignored response"));
	});

	it("cancels promptly while the provider has not finished", async () => {
		const controller = new AbortController();
		const source = new AssistantMessageEventStream();
		const review = vi.fn(async (draft: AssistantMessage) => draft);
		const output = humanizeStream(source, review, controller.signal);
		const original = fauxAssistantMessage("Partial draft");
		source.push({ type: "start", partial: original });
		await setImmediate();
		controller.abort();
		expect(await output.result()).toMatchObject({ stopReason: "aborted", content: [] });
		expect(review).not.toHaveBeenCalled();
		finish(source, original);
	});

	it("supports a provider that completes through end(result)", async () => {
		const source = new AssistantMessageEventStream();
		const original = fauxAssistantMessage("Clear response");
		const review = vi.fn(async (draft: AssistantMessage) => draft);
		const output = humanizeStream(source, review);
		source.end(original);
		expect(await output.result()).toEqual(original);
		expect(review).toHaveBeenCalledOnce();
	});

	it("settles a broken provider iterator without leaking its partial response", async () => {
		class BrokenStream extends AssistantMessageEventStream {
			override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
				yield { type: "start", partial: fauxAssistantMessage("Private partial") };
				throw new Error("Private provider failure");
			}
		}
		const output = humanizeStream(new BrokenStream(), async (draft) => draft);
		const events = await collect(output);
		expect(await output.result()).toMatchObject({ stopReason: "error", content: [] });
		expect(JSON.stringify(events)).not.toContain("Private");
	});

	it("rejects an unfinished provider response instead of emitting an invalid done event", async () => {
		const source = new AssistantMessageEventStream();
		const original = fauxAssistantMessage("Unfinished draft");
		original.stopReason = "pending";
		const review = vi.fn(async (draft: AssistantMessage) => draft);
		const output = humanizeStream(source, review);
		source.end(original);
		expect(await output.result()).toMatchObject({ stopReason: "error", content: [] });
		expect(review).not.toHaveBeenCalled();
	});

	it("handles late reviewer rejection after cancellation", async () => {
		const controller = new AbortController();
		const decision = deferred<AssistantMessage>();
		const source = new AssistantMessageEventStream();
		const output = humanizeStream(source, () => decision.promise, controller.signal);
		finish(source, fauxAssistantMessage("Unreviewed draft"));
		await setImmediate();
		controller.abort();
		expect((await output.result()).stopReason).toBe("aborted");
		decision.reject(new Error("late failure"));
		await setImmediate();
	});
});
