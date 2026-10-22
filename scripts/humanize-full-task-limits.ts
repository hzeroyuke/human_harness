export interface FullTaskLimits {
	readonly maxRevisions: number;
	readonly reviewTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly roundTimeoutMs: number;
	readonly maxAgentCallsPerRound: number;
}

/** Resolve once before creating a workspace; reject typos instead of silently using defaults. */
export function readFullTaskLimits(env: Readonly<Record<string, string | undefined>>): FullTaskLimits {
	const positiveInteger = (key: string, fallback: number, maximum: number): number => {
		const raw = env[key];
		if (raw === undefined) return fallback;
		const value = Number(raw);
		if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum) {
			throw new Error(`${key} 必须是 1 到 ${maximum} 之间的十进制正整数，不能含空格、符号或小数。`);
		}
		return value;
	};
	return Object.freeze({
		maxRevisions: 2,
		// The engine itself caps a message's full review/rewrite sequence at five minutes.
		reviewTimeoutMs: positiveInteger("HUMANIZE_TASK_REVIEW_TIMEOUT_MS", 120_000, 300_000),
		requestTimeoutMs: positiveInteger("HUMANIZE_TASK_REQUEST_TIMEOUT_MS", 90_000, 300_000),
		roundTimeoutMs: positiveInteger("HUMANIZE_TASK_ROUND_TIMEOUT_MS", 720_000, 3_600_000),
		maxAgentCallsPerRound: positiveInteger("HUMANIZE_TASK_MAX_AGENT_CALLS", 45, 200),
	});
}
