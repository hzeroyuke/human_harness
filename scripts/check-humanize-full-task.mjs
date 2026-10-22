#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseResponse(phase) {
	if (phase?.stopReason !== "stop" || typeof phase.response !== "string") return null;
	const text = phase.response.trim();
	const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
	try {
		return JSON.parse(fenced ? fenced[1] : text);
	} catch {
		return null;
	}
}

function decision(value) {
	return (
		object(value) &&
		equal(Object.keys(value).sort(), ["clear", "issues", "needsContext"]) &&
		typeof value.clear === "boolean" &&
		typeof value.needsContext === "boolean" &&
		Array.isArray(value.issues) &&
		value.issues.length <= 16 &&
		value.issues.every(nonempty) &&
		(value.clear ? !value.needsContext && value.issues.length === 0 : value.issues.length > 0)
	);
}

// The SDK sends the newest public conversation, trimming only its oldest boundary.
function visibleTail(messages, budget) {
	const result = [];
	for (let index = messages.length - 1; index >= 0 && budget > 0; index--) {
		const message = messages[index];
		const text = message.text.length > budget ? message.text.slice(-budget) : message.text;
		result.unshift({ role: message.role, text });
		budget -= text.length;
	}
	return result;
}

function checkAcceptance(value, label, errors) {
	if (!object(value) || !Array.isArray(value.checks)) {
		errors.push(`${label} needs actual acceptance checks`);
		return;
	}
	if (
		value.checks.length === 0 ||
		value.checks.some((check) => !object(check) || !nonempty(check.id) || typeof check.passed !== "boolean")
	)
		errors.push(`${label} has invalid acceptance checks`);
	const passed = value.checks.filter((check) => check?.passed === true).length;
	if (
		value.total !== value.checks.length ||
		value.passedCount !== passed ||
		value.passed !== (passed === value.checks.length && passed > 0)
	)
		errors.push(`${label} acceptance totals disagree with actual checks`);
	if (new Set(value.checks.map((check) => check?.id)).size !== value.checks.length)
		errors.push(`${label} has duplicate acceptance check ids`);
}

function checkReview(event, raw, visible, run, label, errors) {
	const review = event.review;
	if (!object(review)) return;
	if (run.enabled !== true) errors.push(`${label} disabled runs cannot count as same-message review pairs`);
	if (!raw || raw.state !== "received" || !["stop", "toolUse"].includes(raw.stopReason) || !nonempty(raw.text))
		errors.push(`${label} original provider error or incomplete response must not count as review failure`);
	if (review.original !== raw?.text) errors.push(`${label} original differs from its same-id raw provider response`);
	if (!["approved", "failed"].includes(review.status)) errors.push(`${label} review has invalid status`);
	if (!Array.isArray(review.phases) || review.phases.length === 0) {
		errors.push(`${label} needs recorded review phases`);
		return;
	}
	if (review.phases[0].phase !== "review" || review.phases[0].request?.draft !== review.original)
		errors.push(`${label} first blind review did not use the original draft`);
	const approved = review.status === "approved";
	if (approved) {
		if (event.isError || !nonempty(review.final) || review.final !== event.text)
			errors.push(`${label} approved final differs from actually released assistant text`);
	} else if (review.final !== null || nonempty(event.text) || event.isError !== true)
		errors.push(`${label} failed review exposed an unapproved draft`);
	if (review.report) {
		if (review.report.status !== review.status) errors.push(`${label} engine report belongs to another result`);
		if (review.report.calls !== review.phases.length)
			errors.push(`${label} report call count differs from recorded phases`);
		if (review.report.lookedUpContext !== review.phases.some((phase) => phase.phase === "lookup"))
			errors.push(`${label} lookup report differs from recorded phases`);
	} else if (approved) errors.push(`${label} approval needs an actual engine report`);
	let next = "review";
	let draft = review.original;
	let lastIssues = null;
	let rewrites = 0;
	for (const [index, phase] of review.phases.entries()) {
		const phaseLabel = `${label} phase ${index}`;
		if (!object(phase) || !object(phase.request)) {
			errors.push(`${phaseLabel} needs an actual request`);
			continue;
		}
		if (phase.phase !== next || phase.request.phase !== phase.phase)
			errors.push(`${phaseLabel} has invalid review/lookup/rewrite order`);
		if (typeof phase.response !== "string" || !Number.isFinite(phase.durationMs) || phase.durationMs < 0)
			errors.push(`${phaseLabel} needs response text and duration`);
		if (["review", "rewrite"].includes(phase.phase) && phase.request.draft !== draft)
			errors.push(`${phaseLabel} draft differs from the actual previous draft`);
		if (phase.phase === "review") {
			if (!equal(Object.keys(phase.request).sort(), ["draft", "phase", "visibleMessages"]))
				errors.push(`${phaseLabel} blind review contains hidden or unexpected context`);
			const budget = (run.limits?.maxContextChars ?? 48_000) - String(phase.request.draft ?? "").length;
			if (!equal(phase.request.visibleMessages, visibleTail(visible, budget)))
				errors.push(`${phaseLabel} blind visible history differs from actually released messages`);
		}
		if (["lookup", "rewrite"].includes(phase.phase) && !equal(phase.request.issues, lastIssues))
			errors.push(`${phaseLabel} issues differ from the preceding blind reader`);
		const parsed = parseResponse(phase);
		let valid = false;
		if (phase.phase === "review") {
			valid = decision(parsed);
			if (valid) {
				lastIssues = parsed.issues;
				next = parsed.clear ? "done" : parsed.needsContext ? "lookup" : "rewrite";
			}
		} else if (phase.phase === "lookup") {
			valid =
				object(parsed) &&
				equal(Object.keys(parsed), ["facts"]) &&
				Array.isArray(parsed.facts) &&
				parsed.facts.every(nonempty);
			if (valid) next = "rewrite";
		} else if (phase.phase === "rewrite") {
			valid = object(parsed) && equal(Object.keys(parsed), ["text"]) && nonempty(parsed.text);
			if (valid) {
				draft = parsed.text;
				next = "review";
				rewrites++;
			}
		}
		if (!valid) {
			if (approved || index !== review.phases.length - 1)
				errors.push(`${phaseLabel} incomplete or invalid model result cannot lead to approval or another phase`);
			next = "failed";
		}
	}
	if (approved) {
		const last = review.phases.at(-1);
		const parsed = parseResponse(last);
		if (
			last.phase !== "review" ||
			!decision(parsed) ||
			parsed.clear !== true ||
			last.request?.draft !== review.final ||
			next !== "done"
		)
			errors.push(`${label} final output lacks matching final independent approval`);
		if (review.report?.revisions !== rewrites) errors.push(`${label} revision count differs from recorded rewrites`);
	} else if (next === "done") errors.push(`${label} failed review contradicts its final approved decision`);
}

/** Verify saved provenance and delivery, without claiming that model prose is factually correct. */
export function validateFullTask(data, { allowPartial = false } = {}) {
	const errors = [];
	const summary = {
		runs: 0,
		models: 0,
		roundsStarted: 0,
		roundsNotStarted: 0,
		businessPassed: 0,
		pairedMessages: 0,
		rewritten: 0,
		unchanged: 0,
		withheld: 0,
		mainResponseErrors: 0,
	};
	if (!object(data)) return { errors: ["Full task dataset must be an object"], summary };
	if (data.schemaVersion !== 1 || data.kind !== "full-task")
		errors.push("Expected schemaVersion 1 and kind full-task");
	if (!allowPartial && data.complete !== true) errors.push("Publication requires a complete dataset");
	if (data.methodology?.comparison !== "same-message-before-after")
		errors.push("Comparison must be same-message-before-after");
	const runs = Array.isArray(data.runs) ? data.runs : [];
	const models = Array.isArray(data.models) ? data.models : [];
	const requirements = Array.isArray(data.task?.rounds) ? data.task.rounds : [];
	if (!runs.length || !models.length || !requirements.length)
		errors.push("Dataset needs models, task rounds and real runs");
	if (new Set(runs.map((run) => run?.id)).size !== runs.length) errors.push("Duplicate run id");
	if (new Set(models.map((model) => model?.id)).size !== models.length) errors.push("Duplicate model id");
	const modelsSeen = new Set();
	const seeds = new Set();
	for (const run of runs) {
		const label = `Run ${run?.id ?? "?"}`;
		if (!object(run) || !Array.isArray(run.rounds)) {
			errors.push(`${label} needs rounds`);
			continue;
		}
		summary.runs++;
		modelsSeen.add(run.modelId);
		seeds.add(run.seedHash);
		if (!models.some((model) => model.id === run.modelId)) errors.push(`${label} has an undeclared model`);
		if (run.enabled !== true) errors.push(`${label} disabled runs cannot count as same-message review pairs`);
		if (!["running", "completed", "interrupted", "error"].includes(run.status))
			errors.push(`${label} has invalid run status`);
		if (run.status === "running" && (!allowPartial || data.complete === true))
			errors.push(`${label} is still running`);
		if (run.status !== "running" && !nonempty(run.finishedAt)) errors.push(`${label} needs a completion timestamp`);
		for (const key of ["humanizeSha256", "runnerSha256", "taskSha256"])
			if (!/^[a-f0-9]{64}$/.test(run.source?.[key] ?? "")) errors.push(`${label} needs source hash ${key}`);
		if (!/^[a-f0-9]{64}$/.test(run.seedHash ?? "")) errors.push(`${label} needs a seed hash`);
		if (
			run.status === "completed" &&
			(run.rounds.length !== requirements.length || run.rounds.some((round) => round.status !== "completed"))
		)
			errors.push(`${label} claims completion without completing every task round`);
		summary.roundsNotStarted += Math.max(0, requirements.length - run.rounds.length);
		const visible = [];
		const rawIds = new Set();
		for (const [roundIndex, round] of run.rounds.entries()) {
			const roundLabel = `${label} round ${round?.id ?? "?"}`;
			const requirement = requirements[roundIndex];
			if (!object(round) || !Array.isArray(round.events) || !Array.isArray(round.rawResponses)) {
				errors.push(`${roundLabel} needs events and raw responses`);
				continue;
			}
			summary.roundsStarted++;
			if (round.id !== requirement?.id) errors.push(`${roundLabel} is not the expected next task round`);
			if (roundIndex > 0 && run.rounds[roundIndex - 1].status !== "completed")
				errors.push(`${roundLabel} started after an unfinished preceding round`);
			if (round.status === "running" && (!allowPartial || data.complete === true))
				errors.push(`${roundLabel} is still running`);
			checkAcceptance(round.initialAcceptance, `${roundLabel} initial`, errors);
			if (round.status !== "running") checkAcceptance(round.acceptance, roundLabel, errors);
			if (round.acceptance?.passed === true) summary.businessPassed++;
			const raws = new Map();
			for (const raw of round.rawResponses) {
				if (!object(raw) || !nonempty(raw.id) || typeof raw.text !== "string") {
					errors.push(`${roundLabel} has an invalid raw response`);
					continue;
				}
				if (rawIds.has(raw.id)) errors.push(`${roundLabel} contains duplicate raw response id`);
				rawIds.add(raw.id);
				raws.set(raw.id, raw);
			}
			const deliveredIds = new Set();
			let users = 0;
			for (const event of round.events) {
				const eventLabel = `${roundLabel} event ${event?.id ?? "?"}`;
				if (!object(event)) {
					errors.push(`${eventLabel} is invalid`);
					continue;
				}
				if (event.type === "user") {
					users++;
					if (event.text !== requirement?.prompt)
						errors.push(`${eventLabel} differs from the task's actual user requirement`);
					visible.push({ role: "user", text: event.text });
				} else if (event.type === "assistant") {
					const raw = raws.get(event.sourceMessageId);
					if (!raw || event.id !== event.sourceMessageId)
						errors.push(`${eventLabel} has no matching same-id raw provider response`);
					if (deliveredIds.has(event.sourceMessageId))
						errors.push(`${eventLabel} duplicates a source message pair`);
					deliveredIds.add(event.sourceMessageId);
					if (event.review) {
						checkReview(event, raw, visible, run, eventLabel, errors);
						summary.pairedMessages++;
						if (event.review.status === "failed") summary.withheld++;
						else if (event.review.original === event.review.final) summary.unchanged++;
						else summary.rewritten++;
					} else if (event.isError) summary.mainResponseErrors++;
					else if (run.enabled && nonempty(event.text))
						errors.push(`${eventLabel} released text without a review pair`);
					if (nonempty(event.text) && !event.isError) visible.push({ role: "assistant", text: event.text });
				}
			}
			if (users !== 1) errors.push(`${roundLabel} must record exactly one user input`);
			if (round.status !== "running") {
				const lastTest = round.events.findLast((event) => event.type === "test" && event.name === "外部业务验收");
				if (!lastTest || !equal(lastTest.result, round.acceptance))
					errors.push(`${roundLabel} final acceptance differs from its actual recorded test event`);
				for (const raw of raws.values())
					if (
						raw.state === "received" &&
						["stop", "toolUse"].includes(raw.stopReason) &&
						nonempty(raw.text) &&
						!deliveredIds.has(raw.id)
					)
						errors.push(`${roundLabel} lost the delivery or withheld record for raw response ${raw.id}`);
			}
		}
	}
	summary.models = modelsSeen.size;
	if (seeds.size > 1) errors.push("Runs used different seed projects");
	if ((!allowPartial || data.complete === true) && models.some((model) => !modelsSeen.has(model.id)))
		errors.push("Missing run for a declared model");
	return { errors, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const allowPartial = args.includes("--allow-partial");
	const paths = args.filter((arg) => arg !== "--allow-partial");
	try {
		if (paths.length > 1 || paths.some((path) => path.startsWith("--")))
			throw new Error("Usage: node scripts/check-humanize-full-task.mjs [path] [--allow-partial]");
		const result = validateFullTask(JSON.parse(readFileSync(paths[0] ?? "site/data/full-task.json", "utf8")), {
			allowPartial,
		});
		if (result.errors.length) {
			result.errors.forEach((error) => console.error(error));
			process.exitCode = 1;
		} else console.log(JSON.stringify(result.summary, null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
