// 建卡前「哪些生效设置可能不是调用方预期的」——纯派生，不碰 git、不碰文件系统、不发请求。
//
// 存在理由：`kanban task create` 是非交互的纯 JSON 命令，agent 传个 `--prompt` 就建卡，而 base ref、
// 实际会跑哪个 agent、权限档（默认是**全放行**）、plan 起步、worktree 模式全部由服务端默认值静默决定。
// 建出来的卡不符合预期时，agent 唯一能察觉的时机是任务已经在跑之后。
//
// 事实采集（git / PATH / 看板扫描）刻意留在 `src/commands/task-create-effective-settings-resolution.ts`，
// 这里只做「事实 → 告警」的映射，于是每一条判据都能被纯单测钉住。
import type { RuntimeAgentId, RuntimeBoardColumnId, RuntimeTaskWorktreeMode } from "./api-contract";
import type { ResolvedTaskAgentPermissionMode } from "./task-agent-permission-mode";
import {
	doesPlanModeStartOverridePermissionModeForAgent,
	doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest,
} from "./task-agent-permission-mode";
import type { TaskCreateBaseRefResolution } from "./task-create-base-ref-resolution";

export type TaskCreateWarningCode =
	| "base_ref_is_not_repository_default_branch"
	| "base_ref_came_from_remembered_project_selection"
	| "remembered_base_ref_no_longer_exists"
	| "base_ref_is_behind_its_remote_tracking_branch"
	| "base_ref_checkout_has_uncommitted_changes"
	| "resolved_agent_binary_is_not_installed"
	| "plan_mode_start_overrides_permission_mode_on_this_agent"
	| "resolved_permission_mode_widens_permissions_beyond_request"
	| "task_will_run_with_all_permission_prompts_bypassed"
	| "worktree_mode_inplace_edits_the_main_checkout"
	| "similar_task_already_exists"
	| "project_is_not_registered_in_kanban";

/** 与 `--prompt` 高度相似的既有任务。用于「你可能在重复建卡」这条告警。 */
export interface ExistingTaskSimilarToRequestedTaskPrompt {
	taskId: string;
	title: string;
	columnId: RuntimeBoardColumnId;
	/** 0–1 的归一化分词 Jaccard 相似度。 */
	similarityScore: number;
}

/**
 * 一条告警。`code` 是给程序判据用的稳定标识，`message` 是给人/agent 读的完整句子；除此之外每条各带
 * 自己那几个具名事实，绝不塞一个笼统的 details 袋子——袋子里的键名不会出现在类型上，消费方只能靠猜。
 */
export type TaskCreateWarning =
	| {
			code: "base_ref_is_not_repository_default_branch";
			message: string;
			resolvedBaseRef: string;
			repositoryDefaultBranch: string;
	  }
	| {
			code: "base_ref_came_from_remembered_project_selection";
			message: string;
			resolvedBaseRef: string;
			baseRefThatWouldHaveBeenUsedWithoutTheRememberedSelection: string;
	  }
	| {
			code: "remembered_base_ref_no_longer_exists";
			message: string;
			rememberedBaseRefThatNoLongerExists: string;
			resolvedBaseRef: string;
	  }
	| {
			code: "base_ref_is_behind_its_remote_tracking_branch";
			message: string;
			resolvedBaseRef: string;
			commitCountBehindRemoteTrackingBranch: number;
	  }
	| {
			code: "base_ref_checkout_has_uncommitted_changes";
			message: string;
			resolvedBaseRef: string;
			/**
			 * 这条告警的**含义随模式反转**，所以模式必须在载荷里：`branch` = 这些改动进不了任务
			 * worktree；`inplace` = agent 就在这个 checkout 里干活，会直接在这些改动之上开工。
			 */
			worktreeMode: RuntimeTaskWorktreeMode;
	  }
	| {
			code: "resolved_agent_binary_is_not_installed";
			message: string;
			effectiveAgentId: RuntimeAgentId;
			effectiveAgentBinary: string;
	  }
	| {
			code: "plan_mode_start_overrides_permission_mode_on_this_agent";
			message: string;
			effectiveAgentId: RuntimeAgentId;
			requestedPermissionMode: string;
	  }
	| {
			code: "resolved_permission_mode_widens_permissions_beyond_request";
			message: string;
			effectiveAgentId: RuntimeAgentId;
			requestedPermissionMode: string;
			effectivePermissionMode: string;
	  }
	| {
			code: "task_will_run_with_all_permission_prompts_bypassed";
			message: string;
			effectivePermissionMode: string;
	  }
	| {
			code: "worktree_mode_inplace_edits_the_main_checkout";
			message: string;
			workspaceRepoPath: string;
	  }
	| {
			code: "similar_task_already_exists";
			message: string;
			similarExistingTasks: readonly ExistingTaskSimilarToRequestedTaskPrompt[];
	  }
	| {
			code: "project_is_not_registered_in_kanban";
			message: string;
			workspaceRepoPath: string;
	  };

export interface TaskCreateWarningDerivationFacts {
	workspaceRepoPath: string;
	baseRefResolution: TaskCreateBaseRefResolution;
	repositoryDefaultBranch: string | null;
	/**
	 * base ref 落后于 `origin/<baseRef>` 的提交数。
	 *
	 * null 表示「问不出来」——没有对应的远端跟踪 ref、仓库没有 remote、或 git 命令失败。刻意**不**
	 * 折叠成 0：「确认没落后」与「没法确认」是两件事，后者不该长得像一句安全保证。采集方绝不 fetch，
	 * 只读本机已有的 remote ref，因此这个数只反映上次 fetch 之后的已知差距。
	 */
	commitCountBaseRefIsBehindItsRemoteTrackingBranch: number | null;
	baseRefCheckoutHasUncommittedChanges: boolean;
	effectiveAgentId: RuntimeAgentId;
	effectiveAgentBinary: string;
	isEffectiveAgentBinaryInstalledOnPath: boolean;
	startInPlanMode: boolean;
	resolvedPermissionMode: ResolvedTaskAgentPermissionMode;
	worktreeMode: RuntimeTaskWorktreeMode;
	similarExistingTasks: readonly ExistingTaskSimilarToRequestedTaskPrompt[];
	isProjectRegisteredInKanban: boolean;
}

export function deriveTaskCreateWarnings(facts: TaskCreateWarningDerivationFacts): TaskCreateWarning[] {
	const warnings: TaskCreateWarning[] = [];
	const { baseRefResolution } = facts;
	const resolvedBaseRef = baseRefResolution.baseRef;

	if (!facts.isProjectRegisteredInKanban) {
		warnings.push({
			code: "project_is_not_registered_in_kanban",
			message:
				`Project ${facts.workspaceRepoPath} is not registered in Kanban yet. ` +
				"Creating a task here (without --preview) registers it automatically.",
			workspaceRepoPath: facts.workspaceRepoPath,
		});
	}

	if (baseRefResolution.rememberedBaseRefDiscardedBecauseBranchNoLongerExists) {
		warnings.push({
			code: "remembered_base_ref_no_longer_exists",
			message:
				`This project last created tasks from "${baseRefResolution.rememberedBaseRefDiscardedBecauseBranchNoLongerExists}", ` +
				`but that branch no longer exists. Falling back to "${resolvedBaseRef}".`,
			rememberedBaseRefThatNoLongerExists: baseRefResolution.rememberedBaseRefDiscardedBecauseBranchNoLongerExists,
			resolvedBaseRef,
		});
	}

	if (baseRefResolution.provenance === "remembered_project_selection") {
		const baseRefThatWouldHaveBeenUsedWithoutTheRememberedSelection = facts.repositoryDefaultBranch ?? "";
		warnings.push({
			code: "base_ref_came_from_remembered_project_selection",
			message:
				`Base ref "${resolvedBaseRef}" comes from the branch this project most recently created a task from, ` +
				`not from a flag${
					baseRefThatWouldHaveBeenUsedWithoutTheRememberedSelection
						? ` (without that remembered selection it would be "${baseRefThatWouldHaveBeenUsedWithoutTheRememberedSelection}")`
						: ""
				}. Pass --base-ref explicitly to override it; --base-ref never changes what is remembered.`,
			resolvedBaseRef,
			baseRefThatWouldHaveBeenUsedWithoutTheRememberedSelection,
		});
	}

	if (resolvedBaseRef && facts.repositoryDefaultBranch && resolvedBaseRef !== facts.repositoryDefaultBranch) {
		warnings.push({
			code: "base_ref_is_not_repository_default_branch",
			message:
				`The task worktree will branch off "${resolvedBaseRef}", not the repository default branch ` +
				`"${facts.repositoryDefaultBranch}".`,
			resolvedBaseRef,
			repositoryDefaultBranch: facts.repositoryDefaultBranch,
		});
	}

	const commitCountBehindRemoteTrackingBranch = facts.commitCountBaseRefIsBehindItsRemoteTrackingBranch;
	if (commitCountBehindRemoteTrackingBranch !== null && commitCountBehindRemoteTrackingBranch > 0) {
		warnings.push({
			code: "base_ref_is_behind_its_remote_tracking_branch",
			message:
				`Local "${resolvedBaseRef}" is ${commitCountBehindRemoteTrackingBranch} commit(s) behind ` +
				`"origin/${resolvedBaseRef}" as of the last fetch. The task worktree will start from the local ref.`,
			resolvedBaseRef,
			commitCountBehindRemoteTrackingBranch,
		});
	}

	if (facts.baseRefCheckoutHasUncommittedChanges) {
		warnings.push({
			code: "base_ref_checkout_has_uncommitted_changes",
			message:
				facts.worktreeMode === "inplace"
					? `${facts.workspaceRepoPath} has uncommitted changes, and worktree mode "inplace" puts the agent ` +
						"in that same checkout — it will start on top of them and can modify or commit them."
					: `The checkout holding "${resolvedBaseRef}" has uncommitted changes. They will not be part of the ` +
						"task worktree, and they can make the eventual hand-back harder.",
			resolvedBaseRef,
			worktreeMode: facts.worktreeMode,
		});
	}

	if (!facts.isEffectiveAgentBinaryInstalledOnPath) {
		warnings.push({
			code: "resolved_agent_binary_is_not_installed",
			message:
				`This task will run agent "${facts.effectiveAgentId}", whose binary "${facts.effectiveAgentBinary}" ` +
				"was not found on PATH. Starting the task will fail until it is installed.",
			effectiveAgentId: facts.effectiveAgentId,
			effectiveAgentBinary: facts.effectiveAgentBinary,
		});
	}

	const { resolvedPermissionMode } = facts;
	// 这类 harness（droid 的 autonomyMode 是 spec/normal/auto-high 单轴）勾了 plan 起步就吃掉权限档，
	// 于是**下面两条以权限档为前提的告警在这种组合下都是假的**：任务并不会按 effectivePermissionMode 跑。
	// 一起 gate 掉，只留这一条把真相说清楚——否则默认配置（plan=true + bypass）会同时吐出两条互相矛盾
	// 的安全告警，而更醒目的那条恰好是错的。
	const doesPlanModeStartTakeOverThePermissionAxis =
		facts.startInPlanMode && doesPlanModeStartOverridePermissionModeForAgent(facts.effectiveAgentId);
	if (doesPlanModeStartTakeOverThePermissionAxis) {
		warnings.push({
			code: "plan_mode_start_overrides_permission_mode_on_this_agent",
			message:
				`Agent "${facts.effectiveAgentId}" expresses plan-mode start and permission tier on a single axis, so ` +
				`starting in plan mode overrides the requested "${resolvedPermissionMode.requestedPermissionMode}" tier. ` +
				"The permission tier below is therefore not what this task will actually run with.",
			effectiveAgentId: facts.effectiveAgentId,
			requestedPermissionMode: resolvedPermissionMode.requestedPermissionMode,
		});
	}

	if (
		!doesPlanModeStartTakeOverThePermissionAxis &&
		doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest(resolvedPermissionMode)
	) {
		warnings.push({
			code: "resolved_permission_mode_widens_permissions_beyond_request",
			message:
				`Agent "${facts.effectiveAgentId}" cannot express permission tier ` +
				`"${resolvedPermissionMode.requestedPermissionMode}", so the task will actually run with ` +
				`"${resolvedPermissionMode.effectivePermissionMode}" — wider permissions than requested.`,
			effectiveAgentId: facts.effectiveAgentId,
			requestedPermissionMode: resolvedPermissionMode.requestedPermissionMode,
			effectivePermissionMode: resolvedPermissionMode.effectivePermissionMode,
		});
	}

	// 只要档位真的会生效就报出，即便调用方是显式要求的：这是当前的**默认**档位，而「默认就是全放行」
	// 正是最容易让调用方产生错误安全预期的一条。plan 起步吃掉权限轴时不报——那种情况下这句话是假的。
	if (
		!doesPlanModeStartTakeOverThePermissionAxis &&
		resolvedPermissionMode.effectivePermissionMode === "bypass_all_permission_prompts"
	) {
		warnings.push({
			code: "task_will_run_with_all_permission_prompts_bypassed",
			message:
				"This task will run with all agent permission prompts bypassed. Pass " +
				"--task-agent-permission-mode ask_for_every_tool_use or auto_approve_file_edits_only to narrow it.",
			effectivePermissionMode: resolvedPermissionMode.effectivePermissionMode,
		});
	}

	if (facts.worktreeMode === "inplace") {
		warnings.push({
			code: "worktree_mode_inplace_edits_the_main_checkout",
			message:
				`Worktree mode "inplace" means the agent edits ${facts.workspaceRepoPath} directly instead of an ` +
				"isolated task worktree.",
			workspaceRepoPath: facts.workspaceRepoPath,
		});
	}

	if (facts.similarExistingTasks.length > 0) {
		warnings.push({
			code: "similar_task_already_exists",
			message:
				`${facts.similarExistingTasks.length} existing task(s) look very similar to this prompt: ` +
				facts.similarExistingTasks.map((task) => `${task.taskId} (${task.columnId}) "${task.title}"`).join(", "),
			similarExistingTasks: facts.similarExistingTasks,
		});
	}

	return warnings;
}

/**
 * 判定「疑似重复建卡」的相似度阈值。
 *
 * 定得偏高（而不是宽松地多报）是有意的：这条告警混在其余告警里输出，误报会稀释掉旁边那些确凿的
 * 条目（比如权限全放行）。宁可漏报几条真重复，也不要让 needsAttention 变成永远为真的噪声位。
 */
const MINIMUM_SIMILARITY_SCORE_TO_REPORT_EXISTING_TASK_AS_DUPLICATE = 0.6;

/** 参与相似度比较的 prompt 前缀长度。超出部分（长 prompt 的细节尾巴）对判重贡献很小、噪声很大。 */
const PROMPT_PREFIX_CHARACTER_COUNT_COMPARED_FOR_SIMILARITY = 400;

function tokenizeTaskTextForSimilarityComparison(text: string): Set<string> {
	return new Set(
		text
			.slice(0, PROMPT_PREFIX_CHARACTER_COUNT_COMPARED_FOR_SIMILARITY)
			.toLowerCase()
			// 按「非字母数字」切分：CJK 无空格分词在这里做不出来，退化成整段一个 token，于是 CJK prompt
			// 只有近乎逐字相同才会判重。这是刻意的保守失败方向——漏报，而不是把不相干的中文卡片判成重复。
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length > 1),
	);
}

function computeJaccardSimilarity(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) {
		return 0;
	}
	let intersectionSize = 0;
	for (const token of left) {
		if (right.has(token)) {
			intersectionSize += 1;
		}
	}
	const unionSize = left.size + right.size - intersectionSize;
	return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export function findExistingTasksSimilarToRequestedTaskPrompt(input: {
	requestedTitle: string;
	requestedPrompt: string;
	existingTasks: readonly { taskId: string; title: string; prompt: string; columnId: RuntimeBoardColumnId }[];
}): ExistingTaskSimilarToRequestedTaskPrompt[] {
	const requestedTokens = tokenizeTaskTextForSimilarityComparison(`${input.requestedTitle} ${input.requestedPrompt}`);
	return input.existingTasks
		.map((existingTask) => ({
			taskId: existingTask.taskId,
			title: existingTask.title,
			columnId: existingTask.columnId,
			similarityScore: computeJaccardSimilarity(
				requestedTokens,
				tokenizeTaskTextForSimilarityComparison(`${existingTask.title} ${existingTask.prompt}`),
			),
		}))
		.filter((candidate) => candidate.similarityScore >= MINIMUM_SIMILARITY_SCORE_TO_REPORT_EXISTING_TASK_AS_DUPLICATE)
		.sort((left, right) => right.similarityScore - left.similarityScore);
}
