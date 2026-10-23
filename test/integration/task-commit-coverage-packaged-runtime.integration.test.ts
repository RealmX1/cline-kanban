import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import type {
	RuntimeProjectsResponse,
	RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponse,
} from "../../src/core/api-contract";
import { computeStablePatchId } from "../../src/workspace/git-utils";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

it("隔离打包实例经真实 API 更新部署覆盖，raw worktree 缓存命中不保留旧部署", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const repository = fixture.createNonBareRepository({
		repositoryDirectoryName: "packaged-coverage-project",
		initialBranchName: "main",
	});
	const commit = (name: string) => {
		writeFileSync(join(repository.repositoryPath, name), name);
		repository.runGit(["add", name]);
		repository.runGit(["commit", "--quiet", "-m", name]);
		return repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
	};
	const base = commit("base.txt");
	const first = commit("first.txt");
	const second = commit("second.txt");
	const observedTaskCommits = await Promise.all(
		[first, second].map(async (commitSha) => ({
			commitSha,
			stablePatchId: await computeStablePatchId(repository.repositoryPath, commitSha),
		})),
	);
	const packagedDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-packaged-runtime");
	await mkdir(join(packagedDirectory, "web-ui/assets"), { recursive: true });
	await writeFile(join(packagedDirectory, "package.json"), JSON.stringify({ type: "module" }));
	await writeFile(join(packagedDirectory, "web-ui/index.html"), "<!doctype html><title>隔离部署覆盖验证</title>");
	await symlink(resolve("node_modules"), join(packagedDirectory, "node_modules"), "dir");
	for (const worker of [
		"notifications/notification-lifecycle-database-worker.mjs",
		"inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
	]) {
		await copyFile(resolve("src", worker), join(packagedDirectory, worker.split("/").at(-1) ?? ""));
	}
	const cli = join(packagedDirectory, "cli.js");
	await build({
		entryPoints: [resolve("src/cli.ts")],
		outfile: cli,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: ["node-pty", "better-sqlite3", "@napi-rs/keyring", "sharp"],
		define: { "process.env.NODE_ENV": '"production"' },
		banner: {
			js: 'import { createRequire as createIsolatedCoverageRequire } from "node:module"; const require = createIsolatedCoverageRequire(import.meta.url);',
		},
	});
	const portReservation = createServer();
	await new Promise<void>((done) => portReservation.listen(0, "127.0.0.1", done));
	const address = portReservation.address();
	if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
	await new Promise<void>((done) => portReservation.close(() => done()));
	const child = spawn(
		process.execPath,
		[cli, "--host", "127.0.0.1", "--port", String(address.port), "--no-open", "--skip-shutdown-cleanup"],
		{
			cwd: repository.repositoryPath,
			env: fixture.createIsolatedChildProcessEnvironment({ NODE_ENV: "test" }),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	try {
		await waitForRuntimeServerStartupBannerOrSigkillChild(child);
		const query = async <T>(procedure: string, input?: unknown): Promise<T> => {
			const url = new URL(`http://127.0.0.1:${address.port}/api/trpc/${procedure}`);
			if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
			const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
			expect(response.status).toBe(200);
			const envelope = (await response.json()) as { result: { data: T } };
			return envelope.result.data;
		};
		const projects = await query<RuntimeProjectsResponse>("projects.list");
		const workspaceId: string = projects.projects[0].id;
		const runtimeHome = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban");
		const workspaceDirectory = join(runtimeHome, "workspaces", workspaceId);
		mkdirSync(workspaceDirectory, { recursive: true });
		const taskId = "c0ffe";
		writeFileSync(
			join(workspaceDirectory, "board.json"),
			JSON.stringify({
				columns: [
					{
						id: "in_progress",
						title: "进行中",
						cards: [
							{
								id: taskId,
								title: "仍在进行的任务",
								prompt: "部署部分提交",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			}),
		);
		writeFileSync(
			join(workspaceDirectory, "task-commit-integration-provenance.json"),
			JSON.stringify({
				schemaVersion: 1,
				tasks: {
					[taskId]: {
						taskId,
						baseRef: "main",
						// 模拟 worktree 删除前的完整观测；仅保留明细无法证明最新任务归属完整。
						lastWorkspaceGitSnapshot: {
							path: join(
								fixture.isolatedHomeDirectoryPath,
								".cline",
								"worktrees",
								taskId,
								"packaged-coverage-project",
							),
							headCommit: second,
							baseRefTipCommit: second,
							commitsAheadOfBaseRef: 0,
							commitsBehindBaseRef: 0,
							taskCommitsIntegratedIntoBaseRef: 2,
							isDetached: false,
							taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: observedTaskCommits,
							observedAt: 1,
						},
						incarnations: [
							{
								incarnationId: "first",
								initialBaseCommit: base,
								captureSource: "worktree_creation",
								startedAt: 1,
								observedTaskCommits,
							},
						],
						retainedCommittedLineChangeHistory: {
							summary: {
								status: "complete",
								commitCount: 2,
								additions: 2,
								deletions: 0,
								historyVersion: "retained-two-commits",
								unavailableReason: null,
							},
							commits: [first, second].map((commitSha) => ({
								commitSha,
								subject: "任务提交",
								committedAtMs: 1,
								additions: 1,
								deletions: 0,
							})),
						},
					},
				},
			}),
		);
		const readCoverage = async () => {
			const response: RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponse = await query(
				"projects.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries",
				{ tasks: [{ workspaceId, taskId }] },
			);
			const task = response.tasks[0];
			expect(task?.availability).toBe("available");
			if (task?.availability === "available") {
				expect(task.taskWorkspaceMetadata.workspaceGitStatus).toMatchObject({
					taskCommitIntegrationTrackingStatus: "complete",
					observationSource: "persisted_final_snapshot",
				});
			}
			return task?.availability === "available"
				? task.taskWorkspaceMetadata.taskCommitCoverageInCurrentDeployment
				: null;
		};
		const record = (sha: string, deploymentId: string) =>
			writeFileSync(
				join(runtimeHome, "post-deploy-verification-state.json"),
				JSON.stringify({
					deploymentGroups: [
						{
							workspaceId,
							deploymentId,
							deployedSourceCommit: sha,
							previousDeployedSourceCommit: null,
							deployedAtIso: "2026-10-23T09:00:00.000Z",
							foldedAtIso: null,
							tasks: [],
						},
					],
				}),
			);
		record(first, "10000000-0000-4000-8000-000000000001");
		expect(await readCoverage()).toMatchObject({
			knownTaskCommitCount: 2,
			matchedTaskCommitCountInCurrentDeployment: 1,
		});
		record(base, "10000000-0000-4000-8000-000000000002");
		expect(await readCoverage()).toMatchObject({
			knownTaskCommitCount: 2,
			matchedTaskCommitCountInCurrentDeployment: 0,
		});
		record(second, "10000000-0000-4000-8000-000000000003");
		expect(await readCoverage()).toMatchObject({
			coverageStatus: "all_known_task_commits_in_current_deployment",
			knownTaskCommitCount: 2,
			matchedTaskCommitCountInCurrentDeployment: 2,
		});
	} finally {
		await sigkillChildProcessAndWaitForExit(child);
		fixture.cleanup();
	}
}, 90_000);
