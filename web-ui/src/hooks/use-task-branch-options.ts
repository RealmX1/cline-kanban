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
	defaultTaskBranchRef: string;
}

function buildTaskBranchLabel(branch: string, workspaceGit: RuntimeGitRepositoryInfo): string {
	const labels: string[] = [];
	if (branch === workspaceGit.currentBranch) {
		labels.push("current");
	}
	if (branch === workspaceGit.defaultBranch) {
		labels.push("default");
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
		return buildTaskBranchOptions(workspaceGit);
	}, [workspaceGit]);

	const defaultTaskBranchRef = useMemo(() => {
		return resolveDefaultTaskBranchRef(workspaceGit, createTaskBranchOptions);
	}, [createTaskBranchOptions, workspaceGit]);

	return {
		createTaskBranchOptions,
		defaultTaskBranchRef,
	};
}
