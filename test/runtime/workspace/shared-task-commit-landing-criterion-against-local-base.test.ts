import { describe, expect, it } from "vitest";

import { evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits } from "../../../src/workspace/shared-task-commit-landing-criterion-against-local-base";

describe("evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits", () => {
	it("is satisfied only when every task-owned non-merge commit is matched, exact SHA first then stable patch-id", () => {
		const evaluation = evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits({
			taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: [
				{ commitSha: "task-a", stablePatchId: "patch-a" },
				{ commitSha: "task-b", stablePatchId: "patch-b" },
			],
			localBaseRefCommits: [
				{ commitSha: "base-unrelated", stablePatchId: "patch-unrelated" },
				{ commitSha: "base-cherry-picked-b", stablePatchId: "patch-b" },
				{ commitSha: "task-a", stablePatchId: "patch-a" },
			],
		});

		expect(evaluation.sharedTaskCommitLandingCriterionOutcome).toBe(
			"all_task_owned_non_merge_commits_integrated_into_local_base",
		);
		expect(evaluation.taskCommitsIntegratedIntoBaseRef).toEqual([
			{
				taskCommitSha: "task-a",
				taskCommitStablePatchId: "patch-a",
				taskCommitIntegrationIntoBaseRefMatchKind: "exact_commit_sha",
				matchedBaseRefCommitSha: "task-a",
			},
			{
				taskCommitSha: "task-b",
				taskCommitStablePatchId: "patch-b",
				taskCommitIntegrationIntoBaseRefMatchKind: "stable_patch_id_equivalent",
				matchedBaseRefCommitSha: "base-cherry-picked-b",
			},
		]);
		expect(evaluation.taskCommitsNotIntegratedIntoBaseRef).toEqual([]);
	});

	it("consumes each base commit at most once, so two task commits with the same patch cannot both ride one base commit", () => {
		const evaluation = evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits({
			taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: [
				{ commitSha: "task-first-copy", stablePatchId: "same-patch" },
				{ commitSha: "task-second-copy", stablePatchId: "same-patch" },
			],
			localBaseRefCommits: [{ commitSha: "base-single-copy", stablePatchId: "same-patch" }],
		});

		expect(evaluation.sharedTaskCommitLandingCriterionOutcome).toBe(
			"task_owned_non_merge_commits_partially_integrated_into_local_base",
		);
		expect(evaluation.taskCommitsNotIntegratedIntoBaseRef).toEqual([
			{ commitSha: "task-second-copy", stablePatchId: "same-patch" },
		]);
	});

	it("never matches a commit without a patch-id by patch-id", () => {
		const evaluation = evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits({
			taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: [{ commitSha: "task-empty", stablePatchId: null }],
			localBaseRefCommits: [{ commitSha: "base-empty", stablePatchId: null }],
		});

		expect(evaluation.sharedTaskCommitLandingCriterionOutcome).toBe(
			"no_task_owned_non_merge_commit_integrated_into_local_base",
		);
	});

	it("treats an empty task-owned set as 'produced no commits', never as landed", () => {
		const evaluation = evaluateSharedTaskCommitLandingCriterionAgainstLocalBaseCommits({
			taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: [],
			localBaseRefCommits: [{ commitSha: "base-anything", stablePatchId: "patch" }],
		});

		expect(evaluation.sharedTaskCommitLandingCriterionOutcome).toBe(
			"no_task_owned_non_merge_commit_reachable_from_last_known_task_head",
		);
	});
});
