import type {
	DraggableProvidedDraggableProps,
	DraggableProvidedDragHandleProps,
	DraggableStyle,
} from "@hello-pangea/dnd";
import {
	getRuntimeAgentCatalogEntry,
	isRuntimeAgentSessionSummaryRenderedAsConversationPanel,
} from "@runtime-agent-catalog";
import { isLowConfidenceLastConversationProgressEvidence } from "@runtime-last-conversation-progress-observation";
import {
	deriveDisplayLiveness,
	isNeverStartedPlaceholderTaskSessionSummary,
	isParkedAwaitingDispatchedBackgroundWork,
	resolveSessionFacets,
} from "@runtime-session-activity";
import { buildTaskWorktreeDisplayPath } from "@runtime-task-worktree-path";
import {
	Activity,
	AlertCircle,
	AlertTriangle,
	Archive,
	Check,
	CircleDotDashed,
	ClipboardCheck,
	Clock,
	Copy,
	Eye,
	FileText,
	GitBranch,
	Home,
	Hourglass,
	ListOrdered,
	MessagesSquare,
	Pencil,
	Pin,
	PinOff,
	Play,
	RotateCcw,
	Trash2,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentCurrentWorkPhaseGoal } from "@/components/agent-current-work-phase-goal";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { BacklogTaskDescriptionLastUpdatedPill } from "@/components/backlog-task-description-last-updated-pill";
import {
	formatClineReasoningEffortLabel,
	formatClineSelectedModelButtonText,
	resolveClineModelDisplayName,
} from "@/components/detail-panels/cline-model-picker-options";
import { boardTaskCardAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { useTaskCardBodyVisualDensity } from "@/components/task-card-body-visual-density-context";
import { TaskCardPrimaryActionWithQuickOptions } from "@/components/task-card-primary-action-with-quick-options";
import { TaskCardResourceUsagePill } from "@/components/task-card-resource-usage-pill";
import { TaskOriginalPromptDialog } from "@/components/task-original-prompt-dialog";
import { AheadBehindIndicator } from "@/components/ui/ahead-behind-indicator";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { Spinner } from "@/components/ui/spinner";
import { TaskCommitsIntegratedIntoBaseRefIndicator } from "@/components/ui/task-commits-integrated-into-base-ref-indicator";
import { describeTaskWorkspaceGitStatusAgainstBaseRef } from "@/components/ui/task-workspace-git-status-against-base-ref-description";
import { Tooltip } from "@/components/ui/tooltip";
import {
	shouldDisplayWorktreeUncommittedChangeSummary,
	WorktreeUncommittedChangeSummaryIndicator,
} from "@/components/ui/worktree-uncommitted-change-summary-indicator";
import { resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp } from "@/hooks/use-session-activity-dot-breathing-opacity-on-shared-fine-clock";
import { useSharedCoarseClockTimestampMs } from "@/hooks/use-shared-coarse-clock";
import { useSharedFineClockTimestampMs } from "@/hooks/use-shared-fine-clock";
import { summarizeQueuedTaskPromptDeliveryCountIndicator } from "@/runtime/queued-task-prompt-delivery-status-wording";
import type { PermanentlyDeletedTaskCardEntry, RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useCrossProjectTaskWorktreeGitMetadataSnapshotValue } from "@/stores/cross-project-task-worktree-git-metadata-store";
import { useQueuedTaskPromptDeliveryProjectionsForTask } from "@/stores/queued-task-prompt-delivery-projection-store";
import { useTaskWorkspaceInfoValue, useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import { describeTerminalDeliveryContention } from "@/terminal/terminal-delivery-contention-notice";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import type { TaskCardMoveIntoDoneRequestHandler } from "@/types/task-card-move-into-done-request";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import { formatPathForDisplay } from "@/utils/path-display";
import { resolveTaskAgentSessionLaunchHistoryEvidence } from "@/utils/task-agent-session-launch-history-evidence";
import { normalizePromptForDisplay, truncateTaskPromptLabel } from "@/utils/task-prompt";
import { writeTextToSystemClipboardWithInsecureContextFallback } from "@/utils/write-text-to-system-clipboard-with-insecure-context-fallback";
import { getAgentVisual } from "./agent-visual";
import {
	type CardSessionActivity,
	deriveCardSessionActivity,
	isCardCreditLimitError,
	SESSION_ACTIVITY_COLOR,
} from "./board-card-session-activity";

// 会跳转的列（单击打开详情、替换看板）上，单击先延迟这么久，留出双击改标题的拦截窗口。
const CLICK_ACTIVATION_DELAY_MS = 220;

function reconstructTaskWorktreeDisplayPath(taskId: string, workspacePath: string | null | undefined): string | null {
	if (!workspacePath) {
		return null;
	}
	try {
		return buildTaskWorktreeDisplayPath(taskId, workspacePath);
	} catch {
		return null;
	}
}

/**
 * 钉在宿主行右下角；纯 overlay，不占文本流宽度；hover 时左侧渐变遮住末行被挡字符。
 */
function TaskCardTitleRowHoverActions({ children }: { children: ReactNode }): React.ReactElement {
	return (
		<div
			className={cn(
				"pointer-events-none absolute bottom-0 right-0 z-10 flex items-end opacity-0 transition-opacity",
				// 与卡面同底色的左向渐变：hover 时才显现，避免为按钮预留 pr-* 挤占换行宽度。
				"bg-gradient-to-l from-surface-2 from-45% to-transparent pl-4 group-hover/card:from-surface-3",
				"group-hover/title:opacity-100 group-hover/title:pointer-events-auto group-focus-within/title:opacity-100 group-focus-within/title:pointer-events-auto",
			)}
		>
			<div className="pointer-events-auto mb-px flex rounded-md bg-surface-3 px-0.5 shadow-sm">{children}</div>
		</div>
	);
}

/**
 * 卡片的业务 props：与「这份卡体被渲染成什么角色」（可拖本体 / sticky 卡头副本 / 置顶板分身）无关的
 * 领域回调与数据。四个渲染点共用同一套，且一律经 `buildTaskCardBusinessProps` 装配，
 * 确保「分身与原卡行为完全相同」不靠各处自觉复制粘贴。
 */
export interface TaskCardBusinessProps {
	card: BoardCardModel;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	onClick?: (card: BoardCardModel) => void;
	onStart?: (taskId: string) => void;
	onMoveToTrash?: TaskCardMoveIntoDoneRequestHandler;
	onMoveToValidation?: (taskId: string) => void;
	// 手动把 In Progress 卡翻入 Review（仅终端 agent；卡死/空闲会话拖不进 Review 的兜底入口）。
	onMoveToReview?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onOpenTaskEditor?: (card: BoardCardModel) => void;
	onCancelAutomaticAction?: (taskId: string) => void;
	// Task Pinboard（置顶板）：请求置顶（由上层弹原因对话框，确认后才真正写盘）与直接取消置顶。
	onRequestPinToTaskPinboard?: (taskId: string) => void;
	onUnpinFromTaskPinboard?: (taskId: string) => void;
	isMoveToTrashLoading?: boolean;
	isMoveToValidationLoading?: boolean;
	isMoveToReviewLoading?: boolean;
	workspacePath?: string | null;
	/** 只读解析预定工作区的绝对路径；Backlog 不需要创建工作树或启动会话。 */
	resolveTaskWorkspaceAbsoluteDirectoryPath?: (task: BoardCardModel) => Promise<string | null>;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}

/**
 * 注入式 DnD 绑定。由 `BoardCard` 从 `@hello-pangea/dnd` 的 `provided`/`snapshot`
 * 装配后下传；`TaskCardBody` 自身不引用 `<Draggable>`，因此可被各种无 DnD 的副本渲染角色复用。
 */
export interface TaskCardBodyDragBindings {
	innerRef: (element?: HTMLElement | null) => void;
	draggableProps: DraggableProvidedDraggableProps;
	dragHandleProps: DraggableProvidedDragHandleProps | null;
	isDragging: boolean;
	draggableStyle?: DraggableStyle;
}

/**
 * 同一张任务卡在界面上可能同时存在多份 DOM，本枚举声明「这一份是哪一份」。
 *
 * 只有 `canonical_card_in_its_stage_list` 那一份携带 `data-task-id` / `data-verification-anchor`
 * 并绑定 DnD。这不是风格偏好而是硬约束：程序化拖动、Focus View 居中滚动、sticky 几何测量、
 * Post-Deploy Verification 高亮全都以「`data-task-id` 全局唯一」为前提。
 */
export type TaskCardBodyRenderRole =
	// 本体：卡片在它自己所属 stage 列表里的那一份，唯一可拖、唯一持有 DOM 身份。
	| "canonical_card_in_its_stage_list"
	// Focus View：焦点卡滚出视野时，跟着 sticky stage 卡头一起留在视野里的那份只读副本。
	// 纯为「别让我正在看的任务跑出屏幕」而存在，因此关掉全部卡级指针交互，只留 hover 动作组。
	| "focused_card_copy_under_sticky_stage_header"
	// All projects 左栏的当前任务副本：分组外保底展示或上下沿 Sticky，无本体 DOM 身份与卡级导航。
	| "focused_task_card_copy_in_cross_project_task_switcher"
	// 手机详情顶部的当前任务副本：完整元数据、常驻触控动作，不拖拽、不持有本体 DOM 身份、不点击跳转。
	| "focused_task_card_copy_in_mobile_detail_header"
	// Task Pinboard：被置顶的卡片在置顶板里的分身。除不可拖、不持有 DOM 身份外，
	// 交互与本体一致（单击进详情、双击改标题、全部动作按钮）。
	| "pinned_card_copy_in_task_pinboard"
	// All projects 切换面板里原地展开的一行（hover 展开 / 固定展开，可以是任何项目的卡）。同置顶板分身：不可拖、
	// 不持有 DOM 身份，动作按钮与本体一致；不显示置顶板专属的 stage 标签与原因行。单击与点那一行的精简行
	// 同一结果（面板的主动作是切换任务）：不延迟、不接双击改标题（铅笔照旧可改），Done 也能点开。
	| "expanded_card_copy_in_cross_project_task_switcher_row"
	// Post-Deploy Verification 面板里一个任务条目的上半部分（下半部分的核对清单由条目 wrapper 自己渲染）。
	// 不可拖；`data-task-id` 与 verification 锚点留在 wrapper 上（wrapper 挂 `verification-panel-task:<taskId>`），
	// 卡体副本一律不输出。其余交互与置顶板分身一致、即与本体一致：单击进详情（会跳转的列延迟单击留出双击窗口）、
	// 双击改标题、全部动作按钮（移入 Done 等动作照样经看板同一组 handler，因而同样过 PDV 门禁）；Done 卡不可点开。
	// 不显示置顶板专属的 stage 标签与原因行——所在列由 wrapper 的徽标表达。
	| "task_card_copy_in_post_deploy_verification_panel_entry"
	| "permanently_deleted_task_history_card";

/**
 * 仅 All projects 切换面板的行副本（`expanded_card_copy_in_cross_project_task_switcher_row`）：精简行上有、卡体本身没有的
 * 行级信息与开关。并进卡体已有的位置，不在卡片上方另叠一条——另叠一条会把标题往下挤，hover 前后标题跳位。
 */
export interface TaskCardBodyCrossProjectTaskSwitcherRowElements {
	/** 首行前导位，替换 Spinner / 失败图标：与精简行同一个前导点，三态之间标题左沿不动。「在跑 / 失败」由下方会话活动行表达。 */
	firstLineLeadingActivityIndicator: ReactNode;
	/** 元信息行最左，对应精简行第 2 行最左的项目名；null = 只有一个项目。 */
	projectName: string | null;
	/** 元信息行右侧药丸组最前，对应精简行第 2 行右侧。 */
	promptCacheWarmthPill: ReactNode;
	/** hover 动作组最右一格：与精简行上的展开开关同一坐标（动作组位置见下方常量）。 */
	inListExpansionToggle: ReactNode;
	/**
	 * true = 这一行刚因 hover 原地展开、指针还在它上面：第一帧就以 hover 态呈现（动作组、底色）。展开发生在静止的
	 * 光标下，卡体要等指针再动一下才收到 mouseenter——否则精简行上刚看到的展开开关会在换成卡片的那一刻消失。
	 */
	isPresentedAsHoveredFromFirstFrame: boolean;
}

/**
 * All projects 切换面板一行里 hover 动作组的竖直位置：叠在首行**上方**，底边落在首行字形之上——与标准密度卡片把动作组
 * 伸出上边框（-top-[6px]）同一个思路，首行的字不被盖住，也不为它在右侧预留空白（预留会让长标题提前折行、
 * 标题可用宽度变窄）。精简行、卡体（`expanded_card_copy_in_cross_project_task_switcher_row`）、卡体兜底三处共用，
 * 最右一格的展开开关因此三态同一坐标。代价：行间只有 2px，动作组上半截会伸进上一行的右下角，hover 时盖住那里几像素。
 * 分区第一行上方不是上一行而是分区 header（右侧有折叠按钮 / 排序下拉框），不能伸进去：见下方首行上外边距常量。
 * 一般紧凑密度（Focus View 左栏列表）仍是 top-1，压在首行右端。
 */
export const CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_VERTICAL_POSITION_ABOVE_FIRST_LINE_CLASS_NAME =
	"-top-3";
// 上面那个类名伸出行顶边的距离（-top-3 = 12px）：面板把一行的顶边滚回可视区时，连动作组一起露出来。
export const CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_OVERHANG_ABOVE_ROW_TOP_EDGE_PX = 12;
/**
 * 行根节点是分区内容容器的第一个子节点时（紧挨分区 header 的第一行）上方留出 16px（mt-4）=
 * 动作组伸出行顶边的 12px（`CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_OVERHANG_ABOVE_ROW_TOP_EDGE_PX`）
 * + 动作组最右一格展开开关的命中区伪元素再向上扩的 4px（cross-project-recently-active-task-switcher-full-task-card-in-list-expansion-toggle-button.tsx
 * 的 `IN_LIST_EXPANSION_TOGGLE_HIT_AREA_EXTENDED_UP_AND_RIGHT_BEYOND_BUTTON_BOX_CLASS_NAME` 里的 `after:-top-1`）。
 * 只让出 12px 时动作组盒子顶边落在 header 底边上，但开关命中区仍高出 header 底边 4px，伸进 Pinned / Running 折叠按钮
 *（h-9 header 里居中的 h-8，底边距 header 底边 2px）的底沿约 2px、截走点击。让出 16px 后命中区顶边正好落在 header 底边上，
 * 不盖住 header 里的折叠按钮（Pinned / Running）与排序下拉框（Recent），指针从首行往上移时不截走它们的点击。
 * 改伸出量或命中区向上扩展量中的任何一项，这里都要跟着改（真实浏览器集成测试阶段 6 用 elementFromPoint 在 header 底沿取点守着）。
 * 三态共用行根节点，首行整体下移、三态之间仍同一坐标；非首行不受影响（非首行开关命中区仍是 24×24）。
 * 第一个子节点是别的东西（Recent「Unread + opened」排序下的小标题、空态提示）时不生效：那时首行不紧挨 header，也不多出空白。
 */
export const CROSS_PROJECT_TASK_SWITCHER_FIRST_ROW_DIRECTLY_BELOW_SECTION_HEADER_TOP_MARGIN_CLEARING_HOVER_ACTION_GROUP_OVERHANG_AND_EXPANSION_TOGGLE_HIT_AREA_UPWARD_EXTENSION_CLASS_NAME =
	"first:mt-4";

/**
 * 任务卡的纯展示卡体（卡壳 + 内层可视卡 + 全部展示态/交互）。
 *
 * 各渲染角色见 `TaskCardBodyRenderRole`；本组件对角色差异的处理全部收敛在下方那组派生布尔里，
 * 各处 JSX 只读布尔、不再重复判角色。
 */
type TaskCardBodyLivePresentationProps = TaskCardBusinessProps & {
	drag?: TaskCardBodyDragBindings | null;
	renderRole?: TaskCardBodyRenderRole;
	/**
	 * 非 null = 这张卡属于**另一个**项目（All projects 面板的展开行）。卡体里几个推流 store 只按 taskId 分键、只装
	 * 当前项目的数据，跨项目同号会读到别人的值，所以此时一律不读它们：git 元数据改读跨项目轮询 store，资源占用与
	 * 排队 prompt 不显示（这两样只对当前项目推流）。
	 */
	taskCardOwnedByOtherProjectWorkspaceId?: string | null;
	/** 当前项目展开卡的轮询复合键；普通看板卡继续只订阅推流 store。 */
	taskCardWorkspaceIdForCrossProjectGitMetadataPolling?: string | null;
	/** 仅置顶板分身：分身上 stage 标签的展示名，取自该卡真正所在 board 列的 `title`（trash 即 "Done"）。 */
	stageDisplayNameForTaskPinboardCopy?: string;
	/** 仅置顶板分身：点 stage 标签跳回原 stage 里的本体卡并高亮。 */
	onNavigateToCanonicalCardInItsStage?: (taskId: string) => void;
	/** 仅置顶板分身：点置顶原因行编辑原因。 */
	onEditTaskPinboardPinReason?: (taskId: string) => void;
	/** 仅 All projects 切换面板的行副本，见 TaskCardBodyCrossProjectTaskSwitcherRowElements。其他角色下忽略。 */
	crossProjectTaskSwitcherRowElementsMergedIntoCardCopy?: TaskCardBodyCrossProjectTaskSwitcherRowElements | null;
};
type TaskCardBodyResolvedPresentationProps = Omit<TaskCardBodyLivePresentationProps, "columnId"> & {
	columnId: BoardColumnId | null;
};
interface PermanentlyDeletedTaskCardBodyProps {
	historicalTaskCard: PermanentlyDeletedTaskCardEntry;
	historicalProjectName?: string;
	onOpenHistoricalPrompt: () => void;
}

export const TaskCardBody = memo(function TaskCardBody(
	input: TaskCardBodyLivePresentationProps | PermanentlyDeletedTaskCardBodyProps,
): React.ReactElement {
	const historicalContext = "historicalTaskCard" in input ? input : null;
	const historicalSnapshot = historicalContext?.historicalTaskCard;
	// 只供 JSX 使用的视图模型，不进入 board，也不传入任何任务变更命令。
	const presentation: TaskCardBodyResolvedPresentationProps = historicalSnapshot
		? {
				card: {
					id: historicalSnapshot.kanbanBoardCard.taskId,
					title: historicalSnapshot.titleBeforePermanentRemoval ?? "标题未留存",
					prompt: historicalSnapshot.promptPreview ?? "",
					createdAt: historicalSnapshot.kanbanBoardCard.taskIncarnationCreatedAtEpochMs,
					updatedAt: historicalSnapshot.permanentlyRemovedFromBoardAt,
					startInPlanMode: false,
					baseRef: "",
				},
				columnId: null,
				renderRole: "permanently_deleted_task_history_card",
				onClick: () => historicalContext?.onOpenHistoricalPrompt(),
			}
		: (input as TaskCardBodyLivePresentationProps);
	const {
		card,
		columnId,
		sessionSummary,
		selected = false,
		onClick,
		onStart,
		onMoveToTrash,
		onMoveToValidation,
		onMoveToReview,
		onRestoreFromTrash,
		onDeleteTask,
		onSaveTitle,
		onOpenTaskEditor,
		onCancelAutomaticAction,
		onRequestPinToTaskPinboard,
		onUnpinFromTaskPinboard,
		isMoveToTrashLoading = false,
		isMoveToValidationLoading = false,
		isMoveToReviewLoading = false,
		workspacePath,
		resolveTaskWorkspaceAbsoluteDirectoryPath,
		defaultClineModelId = null,
		defaultAgentId = null,
		drag = null,
		renderRole = "canonical_card_in_its_stage_list",
		stageDisplayNameForTaskPinboardCopy,
		onNavigateToCanonicalCardInItsStage,
		onEditTaskPinboardPinReason,
		taskCardOwnedByOtherProjectWorkspaceId = null,
		taskCardWorkspaceIdForCrossProjectGitMetadataPolling = null,
		crossProjectTaskSwitcherRowElementsMergedIntoCardCopy = null,
	} = presentation;

	const isCompactRowInFocusViewLeftColumn = useTaskCardBodyVisualDensity() === "compact_row_in_focus_view_left_column";
	const [isHovered, setIsHovered] = useState(false);
	// 卡片多数 Tooltip（右上角动作组、行内 Edit、头部药丸、git 状态）content 统一收成
	// 「hover 时才给」：Radix 在关闭态仍会挂 Root+Trigger（Popper context + state + 一串事件绑定）。
	// 200 张卡 × 数个 Tooltip = 上千个常驻实例，看板每次重渲都要 reconcile 一遍。`Tooltip` 对 falsy
	// `content` 直接返回 children，空闲态就退化成裸元素。头部药丸 / git 状态的触发点是不可聚焦的
	// span，键盘可达性不受门控影响；动作按钮靠 aria-label 保留可访问名。
	// 目录复制的 ID tooltip 常驻，保证键盘聚焦也能立即看到完整 ID。
	//
	// 注意这里刻意**不**改成条件挂载整个动作组：未挂载的按钮无法被 Tab 到，而卡壳本身不可聚焦，
	// backlog 这类没有标题编辑按钮的卡会因此彻底失去键盘可达性。DOM 常驻 + CSS `focus-within`
	// 才是原本保住 Tab 可达的机制。
	const revealHoverActionTooltip = (label: string | null): string | undefined =>
		isHovered && label ? label : undefined;
	const [isPromptViewerOpen, setIsPromptViewerOpen] = useState(false);
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [draftTitle, setDraftTitle] = useState(card.title);
	const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
	const titleEditCancelledRef = useRef(false);
	const isTaskCardOwnedByOtherProject = historicalSnapshot != null || taskCardOwnedByOtherProjectWorkspaceId !== null;
	const taskWorkspaceId =
		taskCardOwnedByOtherProjectWorkspaceId ?? taskCardWorkspaceIdForCrossProjectGitMetadataPolling;
	const currentProjectReviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(
		isTaskCardOwnedByOtherProject ? null : card.id,
	);
	const polledReviewWorkspaceSnapshot = useCrossProjectTaskWorktreeGitMetadataSnapshotValue(
		taskWorkspaceId ?? "",
		card.id,
		taskWorkspaceId != null && (isTaskCardOwnedByOtherProject || currentProjectReviewWorkspaceSnapshot == null),
	);
	const reviewWorkspaceSnapshot = isTaskCardOwnedByOtherProject
		? polledReviewWorkspaceSnapshot
		: (currentProjectReviewWorkspaceSnapshot ?? polledReviewWorkspaceSnapshot);
	const taskWorkspaceInfo = useTaskWorkspaceInfoValue(isTaskCardOwnedByOtherProject ? null : card.id, card.baseRef);
	const taskAgentSessionLaunchHistoryEvidence = resolveTaskAgentSessionLaunchHistoryEvidence({
		mostRecentlyLaunchedAgentSessionAgentId: card.mostRecentlyLaunchedAgentSessionAgentId,
		taskWorktreeExists: taskWorkspaceInfo?.exists,
	});
	const [openedQuickActionMenu, setOpenedQuickActionMenu] = useState<"done" | "prompt" | null>(null);
	const isTrashCard = columnId === "trash";
	// 只有本体持有 DOM 身份（data-task-id / data-verification-anchor）与 DnD 绑定，见 TaskCardBodyRenderRole。
	const emitsCanonicalDomIdentity = renderRole === "canonical_card_in_its_stage_list";
	// sticky 卡头副本纯为「别让焦点卡跑出屏幕」而存在，是只读镜像：卡级指针交互一律关闭。
	const isPassiveFocusedTaskCardCopy =
		renderRole === "focused_card_copy_under_sticky_stage_header" ||
		renderRole === "focused_task_card_copy_in_cross_project_task_switcher";
	const isMobileDetailHeaderCopy = renderRole === "focused_task_card_copy_in_mobile_detail_header";
	// 置顶板分身专属的 stage 标签 / 原因行只认这一个角色；PDV 面板条目副本（task_card_copy_in_post_deploy_verification_panel_entry）
	// 在下面每个派生布尔里都落在与置顶板分身相同的一侧：不可拖、无 DOM 身份、可单击 / 双击、Done 卡不可点开。
	const isTaskPinboardCopy = renderRole === "pinned_card_copy_in_task_pinboard";
	// All projects 切换面板的行副本：单击必须与点精简行同一结果（见 TaskCardBodyRenderRole），Done 卡也能点开。
	const isCrossProjectTaskSwitcherRowCopy = renderRole === "expanded_card_copy_in_cross_project_task_switcher_row";
	const crossProjectTaskSwitcherRowElements = isCrossProjectTaskSwitcherRowCopy
		? crossProjectTaskSwitcherRowElementsMergedIntoCardCopy
		: null;
	const isCardInteractive = (!isTrashCard || isCrossProjectTaskSwitcherRowCopy) && !isPassiveFocusedTaskCardCopy;
	// 切换面板的行副本：「点卡体 = 打开任务」只挂在卡壳的 onClick 上，键盘够不到（精简行有主按钮，展开后没有）。
	// 标题兼作打开任务的键盘入口（Enter / Space，与点卡体同一个 onClick）；标题里没有别的可交互元素，不形成交互元素
	// 嵌套，也不改标题几何。其他角色不变。
	const isTitleKeyboardEntryOpeningTaskFromCrossProjectTaskSwitcherRow =
		(isCrossProjectTaskSwitcherRowCopy || historicalSnapshot != null) && onClick != null;
	// 动作组 / 底色 / 复制按钮的 hover 呈现；tooltip 仍只认真实 hover（见 revealHoverActionTooltip）。
	const isHoverPresentationShown =
		historicalSnapshot != null ||
		isHovered ||
		openedQuickActionMenu !== null ||
		crossProjectTaskSwitcherRowElements?.isPresentedAsHoveredFromFirstFrame === true;
	// 会跳转的列上双击改标题需先拦截单击；这些列单击会打开详情、替换看板。
	const isNavigatingColumn = columnId === "in_progress" || columnId === "review" || columnId === "validation";
	// 双击改标题覆盖 in_progress / review / validation / done(trash)，不含 backlog；只读镜像不参与编辑；
	// 切换面板的行副本也不接（单击要立即生效，改标题走铅笔）。
	const isInlineTitleEditEnabled =
		!isPassiveFocusedTaskCardCopy &&
		!isCrossProjectTaskSwitcherRowCopy &&
		onSaveTitle != null &&
		(isNavigatingColumn || isTrashCard);
	const delaysSingleClickActivationForDoubleClickTitleEdit = isNavigatingColumn && !isCrossProjectTaskSwitcherRowCopy;
	const clickActivationTimerRef = useRef<number | null>(null);
	const cardDragBindings = isMobileDetailHeaderCopy ? null : drag;
	const isDragging = cardDragBindings?.isDragging ?? false;
	const rawSessionActivity = useMemo(() => deriveCardSessionActivity(sessionSummary), [sessionSummary]);
	const lastSessionActivityRef = useRef<CardSessionActivity | null>(null);
	const lastSessionActivityCardIdRef = useRef<string | null>(null);
	if (lastSessionActivityCardIdRef.current !== card.id) {
		lastSessionActivityCardIdRef.current = card.id;
		lastSessionActivityRef.current = null;
	}
	if (rawSessionActivity) {
		lastSessionActivityRef.current = rawSessionActivity;
	}
	const sessionActivity = rawSessionActivity ?? lastSessionActivityRef.current;
	// 「computing 脉动」（双轴重构 Stage 3，distinction ①）：agent 回合且最近 5s 内仍在产出 PTY 输出时，
	// 状态点脉动表示「在算」；静默(quiet)/其它态保持现状静止点。computing/quiet 是随时间漂移的派生叠加
	// （deriveDisplayLiveness，见 session-activity.ts），summary 静默期不再广播，故需一个秒级 tick 让卡片在
	// 跨过静默边界后停止脉动；tick 走共享细时钟（use-shared-fine-clock），且仅在「agent 回合 + liveness=live
	// 且未 parked」时订阅，空闲 / 待审 / 已结束卡不订阅、不随秒级 tick 重渲。
	const sessionFacets = sessionSummary ? resolveSessionFacets(sessionSummary) : null;
	// parked（已派发后台工作、等自行恢复）：纯展示信号——它是普通 agent 回合 {agent,live,null}，但**不在算**，
	// 是在等自己派发的后台工作。读 sidecar（非 facet，deriveDisplayLiveness 不动），抑制 computing 脉冲并渲染
	// parked 徽标，让卡片不再误显示「转圈在算」。
	const isParkedAwaitingBackgroundWork = isParkedAwaitingDispatchedBackgroundWork(sessionSummary);
	// 程序化投递正等着这张卡的终端输入框腾出来（计划 §4.4）：在看板上就要看得见，否则又是一次「机器在等、屏幕不说」。
	// 排队 prompt（主会话的队列；by-the-way 子会话的队列只在详情视图里看）。按 taskId 订阅 store，
	// 只有这张卡自己的队列变了才重渲。
	const queuedPromptProjections = useQueuedTaskPromptDeliveryProjectionsForTask(
		isTaskCardOwnedByOtherProject ? null : card.id,
	);
	const queuedPromptCountIndicator = useMemo(
		() => summarizeQueuedTaskPromptDeliveryCountIndicator(queuedPromptProjections),
		[queuedPromptProjections],
	);
	const terminalDeliveryContentionNotice = describeTerminalDeliveryContention(
		sessionSummary?.terminalDeliveryContention ?? null,
	);
	const isLiveAgentTurn = sessionFacets?.turnOwner === "agent" && sessionFacets.liveness === "live";
	// channel B（distinction ②）：终端 agent 进程已退、任务仍等你审 → liveness==="exited"（Cline SDK 在
	// 进程内运行、恒 live，永不进此分支）。卡片状态点改「空心环」表达「进程已退但仍待你处理」，与实心 live
	// 点区分；点的颜色仍随 channel C（review绿/needs_input金/error红）。pulse 仅 agent 回合开启、与本互斥。
	const isExitedAwaiting = sessionFacets?.liveness === "exited";
	const activityNowMs = useSharedFineClockTimestampMs(isLiveAgentTurn && !isParkedAwaitingBackgroundWork);
	// 头部时长读数的常开粗 tick（30s）：读数粒度是分/时/天，30s 足够，且常开不分 live/idle
	// （与上面仅 live 卡的 1s computing tick 解耦）。走进程内单例时钟而非每卡一个 setInterval：
	// 200 张卡原先 = 200 个常开定时器，且完全不分标签页可见性。共享时钟只留一个定时器 +
	// 一个 visibilitychange 监听，隐藏时整体停摆。
	const elapsedNowMs = useSharedCoarseClockTimestampMs();

	// ── 头部两颗时长药丸，读的是**两个不同的量**，别再合并回一个 ────────────────────────────────
	// 历史上这里只有一颗，读 lastSubstantiveOutputAt 冒充「agent 上次回复」，于是「今天重开一个七天前
	// 的会话」会把它刷成 now——旧对话被重播进新 TUI，实质分类器的行签名记忆是空的，整段旧内容被判成
	// 新产出。实测 26% 的 claude 任务因此显示错误（偏差中位数 26.8 小时）。修法不是继续给分类器打补丁，
	// 而是承认这里本来就要显示两件不同的事：
	//   Stopped（本轮停了多久）——读 agentResponseGenerationStopped，per-incarnation 的离散状态转移。
	//     会话重开时刷新是**正确**的（新活体新一轮），它与 2h 回收共用同一个锚点定义。
	//     agent 回合 / park 期间为 null ⇒ 不显示，此刻由 computing 脉动 / parked 徽标表达。
	//   Progress（对话上次推进）——读 lastConversationProgressObservation，**跨 incarnation 的历史事实**。
	//     进程重启、会话重开、旧对话被重播，它都不该动；权威来源是 agent 自己的落盘转录。
	const agentResponseGenerationStoppedAt = sessionSummary?.agentResponseGenerationStopped?.stoppedAt ?? null;
	const lastConversationProgressObservation = sessionSummary?.lastConversationProgressObservation ?? null;
	// 低置信来源（无转录、无 hook 的 agent 落到 TUI 刮取分类器）以 `~` 前缀如实标注「大约」，
	// 而不是假装精确。判据集中在 core，避免前端各处手写枚举比对。
	const isConversationProgressApproximate =
		lastConversationProgressObservation !== null &&
		isLowConfidenceLastConversationProgressEvidence(lastConversationProgressObservation.evidenceKind);
	// 三处头部 tooltip 的绝对时间文案按时间戳记忆：toLocaleString 每次调用都不便宜，而卡片会随
	// 1s 细时钟 / 30s 粗时钟 / hover 反复重渲，时间戳本身却极少变化。
	const createdAtTooltipContent = useMemo(
		() => `Created · ${new Date(card.createdAt).toLocaleString()}`,
		[card.createdAt],
	);
	const agentResponseGenerationStoppedTooltipContent = useMemo(
		() =>
			agentResponseGenerationStoppedAt != null
				? `Stopped generating · ${new Date(agentResponseGenerationStoppedAt).toLocaleString()}`
				: null,
		[agentResponseGenerationStoppedAt],
	);
	const lastConversationProgressTooltipContent = useMemo(
		() =>
			lastConversationProgressObservation != null
				? `Conversation last advanced · ${new Date(
						lastConversationProgressObservation.observedAtMs,
					).toLocaleString()} · source: ${lastConversationProgressObservation.evidenceKind}`
				: null,
		[lastConversationProgressObservation],
	);
	const isAgentComputing =
		isLiveAgentTurn && !isParkedAwaitingBackgroundWork && sessionSummary != null && sessionFacets != null
			? deriveDisplayLiveness(sessionFacets, sessionSummary.lastOutputAt, activityNowMs) === "computing"
			: false;
	// computing 时会话活动点按 1Hz 呼吸（不用 animate-pulse，理由见该 hook）；activityNowMs 在 computing 时本就订阅着细时钟。
	const sessionActivityDotBreathingOpacity =
		!isTrashCard && isAgentComputing
			? resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp(activityNowMs)
			: undefined;
	const displayTitle = useMemo(
		() => normalizePromptForDisplay(card.title) || truncateTaskPromptLabel(card.prompt),
		[card.prompt, card.title],
	);

	// 卸载时清掉尚未触发的延迟单击计时器，避免对已销毁卡片调用 onClick。
	useEffect(
		() => () => {
			if (clickActivationTimerRef.current != null) {
				clearTimeout(clickActivationTimerRef.current);
				clickActivationTimerRef.current = null;
			}
			if (directoryCopyResetTimerRef.current != null) {
				clearTimeout(directoryCopyResetTimerRef.current);
				directoryCopyResetTimerRef.current = null;
			}
		},
		[],
	);

	useEffect(() => {
		setDraftTitle(card.title);
		setIsEditingTitle(false);
	}, [card.id, card.title]);

	useEffect(() => {
		if (!isEditingTitle) {
			return;
		}
		window.requestAnimationFrame(() => {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		});
	}, [isEditingTitle]);

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const submitTitle = () => {
		if (titleEditCancelledRef.current) {
			titleEditCancelledRef.current = false;
			return;
		}
		setIsEditingTitle(false);
		if (!onSaveTitle) {
			return;
		}
		const trimmed = draftTitle.trim();
		if (trimmed === card.title) {
			return;
		}
		onSaveTitle(card.id, trimmed);
	};

	const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// 输入法组字期间，按键属于输入法本身（上屏字符原文、翻候选页、取消组字），处理器必须整体让开。
		if (isKeyboardEventEmittedDuringImeComposition(event)) {
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			titleInputRef.current?.blur();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			titleEditCancelledRef.current = true;
			setDraftTitle(card.title);
			setIsEditingTitle(false);
			titleInputRef.current?.blur();
		}
	};

	const isCreditLimit = isCardCreditLimitError(sessionSummary);
	const renderStatusMarker = () => {
		if (isCreditLimit) {
			return <AlertTriangle size={12} className="text-status-orange" />;
		}
		if (columnId === "in_progress") {
			// 旧 `state==="failed"`（spawn 失败）→ facet 真相源：严格等价 turnOwner==="user" && liveness==="failed"
			// （projectLegacyState 仅此组合投影回 failed；agent 回合先投影为 running）。复用上方已解析的 sessionFacets。
			if (sessionFacets?.turnOwner === "user" && sessionFacets.liveness === "failed") {
				return <AlertCircle size={12} className="text-status-red" />;
			}
			// 静态图标而非旋转的 Spinner：In Progress 列的每张卡都有这个标记，无限旋转会让看板页可见期间一直逐帧合成。
			// agent 此刻是否在产出由下方会话活动行的呼吸点表达。
			return (
				<CircleDotDashed
					size={12}
					className="text-text-secondary"
					data-task-card-in-progress-column-status-marker="static"
				/>
			);
		}
		return null;
	};
	const statusMarker = renderStatusMarker();
	const showWorkspaceStatus =
		columnId === "in_progress" || columnId === "review" || columnId === "validation" || isTrashCard;
	const reviewWorkspacePath = reviewWorkspaceSnapshot
		? formatPathForDisplay(reviewWorkspaceSnapshot.path)
		: isTrashCard
			? card.worktreeMode === "inplace"
				? workspacePath
					? formatPathForDisplay(workspacePath)
					: null
				: reconstructTaskWorktreeDisplayPath(card.id, workspacePath)
			: null;
	const reviewChangeSummary =
		reviewWorkspaceSnapshot &&
		reviewWorkspaceSnapshot.changedFiles != null &&
		shouldDisplayWorktreeUncommittedChangeSummary(reviewWorkspaceSnapshot)
			? {
					changedFiles: reviewWorkspaceSnapshot.changedFiles,
					additions: reviewWorkspaceSnapshot.additions ?? 0,
					deletions: reviewWorkspaceSnapshot.deletions ?? 0,
				}
			: null;
	const showDirectoryRow = showWorkspaceStatus && Boolean(reviewWorkspacePath);
	const showTitleEditButton =
		(onSaveTitle != null || onOpenTaskEditor != null) && !isPassiveFocusedTaskCardCopy && !isEditingTitle;
	// 「已置顶」由 pinnedToTaskPinboardAt 的存在表达（见 state/task-pinboard-pinning.ts），没有冗余布尔。
	const isPinnedToTaskPinboard = card.pinnedToTaskPinboardAt !== undefined;
	// hover 动作组里那颗按钮：图标表示**动作**（要做什么），至于「这张卡已置顶」的常驻提示走左上角胶囊，
	// 因为动作组在非 hover 态是 opacity-0，只靠它的话浏览原 stage 时根本看不出哪张卡被置顶了。
	const taskPinboardToggle = useMemo(() => {
		if (isPinnedToTaskPinboard) {
			if (!onUnpinFromTaskPinboard) {
				return null;
			}
			return {
				isPinned: true,
				tooltip: "Unpin from pinboard",
				ariaLabel: "Unpin task from pinboard",
				activate: () => onUnpinFromTaskPinboard(card.id),
			};
		}
		if (!onRequestPinToTaskPinboard) {
			return null;
		}
		return {
			isPinned: false,
			tooltip: "Pin to pinboard",
			ariaLabel: "Pin task to pinboard",
			activate: () => onRequestPinToTaskPinboard(card.id),
		};
	}, [card.id, isPinnedToTaskPinboard, onRequestPinToTaskPinboard, onUnpinFromTaskPinboard]);
	// 置顶原因行同时是「编辑置顶原因」的唯一入口，所以原因为空时这一行不能整行消失：空原因是受支持的正常置顶
	// 路径（对话框只给一次填写机会、不设门槛）。整行消失后已置顶的分身上就只剩 Unpin，想事后补一句原因只能
	// unpin 再 pin —— 而 re-pin 会刷新 pinnedToTaskPinboardAt，把卡顶到置顶板最前、白白丢掉原有的排序位置。
	// 因此原因为空且接了编辑回调时，该行退化成一个弱化的「Add pin reason」入口；本体卡照旧完全不铺开原因。
	const taskPinboardPinReasonTextOrEmpty = card.taskPinboardPinReason?.trim() ?? "";
	const hasTaskPinboardPinReasonText = taskPinboardPinReasonTextOrEmpty !== "";
	const showsTaskPinboardPinReasonRowOnThisCopy =
		isTaskPinboardCopy && !isEditingTitle && (hasTaskPinboardPinReasonText || onEditTaskPinboardPinReason != null);
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;
	// 始终显示任务的 effective agent，按运行期同一套优先级解析：
	// 上次运行已锁定（sessionSummary.agentId）?? 任务级覆盖（card.agentId）?? 全局默认（defaultAgentId）
	// 与 src/trpc/runtime-api.ts 的解析顺序一致。
	const effectiveAgentId = sessionSummary?.agentId ?? card.agentId ?? defaultAgentId;
	const agentVisual = getAgentVisual(effectiveAgentId);
	const agentLabel = useMemo(() => {
		if (!effectiveAgentId) {
			return null;
		}
		return getRuntimeAgentCatalogEntry(effectiveAgentId)?.label ?? effectiveAgentId;
	}, [effectiveAgentId]);
	const modelOverrideLabel = useMemo(() => {
		if (card.clineSettings === undefined) {
			return null;
		}
		const explicitReasoningLabel = card.clineSettings.reasoningEffort
			? formatClineReasoningEffortLabel(card.clineSettings.reasoningEffort)
			: !card.clineSettings.providerId && !card.clineSettings.modelId
				? "Default"
				: null;
		if (card.clineSettings.providerId && !card.clineSettings.modelId) {
			const providerLabel = `Provider: ${card.clineSettings.providerId}`;
			return explicitReasoningLabel ? `${providerLabel} (${explicitReasoningLabel})` : providerLabel;
		}
		const effectiveModelId = card.clineSettings.modelId ?? defaultClineModelId;
		if (!effectiveModelId) {
			return explicitReasoningLabel ? `Default model (${explicitReasoningLabel})` : null;
		}
		const modelName = resolveClineModelDisplayName(effectiveModelId);
		if (explicitReasoningLabel) {
			return `${modelName} (${explicitReasoningLabel})`;
		}
		const inheritedReasoningEffort = "";
		return formatClineSelectedModelButtonText({
			modelName,
			reasoningEffort: inheritedReasoningEffort,
			showReasoningEffort: Boolean(inheritedReasoningEffort),
		});
	}, [card.clineSettings, defaultClineModelId]);
	const taskAgentSettingsLabel = useMemo(() => {
		const parts = [agentLabel, modelOverrideLabel].filter((value): value is string => Boolean(value));
		return parts.length > 0 ? parts.join(" · ") : null;
	}, [agentLabel, modelOverrideLabel]);
	// 简写目录行：{worktree/inplace} ↑{ahead} ↓{behind} ({changed files} +{add} -{del})。
	// ahead/behind 是与 base 分支的双向分歧（两侧皆 0 时整体不渲染）；工作区脏统计仍相对 HEAD，
	// 但文件数与增删行数全为 0 时同样整体隐藏，避免无变化任务与真实脏任务争夺注意力。
	const worktreeModeLabel = card.worktreeMode === "inplace" ? "inplace" : "worktree";
	const commitsAheadOfBaseRef = reviewWorkspaceSnapshot?.commitsAheadOfBaseRef ?? null;
	const commitsBehindBaseRef = reviewWorkspaceSnapshot?.commitsBehindBaseRef ?? null;
	const taskCommitsIntegratedIntoBaseRef = reviewWorkspaceSnapshot?.taskCommitsIntegratedIntoBaseRef ?? null;
	const taskCommitIntegrationTrackingStatus = reviewWorkspaceSnapshot?.taskCommitIntegrationTrackingStatus;
	const showTaskCommitIntegrationIndicator = taskCommitIntegrationTrackingStatus !== undefined;
	const taskWorkspaceGitStatusTooltip = useMemo(
		() =>
			describeTaskWorkspaceGitStatusAgainstBaseRef({
				baseRef: card.baseRef,
				commitsAheadOfBaseRef,
				commitsBehindBaseRef,
				taskCommitsIntegratedIntoBaseRef,
				taskCommitIntegrationTrackingStatus,
			}),
		[
			commitsAheadOfBaseRef,
			commitsBehindBaseRef,
			card.baseRef,
			taskCommitIntegrationTrackingStatus,
			taskCommitsIntegratedIntoBaseRef,
		],
	);
	// 复制与 Git 元数据、目录行独立；无回调的宿主只可使用已知绝对路径，不能复制展示用的 ~/ 简写。
	const knownTaskWorkspaceAbsoluteDirectoryPath =
		card.worktreeMode === "inplace" ? workspacePath : reviewWorkspaceSnapshot?.path;
	// resolver 的函数身份可能随宿主重渲改变；只按影响路径的任务/项目参数失效。
	const directoryPathResolutionForCopy = useMemo(
		() => ({ directoryPath: null as string | null, promise: null as Promise<string> | null }),
		[card.id, card.baseRef, card.worktreeMode, workspacePath, taskCardOwnedByOtherProjectWorkspaceId],
	);
	const currentDirectoryPathResolutionForCopyRef = useRef(directoryPathResolutionForCopy);
	currentDirectoryPathResolutionForCopyRef.current = directoryPathResolutionForCopy;
	const prepareTaskWorkspaceDirectoryPathForCopy = (): Promise<string> => {
		if (knownTaskWorkspaceAbsoluteDirectoryPath) {
			return Promise.resolve(knownTaskWorkspaceAbsoluteDirectoryPath);
		}
		if (!directoryPathResolutionForCopy.promise) {
			directoryPathResolutionForCopy.promise = (
				resolveTaskWorkspaceAbsoluteDirectoryPath?.(card) ?? Promise.resolve(null)
			)
				.then((directoryPath) => {
					if (currentDirectoryPathResolutionForCopyRef.current !== directoryPathResolutionForCopy) {
						throw new Error("Task workspace settings changed. Please copy again.");
					}
					if (!directoryPath) {
						throw new Error("Could not resolve the task workspace directory.");
					}
					directoryPathResolutionForCopy.directoryPath = directoryPath;
					return directoryPath;
				})
				.catch((error) => {
					directoryPathResolutionForCopy.promise = null;
					throw error;
				});
		}
		return directoryPathResolutionForCopy.promise;
	};
	const prefetchTaskWorkspaceDirectoryPathForCopy = () => {
		void prepareTaskWorkspaceDirectoryPathForCopy().catch(() => {});
	};
	const showDirectoryCopyButton = Boolean(
		resolveTaskWorkspaceAbsoluteDirectoryPath || knownTaskWorkspaceAbsoluteDirectoryPath,
	);
	const [isDirectoryPathCopied, setIsDirectoryPathCopied] = useState(false);
	const directoryCopyResetTimerRef = useRef<number | null>(null);
	const handleCopyDirectoryPath = async () => {
		setIsDirectoryPathCopied(false);
		if (directoryCopyResetTimerRef.current != null) {
			clearTimeout(directoryCopyResetTimerRef.current);
		}
		try {
			const directoryPath = knownTaskWorkspaceAbsoluteDirectoryPath ?? directoryPathResolutionForCopy.directoryPath;
			if (!directoryPath && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
				// 在点击手势内启动写入；只把内容的解析延后，WebKit 不接受网络 await 后才调用 write。
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/plain": prepareTaskWorkspaceDirectoryPathForCopy().then(
							(path) => new Blob([path], { type: "text/plain" }),
						),
					}),
				]);
			} else if (!directoryPath) {
				// HTTP 无异步 Clipboard API：预取尚未完成时保留下一次点击的原生复制手势。
				prefetchTaskWorkspaceDirectoryPathForCopy();
				throw new Error("Directory path is still loading. Please try copying again.");
			} else {
				// 局域网 HTTP 没有 Clipboard API 时，helper 退回原生复制通道并检查其返回值。
				await writeTextToSystemClipboardWithInsecureContextFallback(directoryPath);
			}
			setIsDirectoryPathCopied(true);
			directoryCopyResetTimerRef.current = window.setTimeout(() => {
				setIsDirectoryPathCopied(false);
				directoryCopyResetTimerRef.current = null;
			}, 1500);
		} catch (error) {
			notifyError(error instanceof Error ? error.message : String(error));
		}
	};

	// ── 两种视觉密度共用的信息项（见 TaskCardBodyVisualDensity）：内容只此一份，密度只决定摆在哪里 ──
	const agentBadge = taskAgentSettingsLabel ? (
		<Tooltip content={revealHoverActionTooltip(taskAgentSettingsLabel)}>
			<span
				data-agent-badge=""
				role="img"
				aria-label={taskAgentSettingsLabel}
				className="inline-flex shrink-0 items-center"
			>
				<agentVisual.Icon
					size={isCompactRowInFocusViewLeftColumn ? 13 : 12}
					className={cn("shrink-0", isTrashCard ? "text-text-tertiary" : agentVisual.className)}
				/>
			</span>
		</Tooltip>
	) : null;
	// Clock=自创建至今（恒显）；PencilLine=Description 最后更新至今（仅 backlog，即该列排序键）；
	// Activity / MessagesSquare 见上方两颗时长药丸的注释。各段 hover 显绝对本地时间。
	const elapsedTimePills = (
		<>
			<Tooltip content={revealHoverActionTooltip(createdAtTooltipContent)}>
				<span
					className={cn(
						"inline-flex items-center gap-0.5 text-[10px] leading-none",
						isTrashCard ? "text-text-tertiary" : "text-text-secondary",
					)}
				>
					<Clock size={8} className="shrink-0" />
					{formatCompactElapsedSince(card.createdAt, elapsedNowMs)}
				</span>
			</Tooltip>
			{columnId === "backlog" ? (
				<>
					<span className="text-text-tertiary">·</span>
					<BacklogTaskDescriptionLastUpdatedPill
						card={card}
						elapsedNowMs={elapsedNowMs}
						revealHoverActionTooltip={revealHoverActionTooltip}
					/>
				</>
			) : null}
			{agentResponseGenerationStoppedAt != null ? (
				<>
					<span className="text-text-tertiary">·</span>
					<Tooltip content={revealHoverActionTooltip(agentResponseGenerationStoppedTooltipContent)}>
						<span
							data-agent-response-generation-stopped-pill=""
							className={cn(
								"inline-flex items-center gap-0.5 text-[10px] leading-none",
								isTrashCard ? "text-text-tertiary" : "text-text-secondary",
							)}
						>
							<Activity size={8} className="shrink-0" />
							{formatCompactElapsedSince(agentResponseGenerationStoppedAt, elapsedNowMs)}
						</span>
					</Tooltip>
				</>
			) : null}
			{lastConversationProgressObservation != null ? (
				<>
					<span className="text-text-tertiary">·</span>
					<Tooltip content={revealHoverActionTooltip(lastConversationProgressTooltipContent)}>
						<span
							data-last-conversation-progress-pill=""
							className={cn(
								"inline-flex items-center gap-0.5 text-[10px] leading-none",
								isTrashCard ? "text-text-tertiary" : "text-text-secondary",
							)}
						>
							<MessagesSquare size={8} className="shrink-0" />
							{isConversationProgressApproximate ? "~" : ""}
							{formatCompactElapsedSince(lastConversationProgressObservation.observedAtMs, elapsedNowMs)}
						</span>
					</Tooltip>
				</>
			) : null}
		</>
	);
	const resourceUsagePill = isTaskCardOwnedByOtherProject ? null : (
		<TaskCardResourceUsagePill
			taskCardId={card.id}
			isTrashCard={isTrashCard}
			revealHoverActionTooltip={revealHoverActionTooltip}
		/>
	);
	const pinnedMarkerOrTaskPinboardStageLabel = (
		<>
			{!isTaskPinboardCopy && isPinnedToTaskPinboard ? (
				// 置顶板里每张都是置顶的，那边不重复这个标记，改为显示 stage 标签（见下）。
				<>
					<span className="text-text-tertiary">·</span>
					<Tooltip
						content={
							card.taskPinboardPinReason
								? `Pinned to pinboard · ${card.taskPinboardPinReason}`
								: "Pinned to pinboard"
						}
					>
						<span
							data-task-pinboard-pinned-marker=""
							className={cn(
								"inline-flex shrink-0 items-center",
								isTrashCard ? "text-text-tertiary" : "text-accent",
							)}
						>
							<Pin size={8} className="shrink-0" />
						</span>
					</Tooltip>
				</>
			) : null}
			{isTaskPinboardCopy && stageDisplayNameForTaskPinboardCopy ? (
				<>
					<span className="text-text-tertiary">·</span>
					<Tooltip content={`In ${stageDisplayNameForTaskPinboardCopy} · click to reveal the card in its stage`}>
						<button
							type="button"
							data-task-pinboard-stage-label=""
							aria-label={`Reveal this task in ${stageDisplayNameForTaskPinboardCopy}`}
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								onNavigateToCanonicalCardInItsStage?.(card.id);
							}}
							className={cn(
								"inline-flex min-w-0 items-center gap-0.5 rounded-full text-[10px] leading-none hover:underline",
								isTrashCard ? "text-text-tertiary" : "text-text-secondary",
							)}
						>
							{columnId ? <ColumnIndicator columnId={columnId} size={8} /> : null}
							<span className="truncate">{stageDisplayNameForTaskPinboardCopy}</span>
						</button>
					</Tooltip>
				</>
			) : null}
		</>
	);

	// 「机器在等」的三种徽标（parked / 程序化投递等输入框 / 排队 prompt）。内容与判据两种密度一致，
	// 紧凑密度只是缩成行内小标签。
	const machineWaitingBadgeSizeClassName = isCompactRowInFocusViewLeftColumn
		? "gap-0.5 rounded-sm px-1 text-[10px] leading-4"
		: "gap-1 rounded-md px-1.5 py-0.5 text-xs";
	const machineWaitingBadgeIconSize = isCompactRowInFocusViewLeftColumn ? 10 : 12;
	const machineWaitingBadges: Array<{ machineWaitingBadgeKey: string; machineWaitingBadgeElement: ReactNode }> = [];
	if (!isTrashCard && isParkedAwaitingBackgroundWork) {
		machineWaitingBadges.push({
			machineWaitingBadgeKey: "parked_awaiting_dispatched_background_work",
			machineWaitingBadgeElement: (
				<span
					className={cn(
						"inline-flex max-w-full items-center border border-status-purple/30 bg-status-purple/10 text-status-purple",
						machineWaitingBadgeSizeClassName,
					)}
				>
					<Hourglass size={machineWaitingBadgeIconSize} className="shrink-0" />
					<span className="truncate">
						{sessionSummary?.awaitingDispatchedBackgroundWork?.label
							? `Parked — awaiting ${sessionSummary.awaitingDispatchedBackgroundWork.label}`
							: "Parked — awaiting dispatched background work"}
					</span>
				</span>
			),
		});
	}
	if (!isTrashCard && terminalDeliveryContentionNotice) {
		machineWaitingBadges.push({
			machineWaitingBadgeKey: "programmatic_terminal_delivery_waiting_for_input_box",
			machineWaitingBadgeElement: (
				<span
					className={cn(
						"inline-flex max-w-full items-center border border-status-orange/30 bg-status-orange/10 text-status-orange",
						machineWaitingBadgeSizeClassName,
					)}
				>
					<Hourglass size={machineWaitingBadgeIconSize} className="shrink-0" />
					<span className="truncate">{terminalDeliveryContentionNotice.headline}</span>
				</span>
			),
		});
	}
	// 仅在无争用提示时显示：两条「机器在等」的提示叠在一起只会互相淹没，争用那条更紧急。
	if (!isTrashCard && !terminalDeliveryContentionNotice && queuedPromptCountIndicator.pendingCount > 0) {
		machineWaitingBadges.push({
			machineWaitingBadgeKey: "queued_task_prompt_deliveries",
			machineWaitingBadgeElement: (
				<span
					className={cn(
						"inline-flex max-w-full items-center border",
						machineWaitingBadgeSizeClassName,
						queuedPromptCountIndicator.hasEntriesAwaitingReconfirmationAfterRestart
							? "border-status-orange/30 bg-status-orange/10 text-status-orange"
							: "border-border-bright bg-surface-3 text-text-secondary",
					)}
				>
					<ListOrdered size={machineWaitingBadgeIconSize} className="shrink-0" />
					<span className="truncate">
						{queuedPromptCountIndicator.pendingCount} queued
						{queuedPromptCountIndicator.hasEntriesAwaitingReconfirmationAfterRestart
							? " · confirm after restart"
							: ""}
					</span>
				</span>
			),
		});
	}
	const taskDirectoryRow = (
		<div
			data-task-directory=""
			className={cn("flex items-start gap-1 font-mono", isCompactRowInFocusViewLeftColumn ? "min-w-0" : "mt-1")}
			style={{
				fontSize: isCompactRowInFocusViewLeftColumn ? 11 : 12,
				lineHeight: 1.4,
				color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : SESSION_ACTIVITY_COLOR.secondary,
			}}
		>
			{card.worktreeMode === "inplace" ? (
				<Home size={10} className="shrink-0" />
			) : (
				<GitBranch size={10} className="shrink-0" />
			)}
			<span className={cn("min-w-0 flex-1 break-words", isTrashCard && "line-through")}>
				<span>{worktreeModeLabel}</span>
				{taskWorkspaceGitStatusTooltip ? (
					// Radix 的 Tooltip.Trigger 用 asChild 把事件与 ref 挂到子元素上，故子元素必须是真实 DOM 节点，
					// 不能直接是不转发 props/ref 的函数组件——否则 hover 根本触发不了 tooltip。
					<Tooltip side="bottom" content={revealHoverActionTooltip(taskWorkspaceGitStatusTooltip)}>
						<span className="mx-1 inline-flex align-middle">
							<AheadBehindIndicator
								ahead={commitsAheadOfBaseRef}
								behind={commitsBehindBaseRef}
								tone="semantic"
								iconSize={10}
							/>
							{showTaskCommitIntegrationIndicator ? (
								<span className="ml-1">
									<TaskCommitsIntegratedIntoBaseRefIndicator
										taskCommitsIntegratedIntoBaseRef={taskCommitsIntegratedIntoBaseRef}
									/>
								</span>
							) : null}
						</span>
					</Tooltip>
				) : null}
				{reviewChangeSummary ? (
					<>
						{" "}
						<WorktreeUncommittedChangeSummaryIndicator
							{...reviewChangeSummary}
							parenthesesAndChangedFileCountStyle={{ color: SESSION_ACTIVITY_COLOR.muted }}
						/>
					</>
				) : null}
			</span>
		</div>
	);

	const directoryCopyButton = (
		<Tooltip side="bottom" content={card.id} delayDuration={0}>
			<Button
				icon={isDirectoryPathCopied ? <Check size={12} className="text-status-green" /> : <Copy size={12} />}
				variant="ghost"
				size="xs"
				aria-label="Copy directory path"
				onPointerEnter={prefetchTaskWorkspaceDirectoryPathForCopy}
				onFocus={prefetchTaskWorkspaceDirectoryPathForCopy}
				onMouseDown={stopEvent}
				onClick={(event) => {
					stopEvent(event);
					void handleCopyDirectoryPath();
				}}
			/>
		</Tooltip>
	);

	const cardShell = (
		<div
			ref={cardDragBindings?.innerRef}
			{...(cardDragBindings?.draggableProps ?? {})}
			{...(cardDragBindings?.dragHandleProps ?? {})}
			className={cn(
				"kb-board-card-shell",
				isMobileDetailHeaderCopy && "[&_button]:min-h-[44px] [&_button]:min-w-[44px] [&_button_svg]:size-4",
			)}
			// 副本一律不输出 data-task-id：保证全局唯一（CSS sticky/scrollIntoView/测试计数依赖此唯一性）。
			data-task-id={emitsCanonicalDomIdentity ? card.id : undefined}
			// Post-Deploy Verification 引导定位锚点：guidance.anchor 可指向此看板任务卡（副本不输出，保唯一）。
			data-verification-anchor={emitsCanonicalDomIdentity ? boardTaskCardAnchorKey(card.id) : undefined}
			data-task-card-render-role={renderRole}
			data-column-id={columnId ?? undefined}
			data-selected={selected}
			onClick={
				isPassiveFocusedTaskCardCopy || isMobileDetailHeaderCopy
					? undefined
					: (event) => {
							// Radix Portal（如 TaskOriginalPromptDialog）挂载到 document.body，但 React 合成 click 仍沿
							// 组件树冒泡回卡片 shell；下方基于 DOM 祖先链的 closest() 守卫对 portal 内容不生效，
							// 所以先做 DOM containment 检查。
							if (!event.currentTarget.contains(event.target as Node)) {
								return;
							}
							if (!isCardInteractive) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							if (isDragging || !onClick) {
								return;
							}
							// 双击的第二击：交给 onDoubleClick 处理，单击逻辑直接放行。
							if (event.detail > 1) {
								return;
							}
							// 会跳转的列：延迟单击，留出双击拦截窗口（双击会清掉这个计时器）。
							if (delaysSingleClickActivationForDoubleClickTitleEdit) {
								if (clickActivationTimerRef.current != null) {
									clearTimeout(clickActivationTimerRef.current);
								}
								clickActivationTimerRef.current = window.setTimeout(() => {
									clickActivationTimerRef.current = null;
									onClick(card);
								}, CLICK_ACTIVATION_DELAY_MS);
								return;
							}
							// backlog 立即开编辑弹窗；trash 在上方 !isCardInteractive 已 return（切换面板的行副本除外）。
							onClick(card);
						}
			}
			onDoubleClick={
				isPassiveFocusedTaskCardCopy || isMobileDetailHeaderCopy
					? undefined
					: (event) => {
							if (!event.currentTarget.contains(event.target as Node)) {
								return;
							}
							if (!isInlineTitleEditEnabled) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							// 取消尚未触发的单击跳转，改为进入标题编辑。
							if (clickActivationTimerRef.current != null) {
								clearTimeout(clickActivationTimerRef.current);
								clickActivationTimerRef.current = null;
							}
							setDraftTitle(card.title);
							setIsEditingTitle(true);
						}
			}
			style={{
				...(cardDragBindings?.draggableStyle ?? {}),
				// 紧凑密度的行之间靠 hover 底色区分，不需要标准卡片那么大的间距。
				marginBottom: emitsCanonicalDomIdentity ? (isCompactRowInFocusViewLeftColumn ? 2 : 6) : 0,
				// 本体可拖 → grab；置顶板分身 / 跨项目展开行 / PDV 面板条目单击进详情 → pointer；sticky 只读镜像什么都不做 → default。
				cursor: emitsCanonicalDomIdentity
					? "grab"
					: isPassiveFocusedTaskCardCopy || isMobileDetailHeaderCopy
						? "default"
						: "pointer",
			}}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{/* 为右下角复制叠层留出横向空间，编辑动作与时长药丸仍可独立命中。 */}
			<div
				className={
					isCompactRowInFocusViewLeftColumn
						? // 紧凑密度：与 All projects 行同一风格的平铺行（无边框、无底色，hover 才显底）。
							cn(
								"group/card relative rounded-md px-2 py-1.5",
								showDirectoryCopyButton && "pr-8",
								historicalSnapshot && "pr-14 sm:pr-10",
								isCardInteractive && "cursor-pointer hover:bg-surface-3",
								isDragging && "bg-surface-3 shadow-lg",
								isHoverPresentationShown && isCardInteractive && "bg-surface-3",
							)
						: cn(
								"group/card relative rounded-md border border-border-bright bg-surface-2 p-2.5",
								showDirectoryCopyButton && !isMobileDetailHeaderCopy && "pr-8",
								isMobileDetailHeaderCopy && "flex flex-col",
								isCardInteractive && "cursor-pointer hover:bg-surface-3 hover:border-border-bright",
								isDragging && "shadow-lg",
								isHovered && isCardInteractive && "bg-surface-3 border-border-bright",
							)
				}
			>
				{/* 标准密度：agent 图标 + 微型时长药丸合一，钉在卡片左上角、略微超出边框（不占标题横向空间）。
				    完整「agent · 模型」进 hover tooltip。紧凑密度不画胶囊，这些项分别并入第 1 行与元信息行。
				    置顶板分身在末尾多挂一段 stage 标签，胶囊会因此变宽；右侧不远就是 hover 动作组（同在 -top-[6px]），
				    所以限宽 + 标签 truncate，窄卡上宁可截断 stage 名也不与动作组叠在一起。 */}
				{isCompactRowInFocusViewLeftColumn ? null : (
					<div
						className={
							isMobileDetailHeaderCopy
								? "mb-1 flex flex-wrap items-center gap-1 leading-none"
								: "absolute -left-2 -top-[6px] z-20 inline-flex h-4 max-w-[calc(100%-2rem)] items-center gap-1 rounded-full border border-border-bright bg-surface-1 pl-1 pr-1.5 leading-none shadow-sm"
						}
					>
						{agentBadge}
						{taskAgentSettingsLabel ? (
							<span aria-hidden className="h-2.5 w-px shrink-0 bg-border-bright" />
						) : null}
						{elapsedTimePills}
						{resourceUsagePill}
						{pinnedMarkerOrTaskPinboardStageLabel}
					</div>
				)}
				<div
					className={
						isCompactRowInFocusViewLeftColumn ? "flex items-start gap-1.5" : "flex items-start gap-2 pt-0.5"
					}
					style={isCompactRowInFocusViewLeftColumn ? undefined : { minHeight: 24 }}
				>
					{crossProjectTaskSwitcherRowElements ? (
						crossProjectTaskSwitcherRowElements.firstLineLeadingActivityIndicator
					) : statusMarker ? (
						<div className={cn("inline-flex items-center", isCompactRowInFocusViewLeftColumn && "mt-[3px]")}>
							{statusMarker}
						</div>
					) : null}
					{isCompactRowInFocusViewLeftColumn && agentBadge ? (
						<span className="mt-[3px] inline-flex shrink-0">{agentBadge}</span>
					) : null}
					<div className={cn("relative min-w-0 flex-1", showTitleEditButton && "group/title")}>
						{isEditingTitle ? (
							// 标题语义上仍是单串；改 textarea 只为长标题视觉 wraparound + 随内容自增高
							// （原生 field-sizing:content，目标运行环境是现代 Chrome）。Enter 仍保存、Esc 仍取消。
							<textarea
								data-mobile-focus-view-idle-collapse-suspension=""
								ref={titleInputRef}
								value={draftTitle}
								rows={1}
								onChange={(event) => setDraftTitle(event.currentTarget.value)}
								onBlur={submitTitle}
								onKeyDown={handleTitleKeyDown}
								onMouseDown={(event) => {
									event.stopPropagation();
								}}
								className="w-full resize-none rounded-md border border-border-focus bg-surface-2 px-2 py-1 text-sm font-medium text-text-primary focus:outline-none [field-sizing:content]"
							/>
						) : (
							<>
								<p
									data-task-card-title=""
									role={isTitleKeyboardEntryOpeningTaskFromCrossProjectTaskSwitcherRow ? "button" : undefined}
									tabIndex={isTitleKeyboardEntryOpeningTaskFromCrossProjectTaskSwitcherRow ? 0 : undefined}
									onKeyDown={
										isTitleKeyboardEntryOpeningTaskFromCrossProjectTaskSwitcherRow
											? (event) => {
													if (event.key === "Enter" || event.key === " ") {
														event.preventDefault();
														onClick?.(card);
													}
												}
											: undefined
									}
									className={cn(
										"line-clamp-3 m-0 font-medium",
										isCompactRowInFocusViewLeftColumn ? "text-[13px] leading-snug" : "text-sm",
										isTrashCard && "line-through text-text-tertiary",
										isTitleKeyboardEntryOpeningTaskFromCrossProjectTaskSwitcherRow &&
											"rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
									)}
								>
									{displayTitle}
								</p>
							</>
						)}
						{showsTaskPinboardPinReasonRowOnThisCopy ? (
							// 置顶原因只在分身上铺开：本体卡上铺开会让每张卡凭空变高，那里原因走 pin 标记的 tooltip。
							<button
								type="button"
								data-task-pinboard-pin-reason=""
								data-task-pinboard-pin-reason-state={
									hasTaskPinboardPinReasonText ? "shows_user_written_reason" : "blank_invites_adding_reason"
								}
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onEditTaskPinboardPinReason?.(card.id);
								}}
								className={cn(
									"mt-1 flex w-full items-start gap-1 rounded-sm text-left text-[11px] leading-snug hover:text-text-primary",
									hasTaskPinboardPinReasonText ? "text-text-secondary" : "italic text-text-tertiary",
								)}
								title={hasTaskPinboardPinReasonText ? "Edit pin reason" : "Add pin reason"}
							>
								<Pin size={10} className="mt-[2px] shrink-0" />
								<span className="line-clamp-2">
									{hasTaskPinboardPinReasonText ? taskPinboardPinReasonTextOrEmpty : "Add pin reason"}
								</span>
							</button>
						) : null}
						{showTitleEditButton && !isCompactRowInFocusViewLeftColumn && !isMobileDetailHeaderCopy ? (
							<TaskCardTitleRowHoverActions>
								<Tooltip
									side="bottom"
									content={revealHoverActionTooltip(onOpenTaskEditor ? "Edit task" : "Edit title")}
								>
									<Button
										icon={<Pencil size={12} />}
										variant="ghost"
										size="xs"
										aria-label="Edit task title"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											if (onOpenTaskEditor) {
												onOpenTaskEditor(card);
												return;
											}
											setDraftTitle(card.title);
											setIsEditingTitle(true);
										}}
									/>
								</Tooltip>
							</TaskCardTitleRowHoverActions>
						) : null}
					</div>
				</div>
				<div
					className={cn(
						isMobileDetailHeaderCopy
							? "order-last mt-2 flex flex-wrap items-center gap-0.5"
							: cn(
									// 动作显示或获得键盘焦点时覆盖 z-20 摘要胶囊，避免长摘要拦截恢复、归档等按钮。
									"absolute right-1 z-30 flex items-center gap-0.5 rounded-md bg-surface-3 px-0.5 shadow-sm transition-opacity",
									// 紧凑密度没有上边框可伸出，动作组覆盖在第 1 行右侧；All projects 切换面板的行例外，叠在首行上方。
									isCrossProjectTaskSwitcherRowCopy
										? CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_VERTICAL_POSITION_ABOVE_FIRST_LINE_CLASS_NAME
										: isCompactRowInFocusViewLeftColumn
											? "top-1"
											: "-top-[6px]",
									"focus-within:opacity-100 focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto",
									isHoverPresentationShown ? "opacity-100" : "opacity-0 pointer-events-none",
								),
					)}
				>
					{showTitleEditButton && (isCompactRowInFocusViewLeftColumn || isMobileDetailHeaderCopy) ? (
						<Tooltip
							side="bottom"
							content={revealHoverActionTooltip(onOpenTaskEditor ? "Edit task" : "Edit title")}
						>
							<Button
								icon={<Pencil size={12} />}
								variant="ghost"
								size="xs"
								aria-label="Edit task title"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									if (onOpenTaskEditor) onOpenTaskEditor(card);
									else {
										setDraftTitle(card.title);
										setIsEditingTitle(true);
									}
								}}
							/>
						</Tooltip>
					) : null}

					{taskPinboardToggle ? (
						<Tooltip side="bottom" content={revealHoverActionTooltip(taskPinboardToggle.tooltip)}>
							<Button
								icon={taskPinboardToggle.isPinned ? <PinOff size={12} /> : <Pin size={12} />}
								variant="ghost"
								size="xs"
								className={taskPinboardToggle.isPinned ? "text-accent" : undefined}
								aria-label={taskPinboardToggle.ariaLabel}
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									taskPinboardToggle.activate();
								}}
							/>
						</Tooltip>
					) : null}
					{historicalContext ? (
						<Tooltip side="bottom" content={revealHoverActionTooltip("查看完整 Prompt")}>
							<Button
								icon={<FileText size={12} />}
								variant="ghost"
								size="xs"
								aria-label="查看完整 Prompt"
								className="min-h-11 min-w-11 sm:min-h-7 sm:min-w-7"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									historicalContext.onOpenHistoricalPrompt();
								}}
							/>
						</Tooltip>
					) : (
						<TaskCardPrimaryActionWithQuickOptions
							open={openedQuickActionMenu === "prompt"}
							onOpenChange={(open) =>
								setOpenedQuickActionMenu((current) => (open ? "prompt" : current === "prompt" ? null : current))
							}
							icon={<FileText size={12} />}
							primaryLabel="查看原始 Prompt"
							primaryAccessibleLabel="View original prompt"
							onPrimaryAction={() => setIsPromptViewerOpen(true)}
							quickOption={{
								label: "复制原始 Prompt",
								icon: <Copy size={14} />,
								onSelect: () => {
									void writeTextToSystemClipboardWithInsecureContextFallback(card.prompt)
										.then(() => {
											showAppToast({ intent: "success", message: "已复制原始 Prompt", timeout: 2000 });
										})
										.catch(() => notifyError("无法复制原始 Prompt，请打开查看后手动复制。"));
								},
							}}
						/>
					)}
					{/* 「In Progress 但从没真正起过会话」包括运行时 attach 时造的占位 summary：启动前段失败（如建 worktree
					    时锁等待超时）后卡片上留下的正是它，不认它的话这张卡在看板上就没有任何重试入口。
					    但占位形状也可能是硬中断后退化的老会话，所以占位时只在有**正面证据**（任务 worktree 不存在、
					    卡片也没有启动记录）时才给「以原 prompt 重新启动」；说不清的交给详情面板把两种出路都摆出来。 */}
					{columnId === "backlog" ||
					(columnId === "in_progress" &&
						(sessionSummary == null ||
							(isNeverStartedPlaceholderTaskSessionSummary(sessionSummary) &&
								taskAgentSessionLaunchHistoryEvidence === "never_launched")) &&
						onStart) ? (
						<Tooltip
							side="bottom"
							content={revealHoverActionTooltip(columnId === "in_progress" ? "Retry task start" : "Start task")}
						>
							<Button
								icon={<Play size={12} />}
								variant="ghost"
								size="xs"
								aria-label={columnId === "in_progress" ? "Retry task start" : "Start task"}
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onStart?.(card.id);
								}}
							/>
						</Tooltip>
					) : null}
					{columnId === "review" ? (
						<Tooltip side="bottom" content={revealHoverActionTooltip("Move to validation")}>
							<Button
								icon={isMoveToValidationLoading ? <Spinner size={12} /> : <ClipboardCheck size={12} />}
								variant="ghost"
								size="xs"
								disabled={isMoveToValidationLoading}
								aria-label="Move task to validation"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onMoveToValidation?.(card.id);
								}}
							/>
						</Tooltip>
					) : null}
					{/* 仅终端 agent（claude/codex…，排除进程内 Cline SDK 与无会话）的 In Progress 卡：手动翻入 Review。
					    用于会话卡死/空闲（Stop hook 未触发、进程未退）拖不进 Review 列、被反复打回的兜底。 */}
					{columnId === "in_progress" &&
					sessionSummary?.agentId != null &&
					!isRuntimeAgentSessionSummaryRenderedAsConversationPanel(sessionSummary) ? (
						<Tooltip side="bottom" content={revealHoverActionTooltip("Move to review")}>
							<Button
								icon={isMoveToReviewLoading ? <Spinner size={12} /> : <Eye size={12} />}
								variant="ghost"
								size="xs"
								disabled={isMoveToReviewLoading}
								aria-label="Move task to review"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onMoveToReview?.(card.id);
								}}
							/>
						</Tooltip>
					) : null}
					{columnId === "review" || columnId === "validation" ? (
						<TaskCardPrimaryActionWithQuickOptions
							open={openedQuickActionMenu === "done"}
							onOpenChange={(open) =>
								setOpenedQuickActionMenu((current) => (open ? "done" : current === "done" ? null : current))
							}
							icon={isMoveToTrashLoading ? <Spinner size={12} /> : <Archive size={12} />}
							primaryLabel="移入 Done"
							primaryAccessibleLabel="Move task to done"
							disabled={isMoveToTrashLoading || !onMoveToTrash}
							onPrimaryAction={() => onMoveToTrash?.(card.id)}
							quickOption={{
								label: "添加评论并移入 Done…",
								icon: <MessagesSquare size={14} />,
								onSelect: () => onMoveToTrash?.(card.id, { requestTaskCommentBeforeMovingIntoDone: true }),
							}}
						/>
					) : null}
					{columnId === "trash" ? (
						<Tooltip
							side="bottom"
							content={
								isHovered ? (
									<>
										Restore session
										<br />
										in new worktree
									</>
								) : undefined
							}
						>
							<Button
								icon={<RotateCcw size={12} />}
								variant="ghost"
								size="xs"
								aria-label="Restore task from done"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onRestoreFromTrash?.(card.id);
								}}
							/>
						</Tooltip>
					) : null}
					{onDeleteTask ? (
						<Tooltip side="bottom" content={revealHoverActionTooltip("Delete permanently")}>
							<Button
								icon={<Trash2 size={12} />}
								variant="danger"
								size="xs"
								aria-label="Delete task permanently"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onDeleteTask(card.id);
								}}
							/>
						</Tooltip>
					) : null}
					{crossProjectTaskSwitcherRowElements?.inListExpansionToggle}
					{isMobileDetailHeaderCopy && showDirectoryCopyButton ? (
						<span data-task-directory-copy-actions="">{directoryCopyButton}</span>
					) : null}
				</div>
				{isPromptViewerOpen ? (
					<TaskOriginalPromptDialog open card={card} onClose={() => setIsPromptViewerOpen(false)} />
				) : null}
				{/* 「机器在等」的徽标：标准密度各占一行；紧凑密度并入元信息行（见下）。 */}
				{isCompactRowInFocusViewLeftColumn
					? null
					: machineWaitingBadges.map(({ machineWaitingBadgeKey, machineWaitingBadgeElement }) => (
							<div key={machineWaitingBadgeKey} className="mt-1">
								{machineWaitingBadgeElement}
							</div>
						))}
				{historicalSnapshot ? (
					<div
						className="mt-1 flex flex-col gap-1 text-xs text-text-secondary"
						data-permanently-deleted-task-card=""
					>
						<div className="flex flex-wrap items-center gap-2">
							<span
								className="min-w-0 break-words"
								title={historicalSnapshot.workspaceRepositoryPath ?? undefined}
							>
								{historicalContext?.historicalProjectName ?? historicalSnapshot.kanbanBoardCard.workspaceId}
							</span>
							<span className="font-mono">{card.id}</span>
							<span>已永久删除</span>
							<time
								className="min-w-0 break-words"
								dateTime={new Date(historicalSnapshot.permanentlyRemovedFromBoardAt).toISOString()}
								title={new Date(historicalSnapshot.permanentlyRemovedFromBoardAt).toString()}
							>
								{new Date(historicalSnapshot.permanentlyRemovedFromBoardAt).toLocaleString()}
							</time>
						</div>
						{historicalSnapshot.promptPreview !== null ? (
							<p className="m-0 line-clamp-3 whitespace-pre-wrap break-words">
								{historicalSnapshot.promptPreview || "删除前 Prompt 为空"}
							</p>
						) : (
							<p className="m-0">删除前 Prompt 未留存或正文不可用，可查看其他版本。</p>
						)}
						{historicalSnapshot.matchedPromptVersions.includes("at_creation") ? (
							<span>命中创建时 Prompt</span>
						) : null}
					</div>
				) : null}
				<AgentCurrentWorkPhaseGoal summary={sessionSummary} />
				{sessionActivity ? (
					<div
						className={cn("flex gap-1.5 items-start", isCompactRowInFocusViewLeftColumn ? "mt-1" : "mt-[6px]")}
						style={{
							color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
						}}
					>
						<span
							className="inline-block shrink-0 rounded-full"
							data-session-activity-dot-breathing-on-shared-fine-clock={
								sessionActivityDotBreathingOpacity !== undefined ? "true" : undefined
							}
							title={
								!isTrashCard && isExitedAwaiting
									? "Agent process exited — still awaiting your review"
									: undefined
							}
							style={{
								width: 6,
								height: 6,
								// exited（进程已退）：空心环（transparent 底 + 同色描边，box-sizing:border-box 下留中空）；
								// 否则实心点。trash 卡一律 muted 实心、不参与 exited 区分。
								backgroundColor:
									isTrashCard || isExitedAwaiting
										? isTrashCard
											? SESSION_ACTIVITY_COLOR.muted
											: "transparent"
										: sessionActivity.dotColor,
								border:
									!isTrashCard && isExitedAwaiting ? `1.5px solid ${sessionActivity.dotColor}` : undefined,
								marginTop: 4,
								opacity: sessionActivityDotBreathingOpacity,
							}}
						/>
						<div className="min-w-0 flex-1">
							<p className="m-0 font-mono break-words line-clamp-2" style={{ fontSize: 12 }}>
								{sessionActivity.text}
							</p>
						</div>
					</div>
				) : null}
				{isCompactRowInFocusViewLeftColumn ? (
					// 紧凑密度的元信息行：目录 / git 统计 / 徽标 / 取消自动动作靠左，时长药丸 + 资源占用 + 置顶标记靠右
					// （与标准密度胶囊里的顺序一致），窄宽度下换行而不截断。
					<div
						data-task-card-compact-metadata-row=""
						className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] leading-none"
					>
						{crossProjectTaskSwitcherRowElements?.projectName ? (
							<span className="min-w-0 max-w-full truncate text-text-tertiary">
								{crossProjectTaskSwitcherRowElements.projectName}
							</span>
						) : null}
						{showDirectoryRow ? taskDirectoryRow : null}
						{machineWaitingBadges.map(({ machineWaitingBadgeKey, machineWaitingBadgeElement }) => (
							<span key={machineWaitingBadgeKey} className="inline-flex min-w-0">
								{machineWaitingBadgeElement}
							</span>
						))}
						{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
							<button
								type="button"
								className="cursor-pointer rounded-sm border-none bg-transparent p-0 text-[11px] text-accent hover:underline"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onCancelAutomaticAction(card.id);
								}}
							>
								{cancelAutomaticActionLabel}
							</button>
						) : null}
						<span className="ml-auto inline-flex shrink-0 items-center gap-1">
							{crossProjectTaskSwitcherRowElements?.promptCacheWarmthPill}
							{elapsedTimePills}
							{resourceUsagePill}
							{pinnedMarkerOrTaskPinboardStageLabel}
						</span>
					</div>
				) : (
					<>
						{showDirectoryRow ? taskDirectoryRow : null}
						{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
							<Button
								size="sm"
								fill
								style={{ marginTop: 12 }}
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onCancelAutomaticAction(card.id);
								}}
							>
								{cancelAutomaticActionLabel}
							</Button>
						) : null}
					</>
				)}
				{showDirectoryCopyButton && !isMobileDetailHeaderCopy ? (
					<div
						data-task-directory-copy-actions=""
						className={cn(
							"absolute bottom-0 right-0 z-10 rounded-md bg-surface-3 px-0.5 shadow-sm",
							"group-focus-within/card:opacity-100 group-focus-within/card:pointer-events-auto",
							isHoverPresentationShown ? "opacity-100" : "opacity-0 pointer-events-none",
						)}
					>
						{directoryCopyButton}
					</div>
				) : null}
			</div>
		</div>
	);

	// 拖拽中把卡壳 portal 到 document.body，避免被祖先 overflow 裁切（@hello-pangea/dnd 惯用法）。
	// 关键：portal 只切换无状态的卡壳 DOM，TaskCardBody 组件本身始终挂载在原位，
	// 故 isHovered/isEditingTitle/最近活动记忆等 hooks 状态在拖拽前后不被重置（与拆分前一致）。
	if (cardDragBindings?.isDragging && typeof document !== "undefined") {
		return createPortal(cardShell, document.body);
	}
	return cardShell;
});
