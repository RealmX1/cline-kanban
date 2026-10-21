import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { CODEX_CLI_OPTIONS_WITH_VALUES } from "../terminal/codex-hook-config";

// 子命令定位与恢复参数分流必须跳过同一组原生选项值，避免把值误当成会话选择。
const CODEX_REMOTE_CONVERSATION_LAUNCH_OPTIONS_WITH_VALUES = new Set([
	...CODEX_CLI_OPTIONS_WITH_VALUES,
	"-c",
	"--config",
	"--remote-auth-token-env",
	"--local-provider",
]);

export const codexNativeApprovalPolicySchema = z.union([
	z.enum(["never", "on-request", "untrusted", "on-failure"]),
	z.object({ granular: z.record(z.string(), z.boolean()) }),
]);
export const codexNativeSandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);

export const codexRemoteConversationLaunchPlanSchema = z.object({
	operation: z.enum(["resume", "fork"]),
	sourceNativeSessionId: z.string().min(1).optional(),
	selectsLatestConversation: z.boolean(),
	includeNonInteractiveConversations: z.boolean(),
	selectsAcrossWorkingDirectories: z.boolean(),
	workingDirectoryPath: z.string(),
	tuiArgumentsWithoutSessionSelection: z.array(z.string()),
	startupPromptArguments: z.array(z.string()),
	appServerRootArguments: z.array(z.string()),
	additionalWritableDirectoryPaths: z.array(z.string()),
	nativeThreadRequestOverrides: z.object({
		approvalPolicy: codexNativeApprovalPolicySchema.optional(),
		approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
		sandbox: codexNativeSandboxModeSchema.optional(),
		model: z.string().optional(),
		config: z.record(z.string(), z.unknown()).optional(),
	}),
});
export type CodexRemoteConversationLaunchPlan = z.infer<typeof codexRemoteConversationLaunchPlanSchema>;

function readConfigOverride(argument: string) {
	const equals = argument.indexOf("=");
	if (equals < 1) throw new Error("Codex 配置覆盖缺少键或等号。");
	const key = argument.slice(0, equals).trim();
	const rawValue = argument.slice(equals + 1);
	let value: unknown;
	try {
		value = parseToml(`value = ${rawValue}`).value;
	} catch {
		// 原生 CLI 对非 TOML 值也按原始字符串处理。
		value = rawValue;
	}
	return { key, value };
}

function isPermissionConfigurationKey(key: string) {
	return ["approval_policy", "approvals_reviewer", "sandbox_mode", "sandbox_workspace_write", "permissions"].some(
		(prefix) => key === prefix || key.startsWith(`${prefix}.`),
	);
}

function findConversationSubcommandIndex(arguments_: readonly string[]) {
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--") return -1;
		if (CODEX_REMOTE_CONVERSATION_LAUNCH_OPTIONS_WITH_VALUES.has(argument)) {
			index += 1;
		} else if (!argument.startsWith("-")) {
			return argument === "resume" || argument === "fork" ? index : -1;
		}
	}
	return -1;
}

// 只分流受管宿主的恢复/fork；新建及显式宿主旁路继续由原生 CLI 消费完整 argv。
export function prepareCodexRemoteConversationLaunchPlan(
	arguments_: readonly string[],
	workingDirectoryPath: string,
): CodexRemoteConversationLaunchPlan | null {
	const subcommandIndex = findConversationSubcommandIndex(arguments_);
	if (subcommandIndex < 0) return null;
	const operation = z.enum(["resume", "fork"]).parse(arguments_[subcommandIndex]);
	const remaining: string[] = [];
	const serverArguments: string[] = [];
	const positionalArguments: string[] = [];
	const config: Record<string, unknown> = {};
	const overrides: CodexRemoteConversationLaunchPlan["nativeThreadRequestOverrides"] = {};
	const configuredPermissions: CodexRemoteConversationLaunchPlan["nativeThreadRequestOverrides"] = {};
	const writableDirectories: string[] = [];
	let selectsLatestConversation = false;
	let includeNonInteractiveConversations = false;
	let selectsAcrossWorkingDirectories = false;
	let bypassRequested = false;
	let positionalArgumentsUseTerminator = false;
	let onlyPositionalArgumentsRemain = false;
	let executionDirectory = workingDirectoryPath;
	for (let index = 0; index < arguments_.length; index += 1) {
		if (index === subcommandIndex) continue;
		const argument = arguments_[index];
		if (argument === "--" && !onlyPositionalArgumentsRemain) {
			onlyPositionalArgumentsRemain = true;
			positionalArgumentsUseTerminator = true;
			continue;
		}
		if (onlyPositionalArgumentsRemain || !argument.startsWith("-")) {
			positionalArguments.push(argument);
			continue;
		}
		if (argument === "--last") {
			selectsLatestConversation = true;
			continue;
		}
		if (argument === "--all") {
			selectsAcrossWorkingDirectories = true;
			continue;
		}
		if (argument === "--include-non-interactive") {
			includeNonInteractiveConversations = true;
			continue;
		}
		if (argument === "--dangerously-bypass-approvals-and-sandbox") {
			bypassRequested = true;
			continue;
		}
		if (argument === "--approve-for-me" || argument === "--full-auto") {
			overrides.approvalPolicy = "on-request";
			overrides.sandbox = "workspace-write";
			if (argument === "--approve-for-me") overrides.approvalsReviewer = "auto_review";
			continue;
		}
		const equalsIndex = argument.startsWith("--") ? argument.indexOf("=") : -1;
		const attachedShortOption = ["-c", "-s", "-a", "-m", "-C"].find(
			(option) => argument.startsWith(option) && argument.length > option.length,
		);
		const option = attachedShortOption ?? (equalsIndex > 0 ? argument.slice(0, equalsIndex) : argument);
		const hasValue = CODEX_REMOTE_CONVERSATION_LAUNCH_OPTIONS_WITH_VALUES.has(option);
		if (!hasValue) {
			remaining.push(argument);
			if (argument === "--strict-config") serverArguments.push(argument);
			continue;
		}
		const value = attachedShortOption
			? argument.slice(attachedShortOption.length).replace(/^=/u, "")
			: equalsIndex > 0
				? argument.slice(equalsIndex + 1)
				: arguments_[++index];
		if (value === undefined) throw new Error(`Codex ${option} 缺少值。`);
		const originalOptionArguments = attachedShortOption || equalsIndex > 0 ? [argument] : [argument, value];
		if (option === "-c" || option === "--config") {
			const entry = readConfigOverride(value);
			if (entry.key === "approval_policy") {
				const approvalPolicy = codexNativeApprovalPolicySchema.parse(entry.value);
				// 原生配置层将旧值规范为 on-request，当前 RPC 不接受 on-failure。
				configuredPermissions.approvalPolicy = approvalPolicy === "on-failure" ? "on-request" : approvalPolicy;
			} else if (entry.key === "sandbox_mode")
				configuredPermissions.sandbox = codexNativeSandboxModeSchema.parse(entry.value);
			else if (entry.key === "approvals_reviewer") {
				const approvalsReviewer = z.enum(["user", "auto_review", "guardian_subagent"]).parse(entry.value);
				// 与原生配置读取一致，RPC 与后续有效权限核对都使用规范值。
				configuredPermissions.approvalsReviewer =
					approvalsReviewer === "guardian_subagent" ? "auto_review" : approvalsReviewer;
			} else config[entry.key] = entry.value;
			if (!isPermissionConfigurationKey(entry.key)) {
				remaining.push(...originalOptionArguments);
				serverArguments.push(...originalOptionArguments);
			}
		} else if (option === "--ask-for-approval" || option === "-a") {
			overrides.approvalPolicy = codexNativeApprovalPolicySchema.parse(value);
		} else if (option === "--sandbox" || option === "-s") {
			overrides.sandbox = codexNativeSandboxModeSchema.parse(value);
		} else if (option === "--add-dir") {
			writableDirectories.push(value);
		} else {
			remaining.push(...originalOptionArguments);
			if (option === "--model" || option === "-m") overrides.model = value;
			if (option === "--cd" || option === "-C") executionDirectory = resolve(workingDirectoryPath, value);
			if (option === "--enable" || option === "--disable") serverArguments.push(...originalOptionArguments);
		}
	}
	if (bypassRequested) {
		overrides.approvalPolicy = "never";
		overrides.sandbox = "danger-full-access";
	}
	if (Object.keys(config).length) overrides.config = config;
	const sourceNativeSessionId = selectsLatestConversation ? undefined : positionalArguments.shift();
	if (!selectsLatestConversation && !sourceNativeSessionId) throw new Error("Codex 恢复缺少原生会话 ID 或 --last。");
	if (positionalArguments.length > 1) throw new Error("Codex 恢复包含不明确的位置参数，未选择其它会话。");
	return {
		operation,
		sourceNativeSessionId,
		selectsLatestConversation,
		includeNonInteractiveConversations,
		selectsAcrossWorkingDirectories,
		workingDirectoryPath: executionDirectory,
		tuiArgumentsWithoutSessionSelection: remaining,
		startupPromptArguments:
			positionalArguments.length && positionalArgumentsUseTerminator
				? ["--", ...positionalArguments]
				: positionalArguments,
		appServerRootArguments: serverArguments,
		additionalWritableDirectoryPaths: writableDirectories.map((path) => resolve(executionDirectory, path)),
		// 原生专用旗标优先于配置覆盖，不随 argv 中二者的先后顺序改变。
		nativeThreadRequestOverrides: { ...configuredPermissions, ...overrides },
	};
}

export function buildCodexRemoteConversationResumeTuiArguments(
	plan: CodexRemoteConversationLaunchPlan,
	nativeSessionId: string,
) {
	return [...plan.tuiArgumentsWithoutSessionSelection, "resume", nativeSessionId, ...plan.startupPromptArguments];
}
