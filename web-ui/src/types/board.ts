import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeBoardColumnId,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskClineSettings,
	RuntimeTaskCommentEntry,
	RuntimeTaskCommitIntegrationTrackingStatus,
	RuntimeTaskImage,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorkspaceGitStatusObservationSource,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";

export type BoardColumnId = RuntimeBoardColumnId;

export type TaskAutoReviewMode = RuntimeTaskAutoReviewMode;
export type TaskImage = RuntimeTaskImage;
export type TaskCommentEntry = RuntimeTaskCommentEntry;

/**
 * 从任务编辑对话框发起的「创建 / 保存」类动作的入参。
 *
 * `promptOverride` 让对话框把「此刻真正在编辑框里的那段文本」直接交给处理方，而不是让
 * 处理方去读自己的 state。`TaskEditorDialog` 已把逐字输入下沉为组件本地 state（否则每次
 * 按键都会重渲 `App` 根节点连同整棵卡片树），只在失焦 / 关闭 / 提交 / 长时间停顿时才上抛，
 * 因此提交那一瞬间父层 state 必然落后一拍——React 的 setState 不同步生效，先调
 * `onPromptChange` 再提交也救不回来。由调用方显式传值是唯一没有竞态的交接方式。
 *
 * 省略时由处理方回落到自己的 state，保留给测试与非对话框调用方。
 */
export interface TaskEditorSubmitOptions {
	keepDialogOpen?: boolean;
	promptOverride?: string;
}

export const DEFAULT_TASK_AUTO_REVIEW_MODE: TaskAutoReviewMode = "commit";

export function resolveTaskAutoReviewMode(mode: TaskAutoReviewMode | null | undefined): TaskAutoReviewMode {
	if (mode === "pr") {
		return mode;
	}
	return DEFAULT_TASK_AUTO_REVIEW_MODE;
}

export function getTaskAutoReviewActionLabel(mode: TaskAutoReviewMode | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") {
		return "PR";
	}
	return "commit";
}

export function getTaskAutoReviewCancelButtonLabel(mode: TaskAutoReviewMode | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") {
		return "Cancel Auto-PR";
	}
	return "Cancel Auto-commit";
}

export interface BoardCard {
	id: string;
	title: string;
	prompt: string;
	startInPlanMode: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	autoReviewEnabled?: boolean;
	autoReviewMode?: TaskAutoReviewMode;
	images?: TaskImage[];
	taskCommentEntries?: TaskCommentEntry[];
	agentId?: RuntimeAgentId;
	// 建卡那一刻固化的「这张卡下次启动该走哪条通道」（见 runtimeBoardCardSchema.ompAgentSessionTransport）。
	// 浏览器侧必须声明它：详情视图在**没有活会话**时只能靠它预判该渲染 xterm 还是会话面板，
	// 而 normalizeCard 是白名单式拷贝——字段不在类型里就既读不到、也会在水合时被丢掉并回写抹平。
	ompAgentSessionTransport?: RuntimeAgentSessionTransport;
	// runtime 观测值，不是用户意图：本卡片最近一次**真正启动成功**的会话用的是哪个 agent，
	// 只由服务端在会话启动成功后写入（见 api-contract.ts 的 runtimeBoardCardSchema）。
	// 前端既不生成也不编辑它，唯一职责是原样保留——归一化层一旦丢掉它，下一次 saveState
	// 就会用剥干净的 board 覆盖盘上这条硬中断恢复的主 durable 真相源。
	mostRecentlyLaunchedAgentSessionAgentId?: RuntimeAgentId;
	clineSettings?: RuntimeTaskClineSettings;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	baseRef: string;
	parentSessionId?: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
	prepFilePath?: string;
	createdAt: number;
	updatedAt: number;
}

export interface BoardColumn {
	id: BoardColumnId;
	title: string;
	cards: BoardCard[];
}

export interface BoardDependency {
	id: string;
	fromTaskId: string;
	toTaskId: string;
	createdAt: number;
}

export interface BoardData {
	columns: BoardColumn[];
	dependencies: BoardDependency[];
}

export interface ReviewTaskWorkspaceSnapshot {
	taskId: string;
	path: string;
	branch: string | null;
	isDetached: boolean;
	headCommit: string | null;
	// 任务从 base 分叉时的提交（fork-point）；未探测 / 计算失败 / inplace 无分叉为 null。
	// 会随 base-branch-sync 吸收 base 而前移，故不是「任务最初创建自哪个 commit」。
	baseCommit: string | null;
	// 与 base 分支的双向分歧。ahead = 任务开工后落在当前 worktree 上的提交数。
	commitsAheadOfBaseRef: number | null;
	// behind = base 分支独有、任务尚未吸收的提交数；base 推进时增长，吸收后归零。
	commitsBehindBaseRef: number | null;
	// 新 runtime metadata 始终携带；optional 仅用于兼容旧 stream / 测试快照。
	taskCommitsIntegratedIntoBaseRef?: number | null;
	taskCommitIntegrationTrackingStatus?: RuntimeTaskCommitIntegrationTrackingStatus;
	workspaceGitStatusObservationSource?: RuntimeTaskWorkspaceGitStatusObservationSource;
	workspaceGitStatusObservedAt?: number | null;
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
}

export interface CardSelection {
	card: BoardCard;
	column: BoardColumn;
	allColumns: BoardColumn[];
}
