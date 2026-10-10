import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isKanbanCursorAgentModelId } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeObservedAgentNativeConversationSessionResumeAddressing,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskConversationMode,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTerminalAgentModelOverrideSettings,
} from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { resolveOmpApprovalModeFlagValue } from "../core/omp-approval-mode-flag";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../core/session-activity";
import { quoteShellArg } from "../core/shell";
import { resolveTaskAgentPermissionModeForAgent } from "../core/task-agent-permission-mode";
import { logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	combineAppendSystemPrompts,
	resolveHomeAgentAppendSystemPrompt,
	resolveTaskSessionAppendSystemPrompt,
} from "../prompts/append-system-prompt";
import { resolveExploratoryModeAppendSystemPrompt } from "../prompts/exploratory-mode-append-system-prompt";
import { resolveInterWorkUnitRelationNeighborhoodSessionStartInjection } from "../prompts/inter-work-unit-relation-neighborhood-append-system-prompt";
import { getRuntimeHomePath } from "../state/workspace-state";
import { hasClaudeInteractivePrompt, hasClaudeStartupUiRendered } from "./claude-readiness";
import {
	CODEX_CLI_OPTIONS_WITH_VALUES,
	configureCodexHooks,
	hasCodexConfigOverride,
	normalizeCodexConfigOverridesBeforeSubcommand,
} from "./codex-hook-config";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import { isKanbanTaskWorktreeWorkingDirectoryPath } from "./kanban-task-worktree-working-directory-path";
import { seedKanbanManagedKimiCodeHome } from "./kimi-hook-config";
import { hasKimiInteractivePrompt } from "./kimi-readiness";
import { writeOmpNativeConversationSessionIdentityExtension } from "./omp-native-conversation-session-identity-extension";
import { detectOmpTerminalTitleStateTransition } from "./omp-terminal-title-state";
import { writeOmpTuiLaunchConfigOverlay } from "./omp-tui-launch-config";
import {
	getOpenCodeAuthPathCandidates,
	getOpenCodeConfigPathCandidates,
	getOpenCodeModelStatePathCandidates,
} from "./opencode-paths";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";
import { resolveCursorLaunchDefaultModelId } from "./terminal-agent-model-selection";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	// 每任务的放权档位。与 startInPlanMode **正交**：plan 起步只决定开局模式，不得在这里
	// 被翻译成「降权」——不能同时表达两者的 harness（droid）是显式例外，见
	// doesPlanModeStartOverridePermissionModeForAgent。
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	// 「续跑既有对话、不重投 prompt」，但**不**带垃圾桶语义（不清聊天、不按转录反查模型）。
	// 目前唯一的来源是通道切换后重开会话（omp 的 TUI ⇄ ACP）。语义上与 resumeFromTrash 的续跑
	// 部分一致，故 adapter 里两者一律并为同一条分支处理；只有 omp 需要认它——别的 agent 不可切换，
	// 到不了这条路径（可切换 agent 集合见 core/agent-session-transport-selection.ts）。
	resumePriorAgentConversationWithoutResendingPrompt?: boolean;
	// 启动通道声明的会话模式快照（蓝图 §A.1）。prepareAgentLaunch 据它物化 exploratory 指令文件、
	// 把渲染好的注入段写进下方 exploratoryModeAppendSystemPrompt——adapter 只消费渲染结果，自己不碰 IO。
	taskConversationMode?: RuntimeTaskConversationMode;
	// prepareAgentLaunch 解析好的 exploratory 注入段（非 exploratory / 物化失败 ⇒ null），
	// 由 resolveAgentAppendSystemPrompt 与 prependTaskSessionGuidanceToPrompt 两处组合点并入（§A.2）。
	exploratoryModeAppendSystemPrompt?: string | null;
	// prepareAgentLaunch 解析好的工作单元间关系邻域注入段（dd2db 1b；没有默认可见的关系 / 读不到 ⇒ null），
	// 与 exploratory 注入段走同样两处组合点。
	interWorkUnitRelationNeighborhoodAppendSystemPrompt?: string | null;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	parentSessionId?: string;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	// 「这条会话**自己**上一世的对话在哪」——由 session-manager 每次启动现算（解析器见
	// core/agent-conversation-session-resume-addressing.ts，唯一来源是 summary 上由 hook 落下的
	// `agentNativeConversationSessionIdentity`）。命中即按 id 续跑，压过下面所有 cwd-latest 分支。
	//
	// 与上面的 taskAgentSessionInitialization **契约分离，绝不可合并**：
	//   taskAgentSessionInitialization = 建卡时的**播种**（这张新卡从别人的某段历史会话长出来），一次性开局参数；
	//   本字段 = **重启寻址**（这条会话接回它自己的上一段对话），每次启动重新解析。
	// 合并的后果是从垃圾桶拖回来的任务会去续播种源的对话而不是它自己的——`resumeFromTrash` 与播种 id
	// 会被前端同时发出（web-ui/src/hooks/use-task-sessions.ts 的 trash 恢复），今天靠 resumeFromTrash
	// 压过播种才是对的，故本字段必须独立于播种轴另起一档。
	observedAgentNativeConversationSessionResumeAddressing?: RuntimeObservedAgentNativeConversationSessionResumeAddressing;
	// kanban 在 spawn 前为**全新开局**分配并已落盘的原生会话 id（目前只有 Cursor，见 agent-catalog 的
	// nativeConversationSessionIdentityCaptureMethod）。与上面的重启寻址同为「按 id」，但语义相反：这里是
	// 以新 id 开一段新对话、照常投 prompt，绝不能被当成续跑（不武装实质输出抑制、不省略 prompt）。
	kanbanAssignedAgentNativeConversationSessionIdForFreshStart?: string;
	readOnlyQuestionSession?: boolean;
	forkLatestWorkingDirectorySession?: boolean;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	// 待 TUI 就绪后提交的原始文本，不含粘贴框架或提交回车。
	deferredStartupPromptText?: string;
	// 本次启动是否会接续 / 重播一段既有的 agent 对话（`--continue` / `--resume <id>` / `--fork-session`
	// 等已被拼进 args）。session-manager 用它武装 resume substantive guard：重播出来的旧 transcript
	// 不是「agent 刚刚响应」，不得推进 lastSubstantiveOutputAt（卡片左上角的「agent 上次响应」读它）。
	// 必须由**决定是否加 resume 旗标的那段代码**如实置位——它是唯一知道真相的地方；用「该任务此前是否
	// 产出过」等外部状态反推会误判崩溃后从原始 prompt 全新重跑的 auto-restart（那种启动毫无重播）。
	// 只在 resumeFromTrash 时续跑的 adapter 可以不设本字段：那条触发器对全部 adapter 一致，
	// session-manager 已在武装点统一 OR 进去。本字段专门覆盖 resumeFromTrash 之外的续跑路径
	// （taskAgentSessionInitialization 的 --resume <id>、forkLatestWorkingDirectorySession 的 fork）。
	resumesPriorAgentConversation?: boolean;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
	// 只给把工作单元间关系邻域注入段写在 argv 之外（agent 配置文件）的 adapter 用（目前只有 kiro）：如实声明本次启动
	// 带上了这段文本。写进 argv / deferredStartupPromptText 的不用设，prepareAgentLaunch 在合流点直接查验。
	carriesInterWorkUnitRelationNeighborhoodAppendSystemPromptOutsideLaunchArgv?: boolean;
	// 本次启动确实带上了关系邻域注入段、且段里列出了断言型关系时才有（由 prepareAgentLaunch 在合流点填写，adapter 不设）。
	// session-manager 在 PTY spawn 成功、新会话装载之后调用一次，提交注入回执；准备或 spawn 失败绝不调用。
	// 后台记账、按幂等键去重、绝不抛错，不影响启动。
	commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded?: () => void;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function escapeForTemplateLiteral(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}

function powerShellQuote(value: string): string {
	return `"${value.replaceAll("`", "``").replaceAll('"', '`"')}"`;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

function buildHooksCommand(args: string[]): string {
	return buildHooksCommandParts(args).map(quoteShellArg).join(" ");
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

function removeCliOptionsWithValues(args: string[], optionNames: readonly string[]): string[] {
	const optionNameSet = new Set(optionNames);
	const nextArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (optionNameSet.has(arg)) {
			index += 1;
			continue;
		}
		if (optionNames.some((optionName) => arg.startsWith(`${optionName}=`))) {
			continue;
		}
		nextArgs.push(arg);
	}
	return nextArgs;
}

// 按各 CLI 的值参数边界保护字面值；恢复只移除选择器与会自动提交的新输入。
// Claude 的列表选项会吃到下一个旗标；Kimi 的 -p 是 prompt，OMP 的 -p 则只是 print 开关。
const NATIVE_SESSION_RESUME_VALUE_OPTIONS = {
	claude: new Set([
		"--agent",
		"--agents",
		"--append-system-prompt",
		"--append-system-prompt-file",
		"--autocompact",
		"--debug-file",
		"--effort",
		"--environment",
		"--fallback-model",
		"--input-format",
		"--json-schema",
		"--max-budget-usd",
		"--model",
		"--name",
		"-n",
		"--output-format",
		"--permission-mode",
		"--permission-prompts",
		"--permission-prompt-tool",
		"--plugin-dir",
		"--plugin-url",
		"--remote-control-session-name-prefix",
		"--setting-sources",
		"--settings",
		"--system-prompt",
		"--system-prompt-file",
		"--system-prompt-snapshot",
	]),
	kimi: new Set(["--model", "-m", "--output-format", "--skills-dir", "--agent", "--agent-file", "--add-dir"]),
	omp: new Set([
		"--model",
		"--smol",
		"--slow",
		"--plan",
		"--prewalk-into",
		"--plan-yolo-into",
		"--provider",
		"--api-key",
		"--system-prompt",
		"--append-system-prompt",
		"--profile",
		"--alias",
		"--cwd",
		"--mode",
		"--config",
		"--add-dir",
		"--session-dir",
		"--provider-session-id",
		"--prompt-cache-key",
		"--models",
		"--tools",
		"--thinking",
		"--service-tier",
		"--hook",
		"--extension",
		"-e",
		"--trusted-extension",
		"--skills",
		"--export",
		"--max-time",
		"--approval-mode",
		"--plugin-dir",
	]),
};
const CLAUDE_CLI_VARIADIC_VALUE_OPTIONS = new Set([
	"--add-dir",
	"--allowedTools",
	"--allowed-tools",
	"--disallowedTools",
	"--disallowed-tools",
	"--betas",
	"--file",
	"--mcp-config",
	"--tools",
]);
const CLAUDE_CLI_OPTIONAL_VALUE_OPTIONS = new Set([
	"--debug",
	"-d",
	"--prompt-suggestions",
	"--remote-control",
	"--worktree",
	"-w",
]);

// 未识别的裸选项可能吞掉下一个旗标；只接受无歧义的等号写法，绝不猜测或静默删值。
const NATIVE_SESSION_RESUME_BOOLEAN_OPTIONS = {
	claude: new Set([
		"--allow-dangerously-skip-permissions",
		"--ax-screen-reader",
		"--bg",
		"--background",
		"--bare",
		"--brief",
		"--chrome",
		"--dangerously-skip-permissions",
		"--disable-slash-commands",
		"--exclude-dynamic-system-prompt-sections",
		"--forward-subagent-text",
		"--help",
		"-h",
		"--ide",
		"--include-hook-events",
		"--include-partial-messages",
		"--no-chrome",
		"--no-session-persistence",
		"--print",
		"-p",
		"--replay-user-messages",
		"--restricted",
		"--safe-mode",
		"--strict-mcp-config",
		"--tmux",
		"--verbose",
		"--version",
		"-v",
	]),
	kimi: new Set(["--version", "-V", "--yolo", "-y", "--auto", "--help", "-h"]),
	omp: new Set([
		"--prewalk",
		"--no-prewalk",
		"--allow-home",
		"--print",
		"-p",
		"--no-session",
		"--no-tools",
		"--no-lsp",
		"--no-pty",
		"--hide-thinking",
		"--advisor",
		"--external-thinking",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-title",
		"--print-thoughts",
		"--auto-approve",
		"--help",
		"-h",
		"--version",
		"-v",
	]),
	codex: new Set([
		"--include-non-interactive",
		"--strict-config",
		"--oss",
		"--approve-for-me",
		"--full-auto",
		"--dangerously-bypass-approvals-and-sandbox",
		"--dangerously-bypass-hook-trust",
		"--worktree",
		"--search",
		"--no-alt-screen",
		"--no-daemon",
		"--help",
		"-h",
		"--version",
		"-V",
	]),
};

function assertNativeSessionResumeOptionHasUnambiguousValue(
	args: string[],
	index: number,
	agentId: keyof typeof NATIVE_SESSION_RESUME_BOOLEAN_OPTIONS,
	valueOptions: ReadonlySet<string>,
): void {
	const argument = args[index];
	const optionName = argument.split("=", 1)[0];
	const hasAttachedShortValue = [...valueOptions].some(
		(option) => option.length === 2 && argument.startsWith(option) && argument.length > 2,
	);
	if (
		(!argument.includes("=") || (args[index + 1] !== undefined && !args[index + 1].startsWith("-"))) &&
		!NATIVE_SESSION_RESUME_BOOLEAN_OPTIONS[agentId].has(optionName) &&
		!valueOptions.has(optionName) &&
		!hasAttachedShortValue
	) {
		throw new Error(`Cannot safely resume ${agentId}: unrecognized option ${optionName} has an ambiguous value.`);
	}
}

function removeNativeSessionSelectionArguments(
	args: string[],
	agentId: "claude" | "kimi" | "omp",
	selectors: readonly string[],
): string[] {
	const remaining: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			throw new Error("Remove the -- argument separator before resuming a recorded session.");
		}
		if (NATIVE_SESSION_RESUME_VALUE_OPTIONS[agentId].has(argument)) {
			remaining.push(argument);
			if (index + 1 < args.length) remaining.push(args[++index]);
		} else if (agentId === "claude" && CLAUDE_CLI_VARIADIC_VALUE_OPTIONS.has(argument.split("=", 1)[0])) {
			remaining.push(argument);
			while (index + 1 < args.length && !args[index + 1].startsWith("-")) remaining.push(args[++index]);
		} else if (agentId === "claude" && CLAUDE_CLI_OPTIONAL_VALUE_OPTIONS.has(argument)) {
			remaining.push(argument);
			if (index + 1 < args.length && !args[index + 1].startsWith("-")) remaining.push(args[++index]);
		} else if (agentId === "kimi" && (argument === "--prompt" || argument === "-p")) {
			index += 1;
		} else if (selectors.includes(argument)) {
			if (args[index + 1] && !args[index + 1].startsWith("-")) index += 1;
		} else if (
			argument.startsWith("-") &&
			argument !== "-" &&
			![
				"--continue",
				"-c",
				...(agentId === "claude" ? ["--fork-session"] : []),
				...(agentId === "omp" ? ["--from-claude", "--from-codex", "--plan-yolo"] : []),
			].includes(argument) &&
			!selectors.some(
				(selector) =>
					argument.startsWith(`${selector}=`) ||
					(selector.length === 2 && argument.startsWith(selector) && agentId !== "omp"),
			) &&
			!(
				agentId === "kimi" &&
				(argument === "--plan" || argument.startsWith("--prompt=") || argument.startsWith("-p"))
			)
		) {
			assertNativeSessionResumeOptionHasUnambiguousValue(
				args,
				index,
				agentId,
				agentId === "claude"
					? new Set([...NATIVE_SESSION_RESUME_VALUE_OPTIONS.claude, ...CLAUDE_CLI_OPTIONAL_VALUE_OPTIONS])
					: NATIVE_SESSION_RESUME_VALUE_OPTIONS[agentId],
			);
			remaining.push(argument);
		}
	}
	return remaining;
}

function applyObservedCodexNativeSessionResumeArguments(args: string[], nativeSessionId: string): void {
	const remaining: string[] = [];
	let hasSessionSubcommand = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--")
			throw new Error("Remove the Codex -- argument separator before resuming a recorded session.");
		if (
			argument === "-c" ||
			argument === "--config" ||
			CODEX_CLI_OPTIONS_WITH_VALUES.has(argument) ||
			["--remote", "--remote-auth-token-env", "--local-provider"].includes(argument)
		) {
			remaining.push(argument);
			if (index + 1 < args.length) remaining.push(args[++index]);
		} else if (!hasSessionSubcommand && (argument === "resume" || argument === "fork")) {
			remaining.push("resume", nativeSessionId);
			hasSessionSubcommand = true;
		} else if (argument.startsWith("-") && argument !== "-" && argument !== "--last" && argument !== "--all") {
			assertNativeSessionResumeOptionHasUnambiguousValue(
				args,
				index,
				"codex",
				new Set([
					...CODEX_CLI_OPTIONS_WITH_VALUES,
					"-c",
					"--config",
					"--remote",
					"--remote-auth-token-env",
					"--local-provider",
				]),
			);
			remaining.push(argument);
		}
		// 其余位置参数是旧 session ID 或开局 prompt，绑定恢复均不得重放。
	}
	if (!hasSessionSubcommand) remaining.push("resume", nativeSessionId);
	args.splice(0, args.length, ...remaining);
}

function setModelCliOption(args: string[], modelId: string): string[] {
	const trimmedModelId = modelId.trim();
	if (!trimmedModelId) {
		return [...args];
	}
	return [...removeCliOptionsWithValues(args, ["--model", "-m"]), "--model", trimmedModelId];
}

function resolveTerminalAgentModelOverride(
	input: AgentAdapterLaunchInput,
	agentId: RuntimeTaskTerminalAgentModelOverrideSettings["agentId"],
): string | null {
	if (input.terminalAgentModelOverrideSettings?.agentId !== agentId) {
		return null;
	}
	const modelId = input.terminalAgentModelOverrideSettings.modelId.trim();
	if (agentId === "cursor" && !isKanbanCursorAgentModelId(modelId)) {
		return null;
	}
	return modelId || null;
}

function hasCodexWorkingDirectoryOverride(args: string[]): boolean {
	return args.some((arg) => arg.startsWith("-C")) || hasCliOption(args, "--cd");
}

// Codex 0.156 起默认把 --last 扩展到同仓库所有 worktree；Kanban 的隐式续跑必须留在任务目录。
// 只作用于 cwd-latest：显式会话 ID 的跨目录播种 / fork 保留原生行为。
async function constrainCodexLatestSessionToTaskWorkingDirectory(args: string[], cwd: string): Promise<void> {
	const taskDirectory = await realpath(cwd).catch(() => resolve(cwd));
	const conflict = (option: string): never => {
		throw new Error(
			`Cannot select the latest conversation in this task directory with ${option}. ` +
				"Remove the conflicting Codex argument or select an explicit conversation ID.",
		);
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const optionIndex = index;
		if (arg === "--" || hasCliOption([arg], "--all")) conflict(arg);
		let directory: string | undefined;
		if (arg === "-C" || arg === "--cd") directory = args[++index] ?? conflict(arg);
		else if (arg.startsWith("--cd=")) directory = arg.slice(5);
		else if (arg.startsWith("-C")) directory = arg.slice(2).replace(/^=/, "");
		if (directory !== undefined) {
			if (!directory) conflict(arg);
			const resolvedDirectory = resolve(cwd, directory);
			if ((await realpath(resolvedDirectory).catch(() => resolvedDirectory)) !== taskDirectory) conflict(arg);
			args.splice(optionIndex, index - optionIndex + 1);
			index = optionIndex - 1;
			continue;
		}
		let config: string | undefined;
		if (arg === "-c" || arg === "--config") config = args[++index] ?? conflict(arg);
		else if (arg.startsWith("--config=")) config = arg.slice(9);
		else if (arg.startsWith("-c")) config = arg.slice(2).replace(/^=/, "");
		if (config !== undefined) {
			const separator = config.indexOf("=");
			const key = config.slice(0, separator).replace(/["'\s]/g, "");
			const value = config.slice(separator + 1).trim();
			if (key === "features" || (key === "features.worktrees" && value !== "false")) conflict(arg);
			continue;
		}
		if (arg === "--enable" || arg.startsWith("--enable=")) {
			const features = arg === "--enable" ? (args[++index] ?? "") : arg.slice(9);
			if (features.split(",").some((feature) => feature.trim() === "worktrees")) conflict(arg);
		}
	}
	// -C 固定执行目录；所有配置最终归一到根命令层，同时保留目录隔离和生命周期 hooks。
	// EXPERIMENT_NODE: 若原生目录选择再次漂移，再评估由 Kanban 枚举校验会话并固定 ID，见目录隔离 runbook。
	args.unshift("-C", cwd);
	args.push("-c", "features.worktrees=false");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeParentSessionId(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (!UUID_PATTERN.test(trimmed)) {
		process.stderr.write(
			`kanban: parent_session_id "${trimmed}" is not a UUID; codex fork expects a session UUID. Ignoring.\n`,
		);
		return null;
	}
	return trimmed;
}

function warnUnsupportedParentSessionId(agentId: RuntimeAgentId, parentSessionId: string | undefined): void {
	if (!parentSessionId || !parentSessionId.trim()) {
		return;
	}
	process.stderr.write(
		`kanban: agent "${agentId}" does not support parent_session_id; ignoring "${parentSessionId.trim()}".\n`,
	);
}

function getClineHookScriptPath(
	hooksDir: string,
	hookName: "Notification" | "TaskComplete" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse",
): string {
	if (process.platform === "win32") {
		return join(hooksDir, `${hookName}.ps1`);
	}
	return join(hooksDir, hookName);
}

function buildClineHookScriptContent(event: RuntimeHookEvent): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", event, "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
try {
  $inputText | & ${command} | Out-Null
} catch {
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
echo '{"cancel":false}'
`;
}

function buildClineNotificationHookScriptContent(): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
if (
  $inputText -match '"event"\\s*:\\s*"user_attention"' -and
  $inputText -notmatch '"source"\\s*:\\s*"completion_result"'
) {
  try {
    $inputText | & ${command} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
if printf '%s' "$INPUT" | grep -Eq '"event"[[:space:]]*:[[:space:]]*"user_attention"' &&
  ! printf '%s' "$INPUT" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"completion_result"'; then
  printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePreToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const reviewCommand = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const review = reviewCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${review} | Out-Null
  } catch {
  }
} else {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const review = reviewCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${review} >/dev/null 2>&1 || true
else
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePostToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildOpenCodePluginContent(
	reviewCommand: string,
	toInProgressCommand: string,
	activityCommand: string,
): string {
	const reviewCmd = escapeForTemplateLiteral(reviewCommand);
	const toInProgressCmd = escapeForTemplateLiteral(toInProgressCommand);
	const activityCmd = escapeForTemplateLiteral(activityCommand);
	return `export const KanbanPlugin = async ({ $, client }) => {
  if (globalThis.__kanbanOpencodePluginV3) return {};
  globalThis.__kanbanOpencodePluginV3 = true;

  if (!process?.env?.KANBAN_HOOK_TASK_ID) return {};

  let currentState = "idle";
  let rootSessionID = null;
  const childSessionCache = new Map();
  const messageRoleByID = new Map();
  const assistantTextByMessageID = new Map();
  const latestAssistantBySessionID = new Map();
  const toolInputByCallID = new Map();

  const asRecord = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value;
  };

  const getMessageKey = (sessionID, messageID) => String(sessionID) + ":" + String(messageID);
  const getToolCallKey = (sessionID, callID) => String(sessionID) + ":" + String(callID);

  const encodePayload = (payload) => {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    try {
      return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    } catch {
      return "";
    }
  };

	const notify = async (kind, payload) => {
		try {
			const encoded = encodePayload(payload);
			if (kind === "review") {
				if (encoded) {
					await $\`${reviewCmd} --metadata-base64 \${encoded}\`;
				} else {
					await $\`${reviewCmd}\`;
				}
				return;
			}
			if (kind === "in_progress") {
				if (encoded) {
					await $\`${toInProgressCmd} --metadata-base64 \${encoded}\`;
				} else {
					await $\`${toInProgressCmd}\`;
				}
				return;
			}
			if (encoded) {
				await $\`${activityCmd} --metadata-base64 \${encoded}\`;
			} else {
				await $\`${activityCmd}\`;
			}
		} catch {
			// Best effort: hook errors should never break OpenCode event handling.
		}
	};

  const notifyReview = async (sessionID, payload = {}) => {
    const mergedPayload = {
      ...payload,
      last_assistant_message:
        typeof payload.last_assistant_message === "string"
          ? payload.last_assistant_message
          : (latestAssistantBySessionID.get(sessionID) ?? undefined),
    };
		await notify("review", mergedPayload);
  };

  const notifyInProgress = async (payload = {}) => {
		await notify("in_progress", payload);
  };

  const notifyActivity = async (payload = {}) => {
		await notify("activity", payload);
  };

  const isChildSession = async (sessionID) => {
    if (!sessionID) return true;
    if (!client?.session?.list) return true;
    if (childSessionCache.has(sessionID)) {
      return childSessionCache.get(sessionID);
    }
    try {
      const sessions = await client.session.list();
      const session = sessions.data?.find((candidate) => candidate.id === sessionID);
      const isChild = !!session?.parentID;
      childSessionCache.set(sessionID, isChild);
      return isChild;
    } catch {
      return true;
    }
  };

  const handleBusy = async (sessionID) => {
    if (!sessionID) {
      return;
    }
    if (!rootSessionID) {
      rootSessionID = sessionID;
    }
    if (sessionID !== rootSessionID) {
      return;
    }
    if (currentState === "idle") {
      currentState = "busy";
      await notifyInProgress({
        hook_event_name: "session.status",
      });
    }
  };

  const handleReview = async (sessionID, payload = {}, force = false) => {
    if (!sessionID) {
      return;
    }
    if (!rootSessionID) {
      rootSessionID = sessionID;
    }
    if (rootSessionID && sessionID !== rootSessionID) {
      return;
    }

    const shouldNotify = force || currentState === "busy";
    if (shouldNotify) {
      currentState = "idle";
      await notifyReview(sessionID, payload);
      rootSessionID = null;
    }
  };

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = asRecord(event.properties?.info);
        const sessionID = typeof info?.sessionID === "string" ? info.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }

        const messageID = typeof info?.id === "string" ? info.id : null;
        const role = typeof info?.role === "string" ? info.role : null;
        if (messageID && role) {
          messageRoleByID.set(getMessageKey(sessionID, messageID), role);
          if (role === "assistant" && !assistantTextByMessageID.has(getMessageKey(sessionID, messageID))) {
            assistantTextByMessageID.set(getMessageKey(sessionID, messageID), "");
          }
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = asRecord(event.properties?.part);
        if (!part) {
          return;
        }

        const sessionID = typeof part.sessionID === "string" ? part.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }

        if (part.type !== "text") {
          return;
        }

        const messageID = typeof part.messageID === "string" ? part.messageID : null;
        if (!messageID) {
          return;
        }

        const messageKey = getMessageKey(sessionID, messageID);
        if (messageRoleByID.get(messageKey) !== "assistant") {
          return;
        }

        const delta = typeof event.properties?.delta === "string" ? event.properties.delta : "";
        const fullText = typeof part.text === "string" ? part.text : "";
        const previousText = assistantTextByMessageID.get(messageKey) ?? "";
        const nextText = delta ? previousText + delta : (fullText || previousText);
        const normalized = nextText.trim();
        if (!normalized) {
          return;
        }

        assistantTextByMessageID.set(messageKey, normalized);
        latestAssistantBySessionID.set(sessionID, normalized);
        return;
      }

      const sessionID = event.properties?.sessionID;
      if (await isChildSession(sessionID)) {
        return;
      }

      if (event.type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "busy") {
          await handleBusy(sessionID);
        } else if (status?.type === "idle") {
          await handleReview(sessionID, {
            hook_event_name: "session.status",
          });
        }
      }

      if (event.type === "session.busy") {
        await handleBusy(sessionID);
      }
      if (event.type === "session.idle") {
        await handleReview(sessionID, {
          hook_event_name: "session.idle",
        });
      }
      if (event.type === "session.error") {
        await handleReview(
          sessionID,
          {
            hook_event_name: "session.error",
          },
          true,
        );
      }
    },
    "tool.execute.before": async (input, output) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
      if (await isChildSession(sessionID)) {
        return;
      }

      await handleBusy(sessionID);

      const toolName = typeof input?.tool === "string" ? input.tool : undefined;
      const callID = typeof input?.callID === "string" ? input.callID : "";
      const toolInput = asRecord(output?.args);
      if (callID) {
        toolInputByCallID.set(getToolCallKey(sessionID, callID), toolInput);
      }

      await notifyActivity({
        hook_event_name: "BeforeTool",
        tool_name: toolName,
        tool_input: toolInput ?? undefined,
      });
    },
    "tool.execute.after": async (input) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
      if (await isChildSession(sessionID)) {
        return;
      }

      const toolName = typeof input?.tool === "string" ? input.tool : undefined;
      const callID = typeof input?.callID === "string" ? input.callID : "";
      const toolInput = callID ? toolInputByCallID.get(getToolCallKey(sessionID, callID)) : null;
      if (callID) {
        toolInputByCallID.delete(getToolCallKey(sessionID, callID));
      }

      await notifyActivity({
        hook_event_name: "AfterTool",
        tool_name: toolName,
        tool_input: toolInput ?? undefined,
      });
    },
    "permission.ask": async (_permission, output) => {
      if (output?.status === "ask") {
        const sessionID = typeof _permission?.sessionID === "string" ? _permission.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }
        await handleReview(
          sessionID,
          {
            hook_event_name: "PermissionRequest",
            notification_type: "permission.asked",
          },
          true,
        );
      }
    },
  };
};
`;
}

function resolveTaskAgentSessionInitialization(
	input: AgentAdapterLaunchInput,
): RuntimeTaskAgentSessionInitialization | null {
	const explicitInitialization = input.taskAgentSessionInitialization;
	if (explicitInitialization) {
		if (explicitInitialization.sourceAgentId !== input.agentId) {
			throw new Error(
				`Task session initialization agent "${explicitInitialization.sourceAgentId}" does not match selected agent "${input.agentId}".`,
			);
		}
		if (
			explicitInitialization.sourceAgentId === "cursor" &&
			explicitInitialization.sourceSessionReuseMode === "fork_existing_session"
		) {
			throw new Error("Cursor Agent does not support forking existing sessions.");
		}
		return explicitInitialization;
	}
	const legacyParentSessionId = normalizeParentSessionId(input.parentSessionId);
	return input.agentId === "codex" && legacyParentSessionId
		? {
				sourceAgentId: "codex",
				sourceSessionId: legacyParentSessionId,
				sourceSessionReuseMode: "fork_existing_session",
			}
		: null;
}

// 重启寻址轴的取值口。不匹配即抛：解析器（core/agent-conversation-session-resume-addressing.ts）
// 已经保证 sourceAgentId === 本次启动的 agent，走到这里还不一致说明有人绕过了漏斗——
// 那种情况下继续启动只会把别的 harness 的 session id 喂给本 agent，静默换回 cwd-latest 更糟。
function resolveObservedAgentNativeConversationSessionResumeAddressing(
	input: AgentAdapterLaunchInput,
): RuntimeObservedAgentNativeConversationSessionResumeAddressing | null {
	const addressing = input.observedAgentNativeConversationSessionResumeAddressing;
	if (!addressing) {
		return null;
	}
	if (addressing.sourceAgentId !== input.agentId) {
		throw new Error(
			`Observed agent native conversation session addressing agent "${addressing.sourceAgentId}" does not match selected agent "${input.agentId}".`,
		);
	}
	return addressing;
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

const KIRO_KANBAN_AGENT_NAME = "kanban";

function getKiroAgentConfigPath(): string {
	return join(homedir(), ".kiro", "agents", `${KIRO_KANBAN_AGENT_NAME}.json`);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

// agent 启动时读到的 hook 配置文件，在 agent 存活期间不能被改写：热重启之后会话不再随部署重开，原地改写会让
// 存活会话中途读到新 build 的配置（Claude 会察觉 settings 被外部修改）；droid 的 settings 还随任务权限档而异，
// 共用一个路径会被并发启动的任务互相覆盖。所以按内容寻址：内容不同就是另一个文件，已有文件永不改写。
// EXPERIMENT_NODE: 旧内容的文件目前不回收——每种内容一份、体积很小，只在 hook 配置变化的部署或不同权限档时新增。
async function ensureContentAddressedTextFile(input: {
	directoryPath: string;
	fileNameStem: string;
	fileNameExtension: string;
	content: string;
}): Promise<string> {
	const contentSha256Prefix = createHash("sha256").update(input.content).digest("hex").slice(0, 12);
	const filePath = join(input.directoryPath, `${input.fileNameStem}-${contentSha256Prefix}${input.fileNameExtension}`);
	const existingContent = await readFile(filePath, "utf8").catch(() => null);
	if (existingContent !== input.content) {
		// 只有文件不存在（或被截断 / 损坏）时才写；内容相同的文件名就是它的内容。
		await ensureTextFile(filePath, input.content);
	}
	return filePath;
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

// Wraps a command in bracketed-paste framing WITHOUT the trailing Enter, so the caller can write
// the framing and the submitting CR as two separate writes.
//
// 为什么必须能分开写：把 `ESC[200~…ESC[201~CR` 拼进同一次 write 时，TUI 在重绘中途一次性收到整串，
// 实测会把末尾 CR 连同 `ESC[201~` 一起吞掉——文本粘进输入框但不发送（2026-08-08 事故的形态 2）。
// 分两次写、且第二次以「TUI 已摄入这段 paste」为门，才真正消掉这个竞态；门控实现在 session-manager 的
// writePasteSubmissionWithConfirm，补发裸 CR 的确认链自此退居真正的 backstop。
export function toBracketedPasteFramingWithoutTrailingSubmit(command: string): string {
	return `\u001b[200~${command}\u001b[201~`;
}

// 提交用的那个单独的 CR。写成 \u 转义而非字面量：控制字符在编辑器里不可见，极易在复制粘贴中被悄悄弄丢。
export const BRACKETED_PASTE_TRAILING_SUBMIT_CARRIAGE_RETURN = "\u000d";

function resolveAgentAppendSystemPrompt(input: AgentAdapterLaunchInput): string | null {
	return combineAppendSystemPrompts(
		resolveHomeAgentAppendSystemPrompt(input.taskId),
		resolveTaskSessionAppendSystemPrompt(input.taskId, input.cwd),
		input.exploratoryModeAppendSystemPrompt,
		input.interWorkUnitRelationNeighborhoodAppendSystemPrompt,
	);
}

function prependTaskSessionGuidanceToPrompt(input: AgentAdapterLaunchInput): string {
	const prompt = input.prompt.trim();
	const taskSessionPrompt = combineAppendSystemPrompts(
		resolveTaskSessionAppendSystemPrompt(input.taskId, input.cwd),
		input.exploratoryModeAppendSystemPrompt,
		input.interWorkUnitRelationNeighborhoodAppendSystemPrompt,
	);
	if (!prompt || !taskSessionPrompt) {
		return input.prompt;
	}
	return `${taskSessionPrompt}\n\n# Task\n${input.prompt}`;
}

// 解析本次启动实际生效的放权档位：不能原生表达中间档的 harness 在此保守降级到「每次询问」。
function resolveLaunchPermissionMode(input: AgentAdapterLaunchInput): RuntimeTaskAgentPermissionMode {
	return resolveTaskAgentPermissionModeForAgent(input.agentId, input.taskAgentPermissionMode).effectivePermissionMode;
}

// Claude Code 的「plan 起步」与「放权档位」都落在 --permission-mode 这一个旗标上，所以必须
// 在一处统一决策，否则两个分支各推一次会产生重复且互相打架的 --permission-mode。
// 正交语义靠 --allow-dangerously-skip-permissions 达成：它不是「现在就放行」，而是「预授权本会话
// 后续可以切到 bypass」——于是 plan 起步的会话仍保有用户选定的 bypass 档。
// 注意：只有 readOnly / plan 这两个「开局必须只读」的分支才剔除已存在的放行旗标；其余情况下
// 调用方（快捷方式等）显式传入的旗标一律原样保留。
function stripClaudeImmediateBypassAndPermissionModeArgs(args: string[]): void {
	const stripped = removeCliOptionsWithValues(
		args.filter((arg) => arg !== "--dangerously-skip-permissions"),
		["--permission-mode"],
	);
	args.length = 0;
	args.push(...stripped);
}

function applyClaudePermissionAndPlanModeArgs(args: string[], input: AgentAdapterLaunchInput): void {
	const permissionMode = resolveLaunchPermissionMode(input);

	// 只读提问会话是最强约束，压过其余一切。
	if (input.readOnlyQuestionSession) {
		stripClaudeImmediateBypassAndPermissionModeArgs(args);
		args.push("--permission-mode", "plan", "--tools", "Read,Glob,Grep,WebSearch,WebFetch");
		return;
	}

	if (input.startInPlanMode) {
		stripClaudeImmediateBypassAndPermissionModeArgs(args);
		if (
			permissionMode === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--allow-dangerously-skip-permissions")
		) {
			args.push("--allow-dangerously-skip-permissions");
		}
		args.push("--permission-mode", "plan");
		return;
	}

	if (permissionMode === "bypass_all_permission_prompts") {
		if (!hasCliOption(args, "--dangerously-skip-permissions")) {
			args.push("--dangerously-skip-permissions");
		}
		return;
	}
	if (permissionMode === "auto_approve_file_edits_only" && !hasCliOption(args, "--permission-mode")) {
		args.push("--permission-mode", "acceptEdits");
	}
	// ask_for_every_tool_use：不加任何旗标，走 Claude Code 自身的逐次询问默认。
}

// Kanban 侧的 Claude Code 渲染模式逃生阀。取值 "inline" 时退回旧的 main-screen 渲染，
// 其余取值（含未设置）一律走 Kanban 默认的 fullscreen。
//
// 为什么另起一个 Kanban 命名空间的变量、而不是直接尊重继承来的 CLAUDE_CODE_* ：那些变量是
// **Claude Code 注入给自己子进程的**，无法区分「用户表态」与「Kanban 恰好被一个 Claude Code
// 会话启动」。若把继承值当表态，从 Claude Code 终端里起的 Kanban 会让全部 task agent 静默退回
// inline，而用户从未做过这个选择。
export const KANBAN_CLAUDE_CODE_TERMINAL_RENDERING_MODE_ENV_VAR = "KANBAN_CLAUDE_CODE_TERMINAL_RENDERING_MODE";

// Claude Code 的 TUI 渲染模式（它自己 `/tui` 的两档：`fullscreen` / `default`）。Kanban 默认选
// fullscreen——即 alt-screen 上的无闪烁渲染器，与 Codex 等其余 alt-screen agent 形态一致。
//
// 历史：2026-05-08「修复 Claude Code 交互式任务启动」曾写死 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
// 把 Claude 摁成 inline，当时是为了让 deferred startup input 的就绪判定能在 normal buffer 的
// 输出里看到提示符。该前提已经不成立：就绪与人机争用让路都改走 terminal-input-box-reader 的
// 结构判定，而它读的是 TerminalStateMirror.getScreenSnapshot() → `buffer.active`，alt-screen 下
// 读的正是 Claude 重绘的那块备用屏。真机实测（v2.1.228，cols=100）：fullscreen 下输入框画法不变
// （两条 U+2500 边界线夹 `❯`），只是从屏顶移到屏底，readTerminalInputBox 照常命中。
//
// 代价是已知且与 Codex 同构的：alt-screen agent 的会话历史留在备用屏内、normal buffer 不增长，
// 因此「阅读 scrollback transcript」入口对 Claude 会话不再出现（见 terminal-scrollback-transcript-extraction）。
//
// 为什么用 CLAUDE_CODE_NO_FLICKER 而不是写用户 settings.json 的 `tui` 键：env 在 Claude 的判定
// 顺序里压过用户设置，才能保证「Kanban 起的会话默认 fullscreen」不被宿主机的 `/tui default` 偏好
// 推翻；而写用户 settings 则会污染用户在 Kanban 之外的 Claude 会话。
//
// 两档都**成对**写出：另一档显式置 undefined 以抹掉继承值（buildTerminalEnvironment 会据此删键）。
// 缺了这一步，从 Claude Code 会话里起的 Kanban 会把继承来的 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
// 一路传下去——它在 Claude 的判定顺序里排在 NO_FLICKER 之前，会把 fullscreen 直接否决掉。
function resolveClaudeCodeTerminalRenderingModeEnv(): Record<string, string | undefined> {
	const requestedMode = process.env[KANBAN_CLAUDE_CODE_TERMINAL_RENDERING_MODE_ENV_VAR]?.trim().toLowerCase();
	if (requestedMode === "inline") {
		return { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_NO_FLICKER: undefined };
	}
	return { CLAUDE_CODE_NO_FLICKER: "1", CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: undefined };
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const taskAgentSessionInitialization = resolveTaskAgentSessionInitialization(input);
		const explicitModelId = resolveTerminalAgentModelOverride(input, "claude");
		const args = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {
			...resolveClaudeCodeTerminalRenderingModeEnv(),
			FORCE_HYPERLINK: "1",
		};
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);
		const observedNativeSessionResumeAddressing =
			resolveObservedAgentNativeConversationSessionResumeAddressing(input);
		const continuesWithoutNewPrompt = Boolean(
			observedNativeSessionResumeAddressing ||
				input.resumeFromTrash ||
				input.resumePriorAgentConversationWithoutResendingPrompt,
		);
		applyClaudePermissionAndPlanModeArgs(args, {
			...input,
			startInPlanMode: input.startInPlanMode && !continuesWithoutNewPrompt,
		});
		// 四条互斥的续跑分支任一命中 ⇒ 本次启动会重播既有对话（见 PreparedAgentLaunch 同名字段）。
		const resumesPriorAgentConversation = Boolean(
			observedNativeSessionResumeAddressing ||
				input.resumeFromTrash ||
				input.resumePriorAgentConversationWithoutResendingPrompt ||
				taskAgentSessionInitialization ||
				input.forkLatestWorkingDirectorySession,
		);
		// 优先级：**重启寻址（按 id）→ resumeFromTrash（cwd-latest）→ 建卡播种 → fork cwd-latest**。
		// 按-id 必须排在最前：`--continue` 挑的是「工作目录下最近一段对话」，而主会话与它的 By the way
		// 侧问、以及同仓库下多个 inplace 任务都共用同一个 cwd，那时 cwd-latest 必然抢错对话。
		// 分支选择只看轴本身，「args 里是否已有该旗标」只决定推不推——否则用户把 `--continue` 写进 agent
		// 命令时会掉进下一条分支，拼出 `--continue --resume <id>` 这种自相矛盾的 argv。
		if (observedNativeSessionResumeAddressing) {
			const resumeArgs = removeNativeSessionSelectionArguments(args, "claude", [
				"--resume",
				"-r",
				"--session-id",
				"--from-pr",
				"--teleport",
				"--cloud",
			]);
			args.splice(0, args.length, ...resumeArgs, "--resume", observedNativeSessionResumeAddressing.sourceSessionId);
		} else if (continuesWithoutNewPrompt) {
			if (!hasCliOption(args, "--continue")) {
				args.push("--continue");
			}
		} else if (taskAgentSessionInitialization) {
			if (!hasCliOption(args, "--resume")) {
				args.push("--resume", taskAgentSessionInitialization.sourceSessionId);
				if (
					taskAgentSessionInitialization.sourceSessionReuseMode === "fork_existing_session" &&
					!hasCliOption(args, "--fork-session")
				) {
					args.push("--fork-session");
				}
			}
		} else if (input.forkLatestWorkingDirectorySession) {
			if (!hasCliOption(args, "--continue")) {
				args.push("--continue");
			}
			if (!hasCliOption(args, "--fork-session")) {
				args.push("--fork-session");
			}
		}
		// Claude Code 的 `--continue`（「Refresh terminal session」/恢复任务时用）会用会话最后一条
		// 已记录回合的「裸」model id `claude-opus-4-8` 重建模型——这丢掉了 1M context 选择，静默回退到
		// 200k 变体（实测：即便会话本来跑在 1M，`--continue` 也会掉到 200k；而尚未产出回合的会话因为
		// 「无可重建」反而留在默认 1M，于是表现为「时好时坏」）。显式传 `--model default`（一个随版本
		// 自动跟进的别名，当前解析为 1M 的 `claude-opus-4-8[1m]`，换代后自动指向新默认）可让每次启动
		// （全新与恢复）都落到看板预期的默认模型，并覆盖上述重建。仅在未显式指定 model 时注入，故按任务
		// 指定的具体模型仍然优先。注意：只有 `--model` 这个「旗标」能解析 `default` 别名并压过 `--continue`
		// 的重建；`ANTHROPIC_MODEL=default` 环境变量会被当成名为 "default" 的自定义模型（实测失效）。
		if (!explicitModelId && !hasCliOption(args, "--model")) {
			args.push("--model", "default");
		}
		const hooks = resolveHookContext(input);
		if (hooks) {
			const hooksSettings = {
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: buildHookCommand("agent_conversation_session_identity_observed", {
										source: "claude",
									}),
								},
							],
						},
					],
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					// 压缩完成：manual / auto 都收（不带 matcher），trigger 由 `kanban hooks` 从 stdin 派生。
					// 刻意不用 SessionStart(source=compact)——它被映射为身份事件，且语义是「会话（重新）开始」。
					PostCompact: [
						{
							hooks: [
								{
									type: "command",
									command: buildHookCommand("main_agent_conversation_context_compaction_completed", {
										source: "claude",
									}),
								},
							],
						},
					],
					PreToolUse: [
						{
							// Stage 5：Claude 原生「计划待批 / 澄清提问」经它自己的工具触发（ExitPlanMode /
							// AskUserQuestion）。PreToolUse 在工具执行前触发——此刻用户需先批/答 → 映射为
							// to_review；具体人轴（plan_review / question）由 ingest 端 classifyHookUserTurnKind
							// 读 metadata.toolName 区分。须排在下方 *→activity 之前（专用 matcher 优先）。镜像
							// Notification 的 permission_prompt+* 双 matcher：保留 *→activity 继续喂活动 feed，
							// 两者对同一工具双触发幂等（activity 不转换、仅 applyHookActivity，metadata-only 漏斗
							// 分支 preserve userTurnKind，不冲掉已采集的人轴）。
							matcher: "ExitPlanMode|AskUserQuestion",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
			};
			const settingsPath = await ensureContentAddressedTextFile({
				directoryPath: getHookAgentDirectory("claude"),
				fileNameStem: "settings",
				fileNameExtension: ".json",
				content: JSON.stringify(hooksSettings, null, 2),
			});
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const trimmed = input.prompt.trim();
		if (!continuesWithoutNewPrompt && trimmed) {
			args.push(trimmed);
		}
		return {
			args,
			env: {
				...env,
			},
			resumesPriorAgentConversation,
			...resolveAgentOutputTransitionDetectionForAgentId("claude"),
		};
	},
};

function claudePromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	// 旧门控 `state==="awaiting_review"` → facet 真相源（行为保持，见 isAwaitingUserReviewTurn 注释）。
	if (!isAwaitingUserReviewTurn(resolveSessionFacets(summary))) {
		return null;
	}
	// 仅在 reviewReason === "attention" 时根据 TUI 输出回到 running。
	// reviewReason === "hook" 表示 Claude 在 Stop / Notification hook 后等待用户审查，
	// 而 Claude 的 TUI 输入框 / 启动横幅会随着每一次重绘出现 — 如果在 "hook" 下也接受
	// prompt-ready，那么 hook 触发后下一帧 TUI 重绘就会立刻把状态翻回 running，
	// "等待审查" 的语义就丢失了。"hook" -> running 应由 UserPromptSubmit hook 走
	// `hook.to_in_progress` 路径触发，而不是靠终端输出探测。
	if (summary.reviewReason !== "attention") {
		return null;
	}
	if (hasClaudeInteractivePrompt(data) || hasClaudeStartupUiRendered(data)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectClaudeOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	// 与 claudePromptDetector 保持一致：仅在 reviewReason === "attention" 时才需要解码
	// 输出来探测 prompt-ready 转移。
	return isAwaitingUserReviewTurn(resolveSessionFacets(summary)) && summary.reviewReason === "attention";
}

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	// 旧门控 `state==="awaiting_review"` → facet 真相源（行为保持，见 isAwaitingUserReviewTurn 注释）。
	if (!isAwaitingUserReviewTurn(resolveSessionFacets(summary))) {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		isAwaitingUserReviewTurn(resolveSessionFacets(summary)) &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const taskAgentSessionInitialization = resolveTaskAgentSessionInitialization(input);
		const observedNativeSessionResumeAddressing =
			resolveObservedAgentNativeConversationSessionResumeAddressing(input);
		const explicitModelId = resolveTerminalAgentModelOverride(input, "codex");
		const codexArgs = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		let deferredStartupPromptText: string | undefined;
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		// codex 的放权是 sandbox × approval 两个正交旗标，但它表达不出「改文件放行、执行命令仍询问」
		// 这一中间档（理由见 task-agent-permission-mode.ts 里 codex 那段注释），所以中间档已在领域层
		// 保守降级成「每次询问」，这里只剩两档要落地。
		// 「每次询问」必须显式推 --ask-for-approval untrusted：codex 的默认审批策略来自用户自己的
		// config.toml，什么都不推等于把档位交给用户全局配置决定——那会静默放宽用户在本任务上选的档。
		// 与 startInPlanMode 无关——codex 的 plan 起步走 deferred `/plan` 斜杠命令，不占用这两个旗标。
		const codexPermissionMode = resolveLaunchPermissionMode(input);
		const hasExplicitCodexApprovalPolicy =
			hasCliOption(codexArgs, "--ask-for-approval") || hasCliOption(codexArgs, "-a");
		if (
			codexPermissionMode === "bypass_all_permission_prompts" &&
			!hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")
		) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		} else if (
			codexPermissionMode === "ask_for_every_tool_use" &&
			!hasExplicitCodexApprovalPolicy &&
			!hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")
		) {
			codexArgs.push("--ask-for-approval", "untrusted");
		}
		const parentSessionId = normalizeParentSessionId(input.parentSessionId);
		const continuesWithoutNewPrompt = Boolean(
			observedNativeSessionResumeAddressing ||
				input.resumeFromTrash ||
				input.resumePriorAgentConversationWithoutResendingPrompt,
		);
		if (input.readOnlyQuestionSession) {
			const withoutBypass = codexArgs.filter((arg) => arg !== "--dangerously-bypass-approvals-and-sandbox");
			codexArgs.length = 0;
			codexArgs.push(...removeCliOptionsWithValues(withoutBypass, ["--sandbox", "-s", "--ask-for-approval", "-a"]));
			codexArgs.push("--sandbox", "read-only", "--ask-for-approval", "never");
		}
		// 优先级同 claude：**重启寻址（按 id）→ resumeFromTrash（`resume --last`）→ 建卡播种 → fork cwd-latest**。
		// `resume --last` 与 `--continue` 是同一种「工作目录下最近一段对话」寻址，共用 cwd 时同样会抢错。
		if (observedNativeSessionResumeAddressing) {
			if (!hasCodexWorkingDirectoryOverride(codexArgs)) {
				codexArgs.push("-C", input.cwd);
			}
			applyObservedCodexNativeSessionResumeArguments(
				codexArgs,
				observedNativeSessionResumeAddressing.sourceSessionId,
			);
		} else if (continuesWithoutNewPrompt) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		} else if (taskAgentSessionInitialization) {
			if (!hasCodexWorkingDirectoryOverride(codexArgs)) {
				codexArgs.push("-C", input.cwd);
			}
			const sessionSubcommand =
				taskAgentSessionInitialization.sourceSessionReuseMode === "fork_existing_session" ? "fork" : "resume";
			if (!codexArgs.includes(sessionSubcommand)) {
				codexArgs.push(sessionSubcommand, taskAgentSessionInitialization.sourceSessionId);
			}
		} else if (parentSessionId || input.forkLatestWorkingDirectorySession) {
			if (!hasCodexWorkingDirectoryOverride(codexArgs)) {
				codexArgs.push("-C", input.cwd);
			}
			if (!codexArgs.includes("fork")) {
				codexArgs.push("fork");
				if (parentSessionId) {
					codexArgs.push(parentSessionId);
				} else {
					codexArgs.push("--last");
				}
			}
		}

		const selectsLatestWorkingDirectorySession =
			!observedNativeSessionResumeAddressing &&
			(continuesWithoutNewPrompt ||
				(!taskAgentSessionInitialization && !parentSessionId && input.forkLatestWorkingDirectorySession));
		if (selectsLatestWorkingDirectorySession) {
			await constrainCodexLatestSessionToTaskWorkingDirectory(codexArgs, input.cwd);
		}

		if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			configureCodexHooks(codexArgs);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		normalizeCodexConfigOverridesBeforeSubcommand(codexArgs);
		const trimmed = continuesWithoutNewPrompt ? "" : input.prompt.trim();
		if (input.startInPlanMode && !continuesWithoutNewPrompt) {
			deferredStartupPromptText = trimmed ? `/plan ${trimmed}` : "/plan";
		} else if (trimmed) {
			codexArgs.push(trimmed);
		}
		const resumesSession =
			continuesWithoutNewPrompt ||
			(!continuesWithoutNewPrompt &&
				taskAgentSessionInitialization?.sourceSessionReuseMode === "resume_existing_session");
		const forksSession =
			!continuesWithoutNewPrompt &&
			(taskAgentSessionInitialization?.sourceSessionReuseMode === "fork_existing_session" ||
				(!taskAgentSessionInitialization &&
					(parentSessionId !== null || Boolean(input.forkLatestWorkingDirectorySession))));

		logTuiFreezeWarning(
			`[tui-freeze] codex-startup-prompt taskId=${input.taskId} hasFork=${forksSession} hasResume=${resumesSession} promptChars=${trimmed.length} deferredViaInput=${deferredStartupPromptText !== undefined}`,
		);

		// 这里刻意只保留**唯一一个** return：hooks 配置只是就地改写 codexArgs / env（见上方
		// `if (hooks)` 块），并不改变 PreparedAgentLaunch 的形状，所以不需要按 hooks 分叉出第二个
		// return。曾经存在的「hooks 分支 return + 默认 return」两份逐字重复的对象字面量，导致给
		// PreparedAgentLaunch 新增字段时只补了其中一份，而生产任务会话恒有 workspaceId、恒走
		// hooks 分支，字段静默丢失（resumesPriorAgentConversation 就这样漏过一次）。单 return 从
		// 结构上根除这类漏改。
		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupPromptText,
			// resume 与 fork 都会把既有会话的 transcript 重播进新 TUI（见 PreparedAgentLaunch 同名字段）。
			resumesPriorAgentConversation: resumesSession || forksSession,
			...resolveAgentOutputTransitionDetectionForAgentId("codex"),
		};
	},
};

// cursor-agent 的 chat 选择参数：`--continue`（cwd 桶最近一段）与 `--resume [chatId]`（chatId 可省）。kanban 一旦按 id
// 寻址就必须先把用户 args 里的这些剥掉——实测 `--continue` 与 `--resume <id>` 同时出现时 `--continue` 胜，
// 按 id 续跑会被静默改成「最近一段」。`--resume` 后面只吞 UUID 形状的值，免得把 positional prompt 当成 chatId 吃掉。
const CURSOR_AGENT_CHAT_ID_ARGUMENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function removeCursorAgentChatSelectionArguments(args: readonly string[]): string[] {
	const remaining: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--continue" || argument.startsWith("--resume=")) {
			continue;
		}
		if (argument === "--resume") {
			if (CURSOR_AGENT_CHAT_ID_ARGUMENT_PATTERN.test(args[index + 1] ?? "")) {
				index += 1;
			}
			continue;
		}
		remaining.push(argument);
	}
	return remaining;
}

const cursorAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const taskAgentSessionInitialization = resolveTaskAgentSessionInitialization(input);
		const explicitModelId = resolveTerminalAgentModelOverride(input, "cursor");
		// cursor 是唯一**无条件**传 `--model` 的 adapter（claude / codex 只在有显式 override 时才传），
		// 所以这个默认值必须跟得上上游改名：从实际模型目录解析（带 TTL 缓存，热路径零开销），
		// 探测失败才回落写死的常量。上一版直接用常量，结果每次会话都在传一个上游早已删除的 model id。
		let args = setModelCliOption(input.args, explicitModelId ?? (await resolveCursorLaunchDefaultModelId()));
		const env: Record<string, string | undefined> = {};

		if (!hasCliOption(args, "--workspace")) {
			args.push("--workspace", input.cwd);
		}

		// cursor-agent 的 --force（放行命令）与 --plan（开局只读规划）是两个独立布尔旗标，实测可并存，
		// 故这里不再让 plan 起步压掉放权档。cursor 无法表达「只放行编辑」，中间档已由
		// resolveLaunchPermissionMode 保守降级为「每次询问」。
		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--force") &&
			!hasCliOption(args, "--yolo")
		) {
			args.push("--force");
		}

		// 未信任的 cwd 上，交互模式会先弹 Workspace Trust 对话框，prompt 要等应答后才提交（`--force` 跳不过，
		// 只有 `--trust` 能）。kanban 从不应答它，于是 8ef28 / aa23d 这类任务的首轮从未落盘，之后每次续跑都撞
		// `No previous chats found.`。范围与 Claude 自动信任一致：只替 kanban 自己的 task worktree 做主。
		if (isKanbanTaskWorktreeWorkingDirectoryPath(input.cwd) && !hasCliOption(args, "--trust")) {
			args.push("--trust");
		}

		const observedNativeSessionResumeAddressing =
			resolveObservedAgentNativeConversationSessionResumeAddressing(input);
		// 与 claude 同一口径：续跑既有对话时不再投 prompt、不重放 plan 起步（`--plan` 会把续上的 chat 的 mode 覆写回 plan）。
		const continuesWithoutNewPrompt = Boolean(
			observedNativeSessionResumeAddressing ||
				input.resumeFromTrash ||
				input.resumePriorAgentConversationWithoutResendingPrompt,
		);
		const resumesPriorAgentConversation = Boolean(continuesWithoutNewPrompt || taskAgentSessionInitialization);
		// chat 选择优先级：**重启寻址（按记录的 id）→ 无 id 的续跑（`--continue`）→ 建卡播种 → kanban 刚分配的新 id**。
		// cursor 不支持 fork（契约层已 superRefine 拦下），所以按 id 只有 `--resume` 一种落法；新 id 开局也用
		// `--resume <新 id> <prompt>`：实测 cursor 会以该 id 建 chat 并自动提交 prompt。
		const chatIdSelectedForLaunch =
			observedNativeSessionResumeAddressing?.sourceSessionId ??
			(continuesWithoutNewPrompt
				? null
				: (taskAgentSessionInitialization?.sourceSessionId ??
					input.kanbanAssignedAgentNativeConversationSessionIdForFreshStart ??
					null));
		if (chatIdSelectedForLaunch !== null) {
			args = [...removeCursorAgentChatSelectionArguments(args), "--resume", chatIdSelectedForLaunch];
		} else if (continuesWithoutNewPrompt) {
			// 只剩「没有记录 id、桶里有 ≥2 段已建立对话」这一条会走到这里——续跑前的预检已经排除了桶为空的情形。
			if (!hasCliOption(args, "--continue") && !hasCliOption(args, "--resume")) {
				args.push("--continue");
			}
		}

		if (
			input.startInPlanMode &&
			!continuesWithoutNewPrompt &&
			!hasCliOption(args, "--plan") &&
			!hasCliOption(args, "--mode")
		) {
			args.push("--plan");
		}

		const trimmed = prependTaskSessionGuidanceToPrompt(input).trim();
		if (!continuesWithoutNewPrompt && trimmed) {
			args.push(trimmed);
		}

		return {
			args,
			env,
			resumesPriorAgentConversation,
		};
	},
};

const geminiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		const geminiPermissionMode = resolveLaunchPermissionMode(input);
		if (geminiPermissionMode === "bypass_all_permission_prompts" && !hasCliOption(args, "--yolo")) {
			args.push("--yolo");
		} else if (geminiPermissionMode === "auto_approve_file_edits_only" && !hasCliOption(args, "--approval-mode")) {
			args.push("--approval-mode=auto_edit");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume")) {
			args.push("--resume", "latest");
		}

		// plan 起步用 --approval-mode=plan 表达，会盖掉上面的 auto_edit（同一旗标）；--yolo 是独立
		// 旗标故 bypass 档在 plan 起步下依然保留。
		if (input.startInPlanMode) {
			args.push("--approval-mode=plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const geminiHookCommand = buildHooksCommand(["gemini-hook"]);

			const config = {
				hooks: {
					BeforeTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					BeforeAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					Notification: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
				},
			};
			const configPath = await ensureContentAddressedTextFile({
				directoryPath: getHookAgentDirectory("gemini"),
				fileNameStem: "settings",
				fileNameExtension: ".json",
				content: JSON.stringify(config, null, 2),
			});
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;
		}

		const prompt = prependTaskSessionGuidanceToPrompt(input);
		const trimmed = prompt.trim();
		if (trimmed) {
			args.push("-i", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

async function resolveOpenCodeBaseConfigPath(explicitPath: string | undefined): Promise<string | null> {
	const candidates = getOpenCodeConfigPathCandidates({ explicitPath });
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Keep searching.
		}
	}
	return null;
}

function hasOpenCodeModelArg(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--model" || arg === "-m") {
			return true;
		}
		if (arg.startsWith("--model=") || arg.startsWith("-m=")) {
			return true;
		}
	}
	return false;
}

function hasOpenCodeAgentArg(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--agent") {
			return true;
		}
		if (arg.startsWith("--agent=")) {
			return true;
		}
	}
	return false;
}

function normalizeOpenCodeModel(providerId: string, modelId: string): string {
	if (modelId.startsWith(`${providerId}/`)) {
		return modelId;
	}
	return `${providerId}/${modelId}`;
}

function stripJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < input.length; i += 1) {
		const current = input[i];
		const next = i + 1 < input.length ? input[i + 1] : "";

		if (inLineComment) {
			if (current === "\n") {
				inLineComment = false;
				output += current;
			}
			continue;
		}
		if (inBlockComment) {
			if (current === "*" && next === "/") {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}
		if (!inString && current === "/" && next === "/") {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (!inString && current === "/" && next === "*") {
			inBlockComment = true;
			i += 1;
			continue;
		}

		output += current;
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (current === "\\") {
				escaped = true;
			} else if (current === '"') {
				inString = false;
			}
			continue;
		}
		if (current === '"') {
			inString = true;
		}
	}
	return output;
}

function tryExtractOpenCodeModelFromConfig(rawConfig: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawConfig);
	} catch {
		try {
			parsed = JSON.parse(stripJsonComments(rawConfig));
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const root = parsed as Record<string, unknown>;

	const directModel = root.model;
	if (typeof directModel === "string" && directModel.trim()) {
		return directModel.trim();
	}

	const mode = root.mode;
	if (mode && typeof mode === "object" && !Array.isArray(mode)) {
		const build = (mode as Record<string, unknown>).build;
		if (build && typeof build === "object" && !Array.isArray(build)) {
			const model = (build as Record<string, unknown>).model;
			if (typeof model === "string" && model.trim()) {
				return model.trim();
			}
		}
	}

	const agent = root.agent;
	if (agent && typeof agent === "object" && !Array.isArray(agent)) {
		const build = (agent as Record<string, unknown>).build;
		if (build && typeof build === "object" && !Array.isArray(build)) {
			const model = (build as Record<string, unknown>).model;
			if (typeof model === "string" && model.trim()) {
				return model.trim();
			}
		}
	}

	return null;
}

async function resolveOpenCodePreferredModelArg(configPath: string | null): Promise<string | null> {
	if (configPath) {
		try {
			const rawConfig = await readFile(configPath, "utf8");
			const modelFromConfig = tryExtractOpenCodeModelFromConfig(rawConfig);
			if (modelFromConfig) {
				return modelFromConfig;
			}
		} catch {
			// Fall through to state-based fallback.
		}
	}

	const modelStateCandidates = getOpenCodeModelStatePathCandidates();
	let recentModels: Array<{ providerID?: unknown; modelID?: unknown }> = [];
	for (const modelStatePath of modelStateCandidates) {
		try {
			const raw = await readFile(modelStatePath, "utf8");
			const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: unknown; modelID?: unknown }> };
			if (Array.isArray(parsed.recent)) {
				recentModels = parsed.recent;
				break;
			}
		} catch {
			// Keep searching through candidate state paths.
		}
	}
	if (recentModels.length === 0) {
		return null;
	}

	const configuredProviders = new Set<string>();
	for (const authPath of getOpenCodeAuthPathCandidates()) {
		try {
			const raw = await readFile(authPath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			for (const [provider, value] of Object.entries(parsed)) {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					continue;
				}
				const key = (value as Record<string, unknown>).key;
				if (typeof key === "string" && key.trim()) {
					configuredProviders.add(provider);
				}
			}
			break;
		} catch {
			// Keep searching through candidate auth paths.
		}
	}

	const candidates: Array<{ providerId: string; model: string }> = [];
	for (const entry of recentModels) {
		const providerId = typeof entry.providerID === "string" ? entry.providerID.trim() : "";
		const modelId = typeof entry.modelID === "string" ? entry.modelID.trim() : "";
		if (!providerId || !modelId) {
			continue;
		}
		candidates.push({ providerId, model: normalizeOpenCodeModel(providerId, modelId) });
	}
	if (candidates.length === 0) {
		return null;
	}

	const preferredProviderOrder = ["openrouter", "anthropic", "openai", "opencode", "google", "amazon-bedrock"];
	for (const providerId of preferredProviderOrder) {
		const match = candidates.find((candidate) => candidate.providerId === providerId);
		if (!match) {
			continue;
		}
		if (configuredProviders.size === 0 || configuredProviders.has(providerId)) {
			return match.model;
		}
	}

	const configuredMatch = candidates.find((candidate) => configuredProviders.has(candidate.providerId));
	if (configuredMatch) {
		return configuredMatch.model;
	}

	return candidates[0].model;
}

const opencodeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		const baseConfigPath = await resolveOpenCodeBaseConfigPath(input.env?.OPENCODE_CONFIG);
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			env.OPENCODE_EXPERIMENTAL_PLAN_MODE = "true";
			if (!hasOpenCodeAgentArg(args)) {
				args.push("--agent", "plan");
			}
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const pluginContent = buildOpenCodePluginContent(
				buildHookCommand("to_review", { source: "opencode" }),
				buildHookCommand("to_in_progress", { source: "opencode" }),
				buildHookCommand("activity", { source: "opencode" }),
			);
			const pluginPath = await ensureContentAddressedTextFile({
				directoryPath: getHookAgentDirectory("opencode"),
				fileNameStem: "kanban",
				fileNameExtension: ".js",
				content: pluginContent,
			});
			const pluginFileUrl = pathToFileURL(pluginPath).href;
			const config = {
				plugin: [pluginFileUrl],
			};
			const configPath = await ensureContentAddressedTextFile({
				directoryPath: getHookAgentDirectory("opencode"),
				fileNameStem: "opencode",
				fileNameExtension: ".json",
				content: JSON.stringify(config),
			});
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.OPENCODE_CONFIG = configPath;
		}

		// Workaround: with --prompt, OpenCode can pick an unexpected provider/model.
		// Explicitly pass the user's preferred model so prompt runs stay on their usual provider.
		if (!hasOpenCodeModelArg(args)) {
			const preferredModel = await resolveOpenCodePreferredModelArg(baseConfigPath);
			if (preferredModel) {
				args.push("--model", preferredModel);
			}
		}

		const prompt = prependTaskSessionGuidanceToPrompt(input);
		const trimmed = prompt.trim();
		if (trimmed) {
			args.push("--prompt", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

const droidAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		// settings.json 必写：autonomyMode 要如实反映当前放权档（"normal" 同样是一个有意义的档位，
		// 不写就会退回 droid 自己的默认，权限档形同虚设）。
		{
			const settings: Record<string, unknown> = {
				// droid 的 autonomyMode 是**单轴**（spec / normal / auto-high），无法同时表达
				// 「plan 起步」与「放权档位」。这是已知的 harness 限制，由
				// doesPlanModeStartOverridePermissionModeForAgent 在 UI 侧明示，此处不静默假装两者都生效。
				autonomyMode: input.startInPlanMode
					? "spec"
					: resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts"
						? "auto-high"
						: "normal",
			};

			if (hooks) {
				const droidActiveToolMatcher = "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create";
				const reviewNotifyCommand = buildHooksCommand(["notify", "--event", "to_review", "--source", "droid"]);
				const inProgressNotifyCommand = buildHooksCommand([
					"notify",
					"--event",
					"to_in_progress",
					"--source",
					"droid",
				]);
				const activityNotifyCommand = buildHooksCommand(["notify", "--event", "activity", "--source", "droid"]);
				settings.hooks = {
					Stop: [{ hooks: [{ type: "command", command: reviewNotifyCommand }] }],
					Notification: [
						{ hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PreToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: droidActiveToolMatcher, hooks: [{ type: "command", command: inProgressNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PostToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: inProgressNotifyCommand }] },
					],
					PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] }],
					UserPromptSubmit: [{ hooks: [{ type: "command", command: inProgressNotifyCommand }] }],
				};

				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			const settingsPath = await ensureContentAddressedTextFile({
				directoryPath: getHookAgentDirectory("droid"),
				fileNameStem: "settings",
				fileNameExtension: ".json",
				content: JSON.stringify(settings, null, 2),
			});
			if (!hasCliOption(args, "--settings")) {
				args.push("--settings", settingsPath);
			}
		}

		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);
		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, prependTaskSessionGuidanceToPrompt(input), "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const kiroAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		// kiro 的 plan 起步是纯 prompt 注入，与 --trust-all-tools 天然正交。
		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--trust-all-tools")
		) {
			args.push("--trust-all-tools");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);
		let carriesInterWorkUnitRelationNeighborhoodAppendSystemPromptOutsideLaunchArgv = false;
		if (hooks || appendedSystemPrompt) {
			const configPath = getKiroAgentConfigPath();
			const config: Record<string, unknown> = {
				name: KIRO_KANBAN_AGENT_NAME,
				description: "Kanban-managed Kiro agent with hook forwarding.",
				tools: ["*"],
			};

			if (hooks) {
				config.hooks = {
					agentSpawn: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "agentSpawn",
							}),
						},
					],
					userPromptSubmit: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "userPromptSubmit",
							}),
						},
					],
					preToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
					],
					postToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "postToolUse",
							}),
						},
					],
					stop: [
						{
							command: buildHookCommand("to_review", {
								source: "kiro",
								hookEventName: "stop",
								activityText: "Waiting for review",
							}),
						},
					],
				};
				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			if (appendedSystemPrompt) {
				config.prompt = appendedSystemPrompt;
			}

			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			if (!hasCliOption(args, "--agent")) {
				args.push("--agent", KIRO_KANBAN_AGENT_NAME);
				// 只有选中的是 Kanban 托管 agent，配置文件里的 prompt 才生效；用户自带 --agent 时如实不算带上。
				carriesInterWorkUnitRelationNeighborhoodAppendSystemPromptOutsideLaunchArgv = Boolean(
					appendedSystemPrompt && input.interWorkUnitRelationNeighborhoodAppendSystemPrompt,
				);
			}
		}

		const trimmedPrompt = input.prompt.trim();
		const planPrompt = input.startInPlanMode
			? [
					"First, inspect the codebase and produce a clear implementation plan only.",
					"Do not modify files, do not use write tools, and do not implement anything yet.",
					"After you present the plan, ask for approval before making changes.",
					trimmedPrompt
						? `\n\nTask:\n${trimmedPrompt}`
						: " Ask the user what they want planned if the task is unclear.",
				].join(" ")
			: input.prompt;
		const withPromptLaunch = withPrompt(args, planPrompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
			carriesInterWorkUnitRelationNeighborhoodAppendSystemPromptOutsideLaunchArgv,
		};
	},
};

const clineAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--auto-approve-all")
		) {
			args.push("--auto-approve-all");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			args.push("--plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const hooksDir = getHookAgentDirectory("cline");
			const notificationHookPath = getClineHookScriptPath(hooksDir, "Notification");
			const taskCompleteHookPath = getClineHookScriptPath(hooksDir, "TaskComplete");
			const userPromptSubmitHookPath = getClineHookScriptPath(hooksDir, "UserPromptSubmit");
			const preToolUseHookPath = getClineHookScriptPath(hooksDir, "PreToolUse");
			const postToolUseHookPath = getClineHookScriptPath(hooksDir, "PostToolUse");
			const executable = process.platform !== "win32";

			await ensureTextFile(notificationHookPath, buildClineNotificationHookScriptContent(), executable);
			await ensureTextFile(taskCompleteHookPath, buildClineHookScriptContent("to_review"), executable);
			await ensureTextFile(userPromptSubmitHookPath, buildClineHookScriptContent("to_in_progress"), executable);
			await ensureTextFile(preToolUseHookPath, buildClinePreToolUseHookScriptContent(), executable);
			await ensureTextFile(postToolUseHookPath, buildClinePostToolUseHookScriptContent(), executable);

			if (!hasCliOption(args, "--hooks-dir")) {
				args.push("--hooks-dir", hooksDir);
			}

			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const withPromptLaunch = withPrompt(args, prependTaskSessionGuidanceToPrompt(input), "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

// Kimi Code TUI 的「等待用户审查 → 回到 running」输出探测：与 claudePromptDetector 对齐（而非 codex）。
// kimi 与 claude 同为 Stop hook 驱动 to_review，故门控口径必须一致——仅在 awaiting-review 且
// reviewReason === "attention" 时，凭输入提示符重现判定 agent 已回到空闲。
function kimiPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (!isAwaitingUserReviewTurn(resolveSessionFacets(summary))) {
		return null;
	}
	// 仅在 reviewReason === "attention"（如 resumeFromTrash 恢复会话）时根据 TUI 输出回到 running。
	// reviewReason === "hook" 表示 kimi 在 Stop / StopFailure hook 后等待用户审查，而 kimi 的 TUI
	// 输入框会随每一次重绘出现 — 若在 "hook" 下也接受 prompt-ready，hook 触发后下一帧 TUI 重绘就会
	// 立刻把状态翻回 running，"等待审查" 的语义（含完成通知）就丢失了。codex 靠 session-manager 的
	// awaitingCodexPromptAfterEnter enter 守卫兜住这次即时翻转，kimi 没有该守卫、也没有 claude 曾缺的
	// 门控，故必须在此对齐 claude。"hook" -> running 应由 UserPromptSubmit hook 走 `hook.to_in_progress`
	// 路径触发，而不是靠终端输出探测。
	if (summary.reviewReason !== "attention") {
		return null;
	}
	if (hasKimiInteractivePrompt(data)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectKimiOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	// 与 kimiPromptDetector / claude 保持一致：仅在 reviewReason === "attention" 时才需要解码输出来探测
	// prompt-ready 转移；"hook" -> running 由 UserPromptSubmit hook 驱动，不走输出探测。
	return isAwaitingUserReviewTurn(resolveSessionFacets(summary)) && summary.reviewReason === "attention";
}

// Kimi Code CLI（Moonshot 的原生终端 agent）。与 codexAdapter 同为「全屏 TUI + 无位置
// prompt」形态，故任务 prompt 一律经 deferredStartupPromptText 在 TUI 就绪后 bracketed-paste 注入
//（`kimi -p` 是单发模式，虽然会保存会话，但不提供托管所需的持续交互终端）。
const kimiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		// 仅在有显式 override 时才注入 `-m/--model`（setModelCliOption 正好清理这两个写法）；
		// 无 override 时不传，交回 kimi config.toml 的 default_model——与 claude / codex adapter 一致。
		const observedNativeSessionResumeAddressing =
			resolveObservedAgentNativeConversationSessionResumeAddressing(input);
		const resumesPriorAgentConversation = Boolean(
			observedNativeSessionResumeAddressing ||
				input.resumeFromTrash ||
				input.resumePriorAgentConversationWithoutResendingPrompt,
		);
		const explicitModelId = resolveTerminalAgentModelOverride(input, "kimi");
		const args = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {
			// 会话中途自升级会打断托管会话（tui.toml [upgrade] auto_install 默认开）；关掉它。
			KIMI_CLI_NO_AUTO_UPDATE: "1",
		};

		// kimi 的 --plan 与 --yolo 是独立旗标，plan 起步不影响放权档。
		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--yolo") &&
			!hasCliOption(args, "-y")
		) {
			args.push("--yolo");
		}
		if (!resumesPriorAgentConversation && input.startInPlanMode && !hasCliOption(args, "--plan")) {
			args.push("--plan");
		}
		if (observedNativeSessionResumeAddressing) {
			const resumeArgs = removeNativeSessionSelectionArguments(args, "kimi", ["--session", "-S"]);
			args.splice(0, args.length, ...resumeArgs, "--session", observedNativeSessionResumeAddressing.sourceSessionId);
		} else if (resumesPriorAgentConversation && !hasCliOption(args, "--continue") && !hasCliOption(args, "-c")) {
			args.push("--continue");
		}

		// hook 只能声明在 kimi 已解析 home 的 config.toml；派生一个 Kanban 托管的 seeded
		// KIMI_CODE_HOME（软链登录态 + 注入 Kanban hooks），不改动用户全局 ~/.kimi-code。
		const hooks = resolveHookContext(input);
		if (hooks) {
			env.KIMI_CODE_HOME = await seedKanbanManagedKimiCodeHome(process.env);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const trimmed = prependTaskSessionGuidanceToPrompt(input).trim();
		const deferredStartupPromptText = !resumesPriorAgentConversation && trimmed ? trimmed : undefined;

		return {
			args,
			env,
			deferredStartupPromptText,
			resumesPriorAgentConversation,
			...resolveAgentOutputTransitionDetectionForAgentId("kimi"),
		};
	},
};

// oh-my-pi（omp）的 PTY TUI 通道。omp 还有一条 ACP 通道（src/acp-client-session/），两条通道
// 共用同一份 omp 磁盘会话存储（omp 的 SessionManager 按 cwd 建库），因而可以随时互相切换——
// 走哪条由 core/agent-session-transport-selection.ts 决定，不是这里。
//
// 形态上模板是 cursorAdapter 而不是 codex/kimi：omp 的根命令吃**位置 prompt** 并在 mode.init()
// 完成后自动提交（main.ts 的 `session.prompt(initialMessage)`），所以不需要 deferredStartupPromptText，
// 也就完全不必碰 session-manager 的就绪判定与注入闸。
const ompAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const observedNativeSessionResumeAddressing =
			resolveObservedAgentNativeConversationSessionResumeAddressing(input);
		const env: Record<string, string | undefined> = {
			// 首启的全屏 setup 向导会切 alt-screen 盖住 TUI 并等人操作，托管会话必须跳过。
			// 这是 omp 侧唯一的读取点（setup-wizard/index.ts）。
			OMP_SKIP_SETUP: "1",
		};

		// 放权档三档与 omp 的 `--approval-mode` 一一对应；映射表与 ACP 通道共用一份
		// （core/omp-approval-mode-flag.ts），否则切换通道会静默改变放权语义。
		// 必须**显式**传：omp 的 schema 默认虽是 yolo，但「默认值」不算 isConfigured，权限门仍会保留。
		if (!hasCliOption(args, "--approval-mode")) {
			args.push("--approval-mode", resolveOmpApprovalModeFlagValue(resolveLaunchPermissionMode(input)));
		}

		// plan 起步经 Kanban 托管的设置 overlay 表达，**不动放权档**（AGENTS.md 的正交轴铁律）。
		// 续跑时不重放 plan 起步：用户已在对话中途，omp 的会话记录里存着当前模式。
		// 续跑（垃圾桶恢复 / 通道切换）在 adapter 里是同一条分支：都不重投 prompt、都按已观察 ID 优先恢复、
		// 都武装重播守卫、都不重放 plan 起步。
		const shouldContinuePriorConversation = Boolean(
			observedNativeSessionResumeAddressing ||
				input.resumeFromTrash ||
				input.resumePriorAgentConversationWithoutResendingPrompt,
		);
		const shouldStartInPlanMode = Boolean(input.startInPlanMode) && !shouldContinuePriorConversation;
		const launchConfigOverlay = await writeOmpTuiLaunchConfigOverlay({
			hookAgentDirectory: getHookAgentDirectory("omp"),
			taskId: input.taskId,
			startInPlanMode: shouldStartInPlanMode,
		});
		args.push("--config", launchConfigOverlay.configFilePath);

		// 已观察身份时用完整 ID 的 `--resume`；旧记录才用 `--continue`。裸 `--resume` 会打开 picker，
		// 等人上下键选（main.ts），托管会话会就此卡死。
		// omp 的 terminal breadcrumb 认的是 TTY 设备路径（ttyid.ts），新 PTY 每次 id 都不同，于是
		// `--continue` 落到 fallback「该 cwd 下最近的一条 session」；仅在上游确认无同 harness 的
		// 共目录竞争者且没有绑定时允许使用，它不锁定具体 sessionId。
		const resumesPriorAgentConversation = shouldContinuePriorConversation;
		if (observedNativeSessionResumeAddressing) {
			const resumeArgs = removeNativeSessionSelectionArguments(args, "omp", [
				"--resume",
				"-r",
				"--session",
				"--fork",
			]);
			args.splice(0, args.length, ...resumeArgs, "--resume", observedNativeSessionResumeAddressing.sourceSessionId);
		} else if (shouldContinuePriorConversation && !hasCliOption(args, "--continue") && !hasCliOption(args, "-c")) {
			args.push("--continue");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			args.push(
				"--extension",
				await writeOmpNativeConversationSessionIdentityExtension(getHookAgentDirectory("omp")),
			);
			Object.assign(env, createHookRuntimeEnv(hooks));
		}

		// 位置 prompt：omp 在 TUI 初始化完成后自动提交它。续跑时不重投——那会凭空多出一轮。
		const trimmed = prependTaskSessionGuidanceToPrompt(input).trim();
		if (!shouldContinuePriorConversation && trimmed) {
			args.push(trimmed);
		}

		return {
			args,
			env,
			resumesPriorAgentConversation,
			...resolveAgentOutputTransitionDetectionForAgentId("omp"),
		};
	},
};

// 按 agent 绑定的「从 PTY 输出推断状态迁移」检测器。与启动参数无关，只由 agentId 决定，因此集中在一张表：
// 新 spawn（各 adapter 的 PreparedAgentLaunch）与热重启后接管仍在跑的会话（不经 prepareAgentLaunch）
// 都从这里取，保证两条路径挂的是同一套检测器。不在表里的 agent 没有输出检测，只靠 hook 与 scanForStalls。
const AGENT_OUTPUT_TRANSITION_DETECTION_BY_AGENT_ID: Readonly<
	Partial<
		Record<RuntimeAgentId, Pick<PreparedAgentLaunch, "detectOutputTransition" | "shouldInspectOutputForTransition">>
	>
> = {
	claude: {
		detectOutputTransition: claudePromptDetector,
		shouldInspectOutputForTransition: shouldInspectClaudeOutputForTransition,
	},
	codex: {
		detectOutputTransition: codexPromptDetector,
		shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
	},
	kimi: {
		detectOutputTransition: kimiPromptDetector,
		shouldInspectOutputForTransition: shouldInspectKimiOutputForTransition,
	},
	// 状态判定读 OSC 终端标题（omp 把三态编码在标题分隔符里），比 cursor/kiro/droid 那种
	// 「只能靠 scanForStalls 兜底」结构化得多；身份扩展不参与这个状态判定。
	// 不设 shouldInspectOutputForTransition：缺省即恒扫，spinner 帧本来就要被看到。
	omp: {
		detectOutputTransition: detectOmpTerminalTitleStateTransition,
	},
};

export function resolveAgentOutputTransitionDetectionForAgentId(
	agentId: RuntimeAgentId,
): Pick<PreparedAgentLaunch, "detectOutputTransition" | "shouldInspectOutputForTransition"> {
	return AGENT_OUTPUT_TRANSITION_DETECTION_BY_AGENT_ID[agentId] ?? {};
}

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	cursor: cursorAdapter,
	gemini: geminiAdapter,
	opencode: opencodeAdapter,
	droid: droidAdapter,
	kiro: kiroAdapter,
	cline: clineAdapter,
	kimi: kimiAdapter,
	omp: ompAdapter,
};

// 合流点查验：adapter 产出的启动参数里是否真的带上了关系邻域注入段。不在 adapter 里逐个上报，是因为「推没推进 argv」
// 散落在各 adapter 的分支里（续跑不重投 prompt、prompt 为空时不拼接、用户已带 --system-prompt 时不追加……），
// 查最终 argv 才是如实的。combineAppendSystemPrompts 会 trim 每一段；codex 以 JSON 字符串字面量放进
// `-c developer_instructions=…`，所以同时认原文与 JSON 转义后的形式。
function doesPreparedAgentLaunchCarryInterWorkUnitRelationNeighborhoodAppendSystemPrompt(
	preparedAgentLaunch: PreparedAgentLaunch,
	interWorkUnitRelationNeighborhoodAppendSystemPrompt: string,
): boolean {
	if (preparedAgentLaunch.carriesInterWorkUnitRelationNeighborhoodAppendSystemPromptOutsideLaunchArgv === true) {
		return true;
	}
	const trimmedAppendSystemPromptText = interWorkUnitRelationNeighborhoodAppendSystemPrompt.trim();
	const jsonStringLiteralEscapedAppendSystemPromptText = JSON.stringify(trimmedAppendSystemPromptText).slice(1, -1);
	const launchTextsThatReachTheAgent = [
		...preparedAgentLaunch.args,
		preparedAgentLaunch.deferredStartupPromptText ?? "",
	];
	return launchTextsThatReachTheAgent.some(
		(launchText) =>
			launchText.includes(trimmedAppendSystemPromptText) ||
			launchText.includes(jsonStringLiteralEscapedAppendSystemPromptText),
	);
}

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	// Exploratory Mode 注入（§A.2）：仅 exploratory 启动物化指令文件；非 exploratory / 物化失败恒为 null。
	const exploratoryModeAppendSystemPrompt = await resolveExploratoryModeAppendSystemPrompt(input.taskConversationMode);
	// dd2db 1b：会话启动时注入工作单元间关系邻域摘要；读不到或超时即不注入，绝不阻断启动。
	// 解析只给文本与「待提交的注入回执」，此刻绝不记账（见下方合流点与 session-manager 的提交点）。
	const interWorkUnitRelationNeighborhoodSessionStartInjection =
		await resolveInterWorkUnitRelationNeighborhoodSessionStartInjection({
			workspaceId: input.workspaceId,
			taskId: input.taskId,
		});
	const interWorkUnitRelationNeighborhoodAppendSystemPrompt =
		interWorkUnitRelationNeighborhoodSessionStartInjection?.interWorkUnitRelationNeighborhoodAppendSystemPromptText ??
		null;
	if (input.agentId !== "codex") {
		warnUnsupportedParentSessionId(input.agentId, input.parentSessionId);
	}
	const preparedAgentLaunch = await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: preparedPrompt,
		exploratoryModeAppendSystemPrompt,
		interWorkUnitRelationNeighborhoodAppendSystemPrompt,
	});
	const commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded =
		interWorkUnitRelationNeighborhoodSessionStartInjection?.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded;
	if (
		!interWorkUnitRelationNeighborhoodAppendSystemPrompt ||
		!commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded ||
		!doesPreparedAgentLaunchCarryInterWorkUnitRelationNeighborhoodAppendSystemPrompt(
			preparedAgentLaunch,
			interWorkUnitRelationNeighborhoodAppendSystemPrompt,
		)
	) {
		return preparedAgentLaunch;
	}
	return { ...preparedAgentLaunch, commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded };
}
