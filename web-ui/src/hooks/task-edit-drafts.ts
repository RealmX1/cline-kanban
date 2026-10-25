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
	RuntimeTaskConversationMode,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";
import type { BoardCard, TaskAutoReviewMode, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";

// 与契约的 runtimeTaskEditDraftSchema 一一对应（store 就用那个 schema 校验磁盘/镜像数据）。
// 这里保留一个本地 interface 只是为了让 web-ui 侧引用 TaskImage / TaskAutoReviewMode 这两个前端别名。
export interface TaskEditDraft {
	taskTitleOverride?: string;
	taskId: string;
	prompt: string;
	images: TaskImage[];
	startInPlanMode: boolean;
	taskConversationMode?: RuntimeTaskConversationMode;
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
 * 两份图片数组是不是同一份内容。
 *
 * 粘贴进来的图是 MB 级 base64，裸 `JSON.stringify` 比较每次都要为两边各分配一整份序列化字符串，
 * 而这条比较挂在草稿去抖（400ms）与通知栏渲染的热路径上。这里改成逐字段早退：
 * 引用相等 → 数组长度 → 逐图 `id`/`mimeType`/`name`/`data.length`（判不等，几乎不碰 data 本体）→
 * 全部通过才 `data ===`。相等的情形零分配。
 *
 * `name` 必须参与比较：它是 schema 里的可选字段，跳过它会把「只改了文件名」误判成没动过，
 * 静默丢掉那次改动（判不等永远是安全方向，判等不是）。字段级比较与原 `JSON.stringify` 写法
 * 逐字段等价——stringify 会丢掉值为 `undefined` 的可选键，属性访问读到的同样是 `undefined`。
 */
export function areTaskImagesEqual(left: TaskImage[], right: TaskImage[]): boolean {
	if (left === right) {
		return true;
	}
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		const leftImage = left[index];
		const rightImage = right[index];
		// 长度已比对过，这里取不到元素不可能发生；真发生了按不等处理（判不等永远是安全方向）。
		if (!leftImage || !rightImage) {
			return false;
		}
		if (leftImage === rightImage) {
			continue;
		}
		if (
			leftImage.id !== rightImage.id ||
			leftImage.mimeType !== rightImage.mimeType ||
			leftImage.name !== rightImage.name ||
			leftImage.data.length !== rightImage.data.length ||
			leftImage.data !== rightImage.data
		) {
			return false;
		}
	}
	return true;
}

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
		left.taskTitleOverride === right.taskTitleOverride &&
		left.prompt === right.prompt &&
		areTaskImagesEqual(left.images, right.images) &&
		left.startInPlanMode === right.startInPlanMode &&
		(left.taskConversationMode ?? "operational") === (right.taskConversationMode ?? "operational") &&
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
		(draft.taskTitleOverride === undefined || draft.taskTitleOverride.trim() === task.title) &&
		draft.prompt === task.prompt.trim() &&
		areTaskImagesEqual(draft.images, task.images ?? []) &&
		draft.startInPlanMode === task.startInPlanMode &&
		(draft.taskConversationMode ?? "operational") === (task.taskConversationMode ?? "operational") &&
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
