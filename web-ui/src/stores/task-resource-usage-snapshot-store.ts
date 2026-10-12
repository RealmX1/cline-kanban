import { useSyncExternalStore } from "react";

import type { RuntimeLiveTaskResourceUsageSnapshot } from "@/runtime/types";

// 当前 workspace 各卡片的实时资源占用快照（按 task 归因的资源占用采集，S4）。
//
// 为什么是按卡片 id 订阅的模块级 store、而不走 reducer + props：
//   - 快照每 15 秒整体推一次；进 reducer 意味着每次都让 App 重渲染并把 props 逐层下传；
//   - 卡体有 5 个渲染点（主看板、Focus View 两处、两处置顶板、stage 卡头孪生），props 下传必有漏接；
//     叶子药丸自己按卡片 id 订阅，所有渲染点自动一致，卡体本身也不重渲染。
// 卡片 id 只在一个看板内唯一：store 只放当前 workspace 的数据，socket 层按 workspaceId 过滤后写入，
// 换 workspace（新建 socket）时清空。

type StoreListener = () => void;

let snapshotsByTaskCardId = new Map<string, RuntimeLiveTaskResourceUsageSnapshot>();
const listenersByTaskCardId = new Map<string, Set<StoreListener>>();

function emitTaskCard(taskCardId: string): void {
	for (const listener of listenersByTaskCardId.get(taskCardId) ?? []) {
		listener();
	}
}

function subscribeToTaskCard(taskCardId: string, listener: StoreListener): () => void {
	const listeners = listenersByTaskCardId.get(taskCardId) ?? new Set<StoreListener>();
	listeners.add(listener);
	listenersByTaskCardId.set(taskCardId, listeners);
	return () => {
		const current = listenersByTaskCardId.get(taskCardId);
		if (!current) {
			return;
		}
		current.delete(listener);
		if (current.size === 0) {
			listenersByTaskCardId.delete(taskCardId);
		}
	};
}

// 只比较药丸与详情面板真正展示的字段：采样时刻每次都变，拿它比会让每张卡每个 tick 都重渲染。
function areSnapshotsVisiblyEqual(
	left: RuntimeLiveTaskResourceUsageSnapshot | undefined,
	right: RuntimeLiveTaskResourceUsageSnapshot | undefined,
): boolean {
	if (left === right) {
		return true;
	}
	if (!left || !right) {
		return false;
	}
	return JSON.stringify({ ...left, sampledAtEpochMs: 0 }) === JSON.stringify({ ...right, sampledAtEpochMs: 0 });
}

// 全量替换当前 workspace 的快照；只通知数值真的变了的卡片。
export function replaceTaskResourceUsageSnapshots(snapshots: readonly RuntimeLiveTaskResourceUsageSnapshot[]): void {
	const nextSnapshotsByTaskCardId = new Map<string, RuntimeLiveTaskResourceUsageSnapshot>();
	for (const snapshot of snapshots) {
		if (snapshot.attributedTaskCardId !== null) {
			nextSnapshotsByTaskCardId.set(snapshot.attributedTaskCardId, snapshot);
		}
	}
	const previousSnapshotsByTaskCardId = snapshotsByTaskCardId;
	snapshotsByTaskCardId = nextSnapshotsByTaskCardId;
	const touchedTaskCardIds = new Set([...previousSnapshotsByTaskCardId.keys(), ...nextSnapshotsByTaskCardId.keys()]);
	for (const taskCardId of touchedTaskCardIds) {
		if (
			!areSnapshotsVisiblyEqual(
				previousSnapshotsByTaskCardId.get(taskCardId),
				nextSnapshotsByTaskCardId.get(taskCardId),
			)
		) {
			emitTaskCard(taskCardId);
		}
	}
}

export function resetTaskResourceUsageSnapshotStore(): void {
	replaceTaskResourceUsageSnapshots([]);
}

export function useTaskResourceUsageSnapshotValue(
	taskCardId: string | null | undefined,
): RuntimeLiveTaskResourceUsageSnapshot | null {
	return useSyncExternalStore(
		(listener) => (taskCardId ? subscribeToTaskCard(taskCardId, listener) : () => {}),
		() => (taskCardId ? (snapshotsByTaskCardId.get(taskCardId) ?? null) : null),
		() => null,
	);
}
