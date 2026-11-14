import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { registerSharedTaskCommitLandingCriterionSatisfiedObservationSink } from "../../../src/workspace/shared-task-commit-landing-criterion-satisfied-observation-port";
import {
	beginTaskCommitLandingCriterionLiveCaptureActivationGeneration,
	countTaskCommitsIntegratedIntoBaseRef,
	listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation,
	readTaskCommitIntegrationProvenanceVersionsByTaskId,
	recordTaskWorktreeCreationCommitProvenance,
	refreshTaskCommitIntegrationProvenance,
	releaseTaskCommitLandingCriterionLiveCaptureActivationGeneration,
} from "../../../src/workspace/task-commit-integration-provenance";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

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

describe("探针声明的 provenance 版本", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("没有写回时绑定读取当时的条目，并与列表版本读取一致", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const workspaceId = "provenance-version-read-binding";
		const taskId = "task-2";
		const directory = getWorkspaceDirectoryPath(workspaceId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "task-commit-integration-provenance.json"),
			JSON.stringify({
				schemaVersion: 1,
				tasks: {
					[taskId]: {
						taskId,
						baseRef: "main",
						incarnations: [
							{
								incarnationId: "floor:1",
								initialBaseCommit: "a".repeat(40),
								captureSource: "worktree_creation",
								startedAt: 1,
								observedTaskCommits: [],
							},
						],
						lastWorkspaceGitSnapshot: {
							path: "/isolated/task-2",
							headCommit: "b".repeat(40),
							baseRefTipCommit: "a".repeat(40),
							commitsAheadOfBaseRef: 1,
							commitsBehindBaseRef: 0,
							taskCommitsIntegratedIntoBaseRef: 4,
							isDetached: false,
							observedAt: 40,
						},
					},
				},
			}),
		);
		let established: string | null | undefined;
		const status = await refreshTaskCommitIntegrationProvenance({
			workspaceId,
			taskId,
			repoPath: "/isolated/repo",
			worktreePath: "/isolated/task-2",
			baseRef: "main",
			worktreeExists: false,
			headCommit: null,
			baseRefTipCommit: null,
			commitsAheadOfBaseRef: null,
			commitsBehindBaseRef: null,
			isDetached: false,
			onEstablishedTaskCommitIntegrationProvenanceVersion: (version) => {
				established = version;
			},
		});
		expect(status).toMatchObject({ taskCommitsIntegratedIntoBaseRef: 4, observedAt: 40 });
		expect(established).toBe(
			(await readTaskCommitIntegrationProvenanceVersionsByTaskId(workspaceId, [taskId])).get(taskId),
		);
	});

	it("写回后绑定锁内写出的条目，外部随后改写文件不会改变已声明版本", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const workspaceId = "provenance-version-write-binding";
		const taskId = "task-2";
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "provenance-version-write-binding",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n");
		repository.runGit(["add", "base.txt"]);
		repository.runGit(["commit", "--quiet", "-m", "base"]);
		const initialBaseCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		const worktreePath = repository.createLinkedWorktree({
			worktreeDirectoryName: "task-2",
			branchName: "task-2",
		}).worktreePath;
		writeFileSync(join(worktreePath, "task.txt"), "task\n");
		repository.runGit(["add", "task.txt"], { workingDirectoryPath: worktreePath });
		repository.runGit(["commit", "--quiet", "-m", "task"], { workingDirectoryPath: worktreePath });
		await recordTaskWorktreeCreationCommitProvenance({
			workspaceId,
			taskId,
			baseRef: "main",
			initialBaseCommit,
		});
		const headCommit = repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: worktreePath }).stdout.trim();
		const baseRefTipCommit = repository.runGit(["rev-parse", "main"]).stdout.trim();
		const [behind, ahead] = repository
			.runGit(["rev-list", "--left-right", "--count", "main...HEAD"], { workingDirectoryPath: worktreePath })
			.stdout.trim()
			.split(/\s+/)
			.map(Number);
		let established: string | null | undefined;
		const status = await refreshTaskCommitIntegrationProvenance({
			workspaceId,
			taskId,
			repoPath: repository.repositoryPath,
			worktreePath,
			baseRef: "main",
			worktreeExists: true,
			headCommit,
			baseRefTipCommit,
			commitsAheadOfBaseRef: ahead ?? null,
			commitsBehindBaseRef: behind ?? null,
			isDetached: false,
			observedAt: 40,
			onEstablishedTaskCommitIntegrationProvenanceVersion: (version) => {
				established = version;
			},
		});
		const written = (await readTaskCommitIntegrationProvenanceVersionsByTaskId(workspaceId, [taskId])).get(taskId);
		expect(status.taskCommitIntegrationTrackingStatus).toBe("complete");
		expect(established).toBe(written);
		expect(established).not.toBeNull();
		writeFileSync(
			join(getWorkspaceDirectoryPath(workspaceId), "task-commit-integration-provenance.json"),
			JSON.stringify({ schemaVersion: 1, tasks: {} }),
		);
		expect(
			(await readTaskCommitIntegrationProvenanceVersionsByTaskId(workspaceId, [taskId])).get(taskId),
		).toBeUndefined();
		expect(established).toBe(written);
	});
});

describe("激活补发资格", () => {
	afterEach(() => {
		registerSharedTaskCommitLandingCriterionSatisfiedObservationSink(null);
		beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
		vi.unstubAllEnvs();
	});

	function historicalEntry(taskId: string, observedAt: number) {
		const commit = { commitSha: "c".repeat(40), stablePatchId: null };
		return {
			taskId,
			baseRef: "main",
			incarnations: [
				{
					incarnationId: "old-incarnation",
					initialBaseCommit: "a".repeat(40),
					captureSource: "worktree_creation" as const,
					startedAt: 1,
					observedTaskCommits: [commit],
				},
			],
			lastWorkspaceGitSnapshot: {
				path: `/isolated/${taskId}`,
				headCommit: commit.commitSha,
				baseRefTipCommit: commit.commitSha,
				commitsAheadOfBaseRef: 0,
				commitsBehindBaseRef: 0,
				taskCommitsIntegratedIntoBaseRef: 1,
				isDetached: false,
				taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: [commit],
				observedAt,
			},
		};
	}

	it("同一毫秒和更晚的历史快照在本代没有求值时仍可补发", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const workspaceId = "historical-backfill-clock-boundary";
		const now = Date.now();
		const directory = getWorkspaceDirectoryPath(workspaceId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "task-commit-integration-provenance.json"),
			JSON.stringify({
				schemaVersion: 1,
				tasks: {
					same: historicalEntry("same", now),
					later: historicalEntry("later", now + 60_000),
					beforeLandingData: {
						...historicalEntry("before", now - 1),
						lastWorkspaceGitSnapshot: {
							...historicalEntry("before", now - 1).lastWorkspaceGitSnapshot,
							taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: undefined,
						},
					},
				},
			}),
		);
		try {
			beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
			const selected =
				await listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(workspaceId);
			expect(selected.map((entry) => entry.taskId).sort()).toEqual(["later", "same"]);
		} finally {
			fixture.cleanup();
		}
	});

	it("只跳过本代已经求值的任务，下一次激活仍补发该历史快照", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		try {
			const workspaceId = "historical-backfill-evaluated-generation";
			const taskId = "live01";
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "historical-backfill-evaluated-generation",
				initialBranchName: "main",
			});
			writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n");
			repository.runGit(["add", "base.txt"]);
			repository.runGit(["commit", "--quiet", "-m", "base"]);
			const initialBaseCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
			const worktreePath = repository.createLinkedWorktree({
				worktreeDirectoryName: "live01",
				branchName: "live01",
			}).worktreePath;
			writeFileSync(join(worktreePath, "task.txt"), "task\n");
			repository.runGit(["add", "task.txt"], { workingDirectoryPath: worktreePath });
			repository.runGit(["commit", "--quiet", "-m", "task"], { workingDirectoryPath: worktreePath });
			await recordTaskWorktreeCreationCommitProvenance({
				workspaceId,
				taskId,
				baseRef: "main",
				initialBaseCommit,
			});
			const headCommit = repository
				.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: worktreePath })
				.stdout.trim();
			const baseRefTipCommit = repository.runGit(["rev-parse", "main"]).stdout.trim();
			const [behind, ahead] = repository
				.runGit(["rev-list", "--left-right", "--count", "main...HEAD"], { workingDirectoryPath: worktreePath })
				.stdout.trim()
				.split(/\s+/)
				.map(Number);
			const refresh = () =>
				refreshTaskCommitIntegrationProvenance({
					workspaceId,
					taskId,
					repoPath: repository.repositoryPath,
					worktreePath,
					baseRef: "main",
					worktreeExists: true,
					headCommit,
					baseRefTipCommit,
					commitsAheadOfBaseRef: ahead ?? null,
					commitsBehindBaseRef: behind ?? null,
					isDetached: false,
				});
			await refresh();
			const provenancePath = join(getWorkspaceDirectoryPath(workspaceId), "task-commit-integration-provenance.json");
			const persisted = JSON.parse(readFileSync(provenancePath, "utf8")) as {
				schemaVersion: number;
				tasks: Record<string, unknown>;
			};
			persisted.tasks.later = historicalEntry("later", Date.now() + 60_000);
			writeFileSync(provenancePath, JSON.stringify(persisted));
			beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
			registerSharedTaskCommitLandingCriterionSatisfiedObservationSink({
				recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking: () => undefined,
			});
			expect(
				(await listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(workspaceId))
					.map((entry) => entry.taskId)
					.sort(),
			).toEqual(["later", taskId]);
			await refresh();
			expect(
				(await listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(workspaceId)).map(
					(entry) => entry.taskId,
				),
			).toEqual(["later"]);
			beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
			expect(
				(await listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(workspaceId))
					.map((entry) => entry.taskId)
					.sort(),
			).toEqual(["later", taskId]);
		} finally {
			fixture.cleanup();
		}
	});

	it("写盘失败或求值抛错都不登记本代求值，历史补发资格保留", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const writeSpy = vi.spyOn(lockedFileSystem, "writeJsonFileAtomic");
		try {
			const workspaceId = "historical-backfill-failed-evaluation";
			const taskId = "fail01";
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "historical-backfill-failed-evaluation",
				initialBranchName: "main",
			});
			writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n");
			repository.runGit(["add", "base.txt"]);
			repository.runGit(["commit", "--quiet", "-m", "base"]);
			const initialBaseCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
			const worktreePath = repository.createLinkedWorktree({
				worktreeDirectoryName: "fail01",
				branchName: "fail01",
			}).worktreePath;
			writeFileSync(join(worktreePath, "task.txt"), "task\n");
			repository.runGit(["add", "task.txt"], { workingDirectoryPath: worktreePath });
			repository.runGit(["commit", "--quiet", "-m", "task"], { workingDirectoryPath: worktreePath });
			const headCommit = repository
				.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: worktreePath })
				.stdout.trim();
			const readBaseRefTipCommit = () => repository.runGit(["rev-parse", "main"]).stdout.trim();
			const baseRefTipCommit = readBaseRefTipCommit();
			const [behind, ahead] = repository
				.runGit(["rev-list", "--left-right", "--count", "main...HEAD"], { workingDirectoryPath: worktreePath })
				.stdout.trim()
				.split(/\s+/)
				.map(Number);
			const commit = { commitSha: headCommit, stablePatchId: null };
			const directory = getWorkspaceDirectoryPath(workspaceId);
			mkdirSync(directory, { recursive: true });
			const provenancePath = join(directory, "task-commit-integration-provenance.json");
			writeFileSync(
				provenancePath,
				JSON.stringify({
					schemaVersion: 1,
					tasks: {
						[taskId]: {
							taskId,
							baseRef: "main",
							incarnations: [
								{
									incarnationId: "existing-incarnation",
									initialBaseCommit,
									captureSource: "worktree_creation",
									startedAt: 1,
									observedTaskCommits: [commit],
								},
							],
							lastWorkspaceGitSnapshot: {
								path: worktreePath,
								headCommit,
								baseRefTipCommit,
								commitsAheadOfBaseRef: ahead,
								commitsBehindBaseRef: behind,
								taskCommitsIntegratedIntoBaseRef: 0,
								isDetached: false,
								taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: [commit],
								observedAt: 50,
							},
						},
						later: historicalEntry("later", Date.now() + 60_000),
					},
				}),
			);
			const originalBytes = readFileSync(provenancePath, "utf8");
			const selectedTaskIds = async () =>
				(await listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(workspaceId))
					.map((entry) => entry.taskId)
					.sort();
			const refresh = (worktreeExists: boolean, tipCommit: string) =>
				refreshTaskCommitIntegrationProvenance({
					workspaceId,
					taskId,
					repoPath: repository.repositoryPath,
					worktreePath,
					baseRef: "main",
					worktreeExists,
					headCommit: worktreeExists ? headCommit : null,
					baseRefTipCommit: tipCommit,
					commitsAheadOfBaseRef: worktreeExists ? (ahead ?? null) : null,
					commitsBehindBaseRef: worktreeExists ? (behind ?? null) : null,
					isDetached: false,
				});
			beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
			let reportedObservations = 0;
			registerSharedTaskCommitLandingCriterionSatisfiedObservationSink({
				recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking() {
					reportedObservations += 1;
				},
			});
			expect(await selectedTaskIds()).toEqual([taskId, "later"]);

			writeSpy.mockRejectedValue(Object.assign(new Error("隔离注入的原子写EIO"), { code: "EIO" }));
			for (const worktreeExists of [false, true]) {
				await expect(refresh(worktreeExists, baseRefTipCommit)).rejects.toMatchObject({ code: "EIO" });
				expect(reportedObservations).toBe(0);
				expect(readFileSync(provenancePath, "utf8")).toBe(originalBytes);
				expect(await selectedTaskIds()).toEqual([taskId, "later"]);
			}

			writeSpy.mockRestore();
			repository.runGit(["merge", "--ff-only", "fail01"]);
			const integratedBaseRefTipCommit = readBaseRefTipCommit();
			registerSharedTaskCommitLandingCriterionSatisfiedObservationSink({
				recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking() {
					throw new Error("隔离注入的求值上报失败");
				},
			});
			for (const worktreeExists of [false, true]) {
				await expect(refresh(worktreeExists, integratedBaseRefTipCommit)).rejects.toThrow("隔离注入的求值上报失败");
				expect(await selectedTaskIds()).toEqual([taskId, "later"]);
			}

			registerSharedTaskCommitLandingCriterionSatisfiedObservationSink({
				recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking() {
					reportedObservations += 1;
				},
			});
			await refresh(false, integratedBaseRefTipCommit);
			expect(reportedObservations).toBe(1);
			expect(await selectedTaskIds()).toEqual(["later"]);
		} finally {
			writeSpy.mockRestore();
			fixture.cleanup();
		}
	});

	it("启动补发结束后释放本代登记，旧代收尾保留新代，释放后不再新增", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		try {
			const workspaceId = "historical-backfill-registration-retention";
			const taskId = "keep01";
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "historical-backfill-registration-retention",
				initialBranchName: "main",
			});
			writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n");
			repository.runGit(["add", "base.txt"]);
			repository.runGit(["commit", "--quiet", "-m", "base"]);
			const initialBaseCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
			const worktreePath = repository.createLinkedWorktree({
				worktreeDirectoryName: "keep01",
				branchName: "keep01",
			}).worktreePath;
			writeFileSync(join(worktreePath, "task.txt"), "task\n");
			repository.runGit(["add", "task.txt"], { workingDirectoryPath: worktreePath });
			repository.runGit(["commit", "--quiet", "-m", "task"], { workingDirectoryPath: worktreePath });
			await recordTaskWorktreeCreationCommitProvenance({
				workspaceId,
				taskId,
				baseRef: "main",
				initialBaseCommit,
			});
			const headCommit = repository
				.runGit(["rev-parse", "HEAD"], { workingDirectoryPath: worktreePath })
				.stdout.trim();
			const baseRefTipCommit = repository.runGit(["rev-parse", "main"]).stdout.trim();
			const [behind, ahead] = repository
				.runGit(["rev-list", "--left-right", "--count", "main...HEAD"], { workingDirectoryPath: worktreePath })
				.stdout.trim()
				.split(/\s+/)
				.map(Number);
			const refresh = () =>
				refreshTaskCommitIntegrationProvenance({
					workspaceId,
					taskId,
					repoPath: repository.repositoryPath,
					worktreePath,
					baseRef: "main",
					worktreeExists: true,
					headCommit,
					baseRefTipCommit,
					commitsAheadOfBaseRef: ahead ?? null,
					commitsBehindBaseRef: behind ?? null,
					isDetached: false,
				});
			await refresh();
			const provenancePath = join(getWorkspaceDirectoryPath(workspaceId), "task-commit-integration-provenance.json");
			const persisted = JSON.parse(readFileSync(provenancePath, "utf8")) as {
				tasks: Record<string, unknown>;
			};
			persisted.tasks.later = historicalEntry("later", Date.now() + 60_000);
			writeFileSync(provenancePath, JSON.stringify(persisted));
			const selectedTaskIds = async () =>
				(await listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(workspaceId))
					.map((entry) => entry.taskId)
					.sort();
			registerSharedTaskCommitLandingCriterionSatisfiedObservationSink({
				recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking: () => undefined,
			});

			const firstGeneration = beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
			expect(await selectedTaskIds()).toEqual([taskId, "later"]);
			await refresh();
			expect(await selectedTaskIds()).toEqual(["later"]);

			const secondGeneration = beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
			expect(await selectedTaskIds()).toEqual([taskId, "later"]);
			await refresh();
			expect(await selectedTaskIds()).toEqual(["later"]);
			releaseTaskCommitLandingCriterionLiveCaptureActivationGeneration(firstGeneration);
			expect(await selectedTaskIds()).toEqual(["later"]);
			releaseTaskCommitLandingCriterionLiveCaptureActivationGeneration(secondGeneration);
			expect(await selectedTaskIds()).toEqual([taskId, "later"]);
			await refresh();
			expect(await selectedTaskIds()).toEqual([taskId, "later"]);

			beginTaskCommitLandingCriterionLiveCaptureActivationGeneration();
			expect(await selectedTaskIds()).toEqual([taskId, "later"]);
			await refresh();
			expect(await selectedTaskIds()).toEqual(["later"]);
		} finally {
			fixture.cleanup();
		}
	});
});
