// 排队 prompt 投影的浏览器侧 per-task 外部 store。
//
// 为什么是模块级 store 而不是从 App 往下传 props：队列要在**两处**被看见——详情视图（Queue tab、角标、
// 重启后高亮）与看板卡片（「N queued」药丸）。看板卡有两条平行宿主链（主看板 board-column.tsx 与
// Focus View column-context-panel.tsx，再加置顶板分身），把一个新 prop 穿过去既侵入又容易漏改其一；
// 而且 App 层每收到一次推送就整份重渲全看板是不可接受的。与 workspace-metadata-store 同一套做法：
// 订阅粒度是 taskId，只有这张卡自己的队列变了，这张卡才重渲。
//
// 写入方：App 层的 use-queued-task-prompt-delivery-projection-sync（首屏拉取 + 推送归并）以及 mutation 响应。
//
// ## 每一次写入都带 workspace 身份
//
// taskId 是 board-local 短 id，不同 workspace 会撞号。切到 workspace B 之后，A 那边一个迟到的 mutation 响应或
// 拉取结果若照单全收，会把 A 的 prompt 预览与计数塞进 B 同名任务的卡片里。所以 store 记着「当前属于哪个
// workspace」，别的 workspace 的写入一律丢弃。
//
// ## 写入代数
//
// 服务端在 mutation 落盘后先推流、再回 HTTP 响应，所以推送往往比响应早到。响应拿到时若期间已有别的写入
// （推送 / 另一次响应），它就不再是最新的——controller 据写入代数丢弃这种过时响应，而不是用它回滚更新的推送。

import { useSyncExternalStore } from "react";

import type {
	RuntimeQueuedTaskPromptDeliveryProjection,
	RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
} from "@/runtime/types";

type StoreListener = () => void;

const EMPTY_PROJECTIONS: readonly RuntimeQueuedTaskPromptDeliveryProjection[] = Object.freeze([]);

let projectionsWorkspaceId: string | null = null;
let projectionWriteGeneration = 0;
let projectionsByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId = {};
// 每个 task 上次写入时的序列化指纹：整份替换时只对真正变了的 task 发通知。推送是 workspace 级整份，
// 不这么做的话任何一个任务的队列动一下，全看板每张卡都会重渲一次。
const fingerprintByTaskId = new Map<string, string>();
const listenersByTaskId = new Map<string, Set<StoreListener>>();

function emitTask(taskId: string): void {
	const listeners = listenersByTaskId.get(taskId);
	if (!listeners) {
		return;
	}
	for (const listener of listeners) {
		listener();
	}
}

/** 当前 store 里的投影每被写入一次就 +1。controller 用它判断自己的 mutation 响应是否已被更新的写入超过。 */
export function getQueuedTaskPromptDeliveryProjectionWriteGeneration(): number {
	return projectionWriteGeneration;
}

/**
 * 用服务端给的整份投影替换 store（首屏拉取 / 推送 / mutation 响应）。
 * 返回是否真的写入了：属于别的 workspace 的写入被丢弃。
 */
export function replaceQueuedTaskPromptDeliveryProjections(
	workspaceId: string,
	nextProjectionsByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
): boolean {
	if (workspaceId !== projectionsWorkspaceId) {
		return false;
	}
	projectionWriteGeneration += 1;
	replaceProjectionsOfCurrentWorkspace(nextProjectionsByTaskId);
	return true;
}

function replaceProjectionsOfCurrentWorkspace(
	nextProjectionsByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
): void {
	const changedTaskIds = new Set<string>();
	const nextFingerprintByTaskId = new Map<string, string>();
	for (const [taskId, projections] of Object.entries(nextProjectionsByTaskId)) {
		const fingerprint = JSON.stringify(projections);
		nextFingerprintByTaskId.set(taskId, fingerprint);
		if (fingerprintByTaskId.get(taskId) !== fingerprint) {
			changedTaskIds.add(taskId);
		}
	}
	for (const taskId of fingerprintByTaskId.keys()) {
		if (!nextFingerprintByTaskId.has(taskId)) {
			changedTaskIds.add(taskId);
		}
	}
	const nextStore: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId = {};
	for (const [taskId, projections] of Object.entries(nextProjectionsByTaskId)) {
		// 没变的 task 沿用旧数组引用：useSyncExternalStore 靠引用判等，换新引用会让订阅者白渲一次。
		nextStore[taskId] = changedTaskIds.has(taskId) ? projections : (projectionsByTaskId[taskId] ?? projections);
	}
	projectionsByTaskId = nextStore;
	fingerprintByTaskId.clear();
	for (const [taskId, fingerprint] of nextFingerprintByTaskId) {
		fingerprintByTaskId.set(taskId, fingerprint);
	}
	for (const taskId of changedTaskIds) {
		emitTask(taskId);
	}
}

/** 切 workspace 时清空并换归属：此后只接受这个 workspace 的写入。null = 当前没有 workspace。 */
export function resetQueuedTaskPromptDeliveryProjectionsForWorkspace(workspaceId: string | null): void {
	projectionsWorkspaceId = workspaceId;
	projectionWriteGeneration += 1;
	replaceProjectionsOfCurrentWorkspace({});
}

export function getQueuedTaskPromptDeliveryProjectionsForTask(
	taskId: string,
): readonly RuntimeQueuedTaskPromptDeliveryProjection[] {
	return projectionsByTaskId[taskId] ?? EMPTY_PROJECTIONS;
}

export function useQueuedTaskPromptDeliveryProjectionsForTask(
	taskId: string | null | undefined,
): readonly RuntimeQueuedTaskPromptDeliveryProjection[] {
	return useSyncExternalStore(
		(listener) => {
			if (!taskId) {
				return () => {};
			}
			const listeners = listenersByTaskId.get(taskId) ?? new Set<StoreListener>();
			listeners.add(listener);
			listenersByTaskId.set(taskId, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					listenersByTaskId.delete(taskId);
				}
			};
		},
		() => (taskId ? getQueuedTaskPromptDeliveryProjectionsForTask(taskId) : EMPTY_PROJECTIONS),
	);
}
