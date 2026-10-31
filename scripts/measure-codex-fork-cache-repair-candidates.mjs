#!/usr/bin/env node
// 在独立 app-server 中测量临时与持久化 fork；不操作真实任务或已安装二进制。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import {
	assessHistoryReuse,
	buildIsolatedEnvironment,
	createSyntheticForkCacheMeasurementPrompt,
	prepareIsolatedNativeAgentMeasurementConfiguration,
	readCodexNativePromptConfigurationEvidence,
	writeNativeAgentMeasurementManifestAtomically as writeManifest,
} from "./measure-native-agent-fork-prompt-cache.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const ensurePrivateDirectory = (path) => mkdirSync(path, { recursive: true, mode: 0o700 });
const supportedForkModes = ["persistent", "ephemeral", "prediction-ephemeral"];

export function buildCodexForkModeParameters(mode, parentThreadId) {
	if (!supportedForkModes.includes(mode)) throw new Error(`未知 fork 模式：${mode}`);
	return {
		threadId: parentThreadId,
		excludeTurns: true,
		...(mode === "persistent" ? {} : { ephemeral: true }),
		...(mode === "prediction-ephemeral" ? { experimentalPredictionMode: true } : {}),
	};
}

export function summarizeAppServerTurnMeasurement(frames, threadId, turnId, marker) {
	const problems = [];
	const matching = frames.filter(
		(frame) =>
			frame.params?.threadId === threadId && (frame.params.turnId === turnId || frame.params.turn?.id === turnId),
	);
	const accepted = matching.some(
		(frame) =>
			["item/started", "item/completed"].includes(frame.method) &&
			frame.params.item?.type === "userMessage" &&
			JSON.stringify(frame.params.item).includes(marker),
	);
	const completion = matching.findLast((frame) => frame.method === "turn/completed");
	const completed = completion?.params.turn.status === "completed" && !completion.params.turn.error;
	const uniqueUsage = new Map();
	for (const frame of matching.filter((frame) => frame.method === "thread/tokenUsage/updated")) {
		const usage = frame.params.tokenUsage?.last;
		if (
			!usage ||
			![usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].every(
				(value) => Number.isSafeInteger(value) && value >= 0,
			) ||
			usage.inputTokens === 0 ||
			usage.cachedInputTokens > usage.inputTokens
		) {
			problems.push("缺少有效逐请求 last 用量");
			continue;
		}
		uniqueUsage.set(JSON.stringify(frame.params.tokenUsage), {
			inputTokens: usage.inputTokens,
			cachedInputTokens: usage.cachedInputTokens,
			outputTokens: usage.outputTokens,
		});
	}
	if (!accepted) problems.push("缺少绑定回合的原生用户接受记录");
	if (!completed) problems.push("缺少绑定回合的成功结束记录");
	if (uniqueUsage.size !== 1) problems.push("逐请求计量缺失或不止一次模型请求");
	if (matching.some((frame) => /compact/i.test(frame.method) || /compact/i.test(frame.params.item?.type ?? "")))
		problems.push("本轮发生压缩");
	return { completed, accepted, problems: [...new Set(problems)], requests: [...uniqueUsage.values()] };
}

export function verifyAppServerForkInheritance(thread, parentThreadId, items, parentPrompts) {
	return (
		!!thread.id &&
		thread.id !== parentThreadId &&
		thread.forkedFromId === parentThreadId &&
		parentPrompts.every((prompt) => JSON.stringify(items).includes(JSON.stringify(prompt).slice(1, -1)))
	);
}

export function verifyAppServerHistoryNonceRecall(frames, threadId, turnId, parentPrompts) {
	const final = frames.findLast(
		(frame) =>
			frame.method === "item/completed" &&
			frame.params?.threadId === threadId &&
			frame.params.turnId === turnId &&
			frame.params.item?.type === "agentMessage",
	);
	try {
		const actual = JSON.parse(final.params.item.text);
		const expected = parentPrompts.map((prompt) => prompt.split("\n")[0].split("=")[1]);
		return JSON.stringify(actual) === JSON.stringify(expected);
	} catch {
		return false;
	}
}

export function recoverAppServerAcceptedTurnId(frames, threadId, marker) {
	const turnIds = new Set(
		frames
			.filter(
				(frame) =>
					["item/started", "item/completed"].includes(frame.method) &&
					frame.params?.threadId === threadId &&
					typeof frame.params.turnId === "string" &&
					frame.params.item?.type === "userMessage" &&
					JSON.stringify(frame.params.item).includes(marker),
			)
			.map((frame) => frame.params.turnId),
	);
	return turnIds.size === 1 ? [...turnIds][0] : null;
}

function reconcileRecordedRepairTurns(state, frames) {
	for (const context of state.contexts) {
		for (const operation of context.operations) {
			operation.turnId ??= recoverAppServerAcceptedTurnId(frames, operation.threadId, operation.marker);
			if (!operation.turnId) continue;
			const measurement = summarizeAppServerTurnMeasurement(
				frames,
				operation.threadId,
				operation.turnId,
				operation.marker,
			);
			measurement.requests = measurement.requests.map((item) => ({
				...item,
				model: operation.model,
				configurationFingerprint: operation.configurationFingerprint,
			}));
			operation.measurement = measurement;
			if (measurement.completed && measurement.accepted && !measurement.problems.length)
				operation.status = "completed";
		}
	}
}

function historyChallengePrompt() {
	return `CACHE_MEASUREMENT_REQUEST=${randomUUID()}\n只返回本条消息之前最早两条用户消息中的 CACHE_MEASUREMENT_REQUEST 标记值（等号后的 UUID），按时间顺序组成 JSON 字符串数组。不要包括当前消息的标记，不要加 Markdown，不调用工具。`;
}

function parseProtocolJournal(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const row = JSON.parse(line);
				return row.direction === "received" ? [row.frame] : [];
			} catch {
				return [];
			}
		});
}

function createNativeAppServerClient(binary, environment, cwd, evidenceDirectory) {
	const logPath = join(evidenceDirectory, "native-app-server-protocol.jsonl");
	const descriptor = openSync(logPath, "a", 0o600);
	const stderr = openSync(join(evidenceDirectory, "native-app-server-stderr.log"), "a", 0o600);
	const frames = [];
	const pending = new Map();
	const listeners = new Set();
	let sequence = 0;
	let closed = false;
	const record = (direction, frame) => {
		appendFileSync(descriptor, `${JSON.stringify({ observedAt: new Date().toISOString(), direction, frame })}\n`);
		fsyncSync(descriptor);
	};
	const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
		cwd,
		env: environment,
		detached: true,
		stdio: ["pipe", "pipe", stderr],
	});
	child.stdin.on("error", () => {});
	const rejectPending = (error) => {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	};
	const lines = createInterface({ input: child.stdout });
	const send = (frame) => {
		record("sent", frame);
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	lines.on("line", (line) => {
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		record("received", frame);
		frames.push(frame);
		if (frame.id !== undefined && pending.has(frame.id)) {
			const request = pending.get(frame.id);
			pending.delete(frame.id);
			clearTimeout(request.timer);
			if (frame.error) request.reject(new Error(`原生 ${request.method} 拒绝：${JSON.stringify(frame.error)}`));
			else request.resolve(frame.result);
		} else if (frame.id !== undefined && frame.method)
			send({ id: frame.id, error: { code: -32601, message: "本次缓存测量不执行工具、审批或问答" } });
		for (const listener of listeners) listener();
	});
	child.on("error", (error) => rejectPending(error));
	child.on("close", () => {
		closed = true;
		rejectPending(new Error("隔离 app-server 已退出"));
		for (const listener of listeners) listener();
	});
	return {
		frames,
		loadedThreadIds: new Set(),
		logPath,
		request(method, params) {
			if (closed) return Promise.reject(new Error("隔离 app-server 已关闭"));
			return new Promise((resolveRequest, reject) => {
				const id = `${process.pid}-${++sequence}`;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`原生请求超时：${method}`));
				}, 60_000);
				pending.set(id, { method, resolve: resolveRequest, reject, timer });
				send({ id, method, params });
			});
		},
		notify: (method) => send({ method }),
		waitForCompletion(threadId, turnId) {
			return new Promise((resolveWait, reject) => {
				const finish = (error) => {
					clearTimeout(timer);
					listeners.delete(check);
					error ? reject(error) : resolveWait();
				};
				const check = () => {
					if (
						frames.some(
							(frame) =>
								frame.method === "turn/completed" &&
								frame.params.threadId === threadId &&
								frame.params.turn.id === turnId,
						)
					)
						finish();
					else if (closed) finish(new Error("原生回合结束前进程退出，保留未知提交状态"));
				};
				const timer = setTimeout(() => finish(new Error("原生模型回合超时，保留未知提交状态")), 300_000);
				listeners.add(check);
				check();
			});
		},
		async close() {
			child.stdin.end();
			for (let index = 0; index < 20 && !closed; index++) await delay(100);
			if (!closed) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {}
			}
			for (let index = 0; index < 30 && !closed; index++) await delay(100);
			if (!closed) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}
			for (let index = 0; index < 10 && !closed; index++) await delay(100);
			lines.removeAllListeners("line");
			lines.close();
			closeSync(descriptor);
			closeSync(stderr);
		},
	};
}

function profileFingerprint(reply, configuration) {
	return sha256(
		JSON.stringify({
			model: reply.model ?? configuration.model,
			reasoning: reply.reasoningEffort ?? configuration.reasoning,
			modelProvider: reply.modelProvider ?? "openai",
			approvalPolicy: reply.approvalPolicy,
			sandbox: reply.sandbox,
			cwd: reply.cwd,
		}),
	);
}

async function readInheritedItems(client, threadId) {
	const items = [];
	let cursor;
	for (let index = 0; index < 20; index++) {
		const page = await client.request("thread/items/list", {
			threadId,
			limit: 100,
			sortDirection: "asc",
			...(cursor ? { cursor } : {}),
		});
		items.push(...page.data);
		cursor = page.nextCursor;
		if (!cursor) return items;
	}
	throw new Error("原生历史分页超过本实验的有界范围");
}

function sourceTranscriptPath(codexHome, thread) {
	if (thread.path && existsSync(thread.path) && !relative(codexHome, thread.path).startsWith("..")) return thread.path;
	const directory = join(codexHome, "sessions");
	if (!existsSync(directory)) return null;
	for (const item of readdirSync(directory, { recursive: true }).filter((item) => item.endsWith(".jsonl"))) {
		const path = join(directory, item);
		const metadata = readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.find((row) => row.type === "session_meta");
		if (metadata?.payload.id === thread.id) return path;
	}
	return null;
}

async function performMeasuredTurn(client, state, context, key, threadReply, prompt, configuration, save) {
	let operation = context.operations.find((item) => item.key === key);
	if (operation && threadReply?.thread?.id && operation.threadId !== threadReply.thread.id)
		throw new Error("已有计量属于另一个子线程，不能复用到当前分身");
	if (!operation) {
		operation = {
			key,
			threadId: threadReply.thread.id,
			marker: prompt.split("\n")[0],
			prompt,
			status: "prepared",
			model: threadReply.model ?? configuration.model,
			configurationFingerprint: profileFingerprint(threadReply, configuration),
		};
		context.operations.push(operation);
		save();
	}
	if (operation.status !== "prepared") return operation;
	operation.status = "submitting";
	operation.startedAt = new Date().toISOString();
	save();
	console.log(`开始 ${state.binaryLabel} ${context.targetTokens} ${key}`);
	try {
		const reply = await client.request("turn/start", {
			threadId: operation.threadId,
			input: [{ type: "text", text: operation.prompt, text_elements: [] }],
			model: configuration.model,
			effort: configuration.reasoning,
		});
		operation.turnId = reply.turn.id;
		save();
		await client.waitForCompletion(operation.threadId, operation.turnId);
		operation.measurement = summarizeAppServerTurnMeasurement(
			client.frames,
			operation.threadId,
			operation.turnId,
			operation.marker,
		);
		operation.measurement.requests = operation.measurement.requests.map((item) => ({
			...item,
			model: operation.model,
			configurationFingerprint: operation.configurationFingerprint,
		}));
		operation.status =
			operation.measurement.completed && operation.measurement.accepted ? "completed" : "insufficient_evidence";
	} catch (error) {
		operation.status = "awaiting_native_evidence";
		operation.problem = error.message;
	}
	operation.finishedAt = new Date().toISOString();
	save();
	console.log(`结束 ${key}：${operation.status} ${JSON.stringify(operation.measurement?.requests ?? [])}`);
	return operation;
}

const simplePrompt = () => `CACHE_MEASUREMENT_REQUEST=${randomUUID()}\n不要调用工具，不要修改文件，只答 OK。`;
const isComplete = (operation) =>
	operation?.status === "completed" &&
	operation.measurement?.requests.length === 1 &&
	!operation.measurement.problems.length;

export function selectBoundRepairOperation(operations, fork) {
	const operation = operations.find((item) => item.key === fork.key);
	if (!operation || (fork.thread?.id && operation.threadId !== fork.thread.id)) return undefined;
	return operation;
}

export function codexRepairContextIsComplete(context, forkCount, modes) {
	const required = [
		"cold-prefix-baseline",
		"parent-create",
		"parent-hot-before",
		"parent-hot-after",
		...Array.from({ length: forkCount }, (_, index) => modes.map((mode) => `${mode}-${index + 1}-first`)).flat(),
	];
	return (
		required.every((key) => isComplete(context.operations.find((item) => item.key === key))) &&
		isComplete(context.operations.find((item) => item.key.endsWith("-second-control")))
	);
}

export function codexRepairLiveRunIsComplete(state, rows) {
	const expected = state.options.contexts.length * state.options.modes.length * state.options.forkCount;
	return (
		rows.length === expected &&
		rows.every((row) => row.status === "measured") &&
		state.options.contexts.every((targetTokens) =>
			codexRepairContextIsComplete(
				state.contexts.find((item) => item.targetTokens === targetTokens) ?? { operations: [] },
				state.options.forkCount,
				state.options.modes,
			),
		)
	);
}

function generateRepairReport(evidenceDirectory, state) {
	const rows = [];
	for (const context of state.contexts) {
		const before = context.operations.find((item) => item.key === "parent-hot-before");
		const after = context.operations.find((item) => item.key === "parent-hot-after");
		const baseline = context.operations.find((item) => item.key === "cold-prefix-baseline");
		const parent = context.operations.find((item) => item.key === "parent-create");
		for (const fork of context.forks) {
			const operation = selectBoundRepairOperation(context.operations, fork);
			const problems = [operation, before, after, baseline, parent].flatMap((item) =>
				isComplete(item) ? [] : [`${item?.key ?? "前置步骤"} 缺少有效计量`],
			);
			if (!fork.historyVerified) problems.push("原生父归属或继承历史证据未通过");
			if (!fork.parentUnchanged) problems.push("父原生转录摘要变化或缺失");
			let assessment = { status: "insufficient_evidence", problems, historyReuseRatio: null };
			if (!problems.length) {
				const cold = {
					...baseline.measurement.requests[0],
					cachedInputTokens: Math.max(
						baseline.measurement.requests[0].cachedInputTokens,
						parent.measurement.requests[0].cachedInputTokens,
					),
				};
				assessment = assessHistoryReuse({
					baseline: cold,
					hotBefore: before.measurement.requests[0],
					hotAfter: after.measurement.requests[0],
					fork: operation.measurement.requests[0],
				});
			}
			if (!operation)
				assessment = {
					status: "not_executed",
					problems: [fork.problem ?? "尚未提交模型回合"],
					historyReuseRatio: null,
				};
			rows.push({
				targetTokens: context.targetTokens,
				mode: fork.mode,
				index: fork.index,
				threadId: fork.thread?.id,
				measurement: operation?.measurement,
				...assessment,
			});
		}
	}
	writeManifest(join(evidenceDirectory, "repair-measurements.json"), {
		analyzedAt: new Date().toISOString(),
		binary: state.binary,
		binarySha256: state.binarySha256,
		binaryLabel: state.binaryLabel,
		rows,
	});
	const percent = (value) => (value == null ? "未知" : `${(value * 100).toFixed(2)}%`);
	const lines = [
		"# Codex 官方与社区修复候选复测",
		"",
		`二进制：${state.binaryLabel}；${state.version}；SHA-256 ${state.binarySha256}。`,
		"",
		"模型 gpt-6.1-sol；推理配置沿用本机快照；仅使用本脚本创建的隔离会话。用量来自绑定 threadId / turnId 的原生 tokenUsage.last，排除累计字段。",
		"",
		"| 目标规模 | fork 模式 | 样本 | 实际 input | cached | 总命中率 | 保守历史复用 | 判定 |",
		"| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
	];
	for (const row of rows) {
		const request = row.measurement?.requests[0];
		lines.push(
			`| ${row.targetTokens} | ${row.mode} | ${row.index} | ${request?.inputTokens ?? "—"} | ${request?.cachedInputTokens ?? "—"} | ${request ? percent(request.cachedInputTokens / request.inputTokens) : "未知"} | ${percent(row.historyReuseRatio)} | ${row.status} |`,
		);
	}
	for (const context of state.contexts) {
		lines.push("", `## ${context.targetTokens} 的对照与资格`, "");
		for (const operation of context.operations.filter((item) => !item.key.includes("-first")))
			lines.push(
				`- ${operation.key}：${operation.status}；${JSON.stringify(operation.measurement?.requests ?? [])}`,
			);
		if (context.problem) lines.push(`- 未完成原因：${context.problem}`);
	}
	for (const row of rows.filter((item) => item.problems.length))
		lines.push(`- ${row.targetTokens}/${row.mode}/${row.index}：${row.problems.join("；")}`);
	lines.push(
		"",
		"临时 fork 不保留可续跑 rollout，原生历史读取不可用时，通过独立父子身份、父历史中的两段随机标记回读和保留输入长度补证；这种证据不等于逐字节比较完整历史。原生协议完整保存在本目录；未知提交状态不会重发。同一目录恢复时继续执行尚未创建或仍为 prepared 的步骤。新的 app-server 进程先 thread/resume 载入已持久化线程，并核对 threadId、父子身份、模型、approvalPolicy 与 sandbox，载入成功后才把模型请求标成 submitting。临时线程在原进程退出后记为不可恢复，不重建或冒充原线程。已完成的首轮读数保留。分身第二轮缺少有效计量时，整个矩阵不算完成。结果仅说明该配置下报告的缓存读取，不证明后端物理重算行为。",
		"",
	);
	writeFileSync(join(evidenceDirectory, "repair-report.zh-CN.md"), lines.join("\n"), { mode: 0o600 });
	return rows;
}

function optionsFromArguments(argv) {
	const options = {
		contexts: [32_000, 128_000],
		modes: supportedForkModes,
		forkCount: 3,
		historyMode: "paginated",
		binaryLabel: "official",
		analyzeOnly: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--analyze-only") {
			options.analyzeOnly = true;
			continue;
		}
		if (argument === "--help") {
			options.help = true;
			continue;
		}
		const value = argv[++index];
		if (!value) throw new Error(`${argument} 缺少值`);
		if (argument === "--evidence-directory") options.evidenceDirectory = resolve(value);
		else if (argument === "--codex-binary") options.binary = realpathSync(value);
		else if (argument === "--binary-label") options.binaryLabel = value;
		else if (argument === "--context-tokens") options.contexts = value.split(",").map(Number);
		else if (argument === "--fork-modes") options.modes = value.split(",");
		else if (argument === "--fork-count") options.forkCount = Number(value);
		else if (argument === "--history-mode") options.historyMode = value;
		else throw new Error(`未知参数：${argument}`);
	}
	if (!options.help && (!options.evidenceDirectory || (!options.analyzeOnly && !options.binary)))
		throw new Error("必须指定持久 evidence-directory 和明确的 codex-binary");
	if (new Set(options.modes).size !== options.modes.length) throw new Error("fork 模式不能重复");
	if (
		options.contexts.some((value) => !Number.isInteger(value) || value < 24_000 || value > 160_000) ||
		options.modes.some((mode) => !supportedForkModes.includes(mode)) ||
		!Number.isInteger(options.forkCount) ||
		options.forkCount < 1 ||
		options.forkCount > 3 ||
		!["legacy", "paginated"].includes(options.historyMode)
	)
		throw new Error("实验矩阵参数无效");
	return options;
}

const ephemeralThreadUnrecoverableProblem = "临时线程在原进程退出后不可恢复，不得重建或冒充原线程";
const ephemeralThreadRecoveryCondition = "原 app-server 进程已退出，临时线程没有可载入的持久记录";
const persistentLoadRecoveryCondition = "持久线程尚未载入；模型请求仍为 prepared，未标成 submitting";

function sandboxPolicyMatches(actual, expected) {
	if (typeof actual === "string") return actual === expected;
	if (actual && typeof actual === "object") {
		if (expected === "read-only") return actual.type === "read-only" || actual.type === "readOnly";
		return actual.type === expected;
	}
	return false;
}

export function persistedCodexThreadLoadMatchesFrozenConfiguration(reply, expected) {
	const problems = [];
	if (!reply?.thread?.id || reply.thread.id !== expected.threadId) problems.push("载入线程身份与清单不一致");
	if (expected.forkedFromId && reply.thread?.forkedFromId !== expected.forkedFromId)
		problems.push("载入线程的父身份与清单不一致");
	if (!reply?.model || reply.model !== expected.model) problems.push("载入线程的模型与冻结配置不一致");
	if (expected.reasoningEffort && reply?.reasoningEffort && reply.reasoningEffort !== expected.reasoningEffort)
		problems.push("载入线程的推理配置与冻结配置不一致");
	if (reply?.approvalPolicy !== expected.approvalPolicy)
		problems.push("载入线程的 approvalPolicy 与冻结配置不一致");
	if (!sandboxPolicyMatches(reply?.sandbox, expected.sandbox))
		problems.push("载入线程的 sandbox 与冻结配置不一致");
	return problems;
}

function measurementThreadPersistence(modeOrKey) {
	return String(modeOrKey).includes("ephemeral") ? "ephemeral" : "persistent";
}

function expectsForkParentIdentity(key) {
	return key.includes("-first") || key.endsWith("-second-control");
}

function rememberLoadedThread(client, threadId) {
	client.loadedThreadIds ??= new Set();
	if (threadId) client.loadedThreadIds.add(threadId);
}

function recordUnrecoverableEphemeralTurn(context, key, threadReply, prompt, configuration, save) {
	let operation = context.operations.find((item) => item.key === key);
	if (!operation) {
		operation = {
			key,
			threadId: threadReply.thread.id,
			marker: (prompt ?? "").split("\n")[0],
			prompt,
			status: "insufficient_evidence",
			problem: ephemeralThreadUnrecoverableProblem,
			recoveryCondition: ephemeralThreadRecoveryCondition,
			model: threadReply.model ?? configuration.model,
		};
		context.operations.push(operation);
	} else if (operation.status === "prepared") {
		operation.status = "insufficient_evidence";
		operation.problem = ephemeralThreadUnrecoverableProblem;
		operation.recoveryCondition = ephemeralThreadRecoveryCondition;
	}
	save();
	return operation;
}

async function ensurePersistedThreadLoaded(client, state, context, key, threadReply, prompt, save, forkedFromId) {
	const threadId = threadReply?.thread?.id;
	if (!threadId) throw new Error("缺少可载入的原生线程身份");
	client.loadedThreadIds ??= new Set();
	if (client.loadedThreadIds.has(threadId)) return threadReply;
	if (measurementThreadPersistence(key) === "ephemeral") {
		recordUnrecoverableEphemeralTurn(
			context,
			key,
			threadReply,
			prompt,
			state.configuration,
			save,
		);
		return null;
	}
	const operation = context.operations.find((item) => item.key === key);
	let reply;
	try {
		reply = await client.request("thread/resume", { threadId });
	} catch (error) {
		if (operation?.status === "prepared") {
			operation.problem = error.message;
			operation.recoveryCondition = persistentLoadRecoveryCondition;
			save();
		}
		throw error;
	}
	const problems = persistedCodexThreadLoadMatchesFrozenConfiguration(reply, {
		threadId,
		forkedFromId,
		model: threadReply.model ?? state.configuration.model,
		reasoningEffort: threadReply.reasoningEffort ?? state.configuration.reasoning,
		approvalPolicy: threadReply.approvalPolicy ?? "never",
		sandbox: threadReply.sandbox ?? "read-only",
	});
	if (problems.length) {
		const problem = problems.join("；");
		if (operation?.status === "prepared") {
			operation.status = "insufficient_evidence";
			operation.problem = problem;
			operation.recoveryCondition = "载入结果与冻结的线程身份或模型、审批、沙箱配置不一致，不提交模型请求";
			save();
		}
		throw new Error(problem);
	}
	rememberLoadedThread(client, reply.thread.id);
	return {
		...threadReply,
		...reply,
		thread: { ...threadReply.thread, ...reply.thread },
		model: reply.model ?? threadReply.model,
		reasoningEffort: reply.reasoningEffort ?? threadReply.reasoningEffort,
		approvalPolicy: reply.approvalPolicy ?? threadReply.approvalPolicy,
		sandbox: reply.sandbox ?? threadReply.sandbox,
	};
}

async function measurePreparedOrUnstartedTurn(client, state, context, key, ensureThread, prompt, save) {
	const existing = context.operations.find((item) => item.key === key);
	// submitting、证据不足、完成和提交状态未知都不重发；prepared 与尚未创建的步骤才继续。
	if (existing && existing.status !== "prepared") return existing;
	const threadReply = existing?.threadId
		? {
				thread: { id: existing.threadId },
				model: existing.model ?? state.configuration.model,
				reasoningEffort: state.configuration.reasoning,
				modelProvider: context.parent?.modelProvider,
				approvalPolicy: existing.approvalPolicy ?? context.parent?.approvalPolicy ?? "never",
				sandbox: existing.sandbox ?? context.parent?.sandbox ?? "read-only",
				cwd: existing.cwd ?? context.parent?.cwd,
			}
		: await ensureThread();
	const loaded = await ensurePersistedThreadLoaded(
		client,
		state,
		context,
		key,
		threadReply,
		existing?.prompt ?? prompt,
		save,
		expectsForkParentIdentity(key) ? context.parent?.thread?.id : undefined,
	);
	if (!loaded) return context.operations.find((item) => item.key === key) ?? existing;
	return performMeasuredTurn(
		client,
		state,
		context,
		key,
		loaded,
		existing?.prompt ?? prompt,
		state.configuration,
		save,
	);
}

async function resumeCodexRepairContext({ client, state, context, options, paths, evidenceDirectory, cwd, save }) {
	const start = async () => {
		const reply = await client.request("thread/start", {
			model: state.configuration.model,
			cwd,
			approvalPolicy: "never",
			sandbox: "read-only",
			historyMode: options.historyMode,
			experimentalRawEvents: true,
		});
		rememberLoadedThread(client, reply?.thread?.id);
		return reply;
	};
	const baseline = await measurePreparedOrUnstartedTurn(
		client,
		state,
		context,
		"cold-prefix-baseline",
		start,
		simplePrompt(),
		save,
	);
	if (!isComplete(baseline)) throw new Error("空历史基线未完成，保留未知状态");
	const storedParentPrompt = context.operations.find((item) => item.key === "parent-create")?.prompt;
	const parentPrompt =
		storedParentPrompt ??
		createSyntheticForkCacheMeasurementPrompt(
			`CACHE_MEASUREMENT_REQUEST=${randomUUID()}`,
			Math.max(1_000, context.targetTokens - baseline.measurement.requests[0].inputTokens),
		);
	const parentCreate = await measurePreparedOrUnstartedTurn(
		client,
		state,
		context,
		"parent-create",
		async () => {
			const reply = await start();
			context.parent = reply;
			save();
			return reply;
		},
		parentPrompt,
		save,
	);
	if (!isComplete(parentCreate)) throw new Error("父会话创建没有完整计量");
	if (!context.parent?.thread?.id) {
		context.parent = {
			thread: { id: parentCreate.threadId },
			model: state.configuration.model,
			reasoningEffort: state.configuration.reasoning,
		};
		save();
	}
	const hotPrompt = context.operations.find((item) => item.key === "parent-hot-before")?.prompt ?? simplePrompt();
	const hotBefore = await measurePreparedOrUnstartedTurn(
		client,
		state,
		context,
		"parent-hot-before",
		async () => context.parent,
		hotPrompt,
		save,
	);
	if (!isComplete(hotBefore)) throw new Error("父热对照没有完整计量");
	let parentPath = context.parentTranscriptPath;
	if (!context.frozenParentSha256) {
		await delay(300);
		parentPath = sourceTranscriptPath(paths.codexHome, context.parent.thread);
		if (!parentPath) throw new Error("无法绑定父原生转录路径");
		const frozenParent = readFileSync(parentPath);
		context.parentTranscriptPath = parentPath;
		context.frozenParentSha256 = sha256(frozenParent);
		context.parentPromptConfiguration = readCodexNativePromptConfigurationEvidence(frozenParent.toString("utf8"));
		copyFileSync(parentPath, join(evidenceDirectory, `frozen-parent-${context.targetTokens}.jsonl`));
		save();
	} else if (!parentPath || sha256(readFileSync(parentPath)) !== context.frozenParentSha256)
		throw new Error("父历史已变化，禁止继续从非冻结状态派生");
	for (let index = 1; index <= options.forkCount; index++) {
		for (const mode of options.modes) {
			const key = `${mode}-${index}-first`;
			let fork = context.forks.find((item) => item.key === key);
			const forkRecordIsNew = !fork;
			if (!fork) {
				fork = { mode, index, key, status: "creating" };
				context.forks.push(fork);
				save();
			}
			const boundOperation = context.operations.find((item) => item.key === key && item.threadId === fork.thread?.id);
			if (fork.thread?.id && isComplete(boundOperation)) {
				fork.parentUnchanged = sha256(readFileSync(parentPath)) === context.frozenParentSha256;
				fork.status = boundOperation.status;
				save();
				continue;
			}
			if (!forkRecordIsNew && !fork.thread?.id) {
				fork.status = "awaiting_native_evidence";
				fork.problem = "分身创建已开始但没有子线程记录，不重新 fork";
				console.log(`${key} 未完成：${fork.problem}`);
				save();
				continue;
			}
			try {
				if (sha256(readFileSync(parentPath)) !== context.frozenParentSha256)
					throw new Error("父历史已变化，禁止继续从非冻结状态派生");
				if (!fork.thread?.id) {
					const reply = await client.request(
						"thread/fork",
						buildCodexForkModeParameters(mode, context.parent.thread.id),
					);
					fork.thread = reply.thread;
					rememberLoadedThread(client, reply.thread?.id);
					fork.profile = { model: reply.model, reasoningEffort: reply.reasoningEffort };
					if (reply.model && reply.model !== state.configuration.model)
						throw new Error("fork 返回了不同模型，未提交模型请求");
					if (reply.thread.id === context.parent.thread.id || reply.thread.forkedFromId !== context.parent.thread.id)
						throw new Error("缺少独立子身份或原生父归属，未提交模型请求");
					save();
				}
				const existingForkTurn = context.operations.find((item) => item.key === key);
				if (existingForkTurn && existingForkTurn.threadId !== fork.thread.id)
					throw new Error("已有计量属于另一个子线程，不能复用到当前分身");
				if (existingForkTurn && existingForkTurn.status !== "prepared") {
					fork.status = existingForkTurn.status;
					fork.parentUnchanged = sha256(readFileSync(parentPath)) === context.frozenParentSha256;
					save();
					continue;
				}
				const forkPrompt = existingForkTurn?.prompt ?? simplePrompt();
				const threadReply = {
					thread: fork.thread,
					model: fork.profile?.model ?? existingForkTurn?.model ?? state.configuration.model,
					reasoningEffort: fork.profile?.reasoningEffort ?? state.configuration.reasoning,
					modelProvider: context.parent.modelProvider,
					approvalPolicy: existingForkTurn?.approvalPolicy ?? context.parent.approvalPolicy ?? "never",
					sandbox: existingForkTurn?.sandbox ?? context.parent.sandbox ?? "read-only",
					cwd: context.parent.cwd,
				};
				const loadedForkThread = await ensurePersistedThreadLoaded(
					client,
					state,
					context,
					key,
					threadReply,
					forkPrompt,
					save,
					context.parent.thread.id,
				);
				if (!loadedForkThread) {
					const recorded = context.operations.find((item) => item.key === key);
					fork.status = recorded?.status ?? "insufficient_evidence";
					fork.problem = recorded?.problem ?? ephemeralThreadUnrecoverableProblem;
					fork.parentUnchanged = sha256(readFileSync(parentPath)) === context.frozenParentSha256;
					save();
					continue;
				}
				let requiresNonceRecall =
					fork.historyVerificationMethod === "native_parentage_two_random_nonces_and_retained_input_length" ||
					Boolean(fork.historyReadUnavailableReason);
				if (!fork.historyVerified && !fork.historyReadUnavailableReason) {
					try {
						const items = await readInheritedItems(client, fork.thread.id);
						fork.inheritedItemsSha256 = sha256(JSON.stringify(items));
						fork.historyVerified = verifyAppServerForkInheritance(
							fork.thread,
							context.parent.thread.id,
							items,
							[parentPrompt, hotPrompt],
						);
						fork.historyVerificationMethod = "native_items_full_prompt_comparison";
						if (!fork.historyVerified) throw new Error("原生历史与父提示词不匹配");
					} catch (error) {
						if (mode === "persistent" || !/not supported|ephemeral.*includeTurns/.test(error.message)) throw error;
						fork.historyReadUnavailableReason = error.message;
						requiresNonceRecall = true;
					}
				}
				const measured = await performMeasuredTurn(
					client,
					state,
					context,
					key,
					loadedForkThread,
					existingForkTurn?.prompt ?? (requiresNonceRecall ? historyChallengePrompt() : simplePrompt()),
					state.configuration,
					save,
				);
				if (requiresNonceRecall) {
					fork.historyVerificationMethod = "native_parentage_two_random_nonces_and_retained_input_length";
					fork.historyNonceRecallVerified = verifyAppServerHistoryNonceRecall(
						client.frames,
						fork.thread.id,
						measured.turnId,
						[parentPrompt, hotPrompt],
					);
					fork.inheritedInputLengthVerified =
						measured.measurement?.requests[0]?.inputTokens >= hotBefore.measurement.requests[0].inputTokens - 1024;
					fork.historyVerified = fork.historyNonceRecallVerified && fork.inheritedInputLengthVerified;
				}
				fork.status = measured.status;
			} catch (error) {
				fork.status = "awaiting_native_evidence";
				fork.problem = error.message;
				console.log(`${key} 未完成：${error.message}`);
			}
			fork.parentUnchanged = sha256(readFileSync(parentPath)) === context.frozenParentSha256;
			save();
		}
	}
	const successful = context.forks.findLast((fork) => fork.status === "completed" && fork.thread?.id);
	if (successful) {
		await measurePreparedOrUnstartedTurn(
			client,
			state,
			context,
			`${successful.mode}-second-control`,
			async () => ({
				thread: successful.thread,
				model: state.configuration.model,
				reasoningEffort: state.configuration.reasoning,
				modelProvider: context.parent.modelProvider,
				approvalPolicy: context.parent.approvalPolicy,
				sandbox: context.parent.sandbox,
				cwd: context.parent.cwd,
			}),
			simplePrompt(),
			save,
		);
	}
	const hotAfter = await measurePreparedOrUnstartedTurn(
		client,
		state,
		context,
		"parent-hot-after",
		async () => context.parent,
		simplePrompt(),
		save,
	);
	if (!isComplete(hotAfter) || !codexRepairContextIsComplete(context, options.forkCount, options.modes))
		throw new Error("分身第二轮或后续对照缺少有效计量，保留已完成的首轮数据");
}

async function main() {
	const options = optionsFromArguments(process.argv.slice(2));
	if (options.help) {
		console.log(
			"用法：node scripts/measure-codex-fork-cache-repair-candidates.mjs --codex-binary <明确二进制> --evidence-directory <持久目录> [--binary-label official|community-patched] [--fork-modes persistent,ephemeral,prediction-ephemeral] [--context-tokens 32000,128000] [--fork-count 3] [--history-mode paginated|legacy] [--analyze-only]",
		);
		return;
	}
	const evidenceDirectory = options.evidenceDirectory;
	if (/^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/.test(evidenceDirectory)) throw new Error("证据必须使用持久目录");
	ensurePrivateDirectory(evidenceDirectory);
	const release = await lockfile.lock(evidenceDirectory, {
		realpath: true,
		stale: 120_000,
		update: 10_000,
		retries: 0,
	});
	let client;
	try {
		const manifestPath = join(evidenceDirectory, "repair-run-manifest.json");
		let state = existsSync(manifestPath) ? readJson(manifestPath) : null;
		const save = () => writeManifest(manifestPath, state);
		if (options.analyzeOnly) {
			if (!state) throw new Error("目录缺少既有运行清单");
			const frames = parseProtocolJournal(join(evidenceDirectory, "native-app-server-protocol.jsonl"));
			reconcileRecordedRepairTurns(state, frames);
			save();
			generateRepairReport(evidenceDirectory, state);
			console.log("离线重算完成");
			return;
		}
		const paths = {
			home: join(evidenceDirectory, "private-runtime", "home"),
			codexHome: join(evidenceDirectory, "private-runtime", "codex-home"),
			kimiHome: join(evidenceDirectory, "private-runtime", "kimi-home"),
		};
		const cwd = join(evidenceDirectory, "private-runtime", "working-directory");
		for (const path of [...Object.values(paths), cwd, join(paths.home, "process-temporary-files")])
			ensurePrivateDirectory(path);
		const environment = buildIsolatedEnvironment(process.env, paths);
		const version = spawnSync(options.binary, ["--version"], {
			env: environment,
			encoding: "utf8",
			timeout: 20_000,
		}).stdout.trim();
		if (version !== "codex-cli 0.166.0") throw new Error(`候选版本与固定源版本不符：${version}`);
		const binarySha256 = sha256(readFileSync(options.binary));
		if (!state) {
			const configuration = prepareIsolatedNativeAgentMeasurementConfiguration("codex", paths.codexHome);
			if (typeof configuration.reasoning !== "string") throw new Error("缺少明确推理配置");
			const measurementSources = [];
			for (const name of [
				"measure-codex-fork-cache-repair-candidates.mjs",
				"measure-native-agent-fork-prompt-cache.mjs",
			]) {
				const source = readFileSync(new URL(name, import.meta.url));
				const snapshot = join(evidenceDirectory, "executed-measurement-source", name);
				ensurePrivateDirectory(dirname(snapshot));
				writeFileSync(snapshot, source, { mode: 0o600 });
				measurementSources.push({ name, snapshot, sha256: sha256(source) });
			}
			state = {
				schemaVersion: 1,
				createdAt: new Date().toISOString(),
				runId: randomUUID(),
				binary: options.binary,
				binaryLabel: options.binaryLabel,
				version,
				binarySha256,
				options,
				configuration,
				measurementSources,
				contexts: [],
			};
			save();
		} else if (
			state.binarySha256 !== binarySha256 ||
			JSON.stringify(state.options.contexts) !== JSON.stringify(options.contexts) ||
			JSON.stringify(state.options.modes) !== JSON.stringify(options.modes) ||
			state.options.forkCount !== options.forkCount ||
			state.options.historyMode !== options.historyMode
		)
			throw new Error("恢复时二进制或矩阵变化，必须使用新目录");
		reconcileRecordedRepairTurns(
			state,
			parseProtocolJournal(join(evidenceDirectory, "native-app-server-protocol.jsonl")),
		);
		save();
		client = createNativeAppServerClient(options.binary, environment, cwd, evidenceDirectory);
		await client.request("initialize", {
			clientInfo: { name: "native-fork-cache-repair-measurement", version: "1" },
			capabilities: { experimentalApi: true },
		});
		client.notify("initialized");
		for (const targetTokens of options.contexts) {
			let context = state.contexts.find((item) => item.targetTokens === targetTokens);
			if (context && codexRepairContextIsComplete(context, options.forkCount, options.modes)) {
				console.log(`保留既有 ${targetTokens}：矩阵已完成，不重发已完成请求`);
				continue;
			}
			if (!context) {
				context = { targetTokens, status: "running", operations: [], forks: [] };
				state.contexts.push(context);
			} else console.log(`接续既有 ${targetTokens}：${context.status}，只执行尚未提交的步骤`);
			context.status = "running";
			save();
			try {
				await resumeCodexRepairContext({
					client,
					state,
					context,
					options,
					paths,
					evidenceDirectory,
					cwd,
					save,
				});
				context.status = "completed";
				context.problem = undefined;
			} catch (error) {
				context.status = "awaiting_native_evidence";
				context.problem = error.message;
				console.log(`${targetTokens} 未完成：${error.message}`);
			}
			generateRepairReport(evidenceDirectory, state);
			save();
		}
		const results = generateRepairReport(evidenceDirectory, state);
		if (!codexRepairLiveRunIsComplete(state, results)) process.exitCode = 2;
		console.log(`修复候选报告：${join(evidenceDirectory, "repair-report.zh-CN.md")}`);
	} finally {
		if (client) await client.close();
		await release();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
	main().catch((error) => {
		console.error(`修复候选复测未完成：${error.message}`);
		process.exitCode = 1;
	});
