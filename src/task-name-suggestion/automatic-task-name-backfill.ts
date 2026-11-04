import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pLimit from "p-limit";
import { z } from "zod";
import type { RuntimeBoardCard } from "../core/api-contract";
import { updateTask } from "../core/task-board-mutations";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadPersistedWorkspaceStateById, mutateWorkspaceState } from "../state/workspace-state";
import { readTaskEditorCreationExplicitStop } from "../task-editor-creation/task-editor-creation-submission-store";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import {
	readRecordedCreationNameSuggestionResult,
	suggestTaskNamesFromTaskDescription,
} from "./suggest-task-names-from-task-description";

const backfillRecordSchema = z.object({
	operationId: z.string().uuid(),
	workspaceId: z.string(),
	workspacePath: z.string(),
	taskId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
	originalTitle: z.string(),
	basisText: z.string(),
	nameVersion: z.number(),
	status: z.enum(["ready", "awaiting_original_model_result", "result_available", "completed", "unavailable"]),
	suggestedName: z.string().optional(),
});
const pendingOperations = new Set<string>();
const completedOperations = new Set<string>();
const limitNamingRequests = pLimit(3);
const recordsDirectory = () => join(getRuntimeHomePath(), "automatic-task-name-backfills");

async function reconcileBackfill(
	path: string,
	broadcast?: (workspaceId: string, workspacePath: string) => void | Promise<void>,
) {
	try {
		let record = backfillRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
		if (["completed", "unavailable"].includes(record.status)) {
			completedOperations.add(path);
			return;
		}
		if (
			await readTaskEditorCreationExplicitStop(
				record.workspaceId,
				record.taskId,
				record.taskIncarnationCreatedAtEpochMs,
			)
		)
			return;
		const state = await loadPersistedWorkspaceStateById(record.workspaceId);
		const column = state.board.columns.find((column) => column.cards.some((card) => card.id === record.taskId));
		const card = column?.cards.find((card) => card.id === record.taskId);
		if (column?.id === "trash" || card?.taskShelvingState?.isShelved) return;
		if (
			!card ||
			card.createdAt !== record.taskIncarnationCreatedAtEpochMs ||
			card.title !== record.originalTitle ||
			card.prompt !== record.basisText ||
			(card.taskNameVersion ?? 0) !== record.nameVersion
		) {
			record.status = "completed";
			await lockedFileSystem.writeJsonFileAtomic(path, record, { durable: true });
			completedOperations.add(path);
			return;
		}
		if (record.status === "awaiting_original_model_result") {
			const original = await readRecordedCreationNameSuggestionResult({
				taskDescription: record.basisText,
				operationId: record.operationId,
			});
			if (!original) return;
			record.status = original.status === "suggested" ? "result_available" : "unavailable";
			record.suggestedName = original.status === "suggested" ? original.suggestedTaskNames[0] : undefined;
			await lockedFileSystem.writeJsonFileAtomic(path, record, { durable: true });
		}
		if (record.status === "ready") {
			const claimed = await lockedFileSystem.withLock({ path }, async () => {
				const current = backfillRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
				if (current.status !== "ready") return false;
				current.status = "awaiting_original_model_result";
				await lockedFileSystem.writeJsonFileAtomic(path, current, { lock: null, durable: true });
				return true;
			});
			if (!claimed) return;
			const result = await suggestTaskNamesFromTaskDescription({
				taskDescription: record.basisText,
				operationId: record.operationId,
			});
			record = {
				...record,
				status: result.status === "suggested" ? "result_available" : "unavailable",
				suggestedName: result.status === "suggested" ? result.suggestedTaskNames[0] : undefined,
			};
			await lockedFileSystem.writeJsonFileAtomic(path, record, { durable: true });
		}
		if (!record.suggestedName) return;
		if (
			await readTaskEditorCreationExplicitStop(
				record.workspaceId,
				record.taskId,
				record.taskIncarnationCreatedAtEpochMs,
			)
		)
			return;
		const update = await mutateWorkspaceState(
			record.workspacePath,
			buildTaskMutationIntentForKanbanRuntimeSystemComponent(
				"runtime_automatic_task_name_backfill",
				"task_name_suggestion",
			),
			(state) => {
				const card = state.board.columns
					.flatMap((column) => column.cards)
					.find((card) => card.id === record.taskId);
				if (
					!card ||
					card.createdAt !== record.taskIncarnationCreatedAtEpochMs ||
					card.title !== record.originalTitle ||
					card.prompt !== record.basisText ||
					(card.taskNameVersion ?? 0) !== record.nameVersion
				)
					return { board: state.board, value: false, save: false };
				const updated = updateTask(state.board, card.id, { ...card, title: record.suggestedName });
				return { board: updated.board, value: true };
			},
		);
		record.status = "completed";
		await lockedFileSystem.writeJsonFileAtomic(path, record, { durable: true });
		completedOperations.add(path);
		if (update.saved) await broadcast?.(record.workspaceId, record.workspacePath);
	} finally {
		pendingOperations.delete(path);
	}
}

export async function requestAutomaticTaskNameBackfill(scope: RuntimeTrpcWorkspaceScope, card: RuntimeBoardCard) {
	const identity = createHash("sha256")
		.update(
			JSON.stringify([
				scope.workspaceId,
				card.id,
				card.createdAt,
				card.taskNameVersion ?? 0,
				card.title,
				card.prompt,
			]),
		)
		.digest("hex");
	const path = join(recordsDirectory(), `${identity}.json`);
	await lockedFileSystem.withLock({ path }, async () => {
		try {
			await readFile(path, "utf8");
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await lockedFileSystem.writeJsonFileAtomic(
			path,
			{
				operationId: randomUUID(),
				...scope,
				taskId: card.id,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				originalTitle: card.title,
				basisText: card.prompt,
				nameVersion: card.taskNameVersion ?? 0,
				status: "ready",
			},
			{ lock: null, durable: true },
		);
	});
}

// 搭乘既有运行时恢复轮次；模型结果不确定时保留记录，禁止自动重复付费。
export async function reconcileAutomaticTaskNameBackfills(
	broadcast?: (workspaceId: string, workspacePath: string) => void | Promise<void>,
) {
	const entries = await readdir(recordsDirectory()).catch(() => []);
	for (const entry of entries.filter((entry) => entry.endsWith(".json"))) {
		const path = join(recordsDirectory(), entry);
		if (pendingOperations.has(path) || completedOperations.has(path)) continue;
		pendingOperations.add(path);
		void limitNamingRequests(() => reconcileBackfill(path, broadcast)).catch(() => undefined);
	}
}
