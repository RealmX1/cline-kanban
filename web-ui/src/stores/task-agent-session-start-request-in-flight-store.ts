// 「这张卡的 agent 会话启动请求还在路上」的浏览器侧 per-task 外部 store。
//
// ## 为什么需要它
//
// 浏览器启动一个任务是两次独立 RPC：先 ensureWorktree（git worktree add + submodule + ignored-path 镜像），
// 再 startTaskSession（服务端 cwd 解析 → per-task 启动闸门 → adapter 准备 → spawn）。卡片在第一步之前就被
// 乐观地移进了 In Progress，终端面板随即挂上——此时 summary 还是从未启动过的占位（turnOwner=null），
// 终端也没有任何输出。面板若只看这两点，就会把「正在启动」误判成「会话随上一个运行时没了」，并递给用户
// 一个「Restart terminal session」——那个按钮走的是续跑式 refresh（空 prompt + --continue），在启动窗口里
// 点下去会和真正的启动抢同一把 per-task 闸门：要么把原 prompt 折叠掉永不送达，要么把刚起来的 agent 杀掉。
// 平时这个窗口不到一秒；高负载下实测 20s～56s（2026-09-30 运行时启动诊断日志），用户就只能看着这句话。
//
// ## 为什么是模块级 store
//
// 写入方是看板交互层（use-board-interactions 的 kickoffTaskInProgress），读取方是深埋在详情视图里的终端面板。
// 与 queued-task-prompt-delivery-projection-store 同理：穿 props 侵入且易漏，订阅粒度按卡即可。
//
// ## 键带 workspace
//
// taskId 是 board-local 短 id，不同 workspace 会撞号，所以键是 workspace + task。
//
// ## 句柄而不是裸 set/clear
//
// 同一张卡可能被连续启动两次（双击、拖拽后又点 Start）。若后一次还在路上时前一次的 finally 清掉了标记，
// 面板会在后一次完成前重新露出「已死」提示。所以每次 begin 返回一个句柄，只有**当前**那次的句柄能推进阶段
// 或结束，过时的句柄静默无效。

import { useSyncExternalStore } from "react";

export type TaskAgentSessionStartRequestInFlightPhase = "preparing_task_worktree" | "launching_agent_session";

export interface TaskAgentSessionStartRequestInFlightHandle {
	advanceToPhase: (phase: TaskAgentSessionStartRequestInFlightPhase) => void;
	finish: () => void;
}

interface TaskAgentSessionStartRequestInFlightEntry {
	startRequestSequenceNumber: number;
	phase: TaskAgentSessionStartRequestInFlightPhase;
}

type StoreListener = () => void;

let nextStartRequestSequenceNumber = 1;
const inFlightEntryByWorkspaceScopedTaskKey = new Map<string, TaskAgentSessionStartRequestInFlightEntry>();
const listenersByWorkspaceScopedTaskKey = new Map<string, Set<StoreListener>>();

function toWorkspaceScopedTaskKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}\u0000${taskId}`;
}

function emitWorkspaceScopedTask(workspaceScopedTaskKey: string): void {
	const listeners = listenersByWorkspaceScopedTaskKey.get(workspaceScopedTaskKey);
	if (!listeners) {
		return;
	}
	for (const listener of listeners) {
		listener();
	}
}

export function beginTaskAgentSessionStartRequestInFlight(
	workspaceId: string,
	taskId: string,
): TaskAgentSessionStartRequestInFlightHandle {
	const workspaceScopedTaskKey = toWorkspaceScopedTaskKey(workspaceId, taskId);
	const startRequestSequenceNumber = nextStartRequestSequenceNumber;
	nextStartRequestSequenceNumber += 1;
	inFlightEntryByWorkspaceScopedTaskKey.set(workspaceScopedTaskKey, {
		startRequestSequenceNumber,
		phase: "preparing_task_worktree",
	});
	emitWorkspaceScopedTask(workspaceScopedTaskKey);

	const isCurrentStartRequest = (): boolean =>
		inFlightEntryByWorkspaceScopedTaskKey.get(workspaceScopedTaskKey)?.startRequestSequenceNumber ===
		startRequestSequenceNumber;

	return {
		advanceToPhase: (phase) => {
			if (!isCurrentStartRequest()) {
				return;
			}
			inFlightEntryByWorkspaceScopedTaskKey.set(workspaceScopedTaskKey, { startRequestSequenceNumber, phase });
			emitWorkspaceScopedTask(workspaceScopedTaskKey);
		},
		finish: () => {
			if (!isCurrentStartRequest()) {
				return;
			}
			inFlightEntryByWorkspaceScopedTaskKey.delete(workspaceScopedTaskKey);
			emitWorkspaceScopedTask(workspaceScopedTaskKey);
		},
	};
}

export function getTaskAgentSessionStartRequestInFlightPhase(
	workspaceId: string,
	taskId: string,
): TaskAgentSessionStartRequestInFlightPhase | null {
	return inFlightEntryByWorkspaceScopedTaskKey.get(toWorkspaceScopedTaskKey(workspaceId, taskId))?.phase ?? null;
}

export function useTaskAgentSessionStartRequestInFlightPhase(
	workspaceId: string | null | undefined,
	taskId: string | null | undefined,
): TaskAgentSessionStartRequestInFlightPhase | null {
	return useSyncExternalStore(
		(listener) => {
			if (!workspaceId || !taskId) {
				return () => {};
			}
			const workspaceScopedTaskKey = toWorkspaceScopedTaskKey(workspaceId, taskId);
			const listeners = listenersByWorkspaceScopedTaskKey.get(workspaceScopedTaskKey) ?? new Set<StoreListener>();
			listeners.add(listener);
			listenersByWorkspaceScopedTaskKey.set(workspaceScopedTaskKey, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					listenersByWorkspaceScopedTaskKey.delete(workspaceScopedTaskKey);
				}
			};
		},
		() => (workspaceId && taskId ? getTaskAgentSessionStartRequestInFlightPhase(workspaceId, taskId) : null),
	);
}
