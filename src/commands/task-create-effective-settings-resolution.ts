// `kanban task create` 的「实际会生效的设置」解析：把请求参数、工作区配置与仓库现状合成一份
// 逐字段带来源的回执，外加告警与一枚指纹。
//
// 为什么需要它：这条命令是非交互的纯 JSON 接口，调用方（多数是 agent）提交正文与显式 Plan 选择后建卡，
// 而 base ref、实际会跑哪个 agent、权限档与 worktree 模式仍可能来自默认值。
// 把这些默认值连同「它们各自从哪来」一起回传，是这条命令唯一能让调用方发现「默认值不是我以为的
// 那个」的通道——`--preview` 让它在建卡**之前**可见，真实建卡响应里同样带一份让它在**之后**可见。
//
// 本模块负责事实采集（git 只读探测、PATH 探测、看板扫描）；「事实 → 告警」的映射在纯模块
// `src/core/task-create-warning-derivation.ts` 里，那边可以被纯单测逐条钉住。
import { createHash } from "node:crypto";
import type { RuntimeConfigState } from "../config/runtime-config";
import { assertRuntimeAgentIsNotRetired, getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeCreationResolvedSettings,
	RuntimeGitRepositoryInfo,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	assertCreationPlanModeWasExplicitlySelected,
	resolveCreationStartupSettings,
} from "../core/creation-startup-settings";
import { resolveTaskAgentPermissionModeForAgent } from "../core/task-agent-permission-mode";
import { resolveTaskCreateBaseRef, type TaskCreateBaseRefResolution } from "../core/task-create-base-ref-resolution";
import {
	deriveTaskCreateWarnings,
	findExistingTasksSimilarToRequestedTaskPrompt,
	type TaskCreateWarning,
} from "../core/task-create-warning-derivation";
import { resolveTaskTitle } from "../core/task-title";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import {
	readCreationAgentDefaultModel,
	readCreationAgentDefaultModelWithoutBlockingBacklogCard,
} from "../terminal/creation-agent-default-model";
import { runGit } from "../workspace/git-utils";

/** 某个生效值究竟从哪来的。 */
export type TaskCreateSettingSource =
	/** 这次命令行上显式传了对应的 flag。 */
	| "explicit_flag"
	/** 这个项目上次成功建卡用的选择（目前只有 base ref 走这条）。 */
	| "remembered_project_selection"
	/** 工作区/全局 Kanban 配置里的默认值（`kanban` 设置页改的那些）。 */
	| "workspace_config_default"
	/** 代码里写死的兜底默认值，任何配置都没参与。 */
	| "built_in_default"
	/** 从 prompt 推出来的（标题）。 */
	| "derived_from_prompt"
	/** 从这次调用所处的位置推出来的：省略 --project-path 时的仓库路径、以及由仓库路径查出的 workspaceId。 */
	| "derived_from_invocation_context"
	/** 从仓库当前的 git 状态推出来的（默认分支 / 当前分支 / 第一条分支）。细分见 baseRefProvenance。 */
	| "derived_from_repository_git_state";

export interface TaskCreateResolvedSetting<TValue> {
	value: TValue;
	source: TaskCreateSettingSource;
}

export interface TaskCreateRequestedSettings {
	modelId?: string;
	codexConfigurationProfileId?: string;
	requestedAgentSessionTransport?: RuntimeAgentSessionTransport;
	title?: string | undefined;
	prompt: string;
	baseRef?: string | undefined;
	startInPlanMode?: boolean | undefined;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode | undefined;
	autoReviewEnabled?: boolean | undefined;
	autoReviewMode?: RuntimeTaskAutoReviewMode | undefined;
	agentId?: RuntimeAgentId | undefined;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization | undefined;
	parentSessionId?: string | undefined;
	worktreeMode?: RuntimeTaskWorktreeMode | undefined;
	prepFilePath?: string | undefined;
}

export interface TaskCreateResolvedSettings extends RuntimeCreationResolvedSettings {
	workspaceRepoPath: TaskCreateResolvedSetting<string>;
	/** 项目尚未注册进 Kanban 时为 null（只可能出现在 `--preview` 路径上）。 */
	workspaceId: TaskCreateResolvedSetting<string | null>;
	column: TaskCreateResolvedSetting<"backlog">;
	title: TaskCreateResolvedSetting<string>;
	baseRef: TaskCreateResolvedSetting<string>;
	worktreeMode: TaskCreateResolvedSetting<RuntimeTaskWorktreeMode>;
	taskAgentSessionInitialization: TaskCreateResolvedSetting<RuntimeTaskAgentSessionInitialization | null>;
	parentSessionId: TaskCreateResolvedSetting<string | null>;
	ompAgentSessionTransportForNewTasks: TaskCreateResolvedSetting<
		RuntimeConfigState["ompAgentSessionTransportForNewTasks"]
	>;
	autoReviewEnabled: TaskCreateResolvedSetting<boolean>;
	autoReviewMode: TaskCreateResolvedSetting<RuntimeTaskAutoReviewMode>;
	prepFilePath: TaskCreateResolvedSetting<string | null>;
}

export interface TaskCreateEffectiveSettingsResolution {
	resolvedSettings: TaskCreateResolvedSettings;
	/** 对 resolvedSettings 的**取值部分**做的稳定哈希。来源变化不影响它，值变化一定影响它。 */
	resolvedSettingsFingerprint: string;
	baseRefResolution: TaskCreateBaseRefResolution;
	warnings: TaskCreateWarning[];
	/** = warnings.length > 0。给调用方一个不用遍历数组就能看的判据位。 */
	needsAttention: boolean;
}

export interface TaskCreateEffectiveSettingsResolutionInput {
	workspaceRepoPath: string;
	/** 未注册的项目为 null。 */
	workspaceId: string | null;
	isProjectRegisteredInKanban: boolean;
	/** `--project-path` 有没有被显式传进来。只影响 workspaceRepoPath 那条的 source 是否算「显式」。 */
	wasProjectPathExplicitlyRequested: boolean;
	repositoryGitInfo: RuntimeGitRepositoryInfo;
	/**
	 * 现有看板列。刻意不收整份 RuntimeWorkspaceStateResponse：未注册的项目根本没有看板可读，
	 * 那条路径只能传一个空列表，而要求整份 state 会逼调用方去伪造 sessions/revision 之类无关字段。
	 */
	existingBoardColumns: RuntimeWorkspaceStateResponse["board"]["columns"];
	runtimeConfig: RuntimeConfigState;
	requested: TaskCreateRequestedSettings;
}

/** 参与「疑似重复」扫描的列。trash 与 validation 里的卡片不构成「你可能重复建了」的证据。 */
const BOARD_COLUMN_IDS_SCANNED_FOR_SIMILAR_EXISTING_TASKS = new Set(["backlog", "in_progress", "review"]);

/**
 * 读出 base ref 落后于 `origin/<baseRef>` 多少个提交。
 *
 * **绝不 fetch**：预览是只读命令，联网抓取会让它变慢、变得可能失败、并且在没有网络凭据的环境里
 * 直接卡住。只读本机上次 fetch 留下的 remote ref，因此这个数字的语义是「以你上次 fetch 时看到的
 * 远端为准，本地落后多少」——告警文案必须把这个限定说出来，否则读起来像一句实时保证。
 *
 * 问不出来（没有 remote、没有对应的远端 ref、git 失败）时返回 null 而不是 0：分不清这两者会让
 * 「没法确认」长得像「确认没落后」。
 */
async function readCommitCountBaseRefIsBehindItsRemoteTrackingBranch(
	workspaceRepoPath: string,
	baseRef: string,
): Promise<number | null> {
	if (!baseRef) {
		return null;
	}
	const remoteTrackingRef = `refs/remotes/origin/${baseRef}`;
	const remoteRefExists = await runGit(workspaceRepoPath, ["rev-parse", "--verify", "--quiet", remoteTrackingRef]);
	if (!remoteRefExists.ok || !remoteRefExists.stdout) {
		return null;
	}
	const behindCount = await runGit(workspaceRepoPath, ["rev-list", "--count", `${baseRef}..${remoteTrackingRef}`]);
	if (!behindCount.ok) {
		return null;
	}
	const parsed = Number.parseInt(behindCount.stdout, 10);
	return Number.isInteger(parsed) ? parsed : null;
}

/**
 * 主 checkout 是否有未提交改动。
 *
 * 两种 worktree 模式下这件事的**相关性判据完全不同**，所以这里必须分流：
 *
 *   - `inplace`：agent 就在主 checkout 里干活，baseRef 是什么都不改变这一点。因此无条件查，
 *     且这些改动是 agent **看得见**的（告警文案由 derivation 侧按模式分流，见 worktreeMode 字段）。
 *   - `branch`：只有主 checkout 正停在 baseRef 上时才相关——那是唯一一种「这些改动本可以属于新任务
 *     的起点、却不会进 worktree」的情形。baseRef 被别的 worktree 占着时报 false：与其猜哪个目录
 *     持有它，不如不说；漏报只是少一条提醒，误报会让每次建卡都挂着一条无从处理的告警。
 */
async function readWhetherBaseRefCheckoutHasUncommittedChanges(
	workspaceRepoPath: string,
	baseRef: string,
	currentBranchOfMainCheckout: string | null,
	worktreeMode: RuntimeTaskWorktreeMode,
): Promise<boolean> {
	if (worktreeMode !== "inplace" && (!baseRef || currentBranchOfMainCheckout !== baseRef)) {
		return false;
	}
	const status = await runGit(workspaceRepoPath, ["status", "--porcelain"]);
	return status.ok && status.stdout.length > 0;
}

/**
 * 不参与指纹的字段。
 *
 * `workspaceId` 必须排除：它是「这个项目在 Kanban 里的登记号」，不是「这张卡会怎么建」。而对**尚未
 * 注册**的项目，`--preview` 只能给出 null（预览刻意不注册项目），真实建卡则会先注册再拿到真正的 id
 * ——把它算进指纹，会让「新项目先预览、再带指纹建卡」这条最需要两步确认的路径在**毫无漂移**时也必然
 * fail closed。项目身份已由同在指纹里的 `workspaceRepoPath` 钉死，排除它不会放过任何真实漂移。
 */
const RESOLVED_SETTING_FIELD_NAMES_EXCLUDED_FROM_FINGERPRINT: ReadonlySet<string> = new Set(["workspaceId"]);

/**
 * 指纹只覆盖**取值**，不覆盖 source。
 *
 * 理由：调用方拿指纹是为了确认「我预览时看到的那套设置还是不是这一套」。同一个值从
 * `built_in_default` 变成 `explicit_flag` 并不改变任务会怎么跑，把 source 算进去只会制造
 * 假失配、逼调用方重跑预览。
 */
function computeResolvedSettingsFingerprint(resolvedSettings: TaskCreateResolvedSettings): string {
	const valuesByFieldNameInStableOrder = Object.entries(resolvedSettings)
		.filter(([fieldName]) => !RESOLVED_SETTING_FIELD_NAMES_EXCLUDED_FROM_FINGERPRINT.has(fieldName))
		.map(([fieldName, setting]) => [fieldName, setting.value] as const)
		.sort((left, right) => left[0].localeCompare(right[0]));
	return createHash("sha256").update(JSON.stringify(valuesByFieldNameInStableOrder)).digest("hex").slice(0, 32);
}

export async function resolveTaskCreateEffectiveSettings(
	input: TaskCreateEffectiveSettingsResolutionInput,
): Promise<TaskCreateEffectiveSettingsResolution> {
	const { requested, runtimeConfig, repositoryGitInfo } = input;
	assertCreationPlanModeWasExplicitlySelected(requested.startInPlanMode);

	const rememberedBaseRefForProject = input.workspaceId
		? (runtimeConfig.userInterfacePreferencesSharedAcrossBrowserOrigins.mostRecentlyUsedTaskCreateBaseRefByProjectId[
				input.workspaceId
			] ?? null)
		: null;
	const baseRefResolution = resolveTaskCreateBaseRef({
		explicitlyRequestedBaseRef: requested.baseRef ?? null,
		rememberedBaseRefForProject,
		repository: repositoryGitInfo,
	});

	const effectiveAgentId = requested.agentId ?? runtimeConfig.selectedAgentId;
	assertRuntimeAgentIsNotRetired(effectiveAgentId);
	const requestedPermissionMode = requested.taskAgentPermissionMode ?? "bypass_all_permission_prompts";
	const resolvedPermissionMode = resolveTaskAgentPermissionModeForAgent(effectiveAgentId, requestedPermissionMode);
	if (requested.modelId && !["claude", "codex", "cursor", "kimi", "omp"].includes(effectiveAgentId))
		throw new Error("所选 Agent 暂不支持单次模型覆盖。");
	const defaultModel = await readCreationAgentDefaultModelWithoutBlockingBacklogCard(
		() =>
			readCreationAgentDefaultModel(
				effectiveAgentId,
				input.workspaceRepoPath,
				requested.codexConfigurationProfileId,
				requested.modelId,
			),
		{
			codexConfigurationProfileId: requested.codexConfigurationProfileId,
			taskAgentSessionInitialization: requested.taskAgentSessionInitialization,
		},
	);
	const startupSettings = resolveCreationStartupSettings({
		agentId: effectiveAgentId,
		startInPlanMode: requested.startInPlanMode,
		agentSelectionSource: requested.agentId ? "explicit_request" : "workspace_config_default",
		taskAgentPermissionMode: requested.taskAgentPermissionMode,
		modelId: requested.modelId,
		defaultCodexConfigurationProfileId: defaultModel.codexConfigurationProfileId,
		defaultModelId: defaultModel.modelId,
		codexConfigurationProfileId: requested.codexConfigurationProfileId,
		codexConfigurationPermissionSelectionSource:
			requested.codexConfigurationProfileId && !requested.taskAgentPermissionMode ? "profile" : "task_local",
		requestedAgentSessionTransport: requested.requestedAgentSessionTransport,
		defaultSessionTransport:
			effectiveAgentId === "omp" ? runtimeConfig.ompAgentSessionTransportForNewTasks : undefined,
	});
	const startInPlanMode = startupSettings.startInPlanMode.value;
	const worktreeMode = requested.worktreeMode ?? "branch";

	const resolvedSettings: TaskCreateResolvedSettings = {
		...startupSettings,
		workspaceRepoPath: {
			value: input.workspaceRepoPath,
			source: input.wasProjectPathExplicitlyRequested ? "explicit_flag" : "derived_from_invocation_context",
		},
		workspaceId: { value: input.workspaceId, source: "derived_from_invocation_context" },
		column: { value: "backlog", source: "built_in_default" },
		title: {
			value: resolveTaskTitle(requested.title, requested.prompt),
			source: requested.title?.trim() ? "explicit_flag" : "derived_from_prompt",
		},
		baseRef: {
			value: baseRefResolution.baseRef,
			source:
				baseRefResolution.provenance === "explicitly_requested"
					? "explicit_flag"
					: baseRefResolution.provenance === "remembered_project_selection"
						? "remembered_project_selection"
						: "derived_from_repository_git_state",
		},
		worktreeMode: {
			value: worktreeMode,
			source: requested.worktreeMode === undefined ? "built_in_default" : "explicit_flag",
		},
		taskAgentSessionInitialization: {
			value: requested.taskAgentSessionInitialization ?? null,
			source: requested.taskAgentSessionInitialization === undefined ? "built_in_default" : "explicit_flag",
		},
		parentSessionId: {
			value: requested.parentSessionId ?? null,
			source: requested.parentSessionId === undefined ? "built_in_default" : "explicit_flag",
		},
		ompAgentSessionTransportForNewTasks: {
			value: runtimeConfig.ompAgentSessionTransportForNewTasks,
			source: "workspace_config_default",
		},
		autoReviewEnabled: {
			value: requested.autoReviewEnabled === true,
			source: requested.autoReviewEnabled === undefined ? "built_in_default" : "explicit_flag",
		},
		autoReviewMode: {
			value: requested.autoReviewMode === "pr" ? "pr" : "commit",
			source: requested.autoReviewMode === undefined ? "built_in_default" : "explicit_flag",
		},
		prepFilePath: {
			value: requested.prepFilePath ?? null,
			source: requested.prepFilePath === undefined ? "built_in_default" : "explicit_flag",
		},
	};

	const agentCatalogEntry = getRuntimeAgentCatalogEntry(effectiveAgentId);
	const effectiveAgentBinary = agentCatalogEntry?.binary ?? "";
	const [commitCountBaseRefIsBehindItsRemoteTrackingBranch, baseRefCheckoutHasUncommittedChanges] = await Promise.all([
		readCommitCountBaseRefIsBehindItsRemoteTrackingBranch(input.workspaceRepoPath, baseRefResolution.baseRef),
		readWhetherBaseRefCheckoutHasUncommittedChanges(
			input.workspaceRepoPath,
			baseRefResolution.baseRef,
			repositoryGitInfo.currentBranch,
			worktreeMode,
		),
	]);

	const warnings = deriveTaskCreateWarnings({
		workspaceRepoPath: input.workspaceRepoPath,
		baseRefResolution,
		repositoryDefaultBranch: repositoryGitInfo.defaultBranch,
		commitCountBaseRefIsBehindItsRemoteTrackingBranch,
		baseRefCheckoutHasUncommittedChanges,
		effectiveAgentId,
		effectiveAgentBinary,
		// 无法解析 binary 时保留未知态，不误报为未安装。
		isEffectiveAgentBinaryInstalledOnPath: !effectiveAgentBinary || isBinaryAvailableOnPath(effectiveAgentBinary),
		startInPlanMode,
		resolvedPermissionMode,
		worktreeMode,
		similarExistingTasks: findExistingTasksSimilarToRequestedTaskPrompt({
			requestedTitle: resolvedSettings.title.value,
			requestedPrompt: requested.prompt,
			existingTasks: input.existingBoardColumns
				.filter((column) => BOARD_COLUMN_IDS_SCANNED_FOR_SIMILAR_EXISTING_TASKS.has(column.id))
				.flatMap((column) =>
					column.cards.map((card) => ({
						taskId: card.id,
						title: card.title,
						prompt: card.prompt,
						columnId: column.id,
					})),
				),
		}),
		isProjectRegisteredInKanban: input.isProjectRegisteredInKanban,
	});

	return {
		resolvedSettings,
		resolvedSettingsFingerprint: computeResolvedSettingsFingerprint(resolvedSettings),
		baseRefResolution,
		warnings,
		needsAttention: warnings.length > 0,
	};
}
