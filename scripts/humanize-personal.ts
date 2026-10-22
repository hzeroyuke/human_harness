import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import {
	exportPersonalSamples,
	replayPersonalSamples,
	sha256,
	validateDataset,
	type PersonalReader,
} from "./humanize-personal-data.ts";

const HELP = `个人 Humanize 样本工具（只写新文件，不覆盖会话或旧导出）

export <session.jsonl|directory> --output <new.json> [--problems-only] [--keep-normal N]
replay <samples.json> --provider <provider> --model <id> --output <new.json> [--trace-id <id> ...]

export 默认保留全部样本。问题样本指审阅失败或有人标记差/失败/问题标签；
--keep-normal N 在问题筛选之外保留按时间排序的前 N 条正常样本作为对照。
replay 使用 PI_CODING_AGENT_DIR 下的模型与认证，只审阅已保存的原稿和上下文。
不会重跑原任务，也不执行样本中的工具调用。每条模型失败仍会写进新结果。
`;

export interface PersonalCliOptions {
	command: "export" | "replay";
	input: string;
	output: string;
	problemsOnly: boolean;
	keepNormal: number;
	provider?: string;
	model?: string;
	traceIds: string[];
}

export function parsePersonalArgs(args: readonly string[]): PersonalCliOptions {
	const [command, input, ...rest] = args;
	if (command !== "export" && command !== "replay") throw new Error("命令必须为 export 或 replay；用 --help 查看用法。");
	if (!input?.trim() || input.startsWith("--")) throw new Error("必须指定会话文件、会话目录或个人样本文件。");
	const options: PersonalCliOptions = { command, input, output: "", problemsOnly: false, keepNormal: 0, traceIds: [] };
	const seen = new Set<string>();
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		if (seen.has(flag) && flag !== "--trace-id") throw new Error(`参数重复：${flag}`);
		seen.add(flag);
		if (flag === "--problems-only" && command === "export") { options.problemsOnly = true; continue; }
		const allowed = command === "export" ? ["--output", "--keep-normal"] : ["--output", "--provider", "--model", "--trace-id"];
		if (!allowed.includes(flag)) throw new Error(`未知或不适用的参数：${flag}`);
		const value = rest[++index];
		if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} 需要非空值。`);
		if (flag === "--output") options.output = value;
		if (flag === "--provider") options.provider = value;
		if (flag === "--model") options.model = value;
		if (flag === "--trace-id") options.traceIds.push(value);
		if (flag === "--keep-normal") {
			if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--keep-normal 必须是非负整数。");
			options.keepNormal = Number(value);
		}
	}
	if (!options.output) throw new Error("必须通过 --output 指定新文件。");
	if (command === "replay" && (!options.provider || !options.model)) throw new Error("重放必须显式指定非空 --provider 和 --model。");
	if (options.keepNormal > 0 && !options.problemsOnly) throw new Error("--keep-normal 必须与 --problems-only 一起使用。");
	if (new Set(options.traceIds).size !== options.traceIds.length) throw new Error("--trace-id 不能重复。");
	if (resolve(options.input) === resolve(options.output)) throw new Error("输出不能覆盖输入，请指定另一个新文件。");
	return options;
}

async function sessionFiles(input: string): Promise<string[]> {
	const info = await lstat(input);
	if (info.isSymbolicLink()) throw new Error("会话输入不能是符号链接；请指定实际文件或目录。");
	if (info.isFile()) return [input];
	if (!info.isDirectory()) throw new Error("会话输入必须是普通文件或目录。");
	const files: string[] = [];
	for (const entry of (await readdir(input, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isSymbolicLink()) continue;
		const path = resolve(input, entry.name);
		if (entry.isDirectory()) files.push(...await sessionFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

async function createPersonalReader(provider: string, id: string): Promise<PersonalReader> {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	if (runtime.getError()) throw new Error("个人模型配置加载失败；请检查 PI_CODING_AGENT_DIR 下的 models.json 和认证配置。");
	const model = runtime.getPhysicalModel(provider, id);
	if (!model) throw new Error(`未找到模型 ${provider}/${id}；请使用个人 models.json 中的精确 provider 和模型 ID。`);
	if (!runtime.hasConfiguredAuth(provider)) throw new Error(`提供方 ${provider} 尚未配置认证；请先在个人 Pi 配置中登录或配置密钥。`);
	return {
		model: { provider: model.provider, id: model.id, api: model.api },
		complete: (systemPrompt, payload, signal) => runtime.completeSimple(model, {
			messages: [
				{ role: "system", content: systemPrompt, timestamp: Date.now() },
				{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() },
			],
		}, { signal, maxRetries: 0, cacheRetention: "none", maxTokens: Math.min(8192, model.maxTokens), transport: "sse", sessionId: `personal-replay:humanize:${randomUUID()}` }),
	};
}

export async function runPersonalCli(
	args: readonly string[],
	dependencies: { createReader?: (provider: string, id: string) => Promise<PersonalReader>; log?: (message: string) => void } = {},
): Promise<void> {
	const log = dependencies.log ?? console.log;
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) { log(HELP); return; }
	const options = parsePersonalArgs(args);
	const outputDirectory = dirname(resolve(options.output));
	let directoryInfo;
	try {
		directoryInfo = await stat(outputDirectory);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error("输出父目录不存在；请先创建目录或修改 --output，尚未调用审阅模型。");
		if (code === "ENOTDIR") throw new Error("输出父路径不是目录；请修改 --output，尚未调用审阅模型。");
		throw new Error("无法访问输出父目录；请检查目录权限，尚未调用审阅模型。");
	}
	if (!directoryInfo.isDirectory()) throw new Error("输出父路径不是目录；请修改 --output，尚未调用审阅模型。");
	try {
		await access(outputDirectory, constants.W_OK | constants.X_OK);
	} catch {
		throw new Error("输出父目录不可写或无法进入；请检查目录权限，尚未调用审阅模型。");
	}
	try {
		await lstat(options.output);
		throw new Error("输出文件已经存在；请指定新的 --output，旧结果不会被覆盖。");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let result: unknown;
	let summary: string;
	if (options.command === "export") {
		const files = await sessionFiles(resolve(options.input));
		if (files.length === 0) throw new Error("目录中没有 .jsonl 会话文件。");
		const sessions: string[] = [];
		for (const file of files) sessions.push(await readFile(file, "utf8"));
		const dataset = exportPersonalSamples(sessions, options);
		result = dataset;
		const inherited = dataset.sources.reduce((count, source) => count + source.inheritedTraces, 0);
		summary = `导出 ${dataset.samples.length} 条个人样本，来自 ${dataset.sources.length} 个会话。${inherited > 0 ? `跳过分支中复制的 ${inherited} 条旧会话记录；可从原会话导出。` : ""}`;
	} else {
		const text = await readFile(options.input, "utf8");
		let dataset: unknown;
		try { dataset = JSON.parse(text); } catch { throw new Error("输入不是有效的个人样本 JSON。"); }
		validateDataset(dataset);
		if (dataset.samples.length === 0) throw new Error("样本为空，没有可重放的消息。");
		if (options.traceIds.some(id => !dataset.samples.some(sample => sample.id === id))) throw new Error("--trace-id 在样本中不存在。");
		const reader = await (dependencies.createReader ?? createPersonalReader)(options.provider!, options.model!);
		const replay = await replayPersonalSamples(dataset, reader, {
			sourceDatasetSha256: sha256(text),
			coreSha256: sha256(await readFile(new URL("../packages/coding-agent/src/core/humanize.ts", import.meta.url), "utf8")),
			...(options.traceIds.length > 0 ? { traceIds: options.traceIds } : {}),
		});
		result = replay;
		summary = `重放 ${replay.results.length} 条：批准 ${replay.results.filter(item => item.status === "approved").length} 条，失败 ${replay.results.filter(item => item.status === "failed").length} 条。失败详情保留在结果中。`;
	}
	await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	log(summary);
	log("新结果已保存；输入文件保持不变。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	runPersonalCli(process.argv.slice(2)).catch(error => {
		console.error(error instanceof Error ? error.message : "个人样本命令失败。");
		process.exitCode = 1;
	});
}
