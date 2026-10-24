import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { RuntimeHookEvent } from "../core/api-contract";
import { buildKanbanAgentHookCommandParts } from "../core/kanban-command";
import { quoteShellArg } from "../core/shell";

// codex 在该秒数后回收 hook 进程，即 codex 路径单条 hook 的总时间预算。F2 给 `kanban hooks ingest`
// 加了有界重试（最坏 HOOK_INGEST_MAX_ATTEMPTS × KANBAN_HOOK_INGEST_TIMEOUT_MS + backoff ≈ 7.25s），
// 故从 5s 抬到 8s，让重试窗口完整落在 codex 回收之前、不被 codex 先杀进程而把丢投截断成静默。
// 正常路径 F1 后亚秒返回，这个上限极少触达。
const CODEX_HOOK_TIMEOUT_SECONDS = 8;

type CodexHookConfigEvent =
	| "SessionStart"
	| "PermissionRequest"
	| "PreCompact"
	| "PostCompact"
	| "PostToolUse"
	| "PreToolUse"
	| "Stop"
	| "UserPromptSubmit";

type JsonValue = JsonPrimitive | JsonArray | JsonObject;
type JsonPrimitive = boolean | null | number | string;
type JsonArray = JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}

interface CodexHookConfig {
	eventName: CodexHookConfigEvent;
	matcher?: string;
	command: string;
}

interface CodexHookTrustEntry {
	key: string;
	trustedHash: string;
}

export function hasCodexConfigOverride(args: string[], key: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-c" || arg === "--config") {
			const next = args[i + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				return true;
			}
			i += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`) || arg.startsWith(`--config=${key}=`)) {
			return true;
		}
	}
	return false;
}

export const CODEX_CLI_OPTIONS_WITH_VALUES = new Set([
	"--model",
	"-m",
	"--profile",
	"-p",
	"--cd",
	"-C",
	"--sandbox",
	"-s",
	"--ask-for-approval",
	"-a",
	"--image",
	"-i",
	"--enable",
	"--disable",
	"--add-dir",
]);

// Codex 的根命令与 resume/fork 同时收到 -c 时会丢根配置。先收集所有覆盖项，再整体放到根参数区。
// 在 adapter 追加位置 prompt 之前调用；-- 之后的字节属于用户参数，不再解析。
export function normalizeCodexConfigOverridesBeforeSubcommand(args: string[]): void {
	const overrides: string[] = [];
	const remaining: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			remaining.push(...args.slice(index));
			break;
		}
		if (argument === "-c" || argument === "--config") {
			const value = args[++index];
			if (value === undefined) throw new Error(`Missing value for Codex ${argument}.`);
			overrides.push(argument, value);
		} else if (argument.startsWith("--config=") || (argument.startsWith("-c") && argument.length > 2)) {
			overrides.push(argument);
		} else {
			remaining.push(argument);
			if (CODEX_CLI_OPTIONS_WITH_VALUES.has(argument) && index + 1 < args.length) remaining.push(args[++index]);
		}
	}
	args.splice(0, args.length, ...overrides, ...remaining);
}

function addCodexConfigOverrideBeforeSubcommand(args: string[], key: string, value: string): void {
	if (hasCodexConfigOverride(args, key)) {
		return;
	}
	args.unshift("-c", `${key}=${value}`);
}

function buildCodexHookCommand(event: RuntimeHookEvent): string {
	return buildKanbanAgentHookCommandParts(["codex-hook", "--event", event, "--source", "codex"])
		.map(quoteShellArg)
		.join(" ");
}

function buildCodexHookConfigValue(command: string, matcher?: string): string {
	const matcherConfig = matcher ? `matcher=${JSON.stringify(matcher)},` : "";
	const commandConfig = JSON.stringify(command);
	return `[{${matcherConfig}hooks=[{type="command",command=${commandConfig},timeout=${CODEX_HOOK_TIMEOUT_SECONDS}}]}]`;
}

function codexSessionFlagsConfigSource(): string {
	return process.platform === "win32" ? String.raw`C:\<session-flags>\config.toml` : "/<session-flags>/config.toml";
}

function codexHookEventKeyLabel(eventName: CodexHookConfigEvent): string {
	switch (eventName) {
		case "SessionStart":
			return "session_start";
		case "PermissionRequest":
			return "permission_request";
		// 与 Codex 0.160.0 二进制里的事件标签一致（strings 实测：pre_compact / post_compact）；标签错了
		// 信任哈希就对不上，Codex 会弹 hooks 审批对话框并吞掉终端输入。
		case "PostCompact":
			return "post_compact";
		case "PreCompact":
			return "pre_compact";
		case "PostToolUse":
			return "post_tool_use";
		case "PreToolUse":
			return "pre_tool_use";
		case "Stop":
			return "stop";
		case "UserPromptSubmit":
			return "user_prompt_submit";
	}
}

function canonicalizeJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(canonicalizeJson);
	}
	if (value !== null && typeof value === "object") {
		const sorted: JsonObject = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = canonicalizeJson(value[key]);
		}
		return sorted;
	}
	return value;
}

function versionForCodexHookIdentity(value: JsonObject): string {
	const canonical = canonicalizeJson(value);
	const serialized = JSON.stringify(canonical);
	const hash = createHash("sha256").update(serialized).digest("hex");
	return `sha256:${hash}`;
}

function buildCodexHookTrustEntry(config: CodexHookConfig): CodexHookTrustEntry {
	const handler: JsonObject = {
		async: false,
		command: config.command,
		timeout: CODEX_HOOK_TIMEOUT_SECONDS,
		type: "command",
	};
	const group: JsonObject = {
		hooks: [handler],
	};
	if (config.matcher !== undefined) {
		group.matcher = config.matcher;
	}
	const eventKeyLabel = codexHookEventKeyLabel(config.eventName);
	const identity: JsonObject = {
		event_name: eventKeyLabel,
		...group,
	};
	return {
		key: `${codexSessionFlagsConfigSource()}:${eventKeyLabel}:0:0`,
		trustedHash: versionForCodexHookIdentity(identity),
	};
}

function buildCodexHookTrustStateConfigValue(entries: CodexHookTrustEntry[]): string {
	const states = entries.map(
		(entry) => `${JSON.stringify(entry.key)}={trusted_hash=${JSON.stringify(entry.trustedHash)}}`,
	);
	return `{${states.join(",")}}`;
}

const readCodexVersion = promisify(execFile);
const verifiedCompactionHookCapabilityByBinary = new Map<string, Promise<boolean>>();

// 仅对真实隔离探针验收过的版本配置开始 hook。未知/旧版本保留原启动与 15 秒策略。
// EXPERIMENT_NODE: 新版本须先重跑原生压缩探针，再扩展已验收版本集合，不能仅按版本号大小猜测。
export async function supportsVerifiedCodexAutomaticCompactionPhaseHooks(
	binary: string,
	environment: NodeJS.ProcessEnv,
): Promise<boolean> {
	let executableIdentity: string | null = null;
	for (const candidate of isAbsolute(binary)
		? [binary]
		: (environment.PATH ?? "").split(delimiter).map((directory) => join(directory, binary))) {
		try {
			const path = await realpath(candidate);
			const metadata = await stat(path);
			executableIdentity = JSON.stringify([path, metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs]);
			break;
		} catch {
			/* 不支持或不可定位的二进制不配置新事件。 */
		}
	}
	if (!executableIdentity) return false;
	const key = executableIdentity;
	let probe = verifiedCompactionHookCapabilityByBinary.get(key);
	if (!probe) {
		probe = readCodexVersion(binary, ["--version"], { env: environment, timeout: 3_000, maxBuffer: 4_096 })
			.then(({ stdout }) => stdout.trim() === "codex-cli 0.164.0")
			.catch(() => false);
		verifiedCompactionHookCapabilityByBinary.set(key, probe);
		void probe.then((supported) => {
			if (!supported) verifiedCompactionHookCapabilityByBinary.delete(key);
		});
	}
	return probe;
}

export function configureCodexHooks(args: string[], enableVerifiedAutomaticCompactionPhaseHooks = false): boolean {
	const enablesCompactionPhaseHooks =
		enableVerifiedAutomaticCompactionPhaseHooks &&
		!hasCodexConfigOverride(args, "hooks.state") &&
		!hasCodexConfigOverride(args, "hooks.PreCompact") &&
		!hasCodexConfigOverride(args, "hooks.PostCompact");
	const inProgressHook: CodexHookConfig = {
		eventName: "UserPromptSubmit",
		command: buildCodexHookCommand("to_in_progress"),
	};
	const reviewHook: CodexHookConfig = {
		eventName: "Stop",
		command: buildCodexHookCommand("to_review"),
	};
	const permissionRequestHook: CodexHookConfig = {
		eventName: "PermissionRequest",
		command: buildCodexHookCommand("to_review"),
		matcher: "*",
	};
	const preToolUseActivityHook: CodexHookConfig = {
		eventName: "PreToolUse",
		command: buildCodexHookCommand("activity"),
		matcher: "*",
	};
	const postToolUseActivityHook: CodexHookConfig = {
		eventName: "PostToolUse",
		command: buildCodexHookCommand("activity"),
		matcher: "*",
	};
	const sessionStartHook: CodexHookConfig = {
		eventName: "SessionStart",
		command: buildCodexHookCommand("agent_conversation_session_identity_observed"),
	};
	// 压缩完成即时触发；刻意不用 SessionStart(source=compact)——Codex 要等到下一次模型请求前才触发它，
	// 晚一个回合（Codex hooks 文档原文）。
	const postCompactHook: CodexHookConfig = {
		eventName: "PostCompact",
		command: buildCodexHookCommand("main_agent_conversation_context_compaction_completed"),
	};
	const preCompactHook: CodexHookConfig = {
		eventName: "PreCompact",
		command: buildCodexHookCommand("main_agent_conversation_context_compaction_started"),
	};
	const trustStateConfigValue = buildCodexHookTrustStateConfigValue(
		[
			sessionStartHook,
			inProgressHook,
			reviewHook,
			permissionRequestHook,
			preToolUseActivityHook,
			postToolUseActivityHook,
			postCompactHook,
			...(enablesCompactionPhaseHooks ? [preCompactHook] : []),
		].map(buildCodexHookTrustEntry),
	);

	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.SessionStart",
		buildCodexHookConfigValue(sessionStartHook.command),
	);
	addCodexConfigOverrideBeforeSubcommand(args, "features.hooks", "true");
	addCodexConfigOverrideBeforeSubcommand(args, "hooks.state", trustStateConfigValue);
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.UserPromptSubmit",
		buildCodexHookConfigValue(inProgressHook.command),
	);
	addCodexConfigOverrideBeforeSubcommand(args, "hooks.Stop", buildCodexHookConfigValue(reviewHook.command));
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.PermissionRequest",
		buildCodexHookConfigValue(permissionRequestHook.command, permissionRequestHook.matcher),
	);
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.PreToolUse",
		buildCodexHookConfigValue(preToolUseActivityHook.command, preToolUseActivityHook.matcher),
	);
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.PostToolUse",
		buildCodexHookConfigValue(postToolUseActivityHook.command, postToolUseActivityHook.matcher),
	);
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.PostCompact",
		buildCodexHookConfigValue(postCompactHook.command),
	);
	if (enablesCompactionPhaseHooks)
		addCodexConfigOverrideBeforeSubcommand(
			args,
			"hooks.PreCompact",
			buildCodexHookConfigValue(preCompactHook.command),
		);
	return enablesCompactionPhaseHooks;
}
