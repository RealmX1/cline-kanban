import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeBoardCard } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import {
	probeAndRefreshTaskCommitIntegrationProvenance,
	readSourceTaskCommitLandingReadiness,
} from "../workspace/task-commit-integration-provenance";
import {
	independentTaskCreationArtifactDirectory,
	readIndependentTaskCreationDraft,
	withIndependentTaskCreationDraftLock,
	writeIndependentTaskCreationDraft,
} from "./persisted-creation-draft";

export async function readValidatedIndependentTaskCreationRecord(workspaceId: string, card: RuntimeBoardCard) {
	const provenance = card.independentTaskCreationProvenance;
	if (!provenance) return null;
	const record = await readIndependentTaskCreationDraft(workspaceId, provenance.creationRequestId);
	if (
		!record ||
		record.reservedTaskId !== card.id ||
		provenance.sourceWorkspaceId !== workspaceId ||
		provenance.contextArtifactDirectory !==
			independentTaskCreationArtifactDirectory(workspaceId, provenance.creationRequestId) ||
		record.draft.sourceTaskId !== provenance.sourceTaskId ||
		record.draft.sourceTaskConversationSessionId !== provenance.sourceTaskConversationSessionId ||
		record.draft.worktreeSource !== provenance.worktreeSource ||
		(record.sourceTaskIncarnationCreatedAtEpochMs !== null &&
			record.sourceTaskIncarnationCreatedAtEpochMs !== undefined &&
			provenance.sourceTaskIncarnationCreatedAtEpochMs !== record.sourceTaskIncarnationCreatedAtEpochMs)
	) {
		throw new Error("分出任务的来源记录不一致，未创建或启动工作树。");
	}
	return record;
}

export async function assertIndependentTaskSourceLandedBeforeInitialStart(input: {
	workspaceId: string;
	repoPath: string;
	card: RuntimeBoardCard;
}) {
	const provenance = input.card.independentTaskCreationProvenance;
	if (provenance?.worktreeSource !== "local_main_after_source_task_landed") return;
	const record = await readValidatedIndependentTaskCreationRecord(input.workspaceId, input.card);
	if (record?.deferredSourceLandingAuthorized) return;
	const board = await loadWorkspaceBoardById(input.workspaceId);
	const completedSource = board.columns
		.find((column) => column.id === "trash")
		?.cards.find((card) => card.id === provenance.sourceTaskId);
	if (!completedSource) throw new Error("此任务等待来源任务完成并合入 local main；来源任务尚未完成。");
	if (
		provenance.sourceTaskIncarnationCreatedAtEpochMs !== undefined &&
		completedSource.createdAt !== provenance.sourceTaskIncarnationCreatedAtEpochMs
	)
		throw new Error("来源 Task ID 已用于另一张卡，不能用其完成状态代替原任务的落地证明。");
	const path = record?.sourceSummary?.workspacePath;
	if (!path) throw new Error("缺少来源工作树的持久记录，无法证明已合入。");
	let exists = false;
	try {
		exists = (await stat(path)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (exists) {
		const status = await runGit(path, ["status", "--porcelain=v1"], {
			env: createGitProcessEnv({ GIT_OPTIONAL_LOCKS: "0" }),
		});
		if (!status.ok || status.stdout)
			throw new Error("来源工作树仍有未提交修改，尚不能证明全部成果已进入 local main。");
	}
	// 来源工作树清理时保存的 dirty patch 仍属于未落地成果。
	let retainedPatchFiles: string[] = [];
	try {
		retainedPatchFiles = await readdir(join(getRuntimeHomePath(), "trashed-task-patches"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (retainedPatchFiles.some((name) => name.startsWith(`${provenance.sourceTaskId}.`) && name.endsWith(".patch"))) {
		throw new Error("来源任务仍保留未落地的工作树补丁，请先恢复并合入 local main。");
	}
	await probeAndRefreshTaskCommitIntegrationProvenance({
		workspaceId: input.workspaceId,
		taskId: provenance.sourceTaskId,
		repoPath: input.repoPath,
		worktreePath: path,
		baseRef: "main",
		worktreeExists: exists,
	});
	if (
		!(await readSourceTaskCommitLandingReadiness({
			workspaceId: input.workspaceId,
			taskId: provenance.sourceTaskId,
			repoPath: input.repoPath,
			localBaseRef: "main",
		}))
	) {
		throw new Error("尚无来源任务成果全部进入 local main 的证明，请完成同步后再手动启动。");
	}
	await withIndependentTaskCreationDraftLock(input.workspaceId, provenance.creationRequestId, async () => {
		const current = await readIndependentTaskCreationDraft(input.workspaceId, provenance.creationRequestId);
		if (!current) throw new Error("分出任务持久记录已缺失。");
		current.deferredSourceLandingAuthorized = true;
		await writeIndependentTaskCreationDraft(input.workspaceId, current);
	});
}
