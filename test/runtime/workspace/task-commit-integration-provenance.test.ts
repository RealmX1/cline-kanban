import { describe, expect, it } from "vitest";

import { countTaskCommitsIntegratedIntoBaseRef } from "../../../src/workspace/task-commit-integration-provenance";

describe("countTaskCommitsIntegratedIntoBaseRef", () => {
	it("优先按 exact SHA 匹配，再用 stable patch-id 匹配改写后的提交", () => {
		const result = countTaskCommitsIntegratedIntoBaseRef({
			observedTaskCommits: [
				{ commitSha: "task-exact", stablePatchId: "patch-exact" },
				{ commitSha: "task-rewritten", stablePatchId: "patch-rewritten" },
				{ commitSha: "task-pending", stablePatchId: "patch-pending" },
			],
			baseRefCommits: [
				{ commitSha: "task-exact", stablePatchId: "patch-exact" },
				{ commitSha: "base-rewritten", stablePatchId: "patch-rewritten" },
			],
		});

		expect(result).toEqual({
			integratedTaskCommitCount: 2,
			exactHashMatchedTaskCommitShas: ["task-exact"],
			patchIdMatchedTaskCommitShas: ["task-rewritten"],
		});
	});

	it("同一个 base commit 不能被多个具有相同 patch-id 的 task commits 重复计数", () => {
		const result = countTaskCommitsIntegratedIntoBaseRef({
			observedTaskCommits: [
				{ commitSha: "task-1", stablePatchId: "same-patch" },
				{ commitSha: "task-2", stablePatchId: "same-patch" },
			],
			baseRefCommits: [{ commitSha: "base-1", stablePatchId: "same-patch" }],
		});

		expect(result.integratedTaskCommitCount).toBe(1);
		expect(result.patchIdMatchedTaskCommitShas).toEqual(["task-1"]);
	});

	it("没有 patch-id 的 merge commit 只允许 exact SHA 匹配", () => {
		const result = countTaskCommitsIntegratedIntoBaseRef({
			observedTaskCommits: [
				{ commitSha: "merge-exact", stablePatchId: null },
				{ commitSha: "merge-rewritten", stablePatchId: null },
			],
			baseRefCommits: [
				{ commitSha: "merge-exact", stablePatchId: null },
				{ commitSha: "different-merge", stablePatchId: null },
			],
		});

		expect(result).toEqual({
			integratedTaskCommitCount: 1,
			exactHashMatchedTaskCommitShas: ["merge-exact"],
			patchIdMatchedTaskCommitShas: [],
		});
	});
});
