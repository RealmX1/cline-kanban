import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { loadWorkspaceContext } from "../../../src/state/workspace-state";
import type { TaskClosureOperation } from "../../../src/task-closure/task-closure-operation-store";
import { ensureTaskWorktreeIfDoesntExist } from "../../../src/workspace/task-worktree";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

export async function createClosurePreservationFixture(requestId = "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF") {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
	const repo = fixture.createNonBareRepository({
		repositoryDirectoryName: "preservation-source",
		initialBranchName: "main",
	});
	writeFileSync(join(repo.repositoryPath, "file.txt"), "base\n");
	repo.commitAllRepositoryFilesAtDate({
		message: "隔离保全初始版本",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	const source = await ensureTaskWorktreeIfDoesntExist({ cwd: repo.repositoryPath, taskId: "abc12", baseRef: "main" });
	if (!source.path) throw new Error(source.error ?? "隔离工作树创建失败");
	writeFileSync(join(source.path, "file.txt"), "staged\n");
	repo.runGit(["add", "file.txt"], { workingDirectoryPath: source.path });
	writeFileSync(join(source.path, "file.txt"), "仅此一份的未暂存成果\n");
	const workspace = await loadWorkspaceContext(repo.repositoryPath);
	const operation: TaskClosureOperation = {
		schemaVersion: 1,
		taskIdentity: { workspaceId: workspace.workspaceId, taskId: "abc12", taskIncarnationCreatedAtEpochMs: 1 },
		workspacePath: repo.repositoryPath,
		sourceWorktreePath: source.path,
		sourceBoardColumnId: "review",
		sourceTaskUpdatedAtEpochMs: 1,
		request: {
			taskId: "abc12",
			closure: {
				closureRequestId: requestId,
				details: { outcome: "delivery_accepted", evidence: [], acceptedDeliverables: [] },
				selectedArtifactRelativePaths: [],
			},
		},
		intent: {
			taskMutationIntentKind: "close_task",
			resolvedKanbanActor: {
				kanbanActorKind: "kanban_cli_invocation_without_task_or_session_environment",
				missingEnvironmentVariableNames: [],
			},
		},
		progress: {
			closureRequestId: requestId,
			phase: "preserving",
			attemptCount: 1,
			lastError: null,
			nextRetryAtEpochMs: null,
			recoveryCondition: null,
		},
		archiveManifest: null,
		closureRecord: null,
		lastAttemptRuntimeInstanceId: null,
		lastRecoveryProbeFingerprint: null,
	};
	return { fixture, repo, sourcePath: source.path, operation };
}
