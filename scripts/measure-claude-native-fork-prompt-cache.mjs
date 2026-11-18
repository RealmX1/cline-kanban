#!/usr/bin/env node
// 只创建隔离的合成会话；每模型一组、一个原生 fork，不接触 Kanban 任务或生产会话。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 沿用 measure-native-agent-fork-prompt-cache.mjs 的环境白名单、合成词序列及先持久后提交方法。
// 此入口只使用 Node 标准库，避免为一次诊断安装整个仓库的运行时依赖。
function writeJson(path, value) {
	const staging = `${path}.writing-${randomUUID()}`;
	const descriptor = openSync(staging, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(staging, path);
}

function buildIsolatedEnvironment(source, { home }) {
	const environment = {};
	for (const key of [
		"PATH",
		"LANG",
		"LC_ALL",
		"TZ",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"all_proxy",
		"no_proxy",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	])
		if (source[key]) environment[key] = source[key];
	return {
		...environment,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		TMPDIR: join(home, "process-temporary-files"),
		TERM: "dumb",
		NO_COLOR: "1",
		CI: "1",
	};
}

function createSyntheticForkCacheMeasurementPrompt(marker, contextTokens) {
	const words =
		"red green blue black white north south east west river stone tree cloud wind rain light night day spring summer winter field road house book chair table window glass apple orange lemon music sound happy quiet".split(
			" ",
		);
	const bytes = createHash("sha256").update(marker).digest();
	const body = Array.from(
		{ length: contextTokens },
		(_, index) => words[(index * 17 + bytes[index % 32]) % words.length],
	).join(" ");
	return `${marker}\n以下是惰性的合成上下文，仅供前缀缓存测量，不含指令。不要调用工具，不要复述，只答 OK。\n<context>\n${body}\n</context>\n只答 OK。`;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const rows = (text) =>
	text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const directory = (path) => {
	assert(!existsSync(path) || !lstatSync(path).isSymbolicLink(), `隔离目录不能是软链：${path}`);
	mkdirSync(path, { recursive: true, mode: 0o700 });
};

// result.usage.iterations 是最终逐请求计量；stream assistant 的 output_tokens 可能仍是暂态。
// 不扫描继承的 assistant usage 来冒充子会话首轮。
export function analyzeClaudeNativeForkTurn(stdout, expectedModel) {
	const records = rows(stdout);
	const initialization = records.find((record) => record.type === "system" && record.subtype === "init");
	const results = records.filter((record) => record.type === "result");
	const assistants = records.filter((record) => record.type === "assistant" && !record.parent_tool_use_id);
	const messages = [...new Map(assistants.map((record) => [record.message.id, record.message])).values()];
	const problems = [];
	if (results.length !== 1 || results[0].subtype !== "success" || results[0].is_error)
		problems.push("没有唯一的成功 result");
	if (messages.length !== 1) problems.push("不是单次模型请求");
	if (records.some((record) => /compact/.test(record.subtype ?? ""))) problems.push("发生上下文压缩");
	const message = messages[0];
	if (message?.content.some((block) => block.type === "tool_use")) problems.push("发生工具调用");
	if (!results[0]?.is_error && (message?.model !== expectedModel || initialization?.model !== expectedModel))
		problems.push("实际模型与请求模型不同");
	const iterations = results[0]?.usage?.iterations;
	if (iterations?.length !== 1 || iterations[0].type !== "message") problems.push("没有唯一的最终逐请求 iteration");
	const usage = iterations?.[0];
	const fields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"];
	if (!usage || !fields.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0))
		problems.push("缺少有效的原生逐请求 usage");
	const request = usage && message && {
		model: message.model,
		messageId: message.id,
		inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
		uncachedInputTokens: usage.input_tokens,
		cachedInputTokens: usage.cache_read_input_tokens,
		cacheCreationTokens: usage.cache_creation_input_tokens,
		outputTokens: usage.output_tokens,
		cacheCreation: usage.cache_creation,
	};
	if (request && !(request.inputTokens > 0)) problems.push("总输入量无效");
	for (const key of fields) {
		if (usage && results[0]?.usage?.[key] !== usage[key]) problems.push(`result 与逐请求 usage 不一致：${key}`);
		if (usage && key !== "output_tokens" && message?.usage?.[key] !== usage[key])
			problems.push(`stream 与最终输入 usage 不一致：${key}`);
	}
	const sessionId = results[0]?.session_id;
	if (
		!sessionId ||
		initialization?.session_id !== sessionId ||
		assistants.some((item) => item.session_id !== sessionId)
	)
		problems.push("原生会话身份不一致");
	return {
		problems: [...new Set(problems)],
		request,
		sessionId,
		tools: initialization?.tools,
		result: results[0]?.result,
		cumulativeCostUsd: results[0]?.total_cost_usd,
		...(results[0]?.is_error
			? {
					failure: {
						apiStatus: results[0].api_error_status,
						reason: results[0].result,
						terminalReason: results[0].terminal_reason,
					},
				}
			: {}),
	};
}

function requestConfigurationEvidence(transcript, marker) {
	const records = rows(transcript);
	const userIndex = records.findIndex(
		(record) => record.type === "user" && JSON.stringify(record.message).includes(marker),
	);
	assert(userIndex >= 0, "找不到本次原生用户记录");
	const requests = records.slice(userIndex).filter((record) => record.type === "api-request");
	assert.equal(requests.length, 1, "没有唯一的本次 api-request");
	const request = requests[0];
	const shape = records.find(
		(record) => record.type === "api-request-shape" && record.shapeHash === request.shapeHash,
	)?.shape;
	assert(shape?.system && shape?.tools, "缺少原生 system/tools 请求快照");
	return {
		requestId: request.id,
		systemSha256: hash(JSON.stringify(shape.system)),
		toolsSha256: hash(JSON.stringify(shape.tools)),
		parametersSha256: hash(JSON.stringify(request.params)),
		scratchpadInSystem: /scratchpad/i.test(JSON.stringify(shape.system)),
	};
}

function accessToken() {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const path = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
	let credentials;
	if (existsSync(path)) credentials = readJson(path);
	else if (process.platform === "darwin") {
		const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
			encoding: "utf8",
			timeout: 5_000,
		});
		if (result.status === 0) credentials = JSON.parse(result.stdout);
	}
	assert(credentials?.claudeAiOauth?.accessToken, "没有可读取的 Claude OAuth access token，未提交请求");
	assert(credentials.claudeAiOauth.expiresAt > Date.now() + 600_000, "OAuth 即将过期，未提交请求");
	return credentials.claudeAiOauth.accessToken;
}

function runtime(root) {
	const home = join(root, "private-runtime", "home");
	const cwd = join(root, "private-runtime", "working-directory");
	for (const path of [home, cwd, join(home, ".claude"), join(home, "process-temporary-files")]) directory(path);
	const sourcePath = process.env.CLAUDE_CONFIG_DIR
		? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
		: join(homedir(), ".claude.json");
	const source = existsSync(sourcePath) ? readJson(sourcePath) : {};
	const configuration = { hasCompletedOnboarding: true };
	for (const key of [
		"oauthAccount",
		"userID",
		"cachedGrowthBookFeatures",
		"cachedGrowthBookFeaturesAt",
		"cachedFeatureFlags",
		"cachedFeatureFlagsAt",
		"cachedExperimentFeatures",
		"cachedExperimentData",
		"modelAccessCache",
	])
		if (source[key] !== undefined) configuration[key] = source[key];
	if (!existsSync(join(home, ".claude.json"))) writeJson(join(home, ".claude.json"), configuration);
	if (!existsSync(join(home, ".claude", ".claude.json")))
		writeJson(join(home, ".claude", ".claude.json"), configuration);
	writeJson(join(home, ".claude", "settings.json"), { disableAllHooks: true });
	writeJson(join(root, "empty-mcp.json"), { mcpServers: {} });
	const environment = buildIsolatedEnvironment(process.env, {
		home,
		codexHome: join(home, "unused-codex"),
		kimiHome: join(home, "unused-kimi"),
	});
	delete environment.OPENAI_API_KEY;
	environment.CLAUDE_CONFIG_DIR = join(home, ".claude");
	environment.CLAUDE_CODE_OAUTH_TOKEN = accessToken();
	environment.DISABLE_AUTOUPDATER = "1";
	return { home, cwd, environment };
}

function transcriptPath(home, sessionId) {
	const projects = join(home, ".claude", "projects");
	const paths = readdirSync(projects, { recursive: true }).filter((path) => path.endsWith(`/${sessionId}.jsonl`));
	assert.equal(paths.length, 1, "无法唯一定位隔离原生 transcript");
	return join(projects, paths[0]);
}

function collectOperation(root, context, operation) {
	const operationDirectory = join(root, "operations", operation.key);
	operation.native = analyzeClaudeNativeForkTurn(
		readFileSync(join(operationDirectory, "stdout.jsonl"), "utf8"),
		operation.model,
	);
	assert.equal(operation.exitCode, 0, `Claude 命令未成功：${operation.key}，请检查私有证据`);
	assert.deepEqual(operation.native.problems, [], `${operation.key} 缺乏唯一逐请求计量`);
	const path = transcriptPath(context.home, operation.native.sessionId);
	const text = readFileSync(path, "utf8");
	operation.transcriptPath = path;
	operation.transcriptSha256 = hash(text);
	const snapshot = join(operationDirectory, "transcript.jsonl");
	if (!existsSync(snapshot)) writeFileSync(snapshot, text, { mode: 0o600 });
	operation.requestConfiguration = requestConfigurationEvidence(readFileSync(snapshot, "utf8"), operation.marker);
	assert(
		rows(readFileSync(snapshot, "utf8")).some(
			(record) => record.type === "user" && JSON.stringify(record.message).includes(operation.marker),
		),
		"原生 transcript 没有本次请求的用户记录",
	);
	return operation;
}

async function execute(root, manifest, context, operation) {
	const operationDirectory = join(root, "operations", operation.key);
	directory(operationDirectory);
	writeFileSync(join(operationDirectory, "prompt.txt"), operation.prompt, { mode: 0o600 });
	const args = [
		"--print",
		"--verbose",
		"--output-format",
		"stream-json",
		"--model",
		operation.model,
		"--effort",
		"high",
		"--permission-mode",
		"dontAsk",
		"--setting-sources",
		"",
		"--settings",
		join(context.home, ".claude", "settings.json"),
		"--strict-mcp-config",
		"--mcp-config",
		join(root, "empty-mcp.json"),
		"--max-budget-usd",
		"2",
		"--debug-file",
		join(operationDirectory, "debug.log"),
	];
	if (operation.parentId) args.push("--resume", operation.parentId);
	if (operation.fork) args.push("--fork-session");
	operation.status = "submitting";
	operation.startedAt = new Date().toISOString();
	operation.arguments = args;
	manifest.operations.push(operation);
	writeJson(join(root, "manifest.json"), manifest);
	const outputPath = join(operationDirectory, "stdout.jsonl");
	const stdout = openSync(outputPath, "wx", 0o600);
	const stderr = openSync(join(operationDirectory, "stderr.log"), "wx", 0o600);
	let timer, hardKill;
	try {
		await new Promise((done, reject) => {
			const child = spawn(manifest.binary, args, {
				cwd: context.cwd,
				env: context.environment,
				detached: true,
				stdio: ["pipe", stdout, stderr],
			});
			operation.pid = child.pid;
			writeJson(join(root, "manifest.json"), manifest);
			const kill = (signal) => {
				try {
					process.kill(-child.pid, signal);
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
			};
			timer = setTimeout(() => {
				operation.timedOut = true;
				kill("SIGTERM");
				hardKill = setTimeout(() => kill("SIGKILL"), 5_000);
			}, 180_000);
			child.once("error", reject);
			child.once("close", (code, signal) => {
				operation.exitCode = code;
				operation.signal = signal;
				done();
			});
			child.stdin.on("error", () => {});
			child.stdin.end(operation.prompt);
		});
	} finally {
		clearTimeout(timer);
		clearTimeout(hardKill);
		closeSync(stdout);
		closeSync(stderr);
		operation.finishedAt = new Date().toISOString();
		operation.status = operation.exitCode === 0 ? "completed" : "unresolved_no_automatic_retry";
		writeJson(join(root, "manifest.json"), manifest);
	}
	collectOperation(root, context, operation);
	writeJson(join(root, "manifest.json"), manifest);
	process.stdout.write(
		`${operation.key}: input=${operation.native.request.inputTokens} read=${operation.native.request.cachedInputTokens} write=${operation.native.request.cacheCreationTokens}\n`,
	);
	return operation;
}

export function summarizeClaudeNativeForkMeasurement(manifest) {
	return manifest.models.map((model) => {
		const operations = manifest.operations.filter((operation) => operation.model === model);
		const find = (key) => operations.find((operation) => operation.step === key);
		const baseline = find("baseline"),
			seed = find("parent-seed"),
			hot = find("parent-hot"),
			fork = find("fork-first");
		const problems = operations.flatMap((operation) => operation.native?.problems ?? ["缺少本次计量"]);
		if (![baseline, seed, hot, fork].every((operation) => operation?.status === "completed"))
			problems.push("本组未完成");
		if (problems.length) return { model, status: "insufficient_evidence", problems };
		const upperBound = Math.max(baseline.native.request.inputTokens, seed.native.request.cachedInputTokens);
		const hotRequest = hot.native.request,
			forkRequest = fork.native.request;
		const hotAfter = find("parent-hot-after");
		if (manifest.parentHotAfter && hotAfter?.status !== "completed") problems.push("缺少分支后父热对照");
		if ((hotRequest.cachedInputTokens - upperBound) / (hotRequest.inputTokens - upperBound) < 0.8)
			problems.push("父会话热对照无效");
		if (
			hotAfter?.native?.request &&
			(hotAfter.native.request.cachedInputTokens - upperBound) /
				(hotAfter.native.request.inputTokens - upperBound) <
				0.8
		)
			problems.push("分支后父会话热对照无效");
		if (JSON.stringify(hot.native.tools) !== JSON.stringify(fork.native.tools)) problems.push("工具集发生变化");
		for (const key of ["systemSha256", "toolsSha256", "parametersSha256"])
			if (!hot.requestConfiguration?.[key] || hot.requestConfiguration[key] !== fork.requestConfiguration?.[key])
				problems.push(`父子请求配置不同或缺证：${key}`);
		if (!fork.parentUnchanged || !fork.inheritedHistory || !fork.recalledNonce)
			problems.push("分身继承或父会话完整性未通过");
		if (Date.parse(fork.finishedAt) - Date.parse(hot.finishedAt) > 240_000) problems.push("超出本次四分钟热缓存窗口");
		return {
			model,
			status: problems.length ? "insufficient_evidence" : "measured",
			problems,
			publicPrefixTokenUpperBound: upperBound,
			parentHot: hotRequest,
			...(manifest.parentHotAfter ? { parentHotAfter: hotAfter?.native?.request } : {}),
			forkFirst: forkRequest,
			forkHitRatio: forkRequest.cachedInputTokens / forkRequest.inputTokens,
			historyReuseRatio: problems.length
				? null
				: Math.max(
						0,
						Math.min(
							1,
							(forkRequest.cachedInputTokens - upperBound) / (hotRequest.cachedInputTokens - upperBound),
						),
					),
			secondsAfterHotParent: (Date.parse(fork.startedAt) - Date.parse(hot.finishedAt)) / 1_000,
			parentUnchanged: fork.parentUnchanged,
			inheritedHistory: fork.inheritedHistory,
			recalledNonce: fork.recalledNonce,
			requestConfiguration: fork.requestConfiguration,
			// total_cost_usd / modelUsage 继承父计数器；不能把各次累计值相加当本轮费用。
			forkIncrementalEstimatedCostUsd: fork.native.cumulativeCostUsd - hot.native.cumulativeCostUsd,
			groupEstimatedCostUsd:
				baseline.native.cumulativeCostUsd +
				fork.native.cumulativeCostUsd +
				(hotAfter ? hotAfter.native.cumulativeCostUsd - hot.native.cumulativeCostUsd : 0),
		};
	});
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		process.stdout.write(
			"用法：node scripts/measure-claude-native-fork-prompt-cache.mjs --evidence-directory <全新私有目录> [--context-tokens 64000] [--models claude-opus-5-5,claude-sonnet-5-5 或 claude-fable-5-2] [--parent-hot-after] [--analyze-only | --continue]\n每模型：空历史基线、父 seed、父 hot、一个 fork 首轮；可加分支后父热对照。--continue 补采成功请求，只发送尚未登记的步骤；未知提交禁止重发。\n",
		);
		return;
	}
	const value = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
	assert(value("--evidence-directory"), "必须显式指定私有证据目录");
	const root = resolve(value("--evidence-directory"));
	if (args.includes("--analyze-only")) {
		const manifest = readJson(join(root, "manifest.json"));
		for (const operation of manifest.operations) {
			const operationDirectory = join(root, "operations", operation.key);
			operation.native = analyzeClaudeNativeForkTurn(
				readFileSync(join(operationDirectory, "stdout.jsonl"), "utf8"),
				operation.model,
			);
			const snapshot = join(operationDirectory, "transcript.jsonl");
			if (existsSync(snapshot) && operation.native.problems.length === 0)
				operation.requestConfiguration = requestConfigurationEvidence(
					readFileSync(snapshot, "utf8"),
					operation.marker,
				);
		}
		writeJson(join(root, "manifest.json"), manifest);
		const summary = summarizeClaudeNativeForkMeasurement(manifest);
		writeJson(join(root, "measurements.json"), summary);
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		return;
	}
	assert(!existsSync(root) || args.includes("--continue"), "证据目录必须全新；请用 --analyze-only 或 --continue");
	directory(root);
	const binaryResult = spawnSync("which", ["claude"], { encoding: "utf8" });
	assert.equal(binaryResult.status, 0, "找不到 claude");
	const binary = realpathSync(binaryResult.stdout.trim());
	const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
	const contextTokens = Number(value("--context-tokens", "64000"));
	assert(Number.isSafeInteger(contextTokens) && contextTokens >= 16_000 && contextTokens <= 160_000);
	const models = value("--models", "claude-opus-5-5,claude-sonnet-5-5").split(",");
	assert(
		models.length > 0 &&
			new Set(models).size === models.length &&
			models.every((model) => /^(claude-(opus|sonnet)-5-5|claude-fable-5-2)$/.test(model)),
	);
	const manifest = args.includes("--continue")
		? readJson(join(root, "manifest.json"))
		: {
				version,
				binary,
				createdAt: new Date().toISOString(),
				contextTokens,
				models,
				...(args.includes("--parent-hot-after") ? { parentHotAfter: true } : {}),
				method: "headless default system prompt; native --resume --fork-session; one fork per model; effort high",
				operations: [],
			};
	assert.equal(manifest.binary, binary, "接续期间禁止更换 CLI");
	assert.equal(manifest.version, version, "接续期间禁止更换 CLI 版本");
	assert.equal(manifest.contextTokens, contextTokens, "接续期间禁止更换规模");
	assert.deepEqual(manifest.models, models, "接续期间禁止更换模型");
	assert.equal(Boolean(manifest.parentHotAfter), args.includes("--parent-hot-after"), "接续期间禁止更换后置对照要求");
	writeJson(join(root, "manifest.json"), manifest);
	const context = runtime(root);
	for (const model of models) {
		const priorSeed = manifest.operations.find(
			(operation) => operation.model === model && operation.step === "parent-seed",
		);
		const nonce = priorSeed?.prompt.match(/RECALL_KEY=([a-f0-9-]{36})/)?.[1] ?? randomUUID();
		const run = async (step, prompt, extra = {}) => {
			const existing = manifest.operations.find((operation) => operation.key === `${model}-${step}`);
			if (existing) {
				assert.equal(existing.status, "completed", "既有步骤提交状态未知；禁止重新发送");
				collectOperation(root, context, existing);
				writeJson(join(root, "manifest.json"), manifest);
				return existing;
			}
			const marker = `CLAUDE_FORK_CACHE_${randomUUID()}`;
			return execute(root, manifest, context, {
				key: `${model}-${step}`,
				step,
				model,
				marker,
				prompt: `${marker}\n${prompt}`,
				...extra,
			});
		};
		await run("baseline", "请只答 OK，不调用工具。");
		const seed = await run(
			"parent-seed",
			`记住本会话的 RECALL_KEY=${nonce}\n${createSyntheticForkCacheMeasurementPrompt(randomUUID(), contextTokens)}`,
		);
		const hot = await run("parent-hot", "请只答 OK，不调用工具。", { parentId: seed.native.sessionId });
		assert.equal(seed.native.sessionId, hot.native.sessionId, "热对照不是同一父会话");
		const frozenText = readFileSync(hot.transcriptPath, "utf8");
		const fork = await run(
			"fork-first",
			"请只返回父会话最早 user 消息中 RECALL_KEY= 后面的 UUID，不要解释，不调用工具。",
			{ parentId: hot.native.sessionId, fork: true },
		);
		assert.notEqual(fork.native.sessionId, hot.native.sessionId, "fork 没有新建会话身份");
		fork.parentUnchanged = hash(readFileSync(hot.transcriptPath)) === hash(frozenText);
		const childRows = rows(readFileSync(fork.transcriptPath, "utf8"));
		const parentMessages = rows(frozenText).filter((record) => ["user", "assistant"].includes(record.type));
		const childMessages = childRows.filter((record) => ["user", "assistant"].includes(record.type));
		fork.inheritedHistory =
			parentMessages.length > 0 &&
			parentMessages.every(
				(record, index) =>
					childMessages[index]?.uuid === record.uuid &&
					JSON.stringify(childMessages[index].message) === JSON.stringify(record.message),
			);
		fork.recalledNonce = fork.native.result.trim() === nonce;
		writeJson(join(root, "manifest.json"), manifest);
		if (manifest.parentHotAfter) {
			const after = await run("parent-hot-after", "请只答 OK，不调用工具。", { parentId: hot.native.sessionId });
			assert.equal(after.native.sessionId, hot.native.sessionId, "后置热对照不是同一父会话");
		}
	}
	const summary = summarizeClaudeNativeForkMeasurement(manifest);
	writeJson(join(root, "measurements.json"), summary);
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
