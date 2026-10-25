import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type RuntimeBoardData,
	runtimeBoardCardSchema,
	runtimeTaskCardActionTransferBacklogTaskToProjectRequestSchema,
} from "../core/api-contract";
import {
	committedInterWorkUnitRelationLedgerEventSchema,
	type KanbanActor,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import { isNeverStartedPlaceholderTaskSessionSummary } from "../core/session-activity";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readTaskIndexingSupportJsonFile } from "../task-indexing-support/task-indexing-support-storage";
import { getRuntimeHomePath } from "./runtime-home-path";
import type { TaskMutationIntentWithResolvedActor } from "./workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	getTaskWorktreesHomePath,
	getWorkspaceDirectoryLockRequest,
	loadPersistedWorkspaceStateById,
	loadWorkspaceContextById,
	reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock,
	writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents,
} from "./workspace-state";

const transferReceiptSchema = runtimeTaskCardActionTransferBacklogTaskToProjectRequestSchema.extend({
	sourceWorkspaceId: z.string(),
	taskCard: runtimeBoardCardSchema,
	actor: committedInterWorkUnitRelationLedgerEventSchema.shape.actor,
	status: z.enum(["prepared", "target_saved", "completed"]),
	preparedAt: z.number(),
});
type TransferReceipt = z.infer<typeof transferReceiptSchema>;
const receiptDirectory = () => join(getRuntimeHomePath(), "backlog-task-project-transfers");

async function pathExists(path: string) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

async function withBothWorkspaceLocks<T>(source: string, target: string, action: () => Promise<T>): Promise<T> {
	const [first, second] = [source, target].sort();
	if (!first || !second || first === second) throw new Error("迁移需要两个不同的项目。");
	return lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(first), () =>
		lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(second), action),
	);
}

async function completeTransferWithinWorkspaceLocks(receipt: TransferReceipt, receiptPath: string) {
	const sourceContext = await loadWorkspaceContextById(receipt.sourceWorkspaceId);
	const targetContext = await loadWorkspaceContextById(receipt.targetWorkspaceId);
	if (!sourceContext || !targetContext) throw new Error("迁移项目尚未注册，等待恢复后重试。");
	const source = await loadPersistedWorkspaceStateById(receipt.sourceWorkspaceId);
	const target = await loadPersistedWorkspaceStateById(receipt.targetWorkspaceId);
	await reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(
		sourceContext,
		source.board,
		source.sessions,
		source.revision,
	);
	await reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(
		targetContext,
		target.board,
		target.sessions,
		target.revision,
	);
	const locate = (state: typeof source) =>
		state.board.columns
			.flatMap((column) => column.cards.map((card) => ({ card, columnId: column.id })))
			.find((entry) => entry.card.id === receipt.taskId);
	const sourceCard = locate(source);
	const targetCard = locate(target);
	if (sourceCard && JSON.stringify(sourceCard.card) !== JSON.stringify(receipt.taskCard)) {
		throw new Error("迁移期间来源任务被修改，保留两侧原文和恢复记录，未覆盖新内容。");
	}
	for (const entry of [sourceCard, targetCard])
		if (entry && (entry.card.createdAt !== receipt.taskIncarnationCreatedAtEpochMs || entry.columnId !== "backlog"))
			throw new Error("迁移任务身份或所在列发生变化，保留迁移记录并拒绝覆盖。");
	for (const state of [source, target])
		if (
			Object.values(state.sessions).some(
				(summary) =>
					(summary.taskId === receipt.taskId ||
						summary.taskConversationSessionMetadata?.workspaceTaskId === receipt.taskId) &&
					!isNeverStartedPlaceholderTaskSessionSummary(summary),
			)
		)
			throw new Error("任务已经启动，不能迁移项目。");
	const intent = (writeSide: "source" | "target"): TaskMutationIntentWithResolvedActor => ({
		taskMutationIntentKind: "backlog_task_project_transferred",
		resolvedKanbanActor: receipt.actor as KanbanActor,
		idempotencyKey: `backlog-transfer:${receipt.operationId}:${writeSide}`,
		backlogTaskProjectTransfer: {
			operationId: receipt.operationId,
			sourceWorkspaceId: receipt.sourceWorkspaceId,
			targetWorkspaceId: receipt.targetWorkspaceId,
			taskId: receipt.taskId,
			taskIncarnationCreatedAtEpochMs: receipt.taskIncarnationCreatedAtEpochMs,
			writeSide,
		},
	});
	const write = async (
		state: typeof source,
		context: typeof sourceContext,
		board: typeof source.board,
		writeSide: "source" | "target",
	) => {
		await reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(
			context,
			state.board,
			state.sessions,
			state.revision,
		);
		await writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents({
			context,
			previousBoard: state.board,
			previousSessions: state.sessions,
			nextBoard: board,
			nextSessions: state.sessions,
			nextMeta: { revision: state.revision + 1, updatedAt: Date.now() },
			taskMutationIntentWithResolvedActor: intent(writeSide),
		});
	};
	// 先确保目标持久化，再移除来源。崩溃后以限定身份幂等接续，永不产生第二张新身份。
	if (!targetCard) {
		await write(
			target,
			targetContext,
			{
				...target.board,
				columns: target.board.columns.map((column) =>
					column.id === "backlog"
						? { ...column, cards: [{ ...receipt.taskCard, baseRef: receipt.targetBaseRef }, ...column.cards] }
						: column,
				),
			},
			"target",
		);
	}
	receipt.status = "target_saved";
	await lockedFileSystem.writeJsonFileAtomic(receiptPath, receipt, { lock: null });
	if (sourceCard)
		await write(
			source,
			sourceContext,
			{
				...source.board,
				columns: source.board.columns.map((column) => ({
					...column,
					cards: column.cards.filter((card) => card.id !== receipt.taskId),
				})),
			},
			"source",
		);
	receipt.status = "completed";
	await lockedFileSystem.writeJsonFileAtomic(receiptPath, receipt, { lock: null });
	return { operationId: receipt.operationId, workspaceId: receipt.targetWorkspaceId, taskId: receipt.taskId };
}

async function readBacklogTaskProjectTransferReceipts(): Promise<TransferReceipt[]> {
	let filenames: string[];
	try {
		filenames = await readdir(receiptDirectory());
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const receipts: TransferReceipt[] = [];
	for (const filename of filenames.filter((name) => /^[0-9a-f-]{36}\.json$/iu.test(name)))
		receipts.push(
			transferReceiptSchema.parse(await readTaskIndexingSupportJsonFile(join(receiptDirectory(), filename))),
		);
	return receipts;
}

/** 无版本整板快照无法证明调用方见过迁入卡；显式卡片命令和匹配版本的整板保存由调用方另行放行。 */
export async function hasBoardSnapshotRemovedTaskTransferredIntoWorkspace(
	workspaceId: string,
	previousBoard: RuntimeBoardData,
	nextBoard: RuntimeBoardData,
): Promise<boolean> {
	const nextIdentities = new Set(
		nextBoard.columns.flatMap((column) => column.cards.map((card) => `${card.id}:${card.createdAt}`)),
	);
	const removedCards = previousBoard.columns
		.flatMap((column) => column.cards)
		.filter((card) => !nextIdentities.has(`${card.id}:${card.createdAt}`));
	if (!removedCards.length) return false;
	const receipts = await readBacklogTaskProjectTransferReceipts();
	return removedCards.some((card) => {
		const latest = receipts
			.filter(
				(receipt) =>
					receipt.status === "completed" &&
					receipt.taskId === card.id &&
					receipt.taskIncarnationCreatedAtEpochMs === card.createdAt,
			)
			.sort((left, right) => left.preparedAt - right.preparedAt)
			.at(-1);
		return latest?.targetWorkspaceId === workspaceId;
	});
}

/** 整板保存中的旧客户端快照不能把已迁出的同一世任务复活。 */
export async function assertNoTransferredTaskIsReintroducedByStaleBoardSnapshot(
	workspaceId: string,
	previousBoard: RuntimeBoardData,
	nextBoard: RuntimeBoardData,
) {
	const previousIdentities = new Set(
		previousBoard.columns.flatMap((column) => column.cards.map((card) => `${card.id}:${card.createdAt}`)),
	);
	const added = nextBoard.columns
		.flatMap((column) => column.cards)
		.filter((card) => !previousIdentities.has(`${card.id}:${card.createdAt}`));
	if (!added.length) return;
	const receipts = await readBacklogTaskProjectTransferReceipts();
	for (const card of added) {
		const history = receipts
			.filter(
				(receipt) =>
					receipt.status === "completed" &&
					receipt.taskId === card.id &&
					receipt.taskIncarnationCreatedAtEpochMs === card.createdAt,
			)
			.sort((left, right) => left.preparedAt - right.preparedAt);
		const latest = history.at(-1);
		if (
			latest &&
			history.some(
				(receipt) => receipt.sourceWorkspaceId === workspaceId || receipt.targetWorkspaceId === workspaceId,
			) &&
			latest.targetWorkspaceId !== workspaceId
		)
			throw new Error(
				`任务 ${card.id} 已迁移到 ${latest.targetWorkspaceId}，旧看板快照不能将其重新建回原项目。请刷新看板。`,
			);
	}
}

export async function recoverPendingBacklogTaskProjectTransfers(workspaceId?: string) {
	if (!(await pathExists(receiptDirectory()))) return;
	return lockedFileSystem.withLock({ path: receiptDirectory(), type: "directory" }, async () => {
		let filenames: string[];
		try {
			filenames = await readdir(receiptDirectory());
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const filename of filenames.filter((name) => /^[0-9a-f-]{36}\.json$/iu.test(name)).sort()) {
			const path = join(receiptDirectory(), filename);
			const receipt = transferReceiptSchema.parse(await readTaskIndexingSupportJsonFile(path));
			if (
				receipt.status === "completed" ||
				(workspaceId && receipt.sourceWorkspaceId !== workspaceId && receipt.targetWorkspaceId !== workspaceId)
			)
				continue;
			await withBothWorkspaceLocks(receipt.sourceWorkspaceId, receipt.targetWorkspaceId, () =>
				completeTransferWithinWorkspaceLocks(receipt, path),
			);
		}
	});
}

export async function transferNeverStartedBacklogTaskToProject(
	sourceWorkspaceId: string,
	request: z.infer<typeof runtimeTaskCardActionTransferBacklogTaskToProjectRequestSchema>,
	intent: TaskMutationIntentWithResolvedActor,
) {
	await recoverPendingBacklogTaskProjectTransfers(sourceWorkspaceId);
	return lockedFileSystem.withLock({ path: receiptDirectory(), type: "directory" }, () =>
		withBothWorkspaceLocks(sourceWorkspaceId, request.targetWorkspaceId, async () => {
			const path = join(receiptDirectory(), `${request.operationId}.json`);
			const existingValue = await readTaskIndexingSupportJsonFile(path);
			if (existingValue) {
				const existing = transferReceiptSchema.parse(existingValue);
				if (
					existing.sourceWorkspaceId !== sourceWorkspaceId ||
					existing.targetWorkspaceId !== request.targetWorkspaceId ||
					existing.taskId !== request.taskId ||
					existing.taskIncarnationCreatedAtEpochMs !== request.taskIncarnationCreatedAtEpochMs ||
					existing.targetBaseRef !== request.targetBaseRef
				)
					throw new Error("迁移操作编号已用于其他输入。");
				if (existing.status === "completed")
					return {
						operationId: existing.operationId,
						workspaceId: existing.targetWorkspaceId,
						taskId: existing.taskId,
					};
				return completeTransferWithinWorkspaceLocks(existing, path);
			}
			const source = await loadPersistedWorkspaceStateById(sourceWorkspaceId);
			const card = source.board.columns
				.find((column) => column.id === "backlog")
				?.cards.find(
					(entry) => entry.id === request.taskId && entry.createdAt === request.taskIncarnationCreatedAtEpochMs,
				);
			if (!card) throw new Error("只能迁移身份一致且从未启动的 Backlog 任务。");
			if (await pathExists(join(getTaskWorktreesHomePath(), request.taskId)))
				throw new Error("任务已有工作树资源，保留原卡；请先核对其启动历史。");
			const target = await loadWorkspaceContextById(request.targetWorkspaceId);
			if (!target) throw new Error("目标项目不存在。");
			if (!target.git.branches.some((branch) => branch.name === request.targetBaseRef))
				throw new Error("目标项目中不存在所选基础分支，请重新选择。");
			const targetState = await loadPersistedWorkspaceStateById(request.targetWorkspaceId);
			if (targetState.board.columns.some((column) => column.cards.some((entry) => entry.id === request.taskId)))
				throw new Error("目标项目存在同 ID 任务，原卡保持不变。");
			for (const summary of Object.values(source.sessions)) {
				if (
					(summary.taskId === request.taskId ||
						summary.taskConversationSessionMetadata?.workspaceTaskId === request.taskId) &&
					!isNeverStartedPlaceholderTaskSessionSummary(summary)
				)
					throw new Error("任务已经启动，不能迁移项目。");
			}
			const receipt: TransferReceipt = {
				...request,
				sourceWorkspaceId,
				taskCard: card,
				actor: intent.resolvedKanbanActor,
				status: "prepared",
				preparedAt: Date.now(),
			};
			await lockedFileSystem.writeJsonFileAtomic(path, receipt, { lock: null });
			return completeTransferWithinWorkspaceLocks(receipt, path);
		}),
	);
}
