import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import type { RuntimeBoardData } from "../core/api-contract";
import type { taskClosureArchiveCleanupCredentialSchema } from "../core/task-closure-contract";
import { assertSourceGitWorkingStateMatchesSnapshot } from "../independent-task-creation/git-working-state-snapshot";
import {
	assertTaskClosureArchivePayloadIsRecoverable,
	captureAndVerifyTaskClosureArchive,
} from "./task-closure-archive";
import { readTaskClosureOperation } from "./task-closure-operation-store";

/** 结案、永久删除、公开 delete-worktree 共用。024c5 的其他清理授权也应在此入口组合核验。 */
export async function assertTaskWorktreeCleanupHasCurrentVerifiedArchive(input: {
	workspaceId: string;
	taskId: string;
	worktreePath: string;
	board: RuntimeBoardData;
	credential: z.infer<typeof taskClosureArchiveCleanupCredentialSchema> | undefined;
}) {
	const credential = input.credential;
	if (!credential)
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "工作树尚无本次清理的已验证归档凭据，请使用任务结案或永久删除动作。",
		});
	const operation = await readTaskClosureOperation(
		{
			workspaceId: input.workspaceId,
			taskId: input.taskId,
			taskIncarnationCreatedAtEpochMs: credential.taskIncarnationCreatedAtEpochMs,
		},
		credential.closureRequestId,
	);
	const card = input.board.columns
		.flatMap((column) => column.cards)
		.find((candidate) => candidate.id === input.taskId);
	const closedCard = input.board.columns
		.find((column) => column.id === "trash")
		?.cards.find((candidate) => candidate.id === input.taskId);
	if (
		!operation ||
		operation.progress.phase !== "closed_cleanup_pending" ||
		operation.sourceWorktreePath !== input.worktreePath ||
		operation.archiveManifest?.availability !== "verified_recoverable" ||
		!operation.archiveManifest.verifiedAtEpochMs ||
		(card &&
			(card.createdAt !== credential.taskIncarnationCreatedAtEpochMs ||
				!closedCard ||
				card.taskClosureSummary?.archiveManifest.archiveDirectory !== operation.archiveManifest.archiveDirectory))
	)
		throw new TRPCError({ code: "PRECONDITION_FAILED", message: "归档凭据已失效或任务已重新打开，未删除工作树。" });
	await assertSourceGitWorkingStateMatchesSnapshot(input.worktreePath, operation.archiveManifest.archiveDirectory);
	try {
		await assertTaskClosureArchivePayloadIsRecoverable(operation);
	} catch {
		// 来源仍匹配原快照时可修复损坏载荷；元数据缺失或来源漂移时上面的核验已拒绝清理。
		const recovered = await captureAndVerifyTaskClosureArchive(operation);
		if (
			recovered.archiveDirectory !== operation.archiveManifest.archiveDirectory ||
			recovered.headCommit !== operation.archiveManifest.headCommit
		)
			throw new Error("重新保全的归档身份与清理凭据不一致。");
	}
	await assertSourceGitWorkingStateMatchesSnapshot(input.worktreePath, operation.archiveManifest.archiveDirectory);
}
