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
		branches: ["feature/newest", "bugfix/recent", "main", "release/old"],
		...overrides,
	};
}

describe("use-task-branch-options", () => {
	it("keeps branch options in repository-provided recency order while defaulting to main", () => {
		const workspaceGit = createWorkspaceGit();

		const options = buildTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "feature/newest", label: "feature/newest (current)" },
			{ value: "bugfix/recent", label: "bugfix/recent" },
			{ value: "main", label: "main" },
			{ value: "release/old", label: "release/old" },
		]);
		expect(resolveDefaultTaskBranchRef(workspaceGit, options)).toBe("main");
	});

	it("uses real refs for task creation options", () => {
		const workspaceGit = createWorkspaceGit();

		const options = buildCreateTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "feature/newest", label: "feature/newest (current)" },
			{ value: "bugfix/recent", label: "bugfix/recent" },
			{ value: "main", label: "main" },
			{ value: "release/old", label: "release/old" },
		]);
		expect(options.some((option) => option.value === NEW_TASK_WORKTREE_OPTION_VALUE)).toBe(false);
	});

	it("appends current and default refs without duplicating branch options", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "detached-worktree-branch",
			defaultBranch: "main",
			branches: ["topic/recent", "main"],
		});

		const options = buildTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "topic/recent", label: "topic/recent" },
			{ value: "main", label: "main" },
			{ value: "detached-worktree-branch", label: "detached-worktree-branch (current)" },
		]);
		expect(resolveDefaultTaskBranchRef(workspaceGit, options)).toBe("main");
	});

	it("uses main as the default even when another branch is listed first", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["feature/recent", "main"],
		});

		const options = buildCreateTaskBranchOptions(workspaceGit);

		expect(options[0]?.value).toBe("feature/recent");
		expect(resolveDefaultTaskBranchRef(workspaceGit, options)).toBe("main");
	});

	it("marks only the active branch as current when it is also the repository default branch", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main", "feature/recent"],
		});

		const options = buildCreateTaskBranchOptions(workspaceGit);

		expect(options).toEqual([
			{ value: "main", label: "main (current)" },
			{ value: "feature/recent", label: "feature/recent" },
		]);
	});
});
