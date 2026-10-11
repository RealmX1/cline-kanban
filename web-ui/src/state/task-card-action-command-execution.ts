import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "@/runtime/types";
import type {
	PendingTaskCardCommandBoardOverlayEntry,
	PendingTaskCardCommandExpectedBoardEffect,
} from "@/state/pending-task-card-command-board-overlay";
import {
	addPendingTaskCardCommandBoardOverlayEntries,
	removePendingTaskCardCommandBoardOverlayEntries,
	replacePendingTaskCardCommandBoardOverlayEntry,
	schedulePendingTaskCardCommandBoardOverlayEntriesFallbackRemoval,
} from "@/stores/pending-task-card-command-board-overlay-store";
import {
	type TaskCardActionCommandKind,
	tryBeginTaskCardActionCommandInFlight,
} from "@/stores/task-card-action-commands-in-flight-store";

// 一条卡片动作命令（`taskCardAction.*`）在浏览器侧的统一编排。主看板、Focus View（This project）、跨项目切换
// 面板（All projects）的所有卡片动作都经这里，所以「同一张卡在三处只有一个在途命令、一个 spinner」是结构性保证：
//
//   1. 在途闸：同一张卡已有命令在途 → 直接拒绝（服务端还有按卡串行兜底，这里只是不让用户连点）。
//   2. overlay：只对当前项目传入期望效果——渲染层立刻显示结果，**不改**那份会被整板保存的 board。若浏览器先把
//      乐观结果写进 board 并抢先保存，服务端命令会看到「卡已经在 Done」而跳过停会话 / 删 worktree。
//   3. 结算：成功后按服务端的动作后快照核对期望（不符立即撤 overlay；字段 patch 换成服务端实际写下的值），再等广播
//      回灌把 overlay 换成真相（兜底定时器防卡死）；失败立即撤 overlay。
//
// 失败提示、选中下一张卡等手势副作用由调用方按结果决定，这里不弹 toast：同一个失败在 CLI 风格的批量入口与单卡
// 按钮里该说的话不一样。

export type TaskCardActionCommandExecutionResult<TResponse> =
	| { taskCardActionCommandExecutionOutcome: "command_completed_by_runtime"; response: TResponse }
	| { taskCardActionCommandExecutionOutcome: "rejected_because_another_command_is_in_flight_for_task_card" }
	| { taskCardActionCommandExecutionOutcome: "command_failed"; commandFailureMessage: string };

let pendingTaskCardCommandOverlayEntrySequenceNumber = 0;

function describeCommandFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rewriteOverlayEntryAgainstTaskCardSnapshotAfterAction(
	entry: PendingTaskCardCommandBoardOverlayEntry,
	snapshot: RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries | undefined,
): PendingTaskCardCommandBoardOverlayEntry | "remove_overlay_entry_now" | "keep_overlay_entry_unchanged" {
	if (!snapshot) {
		return "keep_overlay_entry_unchanged";
	}
	const effect = entry.expectedBoardEffect;
	switch (effect.pendingTaskCardCommandExpectedBoardEffectKind) {
		case "task_card_moved_into_board_column":
			// 服务端把卡放到了别处（例如恢复失败又移回 Done）：期望永远不会被满足，立刻撤掉，别让 overlay 盖住真相。
			return snapshot.boardColumnIdContainingTaskCard === effect.targetBoardColumnId
				? "keep_overlay_entry_unchanged"
				: "remove_overlay_entry_now";
		case "task_card_fields_patched": {
			// 置顶时刻这类值由服务端决定；换成它实际写下的值，回灌时 isSatisfied 才比得上。
			const taskCardFieldPatchWrittenByRuntime: Record<string, unknown> = {};
			for (const fieldName of Object.keys(effect.taskCardFieldPatch)) {
				taskCardFieldPatchWrittenByRuntime[fieldName] =
					snapshot.taskCard[fieldName as keyof typeof snapshot.taskCard];
			}
			return {
				...entry,
				expectedBoardEffect: {
					pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
					taskCardFieldPatch: taskCardFieldPatchWrittenByRuntime,
				},
			};
		}
		case "task_card_removed_from_board":
			return "keep_overlay_entry_unchanged";
	}
}

export async function executeTaskCardActionCommand<TResponse>(input: {
	workspaceId: string;
	taskIds: readonly string[];
	commandKind: TaskCardActionCommandKind;
	// 只有当前项目传：期望效果写成 overlay（其他项目的 board 不在浏览器内存里，只显示在途 spinner）。
	expectedBoardEffectByTaskId?: ReadonlyMap<string, PendingTaskCardCommandExpectedBoardEffect>;
	sendCommand: () => Promise<TResponse>;
	// 服务端的动作后快照（批量删除没有快照，不传）。
	readTaskCardSnapshotsAfterAction?: (
		response: TResponse,
	) => readonly RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries[];
}): Promise<TaskCardActionCommandExecutionResult<TResponse>> {
	const finishInFlightCallbacks: Array<() => void> = [];
	for (const taskId of input.taskIds) {
		const finishInFlight = tryBeginTaskCardActionCommandInFlight(input.workspaceId, taskId, input.commandKind);
		if (!finishInFlight) {
			for (const finishStartedInFlight of finishInFlightCallbacks) {
				finishStartedInFlight();
			}
			return {
				taskCardActionCommandExecutionOutcome: "rejected_because_another_command_is_in_flight_for_task_card",
			};
		}
		finishInFlightCallbacks.push(finishInFlight);
	}

	const overlayEntries: PendingTaskCardCommandBoardOverlayEntry[] = [];
	for (const [taskId, expectedBoardEffect] of input.expectedBoardEffectByTaskId ?? []) {
		pendingTaskCardCommandOverlayEntrySequenceNumber += 1;
		overlayEntries.push({
			pendingTaskCardCommandOverlayEntryId: `${input.commandKind}:${taskId}:${pendingTaskCardCommandOverlayEntrySequenceNumber}`,
			taskId,
			expectedBoardEffect,
		});
	}
	addPendingTaskCardCommandBoardOverlayEntries(input.workspaceId, overlayEntries);
	const overlayEntryIds = overlayEntries.map((entry) => entry.pendingTaskCardCommandOverlayEntryId);

	try {
		const response = await input.sendCommand();
		const snapshotsAfterAction = input.readTaskCardSnapshotsAfterAction?.(response) ?? [];
		const entryIdsAwaitingBroadcast: string[] = [];
		for (const entry of overlayEntries) {
			const rewritten = rewriteOverlayEntryAgainstTaskCardSnapshotAfterAction(
				entry,
				snapshotsAfterAction.find((snapshot) => snapshot.taskCard.id === entry.taskId),
			);
			if (rewritten === "remove_overlay_entry_now") {
				removePendingTaskCardCommandBoardOverlayEntries(input.workspaceId, [
					entry.pendingTaskCardCommandOverlayEntryId,
				]);
				continue;
			}
			if (rewritten !== "keep_overlay_entry_unchanged") {
				replacePendingTaskCardCommandBoardOverlayEntry(input.workspaceId, rewritten);
			}
			entryIdsAwaitingBroadcast.push(entry.pendingTaskCardCommandOverlayEntryId);
		}
		schedulePendingTaskCardCommandBoardOverlayEntriesFallbackRemoval(input.workspaceId, entryIdsAwaitingBroadcast);
		return { taskCardActionCommandExecutionOutcome: "command_completed_by_runtime", response };
	} catch (error) {
		removePendingTaskCardCommandBoardOverlayEntries(input.workspaceId, overlayEntryIds);
		return {
			taskCardActionCommandExecutionOutcome: "command_failed",
			commandFailureMessage: describeCommandFailure(error),
		};
	} finally {
		for (const finishInFlight of finishInFlightCallbacks) {
			finishInFlight();
		}
	}
}
