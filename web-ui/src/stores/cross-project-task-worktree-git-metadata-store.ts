import { buildCrossProjectTaskSwitcherEntryKey } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { useSyncExternalStore } from "react";

import type { RuntimeCrossProjectTaskWorktreeGitMetadata } from "@/runtime/types";
import { areTaskWorkspaceSnapshotsEqual, toTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

// 跨项目切换面板的 git 元数据快照与轮询状态（ahead/behind、未提交改动），由
// use-cross-project-task-worktree-git-metadata-polling.ts 轮询写入。
//
// 与 workspace-metadata-store 分开：那个 store 只按 taskId 分键、切项目时整体清空，只装当前项目推流来的数据；
// 这里跨项目，taskId 会撞号，必须按 (workspaceId, taskId) 复合键。快照形状与转换函数两边共用。

export interface CrossProjectTaskWorktreeGitMetadataPollObservation {
	snapshot: ReviewTaskWorkspaceSnapshot | null;
	worktreeExists: boolean | null;
	pollStatus: "loading" | "available" | "unavailable";
}

export function hasUsableTaskWorktreeGitMetadataSnapshot(snapshot: ReviewTaskWorkspaceSnapshot | null): boolean {
	// base 关系不可用不影响独立的 dirty 观察；全未知才没有可供行和筛选使用的计数证据。
	return (
		snapshot !== null &&
		(snapshot.changedFiles !== null ||
			snapshot.commitsAheadOfBaseRef !== null ||
			snapshot.commitsBehindBaseRef !== null)
	);
}

const observationByEntryKey = new Map<string, CrossProjectTaskWorktreeGitMetadataPollObservation>();
const listenersByEntryKey = new Map<string, Set<() => void>>();

function emitEntryKey(entryKey: string): void {
	for (const listener of listenersByEntryKey.get(entryKey) ?? []) {
		listener();
	}
}

function setObservationForEntryKey(
	entryKey: string,
	observation: CrossProjectTaskWorktreeGitMetadataPollObservation,
): void {
	const previous = observationByEntryKey.get(entryKey);
	const snapshotUnchanged = areTaskWorkspaceSnapshotsEqual(previous?.snapshot ?? null, observation.snapshot);
	if (
		previous &&
		snapshotUnchanged &&
		previous.pollStatus === observation.pollStatus &&
		previous.worktreeExists === observation.worktreeExists
	) {
		return;
	}
	observationByEntryKey.set(entryKey, {
		...observation,
		snapshot: snapshotUnchanged ? (previous?.snapshot ?? null) : observation.snapshot,
	});
	emitEntryKey(entryKey);
}

export function getCrossProjectTaskWorktreeGitMetadataPollObservation(
	workspaceId: string,
	taskId: string,
): CrossProjectTaskWorktreeGitMetadataPollObservation | null {
	return observationByEntryKey.get(buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId)) ?? null;
}

export function subscribeToCrossProjectTaskWorktreeGitMetadataEntry(
	entryKey: string,
	listener: () => void,
): () => void {
	const listeners = listenersByEntryKey.get(entryKey) ?? new Set<() => void>();
	listeners.add(listener);
	listenersByEntryKey.set(entryKey, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) listenersByEntryKey.delete(entryKey);
	};
}

export function markCrossProjectTaskWorktreeGitMetadataPollStarted(
	tasks: readonly { workspaceId: string; taskId: string }[],
): void {
	for (const { workspaceId, taskId } of tasks) {
		const entryKey = buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId);
		// 后续刷新保留已有观察，不让列表每五秒闪回加载态。
		if (!observationByEntryKey.has(entryKey)) {
			setObservationForEntryKey(entryKey, { snapshot: null, worktreeExists: null, pollStatus: "loading" });
		}
	}
}

export function markCrossProjectTaskWorktreeGitMetadataPollFailed(
	tasks: readonly { workspaceId: string; taskId: string }[],
): void {
	for (const { workspaceId, taskId } of tasks) {
		const entryKey = buildCrossProjectTaskSwitcherEntryKey(workspaceId, taskId);
		const previous = observationByEntryKey.get(entryKey);
		setObservationForEntryKey(entryKey, {
			snapshot: previous?.snapshot ?? null,
			worktreeExists: previous?.worktreeExists ?? null,
			pollStatus: "unavailable",
		});
	}
}

// 一轮轮询的结果。只更新结果里出现的键，内容不变的键不通知订阅者（行不重渲染）。
export function applyCrossProjectTaskWorktreeGitMetadataPollResults(
	results: readonly RuntimeCrossProjectTaskWorktreeGitMetadata[],
): void {
	for (const result of results) {
		if (result.availability === "unavailable" && result.unavailableReason === "git_metadata_probe_failed") {
			markCrossProjectTaskWorktreeGitMetadataPollFailed([result]);
			continue;
		}
		const snapshot =
			result.availability === "available" ? toTaskWorkspaceSnapshot(result.taskWorkspaceMetadata) : null;
		if (
			result.availability === "available" &&
			result.taskWorkspaceMetadata.exists &&
			snapshot?.workspaceGitStatusObservationSource !== "persisted_final_snapshot" &&
			!hasUsableTaskWorktreeGitMetadataSnapshot(snapshot)
		) {
			// 探针失败也可能包在 available 响应内，不能用全未知结果覆盖上一份可信观察。
			markCrossProjectTaskWorktreeGitMetadataPollFailed([result]);
			continue;
		}
		setObservationForEntryKey(buildCrossProjectTaskSwitcherEntryKey(result.workspaceId, result.taskId), {
			snapshot,
			worktreeExists: result.availability === "available" ? result.taskWorkspaceMetadata.exists : null,
			pollStatus: result.availability,
		});
	}
}

export function resetCrossProjectTaskWorktreeGitMetadataStore(): void {
	const entryKeys = [...observationByEntryKey.keys()];
	observationByEntryKey.clear();
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
			return subscribeToCrossProjectTaskWorktreeGitMetadataEntry(entryKey, listener);
		},
		() => (isEnabled ? (observationByEntryKey.get(entryKey)?.snapshot ?? null) : null),
		() => null,
	);
}
