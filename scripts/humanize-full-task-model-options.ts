export type FullTaskReasoningEffort = "low" | "medium" | "high";

export interface FullTaskModelOptions {
	readonly modelReasoning: boolean;
	readonly thinkingLevel: "off" | FullTaskReasoningEffort;
	readonly reasoning: Readonly<
		| { mode: "upstream-unspecified"; effort: null }
		| { mode: "explicit"; effort: FullTaskReasoningEffort }
	>;
}

/** The old default omits upstream effort; it does not establish that the model does no reasoning. */
export function readFullTaskModelOptions(env: Readonly<Record<string, string | undefined>>): FullTaskModelOptions {
	const effort = env.HUMANIZE_TASK_REASONING;
	if (effort === undefined) {
		return Object.freeze({
			modelReasoning: false,
			thinkingLevel: "off",
			reasoning: Object.freeze({ mode: "upstream-unspecified", effort: null }),
		});
	}
	if (effort !== "low" && effort !== "medium" && effort !== "high") {
		throw new Error("HUMANIZE_TASK_REASONING 必须是 low、medium 或 high；不设置时不向上游指定推理档位。");
	}
	return Object.freeze({
		modelReasoning: true,
		thinkingLevel: effort,
		reasoning: Object.freeze({ mode: "explicit", effort }),
	});
}
