import { useSyncExternalStore } from "react";

import {
	isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard,
	type PendingTaskCardCommandBoardOverlayEntry,
} from "@/state/pending-task-card-command-board-overlay";
import type { BoardData } from "@/types";

// 卡片动作命令在途期间叠在渲染层的 overlay 条目（纯函数见 pending-task-card-command-board-overlay.ts）。
//
// 按 workspace 分开存：只有当前项目的 board 在浏览器内存里，App 只读当前项目那一份；切项目后旧项目的条目不再
// 显示，由各自的兜底定时器回收，不需要在切项目时清空。
//
// 一条条目在三种情况下退场：
//   1. 回灌的 board 已体现它的效果（App 在 board 变化时调 prune）——此后显示的就是服务端真相；
//   2. 命令失败，或服务端返回的动作后快照与期望不符（执行编排里直接移除）；
//   3. 兜底定时器到期：广播丢了、或别处又改了这张卡，期望永远不会被满足时，不让 overlay 永久盖住真相。

// EXPERIMENT_NODE: overlay 条目兜底退场时长取 5 秒；本机 runtime 的命令往返加广播通常在 100ms 内。
const PENDING_TASK_CARD_COMMAND_BOARD_OVERLAY_ENTRY_FALLBACK_REMOVAL_AFTER_MS = 5_000;

const EMPTY_PENDING_TASK_CARD_COMMAND_BOARD_OVERLAY_ENTRIES: readonly PendingTaskCardCommandBoardOverlayEntry[] = [];

const entriesByWorkspaceId = new Map<string, readonly PendingTaskCardCommandBoardOverlayEntry[]>();
const fallbackRemovalTimeoutIdByEntryId = new Map<string, number>();
const listenersByWorkspaceId = new Map<string, Set<() => void>>();

function emitWorkspace(workspaceId: string): void {
	for (const listener of listenersByWorkspaceId.get(workspaceId) ?? []) {
		listener();
	}
}

function replaceEntries(workspaceId: string, entries: readonly PendingTaskCardCommandBoardOverlayEntry[]): void {
	if (entries.length === 0) {
		entriesByWorkspaceId.delete(workspaceId);
	} else {
		entriesByWorkspaceId.set(workspaceId, entries);
	}
	emitWorkspace(workspaceId);
}

export function addPendingTaskCardCommandBoardOverlayEntries(
	workspaceId: string,
	entries: readonly PendingTaskCardCommandBoardOverlayEntry[],
): void {
	if (entries.length === 0) {
		return;
	}
	replaceEntries(workspaceId, [...(entriesByWorkspaceId.get(workspaceId) ?? []), ...entries]);
}

export function removePendingTaskCardCommandBoardOverlayEntries(
	workspaceId: string,
	entryIds: readonly string[],
): void {
	const removedEntryIds = new Set(entryIds);
	for (const entryId of entryIds) {
		const timeoutId = fallbackRemovalTimeoutIdByEntryId.get(entryId);
		if (timeoutId !== undefined) {
			window.clearTimeout(timeoutId);
			fallbackRemovalTimeoutIdByEntryId.delete(entryId);
		}
	}
	const current = entriesByWorkspaceId.get(workspaceId) ?? [];
	const remaining = current.filter((entry) => !removedEntryIds.has(entry.pendingTaskCardCommandOverlayEntryId));
	if (remaining.length !== current.length) {
		replaceEntries(workspaceId, remaining);
	}
}

// 命令已结算、等广播回灌：开兜底定时器（见文件头第 3 条）。
export function schedulePendingTaskCardCommandBoardOverlayEntriesFallbackRemoval(
	workspaceId: string,
	entryIds: readonly string[],
): void {
	for (const entryId of entryIds) {
		if (fallbackRemovalTimeoutIdByEntryId.has(entryId)) {
			continue;
		}
		const timeoutId = window.setTimeout(() => {
			fallbackRemovalTimeoutIdByEntryId.delete(entryId);
			removePendingTaskCardCommandBoardOverlayEntries(workspaceId, [entryId]);
		}, PENDING_TASK_CARD_COMMAND_BOARD_OVERLAY_ENTRY_FALLBACK_REMOVAL_AFTER_MS);
		fallbackRemovalTimeoutIdByEntryId.set(entryId, timeoutId);
	}
}

// 用已有条目的期望改写（命令成功后把字段 patch 换成服务端实际写下的值，回灌时才比得上）。
export function replacePendingTaskCardCommandBoardOverlayEntry(
	workspaceId: string,
	replacement: PendingTaskCardCommandBoardOverlayEntry,
): void {
	const current = entriesByWorkspaceId.get(workspaceId) ?? [];
	if (
		!current.some(
			(entry) => entry.pendingTaskCardCommandOverlayEntryId === replacement.pendingTaskCardCommandOverlayEntryId,
		)
	) {
		return;
	}
	replaceEntries(
		workspaceId,
		current.map((entry) =>
			entry.pendingTaskCardCommandOverlayEntryId === replacement.pendingTaskCardCommandOverlayEntryId
				? replacement
				: entry,
		),
	);
}

// board 每次变化（含广播回灌）时调用：已被 board 体现的条目退场。
export function prunePendingTaskCardCommandBoardOverlayEntriesSatisfiedByBoard(
	workspaceId: string,
	board: BoardData,
): void {
	const current = entriesByWorkspaceId.get(workspaceId) ?? [];
	const satisfiedEntryIds = current
		.filter((entry) => isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(board, entry))
		.map((entry) => entry.pendingTaskCardCommandOverlayEntryId);
	if (satisfiedEntryIds.length > 0) {
		removePendingTaskCardCommandBoardOverlayEntries(workspaceId, satisfiedEntryIds);
	}
}

export function readPendingTaskCardCommandBoardOverlayEntries(
	workspaceId: string | null,
): readonly PendingTaskCardCommandBoardOverlayEntry[] {
	return workspaceId
		? (entriesByWorkspaceId.get(workspaceId) ?? EMPTY_PENDING_TASK_CARD_COMMAND_BOARD_OVERLAY_ENTRIES)
		: EMPTY_PENDING_TASK_CARD_COMMAND_BOARD_OVERLAY_ENTRIES;
}

// 浏览器端列自动流转据此跳过：这张卡正等一条服务端命令落定，自动流转不能抢在它前面改列。
export function hasPendingTaskCardCommandBoardOverlayEntryForTaskCard(
	workspaceId: string | null,
	taskId: string,
): boolean {
	return readPendingTaskCardCommandBoardOverlayEntries(workspaceId).some((entry) => entry.taskId === taskId);
}

export function usePendingTaskCardCommandBoardOverlayEntries(
	workspaceId: string | null,
): readonly PendingTaskCardCommandBoardOverlayEntry[] {
	return useSyncExternalStore(
		(listener) => {
			if (!workspaceId) {
				return () => {};
			}
			const listeners = listenersByWorkspaceId.get(workspaceId) ?? new Set<() => void>();
			listeners.add(listener);
			listenersByWorkspaceId.set(workspaceId, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					listenersByWorkspaceId.delete(workspaceId);
				}
			};
		},
		() => readPendingTaskCardCommandBoardOverlayEntries(workspaceId),
		() => EMPTY_PENDING_TASK_CARD_COMMAND_BOARD_OVERLAY_ENTRIES,
	);
}

/** 测试用：清空全部条目与定时器。 */
export function resetPendingTaskCardCommandBoardOverlayStore(): void {
	for (const timeoutId of fallbackRemovalTimeoutIdByEntryId.values()) {
		window.clearTimeout(timeoutId);
	}
	fallbackRemovalTimeoutIdByEntryId.clear();
	const workspaceIds = [...entriesByWorkspaceId.keys()];
	entriesByWorkspaceId.clear();
	for (const workspaceId of workspaceIds) {
		emitWorkspace(workspaceId);
	}
}
