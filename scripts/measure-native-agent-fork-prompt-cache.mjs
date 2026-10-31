#!/usr/bin/env node
// 独立研究入口；不导入 Kanban 运行时，不复用真实任务会话，不执行仓库操作。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const expectedVersions = { codex: "0.166.0", kimi: "2.3.1" };
const expectedModels = { codex: "gpt-6.1-sol", kimi: "kimi-code/k3.1-pro" };
const safeSpawnErrorCodes = new Set(["ENOENT", "EACCES", "E2BIG", "ENOEXEC"]);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const privateDirectory = (path) => {
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`私有目录不能是符号链接：${path}`);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
};

function writeDurableJson(path, value) {
	const stagingPath = `${path}.writing-${randomUUID()}`;
	const descriptor = openSync(stagingPath, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(stagingPath, path);
	const directoryDescriptor = openSync(dirname(path), "r");
	try {
		fsyncSync(directoryDescriptor);
	} finally {
		closeSync(directoryDescriptor);
	}
}

function parseNativeRows(text) {
	const problems = [];
	const rows = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			rows.push({ record: JSON.parse(line), line: index + 1 });
		} catch {
			problems.push(`原生记录第 ${index + 1} 行不完整或不是 JSON`);
		}
	}
	return { rows, problems };
}

function validTokenCounts(inputTokens, cachedInputTokens, outputTokens) {
	return (
		[inputTokens, cachedInputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0) &&
		inputTokens > 0 &&
		cachedInputTokens <= inputTokens
	);
}

export function analyzeNativeTurn(agent, transcript, requestMarker) {
	const { rows, problems } = parseNativeRows(transcript);
	const markerIndex = rows.findIndex(({ record }) => {
		const isUser =
			agent === "codex"
				? (record.type === "event_msg" && record.payload?.type === "user_message") ||
					(record.type === "response_item" && record.payload?.role === "user")
				: record.type === "turn.prompt" || record.type === "context.append_message";
		return isUser && JSON.stringify(record).includes(requestMarker);
	});
	if (markerIndex < 0)
		return {
			requests: [],
			problems: [...problems, "未找到本次请求的原生用户记录"],
			accepted: false,
			completed: false,
		};
	const remainingRows = rows.slice(markerIndex);
	const completionIndex = remainingRows.findIndex(({ record }) =>
		agent === "codex"
			? record.type === "event_msg" && ["task_complete", "turn_complete"].includes(record.payload?.type)
			: record.type === "turn.ended",
	);
	const freshRows = completionIndex < 0 ? remainingRows : remainingRows.slice(0, completionIndex + 1);
	const requests = [];
	let context = rows.slice(0, markerIndex).findLast(({ record }) => record.type === "turn_context")?.record.payload;
	let pendingKimiRequest;
	const seenCodexUsage = new Set();
	for (const { record, line } of freshRows) {
		if (
			record.type === "compacted" ||
			/compact/i.test(record.type) ||
			record.kind === "compaction" ||
			/compact/i.test(record.payload?.type ?? "")
		)
			problems.push("本轮发生上下文压缩");
		if (record.type === "turn_context") context = record.payload;
		if (agent === "codex" && record.type === "event_msg" && record.payload?.type === "token_count") {
			const info = record.payload.info;
			if (!info) continue;
			const usage = info.last_token_usage;
			if (!usage || !validTokenCounts(usage.input_tokens, usage.cached_input_tokens, usage.output_tokens)) {
				problems.push("Codex 缺少有效 last_token_usage 字段");
				continue;
			}
			const usageIdentity = JSON.stringify([info.total_token_usage, usage]);
			if (seenCodexUsage.has(usageIdentity)) continue;
			seenCodexUsage.add(usageIdentity);
			if (!context?.model || !context.effort) problems.push("Codex 缺少本轮模型或推理配置");
			requests.push({
				inputTokens: usage.input_tokens,
				cachedInputTokens: usage.cached_input_tokens,
				outputTokens: usage.output_tokens,
				model: context?.model,
				configurationFingerprint: sha256(JSON.stringify([context?.model, context?.effort])),
				reasoningEffort: context?.effort,
				sourceLine: line,
			});
		}
		if (agent === "kimi" && record.type === "llm.request" && record.agentId === "main") {
			if (pendingKimiRequest) problems.push("Kimi 多个 llm.request 无法与 usage.record 唯一配对");
			pendingKimiRequest = record;
		}
		if (agent === "kimi" && record.type === "usage.record" && record.agentId === "main") {
			const request = pendingKimiRequest;
			pendingKimiRequest = undefined;
			if (!request || record.model !== request.modelAlias || record.usageScope !== "turn") {
				problems.push("Kimi usage.record 缺少同模型的逐请求关联");
				continue;
			}
			const usage = record.usage ?? {};
			const inputTokens = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
			if (
				!Number.isSafeInteger(usage.inputOther) ||
				!Number.isSafeInteger(usage.inputCacheCreation) ||
				usage.inputOther < 0 ||
				usage.inputCacheCreation < 0 ||
				!validTokenCounts(inputTokens, usage.inputCacheRead, usage.output)
			) {
				problems.push("Kimi 缺少有效逐请求 usage 字段");
				continue;
			}
			if (!request.toolsHash || !request.systemPromptHash || !request.thinkingEffort)
				problems.push("Kimi 缺少工具或推理配置证据");
			requests.push({
				inputTokens,
				cachedInputTokens: usage.inputCacheRead,
				outputTokens: usage.output,
				cacheCreationTokens: usage.inputCacheCreation,
				model: request.modelAlias,
				sourceLine: line,
				configurationFingerprint: sha256(
					JSON.stringify([
						request.modelAlias,
						request.thinkingEffort,
						request.thinkingKeep,
						request.provider,
						request.toolsHash,
						request.systemPromptHash,
						request.temperature,
						request.topP,
						request.maxTokens,
						request.toolSelect,
					]),
				),
				reasoningEffort: request.thinkingEffort,
				toolsHash: request.toolsHash,
				systemPromptHash: request.systemPromptHash,
				turnStep: request.turnStep,
			});
		}
	}
	if (pendingKimiRequest) problems.push("Kimi 请求尚无对应 usage.record");
	if (!requests.length) problems.push("本次请求没有可用的原生逐请求计量");
	const completed = freshRows.some(({ record }) =>
		agent === "codex"
			? record.type === "event_msg" && ["task_complete", "turn_complete"].includes(record.payload?.type)
			: record.type === "turn.ended" &&
				!["cancelled", "aborted", "error", "failed"].includes(record.reason ?? record.status),
	);
	if (!completed) problems.push("缺少本次请求的成功回合结束证据");
	return { requests, problems: [...new Set(problems)], accepted: true, completed };
}

export function assessHistoryReuse({ baseline, hotBefore, hotAfter, fork, integrityProblems = [] }) {
	const problems = [...integrityProblems];
	const measurements = [baseline, hotBefore, hotAfter, fork];
	if (
		new Set(measurements.map((item) => item.configurationFingerprint)).size !== 1 ||
		new Set(measurements.map((item) => item.model)).size !== 1 ||
		new Set(measurements.map((item) => item.systemPromptHash ?? null)).size !== 1
	)
		problems.push("模型、推理、工具或系统提示配置变化");
	// 冷请求也可能 miss；空历史的总 input 是共享静态前缀的保守上界。
	const publicPrefixTokenUpperBound = Math.max(baseline.inputTokens, baseline.cachedInputTokens);
	const parentHotCachedHistoryTokenReference =
		Math.min(hotBefore.cachedInputTokens, hotAfter.cachedInputTokens) - publicPrefixTokenUpperBound;
	for (const hot of [hotBefore, hotAfter]) {
		if (
			hot.inputTokens <= publicPrefixTokenUpperBound ||
			(hot.cachedInputTokens - publicPrefixTokenUpperBound) / (hot.inputTokens - publicPrefixTokenUpperBound) < 0.8
		)
			problems.push("父会话热续跑对照失效");
	}
	if (parentHotCachedHistoryTokenReference <= 0) problems.push("无法建立父历史缓存基线");
	return {
		status: problems.length ? "insufficient_evidence" : "measured",
		problems: [...new Set(problems)],
		publicPrefixTokenUpperBound,
		parentHotCachedHistoryTokenReference,
		cacheHitRatio: fork.cachedInputTokens / fork.inputTokens,
		historyReuseRatio: problems.length
			? null
			: Math.max(
					0,
					Math.min(
						1,
						(fork.cachedInputTokens - publicPrefixTokenUpperBound) / parentHotCachedHistoryTokenReference,
					),
				),
	};
}

export function resolveOperationRecovery({
	status,
	completed,
	spawnErrorCode,
	preSubmissionRejectionCode,
	attemptCount = 0,
}) {
	if (completed || status === "completed") return "complete";
	if (
		status === "prepared" ||
		(status === "not_submitted" &&
			(safeSpawnErrorCodes.has(spawnErrorCode) ||
				["AUTH_TOKEN_MISSING", "SESSION_ID_NOT_FOUND"].includes(preSubmissionRejectionCode)) &&
			attemptCount < 2)
	)
		return "execute";
	return "await_native_evidence";
}

export function classifyKimiPreSubmissionRejection(stderr, nativeTranscripts) {
	const rejectionCode = /^error: failed to run prompt: provider [^\n]+ has no credential configured\s*$/m.test(stderr)
		? "AUTH_TOKEN_MISSING"
		: /^error: failed to run prompt: Session "[^"]+" not found\.\s*$/m.test(stderr)
			? "SESSION_ID_NOT_FOUND"
			: null;
	if (!rejectionCode || nativeTranscripts.length !== 1) return null;
	const parsed = parseNativeRows(nativeTranscripts[0]);
	if (parsed.problems.length || !parsed.rows.some(({ record }) => record.type === "metadata")) return null;
	return parsed.rows.some(({ record }) => ["llm.request", "usage.record", "turn.prompt"].includes(record.type))
		? null
		: rejectionCode;
}

export function buildIsolatedEnvironment(source, paths) {
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
		"OPENAI_API_KEY",
	]) {
		if (source[key]) environment[key] = source[key];
	}
	return {
		...environment,
		HOME: paths.home,
		USERPROFILE: paths.home,
		XDG_CONFIG_HOME: join(paths.home, ".config"),
		XDG_CACHE_HOME: join(paths.home, ".cache"),
		XDG_DATA_HOME: join(paths.home, ".local", "share"),
		CODEX_HOME: paths.codexHome,
		CODEX_SQLITE_HOME: paths.codexHome,
		KIMI_CODE_HOME: paths.kimiHome,
		TMPDIR: join(paths.home, "process-temporary-files"),
		TERM: "dumb",
		NO_COLOR: "1",
		CI: "1",
	};
}

function findBinary(name) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(directory, name);
		if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
	}
	return null;
}

export function isAllowedNativeCodexExecutableLink(relativePath, resolvedTarget, pinnedBinary) {
	return (
		!!pinnedBinary &&
		resolvedTarget === pinnedBinary &&
		/^codex-home\/tmp\/(?:arg0-(?:macos|linux)|path)\/codex-arg0[^/]+\/apply_?patch$/.test(relativePath)
	);
}

function assertPrivateTree(evidenceDirectory, pinnedNativeBinary) {
	for (const path of [
		evidenceDirectory,
		...readdirSync(evidenceDirectory, { recursive: true }).map((entry) => join(evidenceDirectory, entry)),
	]) {
		if (lstatSync(path).isSymbolicLink()) {
			// Codex 自建的执行入口只读复用锁定二进制，不能扩展为状态目录的外链。
			if (
				isAllowedNativeCodexExecutableLink(
					relative(evidenceDirectory, path),
					realpathSync(path),
					pinnedNativeBinary,
				)
			)
				continue;
			throw new Error(`隔离目录不允许符号链接：${path}`);
		}
		if (relative(evidenceDirectory, realpathSync(path)).startsWith("..")) throw new Error(`隔离目录越界：${path}`);
	}
}

function privateCopy(source, destination) {
	if (!existsSync(source)) return;
	cpSync(source, destination, { recursive: true, dereference: true });
	for (const path of [
		destination,
		...(statSync(destination).isDirectory()
			? readdirSync(destination, { recursive: true }).map((entry) => join(destination, entry))
			: []),
	]) {
		chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
	}
}

function prepareAgentConfiguration(agent, directory) {
	const sourceHome =
		agent === "codex"
			? (process.env.CODEX_HOME ?? join(homedir(), ".codex"))
			: (process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"));
	const sourceConfiguration = existsSync(join(sourceHome, "config.toml"))
		? parseToml(readText(join(sourceHome, "config.toml")))
		: {};
	let configuration;
	if (agent === "codex") {
		configuration = {
			model: expectedModels.codex,
			model_reasoning_effort: sourceConfiguration.model_reasoning_effort ?? "max",
			approval_policy: "never",
			sandbox_mode: "read-only",
			web_search: "disabled",
			features: { multi_agent: false, memories: false, codex_hooks: false, apps: false, plugins: false },
		};
		for (const key of ["model_provider", "service_tier"])
			if (sourceConfiguration[key]) configuration[key] = sourceConfiguration[key];
		if (
			sourceConfiguration.model_provider &&
			sourceConfiguration.model_providers?.[sourceConfiguration.model_provider]
		) {
			configuration.model_providers = {
				[sourceConfiguration.model_provider]:
					sourceConfiguration.model_providers[sourceConfiguration.model_provider],
			};
		}
		privateCopy(join(sourceHome, "auth.json"), join(directory, "auth.json"));
		if (!existsSync(join(directory, "auth.json")) && !process.env.OPENAI_API_KEY)
			throw new Error("Codex 缺少可复制的凭据");
	} else {
		const model = sourceConfiguration.models?.[expectedModels.kimi];
		if (!model || !sourceConfiguration.providers?.[model.provider])
			throw new Error("Kimi 当前配置缺少 k3.1-pro 模型或 provider");
		configuration = {
			default_model: expectedModels.kimi,
			thinking: sourceConfiguration.thinking ?? { enabled: true, effort: "high" },
			models: { [expectedModels.kimi]: model },
			providers: { [model.provider]: sourceConfiguration.providers[model.provider] },
		};
		for (const item of ["credentials", "oauth", "device_id", "region"])
			privateCopy(join(sourceHome, item), join(directory, item));
		writeDurableJson(join(directory, "mcp.json"), { mcpServers: {} });
	}
	writeFileSync(join(directory, "config.toml"), stringifyToml(configuration), { mode: 0o600 });
	return {
		model: expectedModels[agent],
		reasoning: agent === "codex" ? configuration.model_reasoning_effort : configuration.thinking,
		configurationSha256: sha256(stringifyToml(configuration)),
		sourceConfigurationSha256: sha256(readText(join(sourceHome, "config.toml"))),
		sourceHome,
		externalHooksAndPluginsCopied: false,
	};
}

function prepareRuntime(evidenceDirectory, agent) {
	const runtimeRoot = join(evidenceDirectory, "private-agent-runtime", agent);
	let existingAncestor = runtimeRoot;
	while (!existsSync(existingAncestor)) existingAncestor = dirname(existingAncestor);
	if (relative(realpathSync(evidenceDirectory), realpathSync(existingAncestor)).startsWith(".."))
		throw new Error("隔离运行目录越过证据目录");
	if (existsSync(runtimeRoot)) assertPrivateTree(runtimeRoot, agent === "codex" ? findBinary("codex") : null);
	const paths = {
		home: join(runtimeRoot, "home"),
		codexHome: join(runtimeRoot, "codex-home"),
		kimiHome: join(runtimeRoot, "kimi-home"),
	};
	for (const path of [
		...Object.values(paths),
		join(paths.home, "process-temporary-files"),
		join(runtimeRoot, "working-directory"),
		join(runtimeRoot, "empty-skills"),
	])
		privateDirectory(path);
	assertPrivateTree(runtimeRoot, agent === "codex" ? findBinary("codex") : null);
	return {
		...paths,
		cwd: join(runtimeRoot, "working-directory"),
		emptySkills: join(runtimeRoot, "empty-skills"),
		environment: buildIsolatedEnvironment(process.env, paths),
	};
}

function refreshKimiCredentialCopyIfRecovered(runtime, agentSnapshot) {
	const configuration = parseToml(readText(join(runtime.kimiHome, "config.toml")));
	const provider = configuration.providers?.[configuration.models?.[expectedModels.kimi]?.provider];
	if (provider?.api_key || provider?.oauth?.key !== "oauth/kimi-code" || provider.oauth.storage !== "file") return;
	const credentialPath = join(runtime.kimiHome, "credentials", "kimi-code.json");
	if (existsSync(credentialPath) && readJson(credentialPath).access_token) return;
	const sourceHome = process.env.KIMI_CODE_HOME ?? agentSnapshot.sourceHome;
	const sourceCredentialPath = join(sourceHome, "credentials", "kimi-code.json");
	if (!existsSync(sourceCredentialPath) || !readJson(sourceCredentialPath).access_token) {
		throw new Error("Kimi 当前 OAuth 登录凭据已撤销或缺失；未发送模型请求。来源恢复登录后重跑同一证据目录即可接续");
	}
	const previousDigest = fileDigest(credentialPath);
	privateCopy(sourceCredentialPath, credentialPath);
	agentSnapshot.credentialCopyRefreshes ??= [];
	agentSnapshot.credentialCopyRefreshes.push({
		observedAt: new Date().toISOString(),
		sourceHome,
		previousSha256: previousDigest?.sha256,
		refreshedSha256: fileDigest(credentialPath).sha256,
		reason: "私有凭据副本已撤销，当前来源已恢复有效登录",
	});
}

function nativeTranscripts(agent, runtime) {
	const directory = join(agent === "codex" ? runtime.codexHome : runtime.kimiHome, "sessions");
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true })
		.filter((entry) =>
			agent === "codex"
				? entry.endsWith(".jsonl") && entry.includes("rollout-")
				: entry.endsWith("agents/main/wire.jsonl"),
		)
		.map((entry) => join(directory, entry));
}

function nativeSessionId(agent, path, text) {
	if (agent === "codex")
		return parseNativeRows(text).rows.find(({ record }) => record.type === "session_meta")?.record.payload?.id;
	const statePath = resolve(dirname(path), "../../state.json");
	return existsSync(statePath)
		? readKimiSessionIdentityFromNativeState(readJson(statePath), dirname(path))
		: undefined;
}

export function readKimiSessionIdentityFromNativeState(state, expectedAgentHomeDirectory) {
	return typeof state.id === "string" &&
		state.id.length > 0 &&
		state.agents?.main?.homedir === expectedAgentHomeDirectory
		? state.id
		: undefined;
}

export function readCodexNativePromptConfigurationEvidence(transcript, inheritedParentTranscript = "") {
	const rows = parseNativeRows(transcript).rows;
	const metadata = rows.find(({ record }) => record.type === "session_meta")?.record.payload;
	let tools = rows.findLast(
		({ record }) => record.type === "response_item" && record.payload?.type === "additional_tools",
	)?.record.payload.tools;
	if (!tools && metadata?.history_base && inheritedParentTranscript)
		tools = parseNativeRows(inheritedParentTranscript).rows.findLast(
			({ record }) => record.type === "response_item" && record.payload?.type === "additional_tools",
		)?.record.payload.tools;
	return {
		baseInstructionsSha256: metadata?.base_instructions?.text ? sha256(metadata.base_instructions.text) : null,
		additionalToolsSha256: Array.isArray(tools) ? sha256(JSON.stringify(tools)) : null,
	};
}

function fileDigest(path) {
	if (!path || !existsSync(path)) return null;
	return { sha256: sha256(readFileSync(path)), bytes: statSync(path).size, mtimeMs: statSync(path).mtimeMs };
}

function locateOperationTranscript(operation, runtime) {
	const candidates = nativeTranscripts(operation.agent, runtime);
	if (operation.sessionId)
		return candidates.find((path) => nativeSessionId(operation.agent, path, readText(path)) === operation.sessionId);
	const matches = candidates.filter((path) => {
		const text = readText(path);
		return operation.kind === "fork-create"
			? !operation.beforeTranscriptPaths.includes(path)
			: analyzeNativeTurn(operation.agent, text, operation.marker).accepted;
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function nativeTurnHasUniqueValidMeasurement(native) {
	return native?.requests?.length === 1 && !native.problems?.length;
}

function applyMeasuredOperationStatus(operation) {
	if (operation.status === "quota_exhausted" || operation.status === "not_submitted") return;
	if (!operation.native?.accepted && !operation.native?.completed) return;
	if (operation.kind === "fork-create") {
		if (operation.native?.accepted && operation.native.completed) operation.status = "completed";
		return;
	}
	operation.status =
		operation.native?.accepted && operation.native.completed && nativeTurnHasUniqueValidMeasurement(operation.native)
			? "completed"
			: "insufficient_evidence";
}

function recordKimiNativeSessionState(evidenceDirectory, operation) {
	if (operation.agent !== "kimi" || !operation.nativeTranscriptPath) return;
	const authoritativeId = nativeSessionId("kimi", operation.nativeTranscriptPath);
	const sessionStateSourcePath = resolve(dirname(operation.nativeTranscriptPath), "../../state.json");
	if (authoritativeId && existsSync(sessionStateSourcePath)) {
		operation.nativeSessionStateArtifactPath ??= join(
			operation.artifactDirectory,
			`native-session-state-attempt-${operation.attempts.length}.json`,
		);
		const sessionStateArtifactPath = join(evidenceDirectory, operation.nativeSessionStateArtifactPath);
		if (!existsSync(sessionStateArtifactPath)) {
			copyFileSync(sessionStateSourcePath, sessionStateArtifactPath);
			chmodSync(sessionStateArtifactPath, 0o600);
			operation.nativeSessionStateSnapshotRecordedAt = new Date().toISOString();
		}
	}
	if (authoritativeId && operation.sessionId !== authoritativeId) {
		operation.nativeIdentityCorrections ??= [];
		operation.nativeIdentityCorrections.push({
			observedAt: new Date().toISOString(),
			previousSessionId: operation.sessionId,
			sessionId: authoritativeId,
			source: "native_session_state_json",
		});
		operation.sessionId = authoritativeId;
	}
}

function reconcileOperation(evidenceDirectory, operation, runtime) {
	recordKimiNativeSessionState(evidenceDirectory, operation);
	if (
		operation.status === "completed" &&
		operation.native?.accepted &&
		operation.native.completed &&
		(operation.kind === "fork-create" || nativeTurnHasUniqueValidMeasurement(operation.native))
	)
		return;
	const source = locateOperationTranscript(operation, runtime);
	if (!source) {
		const lastAttempt = operation.attempts.at(-1);
		if (operation.agent !== "kimi" || !lastAttempt?.finishedAt) return;
		const candidates = nativeTranscripts(operation.agent, runtime).filter((path) => {
			if (operation.beforeTranscriptPaths.includes(path)) return false;
			const createdAt = parseNativeRows(readText(path)).rows.find(({ record }) => record.type === "metadata")?.record
				.created_at;
			return createdAt >= Date.parse(lastAttempt.startedAt) && createdAt <= Date.parse(lastAttempt.finishedAt);
		});
		const stderr = readText(
			join(evidenceDirectory, operation.artifactDirectory, `stderr-attempt-${operation.attempts.length}.log`),
		);
		const rejectionCode = classifyKimiPreSubmissionRejection(stderr, candidates.map(readText));
		if (rejectionCode) {
			lastAttempt.preSubmissionRejectionCode = rejectionCode;
			operation.status = "not_submitted";
			operation.recoveryCondition = "当前凭据来源恢复有效登录后自动复制到私有 HOME，仍只对明确未提交的请求有界重试";
			operation.preSubmissionRejectionEvidencePath = join(
				operation.artifactDirectory,
				`pre-submission-rejection-attempt-${operation.attempts.length}.jsonl`,
			);
			copyFileSync(candidates[0], join(evidenceDirectory, operation.preSubmissionRejectionEvidencePath));
		}
		return;
	}
	operation.sessionId = nativeSessionId(operation.agent, source, readText(source));
	operation.nativeTranscriptPath = source;
	recordKimiNativeSessionState(evidenceDirectory, operation);
	const artifact = join(
		evidenceDirectory,
		operation.artifactDirectory,
		`native-transcript-attempt-${operation.attempts.length}.jsonl`,
	);
	copyFileSync(source, artifact);
	chmodSync(artifact, 0o600);
	operation.transcriptArtifactPath = relative(evidenceDirectory, artifact);
	operation.native =
		operation.kind === "fork-create"
			? { completed: true, accepted: true, requests: [], problems: [] }
			: analyzeNativeTurn(operation.agent, readText(artifact), operation.marker);
	const lastAttempt = operation.attempts.at(-1);
	if (operation.agent === "kimi" && !operation.native.accepted && lastAttempt?.finishedAt) {
		const newRecords = parseNativeRows(readText(artifact)).rows.filter(
			({ record }) => record.type === "metadata" || record.time >= Date.parse(lastAttempt.startedAt),
		);
		const stderr = readText(
			join(evidenceDirectory, operation.artifactDirectory, `stderr-attempt-${operation.attempts.length}.log`),
		);
		const rejectionCode = classifyKimiPreSubmissionRejection(stderr, [
			newRecords.map(({ record }) => JSON.stringify(record)).join("\n"),
		]);
		if (rejectionCode) {
			lastAttempt.preSubmissionRejectionCode = rejectionCode;
			operation.status = "not_submitted";
			operation.preSubmissionRejectionEvidencePath = operation.transcriptArtifactPath;
			operation.preSubmissionRejectionWatermarkMs = Date.parse(lastAttempt.startedAt);
			operation.recoveryCondition = "按已核对的原生 state.json 完整会话 ID 接续；历史调用前拒绝记录保留";
		}
	}
	applyMeasuredOperationStatus(operation);
	if (operation.parentTranscriptPath) {
		operation.parentAfter ??= fileDigest(operation.parentTranscriptPath);
		operation.parentUnchanged =
			operation.parentBefore?.sha256 === operation.parentAfter?.sha256 &&
			operation.parentBefore?.bytes === operation.parentAfter?.bytes;
	}
}

let interrupted = false;
let activeChild;
function terminateActiveChild(signal = "SIGTERM") {
	if (!activeChild) return;
	try {
		process.kill(-activeChild.pid, signal);
	} catch {
		/* 子进程可能已经结束。 */
	}
}

async function executeNativeCommand(binary, args, runtime, stdin, artifactDirectory, operation, save) {
	const attempt = {
		startedAt: new Date().toISOString(),
		arguments: args.map((argument) => (argument === stdin ? "<持久 prompt 文件>" : argument)),
	};
	operation.attempts.push(attempt);
	operation.status = "submitting";
	operation.recoveryCondition = "先查本次 marker 的原生结束与 usage 记录；提交未知时禁止重发，其他独立测试继续";
	save();
	const stdoutPath = join(artifactDirectory, `stdout-attempt-${operation.attempts.length}.jsonl`);
	const stderrPath = join(artifactDirectory, `stderr-attempt-${operation.attempts.length}.log`);
	const stdout = openSync(stdoutPath, "w", 0o600);
	const stderr = openSync(stderrPath, "w", 0o600);
	let timeout;
	let hardKill;
	try {
		await new Promise((done) => {
			const child = spawn(binary, args, {
				cwd: runtime.cwd,
				env: runtime.environment,
				detached: true,
				stdio: ["pipe", stdout, stderr],
			});
			activeChild = child;
			attempt.pid = child.pid;
			save();
			child.stdin.on("error", () => {});
			child.stdin.end(operation.agent === "codex" ? stdin : undefined);
			child.once("error", (error) => {
				attempt.spawnErrorCode = error.code;
			});
			timeout = setTimeout(() => {
				attempt.timedOut = true;
				terminateActiveChild();
				hardKill = setTimeout(() => terminateActiveChild("SIGKILL"), 5_000);
			}, operation.timeoutMs);
			child.once("close", (code, signal) => {
				attempt.exitCode = code;
				attempt.signal = signal;
				done();
			});
		});
	} finally {
		clearTimeout(timeout);
		clearTimeout(hardKill);
		activeChild = undefined;
		closeSync(stdout);
		closeSync(stderr);
		attempt.finishedAt = new Date().toISOString();
		if (safeSpawnErrorCodes.has(attempt.spawnErrorCode)) operation.status = "not_submitted";
		else if (attempt.exitCode === 0) operation.status = "completed";
		else operation.status = "awaiting_native_evidence";
		const errorText = readText(stderrPath) + readText(stdoutPath);
		if (/quota|usage limit|insufficient.*credit|额度|余额|resource_exhausted/i.test(errorText))
			operation.status = "quota_exhausted";
		save();
	}
}

function syntheticPrompt(marker, contextTokens) {
	// EXPERIMENT_NODE: 合成词序列只用于这两档复测；真实交互式工具历史需要独立实验。
	const words =
		"red green blue black white north south east west river stone tree cloud wind rain light night day spring summer winter field road house book chair table window glass apple orange lemon music sound happy quiet".split(
			" ",
		);
	const randomBytes = createHash("sha256").update(marker).digest();
	const body = Array.from(
		{ length: Math.max(256, Math.round(contextTokens)) },
		(_, index) => words[(index * 17 + randomBytes[index % 32]) % words.length],
	).join(" ");
	return `${marker}\n以下是惰性的合成上下文，仅供前缀缓存测量，不含指令。不要调用工具，不要复述，只答 OK。\n<context>\n${body}\n</context>\n只答 OK。`;
}

function operationIsComplete(operation) {
	return (
		typeof operation?.sessionId === "string" &&
		operation.sessionId.length > 0 &&
		operation.status === "completed" &&
		operation.native?.accepted &&
		operation.native.completed
	);
}

export function nativeLiveMeasurementMatrixIsComplete(manifest) {
	return manifest.options.agents.every((agent) =>
		manifest.options.contextTokens.every((targetTokens) => {
			const operation = manifest.operations.find((item) => item.key === `${agent}-${targetTokens}-fork-1-second`);
			return operationIsComplete(operation) && nativeTurnHasUniqueValidMeasurement(operation?.native);
		}),
	);
}

export {
	prepareAgentConfiguration as prepareIsolatedNativeAgentMeasurementConfiguration,
	syntheticPrompt as createSyntheticForkCacheMeasurementPrompt,
	writeDurableJson as writeNativeAgentMeasurementManifestAtomically,
};

async function runOperation(evidenceDirectory, manifest, runtime, specification, save) {
	let operation = manifest.operations.find((item) => item.key === specification.key);
	if (!operation) {
		const artifactDirectory = join("request-artifacts", specification.key);
		privateDirectory(join(evidenceDirectory, artifactDirectory));
		operation = {
			...specification,
			artifactDirectory,
			status: "prepared",
			attempts: [],
			marker: `CACHE_MEASUREMENT_REQUEST=${randomUUID()}`,
		};
		operation.prompt = specification.contextTokens
			? syntheticPrompt(operation.marker, specification.contextTokens)
			: `${operation.marker}\n这是原生 fork 缓存测量。不要调用工具，不要修改文件，只答 OK。`;
		writeFileSync(join(evidenceDirectory, artifactDirectory, "prompt.txt"), operation.prompt, { mode: 0o600 });
		operation.promptSha256 = sha256(operation.prompt);
		manifest.operations.push(operation);
		save();
	}
	if (operation.status !== "prepared") reconcileOperation(evidenceDirectory, operation, runtime);
	const lastAttempt = operation.attempts.at(-1);
	const recovery = resolveOperationRecovery({
		status: operation.status,
		completed: operation.native?.completed,
		spawnErrorCode: lastAttempt?.spawnErrorCode,
		preSubmissionRejectionCode: lastAttempt?.preSubmissionRejectionCode,
		attemptCount: operation.attempts.length,
	});
	if (recovery !== "execute" || interrupted) {
		save();
		return operation;
	}
	if (
		operation.status === "not_submitted" &&
		lastAttempt?.preSubmissionRejectionCode === "AUTH_TOKEN_MISSING" &&
		specification.contextTokens &&
		specification.contextTokens !== operation.contextTokens
	) {
		const previousPromptArtifactPath = join(
			operation.artifactDirectory,
			`prompt-before-recovery-${operation.attempts.length}.txt`,
		);
		writeFileSync(join(evidenceDirectory, previousPromptArtifactPath), operation.prompt, { mode: 0o600 });
		operation.promptRevisions ??= [];
		operation.promptRevisions.push({
			recordedAt: new Date().toISOString(),
			previousPromptArtifactPath,
			previousPromptSha256: operation.promptSha256,
			reason: "原请求未提交；凭据恢复后按成功冷基线重新校准合成上下文规模",
		});
		operation.contextTokens = specification.contextTokens;
		operation.prompt = syntheticPrompt(operation.marker, operation.contextTokens);
		operation.promptSha256 = sha256(operation.prompt);
		writeFileSync(join(evidenceDirectory, operation.artifactDirectory, "prompt.txt"), operation.prompt, {
			mode: 0o600,
		});
		save();
	}
	if (
		operation.sessionId &&
		!nativeTranscripts(operation.agent, runtime).some(
			(path) => nativeSessionId(operation.agent, path, readText(path)) === operation.sessionId,
		)
	) {
		operation.status = "awaiting_native_evidence";
		operation.recoveryCondition = "恢复清单绑定的原生会话文件后自动接续";
		save();
		return operation;
	}
	operation.beforeTranscriptPaths = nativeTranscripts(operation.agent, runtime);
	operation.parentBefore = fileDigest(operation.parentTranscriptPath);
	if (operation.frozenParentSha256 && operation.parentBefore?.sha256 !== operation.frozenParentSha256) {
		operation.status = "awaiting_native_evidence";
		operation.recoveryCondition = "父状态已前进；先查已创建的原生分身，只有冻结父状态的身份和历史可核验后才能接续";
		save();
		return operation;
	}
	let args;
	if (operation.agent === "codex") {
		args = ["exec"];
		if (operation.kind === "fork-first") args.push("fork", operation.parentSessionId);
		else if (operation.sessionId) args.push("resume", operation.sessionId);
		args.push("--json", "--skip-git-repo-check", "--ignore-rules", "-m", expectedModels.codex, "-");
	} else if (operation.kind === "fork-create") args = ["fork", operation.parentSessionId, "--yes"];
	else {
		args = ["--model", expectedModels.kimi, "--skills-dir", runtime.emptySkills];
		if (operation.sessionId) args.push("--session", operation.sessionId);
		args.push("--output-format", "stream-json", "--prompt", operation.prompt);
	}
	console.log(`开始 ${operation.key}（第 ${operation.attempts.length + 1} 次尝试）`);
	await executeNativeCommand(
		manifest.agents[operation.agent].binary,
		args,
		runtime,
		operation.prompt,
		join(evidenceDirectory, operation.artifactDirectory),
		operation,
		save,
	);
	if (operation.parentTranscriptPath) {
		operation.parentAfter = fileDigest(operation.parentTranscriptPath);
		operation.parentUnchanged =
			operation.parentBefore?.sha256 === operation.parentAfter?.sha256 &&
			operation.parentBefore?.bytes === operation.parentAfter?.bytes;
	}
	reconcileOperation(evidenceDirectory, operation, runtime);
	applyMeasuredOperationStatus(operation);
	console.log(
		`结束 ${operation.key}：${operation.status}，逐请求用量 ${JSON.stringify(operation.native?.requests ?? [])}`,
	);
	save();
	return operation;
}

export function verifyForkHistoryInheritance({
	agent,
	childTranscript,
	childSessionId,
	childSessionState,
	parentTranscript,
	parentSessionId,
	frozenParentSha256,
	parentPrompts,
}) {
	const containsPrompts = (text) =>
		parentPrompts.every((prompt) => text.includes(JSON.stringify(prompt).slice(1, -1)));
	if (sha256(parentTranscript) !== frozenParentSha256 || !containsPrompts(parentTranscript))
		return { verified: false, reason: "父快照摘要或完整提示词不匹配" };
	const childMeta = parseNativeRows(childTranscript).rows.find(({ record }) => record.type === "session_meta")?.record
		.payload;
	if (agent === "codex" && childMeta?.history_base) {
		const reference = childMeta.history_base;
		const parentRows = parseNativeRows(parentTranscript).rows;
		const parentId = parentRows.find(({ record }) => record.type === "session_meta")?.record.payload.id;
		const ordinalBoundary = Math.max(...parentRows.map(({ record }) => record.ordinal ?? -1)) + 1;
		const verified =
			parentId === parentSessionId &&
			childMeta.id !== parentSessionId &&
			reference.thread_id === parentSessionId &&
			childMeta.forked_from_id === parentSessionId &&
			reference.end_byte_offset === Buffer.byteLength(parentTranscript) &&
			reference.end_ordinal_exclusive === ordinalBoundary &&
			childMeta.forked_from_ordinal_exclusive === ordinalBoundary;
		return {
			verified,
			mode: "paginated_parent_reference",
			reference,
			parentSnapshotSha256: frozenParentSha256,
			baseInstructionsUnchanged:
				sha256(JSON.stringify(childMeta.base_instructions)) ===
				sha256(JSON.stringify(parentRows[0]?.record.payload?.base_instructions)),
		};
	}
	const nativeLineageVerified =
		agent !== "kimi" ||
		(childSessionState?.forkedFrom === parentSessionId &&
			childSessionState.id === childSessionId &&
			childSessionId !== parentSessionId);
	return {
		verified: nativeLineageVerified && containsPrompts(childTranscript),
		mode: "copied_history",
		nativeParentSessionId: childSessionState?.forkedFrom,
		parentSnapshotSha256: frozenParentSha256,
	};
}

function caseReport(evidenceDirectory, manifest, agent, targetTokens) {
	const prefix = `${agent}-${targetTokens}`;
	const operations = manifest.operations.filter((operation) => operation.key.startsWith(`${prefix}-`));
	const find = (name) => operations.find((operation) => operation.key === `${prefix}-${name}`);
	const baseline = find("cold-prefix-baseline");
	const parent = find("parent-create");
	const hotBefore = find("parent-hot-before");
	const hotAfter = find("parent-hot-after");
	const forks = Array.from({ length: manifest.options.forkCount }, (_, index) => {
		const operation = find(`fork-${index + 1}-first`);
		if (!operation)
			return {
				key: `${prefix}-fork-${index + 1}-first`,
				status: "not_executed",
				historyReuseRatio: null,
				problems: [manifest.agents[agent]?.problem ?? "前置步骤尚未完成，尚未执行本次 fork"],
			};
		const related = [baseline, parent, hotBefore, hotAfter, operation];
		const problems = related.flatMap((item) =>
			!operationIsComplete(item) ? [`${item?.key ?? "前置步骤"} 未完成`] : item.native.problems,
		);
		if (related.some((item) => item?.native?.requests.length !== 1))
			problems.push("对照或分身并非唯一模型请求，首轮比较证据不足；逐请求数据仍保留");
		if (!operation?.parentUnchanged) problems.push("父 transcript 前后不一致或缺少摘要");
		if (!operation?.sessionId || operation.sessionId === parent?.sessionId) problems.push("缺少独立分身身份");
		let historyInheritance;
		if (operation?.transcriptArtifactPath && hotBefore?.transcriptArtifactPath && parent) {
			historyInheritance = verifyForkHistoryInheritance({
				agent,
				childTranscript: readText(join(evidenceDirectory, operation.transcriptArtifactPath)),
				childSessionId: operation.sessionId,
				childSessionState: operation.nativeSessionStateArtifactPath
					? readJson(join(evidenceDirectory, operation.nativeSessionStateArtifactPath))
					: undefined,
				parentTranscript: readText(join(evidenceDirectory, hotBefore.transcriptArtifactPath)),
				parentSessionId: parent.sessionId,
				frozenParentSha256: operation.frozenParentSha256,
				parentPrompts: [parent.prompt, hotBefore.prompt],
			});
		}
		if (!historyInheritance?.verified) problems.push("分身未证实继承冻结父历史");
		let codexNativePromptConfiguration;
		if (agent === "codex" && related.every((item) => item?.transcriptArtifactPath)) {
			const parentTranscript = readText(join(evidenceDirectory, hotBefore.transcriptArtifactPath));
			const configurations = related.map((item) =>
				readCodexNativePromptConfigurationEvidence(
					readText(join(evidenceDirectory, item.transcriptArtifactPath)),
					item.kind === "fork-first" ? parentTranscript : "",
				),
			);
			if (
				configurations.some((item) => !item.baseInstructionsSha256 || !item.additionalToolsSha256) ||
				new Set(configurations.map((item) => JSON.stringify(item))).size !== 1
			)
				problems.push("Codex 原生基础指令或工具快照缺失、变化");
			codexNativePromptConfiguration = configurations.at(-1);
		}
		if (operation?.frozenParentSha256 !== operation?.parentBefore?.sha256)
			problems.push("fork 来源不是冻结的同一父状态");
		if (problems.length)
			return {
				key: operation?.key ?? `${prefix}-fork-${index + 1}-first`,
				status: "insufficient_evidence",
				problems: [...new Set(problems)],
				historyReuseRatio: null,
			};
		// 父首次请求也是冷历史，取两者 cached 的较大值，保守扣除静态公共前缀。
		const cold = {
			...baseline.native.requests[0],
			cachedInputTokens: Math.max(
				baseline.native.requests[0].cachedInputTokens,
				parent.native.requests[0].cachedInputTokens,
			),
		};
		return {
			key: operation.key,
			sessionId: operation.sessionId,
			historyInheritance,
			codexNativePromptConfiguration,
			...assessHistoryReuse({
				baseline: cold,
				hotBefore: hotBefore.native.requests[0],
				hotAfter: hotAfter.native.requests[0],
				fork: operation.native.requests[0],
			}),
		};
	});
	const forkSessionIds = forks.map((item) => item.sessionId).filter(Boolean);
	if (new Set(forkSessionIds).size !== forkSessionIds.length) {
		for (const fork of forks) {
			fork.status = "insufficient_evidence";
			fork.historyReuseRatio = null;
			fork.problems.push("分身身份不唯一");
		}
	}
	return { agent, targetTokens, operations: operations.map(({ prompt, ...operation }) => operation), forks };
}

function writeReports(evidenceDirectory, manifest) {
	const cases = manifest.options.agents.flatMap((agent) =>
		manifest.options.contextTokens.map((tokens) => caseReport(evidenceDirectory, manifest, agent, tokens)),
	);
	writeDurableJson(join(evidenceDirectory, "measurements.json"), {
		schemaVersion: 1,
		runId: manifest.runId,
		analyzedAt: new Date().toISOString(),
		cases,
	});
	const percent = (number) => (number === null || number === undefined ? "未知" : `${(number * 100).toFixed(2)}%`);
	const lines = [
		"# 原生 Agent fork 缓存复测",
		"",
		`运行：${manifest.runId}；创建：${manifest.createdAt}。`,
		"",
		"仅适用于所测 CLI、模型、推理设置与合成上下文；不代表全部生产交互式会话。",
		"",
		"公共前缀上界取空历史冷基线 input 与父首次请求 cached 的较大值，避免冷基线本身 miss 时误判。历史复用比例 = max(0, fork cached - 公共前缀上界) / (min(前后热对照 cached) - 公共前缀上界)，上限 100%。这是保守比较值；前后热对照扣除公共前缀上界后的命中率须至少 80%。",
		"",
		"多次模型请求逐项保留；首轮对比不能唯一归属、发生压缩或配置变化时不下缓存结论。额度耗尽、未执行与证据不足分别记录。",
		"",
		"证据目录为私有目录。private-agent-runtime 含凭据副本，不可分享；离线分析使用 manifest.json、request-artifacts 与 measurements.json。",
		"",
	];
	for (const [agent, snapshot] of Object.entries(manifest.agents))
		lines.push(
			`- ${agent}：${snapshot.version ?? "未安装"}，${snapshot.model ?? expectedModels[agent]}，推理 ${JSON.stringify(snapshot.reasoning)}；配置摘要 ${snapshot.configurationSha256 ?? "未知"}；${snapshot.problem ?? "预检通过"}`,
		);
	for (const item of cases) {
		lines.push(
			"",
			`## ${item.agent}：目标 ${item.targetTokens} tokens`,
			"",
			"| 步骤 | 状态 | 原生会话 | input | cached | 总命中率 |",
			"| --- | --- | --- | ---: | ---: | ---: |",
		);
		for (const operation of item.operations) {
			const requests = operation.native?.requests ?? [];
			if (!requests.length)
				lines.push(`| ${operation.key} | ${operation.status} | ${operation.sessionId ?? "未知"} | — | — | — |`);
			for (const [index, request] of requests.entries())
				lines.push(
					`| ${operation.key} 请求 ${index + 1} | ${operation.status} | ${operation.sessionId ?? "未知"} | ${request.inputTokens} | ${request.cachedInputTokens} | ${percent(request.cachedInputTokens / request.inputTokens)} |`,
				);
		}
		for (const fork of item.forks)
			lines.push(
				"",
				`- ${fork.key}：${fork.status === "measured" ? `扣除公共前缀上界后的保守历史复用 ${percent(fork.historyReuseRatio)}` : `${fork.status === "not_executed" ? "未执行" : "证据不足"}：${fork.problems.join("；")}`}`,
			);
		const absent = [
			"cold-prefix-baseline",
			"parent-create",
			"parent-hot-before",
			...Array.from({ length: manifest.options.forkCount }, (_, index) => `fork-${index + 1}-first`),
			"fork-1-second",
			"parent-hot-after",
		].filter(
			(step) => !item.operations.some((operation) => operation.key === `${item.agent}-${item.targetTokens}-${step}`),
		);
		if (absent.length)
			lines.push(
				"",
				`未执行：${absent.join("、")}。原因：${manifest.agents[item.agent]?.problem ?? "依赖尚未完成或已中断；恢复同一目录后先自动补证"}。`,
			);
	}
	lines.push(
		"",
		"## 恢复与离线重算",
		"",
		"同一 evidence-directory 再执行脚本：先补读原生记录，完成项不重发。提交未知时等待绑定 marker 的结束与 usage 证据，其他独立项继续；只对明确未 spawn 或原生确认调用前凭据拒绝的请求最多尝试两次。分身第二轮必须有唯一有效逐请求用量且没有证据问题，否则矩阵不以退出码 0 完成，也不把缺计量重发成新的模型请求。Kimi 在首次定位原生 transcript 的同一次操作中保存 state.json 快照。",
		"",
		"执行退出码：0 表示完整矩阵有可用计量，包含每个规模的分身第二轮；2 表示存在未执行或证据不足，已完成的首轮读数保留；1 表示入口错误；130 表示中断。离线分析成功输出报告时返回 0，具体结论读取 measurements.json。",
		"",
		"`--analyze-only --evidence-directory <本目录>` 不启动 CLI、不读取凭据，只重算已有原生证据。",
		"",
		"Cursor 只记录本机能力；Claude Code 与 DeepSeek 不调用。详见 cursor-capability.json。",
		"",
	);
	writeFileSync(join(evidenceDirectory, "report.zh-CN.md"), lines.join("\n"), { mode: 0o600 });
	return cases;
}

function probeCursorCapability(evidenceDirectory) {
	const binary = findBinary("cursor-agent");
	const result = {
		checkedAt: new Date().toISOString(),
		binary,
		modelCallsPerformed: false,
		officialDocumentation: "https://prod.cursor.com/docs/cli/reference/slash-commands",
	};
	if (binary) {
		const runtime = prepareRuntime(evidenceDirectory, "cursor-capability-only");
		const version = spawnSync(binary, ["--version"], {
			env: runtime.environment,
			cwd: runtime.cwd,
			encoding: "utf8",
			timeout: 20_000,
		});
		result.version = version.stdout?.trim();
		for (const entry of readdirSync(dirname(binary))) {
			if (!entry.endsWith(".js")) continue;
			const path = join(dirname(binary), entry);
			const text = readText(path);
			const match = text.match(/.{0,90}(?:name:\s*["']fork["']|["']\/fork["']|Fork the current chat).{0,160}/);
			if (match) {
				result.installedForkEvidence = { path, sha256: sha256(text), excerpt: match[0] };
				break;
			}
		}
	}
	writeDurableJson(join(evidenceDirectory, "cursor-capability.json"), result);
}

function parseOptions(argv) {
	const options = {
		agents: ["codex", "kimi"],
		contextTokens: [32_000, 128_000],
		forkCount: 3,
		timeoutMs: 300_000,
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
		if (argument === "--agents") options.agents = value.split(",");
		else if (argument === "--context-tokens") options.contextTokens = value.split(",").map(Number);
		else if (argument === "--fork-count") options.forkCount = Number(value);
		else if (argument === "--timeout-ms") options.timeoutMs = Number(value);
		else if (argument === "--evidence-directory") options.evidenceDirectory = resolve(value);
		else throw new Error(`未知选项：${argument}`);
	}
	if (
		!options.agents.length ||
		options.agents.some((agent) => !["codex", "kimi"].includes(agent)) ||
		new Set(options.agents).size !== options.agents.length ||
		!options.contextTokens.length ||
		options.contextTokens.some((tokens) => !Number.isSafeInteger(tokens) || tokens < 1_000 || tokens > 200_000) ||
		new Set(options.contextTokens).size !== options.contextTokens.length ||
		!Number.isInteger(options.forkCount) ||
		options.forkCount < 1 ||
		options.forkCount > 10 ||
		!Number.isInteger(options.timeoutMs) ||
		options.timeoutMs < 1_000 ||
		options.timeoutMs > 900_000
	)
		throw new Error("Agent、上下文规模、fork 次数或超时参数无效");
	return options;
}

async function main() {
	const options = parseOptions(process.argv.slice(2));
	if (options.help) {
		console.log(
			"用法：node scripts/measure-native-agent-fork-prompt-cache.mjs [--agents codex,kimi] [--context-tokens 32000,128000] [--fork-count 3] [--evidence-directory 持久目录] [--timeout-ms 300000] [--analyze-only]\n默认会真实调用模型；版本固定 Codex 0.166.0/gpt-6.1-sol 与 Kimi 2.3.1/k3.1-pro。离线重算必须指定已有证据目录。",
		);
		return;
	}
	if (options.analyzeOnly && !options.evidenceDirectory) throw new Error("离线重算必须指定已有证据目录");
	const evidenceDirectory =
		options.evidenceDirectory ??
		join(
			homedir(),
			".cline/kanban/native-agent-fork-prompt-cache-measurements",
			new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8),
		);
	if (/^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/.test(evidenceDirectory))
		throw new Error("证据必须写入能跨重启保留的目录");
	privateDirectory(evidenceDirectory);
	const release = await lockfile.lock(evidenceDirectory, {
		realpath: true,
		stale: 120_000,
		update: 10_000,
		retries: 0,
	});
	let manifest;
	const save = () => writeDurableJson(join(evidenceDirectory, "manifest.json"), manifest);
	try {
		const manifestPath = join(evidenceDirectory, "manifest.json");
		if (existsSync(manifestPath)) manifest = readJson(manifestPath);
		else {
			if (options.analyzeOnly) throw new Error("目录缺少 manifest.json");
			manifest = {
				schemaVersion: 1,
				runId: randomUUID(),
				createdAt: new Date().toISOString(),
				options,
				agents: {},
				operations: [],
			};
			save();
		}
		if (manifest.schemaVersion !== 1) throw new Error("不支持此运行清单版本");
		if (options.analyzeOnly) {
			for (const operation of manifest.operations)
				if (operation.transcriptArtifactPath && operation.kind !== "fork-create") {
					operation.native = analyzeNativeTurn(
						operation.agent,
						readText(join(evidenceDirectory, operation.transcriptArtifactPath)),
						operation.marker,
					);
				}
			writeReports(evidenceDirectory, manifest);
			console.log(`离线报告：${join(evidenceDirectory, "report.zh-CN.md")}`);
			return;
		}
		for (const option of ["agents", "contextTokens", "forkCount"]) {
			const explicit = { agents: "--agents", contextTokens: "--context-tokens", forkCount: "--fork-count" }[option];
			if (
				process.argv.includes(explicit) &&
				JSON.stringify(options[option]) !== JSON.stringify(manifest.options[option])
			)
				throw new Error("恢复必须沿用原运行矩阵；新矩阵请使用新目录");
		}
		console.log(`持久证据目录：${evidenceDirectory}`);
		if (!existsSync(join(evidenceDirectory, "cursor-capability.json"))) probeCursorCapability(evidenceDirectory);
		for (const signal of ["SIGINT", "SIGTERM"])
			process.once(signal, () => {
				interrupted = true;
				terminateActiveChild();
			});
		for (const agent of manifest.options.agents) {
			const runtime = prepareRuntime(evidenceDirectory, agent);
			for (const operation of manifest.operations.filter((item) => item.agent === agent))
				reconcileOperation(evidenceDirectory, operation, runtime);
			let snapshot = manifest.agents[agent];
			try {
				const binary = findBinary(agent);
				if (!binary) throw new Error(`${agent} CLI 未安装`);
				const version = spawnSync(binary, ["--version"], {
					env: runtime.environment,
					cwd: runtime.cwd,
					encoding: "utf8",
					timeout: 20_000,
				}).stdout?.trim();
				if (version?.split(/\s+/).at(-1) !== expectedVersions[agent])
					throw new Error(`当前 ${agent} 版本 ${version} 不等于已批准版本 ${expectedVersions[agent]}`);
				if (!snapshot?.configurationSha256)
					snapshot = {
						binary,
						version,
						binarySha256: sha256(readFileSync(binary)),
						...prepareAgentConfiguration(agent, agent === "codex" ? runtime.codexHome : runtime.kimiHome),
					};
				if (
					snapshot.binarySha256 !== sha256(readFileSync(binary)) ||
					snapshot.configurationSha256 !==
						sha256(readText(join(agent === "codex" ? runtime.codexHome : runtime.kimiHome, "config.toml")))
				)
					throw new Error("CLI 或隔离配置与启动快照不同");
				if (agent === "kimi") refreshKimiCredentialCopyIfRecovered(runtime, snapshot);
				snapshot.problem = null;
			} catch (error) {
				snapshot = { ...snapshot, problem: error.message };
			}
			manifest.agents[agent] = snapshot;
			save();
			if (snapshot.problem) {
				console.log(`跳过 ${agent}：${snapshot.problem}`);
				continue;
			}
			for (const targetTokens of manifest.options.contextTokens) {
				if (interrupted) break;
				const prefix = `${agent}-${targetTokens}`;
				const run = (name, specification = {}) =>
					runOperation(
						evidenceDirectory,
						manifest,
						runtime,
						{
							key: `${prefix}-${name}`,
							agent,
							targetTokens,
							timeoutMs: manifest.options.timeoutMs,
							...specification,
						},
						save,
					);
				const baseline = await run("cold-prefix-baseline");
				const parent = await run("parent-create", {
					contextTokens: Math.max(1_000, targetTokens - (baseline.native?.requests[0]?.inputTokens ?? 16_000)),
				});
				if (!operationIsComplete(parent)) continue;
				const hot = await run("parent-hot-before", { sessionId: parent.sessionId });
				if (!operationIsComplete(hot)) continue;
				const frozenParentSha256 = hot.parentFrozenSha256 ?? sha256(readText(hot.nativeTranscriptPath));
				hot.parentFrozenSha256 = frozenParentSha256;
				save();
				const forks = [];
				for (let index = 1; index <= manifest.options.forkCount; index++) {
					let sessionId;
					if (agent === "kimi") {
						const created = await run(`fork-${index}-create`, {
							kind: "fork-create",
							parentSessionId: parent.sessionId,
							parentTranscriptPath: hot.nativeTranscriptPath,
							frozenParentSha256,
						});
						if (!operationIsComplete(created)) continue;
						sessionId = created.sessionId;
					}
					forks.push(
						await run(`fork-${index}-first`, {
							kind: "fork-first",
							parentSessionId: parent.sessionId,
							sessionId,
							parentTranscriptPath: hot.nativeTranscriptPath,
							frozenParentSha256,
						}),
					);
				}
				if (operationIsComplete(forks[0])) await run("fork-1-second", { sessionId: forks[0].sessionId });
				await run("parent-hot-after", { sessionId: parent.sessionId });
				writeReports(evidenceDirectory, manifest);
			}
		}
		const results = writeReports(evidenceDirectory, manifest);
		console.log(`中文报告：${join(evidenceDirectory, "report.zh-CN.md")}`);
		if (interrupted) process.exitCode = 130;
		else if (
			results.some((item) => item.forks.some((fork) => fork.status !== "measured")) ||
			!nativeLiveMeasurementMatrixIsComplete(manifest)
		)
			process.exitCode = 2;
	} finally {
		if (manifest) {
			save();
			writeReports(evidenceDirectory, manifest);
		}
		await release();
	}
}

if (
	process.argv[1] &&
	isAbsolute(resolve(process.argv[1])) &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	main().catch((error) => {
		console.error(`缓存复测未完成：${error.message}`);
		process.exitCode = 1;
	});
}
