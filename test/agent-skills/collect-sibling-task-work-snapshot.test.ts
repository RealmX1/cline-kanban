import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createTempDir } from "../utilities/temp-dir";

const surveySkillDirectoryPath = fileURLToPath(
	new URL("../../.codex/skills/cline-kanban-survey-sibling-task-work-in-same-workspace", import.meta.url),
);
const snapshotCollectorScriptPath = join(surveySkillDirectoryPath, "scripts", "collect-sibling-task-work-snapshot.mjs");
const agentSkillInstallerScriptPath = fileURLToPath(
	new URL("../../scripts/install-globally-invocable-cline-kanban-agent-skills.mjs", import.meta.url),
);

interface SiblingTaskRecord {
	taskId: string;
	column: string | null;
	promptExcerpt: string;
	sessionActive: boolean;
	worktreePresent: boolean;
	headContainedInLocalBase: boolean | null;
	commitsAheadOfLocalBase: { oid: string; subject: string }[];
	committedPaths: string[];
	uncommittedPaths: string[];
	uncommittedPathCount: number;
	uncommittedReadStatus: string;
}

interface SiblingTaskWorkSnapshot {
	schemaVersion: number;
	workspaceId: string | null;
	taskInventorySource: string;
	taskInventoryDegraded: boolean;
	siblingTaskCount: number;
	siblingTasks: SiblingTaskRecord[];
	degradations: { stage: string; reason: string }[];
}

function writeExecutableKanbanCliStub(stubPath: string, taskListJson: unknown): void {
	// kanban CLI 会把完整 JSON 写到 stdout；桩必须同样按文件描述符写，才能复刻真实调用形态。
	writeFileSync(
		stubPath,
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(taskListJson, null, 2)}\n`)});\n`,
	);
	chmodSync(stubPath, 0o755);
}

function findSiblingTask(snapshot: SiblingTaskWorkSnapshot, taskId: string): SiblingTaskRecord {
	const record = snapshot.siblingTasks.find((siblingTask) => siblingTask.taskId === taskId);
	if (!record) throw new Error(`快照里没有 sibling task ${taskId}`);
	return record;
}

describe("sibling task work snapshot collector", () => {
	it("采集同 workspace 其它任务的在办工作，且不改动它们的 worktree", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(() => fixture.cleanup());
		const projectRepository = fixture.createNonBareRepository({
			repositoryDirectoryName: "project",
			initialBranchName: "main",
		});
		writeFileSync(join(projectRepository.repositoryPath, "baseline.txt"), "baseline\n");
		projectRepository.commitAllRepositoryFilesAtDate({
			message: "baseline",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});

		const aheadWorktree = projectRepository.createLinkedWorktree({
			worktreeDirectoryName: "alpha1",
			branchName: "task-alpha",
		});
		const landedWorktree = projectRepository.createLinkedWorktree({
			worktreeDirectoryName: "beta22",
			branchName: "task-beta",
		});
		const dirtyWorktree = projectRepository.createLinkedWorktree({
			worktreeDirectoryName: "gamma3",
			branchName: "task-gamma",
		});
		const selfWorktree = projectRepository.createLinkedWorktree({
			worktreeDirectoryName: "selfxx",
			branchName: "task-self",
		});
		const taskWorktreeRootPath = dirname(aheadWorktree.worktreePath);

		writeFileSync(join(aheadWorktree.worktreePath, "shared-surface.txt"), "changed by alpha\n");
		projectRepository.runGit(["add", "shared-surface.txt"], { workingDirectoryPath: aheadWorktree.worktreePath });
		projectRepository.runGit(["commit", "-m", "alpha 的未落地提交"], {
			workingDirectoryPath: aheadWorktree.worktreePath,
		});
		writeFileSync(join(dirtyWorktree.worktreePath, "work-in-progress.txt"), "gamma 正在改\n");

		const temporaryDirectory = createTempDir("kanban-sibling-survey-");
		onTestFinished(() => temporaryDirectory.cleanup());
		const workspacesDirectoryPath = join(temporaryDirectory.path, "kanban", "workspaces");
		mkdirSync(workspacesDirectoryPath, { recursive: true });
		writeFileSync(
			join(workspacesDirectoryPath, "index.json"),
			JSON.stringify({
				version: 1,
				entries: { project: { workspaceId: "project", repoPath: projectRepository.repositoryPath } },
			}),
		);
		const kanbanCliStubPath = join(temporaryDirectory.path, "kanban-cli-stub.mjs");
		writeExecutableKanbanCliStub(kanbanCliStubPath, {
			ok: true,
			tasks: [
				{ id: "alpha1", column: "in_progress", prompt: "改 shared-surface", session: { state: "idle" } },
				{ id: "beta22", column: "review", prompt: "已经落地的工作", session: null },
				{
					id: "gamma3",
					column: "in_progress",
					prompt: "正在改 work-in-progress",
					session: { state: "running", liveness: "live" },
				},
				{ id: "selfxx", column: "in_progress", prompt: "本任务自己", session: { state: "running" } },
			],
			dependencies: [],
		});

		const worktreeAdministrativeIndexPaths = new Map(
			["alpha1", "beta22", "gamma3"].map((worktreeName) => [
				worktreeName,
				join(projectRepository.repositoryPath, ".git", "worktrees", worktreeName, "index"),
			]),
		);
		const administrativeIndexBytesBefore = new Map(
			[...worktreeAdministrativeIndexPaths].map(([name, path]) => [name, readFileSync(path)]),
		);

		const collectorStdout = execFileSync(
			process.execPath,
			[
				snapshotCollectorScriptPath,
				"--project-path",
				projectRepository.repositoryPath,
				"--self-task-id",
				"selfxx",
				"--base-ref",
				"main",
				"--kanban-cli",
				kanbanCliStubPath,
				"--cline-home",
				temporaryDirectory.path,
				"--task-worktree-root",
				taskWorktreeRootPath,
			],
			{ cwd: selfWorktree.worktreePath, encoding: "utf8", env: fixture.createIsolatedChildProcessEnvironment() },
		);
		const snapshot = JSON.parse(collectorStdout) as SiblingTaskWorkSnapshot;

		expect(snapshot.schemaVersion).toBe(1);
		expect(snapshot.taskInventorySource).toBe("KANBAN_CLI");
		expect(snapshot.taskInventoryDegraded).toBe(false);
		expect(snapshot.workspaceId).toBe("project");
		expect(snapshot.degradations).toEqual([]);
		expect(snapshot.siblingTasks.map((siblingTask) => siblingTask.taskId)).toEqual(["alpha1", "beta22", "gamma3"]);

		const aheadTask = findSiblingTask(snapshot, "alpha1");
		expect(aheadTask.headContainedInLocalBase).toBe(false);
		expect(aheadTask.commitsAheadOfLocalBase).toHaveLength(1);
		expect(aheadTask.commitsAheadOfLocalBase[0]?.subject).toBe("alpha 的未落地提交");
		expect(aheadTask.committedPaths).toEqual(["shared-surface.txt"]);

		const landedTask = findSiblingTask(snapshot, "beta22");
		expect(landedTask.headContainedInLocalBase).toBe(true);
		expect(landedTask.commitsAheadOfLocalBase).toEqual([]);

		const dirtyTask = findSiblingTask(snapshot, "gamma3");
		expect(dirtyTask.sessionActive).toBe(true);
		expect(dirtyTask.uncommittedReadStatus).toBe("READ");
		expect(dirtyTask.uncommittedPaths).toEqual(["work-in-progress.txt"]);
		expect(dirtyTask.uncommittedPathCount).toBe(1);

		for (const [worktreeName, administrativeIndexPath] of worktreeAdministrativeIndexPaths) {
			expect(readFileSync(administrativeIndexPath)).toEqual(administrativeIndexBytesBefore.get(worktreeName));
		}
		expect(landedWorktree.worktreePath).toContain("beta22");
	});

	it("kanban CLI 不可用时降级到 git worktree 证据，而不是报告没有其它任务", () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(() => fixture.cleanup());
		const projectRepository = fixture.createNonBareRepository({
			repositoryDirectoryName: "project",
			initialBranchName: "main",
		});
		writeFileSync(join(projectRepository.repositoryPath, "baseline.txt"), "baseline\n");
		projectRepository.commitAllRepositoryFilesAtDate({
			message: "baseline",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const siblingWorktree = projectRepository.createLinkedWorktree({
			worktreeDirectoryName: "delta4",
			branchName: "task-delta",
		});
		const temporaryDirectory = createTempDir("kanban-sibling-survey-degraded-");
		onTestFinished(() => temporaryDirectory.cleanup());

		const collectorStdout = execFileSync(
			process.execPath,
			[
				snapshotCollectorScriptPath,
				"--project-path",
				projectRepository.repositoryPath,
				"--self-task-id",
				"not-a-real-task",
				"--kanban-cli",
				join(temporaryDirectory.path, "missing-kanban-cli"),
				"--cline-home",
				temporaryDirectory.path,
				"--task-worktree-root",
				dirname(siblingWorktree.worktreePath),
			],
			{
				cwd: projectRepository.repositoryPath,
				encoding: "utf8",
				env: fixture.createIsolatedChildProcessEnvironment(),
			},
		);
		const snapshot = JSON.parse(collectorStdout) as SiblingTaskWorkSnapshot;

		expect(snapshot.taskInventorySource).toBe("GIT_WORKTREE_ONLY");
		expect(snapshot.taskInventoryDegraded).toBe(true);
		expect(snapshot.degradations.length).toBeGreaterThan(0);
		expect(snapshot.siblingTasks.map((siblingTask) => siblingTask.taskId)).toEqual(["delta4"]);
	});
});

describe("globally invocable agent skill installer", () => {
	function runInstallerFromCheckoutShape(options: { checkoutPath: string; gitEntryIsFile: boolean }): {
		exitCode: number;
		combinedOutput: string;
	} {
		mkdirSync(join(options.checkoutPath, "scripts"), { recursive: true });
		if (options.gitEntryIsFile) {
			writeFileSync(join(options.checkoutPath, ".git"), "gitdir: /elsewhere/.git/worktrees/task\n");
		} else {
			mkdirSync(join(options.checkoutPath, ".git"), { recursive: true });
		}
		const installedScriptPath = join(
			options.checkoutPath,
			"scripts",
			"install-globally-invocable-cline-kanban-agent-skills.mjs",
		);
		copyFileSync(agentSkillInstallerScriptPath, installedScriptPath);
		try {
			const stdout = execFileSync(process.execPath, [installedScriptPath, "--dry-run"], {
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: options.checkoutPath },
			});
			return { exitCode: 0, combinedOutput: stdout };
		} catch (error) {
			const failure = error as { status?: number; stdout?: string; stderr?: string };
			return { exitCode: failure.status ?? -1, combinedOutput: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
		}
	}

	it("拒绝从 linked worktree 形态的 checkout 安装", () => {
		const temporaryDirectory = createTempDir("kanban-agent-skill-installer-worktree-shape-");
		onTestFinished(() => temporaryDirectory.cleanup());
		const result = runInstallerFromCheckoutShape({
			checkoutPath: join(temporaryDirectory.path, "linked-worktree-shape"),
			gitEntryIsFile: true,
		});
		expect(result.exitCode).toBe(2);
		expect(result.combinedOutput).toContain("AGENT_SKILL_INSTALL_STATUS=REFUSED");
		expect(result.combinedOutput).toContain("linked git worktree");
	});

	it("拒绝从 cline 任务 worktree 路径下安装", () => {
		const temporaryDirectory = createTempDir("kanban-agent-skill-installer-task-path-");
		onTestFinished(() => temporaryDirectory.cleanup());
		const result = runInstallerFromCheckoutShape({
			checkoutPath: join(temporaryDirectory.path, ".cline", "worktrees", "task1", "cline-kanban"),
			gitEntryIsFile: false,
		});
		expect(result.exitCode).toBe(2);
		expect(result.combinedOutput).toContain("AGENT_SKILL_INSTALL_STATUS=REFUSED");
		expect(result.combinedOutput).toContain("cline 任务 worktree");
	});
});
