import { resolveTaskCreateBaseRef, type TaskCreateBaseRefProvenance } from "@runtime-task-create-base-ref-resolution";
import { useMemo } from "react";

import type { RuntimeGitBranch, RuntimeGitRepositoryInfo } from "@/runtime/types";

interface TaskBranchOption {
	value: string;
	label: string;
}

interface UseTaskBranchOptionsInput {
	workspaceGit: RuntimeGitRepositoryInfo | null;
	/**
	 * 当前项目上次成功建卡所用的 base ref（跨 origin 界面偏好里记的那份）。
	 *
	 * 只影响**建卡**的默认值。编辑既有卡片时下拉框显示的是那张卡自己的 baseRef，与记忆无关。
	 */
	rememberedTaskCreateBaseRefForCurrentProject?: string | null;
}

interface UseTaskBranchOptionsResult {
	createTaskBranchOptions: TaskBranchOption[];
	editTaskBranchOptions: TaskBranchOption[];
	/** 编辑既有卡片时的回落值：不看记忆，纯按仓库自身解析。 */
	defaultTaskBranchRef: string;
	/** 建卡对话框的默认值：记忆值优先（前提是那条分支还在）。 */
	defaultCreateTaskBranchRef: string;
	/** defaultCreateTaskBranchRef 来自哪条规则，用于对话框上的说明文案。 */
	defaultCreateTaskBranchRefProvenance: TaskCreateBaseRefProvenance | null;
	/** 记忆值指向的分支已消失、因而被丢弃时的那个名字。 */
	rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists: string | null;
}

export const NEW_TASK_WORKTREE_OPTION_VALUE = "__kanban_new_task_worktree__";

function formatBranchLastCommitDate(lastCommitDate: string): string {
	const trimmed = lastCommitDate.trim();
	if (!trimmed) {
		return "";
	}
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(trimmed);
	if (match) {
		return `${match[1]} ${match[2]}`;
	}
	return trimmed;
}

function buildTaskBranchLabel(branch: RuntimeGitBranch, workspaceGit: RuntimeGitRepositoryInfo): string {
	const labels: string[] = [];
	if (branch.name === workspaceGit.currentBranch) {
		labels.push("current");
	}
	if (branch.lastCommitDate) {
		const formattedLastCommitDate = formatBranchLastCommitDate(branch.lastCommitDate);
		if (formattedLastCommitDate) {
			labels.push(`last commit ${formattedLastCommitDate}`);
		}
	}
	if (labels.length === 0) {
		return branch.name;
	}
	return `${branch.name} (${labels.join(", ")})`;
}

export function buildTaskBranchOptions(workspaceGit: RuntimeGitRepositoryInfo | null): TaskBranchOption[] {
	if (!workspaceGit) {
		return [];
	}

	const options: TaskBranchOption[] = [];
	const seen = new Set<string>();
	const append = (branch: RuntimeGitBranch | string | null) => {
		if (!branch) {
			return;
		}
		const branchInfo = typeof branch === "string" ? { name: branch } : branch;
		const value = branchInfo.name.trim();
		if (!value || seen.has(value)) {
			return;
		}
		seen.add(value);
		options.push({
			value,
			label: buildTaskBranchLabel(branchInfo, workspaceGit),
		});
	};

	for (const branch of workspaceGit.branches) {
		append(branch);
	}
	append(workspaceGit.currentBranch);
	append(workspaceGit.defaultBranch);

	return options;
}

export function buildCreateTaskBranchOptions(workspaceGit: RuntimeGitRepositoryInfo | null): TaskBranchOption[] {
	return buildTaskBranchOptions(workspaceGit);
}

/**
 * 建卡 / 编辑卡片的 base ref 默认值——薄封装，规则本体在运行时 core 的
 * `resolveTaskCreateBaseRef`（`@runtime-task-create-base-ref-resolution`）。
 *
 * 之所以不在这里自己写一套：这条规则同时被 CLI `task create` 与服务端快速添加用着，UI 独立实现过
 * 一份「硬偏好字面量 main」的版本，结果同一个项目换条入口建卡就落到不同 base 上。
 *
 * `createTaskBranchOptions` 参数留着是为了**兼容既有调用点**（编辑卡片那条路径按选项列表兜底），
 * 但候选集合本身已由 resolver 从 workspaceGit 推出，两者内容一致。
 */
export function resolveDefaultTaskBranchRef(
	workspaceGit: RuntimeGitRepositoryInfo | null,
	createTaskBranchOptions: readonly TaskBranchOption[],
	rememberedTaskCreateBaseRefForCurrentProject?: string | null,
): string {
	const resolution = resolveTaskCreateBaseRef({
		...(rememberedTaskCreateBaseRefForCurrentProject
			? { rememberedBaseRefForProject: rememberedTaskCreateBaseRefForCurrentProject }
			: {}),
		repository: {
			currentBranch: workspaceGit?.currentBranch ?? null,
			defaultBranch: workspaceGit?.defaultBranch ?? null,
			branches: workspaceGit?.branches ?? [],
		},
	});
	if (resolution.baseRef) {
		return resolution.baseRef;
	}
	// workspaceGit 尚未加载完（branches 为空）但选项已由别处铺好时的兜底。
	return createTaskBranchOptions[0]?.value ?? "";
}

export function useTaskBranchOptions({
	workspaceGit,
	rememberedTaskCreateBaseRefForCurrentProject,
}: UseTaskBranchOptionsInput): UseTaskBranchOptionsResult {
	const createTaskBranchOptions = useMemo(() => {
		return buildCreateTaskBranchOptions(workspaceGit);
	}, [workspaceGit]);

	const editTaskBranchOptions = useMemo(() => {
		return buildTaskBranchOptions(workspaceGit);
	}, [workspaceGit]);

	const defaultTaskBranchRef = useMemo(() => {
		return resolveDefaultTaskBranchRef(workspaceGit, editTaskBranchOptions);
	}, [editTaskBranchOptions, workspaceGit]);

	const createTaskBaseRefResolution = useMemo(() => {
		return resolveTaskCreateBaseRef({
			...(rememberedTaskCreateBaseRefForCurrentProject
				? { rememberedBaseRefForProject: rememberedTaskCreateBaseRefForCurrentProject }
				: {}),
			repository: {
				currentBranch: workspaceGit?.currentBranch ?? null,
				defaultBranch: workspaceGit?.defaultBranch ?? null,
				branches: workspaceGit?.branches ?? [],
			},
		});
	}, [rememberedTaskCreateBaseRefForCurrentProject, workspaceGit]);

	return {
		createTaskBranchOptions,
		editTaskBranchOptions,
		defaultTaskBranchRef,
		defaultCreateTaskBranchRef: createTaskBaseRefResolution.baseRef || (createTaskBranchOptions[0]?.value ?? ""),
		defaultCreateTaskBranchRefProvenance: createTaskBaseRefResolution.provenance,
		rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists:
			createTaskBaseRefResolution.rememberedBaseRefDiscardedBecauseBranchNoLongerExists,
	};
}
