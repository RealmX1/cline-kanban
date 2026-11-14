import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as waitForIdleObservation } from "node:timers/promises";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeProjectsResponse,
	RuntimeTaskWorkspaceGitStatusesResponse,
} from "../../src/core/api-contract";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const execFileAsync = promisify(execFile);

it("打包实例的Git查询并发、变更、断开与冷启动保持新鲜，并可记录同规模前后资源对照", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const repository = fixture.createNonBareRepository({
		repositoryDirectoryName: "git-query-project",
		initialBranchName: "main",
	});
	writeFileSync(join(repository.repositoryPath, "base.txt"), "base\n");
	repository.runGit(["add", "."]);
	repository.runGit(["commit", "--quiet", "-m", "初始提交"]);
	const initialCommit = repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
	const cards: RuntimeBoardCard[] = [];
	const worktreePaths: string[] = [];
	for (let index = 0; index < 12; index += 1) {
		const id = `a${index.toString(16).padStart(4, "0")}`;
		const path = join(
			fixture.isolatedHomeDirectoryPath,
			".cline",
			"worktrees",
			id,
			basename(repository.repositoryPath),
		);
		mkdirSync(join(path, ".."), { recursive: true });
		const linked = repository.createLinkedWorktree({
			worktreeDirectoryName: id,
			branchName: `task-${id}`,
			startPoint: initialCommit,
		});
		await symlink(linked.worktreePath, path, "dir");
		writeFileSync(join(path, "task.txt"), `任务${index}\n`);
		repository.runGit(["add", "."], { workingDirectoryPath: path });
		repository.runGit(["commit", "--quiet", "-m", `任务提交${index}`], { workingDirectoryPath: path });
		cards.push({
			id,
			title: id,
			prompt: "隔离Git查询",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: index + 1,
			updatedAt: index + 1,
		});
		worktreePaths.push(path);
	}
	const packaged = join(fixture.fixtureRootDirectoryPath, "packaged-git-query-runtime");
	await mkdir(join(packaged, "web-ui/assets"), { recursive: true });
	await writeFile(join(packaged, "package.json"), JSON.stringify({ type: "module" }));
	await writeFile(join(packaged, "web-ui/index.html"), "<!doctype html><title>隔离Git查询</title>");
	await symlink(resolve("node_modules"), join(packaged, "node_modules"), "dir");
	for (const worker of [
		"notifications/notification-lifecycle-database-worker.mjs",
		"inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
	])
		await copyFile(resolve("src", worker), join(packaged, basename(worker)));
	const candidateCli = join(packaged, "cli.js");
	await build({
		entryPoints: {
			cli: resolve("src/cli.ts"),
			"agent-session-pty-host": resolve(
				"src/agent-session-pty-host/host-process/agent-session-pty-host-process-entry.ts",
			),
		},
		outdir: packaged,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: ["node-pty", "better-sqlite3", "@napi-rs/keyring", "sharp"],
		define: { "process.env.NODE_ENV": '"production"' },
		banner: {
			js: 'import { createRequire as createGitQueryTestRequire } from "node:module"; const require = createGitQueryTestRequire(import.meta.url);',
		},
	});
	const variants = [
		...(process.env.KANBAN_GIT_QUERY_BASELINE_CLI_PATH
			? [{ name: "baseline", cli: process.env.KANBAN_GIT_QUERY_BASELINE_CLI_PATH }]
			: []),
		{ name: "candidate", cli: candidateCli },
	];
	const reports: unknown[] = [];
	for (const variant of variants) {
		rmSync(join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban"), { recursive: true, force: true });
		const provenance: Record<string, unknown> = {};
		for (const card of cards)
			provenance[card.id] = {
				taskId: card.id,
				baseRef: "main",
				incarnations: [
					{
						incarnationId: `creation-${card.id}`,
						initialBaseCommit: initialCommit,
						captureSource: "worktree_creation",
						startedAt: 1,
						observedTaskCommits: [],
					},
				],
				lastWorkspaceGitSnapshot: null,
			};
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
		await new Promise<void>((done) => reservation.close(() => done()));
		const env = fixture.createIsolatedChildProcessEnvironment(
			{
				NODE_ENV: "test",
				KANBAN_AGENT_SESSION_PTY_HOST_MODE: "disabled",
				KANBAN_RUNTIME_PORT: String(address.port),
				CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-configuration"),
				CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-storage"),
			},
			{ gitTrace2EventOutputFileName: `${variant.name}-trace.jsonl` },
		);
		let child: ChildProcess | null = null;
		const startRuntime = async () => {
			const processHandle = spawn(
				process.execPath,
				[
					variant.cli,
					"--host",
					"127.0.0.1",
					"--port",
					String(address.port),
					"--no-open",
					"--skip-shutdown-cleanup",
				],
				{ cwd: repository.repositoryPath, env, stdio: ["ignore", "pipe", "pipe"] },
			);
			child = processHandle;
			await waitForRuntimeServerStartupBannerOrSigkillChild(processHandle);
		};
		await startRuntime();
		try {
			let workspaceId = "";
			const query = async <T>(procedure: string, input?: unknown, signal?: AbortSignal): Promise<T> => {
				const url = new URL(`http://127.0.0.1:${address.port}/api/trpc/${procedure}`);
				if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
				const response = await fetch(url, {
					headers: { "x-kanban-workspace-id": workspaceId },
					signal: signal ?? AbortSignal.timeout(30_000),
				});
				expect(response.status).toBe(200);
				return ((await response.json()) as { result: { data: T } }).result.data;
			};
			const projects = await query<RuntimeProjectsResponse>("projects.list");
			workspaceId = projects.projects[0].id;
			const directory = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban", "workspaces", workspaceId);
			mkdirSync(directory, { recursive: true });
			const board: RuntimeBoardData = {
				columns: ["backlog", "in_progress", "review", "validation", "trash"].map((id) => ({
					id: id as RuntimeBoardData["columns"][number]["id"],
					title: id,
					cards:
						id === "review"
							? cards.slice(0, 6)
							: id === "in_progress"
								? cards.slice(6, 10)
								: id === "trash"
									? cards.slice(10)
									: [],
				})),
			};
			writeFileSync(join(directory, "board.json"), JSON.stringify(board));
			writeFileSync(
				join(directory, "task-commit-integration-provenance.json"),
				JSON.stringify({ schemaVersion: 1, tasks: provenance }),
			);
			const taskIds = cards.slice(0, 6).map((card) => card.id);
			const readStatuses = () =>
				query<RuntimeTaskWorkspaceGitStatusesResponse>(
					"workspace.getTaskWorkspaceGitStatuses",
					variant.name === "baseline" ? undefined : { taskIds },
				);
			const traceEvents = (): Array<{ event: string; argv?: string[] }> => {
				if (!existsSync(String(env.GIT_TRACE2_EVENT))) return [];
				return readFileSync(String(env.GIT_TRACE2_EVENT), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
			};
			const nativeSnapshot = async (): Promise<Record<string, number> | null> => {
				const script = process.env.KANBAN_GIT_QUERY_NATIVE_RESOURCE_SNAPSHOT_SCRIPT_PATH;
				if (!script || process.platform !== "darwin") return null;
				const result = await execFileAsync("python3", [script, String(child?.pid)], { env, timeout: 10_000 });
				return JSON.parse(result.stdout);
			};
			const phases: unknown[] = [];
			const measure = async (name: string, run: () => Promise<void>) => {
				const beforeNative = await nativeSnapshot();
				const before = traceEvents().length;
				const started = performance.now();
				await run();
				const elapsedMs = performance.now() - started;
				const events = traceEvents()
					.slice(before)
					.filter((event) => event.event === "start");
				const afterNative = await nativeSnapshot();
				if (beforeNative && afterNative)
					expect(afterNative.startedAbsoluteTime).toBe(beforeNative.startedAbsoluteTime);
				phases.push({
					name,
					elapsedMs,
					gitProcessStarts: events.length,
					gitArguments: events.map((event) => event.argv),
					beforeNative,
					afterNative,
				});
				return events.length;
			};
			await measure("cold", async () => {
				const result = await readStatuses();
				for (const id of taskIds)
					expect(result.taskWorkspaceGitStatuses[id]).toMatchObject({
						commitsAheadOfBaseRef: 1,
						commitsBehindBaseRef: 0,
						taskCommitIntegrationTrackingStatus: "complete",
					});
			});
			await measure("provenance-version-reconciliation", async () => {
				await readStatuses();
			});
			const stableStarts = await measure("stable-eight-reads", async () => {
				for (let index = 0; index < 8; index += 1) await readStatuses();
			});
			if (variant.name === "candidate") expect(stableStarts).toBeLessThanOrEqual(8);
			await measure("four-concurrent-reads", async () => {
				await Promise.all(Array.from({ length: 4 }, readStatuses));
			});
			const idleStarts = await measure("idle-without-subscriber", async () => {
				await waitForIdleObservation(1_000);
			});
			expect(idleStarts).toBe(0);
			if (variant.name === "candidate") {
				const dotGit = join(worktreePaths[0], ".git");
				const originalGitPointer = readFileSync(dotGit, "utf8");
				try {
					writeFileSync(dotGit, `gitdir: ${join(fixture.fixtureRootDirectoryPath, "missing-git-directory")}\n`);
					expect(
						(await readStatuses()).taskWorkspaceGitStatuses[taskIds[0]].taskCommitIntegrationTrackingStatus,
					).toBe("git_probe_unavailable");
				} finally {
					writeFileSync(dotGit, originalGitPointer);
				}
				expect(
					(await readStatuses()).taskWorkspaceGitStatuses[taskIds[0]].taskCommitIntegrationTrackingStatus,
				).toBe("complete");
				const firstPath = worktreePaths[0];
				writeFileSync(join(firstPath, "task.txt"), "任务新增内容\n");
				repository.runGit(["add", "."], { workingDirectoryPath: firstPath });
				repository.runGit(["commit", "--quiet", "-m", "任务第二个提交"], { workingDirectoryPath: firstPath });
				await measure("head-change", async () => {
					expect((await readStatuses()).taskWorkspaceGitStatuses[taskIds[0]].commitsAheadOfBaseRef).toBe(2);
				});
				writeFileSync(join(repository.repositoryPath, "base-next.txt"), "base next\n");
				repository.runGit(["add", "."]);
				repository.runGit(["commit", "--quiet", "-m", "base推进"]);
				await measure("base-change", async () => {
					expect((await readStatuses()).taskWorkspaceGitStatuses[taskIds[0]].commitsBehindBaseRef).toBe(1);
				});
				const provenanceFile = join(directory, "task-commit-integration-provenance.json");
				const validProvenance = readFileSync(provenanceFile, "utf8");
				const incomplete = JSON.parse(validProvenance);
				incomplete.tasks[taskIds[1]].incarnations = [];
				try {
					writeFileSync(provenanceFile, JSON.stringify(incomplete));
					expect(
						(await readStatuses()).taskWorkspaceGitStatuses[taskIds[1]].taskCommitIntegrationTrackingStatus,
					).toBe("task_commit_ownership_history_incomplete");
				} finally {
					writeFileSync(provenanceFile, validProvenance);
				}
				expect(
					(await readStatuses()).taskWorkspaceGitStatuses[taskIds[1]].taskCommitIntegrationTrackingStatus,
				).toBe("complete");
				const controller = new AbortController();
				const abandoned = query("workspace.getTaskWorkspaceGitStatuses", { taskIds }, controller.signal);
				controller.abort();
				await expect(abandoned).rejects.toThrow();
				expect((await readStatuses()).taskWorkspaceGitStatuses[taskIds[0]].commitsAheadOfBaseRef).toBe(2);
				if (child) await sigkillChildProcessAndWaitForExit(child);
				child = null;
				await startRuntime();
				await measure("restart", async () => {
					expect((await readStatuses()).taskWorkspaceGitStatuses[taskIds[0]]).toMatchObject({
						commitsAheadOfBaseRef: 2,
						commitsBehindBaseRef: 1,
					});
				});
				const cli = await execFileAsync(
					process.execPath,
					[variant.cli, "task", "list", "--project-path", repository.repositoryPath, "--column", "review"],
					{ env, timeout: 30_000, maxBuffer: 2 ** 20 },
				);
				expect(JSON.parse(cli.stdout)).toMatchObject({ count: 6, column: "review" });
			}
			reports.push({ variant: variant.name, projectCount: 1, totalTaskCount: 12, selectedTaskCount: 6, phases });
			const output = process.env.KANBAN_GIT_QUERY_RESOURCE_EVIDENCE_DIRECTORY;
			if (output) {
				mkdirSync(output, { recursive: true });
				writeFileSync(join(output, `${variant.name}-git-trace.jsonl`), readFileSync(String(env.GIT_TRACE2_EVENT)));
				writeFileSync(join(output, "git-query-resource-comparison.json"), `${JSON.stringify(reports, null, 2)}\n`);
			}
		} finally {
			if (child) await sigkillChildProcessAndWaitForExit(child);
		}
	}
}, 120_000);
