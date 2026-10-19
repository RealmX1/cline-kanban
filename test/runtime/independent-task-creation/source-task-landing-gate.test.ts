import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { independentTaskCreationDraftSchema } from "../../../src/core/independent-task-creation-contract";
import {
	independentTaskCreationArtifactDirectory,
	writeIndependentTaskCreationDraft,
} from "../../../src/independent-task-creation/persisted-creation-draft";
import { assertIndependentTaskSourceLandedBeforeInitialStart } from "../../../src/independent-task-creation/source-task-landing-gate";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const mocked = vi.hoisted(() => ({ board: vi.fn(), landingReady: vi.fn(), probe: vi.fn() }));
vi.mock("../../../src/state/workspace-state", () => ({ loadWorkspaceBoardById: mocked.board }));
vi.mock("../../../src/workspace/task-commit-integration-provenance", () => ({
	probeAndRefreshTaskCommitIntegrationProvenance: mocked.probe,
	readSourceTaskCommitLandingReadiness: mocked.landingReady,
}));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it("Done 和干净工作树仍需共享落地证明；dirty 与清理后补丁会阻止初次启动，授权后恢复不重验来源", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "source", initialBranchName: "main" });
	writeFileSync(join(repository.repositoryPath, "file.txt"), "base");
	repository.commitAllRepositoryFilesAtDate({
		message: "初始版本",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	const requestId = "11111111-1111-4111-8111-111111111111";
	const draft = independentTaskCreationDraftSchema.parse({
		requestId,
		sourceTaskId: "source",
		sourceTaskConversationSessionId: "peer",
		revision: 1,
		status: "created",
		userTaskDescription: "需求",
		suggestedTaskDescription: "需求",
		title: "标题",
		initialPrompt: "需求",
		titleWasEditedByUser: false,
		initialPromptWasEditedByUser: false,
		contextInheritance: "fresh_conversation",
		worktreeSource: "local_main_after_source_task_landed",
		generatedFromDescription: "需求",
		contextCapturedAt: 1,
		contextWarnings: [],
		forkUnavailableReason: null,
		sourceGitStatus: "",
		sourceCommitsNotInLocalMain: 0,
		errorMessage: null,
		createdTaskId: "child",
	});
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "peer",
		state: "idle",
		agentId: "codex",
		workspacePath: repository.repositoryPath,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	});
	await writeIndependentTaskCreationDraft("workspace", {
		draft,
		sourceSummary: summary,
		contextBeforeSideSession: "",
		contextAfterSideSession: "",
		nativeConversationSeed: null,
		reservedTaskId: "child",
		generationAttemptId: null,
	});
	const card = {
		title: "子卡",
		createdAt: 1,
		updatedAt: 1,
		id: "child",
		prompt: "需求",
		startInPlanMode: true,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		independentTaskCreationProvenance: {
			creationRequestId: requestId,
			sourceWorkspaceId: "workspace",
			sourceTaskId: "source",
			sourceTaskConversationSessionId: "peer",
			sourceNativeSessionId: null,
			sourceContextCapturedAt: 1,
			contextInheritance: "fresh_conversation" as const,
			worktreeSource: "local_main_after_source_task_landed" as const,
			contextArtifactDirectory: independentTaskCreationArtifactDirectory("workspace", requestId),
		},
	};
	const check = () =>
		assertIndependentTaskSourceLandedBeforeInitialStart({
			workspaceId: "workspace",
			repoPath: repository.repositoryPath,
			card,
		});
	mocked.board.mockResolvedValue({ columns: [{ id: "in_progress", cards: [{ id: "source" }] }] });
	await expect(check()).rejects.toThrow("尚未完成");
	mocked.board.mockResolvedValue({ columns: [{ id: "trash", cards: [{ id: "source" }] }] });
	mocked.landingReady.mockResolvedValue(false);
	await expect(check()).rejects.toThrow("尚无来源任务成果");
	writeFileSync(join(repository.repositoryPath, "dirty.txt"), "未提交");
	mocked.landingReady.mockResolvedValue(true);
	await expect(check()).rejects.toThrow("未提交修改");
	repository.commitAllRepositoryFilesAtDate({
		message: "落地成果",
		authorAndCommitterIsoDate: "2026-01-02T00:00:00Z",
	});
	const patchDirectory = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban", "trashed-task-patches");
	mkdirSync(patchDirectory, { recursive: true });
	writeFileSync(join(patchDirectory, "other-task.abc.patch"), "其他任务的补丁不应阻止");
	writeFileSync(join(patchDirectory, "source.abc.patch"), "来源未落地补丁");
	await expect(check()).rejects.toThrow("仍保留未落地");
	unlinkSync(join(patchDirectory, "source.abc.patch"));
	await expect(check()).resolves.toBeUndefined();
	mocked.board.mockResolvedValue({ columns: [] });
	await expect(check()).resolves.toBeUndefined();
});
