// 「这张卡有一条卡片动作命令（taskCardAction.*）还在路上」的浏览器侧 per-task 外部 store。
//
// ## 为什么需要它
//
// 卡片动作改走服务端后，同一张卡可能同时出现在三处：主看板 / Focus View 左栏（This project）/ 跨项目面板
// （All projects）。三处必须看到同一个 spinner、同一个「按钮暂时不可用」——否则在一处点了 Done，另一处还能再点一次。
// 它也是客户端幂等闸：同一张卡已有命令在途时，新命令直接拒绝（服务端还有按卡串行兜底，这里只是不让用户连点）。
// 以前的 `moveToTrashLoadingById` 一类状态都改为从这里派生。
//
// ## 键带 workspace
//
// taskId 是 board-local 短 id，不同 workspace 会撞号，所以键是 workspace + task（同
// task-agent-session-start-request-in-flight-store）。

import { useSyncExternalStore } from "react";

// 在途命令的种类：UI 据此决定哪个按钮转圈。名字与服务端 procedure 一一对应。
export type TaskCardActionCommandKind =
	| "set_task_card_shelving_state"
	| "start_task_card_agent_session_moving_it_into_in_progress"
	| "move_task_card_into_review_by_handing_turn_to_user"
	| "move_task_card_between_non_trash_columns_without_session_side_effects"
	| "move_task_card_into_done_stopping_sessions_and_deleting_worktree"
	| "restore_task_card_from_done_into_review_resuming_agent_session"
	| "permanently_delete_task_card_with_full_resource_cleanup"
	| "update_task_card_field_values"
	| "set_task_pinboard_pin_state_of_task_card";

type StoreListener = () => void;

const inFlightCommandKindByWorkspaceScopedTaskKey = new Map<string, TaskCardActionCommandKind>();
const listenersByWorkspaceScopedTaskKey = new Map<string, Set<StoreListener>>();

function toWorkspaceScopedTaskKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}\u0000${taskId}`;
}

function emitWorkspaceScopedTask(workspaceScopedTaskKey: string): void {
	for (const listener of listenersByWorkspaceScopedTaskKey.get(workspaceScopedTaskKey) ?? []) {
		listener();
	}
}

// 登记一条在途命令。已有命令在途时返回 null（调用方据此放弃这次手势），否则返回结束函数（只能生效一次）。
export function tryBeginTaskCardActionCommandInFlight(
	workspaceId: string,
	taskId: string,
	commandKind: TaskCardActionCommandKind,
): (() => void) | null {
	const workspaceScopedTaskKey = toWorkspaceScopedTaskKey(workspaceId, taskId);
	if (inFlightCommandKindByWorkspaceScopedTaskKey.has(workspaceScopedTaskKey)) {
		return null;
	}
	inFlightCommandKindByWorkspaceScopedTaskKey.set(workspaceScopedTaskKey, commandKind);
	emitWorkspaceScopedTask(workspaceScopedTaskKey);
	let finished = false;
	return () => {
		if (finished) {
			return;
		}
		finished = true;
		inFlightCommandKindByWorkspaceScopedTaskKey.delete(workspaceScopedTaskKey);
		emitWorkspaceScopedTask(workspaceScopedTaskKey);
	};
}

export function readTaskCardActionCommandKindInFlight(
	workspaceId: string,
	taskId: string,
): TaskCardActionCommandKind | null {
	return inFlightCommandKindByWorkspaceScopedTaskKey.get(toWorkspaceScopedTaskKey(workspaceId, taskId)) ?? null;
}

function subscribeToWorkspaceScopedTask(workspaceScopedTaskKey: string, listener: StoreListener): () => void {
	let listeners = listenersByWorkspaceScopedTaskKey.get(workspaceScopedTaskKey);
	if (!listeners) {
		listeners = new Set();
		listenersByWorkspaceScopedTaskKey.set(workspaceScopedTaskKey, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) {
			listenersByWorkspaceScopedTaskKey.delete(workspaceScopedTaskKey);
		}
	};
}

// 按卡订阅：只有这张卡的在途状态变了才重渲。workspaceId 为 null（无项目）时恒为 null。
export function useTaskCardActionCommandKindInFlight(
	workspaceId: string | null,
	taskId: string,
): TaskCardActionCommandKind | null {
	const workspaceScopedTaskKey = workspaceId ? toWorkspaceScopedTaskKey(workspaceId, taskId) : null;
	return useSyncExternalStore(
		(listener) =>
			workspaceScopedTaskKey ? subscribeToWorkspaceScopedTask(workspaceScopedTaskKey, listener) : () => {},
		() =>
			workspaceScopedTaskKey
				? (inFlightCommandKindByWorkspaceScopedTaskKey.get(workspaceScopedTaskKey) ?? null)
				: null,
	);
}

/** 测试用：清空全部在途登记。 */
export function clearAllTaskCardActionCommandsInFlight(): void {
	const keys = [...inFlightCommandKindByWorkspaceScopedTaskKey.keys()];
	inFlightCommandKindByWorkspaceScopedTaskKey.clear();
	for (const key of keys) {
		emitWorkspaceScopedTask(key);
	}
}
