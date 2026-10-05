import { buildCrossProjectTaskSwitcherEntryKey } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { useSyncExternalStore } from "react";

import type { RuntimeCrossProjectTaskWorktreeGitMetadata } from "@/runtime/types";
import { areTaskWorkspaceSnapshotsEqual, toTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

// 跨项目切换面板里「其他项目」行的 git 元数据快照（ahead/behind、未提交改动），由
// use-cross-project-task-worktree-git-metadata-polling.ts 轮询写入。
//
// 与 workspace-metadata-store 分开：那个 store 只按 taskId 分键、切项目时整体清空，只装当前项目推流来的数据；
// 这里跨项目，taskId 会撞号，必须按 (workspaceId, taskId) 复合键。快照形状与转换函数两边共用。

const snapshotByEntryKey = new Map<string, ReviewTaskWorkspaceSnapshot | null>();
const listenersByEntryKey = new Map<string, Set<() => void>>();

function emitEntryKey(entryKey: string): void {
	for (const listener of listenersByEntryKey.get(entryKey) ?? []) {
		listener();
	}
}

function setSnapshotForEntryKey(entryKey: string, snapshot: ReviewTaskWorkspaceSnapshot | null): void {
	const previous = snapshotByEntryKey.get(entryKey) ?? null;
	if (areTaskWorkspaceSnapshotsEqual(previous, snapshot)) {
		return;
	}
	snapshotByEntryKey.set(entryKey, snapshot);
	emitEntryKey(entryKey);
}

// 一轮轮询的结果。只更新结果里出现的键，内容不变的键不通知订阅者（行不重渲染）。
export function applyCrossProjectTaskWorktreeGitMetadataPollResults(
	results: readonly RuntimeCrossProjectTaskWorktreeGitMetadata[],
): void {
	for (const result of results) {
		setSnapshotForEntryKey(
			buildCrossProjectTaskSwitcherEntryKey(result.workspaceId, result.taskId),
			result.availability === "available" ? toTaskWorkspaceSnapshot(result.taskWorkspaceMetadata) : null,
		);
	}
}

export function resetCrossProjectTaskWorktreeGitMetadataStore(): void {
	const entryKeys = [...snapshotByEntryKey.keys()];
	snapshotByEntryKey.clear();
	for (const entryKey of entryKeys) {
		emitEntryKey(entryKey);
	}
}

export function useCrossProjectTaskWorktreeGitMetadataSnapshotValue(
	workspaceId: string,
	taskId: string,
	isEnabled: boolean,
): ReviewTaskWorkspaceSnapshot | null {
	const entryKey = buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId);
	return useSyncExternalStore(
		(listener) => {
			if (!isEnabled) {
				return () => {};
			}
			const listeners = listenersByEntryKey.get(entryKey) ?? new Set<() => void>();
			listeners.add(listener);
			listenersByEntryKey.set(entryKey, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					listenersByEntryKey.delete(entryKey);
				}
			};
		},
		() => (isEnabled ? (snapshotByEntryKey.get(entryKey) ?? null) : null),
		() => null,
	);
}
