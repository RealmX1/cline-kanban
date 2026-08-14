import {
	clearTaskEditDraftInStore,
	readSavedTaskEditDraftFromStore,
	saveTaskEditDraftToStore,
} from "@/runtime/task-edit-draft-store";
import type {
	RuntimeAgentId,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";
import type { BoardCard, TaskAutoReviewMode, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";

// 与契约的 runtimeTaskEditDraftSchema 一一对应（store 就用那个 schema 校验磁盘/镜像数据）。
// 这里保留一个本地 interface 只是为了让 web-ui 侧引用 TaskImage / TaskAutoReviewMode 这两个前端别名。
export interface TaskEditDraft {
	taskId: string;
	prompt: string;
	images: TaskImage[];
	startInPlanMode: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
	branchRef: string;
	agentId?: RuntimeAgentId;
	clineSettings?: RuntimeTaskClineSettings;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	worktreeMode?: RuntimeTaskWorktreeMode;
	savedAt: number;
}

/**
 * 一份草稿里「表单里那些值」的那部分——去掉身份（taskId）与时间戳（savedAt）。
 *
 * 由 `TaskEditDraft` 派生而不是另抄一份字段表：给任务加字段时，漏改这里会直接编译不过，
 * 而不是变成一处「新字段不参与比较」的静默错位。
 */
export type TaskEditDraftFormValues = Omit<TaskEditDraft, "taskId" | "savedAt">;

/**
 * 两份表单值是不是同一份内容。
 *
 * 用途是回答「用户动过表单没有」：编辑对话框的表单是同步铺上去的，服务端草稿快照可能迟到，
 * 迟到的快照只有在用户还没动过表单时才可以拿来重铺（见 use-task-editor.ts）。
 */
export function areTaskEditDraftFormValuesEqual(
	left: TaskEditDraftFormValues,
	right: TaskEditDraftFormValues,
): boolean {
	return (
		left.prompt === right.prompt &&
		JSON.stringify(left.images) === JSON.stringify(right.images) &&
		left.startInPlanMode === right.startInPlanMode &&
		left.taskAgentPermissionMode === right.taskAgentPermissionMode &&
		left.autoReviewEnabled === right.autoReviewEnabled &&
		left.autoReviewMode === right.autoReviewMode &&
		left.branchRef === right.branchRef &&
		(left.worktreeMode ?? "branch") === (right.worktreeMode ?? "branch") &&
		left.agentId === right.agentId &&
		JSON.stringify(left.clineSettings ?? null) === JSON.stringify(right.clineSettings ?? null) &&
		JSON.stringify(left.terminalAgentModelOverrideSettings ?? null) ===
			JSON.stringify(right.terminalAgentModelOverrideSettings ?? null) &&
		JSON.stringify(left.taskAgentSessionInitialization ?? null) ===
			JSON.stringify(right.taskAgentSessionInitialization ?? null)
	);
}

// 下面三个函数的真相源已搬到服务端，这里只保留同步签名并委派给 task-edit-draft-store。
// 签名不变是刻意的：`readSavedTaskEditDraft` 要给编辑表单铺初值，慢一帧就会先渲染出空表单再跳成
// 草稿内容。store 用「内存快照 + localStorage 镜像」保证同步可读，服务端同步在后台异步进行。

export function readSavedTaskEditDraft(projectId: string | null, taskId: string): TaskEditDraft | null {
	if (!projectId) {
		return null;
	}
	return readSavedTaskEditDraftFromStore(projectId, taskId);
}

export function saveTaskEditDraft(projectId: string | null, draft: TaskEditDraft): void {
	if (!projectId) {
		return;
	}
	saveTaskEditDraftToStore(projectId, draft);
}

export function clearTaskEditDraft(projectId: string | null, taskId: string): void {
	if (!projectId) {
		return;
	}
	clearTaskEditDraftInStore(projectId, taskId);
}

export function isTaskEditDraftEqualToTask(draft: Omit<TaskEditDraft, "savedAt">, task: BoardCard): boolean {
	return (
		draft.prompt === task.prompt.trim() &&
		JSON.stringify(draft.images) === JSON.stringify(task.images ?? []) &&
		draft.startInPlanMode === task.startInPlanMode &&
		draft.taskAgentPermissionMode === task.taskAgentPermissionMode &&
		draft.autoReviewEnabled === (task.autoReviewEnabled === true) &&
		draft.autoReviewMode === resolveTaskAutoReviewMode(task.autoReviewMode) &&
		draft.branchRef === task.baseRef &&
		draft.worktreeMode === (task.worktreeMode ?? "branch") &&
		draft.agentId === task.agentId &&
		JSON.stringify(draft.clineSettings ?? null) === JSON.stringify(task.clineSettings ?? null) &&
		JSON.stringify(draft.terminalAgentModelOverrideSettings ?? null) ===
			JSON.stringify(task.terminalAgentModelOverrideSettings ?? null) &&
		JSON.stringify(draft.taskAgentSessionInitialization ?? null) ===
			JSON.stringify(task.taskAgentSessionInitialization ?? null)
	);
}
