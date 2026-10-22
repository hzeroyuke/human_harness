/**
 * Feedback for one recorded Humanize reply. Stored as a custom session entry,
 * never as a user/model message.
 *
 * pi -e ./packages/coding-agent/examples/extensions/humanize-feedback.ts
 * /feedback
 * /feedback --choose
 * /feedback [traceId] 好|差|失败|丢事实|仍难懂|太长 --note "说明" --expected "期望表达"
 */
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export type FeedbackRating = "good" | "bad" | "failed";
export type FeedbackTag = "lost-facts" | "unclear" | "too-long";

export interface HumanizeFeedback {
	schemaVersion: 1;
	traceId: string;
	sessionId: string;
	messageEntryId: string;
	rating: FeedbackRating;
	tags: FeedbackTag[];
	note: string;
	expected: string;
	createdAt: string;
}

export interface FeedbackTarget {
	schemaVersion: 1;
	traceId: string;
	sessionId: string;
	messageEntryId: string;
	original: string;
	final: string | null;
	status: "approved" | "failed";
}

interface FeedbackArguments {
	traceId?: string;
	rating?: FeedbackRating;
	tags: FeedbackTag[];
	note: string;
	expected: string;
	choose: boolean;
	help: boolean;
}

const choices: Record<string, { rating: FeedbackRating; tags: FeedbackTag[] }> = {
	好: { rating: "good", tags: [] },
	差: { rating: "bad", tags: [] },
	失败: { rating: "failed", tags: [] },
	丢事实: { rating: "bad", tags: ["lost-facts"] },
	仍难懂: { rating: "bad", tags: ["unclear"] },
	太长: { rating: "bad", tags: ["too-long"] },
	good: { rating: "good", tags: [] },
	bad: { rating: "bad", tags: [] },
	failed: { rating: "failed", tags: [] },
};
const tagAliases: Record<string, FeedbackTag> = {
	"lost-facts": "lost-facts",
	丢事实: "lost-facts",
	unclear: "unclear",
	仍难懂: "unclear",
	"too-long": "too-long",
	太长: "too-long",
};
const usage =
	'/feedback [traceId] 好|差|失败|丢事实|仍难懂|太长 [--tags 丢事实,太长] [--note "说明"] [--expected "期望表达"]；/feedback --choose 可选当前分支的回复。';

/** A small argument tokenizer: quotes group text, backslash escapes the next character. */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let value = "";
	let quote = "";
	let active = false;
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (char === "\\") {
			if (i + 1 === input.length) throw new Error("参数末尾的反斜杠没有对应字符。");
			value += input[++i];
			active = true;
		} else if (quote) {
			if (char === quote) quote = "";
			else value += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			active = true;
		} else if (/\s/.test(char)) {
			if (active) tokens.push(value);
			value = "";
			active = false;
		} else {
			value += char;
			active = true;
		}
	}
	if (quote) throw new Error("参数中的引号没有闭合。");
	if (active) tokens.push(value);
	return tokens;
}

export function parseFeedbackArguments(input: string): FeedbackArguments {
	const parsed: FeedbackArguments = { tags: [], note: "", expected: "", choose: false, help: false };
	const tokens = tokenize(input);
	const seen = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.startsWith("--")) {
			if (seen.has(token)) throw new Error(`参数重复：${token}`);
			seen.add(token);
			if (token === "--choose") parsed.choose = true;
			else if (token === "--help") parsed.help = true;
			else if (["--note", "--expected", "--tags", "--trace"].includes(token)) {
				const value = tokens[++i];
				if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${token} 缺少内容。`);
				if (token === "--note") parsed.note = value;
				else if (token === "--expected") parsed.expected = value;
				else if (token === "--trace") {
					if (parsed.traceId || !value) throw new Error("只能指定一个非空 traceId。");
					parsed.traceId = value;
				} else {
					for (const name of value.split(/[,，]/)) {
						const tag = Object.hasOwn(tagAliases, name.trim()) ? tagAliases[name.trim()] : undefined;
						if (!tag) throw new Error(`未知反馈标签：${name}`);
						parsed.tags.push(tag);
					}
				}
			} else throw new Error(`未知参数：${token}`);
		} else if (Object.hasOwn(choices, token)) {
			if (parsed.rating) throw new Error("只能指定一种评分；多个问题请用 --tags。");
			parsed.rating = choices[token].rating;
			parsed.tags.push(...choices[token].tags);
		} else if (!parsed.traceId && token) parsed.traceId = token;
		else throw new Error(`无法识别参数：${token}`);
	}
	if (parsed.choose && parsed.traceId) throw new Error("--choose 和 traceId 不能同时使用。");
	parsed.tags = [...new Set(parsed.tags)];
	return parsed;
}

/** Only accept trace entries and their exact assistant entries on this branch. */
export function feedbackTargets(entries: readonly SessionEntry[], sessionId: string): FeedbackTarget[] {
	const messageIds = new Set(
		entries
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.map((entry) => entry.id),
	);
	const targets: FeedbackTarget[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "humanize_trace" || !entry.data) continue;
		const trace = entry.data as Partial<FeedbackTarget>;
		if (
			trace.schemaVersion === 1 &&
			trace.sessionId === sessionId &&
			typeof trace.traceId === "string" &&
			trace.traceId.length > 0 &&
			typeof trace.messageEntryId === "string" &&
			messageIds.has(trace.messageEntryId) &&
			typeof trace.original === "string" &&
			(typeof trace.final === "string" || trace.final === null) &&
			(trace.status === "approved" || trace.status === "failed")
		)
			targets.push(trace as FeedbackTarget);
	}
	return targets;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else process.stderr.write(`[humanize feedback] ${message}\n`);
}

export default function humanizeFeedback(pi: ExtensionAPI): void {
	// Pi resolves duplicate extension names as /feedback:1, /feedback:2, etc.
	// Synchronous registration preserves autocomplete without replacing another extension.
	pi.registerCommand("feedback", {
		description: "给当前分支的 Humanize 回复留反馈；/feedback --help 查看参数",
		handler: async (args, ctx) => {
			try {
				const parsed = parseFeedbackArguments(args);
				if (parsed.help) return notify(ctx, usage, "info");
				const sessionId = ctx.sessionManager.getSessionId();
				const branch = ctx.sessionManager.getBranch();
				const targets = feedbackTargets(branch, sessionId);
				let target = parsed.traceId ? targets.find((item) => item.traceId === parsed.traceId) : targets.at(-1);
				if (!target) {
					return notify(
						ctx,
						parsed.traceId
							? "当前会话分支没有这个 traceId，未保存反馈。请切回对应分支。"
							: "当前分支还没有 Humanize 回复记录。请开启 humanize.record 后产生一条回复。",
						"warning",
					);
				}
				if (parsed.traceId && targets.filter((item) => item.traceId === parsed.traceId).length !== 1) {
					return notify(ctx, "这个 traceId 对应多条记录，身份有歧义，未保存反馈。", "error");
				}
				const latestAssistant = [...branch]
					.reverse()
					.find((entry) => entry.type === "message" && entry.message.role === "assistant");
				if (!parsed.traceId && !parsed.choose && latestAssistant?.id !== target.messageEntryId) {
					return notify(
						ctx,
						`最近一条助手消息没有可评轨迹，未保存反馈。之前的记录是 ${target.traceId}；如要评价它，请显式指定 traceId 或使用 --choose。`,
						"warning",
					);
				}
				if (parsed.choose) {
					if (!ctx.hasUI) return notify(ctx, "无交互界面时请用 traceId 指定回复。", "warning");
					const labels = [...targets].reverse().map((item) => {
						const preview = (item.final ?? item.original).replace(/[\s\x00-\x1f\x7f]+/g, " ").slice(0, 64);
						return `${item.traceId} · ${item.final === null ? "未发出" : "已发出"} · ${preview}`;
					});
					const selected = await ctx.ui.select("选择要反馈的回复（当前分支）", labels);
					if (!selected) return notify(ctx, "已取消，没有保存反馈。", "info");
					target = [...targets].reverse()[labels.indexOf(selected)];
				}
				if (!parsed.rating) {
					if (!ctx.hasUI) return notify(ctx, `无交互界面时必须提供评分。${usage}`, "warning");
					const selected = await ctx.ui.select(
						`反馈 ${target.traceId}：${(target.final ?? target.original).slice(0, 100)}`,
						["好", "差", "丢事实", "仍难懂", "太长", "失败"],
					);
					if (!selected) return notify(ctx, "已取消，没有保存反馈。", "info");
					parsed.rating = choices[selected].rating;
					parsed.tags = [...new Set([...parsed.tags, ...choices[selected].tags])];
					const note = await ctx.ui.input("补充说明（可留空；Esc 取消反馈）", parsed.note);
					if (note === undefined) return notify(ctx, "已取消，没有保存反馈。", "info");
					const expected = await ctx.ui.input("你期望怎样表达（可留空；Esc 取消反馈）", parsed.expected);
					if (expected === undefined) return notify(ctx, "已取消，没有保存反馈。", "info");
					parsed.note = note;
					parsed.expected = expected;
				}
				// A dialog can outlive a branch/session switch. Recheck exact identity before writing.
				if (
					ctx.sessionManager.getSessionId() !== sessionId ||
					!feedbackTargets(ctx.sessionManager.getBranch(), sessionId).some(
						(item) => item.traceId === target.traceId && item.messageEntryId === target.messageEntryId,
					)
				)
					return notify(ctx, "会话或分支已切换，未保存反馈。请在目标分支重新执行。", "warning");
				pi.appendEntry<HumanizeFeedback>("humanize_feedback", {
					schemaVersion: 1,
					traceId: target.traceId,
					sessionId,
					messageEntryId: target.messageEntryId,
					rating: parsed.rating,
					tags: parsed.tags,
					note: parsed.note,
					expected: parsed.expected,
					createdAt: new Date().toISOString(),
				});
				const preview = (target.final ?? target.original).replace(/[\s\x00-\x1f\x7f]+/g, " ").slice(0, 100);
				notify(
					ctx,
					`已保存反馈：${target.traceId}。\n对应内容：${preview}\n仅作为本地记录，不发送给模型。`,
					"info",
				);
			} catch (error) {
				notify(ctx, `${error instanceof Error ? error.message : String(error)}\n${usage}`, "error");
			}
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (pi.getCommands().filter((command) => /^feedback(?::\d+)?$/.test(command.name)).length > 1) {
			const message =
				"存在同名 /feedback 命令，Pi 已分配数字后缀。请在自动补全中选择来自 humanize-feedback.ts 的命令。";
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`[humanize feedback] ${message}\n`);
		}
	});
}
