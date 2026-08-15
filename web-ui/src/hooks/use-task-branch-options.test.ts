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

	it("uses the repository default branch even when another branch is listed first", () => {
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

	// 曾经这里写死偏好字面量 "main"，于是默认分支叫别的名字、但仓库里恰好也有一条 main 的项目会被
	// 默默带到错误的基线上。默认分支的解析归 detectGitDefaultBranch，这条断言钉住「不再有字面量」。
	it("prefers the repository default branch over a branch that merely happens to be named main", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "feature/newest",
			defaultBranch: "trunk",
			branches: [{ name: "main" }, { name: "trunk" }, { name: "feature/newest" }],
		});

		expect(resolveDefaultTaskBranchRef(workspaceGit, buildCreateTaskBranchOptions(workspaceGit))).toBe("trunk");
	});

	it("prefers the branch this project most recently created a task from", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "main",
			defaultBranch: "main",
			branches: [{ name: "main" }, { name: "feature/remembered" }],
		});

		expect(
			resolveDefaultTaskBranchRef(workspaceGit, buildCreateTaskBranchOptions(workspaceGit), "feature/remembered"),
		).toBe("feature/remembered");
	});

	it("falls back to the repository default branch when the remembered branch no longer exists", () => {
		const workspaceGit = createWorkspaceGit({
			currentBranch: "main",
			defaultBranch: "main",
			branches: [{ name: "main" }],
		});

		expect(
			resolveDefaultTaskBranchRef(workspaceGit, buildCreateTaskBranchOptions(workspaceGit), "feature/deleted"),
		).toBe("main");
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
