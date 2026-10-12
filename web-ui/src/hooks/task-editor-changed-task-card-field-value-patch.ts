import { areTaskImagesEqual } from "@/hooks/task-edit-drafts";
import type {
	RuntimeAgentId,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskCardFieldValuePatch,
	RuntimeTaskClineSettings,
	RuntimeTaskConversationMode,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";
import type { BoardCard, TaskAutoReviewMode, TaskImage } from "@/types";

// 编辑对话框点保存时，表单里的全部字段值（baseRef 已按默认分支补齐、prompt 已 trim）。
export interface TaskEditorSubmittedTaskCardFieldValues {
	taskTitleOverride?: string;
	prompt: string;
	images: TaskImage[];
	startInPlanMode: boolean;
	taskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	taskConversationMode: RuntimeTaskConversationMode;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
	baseRef: string;
	worktreeMode: RuntimeTaskWorktreeMode;
	agentId: RuntimeAgentId | undefined;
	clineSettings: RuntimeTaskClineSettings | undefined;
	terminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	taskAgentSessionInitialization: RuntimeTaskAgentSessionInitialization | undefined;
}

function areOptionalStructuredFieldValuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * 编辑器保存只发「表单值与铺表单那一刻的卡片本体不同」的字段（`taskCardAction.updateTaskCardFieldValues` 的三态
 * patch：键缺省 = 服务端保留最新现值）。
 *
 * 比较基准是**铺表单时的卡片**，不是保存那一刻的卡片：编辑期间 CLI / agent 改了某个用户没动的字段时，那个字段
 * 不进 patch，服务端在锁内保留别人的新值；以保存时的卡片为基准则会把编辑器里的旧值当作改动写回去。
 * 表单从草稿铺出来时，草稿与卡片不同的字段照样进 patch——那正是用户要保存的内容。
 *
 * 卡片上缺省、表单里补了默认值的字段（权限档、会话模式、自动 review、worktree 模式）与卡片「不同」，照发：
 * 改动前浏览器整卡覆盖时也会把这些默认值写成显式值，这里保持同样的落盘结果。
 * 名称同样与铺表单时的值比较；未修改时不发，保留服务端并发改名。
 */
export function buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(
	taskCardTheEditorFormWasSeededFrom: BoardCard,
	submitted: TaskEditorSubmittedTaskCardFieldValues,
): RuntimeTaskCardFieldValuePatch {
	const seed = taskCardTheEditorFormWasSeededFrom;
	const patch: RuntimeTaskCardFieldValuePatch = {};
	if (submitted.taskTitleOverride !== undefined && submitted.taskTitleOverride.trim() !== seed.title) {
		patch.title = submitted.taskTitleOverride.trim() || null;
	}

	if (submitted.prompt !== seed.prompt.trim()) {
		patch.prompt = submitted.prompt;
	}
	if (!areTaskImagesEqual(submitted.images, seed.images ?? [])) {
		patch.images = submitted.images.length > 0 ? submitted.images : null;
	}
	if (submitted.startInPlanMode !== seed.startInPlanMode) {
		patch.startInPlanMode = submitted.startInPlanMode;
	}
	if (submitted.taskAgentPermissionMode !== seed.taskAgentPermissionMode) {
		patch.taskAgentPermissionMode = submitted.taskAgentPermissionMode;
	}
	if (submitted.taskConversationMode !== seed.taskConversationMode) {
		patch.taskConversationMode = submitted.taskConversationMode;
	}
	if (submitted.autoReviewEnabled !== seed.autoReviewEnabled) {
		patch.autoReviewEnabled = submitted.autoReviewEnabled;
	}
	if (submitted.autoReviewMode !== seed.autoReviewMode) {
		patch.autoReviewMode = submitted.autoReviewMode;
	}
	if (submitted.baseRef !== seed.baseRef) {
		patch.baseRef = submitted.baseRef;
	}
	if (submitted.worktreeMode !== seed.worktreeMode) {
		patch.worktreeMode = submitted.worktreeMode;
	}
	if (submitted.agentId !== seed.agentId) {
		patch.agentId = submitted.agentId ?? null;
	}
	if (!areOptionalStructuredFieldValuesEqual(submitted.clineSettings, seed.clineSettings)) {
		patch.clineSettings = submitted.clineSettings ?? null;
	}
	if (
		!areOptionalStructuredFieldValuesEqual(
			submitted.terminalAgentModelOverrideSettings,
			seed.terminalAgentModelOverrideSettings,
		)
	) {
		patch.terminalAgentModelOverrideSettings = submitted.terminalAgentModelOverrideSettings ?? null;
	}
	if (
		!areOptionalStructuredFieldValuesEqual(
			submitted.taskAgentSessionInitialization,
			seed.taskAgentSessionInitialization,
		)
	) {
		// 服务端见到这个键（含 null）且 patch 没给 parentSessionId 时一并清掉遗留 parentSessionId，与浏览器 updateTask 同义。
		patch.taskAgentSessionInitialization = submitted.taskAgentSessionInitialization ?? null;
	}
	return patch;
}
