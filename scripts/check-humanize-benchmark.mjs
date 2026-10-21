#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function uniqueIds(items, label, errors) {
	const ids = new Set();
	for (const [index, item] of items.entries()) {
		if (!object(item) || !nonempty(item.id)) {
			errors.push(`${label}[${index}] must have a nonempty id`);
			continue;
		}
		if (ids.has(item.id)) errors.push(`${label} contains duplicate id ${item.id}`);
		ids.add(item.id);
	}
	return ids;
}

/** Publication validation: checks evidence provenance and coverage, not answer correctness. */
export function validateBenchmark(data, { allowPartial = false } = {}) {
	const errors = [];
	if (!object(data)) return { errors: ["Benchmark must be an object"], summary: null };
	if (data.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (!nonempty(data.generatedAt) || !Number.isFinite(Date.parse(data.generatedAt))) {
		errors.push("generatedAt must be a date-time string");
	}
	const models = Array.isArray(data.models) ? data.models : [];
	const tasks = Array.isArray(data.tasks) ? data.tasks : [];
	const runs = Array.isArray(data.runs) ? data.runs : [];
	if (models.length === 0) errors.push("models must be a nonempty array");
	if (tasks.length === 0) errors.push("tasks must be a nonempty array");
	if (!Array.isArray(data.runs)) errors.push("runs must be an array");
	uniqueIds(models, "models", errors);
	for (const model of models) {
		if (object(model) && !["chat", "embeddings"].includes(model.type)) {
			errors.push(`Model ${model.id} must declare chat or embeddings type`);
		}
	}
	const chatModels = models.filter((model) => object(model) && model.type === "chat");
	if (chatModels.length === 0) errors.push("models must contain at least one chat model");
	const modelIds = new Set(chatModels.map((model) => model.id));
	const taskIds = uniqueIds(tasks, "tasks", errors);
	uniqueIds(runs, "runs", errors);
	const taskById = new Map(tasks.filter(object).map((task) => [task.id, task]));
	const methodology = object(data.methodology) ? data.methodology : {};
	if (typeof methodology.complete !== "boolean") errors.push("methodology.complete must be a boolean");
	if (!allowPartial && methodology.complete !== true) errors.push("Publication requires a complete benchmark");
	const generatedTaskIds = Array.isArray(methodology.generatedTaskIds) ? methodology.generatedTaskIds : [];
	if (!Array.isArray(methodology.generatedTaskIds)) errors.push("methodology.generatedTaskIds must be an array");
	if (new Set(generatedTaskIds).size !== generatedTaskIds.length) errors.push("generatedTaskIds contains duplicates");
	for (const id of generatedTaskIds) {
		if (!taskIds.has(id)) errors.push(`Unknown generated task ${id}`);
	}
	const expected = chatModels.length * (tasks.length + generatedTaskIds.length);
	if (methodology.expectedRuns !== expected) errors.push(`methodology.expectedRuns must be ${expected}`);
	for (const task of tasks) {
		if (!object(task)) continue;
		if (!nonempty(task.fixedDraft)) errors.push(`Task ${task.id} needs a fixedDraft`);
		if (
			!Array.isArray(task.input) ||
			task.input.length === 0 ||
			task.input.some(
				(message) => !object(message) || !["user", "assistant"].includes(message.role) || !nonempty(message.text),
			)
		) {
			errors.push(`Task ${task.id} needs visible user/assistant input`);
		}
	}
	const combinations = new Set();
	const counts = { approved: 0, failed: 0, unavailable: 0, pending: 0 };
	for (const run of runs) {
		if (!object(run)) continue;
		const label = `Run ${run.id ?? "?"}`;
		if (!modelIds.has(run.modelId)) errors.push(`${label} refers to unknown model ${run.modelId}`);
		if (!taskIds.has(run.taskId)) errors.push(`${label} refers to unknown task ${run.taskId}`);
		if (!["fixed", "generated"].includes(run.mode)) errors.push(`${label} has invalid mode`);
		if (run.mode === "generated" && !generatedTaskIds.includes(run.taskId)) {
			errors.push(`${label} is not an expected generated task`);
		}
		const combination = JSON.stringify([run.modelId, run.taskId, run.mode]);
		if (combinations.has(combination)) errors.push(`${label} duplicates a model/task/mode combination`);
		combinations.add(combination);
		const running = run.state === "running";
		if (!["running", "complete"].includes(run.state)) errors.push(`${label} has invalid state`);
		if (running) counts.pending++;
		if (["approved", "failed", "unavailable"].includes(run.status)) {
			if (!running) counts[run.status]++;
		} else errors.push(`${label} must have a recognized status`);
		if (typeof run.before !== "string") errors.push(`${label} needs the original draft string`);
		const task = taskById.get(run.taskId);
		if (task && run.mode === "fixed" && run.before !== task.fixedDraft) {
			errors.push(`${label} changed the fixed baseline`);
		}
		if (task && JSON.stringify(run.input) !== JSON.stringify(task.input)) {
			errors.push(`${label} changed the visible task input`);
		}
		if (!Number.isFinite(run.durationMs) || run.durationMs < 0)
			errors.push(`${label} needs a nonnegative durationMs`);
		if (!Array.isArray(run.phases)) {
			errors.push(`${label} needs a phases array`);
			continue;
		}
		const auxiliary = [];
		for (const [index, phase] of run.phases.entries()) {
			if (!object(phase)) {
				errors.push(`${label} phase ${index} must be an object`);
				continue;
			}
			if (!["generation", "review", "lookup", "rewrite"].includes(phase.phase)) {
				errors.push(`${label} phase ${index} has unknown kind`);
			}
			if (typeof phase.response !== "string") errors.push(`${label} phase ${index} needs a text response`);
			if (phase.parsed !== null && phase.parsed !== undefined) {
				try {
					const raw = typeof phase.response === "string" ? phase.response.trim() : "";
					const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(raw);
					if (JSON.stringify(JSON.parse(fenced ? fenced[1] : raw)) !== JSON.stringify(phase.parsed)) {
						errors.push(`${label} phase ${index} parsed response differs from the actual model response`);
					}
				} catch {
					errors.push(`${label} phase ${index} claims a parsed response for invalid JSON`);
				}
			}
			if (!Number.isFinite(phase.durationMs) || phase.durationMs < 0) {
				errors.push(`${label} phase ${index} needs a nonnegative durationMs`);
			}
			if (phase.phase === "generation") {
				if (run.mode !== "generated" || index !== 0) errors.push(`${label} generation must be first and explicit`);
				if (run.before && phase.response !== run.before)
					errors.push(`${label} baseline differs from actual generation`);
				continue;
			}
			auxiliary.push(phase);
			if (!object(phase.request) || phase.request.phase !== phase.phase) {
				errors.push(`${label} phase ${index} needs its exact request payload`);
			}
			if (phase.phase === "review") {
				const keys = object(phase.request) ? Object.keys(phase.request).sort() : [];
				if (JSON.stringify(keys) !== JSON.stringify(["draft", "phase", "visibleMessages"])) {
					errors.push(`${label} blind review contains hidden or unexpected context`);
				}
				if (object(phase.request) && JSON.stringify(phase.request.visibleMessages) !== JSON.stringify(run.input)) {
					errors.push(`${label} blind review visible context differs from the public task input`);
				}
			}
		}
		if (running) {
			if (!allowPartial || methodology.complete === true) errors.push(`${label} is still running`);
			if (run.after !== null) errors.push(`${label} exposed a draft before completion`);
			continue;
		}
		if (run.mode === "generated" && run.phases[0]?.phase !== "generation") {
			errors.push(`${label} is missing its actual generation phase`);
		}
		if (run.status !== "approved") {
			if (run.after !== null) errors.push(`${label} exposed an unapproved draft as output`);
			if (!nonempty(run.error)) errors.push(`${label} needs a failure reason`);
			continue;
		}
		if (!nonempty(run.after)) errors.push(`${label} needs an approved output`);
		if (run.mode === "generated" && (!nonempty(run.before) || run.phases[0]?.stopReason !== "stop")) {
			errors.push(`${label} approved an incomplete original generation`);
		}
		const report = object(run.report) ? run.report : {};
		if (report.status !== "approved") errors.push(`${label} has no approved engine report`);
		if (report.calls !== auxiliary.length)
			errors.push(`${label} report.calls does not match recorded auxiliary phases`);
		if (report.revisions !== auxiliary.filter((phase) => phase.phase === "rewrite").length) {
			errors.push(`${label} report.revisions does not match rewrites`);
		}
		if (report.lookedUpContext !== auxiliary.some((phase) => phase.phase === "lookup")) {
			errors.push(`${label} lookup report does not match recorded phases`);
		}
		const final = auxiliary.at(-1);
		if (
			final?.phase !== "review" ||
			final.parsed?.clear !== true ||
			final.parsed?.needsContext !== false ||
			!Array.isArray(final.parsed?.issues) ||
			final.parsed.issues.length !== 0
		) {
			errors.push(`${label} is missing its final independent approval`);
		}
		if (final?.request?.draft !== run.after) errors.push(`${label} output differs from the approved draft`);
		if (auxiliary[0]?.phase !== "review" || auxiliary[0]?.request?.draft !== run.before) {
			errors.push(`${label} did not start by blindly reviewing the original draft`);
		}
		let state = "review";
		let currentDraft = run.before;
		for (const phase of auxiliary) {
			if (phase.phase !== state) errors.push(`${label} has an invalid review/lookup/rewrite sequence`);
			if (phase.stopReason !== "stop") errors.push(`${label} approved an incomplete model response`);
			if (["review", "rewrite"].includes(phase.phase) && phase.request?.draft !== currentDraft) {
				errors.push(`${label} next phase did not use the actual previous draft`);
			}
			if (phase.phase === "review")
				state = phase.parsed?.clear ? "done" : phase.parsed?.needsContext ? "lookup" : "rewrite";
			else if (phase.phase === "lookup") state = "rewrite";
			else {
				if (!nonempty(phase.parsed?.text)) errors.push(`${label} rewrite has no actual revised text`);
				currentDraft = phase.parsed?.text;
				state = "review";
			}
		}
	}
	if (!allowPartial || methodology.complete === true) {
		for (const modelId of modelIds) {
			for (const taskId of taskIds) {
				if (!combinations.has(JSON.stringify([modelId, taskId, "fixed"]))) {
					errors.push(`Missing fixed run for ${modelId}/${taskId}`);
				}
			}
			for (const taskId of generatedTaskIds) {
				if (!combinations.has(JSON.stringify([modelId, taskId, "generated"]))) {
					errors.push(`Missing generated run for ${modelId}/${taskId}`);
				}
			}
		}
	}
	return {
		errors,
		summary: {
			models: chatModels.length,
			excludedModels: models.length - chatModels.length,
			tasks: tasks.length,
			runs: runs.length,
			expected,
			...counts,
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const allowPartial = args.includes("--allow-partial");
	const paths = args.filter((arg) => arg !== "--allow-partial");
	if (paths.length > 1 || paths.some((path) => path.startsWith("--"))) {
		console.error("Usage: node scripts/check-humanize-benchmark.mjs [path] [--allow-partial]");
		process.exitCode = 1;
	} else {
		try {
			const result = validateBenchmark(JSON.parse(readFileSync(paths[0] ?? "site/data/benchmark.json", "utf8")), {
				allowPartial,
			});
			if (result.errors.length > 0) {
				for (const error of result.errors) console.error(error);
				process.exitCode = 1;
			} else {
				console.log(JSON.stringify(result.summary, null, 2));
				console.log(
					allowPartial
						? "Trajectory structure validated; partial coverage allowed."
						: "Complete trajectory dataset is ready for publication.",
				);
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
