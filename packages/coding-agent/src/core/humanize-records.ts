import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, Usage } from "@earendil-works/pi-ai";
import { getPackageDir, VERSION } from "../config.ts";
import type { HumanizeReport, HumanizeSettings, HumanizeVisibleMessage } from "./humanize.ts";

export const HUMANIZE_TRACE_TYPE = "humanize_trace";
export const HUMANIZE_FEEDBACK_TYPE = "humanize_feedback";

export interface HumanizeTracePhase {
	phase: "review" | "lookup" | "rewrite";
	systemPrompt: string;
	request: unknown;
	response: string | null;
	stopReason: string | null;
	durationMs: number;
	usage?: Usage;
	error?: string;
}

export interface HumanizeTrace {
	schemaVersion: 1;
	traceId: string;
	sessionId: string;
	messageEntryId: string;
	contextLeafId: string | null;
	createdAt: string;
	completedAt: string;
	durationMs: number;
	model: { provider: string; id: string; api: string };
	readerModel: { provider: string; id: string; api: string } | null;
	settings: { maxRevisions: number; timeoutMs: number; maxContextChars: number };
	original: string;
	originalMessage: AssistantMessage;
	visibleMessages: HumanizeVisibleMessage[];
	/** null means the full readable snapshot exceeded the size limit; [] means genuinely empty. */
	executionMessages: AgentMessage[] | null;
	contextSnapshot: {
		maxChars: number;
		visibleComplete: boolean;
		executionComplete: boolean;
		executionReason: "complete" | "size-limit";
	};
	phases: HumanizeTracePhase[];
	report: HumanizeReport | null;
	status: "approved" | "failed";
	error: string | null;
	reviewedFinal: string | null;
	/** Actual persisted assistant text after message_end extensions; withheld responses are null. */
	final: string | null;
	deliveryChanged: boolean;
	source: {
		packageVersion: string;
		humanizeSha256: string | null;
		format: "typescript" | "javascript" | "unavailable";
	};
}

export interface HumanizeFeedback {
	schemaVersion: 1;
	traceId: string;
	sessionId: string;
	messageEntryId: string;
	rating: "good" | "bad" | "failed";
	tags: ("lost-facts" | "unclear" | "too-long")[];
	note: string;
	expected: string;
	createdAt: string;
}

export function humanizeTextOf(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function snapshotText(block: TextContent): TextContent {
	return {
		type: "text",
		text: block.text,
		...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
	};
}

/** Keep protocol-relevant text signatures, but never copy thinking or provider diagnostics. */
export function snapshotHumanizeAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: message.content.flatMap((block): AssistantMessage["content"] => {
			if (block.type === "text") return [snapshotText(block)];
			if (block.type === "toolCall") {
				return [{ type: "toolCall", id: block.id, name: block.name, arguments: structuredClone(block.arguments) }];
			}
			return [];
		}),
		api: message.api,
		provider: message.provider,
		model: message.model,
		timestamp: message.timestamp,
		...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
		stopReason: message.stopReason,
		usage: structuredClone(message.usage),
	};
}

/** Readable execution is still private project data; this is filtering, not redaction. */
export function snapshotHumanizeExecutionMessages(
	messages: readonly AgentMessage[],
	maxChars: number,
): { messages: AgentMessage[] | null; complete: boolean } {
	const result: AgentMessage[] = [];
	let chars = 2;
	for (const message of messages) {
		let readable: AgentMessage;
		if (message.role === "assistant") {
			readable = snapshotHumanizeAssistantMessage(message);
		} else if (message.role === "toolResult") {
			readable = {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content.filter((block) => block.type === "text").map(snapshotText),
				isError: message.isError,
				timestamp: message.timestamp,
			};
		} else continue;
		chars += JSON.stringify(readable).length + (result.length > 0 ? 1 : 0);
		if (chars > maxChars) return { messages: null, complete: false };
		result.push(readable);
	}
	return { messages: result, complete: true };
}

function snapshotVisible(messages: readonly HumanizeVisibleMessage[], maxChars: number) {
	let budget = maxChars;
	const result: HumanizeVisibleMessage[] = [];
	let complete = true;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (budget <= 0) {
			if (message.text.length > 0) complete = false;
			continue;
		}
		if (message.text.length > budget) complete = false;
		const text = message.text.length > budget ? message.text.slice(-budget) : message.text;
		result.unshift({ role: message.role, text });
		budget -= text.length;
	}
	return { messages: result, complete };
}

let cachedSource: HumanizeTrace["source"] | undefined;
function sourceIdentity(): HumanizeTrace["source"] {
	if (cachedSource) return cachedSource;
	for (const [file, format] of [
		["src/core/humanize.ts", "typescript"],
		["dist/core/humanize.js", "javascript"],
	] as const) {
		const path = join(getPackageDir(), file);
		try {
			if (!existsSync(path)) continue;
			cachedSource = {
				packageVersion: VERSION,
				humanizeSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
				format,
			};
			return cachedSource;
		} catch {
			/* A read-only fingerprint must not prevent a reply. */
		}
	}
	return { packageVersion: VERSION, humanizeSha256: null, format: "unavailable" };
}

type PendingTrace = Omit<HumanizeTrace, "messageEntryId" | "final" | "deliveryChanged">;
const pendingTraces = new WeakMap<AssistantMessage, PendingTrace>();

/** Taken only by appendMessage, using object identity rather than text equality. */
export function takeHumanizeTrace(
	message: AssistantMessage,
	sessionId: string,
	messageEntryId: string,
): HumanizeTrace | undefined {
	const pending = pendingTraces.get(message);
	pendingTraces.delete(message);
	if (!pending || pending.sessionId !== sessionId) return undefined;
	const final =
		message.stopReason === "error" || message.stopReason === "aborted" ? null : humanizeTextOf(message) || null;
	return { ...pending, messageEntryId, final, deliveryChanged: final !== pending.reviewedFinal };
}

/** Internal recorder: snapshots are detached on finish so late provider completions cannot mutate a saved trace. */
export class HumanizeTraceRecorder {
	private readonly started = performance.now();
	private readonly phaseStarted: number[] = [];
	private closed = false;
	private readonly trace: PendingTrace;

	constructor(options: {
		sessionId: string;
		contextLeafId: string | null;
		message: AssistantMessage;
		visibleMessages: readonly HumanizeVisibleMessage[];
		executionMessages: readonly AgentMessage[];
		settings?: HumanizeSettings;
	}) {
		const settings = {
			maxRevisions: options.settings?.maxRevisions ?? 2,
			timeoutMs: options.settings?.timeoutMs ?? 90000,
			maxContextChars: options.settings?.maxContextChars ?? 48000,
		};
		const maxChars = settings.maxContextChars * 4;
		const visible = snapshotVisible(options.visibleMessages, settings.maxContextChars);
		const execution = snapshotHumanizeExecutionMessages(options.executionMessages, maxChars);
		this.trace = {
			schemaVersion: 1,
			traceId: randomUUID(),
			sessionId: options.sessionId,
			contextLeafId: options.contextLeafId,
			createdAt: new Date().toISOString(),
			completedAt: "",
			durationMs: 0,
			model: { provider: options.message.provider, id: options.message.model, api: options.message.api },
			readerModel: null,
			settings,
			original: humanizeTextOf(options.message),
			originalMessage: snapshotHumanizeAssistantMessage(options.message),
			visibleMessages: visible.messages,
			executionMessages: execution.messages,
			contextSnapshot: {
				maxChars,
				visibleComplete: visible.complete,
				executionComplete: execution.complete,
				executionReason: execution.complete ? "complete" : "size-limit",
			},
			phases: [],
			report: null,
			status: "failed",
			error: null,
			reviewedFinal: null,
			source: sourceIdentity(),
		};
	}

	setReaderModel(model: { provider: string; id: string; api: string }): void {
		if (!this.closed) this.trace.readerModel = { provider: model.provider, id: model.id, api: model.api };
	}

	startPhase(systemPrompt: string, request: unknown): number {
		if (this.closed) return -1;
		const phase = (request as { phase: HumanizeTracePhase["phase"] }).phase;
		const index =
			this.trace.phases.push({
				phase,
				systemPrompt,
				request: structuredClone(request),
				response: null,
				stopReason: null,
				durationMs: 0,
			}) - 1;
		this.phaseStarted[index] = performance.now();
		return index;
	}

	completePhase(index: number, response: AssistantMessage): void {
		if (this.closed || index < 0) return;
		Object.assign(this.trace.phases[index], {
			response: humanizeTextOf(response),
			stopReason: response.stopReason,
			durationMs: performance.now() - this.phaseStarted[index],
			usage: structuredClone(response.usage),
		});
	}

	failPhase(index: number): void {
		if (this.closed || index < 0) return;
		Object.assign(this.trace.phases[index], {
			durationMs: performance.now() - this.phaseStarted[index],
			error: "Reader request failed or was cancelled.",
		});
	}

	approve(message: AssistantMessage, report: HumanizeReport): void {
		if (this.closed) return;
		this.trace.status = "approved";
		this.trace.report = structuredClone(report);
		this.trace.reviewedFinal = humanizeTextOf(message);
	}

	fail(error: string, report?: HumanizeReport): void {
		if (this.closed) return;
		this.trace.status = "failed";
		this.trace.error = error;
		this.trace.report = report ? structuredClone(report) : null;
	}

	finish(message: AssistantMessage): void {
		if (this.closed) return;
		this.closed = true;
		this.trace.completedAt = new Date().toISOString();
		this.trace.durationMs = performance.now() - this.started;
		if (this.trace.status !== "approved" && !this.trace.error) {
			this.trace.error = message.stopReason === "aborted" ? "Humanize review cancelled." : "Humanize review failed.";
		}
		for (const [index, phase] of this.trace.phases.entries()) {
			if (phase.response === null && !phase.error) {
				phase.durationMs = performance.now() - this.phaseStarted[index];
				phase.error = "Reader request did not finish before review ended.";
			}
		}
		pendingTraces.set(message, structuredClone(this.trace));
	}
}
