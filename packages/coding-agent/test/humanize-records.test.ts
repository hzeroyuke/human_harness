import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { describe, expect, it } from "vitest";
import type { HumanizeReport } from "../src/core/humanize.ts";
import {
	HUMANIZE_TRACE_TYPE,
	type HumanizeTrace,
	HumanizeTraceRecorder,
	snapshotHumanizeAssistantMessage,
	snapshotHumanizeExecutionMessages,
	takeHumanizeTrace,
} from "../src/core/humanize-records.ts";
import { humanizeStream } from "../src/core/humanize-stream.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function approvedReport(): HumanizeReport {
	return { status: "approved", revisions: 0, calls: 1, lookedUpContext: false, usage: fauxAssistantMessage("").usage };
}

function recorder(manager: SessionManager, original = fauxAssistantMessage("The same draft.")) {
	return new HumanizeTraceRecorder({
		sessionId: manager.getSessionId(),
		contextLeafId: manager.getLeafId(),
		message: original,
		visibleMessages: [{ role: "user", text: "Explain." }],
		executionMessages: [],
	});
}

function traces(manager: SessionManager): HumanizeTrace[] {
	return manager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === HUMANIZE_TRACE_TYPE ? [entry.data as HumanizeTrace] : [],
		);
}

describe("Humanize local trace records", () => {
	it("pairs identical originals by object and entry id, and never enters model context", () => {
		const manager = SessionManager.inMemory();
		const first = fauxAssistantMessage("First clear answer.");
		const second = fauxAssistantMessage("Second clear answer.");
		for (const message of [first, second]) {
			const trace = recorder(manager);
			trace.approve(message, approvedReport());
			trace.finish(message);
		}
		const firstId = manager.appendMessage(first);
		const secondId = manager.appendMessage(second);
		const records = traces(manager);
		expect(records.map((trace) => [trace.messageEntryId, trace.original, trace.final])).toEqual([
			[firstId, "The same draft.", "First clear answer."],
			[secondId, "The same draft.", "Second clear answer."],
		]);
		expect(new Set(records.map((trace) => trace.traceId)).size).toBe(2);
		expect(manager.buildSessionContext().messages).toEqual([first, second]);
		expect(takeHumanizeTrace(first, manager.getSessionId(), firstId)).toBeUndefined();
	});

	it("keeps the actual post-extension message, without losing identity or the reviewed text", () => {
		const manager = SessionManager.inMemory();
		const delivered = fauxAssistantMessage("Approved answer.");
		const trace = recorder(manager);
		trace.approve(delivered, approvedReport());
		trace.finish(delivered);
		// message_end normalizes a replacement by mutating the existing object.
		Object.assign(delivered, fauxAssistantMessage("Extension answer."));
		manager.appendMessage(delivered);
		expect(traces(manager)[0]).toMatchObject({
			reviewedFinal: "Approved answer.",
			final: "Extension answer.",
			deliveryChanged: true,
		});
	});

	it("freezes cancellation records before a late response and ignores replacement sessions", () => {
		const manager = SessionManager.inMemory();
		const trace = recorder(manager);
		const phase = trace.startPhase("reader", { phase: "review", draft: "The same draft." });
		const cancelled = fauxAssistantMessage("", { stopReason: "aborted" });
		trace.finish(cancelled);
		manager.appendMessage(cancelled);
		const before = structuredClone(traces(manager)[0]);
		trace.completePhase(phase, fauxAssistantMessage("Late private text."));
		trace.approve(fauxAssistantMessage("Late answer."), approvedReport());
		expect(traces(manager)[0]).toEqual(before);
		expect(before).toMatchObject({ status: "failed", final: null, reviewedFinal: null });
		expect(before.phases[0]).toMatchObject({ response: null, stopReason: null });
		expect(before.phases[0].error).toBeTruthy();
		const old = recorder(manager);
		const outgoing = fauxAssistantMessage("Old session.");
		old.finish(outgoing);
		manager.newSession();
		manager.appendMessage(outgoing);
		expect(traces(manager)).toEqual([]);
	});

	it("keeps readable text, arguments and text signatures, excluding thinking, images and system content", () => {
		const assistant = fauxAssistantMessage([
			fauxThinking("PRIVATE_THOUGHT"),
			{ type: "text", text: "Readable", textSignature: "opaque-protected-signature" },
			{ ...fauxToolCall("read", { path: "note.txt" }), thoughtSignature: "PRIVATE_THOUGHT_SIGNATURE" },
		]);
		const messages: AgentMessage[] = [
			{ role: "system", content: "PRIVATE_SYSTEM", timestamp: 1 },
			{ role: "user", content: "User visible elsewhere", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				isError: false,
				timestamp: 1,
				details: { private: "PRIVATE_DETAILS" },
				content: [
					{ type: "text", text: "File text" },
					{ type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE" },
				],
			},
		];
		const snapshot = snapshotHumanizeExecutionMessages(messages, 10000);
		expect(snapshot.complete).toBe(true);
		expect(snapshot.messages).toHaveLength(2);
		expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
		expect(snapshotHumanizeAssistantMessage(assistant).content[0]).toEqual({
			type: "text",
			text: "Readable",
			textSignature: "opaque-protected-signature",
		});
		expect(snapshot.messages?.[1]).toMatchObject({ content: [{ type: "text", text: "File text" }] });
		expect(snapshotHumanizeExecutionMessages(messages, 10)).toEqual({ messages: null, complete: false });
		expect(snapshotHumanizeExecutionMessages([], 10)).toEqual({ messages: [], complete: true });
	});

	it("bounds visible history with the same tail semantics and marks omitted execution", () => {
		const manager = SessionManager.inMemory();
		const message = fauxAssistantMessage("Answer");
		const trace = new HumanizeTraceRecorder({
			sessionId: manager.getSessionId(),
			contextLeafId: null,
			message,
			visibleMessages: [
				{ role: "user", text: "OLD".repeat(200) },
				{ role: "assistant", text: "NEW" },
			],
			executionMessages: [fauxAssistantMessage("A".repeat(2000))],
			settings: { maxContextChars: 256 },
		});
		trace.approve(message, approvedReport());
		trace.finish(message);
		manager.appendMessage(message);
		const saved = traces(manager)[0];
		expect(saved.visibleMessages).toEqual([
			{ role: "user", text: "OLD".repeat(200).slice(-253) },
			{ role: "assistant", text: "NEW" },
		]);
		expect(saved.contextSnapshot).toEqual({
			maxChars: 1024,
			visibleComplete: false,
			executionComplete: false,
			executionReason: "size-limit",
		});
		expect(saved.executionMessages).toBeNull();
		expect(saved.source.humanizeSha256).toMatch(/^[a-f0-9]{64}$/);
	});
	it.each([false, true])(
		"settles the stream even if its diagnostic observer throws (review failure: %s)",
		async (failReview) => {
			const source = new AssistantMessageEventStream();
			const message = fauxAssistantMessage("Approved output.");
			const output = humanizeStream(
				source,
				async (draft) => {
					if (failReview) throw new Error("Review failed");
					return draft;
				},
				undefined,
				() => {
					throw new Error("Recorder failed");
				},
			);
			source.push({ type: "done", reason: "stop", message });
			source.end(message);
			const result = await output.result();
			expect(result.stopReason).toBe(failReview ? "error" : "stop");
			expect(result.content).toEqual(failReview ? [] : message.content);
		},
	);
});
