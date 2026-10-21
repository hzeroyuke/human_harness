import type { AssistantMessage, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * Hold the entire response until its user-facing text has passed an independent review.
 * The source must receive the same abort signal so cancellation also stops provider work.
 */
export function humanizeStream(
	source: AssistantMessageEventStream,
	review: (message: AssistantMessage) => Promise<AssistantMessage>,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	const output = new AssistantMessageEventStream();
	let latest: AssistantMessage | undefined;

	const consume = async (): Promise<AssistantMessage> => {
		// Drain deltas as they arrive instead of retaining the provider's event queue.
		// Never forward the source's mutable partial objects to a public consumer.
		for await (const event of source) {
			latest = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
		}
		return source.result();
	};

	void (async () => {
		try {
			const original = await abortable(consume(), signal);
			latest = original;
			if (original.stopReason === "pending") throw new Error("Response did not finish");
			let message = original;
			if (
				original.stopReason !== "error" &&
				original.stopReason !== "aborted" &&
				original.content.some((block) => block.type === "text" && block.text.trim().length > 0)
			) {
				signal?.throwIfAborted();
				message = await abortable(
					Promise.resolve().then(() => review(original)),
					signal,
				);
			}
			signal?.throwIfAborted();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const error = { ...message, content: [] };
				output.push({ type: "error", reason: message.stopReason, error });
				output.end(error);
				return;
			}
			if (message.stopReason === "pending") throw new Error("Response did not finish");
			replay(output, message);
			output.push({ type: "done", reason: message.stopReason, message });
			output.end(message);
		} catch {
			const aborted = signal?.aborted === true;
			const error: AssistantMessage = {
				...(latest ?? {
					role: "assistant" as const,
					api: "humanize",
					provider: "humanize",
					model: "unknown",
					timestamp: Date.now(),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
				content: [],
				stopReason: aborted ? "aborted" : "error",
				// Exceptions can contain a prompt or the held draft. Do not echo them.
				errorMessage: aborted
					? "Humanize review cancelled; the unreviewed response was withheld."
					: "Humanize review failed; the unreviewed response was withheld. Retry or disable humanize in settings.",
			};
			output.push({ type: "error", reason: aborted ? "aborted" : "error", error });
			output.end(error);
		}
	})();
	return output;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("Humanize aborted"));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** Reconstruct normal block events only from the approved message. */
function replay(output: AssistantMessageEventStream, message: AssistantMessage): void {
	let partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	output.push({ type: "start", partial });
	for (const [contentIndex, block] of message.content.entries()) {
		const previous = partial.content;
		switch (block.type) {
			case "text": {
				partial = { ...partial, content: [...previous, { ...block, text: "" }] };
				output.push({ type: "text_start", contentIndex, partial });
				partial = { ...partial, content: [...previous, { ...block }] };
				output.push({ type: "text_delta", contentIndex, delta: block.text, partial });
				output.push({ type: "text_end", contentIndex, content: block.text, partial });
				break;
			}
			case "thinking": {
				const initial: ThinkingContent = { ...block, thinking: block.redacted ? block.thinking : "" };
				partial = { ...partial, content: [...previous, initial] };
				output.push({ type: "thinking_start", contentIndex, partial });
				partial = { ...partial, content: [...previous, { ...block }] };
				if (!block.redacted) {
					output.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
				}
				output.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
				break;
			}
			case "toolCall": {
				partial = { ...partial, content: [...previous, { ...block, arguments: {} }] };
				output.push({ type: "toolcall_start", contentIndex, partial });
				const toolCall: ToolCall = { ...block, arguments: structuredClone(block.arguments) };
				partial = { ...partial, content: [...previous, toolCall] };
				output.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
				output.push({ type: "toolcall_end", contentIndex, toolCall, partial });
				break;
			}
		}
	}
}
