import { describe, expect, it } from "vitest";

import {
	buildCreateTaskBranchOptions,
	buildTaskBranchOptions,
	NEW_TASK_WORKTREE_OPTION_VALUE,
	resolveDefaultTaskBranchRef,
} from "@/hooks/use-task-branch-options";
import type { RuntimeGitRepositoryInfo } from "@/runtime/types";

function createWorkspaceGit(overrides: Partial<RuntimeGitRepositoryInfo> = {}): RuntimeGitRepositoryInfo {
	return {
		currentBranch: "feature/newest",
		defaultBranch: "main",
		branches: [
			{ name: "feature/newest", lastCommitDate: "2026-05-10T10:00:00+08:00" },
			{ name: "bugfix/recent", lastCommitDate: "2026-05-09T09:30:00+08:00" },
			{ name: "main", lastCommitDate: "2026-05-08T18:45:00+08:00" },
			{ name: "release/old" },
		],
		...overrides,
	};
}

describe("use-task-branch-options", () => {
	it("keeps branch options in repository-provided recency order while defaulting to main", () => {
		const workspaceGit = createWorkspaceGit();

		const options = buildTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "feature/newest", label: "feature/newest (current, last commit 2026-05-10 10:00)" },
			{ value: "bugfix/recent", label: "bugfix/recent (last commit 2026-05-09 09:30)" },
			{ value: "main", label: "main (last commit 2026-05-08 18:45)" },
			{ value: "release/old", label: "release/old" },
		]);
		expect(resolveDefaultTaskBranchRef(workspaceGit, options)).toBe("main");
	});

	it("uses real refs for task creation options", () => {
		const workspaceGit = createWorkspaceGit();

		const options = buildCreateTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "feature/newest", label: "feature/newest (current, last commit 2026-05-10 10:00)" },
			{ value: "bugfix/recent", label: "bugfix/recent (last commit 2026-05-09 09:30)" },
			{ value: "main", label: "main (last commit 2026-05-08 18:45)" },
			{ value: "release/old", label: "release/old" },
		]);
		expect(options.some((option) => option.value === NEW_TASK_WORKTREE_OPTION_VALUE)).toBe(false);
	});

	it("appends current and default refs without duplicating branch options", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "detached-worktree-branch",
			defaultBranch: "main",
			branches: [
				{ name: "topic/recent", lastCommitDate: "2026-05-10T08:00:00+08:00" },
				{ name: "main", lastCommitDate: "2026-05-08T18:45:00+08:00" },
			],
		});

		const options = buildTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "topic/recent", label: "topic/recent (last commit 2026-05-10 08:00)" },
			{ value: "main", label: "main (last commit 2026-05-08 18:45)" },
			{ value: "detached-worktree-branch", label: "detached-worktree-branch (current)" },
		]);
		expect(resolveDefaultTaskBranchRef(workspaceGit, options)).toBe("main");
	});

	it("uses main as the default even when another branch is listed first", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "main",
			defaultBranch: "main",
			branches: [
				{ name: "feature/recent", lastCommitDate: "2026-05-07T14:15:00+08:00" },
				{ name: "main", lastCommitDate: "2026-05-08T18:45:00+08:00" },
			],
		});

		const options = buildCreateTaskBranchOptions(workspaceGit);

		expect(options[0]?.value).toBe("feature/recent");
		expect(resolveDefaultTaskBranchRef(workspaceGit, options)).toBe("main");
	});

	it("marks only the active branch as current when it is also the repository default branch", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "main",
			defaultBranch: "main",
			branches: [
				{ name: "main", lastCommitDate: "2026-05-08T18:45:00+08:00" },
				{ name: "feature/recent", lastCommitDate: "2026-05-07T14:15:00+08:00" },
			],
		});

		const options = buildCreateTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "main", label: "main (current, last commit 2026-05-08 18:45)" },
			{ value: "feature/recent", label: "feature/recent (last commit 2026-05-07 14:15)" },
		]);
	});
});
