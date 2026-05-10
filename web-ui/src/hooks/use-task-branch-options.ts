import { useMemo } from "react";

import type { RuntimeGitRepositoryInfo } from "@/runtime/types";

interface TaskBranchOption {
	value: string;
	label: string;
}

interface UseTaskBranchOptionsInput {
	workspaceGit: RuntimeGitRepositoryInfo | null;
}

interface UseTaskBranchOptionsResult {
	createTaskBranchOptions: TaskBranchOption[];
	editTaskBranchOptions: TaskBranchOption[];
	defaultTaskBranchRef: string;
	defaultCreateTaskBranchRef: string;
}

export const NEW_TASK_WORKTREE_OPTION_VALUE = "__kanban_new_task_worktree__";

function buildTaskBranchLabel(branch: string, workspaceGit: RuntimeGitRepositoryInfo): string {
	const labels: string[] = [];
	if (branch === workspaceGit.currentBranch) {
		labels.push("current");
	}
	if (labels.length === 0) {
		return branch;
	}
	return `${branch} (${labels.join(", ")})`;
}

export function buildTaskBranchOptions(workspaceGit: RuntimeGitRepositoryInfo | null): TaskBranchOption[] {
	if (!workspaceGit) {
		return [];
	}

	const options: TaskBranchOption[] = [];
	const seen = new Set<string>();
	const append = (value: string | null) => {
		if (!value || seen.has(value)) {
			return;
		}
		seen.add(value);
		options.push({
			value,
			label: buildTaskBranchLabel(value, workspaceGit),
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
	const branchOptions = buildTaskBranchOptions(workspaceGit);
	if (branchOptions.length === 0) {
		return [];
	}
	return [{ value: NEW_TASK_WORKTREE_OPTION_VALUE, label: "New worktree (default)" }, ...branchOptions];
}

export function resolveDefaultTaskBranchRef(
	workspaceGit: RuntimeGitRepositoryInfo | null,
	createTaskBranchOptions: readonly TaskBranchOption[],
): string {
	if (createTaskBranchOptions.length > 0) {
		return createTaskBranchOptions[0]?.value ?? "";
	}
	return workspaceGit?.currentBranch ?? workspaceGit?.defaultBranch ?? "";
}

export function useTaskBranchOptions({ workspaceGit }: UseTaskBranchOptionsInput): UseTaskBranchOptionsResult {
	const createTaskBranchOptions = useMemo(() => {
		return buildCreateTaskBranchOptions(workspaceGit);
	}, [workspaceGit]);

	const editTaskBranchOptions = useMemo(() => {
		return buildTaskBranchOptions(workspaceGit);
	}, [workspaceGit]);

	const defaultTaskBranchRef = useMemo(() => {
		return resolveDefaultTaskBranchRef(workspaceGit, editTaskBranchOptions);
	}, [editTaskBranchOptions, workspaceGit]);

	return {
		createTaskBranchOptions,
		editTaskBranchOptions,
		defaultTaskBranchRef,
		defaultCreateTaskBranchRef: createTaskBranchOptions[0]?.value ?? "",
	};
}
