#!/usr/bin/env node
// 仅操作脚本创建的私有 Cursor 会话；原生 /fork 通过 PTY 触发，不修改 Kanban 的生产适配器。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import Database from "better-sqlite3";
import pty from "node-pty";
import lockfile from "proper-lockfile";
import {
	assessHistoryReuse,
	buildIsolatedEnvironment,
	createSyntheticForkCacheMeasurementPrompt,
	writeNativeAgentMeasurementManifestAtomically as writeManifest,
} from "./measure-native-agent-fork-prompt-cache.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const privateDirectory = (path) => {
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`私有目录不能是符号链接：${path}`);
	mkdirSync(path, { recursive: true, mode: 0o700 });
};

export function selectCurrentCursorGrokHighModelFromNativeCatalog(catalog) {
	const candidates = stripVTControlCharacters(catalog)
		.split("\n")
		.map((line) => line.trim().split(/\s/)[0])
		.flatMap((id) => {
			const match = /(?:^|[-/])grok-(\d+(?:\.\d+)+)-high$/.exec(id);
			return match ? [{ id, generation: match[1] }] : [];
		});
	candidates.sort((a, b) => b.generation.localeCompare(a.generation, "en", { numeric: true }));
	if (!candidates.length) throw new Error("原生模型目录没有可用的非 Fast Grok high；没有替换模型");
	return candidates[0].id;
}

export function analyzeCursorNativeTurn(stdout, sessionId, marker) {
	const problems = [],
		records = [];
	for (const line of stdout.split("\n").filter((line) => line.trim())) {
		try {
			records.push(JSON.parse(line));
		} catch {
			problems.push("原生输出含破损或非 JSON 记录");
		}
	}
	const own = records.filter((record) => record.session_id === sessionId);
	const initialization = own.find((record) => record.type === "system" && record.subtype === "init");
	const accepted = own.some(
		(record) =>
			record.type === "user" &&
			record.message?.content?.some((item) => item.type === "text" && item.text.includes(marker)),
	);
	const results = own.filter((record) => record.type === "result"),
		assistants = own.filter((record) => record.type === "assistant");
	if (!initialization?.model) problems.push("缺少绑定原生身份的模型初始化记录");
	if (!accepted) problems.push("缺少绑定请求标记的原生用户接受记录");
	if (results.length !== 1 || assistants.length !== 1) problems.push("不是单次成功响应，缺少可拆分逐请求计量");
	if (own.some((record) => /tool|compact|error/i.test(record.type) || /compact/i.test(record.subtype ?? "")))
		problems.push("发生工具调用、压缩或错误，不能作为单请求对照");
	const result = results[0],
		usage = result?.usage;
	if (result?.subtype !== "success" || result.is_error !== false || !result.request_id)
		problems.push("缺少带原生 request_id 的成功结果");
	let request;
	if (
		!usage ||
		![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		)
	)
		problems.push("缺少有效原生用量字段，不能按零补齐");
	else {
		const inputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) problems.push("原生总输入无效");
		else
			request = {
				inputTokens,
				cachedInputTokens: usage.cacheReadTokens,
				outputTokens: usage.outputTokens,
				cacheCreationTokens: usage.cacheWriteTokens,
				model: initialization?.model,
			};
	}
	return {
		accepted,
		problems: [...new Set(problems)],
		request,
		nativeRequestId: result?.request_id,
		nativeModelDisplay: initialization?.model,
	};
}

export function verifyCursorNativeForkStorageInheritance(parent, child) {
	return (
		typeof parent.sessionId === "string" &&
		typeof child.sessionId === "string" &&
		parent.sessionId !== child.sessionId &&
		!!parent.latestRootBlobId &&
		JSON.stringify(parent.latestRootBlobId) === JSON.stringify(child.latestRootBlobId) &&
		parent.model === child.model &&
		parent.mode === child.mode &&
		parent.blobs.length > 0 &&
		JSON.stringify(parent.blobs) === JSON.stringify(child.blobs)
	);
}

export function decodeCursorNativeSqliteMetadata(encoded) {
	if (typeof encoded !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(encoded))
		throw new Error("原生元数据不是有效的十六进制封装");
	let metadata;
	try {
		metadata = JSON.parse(Buffer.from(encoded, "hex").toString("utf8"));
	} catch {
		throw new Error("原生元数据 JSON 解码失败；不输出私有元数据原文");
	}
	if (typeof metadata?.agentId !== "string" || !metadata.agentId || typeof metadata.latestRootBlobId !== "string")
		throw new Error("原生元数据缺少会话身份或历史根指针");
	return {
		agentId: metadata.agentId,
		latestRootBlobId: metadata.latestRootBlobId,
		lastUsedModel: metadata.lastUsedModel,
		mode: metadata.mode,
	};
}

function isolatedEnvironment(state, interactive = false) {
	const environment = {
		...buildIsolatedEnvironment(process.env, {
			home: state.home,
			codexHome: join(state.home, "unused-codex-home"),
			kimiHome: join(state.home, "unused-kimi-home"),
		}),
		AGENT_CLI_CREDENTIAL_STORE: "file",
		CURSOR_CONFIG_DIR: join(state.home, ".cursor"),
		CURSOR_DATA_DIR: join(state.home, ".cursor"),
		DIRENV_DISABLE: "1",
	};
	delete environment.OPENAI_API_KEY;
	if (interactive) {
		delete environment.CI;
		environment.TERM = "xterm-256color";
	}
	return environment;
}

function preparePrivateCredentials(home) {
	const credentials = {};
	for (const [key, service] of [
		["accessToken", "cursor-access-token"],
		["refreshToken", "cursor-refresh-token"],
		["apiKey", "cursor-api-key"],
	]) {
		const result = spawnSync(
			"/usr/bin/security",
			["find-generic-password", "-a", "cursor-user", "-s", service, "-w"],
			{ encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
		);
		if (result.status === 0 && result.stdout.trim()) credentials[key] = result.stdout.trim();
	}
	if (!credentials.accessToken && !credentials.apiKey) throw new Error("未取得 Cursor 凭据，未提交模型请求");
	writeFileSync(join(home, ".cursor", "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
}

function preparePrivateHooks(root, home) {
	const hookPath = join(root, "capture-isolated-cursor-native-hook.mjs"),
		journalPath = join(root, "native-cursor-hooks.jsonl");
	if (existsSync(join(home, ".cursor", "hooks.json"))) return;
	writeFileSync(
		hookPath,
		`import {appendFileSync,openSync,fsyncSync,closeSync} from 'node:fs';\nlet input='';for await(const part of process.stdin){input+=part;if(input.length>16000000)throw new Error('隔离 hook 输入过大');}\nconst payload=JSON.parse(input),eventType=process.argv[2],fd=openSync(${JSON.stringify(journalPath)},'a',0o600);try{appendFileSync(fd,JSON.stringify({observedAt:new Date().toISOString(),eventType,payload})+'\\n');fsyncSync(fd);}finally{closeSync(fd);}\nprocess.stdout.write(JSON.stringify(eventType.startsWith('before')&&eventType!=='beforeSubmitPrompt'?{permission:'deny',user_message:'合成缓存实验不执行工具'}:{}));\n`,
		{ mode: 0o600 },
	);
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const hooks = Object.fromEntries(
		[
			"sessionStart",
			"sessionEnd",
			"beforeSubmitPrompt",
			"afterAgentResponse",
			"stop",
			"preCompact",
			"beforeShellExecution",
			"beforeMCPExecution",
			"beforeReadFile",
		].map((event) => [event, [{ command: `${quote(process.execPath)} ${quote(hookPath)} ${quote(event)}` }]]),
	);
	writeFileSync(join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks }), { mode: 0o600 });
}

function chatsRoot(state) {
	const bucket = createHash("md5").update(realpathSync(state.cwd)).digest("hex");
	return join(state.home, ".cursor", "chats", bucket);
}

function snapshotPrivateStore(state, root, sessionDirectoryName, label) {
	const source = join(chatsRoot(state), sessionDirectoryName, "store.db");
	const boundary = relative(realpathSync(chatsRoot(state)), realpathSync(source));
	if (boundary.startsWith("..") || isAbsolute(boundary)) throw new Error("拒绝读取私有测试目录之外的 Cursor 数据库");
	const destinationDirectory = join(root, "native-store-snapshots", label);
	privateDirectory(destinationDirectory);
	const files = [source, `${source}-wal`, `${source}-shm`].filter(existsSync);
	const before = files.map((file) => hash(readFileSync(file)));
	for (const file of files) copyFileSync(file, join(destinationDirectory, file.slice(file.lastIndexOf("/") + 1)));
	if (files.some((file, index) => hash(readFileSync(file)) !== before[index]))
		throw new Error("原生数据库在快照期间仍变化，保留待补证状态");
	const snapshotPath = join(destinationDirectory, "store.db"),
		database = new Database(snapshotPath, { readonly: true, fileMustExist: true });
	try {
		const metadata = decodeCursorNativeSqliteMetadata(
			database.prepare("SELECT value FROM meta WHERE key = '0'").get()?.value,
		);
		const blobs = database
			.prepare("SELECT id, data FROM blobs ORDER BY id")
			.all()
			.map((row) => ({ id: row.id, sha256: hash(row.data), bytes: row.data.length }));
		if (typeof metadata.agentId !== "string" || !metadata.agentId)
			throw new Error("原生 store 缺少 agentId，未从路径推断身份");
		return {
			sessionId: metadata.agentId,
			latestRootBlobId: metadata.latestRootBlobId,
			model: metadata.lastUsedModel ?? state.model,
			storedModel: metadata.lastUsedModel ?? null,
			modelEvidence: metadata.lastUsedModel
				? "native_store_lastUsedModel"
				: "explicit_model_argument_and_native_initialization",
			mode: metadata.mode,
			blobs,
			snapshotPath,
			historySha256: hash(JSON.stringify({ root: metadata.latestRootBlobId, blobs })),
		};
	} finally {
		database.close();
	}
}

function refreshOperation(state, operation) {
	const stdout = readText(join(operation.directory, "stdout.jsonl"));
	const measurement = analyzeCursorNativeTurn(stdout, operation.sessionId, operation.marker);
	if (measurement.request)
		measurement.request.configurationFingerprint = hash(
			JSON.stringify({
				version: state.version,
				model: state.model,
				display: measurement.nativeModelDisplay,
				cwd: state.cwd,
				bundle: state.nativeSource.bundleSha256,
				hooks: state.hooksConfigurationSha256 ?? hash(readFileSync(join(state.home, ".cursor", "hooks.json"))),
			}),
		);
	const nativeHooks = readText(join(dirname(dirname(state.home)), "native-cursor-hooks.jsonl"));
	for (const line of nativeHooks.split("\n").filter(Boolean)) {
		try {
			const event = JSON.parse(line);
			if (
				event.eventType === "preCompact" &&
				event.payload.conversation_id === operation.sessionId &&
				Date.parse(event.observedAt) >= Date.parse(operation.startedAt) &&
				Date.parse(event.observedAt) <= Date.parse(operation.finishedAt ?? new Date().toISOString()) + 1000
			)
				measurement.problems.push("本次原生回合发生压缩");
		} catch {
			measurement.problems.push("原生 hook 记录破损，不能排除压缩");
		}
	}
	operation.measurement = measurement;
	if (!measurement.problems.length) operation.status = "completed";
	else if (operation.status !== "prepared")
		operation.status = /quota|usage.limit|rate.limit|resource.exhausted|额度|用量.*耗尽/i.test(
			stdout + readText(join(operation.directory, "stderr.log")),
		)
			? "quota_exhausted"
			: "awaiting_native_evidence";
	return operation;
}

async function measuredTurn(root, state, context, key, sessionId, prompt, save) {
	let operation = context.operations.find((item) => item.key === key);
	if (operation) {
		refreshOperation(state, operation);
		save();
		if (operation.status !== "prepared") return operation;
	} else {
		const directory = join(root, "request-artifacts", `cursor-${context.targetTokens}-${key}`);
		privateDirectory(directory);
		operation = { key, sessionId, prompt, marker: prompt.split("\n")[0], directory, status: "prepared" };
		writeFileSync(join(directory, "prompt.txt"), prompt, { mode: 0o600 });
		context.operations.push(operation);
		save();
	}
	operation.status = "submitting";
	operation.startedAt = new Date().toISOString();
	save();
	console.log(`开始 Cursor ${state.model} ${context.targetTokens} ${key}`);
	const stdout = openSync(join(operation.directory, "stdout.jsonl"), "w", 0o600),
		stderr = openSync(join(operation.directory, "stderr.log"), "w", 0o600);
	try {
		await new Promise((resolveRun, reject) => {
			const child = spawn(
				state.binary,
				[
					"--print",
					"--output-format",
					"stream-json",
					"--model",
					state.model,
					"--trust",
					"--resume",
					operation.sessionId,
				],
				{ cwd: state.cwd, env: isolatedEnvironment(state), detached: true, stdio: ["pipe", stdout, stderr] },
			);
			operation.pid = child.pid;
			save();
			child.stdin.on("error", () => {});
			child.stdin.end(operation.prompt);
			child.once("close", (code, signal) => {
				operation.exitCode = code;
				operation.signal = signal;
			});
			armDetachedProcessGroupTimeout(child, {
				timeoutMs: 300_000,
				termGraceMs: 2_000,
				killGraceMs: 1_000,
				onTimeout() {
					operation.problem = "模型回合超时，提交状态未知，不自动重发";
					save();
				},
			}).then(resolveRun, reject);
		});
	} catch (error) {
		operation.problem = error.message;
	} finally {
		closeSync(stdout);
		closeSync(stderr);
	}
	operation.finishedAt = new Date().toISOString();
	refreshOperation(state, operation);
	save();
	console.log(`结束 ${key}：${operation.status} ${JSON.stringify(operation.measurement.request ?? {})}`);
	return operation;
}

const simplePrompt = () => `CACHE_MEASUREMENT_REQUEST=${randomUUID()}\n不要调用任何工具，不要读取或修改文件，只答 OK。`;
const validOperation = (operation) =>
	operation?.status === "completed" && operation.measurement?.request && !operation.measurement.problems.length;

export function cursorContextHasCompleteSecondControl(context) {
	return validOperation(context?.operations?.find((item) => item.key === "fork-second-control"));
}

export function cursorContextShouldSkipOnResume(context) {
	return (
		context?.status === "completed" &&
		cursorContextHasCompleteSecondControl(context) &&
		validOperation(context.operations.find((item) => item.key === "parent-hot-after"))
	);
}

export function armDetachedProcessGroupTimeout(child, { timeoutMs, termGraceMs, killGraceMs, onTimeout, onSignal }) {
	return new Promise((resolveRun, reject) => {
		let settled = false;
		let killTimer;
		let giveUpTimer;
		const signalGroup = (signal) => {
			onSignal?.(signal);
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch {
				// 进程组已经退出时，后续的强制信号不需要另作失败。
			}
		};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(termTimer);
			clearTimeout(killTimer);
			clearTimeout(giveUpTimer);
			if (error) reject(error);
			else resolveRun();
		};
		const termTimer = setTimeout(() => {
			onTimeout?.();
			signalGroup("SIGTERM");
			killTimer = setTimeout(() => signalGroup("SIGKILL"), termGraceMs);
			giveUpTimer = setTimeout(() => finish(), termGraceMs + killGraceMs);
		}, timeoutMs);
		child.once("close", () => finish());
		child.once("error", (error) => finish(error));
	});
}

async function createNativeForkViaPty(state, fork, save) {
	const descriptor = openSync(fork.ptyLogPath, "a", 0o600);
	let output = "",
		exited = false,
		lastOutputAt = Date.now();
	const terminal = pty.spawn(state.binary, ["--model", state.model, "--trust", "--resume", fork.parentSessionId], {
		cwd: state.cwd,
		env: isolatedEnvironment(state, true),
		name: "xterm-256color",
		cols: 160,
		rows: 50,
	});
	fork.pid = terminal.pid;
	save();
	const outputSubscription = terminal.onData((chunk) => {
		appendFileSync(descriptor, chunk);
		output += stripVTControlCharacters(chunk);
		lastOutputAt = Date.now();
	});
	terminal.onExit(({ exitCode }) => {
		exited = true;
		fork.creationExitCode = exitCode;
	});
	const wait = async (predicate, limit) => {
		const deadline = Date.now() + limit;
		while (Date.now() < deadline) {
			if (predicate()) return;
			if (exited) throw new Error("原生 fork 进程提前退出");
			await delay(100);
		}
		throw new Error("原生 fork 控制超时，禁止重发状态未知的创建请求");
	};
	try {
		await wait(
			() =>
				/Grok|\/ commands|Add a follow-up|Ask anything|Type a message/.test(output) &&
				Date.now() - lastOutputAt >= 700,
			45_000,
		);
		// React 输入状态须先完成渲染，再单独投递 Enter；同批写入会停在 slash 候选菜单。
		terminal.write("/fork");
		await delay(500);
		fork.commandSubmittedAt = new Date().toISOString();
		save();
		terminal.write("\r");
		await wait(() => output.includes("This conversation has been forked"), 45_000);
		if (!output.includes(fork.parentSessionId)) throw new Error("原生 fork 回执没有明确父会话 ID");
		fork.nativeForkReceiptVerified = true;
		save();
		fsyncSync(descriptor);
		terminal.write("/quit");
		await delay(500);
		terminal.write("\r");
		await wait(() => exited, 10_000);
	} finally {
		if (!exited) {
			try {
				terminal.kill("SIGTERM");
			} catch {}
			for (let index = 0; index < 20 && !exited; index++) await delay(100);
		}
		if (!exited) {
			try {
				terminal.kill("SIGKILL");
			} catch {}
			for (let index = 0; index < 10 && !exited; index++) await delay(100);
		}
		outputSubscription.dispose();
		fsyncSync(descriptor);
		closeSync(descriptor);
	}
}

function recoverCreatedFork(root, state, context, fork) {
	const transcript = stripVTControlCharacters(readText(fork.ptyLogPath));
	fork.nativeForkReceiptVerified =
		transcript.includes("This conversation has been forked") && transcript.includes(fork.parentSessionId);
	if (!fork.nativeForkReceiptVerified) throw new Error("尚无明确原生 fork 成功回执；不重发创建请求");
	const candidates = readdirSync(chatsRoot(state)).filter((name) => !fork.chatDirectoriesBefore.includes(name));
	const matching = [];
	for (const name of candidates) {
		const snapshot = snapshotPrivateStore(
			state,
			root,
			name,
			`${context.targetTokens}-fork-${fork.index}-candidate-${name}`,
		);
		if (verifyCursorNativeForkStorageInheritance(context.frozenParentStore, snapshot)) matching.push(snapshot);
	}
	if (matching.length !== 1) throw new Error("原生成功回执未能关联唯一且完整继承历史的子 store");
	fork.sessionId = matching[0].sessionId;
	fork.storeBeforeFirstTurn = matching[0];
	fork.historyVerified = true;
	const parentAfter = snapshotPrivateStore(
		state,
		root,
		fork.parentSessionId,
		`${context.targetTokens}-parent-after-fork-${fork.index}`,
	);
	fork.parentHistoryUnchanged = parentAfter.historySha256 === context.frozenParentStore.historySha256;
	if (!fork.parentHistoryUnchanged) throw new Error("父历史内容或根指针变化，不能作冻结父状态的 fork 对照");
	fork.status = "created";
}

function report(root, state) {
	const rows = [];
	for (const context of state.contexts) {
		const get = (key) => context.operations.find((operation) => operation.key === key);
		for (let index = 1; index <= state.forkCount; index++) {
			const operation = get(`fork-${index}-first`),
				fork = context.forks.find((item) => item.index === index);
			const problems = [
				operation,
				get("cold-prefix-baseline"),
				get("parent-create"),
				get("parent-hot-before"),
				get("parent-hot-after"),
			].flatMap((item) => (validOperation(item) ? [] : [`${item?.key ?? "未执行步骤"} 缺少有效计量`]));
			if (!fork?.historyVerified || !fork.parentHistoryUnchanged || !fork.nativeForkReceiptVerified)
				problems.push("缺少原生 fork、完整继承及父历史不变的证据");
			if (
				operation?.measurement?.request?.inputTokens <
				(get("parent-hot-before")?.measurement?.request?.inputTokens ?? 0) - 1024
			)
				problems.push("分身输入规模没有保留父历史");
			let assessment = {
				status:
					operation?.status === "quota_exhausted"
						? "quota_exhausted"
						: operation
							? "insufficient_evidence"
							: "not_executed",
				historyReuseRatio: null,
				problems,
			};
			if (!problems.length) {
				const baseline = {
					...get("cold-prefix-baseline").measurement.request,
					cachedInputTokens: Math.max(
						get("cold-prefix-baseline").measurement.request.cachedInputTokens,
						get("parent-create").measurement.request.cachedInputTokens,
					),
				};
				assessment = assessHistoryReuse({
					baseline,
					hotBefore: get("parent-hot-before").measurement.request,
					hotAfter: get("parent-hot-after").measurement.request,
					fork: operation.measurement.request,
				});
			}
			rows.push({
				targetTokens: context.targetTokens,
				index,
				sessionId: fork?.sessionId,
				request: operation?.measurement?.request,
				nativeRequestId: operation?.measurement?.nativeRequestId,
				...assessment,
			});
		}
	}
	writeManifest(join(root, "cursor-measurements.json"), {
		analyzedAt: new Date().toISOString(),
		model: state.model,
		version: state.version,
		rows,
	});
	const percent = (value) => (value == null ? "未知" : `${(value * 100).toFixed(2)}%`);
	const lines = [
		"# Cursor Grok 原生分身缓存复测",
		"",
		`CLI ${state.version}；模型 ${state.model}；输入总量 = 未缓存 inputTokens + cacheReadTokens + cacheWriteTokens。`,
		"",
		"| 目标规模 | fork | 实际总输入 | cached | 总命中率 | 保守历史复用 | 判定 |",
		"| --- | --- | ---: | ---: | ---: | ---: | --- |",
	];
	for (const row of rows)
		lines.push(
			`| ${row.targetTokens} | ${row.index} | ${row.request?.inputTokens ?? "—"} | ${row.request?.cachedInputTokens ?? "—"} | ${row.request ? percent(row.request.cachedInputTokens / row.request.inputTokens) : "未知"} | ${percent(row.historyReuseRatio)} | ${row.status} |`,
		);
	for (const context of state.contexts) {
		lines.push("", `## ${context.targetTokens} 的对照`, "");
		for (const operation of context.operations.filter((item) => !item.key.endsWith("-first")))
			lines.push(`- ${operation.key}：${operation.status}；${JSON.stringify(operation.measurement?.request ?? {})}`);
		if (context.problem)
			lines.push(`- ${context.status === "completed" ? "已恢复的历史原因" : "未完成原因"}：${context.problem}`);
	}
	for (const row of rows.filter((item) => item.problems.length))
		lines.push(`- ${row.targetTokens}/${row.index}：${row.problems.join("；")}`);
	lines.push(
		"",
		"只读取脚本私有 store 的快照；子身份读取原生 meta.agentId，不从目录名推断。原生 /fork 回执、全部历史 blob 校验和及根指针必须匹配。生产 Kanban 的 Cursor fork 适配未修改。结果仅适用于所测模型、合成上下文与 CLI 配置。",
		"",
	);
	writeFileSync(join(root, "cursor-report.zh-CN.md"), lines.join("\n"), { mode: 0o600 });
	return rows;
}

async function main() {
	let root = join(
			homedir(),
			".cline",
			"kanban",
			"native-agent-fork-prompt-cache-measurements",
			`cursor-grok-${new Date().toISOString().replaceAll(":", "-")}`,
		),
		analyzeOnly = false,
		modelOverride;
	for (let index = 2; index < process.argv.length; index++) {
		if (process.argv[index] === "--analyze-only") analyzeOnly = true;
		else if (process.argv[index] === "--model" && process.argv[index + 1]) modelOverride = process.argv[++index];
		else if (process.argv[index] === "--evidence-directory" && process.argv[index + 1])
			root = resolve(process.argv[++index]);
		else throw new Error("参数仅支持 --evidence-directory <持久目录>、--model <原生 Grok high ID> 与 --analyze-only");
	}
	if (/^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/.test(root)) throw new Error("证据必须写入持久目录");
	privateDirectory(root);
	const release = await lockfile.lock(root, { realpath: true, stale: 120_000, update: 10_000, retries: 0 });
	try {
		const manifestPath = join(root, "cursor-run-manifest.json");
		let state = existsSync(manifestPath) ? readJson(manifestPath) : null;
		const home = join(root, "private-runtime", "home"),
			cwd = join(root, "private-runtime", "working-directory");
		const save = () => writeManifest(manifestPath, state);
		if (analyzeOnly) {
			if (!state) throw new Error("证据目录没有既有清单");
			for (const context of state.contexts)
				for (const operation of context.operations) refreshOperation(state, operation);
			save();
			report(root, state);
			console.log("Cursor 离线重算完成，没有调用模型");
			return;
		}
		if (process.platform !== "darwin") throw new Error("本入口的凭据隔离当前只验证了 macOS；未调用模型");
		try {
			const sqlitePreflight = new Database(":memory:");
			sqlitePreflight.close();
		} catch {
			throw new Error(
				`Node ${process.version} 与现有 SQLite 原生绑定不兼容；请使用安装依赖时的 Node，尚未启动模型请求`,
			);
		}
		for (const directory of [home, cwd, join(home, ".cursor"), join(home, "process-temporary-files")])
			privateDirectory(directory);
		if (!state) {
			preparePrivateCredentials(home);
			preparePrivateHooks(root, home);
			const binary = realpathSync(join(homedir(), ".local", "bin", "cursor-agent"));
			const initial = { home, cwd };
			const catalog = spawnSync(binary, ["--list-models"], {
				cwd,
				env: isolatedEnvironment(initial),
				encoding: "utf8",
				timeout: 60_000,
			});
			if (catalog.status !== 0) throw new Error("原生模型目录探测失败，未调用模型");
			writeFileSync(join(root, "cursor-model-catalog.stdout.log"), catalog.stdout, { mode: 0o600 });
			if (
				modelOverride &&
				(!/(?:^|[-/])grok-\d+(?:\.\d+)+-high$/.test(modelOverride) ||
					!stripVTControlCharacters(catalog.stdout)
						.split("\n")
						.some((line) => line.trim().split(/\s/)[0] === modelOverride))
			)
				throw new Error("指定型号不在原生 Grok high 目录，未提交模型请求");
			const version = spawnSync(binary, ["--version"], {
				cwd,
				env: isolatedEnvironment(initial),
				encoding: "utf8",
				timeout: 20_000,
			}).stdout.trim();
			state = {
				schemaVersion: 1,
				createdAt: new Date().toISOString(),
				binary,
				version,
				model: modelOverride ?? selectCurrentCursorGrokHighModelFromNativeCatalog(catalog.stdout),
				reasoning: "high",
				home,
				cwd,
				targets: [32_000, 128_000],
				forkCount: 3,
				contexts: [],
				nativeSource: { bundleSha256: hash(readFileSync(join(dirname(binary), "8008.index.js"))) },
			};
			save();
		}
		assert.equal(state.home, home);
		assert.equal(state.cwd, cwd);
		if (modelOverride) assert.equal(state.model, modelOverride, "恢复时不允许替换所测型号");
		assert.equal(
			hash(readFileSync(join(dirname(state.binary), "8008.index.js"))),
			state.nativeSource.bundleSha256,
			"原生 CLI 变更，必须使用新证据目录",
		);
		state.hooksConfigurationSha256 ??= hash(readFileSync(join(home, ".cursor", "hooks.json")));
		assert.equal(
			hash(readFileSync(join(home, ".cursor", "hooks.json"))),
			state.hooksConfigurationSha256,
			"私有 hook 配置变化，必须使用新证据目录",
		);
		for (const context of state.contexts)
			for (const operation of context.operations) refreshOperation(state, operation);
		save();
		for (const targetTokens of state.targets) {
			let context = state.contexts.find((item) => item.targetTokens === targetTokens);
			if (cursorContextShouldSkipOnResume(context)) continue;
			if (!context) {
				context = { targetTokens, status: "running", operations: [], forks: [] };
				state.contexts.push(context);
				save();
			}
			try {
				const baseline = await measuredTurn(
					root,
					state,
					context,
					"cold-prefix-baseline",
					context.operations.find((item) => item.key === "cold-prefix-baseline")?.sessionId ?? randomUUID(),
					simplePrompt(),
					save,
				);
				if (!validOperation(baseline)) throw new Error("空历史基线未完成，提交未知的请求不重发");
				context.parentSessionId ??= randomUUID();
				save();
				const parentPrompt =
					context.operations.find((item) => item.key === "parent-create")?.prompt ??
					createSyntheticForkCacheMeasurementPrompt(
						`CACHE_MEASUREMENT_REQUEST=${randomUUID()}`,
						Math.max(1000, targetTokens - baseline.measurement.request.inputTokens),
					);
				const created = await measuredTurn(
					root,
					state,
					context,
					"parent-create",
					context.parentSessionId,
					parentPrompt,
					save,
				);
				if (!validOperation(created)) throw new Error("父首次请求未取得有效计量");
				const hot = await measuredTurn(
					root,
					state,
					context,
					"parent-hot-before",
					context.parentSessionId,
					simplePrompt(),
					save,
				);
				if (!validOperation(hot)) throw new Error("父热对照未取得有效计量");
				context.frozenParentStore ??= snapshotPrivateStore(
					state,
					root,
					context.parentSessionId,
					`${targetTokens}-parent-frozen`,
				);
				save();
				for (let index = 1; index <= state.forkCount; index++) {
					let fork = context.forks.find((item) => item.index === index);
					if (!fork) {
						fork = {
							index,
							parentSessionId: context.parentSessionId,
							status: "prepared",
							chatDirectoriesBefore: readdirSync(chatsRoot(state)),
							ptyLogPath: join(root, `native-fork-${targetTokens}-${index}.pty.log`),
						};
						context.forks.push(fork);
						save();
					}
					try {
						if (!fork.sessionId) {
							const currentParent = snapshotPrivateStore(
								state,
								root,
								context.parentSessionId,
								`${targetTokens}-parent-before-fork-${index}`,
							);
							if (currentParent.historySha256 !== context.frozenParentStore.historySha256)
								throw new Error("父状态已偏离冻结点，未创建新分身");
							if (fork.status === "prepared") {
								fork.status = "creating";
								save();
								await createNativeForkViaPty(state, fork, save);
							}
							recoverCreatedFork(root, state, context, fork);
							save();
						}
						const measured = await measuredTurn(
							root,
							state,
							context,
							`fork-${index}-first`,
							fork.sessionId,
							simplePrompt(),
							save,
						);
						fork.status = measured.status;
						save();
					} catch (error) {
						fork.problem = error.message;
						fork.status = "awaiting_native_evidence";
						save();
						console.log(`fork-${index} 待补证：${error.message}`);
					}
				}
				if (
					context.forks.some(
						(fork) => !validOperation(context.operations.find((item) => item.key === `fork-${fork.index}-first`)),
					)
				)
					throw new Error("部分分身仍待原生证据，保留父冻结状态，继续其他独立规模");
				const secondSource = context.forks.find((fork) =>
					validOperation(context.operations.find((item) => item.key === `fork-${fork.index}-first`)),
				);
				const second = secondSource
					? await measuredTurn(
							root,
							state,
							context,
							"fork-second-control",
							secondSource.sessionId,
							simplePrompt(),
							save,
						)
					: undefined;
				const after = await measuredTurn(
					root,
					state,
					context,
					"parent-hot-after",
					context.parentSessionId,
					simplePrompt(),
					save,
				);
				if (!validOperation(second) || !validOperation(after))
					throw new Error("分身第二轮或父后热对照缺少有效计量，保留已完成的首轮数据");
				context.status = "completed";
				save();
			} catch (error) {
				context.status = "awaiting_native_evidence";
				context.problem = error.message;
				save();
				console.log(`${targetTokens} 待补证：${error.message}`);
			}
			report(root, state);
		}
		const rows = report(root, state);
		if (
			rows.length !== state.targets.length * state.forkCount ||
			rows.some((row) => row.status !== "measured") ||
			state.targets.some(
				(targetTokens) =>
					!cursorContextHasCompleteSecondControl(state.contexts.find((item) => item.targetTokens === targetTokens)),
			)
		)
			process.exitCode = 2;
		console.log(`Cursor 报告：${join(root, "cursor-report.zh-CN.md")}`);
	} finally {
		await release();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
	main().catch((error) => {
		console.error(`Cursor 分身缓存测量未完成：${error.message}`);
		process.exitCode = 1;
	});
