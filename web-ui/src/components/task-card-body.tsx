import type {
	DraggableProvidedDraggableProps,
	DraggableProvidedDragHandleProps,
	DraggableStyle,
} from "@hello-pangea/dnd";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import {
	deriveDisplayLiveness,
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
	ClipboardCheck,
	Clock,
	Copy,
	Eye,
	FileText,
	GitBranch,
	Home,
	Hourglass,
	Pencil,
	Play,
	RotateCcw,
	Trash2,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	formatClineReasoningEffortLabel,
	formatClineSelectedModelButtonText,
	resolveClineModelDisplayName,
} from "@/components/detail-panels/cline-model-picker-options";
import { TaskOriginalPromptDialog } from "@/components/task-original-prompt-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";
import { formatPathForDisplay } from "@/utils/path-display";
import { useCopyToClipboard, useInterval } from "@/utils/react-use";
import { normalizePromptForDisplay, truncateTaskPromptLabel } from "@/utils/task-prompt";
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

/** 钉在宿主行右下角；纯 overlay，不占文本流宽度；hover 时左侧渐变遮住末行被挡字符。 */
function TaskCardRowHoverActions({
	groupName,
	children,
}: {
	groupName: "title" | "directory";
	children: ReactNode;
}): React.ReactElement {
	return (
		<div
			className={cn(
				"pointer-events-none absolute bottom-0 right-0 z-10 flex items-end opacity-0 transition-opacity",
				// 与卡面同底色的左向渐变：hover 时才显现，避免为按钮预留 pr-* 挤占换行宽度。
				"bg-gradient-to-l from-surface-2 from-45% to-transparent pl-4 group-hover/card:from-surface-3",
				groupName === "title"
					? "group-hover/title:opacity-100 group-hover/title:pointer-events-auto group-focus-within/title:opacity-100 group-focus-within/title:pointer-events-auto"
					: "group-hover/directory:opacity-100 group-hover/directory:pointer-events-auto group-focus-within/directory:opacity-100 group-focus-within/directory:pointer-events-auto",
			)}
		>
			<div className="pointer-events-auto mb-px flex rounded-md bg-surface-3 px-0.5 shadow-sm">{children}</div>
		</div>
	);
}

/**
 * 卡片的业务 props：与 DnD/钉住克隆等渲染容器无关的领域回调与数据。
 * `BoardCard`（看板内的可拖卡）、`TaskCardBody`（纯卡体）、`SelectedTaskPinBar`
 * （Focus View 跨 stage 浮动钉住条里的克隆卡）共用同一套，确保三处行为一致。
 */
export interface TaskCardBusinessProps {
	card: BoardCardModel;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	onClick?: () => void;
	onStart?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onMoveToValidation?: (taskId: string) => void;
	// 手动把 In Progress 卡翻入 Review（仅终端 agent；卡死/空闲会话拖不进 Review 的兜底入口）。
	onMoveToReview?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommit?: (taskId: string) => void;
	onOpenPr?: (taskId: string) => void;
	onCancelAutomaticAction?: (taskId: string) => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	isMoveToTrashLoading?: boolean;
	isMoveToValidationLoading?: boolean;
	isMoveToReviewLoading?: boolean;
	onDependencyPointerDown?: (taskId: string, event: MouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	isDependencySource?: boolean;
	isDependencyTarget?: boolean;
	isDependencyLinking?: boolean;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}

/**
 * 注入式 DnD 绑定。由 `BoardCard` 从 `@hello-pangea/dnd` 的 `provided`/`snapshot`
 * 装配后下传；`TaskCardBody` 自身不引用 `<Draggable>`，因此可被钉住克隆（无 DnD）复用。
 */
export interface TaskCardBodyDragBindings {
	innerRef: (element?: HTMLElement | null) => void;
	draggableProps: DraggableProvidedDraggableProps;
	dragHandleProps: DraggableProvidedDragHandleProps | null;
	isDragging: boolean;
	draggableStyle?: DraggableStyle;
}

/**
 * 任务卡的纯展示卡体（卡壳 + 内层可视卡 + 全部展示态/交互）。
 *
 * - 列表内可拖卡：由 `BoardCard` 提供 `drag` 绑定，外壳挂上 DnD ref/props 与 `data-task-id`。
 * - 钉住克隆（`pinnedClone`）：不挂 DnD、不输出 `data-task-id`（保证全局唯一）、`cursor:default`、
 *   关闭单击导航/双击改标题/依赖连线，但保留 hover 揭示动作组与各动作按钮，视觉与列表卡完全一致。
 */
export function TaskCardBody({
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
	onCommit,
	onOpenPr,
	onCancelAutomaticAction,
	isCommitLoading = false,
	isOpenPrLoading = false,
	isMoveToTrashLoading = false,
	isMoveToValidationLoading = false,
	isMoveToReviewLoading = false,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	isDependencySource = false,
	isDependencyTarget = false,
	isDependencyLinking = false,
	workspacePath,
	defaultClineModelId = null,
	defaultAgentId = null,
	drag = null,
	pinnedClone = false,
}: TaskCardBusinessProps & {
	drag?: TaskCardBodyDragBindings | null;
	pinnedClone?: boolean;
}): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const [isPromptViewerOpen, setIsPromptViewerOpen] = useState(false);
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [draftTitle, setDraftTitle] = useState(card.title);
	const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
	const titleEditCancelledRef = useRef(false);
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(card.id);
	const isTrashCard = columnId === "trash";
	// 钉住克隆是非交互镜像：单击/双击/依赖一律关闭，只保留 hover 揭示动作组。
	const isCardInteractive = !isTrashCard && !pinnedClone;
	// 会跳转的列上双击改标题需先拦截单击；这些列单击会打开详情、替换看板。
	const isNavigatingColumn = columnId === "in_progress" || columnId === "review" || columnId === "validation";
	// 双击改标题覆盖 in_progress / review / validation / done(trash)，不含 backlog；钉住克隆不参与编辑。
	const isInlineTitleEditEnabled = !pinnedClone && onSaveTitle != null && (isNavigatingColumn || isTrashCard);
	const clickActivationTimerRef = useRef<number | null>(null);
	const isDragging = drag?.isDragging ?? false;
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
	// （deriveDisplayLiveness，见 session-activity.ts），summary 静默期不再广播，故需本地 tick 让卡片在跨过
	// 静默边界后停止脉动；tick 仅在「agent 回合 + liveness=live」时开启，空闲 / 待审 / 已结束卡不计时。
	const sessionFacets = sessionSummary ? resolveSessionFacets(sessionSummary) : null;
	// parked（已派发后台工作、等自行恢复）：纯展示信号——它是普通 agent 回合 {agent,live,null}，但**不在算**，
	// 是在等自己派发的后台工作。读 sidecar（非 facet，deriveDisplayLiveness 不动），抑制 computing 脉冲并渲染
	// parked 徽标，让卡片不再误显示「转圈在算」。
	const isParkedAwaitingBackgroundWork = isParkedAwaitingDispatchedBackgroundWork(sessionSummary);
	const isLiveAgentTurn = sessionFacets?.turnOwner === "agent" && sessionFacets.liveness === "live";
	// channel B（distinction ②）：终端 agent 进程已退、任务仍等你审 → liveness==="exited"（Cline SDK 在
	// 进程内运行、恒 live，永不进此分支）。卡片状态点改「空心环」表达「进程已退但仍待你处理」，与实心 live
	// 点区分；点的颜色仍随 channel C（review绿/needs_input金/error红）。pulse 仅 agent 回合开启、与本互斥。
	const isExitedAwaiting = sessionFacets?.liveness === "exited";
	const [activityNowMs, setActivityNowMs] = useState(() => Date.now());
	useInterval(() => setActivityNowMs(Date.now()), isLiveAgentTurn && !isParkedAwaitingBackgroundWork ? 1000 : null);
	// 头部「创建至今 / agent 上次响应至今」双时长读数的常开粗 tick（30s）：读数粒度是分/时/天，30s 足够，
	// 且常开不分 live/idle（与上面仅 live 卡的 1s computing tick 解耦）。lastSubstantiveOutputAt 只在 agent 产出
	// 新正文/工具内容时推进——过滤 TUI 装饰性重绘、与 board.json 分离，故列间拖动与终端重启刷新都不会扰动它，
	// 恰好锚定「真实最后一次响应」；为空（早期 session）回退 lastOutputAt，再空则隐藏响应段。
	const [elapsedNowMs, setElapsedNowMs] = useState(() => Date.now());
	useInterval(() => setElapsedNowMs(Date.now()), 30_000);
	const lastAgentResponseAt = sessionSummary?.lastSubstantiveOutputAt ?? sessionSummary?.lastOutputAt ?? null;
	const isAgentComputing =
		isLiveAgentTurn && !isParkedAwaitingBackgroundWork && sessionSummary != null && sessionFacets != null
			? deriveDisplayLiveness(sessionFacets, sessionSummary.lastOutputAt, activityNowMs) === "computing"
			: false;
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
			return <Spinner size={12} />;
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
	const reviewRefLabel = reviewWorkspaceSnapshot?.headCommit?.slice(0, 8) ?? "HEAD";
	const reviewChangeSummary = reviewWorkspaceSnapshot
		? reviewWorkspaceSnapshot.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorkspaceSnapshot.changedFiles} ${reviewWorkspaceSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorkspaceSnapshot.additions ?? 0,
					deletions: reviewWorkspaceSnapshot.deletions ?? 0,
				}
		: null;
	const showDirectoryRow = showWorkspaceStatus && Boolean(reviewWorkspacePath);
	const showTitleEditButton = onSaveTitle != null && !pinnedClone && !isEditingTitle;
	const showReviewGitActions = columnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;
	const isAnyGitActionLoading = isCommitLoading || isOpenPrLoading;
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
	// 简写目录行：{worktree/inplace} @ {HEAD} {N commits} ({changed files} +{add} -{del})。
	// commitsSinceFork = fork-point..HEAD；工作区脏统计仍相对 HEAD。
	const worktreeModeLabel = card.worktreeMode === "inplace" ? "inplace" : "worktree";
	const commitsSinceForkLabel =
		reviewWorkspaceSnapshot?.commitsSinceFork != null
			? `${reviewWorkspaceSnapshot.commitsSinceFork} ${reviewWorkspaceSnapshot.commitsSinceFork === 1 ? "commit" : "commits"}`
			: null;
	// 复制源优先绝对路径（snapshot.path），trash 无快照时退回重建的展示路径，再退回 base 仓库路径。
	const copyableDirectoryPath = reviewWorkspaceSnapshot?.path ?? reviewWorkspacePath ?? workspacePath ?? null;
	const showDirectoryCopyButton = showDirectoryRow && Boolean(copyableDirectoryPath);
	const [, copyToClipboard] = useCopyToClipboard();
	const [isDirectoryPathCopied, setIsDirectoryPathCopied] = useState(false);
	const directoryCopyResetTimerRef = useRef<number | null>(null);
	const handleCopyDirectoryPath = () => {
		if (!copyableDirectoryPath) {
			return;
		}
		copyToClipboard(copyableDirectoryPath);
		setIsDirectoryPathCopied(true);
		if (directoryCopyResetTimerRef.current != null) {
			clearTimeout(directoryCopyResetTimerRef.current);
		}
		directoryCopyResetTimerRef.current = window.setTimeout(() => {
			setIsDirectoryPathCopied(false);
			directoryCopyResetTimerRef.current = null;
		}, 1500);
	};

	const cardShell = (
		<div
			ref={drag?.innerRef}
			{...(drag?.draggableProps ?? {})}
			{...(drag?.dragHandleProps ?? {})}
			className="kb-board-card-shell"
			// 钉住克隆不输出 data-task-id：保证全局 data-task-id 唯一（CSS sticky/scrollIntoView/测试计数依赖此唯一性）。
			data-task-id={pinnedClone ? undefined : card.id}
			data-column-id={columnId}
			data-selected={selected}
			onMouseDownCapture={
				pinnedClone
					? undefined
					: (event) => {
							// Radix Portal（如 TaskOriginalPromptDialog）挂载到 document.body，
							// 但 React 合成事件仍沿组件树冒泡回卡片 shell；下方基于 DOM 祖先链的
							// closest() 守卫对 portal 内容不生效，所以先做 DOM containment 检查。
							if (!event.currentTarget.contains(event.target as Node)) {
								return;
							}
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (!event.metaKey && !event.ctrlKey) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							onDependencyPointerDown?.(card.id, event);
						}
			}
			onClick={
				pinnedClone
					? undefined
					: (event) => {
							// 同上：portal 内容的合成 click 也会冒泡到这里，先做 DOM containment 检查。
							if (!event.currentTarget.contains(event.target as Node)) {
								return;
							}
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (event.metaKey || event.ctrlKey) {
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
							if (isNavigatingColumn) {
								if (clickActivationTimerRef.current != null) {
									clearTimeout(clickActivationTimerRef.current);
								}
								clickActivationTimerRef.current = window.setTimeout(() => {
									clickActivationTimerRef.current = null;
									onClick();
								}, CLICK_ACTIVATION_DELAY_MS);
								return;
							}
							// backlog 立即开编辑弹窗；trash 在上方 !isCardInteractive 已 return，到不了这里。
							onClick();
						}
			}
			onDoubleClick={
				pinnedClone
					? undefined
					: (event) => {
							if (!event.currentTarget.contains(event.target as Node)) {
								return;
							}
							if (!isInlineTitleEditEnabled || isDependencyLinking) {
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
				...(drag?.draggableStyle ?? {}),
				marginBottom: pinnedClone ? 0 : 6,
				cursor: pinnedClone ? "default" : "grab",
			}}
			onMouseEnter={() => {
				setIsHovered(true);
				if (!pinnedClone) {
					onDependencyPointerEnter?.(card.id);
				}
			}}
			onMouseMove={
				pinnedClone
					? undefined
					: () => {
							if (!isDependencyLinking) {
								return;
							}
							onDependencyPointerEnter?.(card.id);
						}
			}
			onMouseLeave={() => setIsHovered(false)}
		>
			<div
				className={cn(
					"group/card relative rounded-md border border-border-bright bg-surface-2 p-2.5",
					isCardInteractive && "cursor-pointer hover:bg-surface-3 hover:border-border-bright",
					isDragging && "shadow-lg",
					isHovered && isCardInteractive && "bg-surface-3 border-border-bright",
					isDependencySource && "kb-board-card-dependency-source",
					isDependencyTarget && "kb-board-card-dependency-target",
				)}
			>
				{/* agent 图标 + 微型时长药丸合一：钉在卡片左上角、略微超出边框（不占标题横向空间）。
				    最左为 agent 图标（略放大）；完整「agent · 模型」进 hover tooltip。
				    Clock=自创建至今（恒显）；Activity=agent 上次响应至今（仅有时间戳时显）。各段 hover 显绝对本地时间。 */}
				<div className="absolute -left-2 -top-[6px] z-20 inline-flex h-4 items-center gap-1 rounded-full border border-border-bright bg-surface-1 pl-1 pr-1.5 leading-none shadow-sm">
					{taskAgentSettingsLabel ? (
						<Tooltip content={taskAgentSettingsLabel}>
							<span
								data-agent-badge=""
								role="img"
								aria-label={taskAgentSettingsLabel}
								className="inline-flex shrink-0 items-center"
							>
								<agentVisual.Icon
									size={12}
									className={cn("shrink-0", isTrashCard ? "text-text-tertiary" : agentVisual.className)}
								/>
							</span>
						</Tooltip>
					) : null}
					{taskAgentSettingsLabel ? <span aria-hidden className="h-2.5 w-px shrink-0 bg-border-bright" /> : null}
					<Tooltip content={`Created · ${new Date(card.createdAt).toLocaleString()}`}>
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
					{lastAgentResponseAt != null ? (
						<>
							<span className="text-text-tertiary">·</span>
							<Tooltip content={`Agent last responded · ${new Date(lastAgentResponseAt).toLocaleString()}`}>
								<span
									className={cn(
										"inline-flex items-center gap-0.5 text-[10px] leading-none",
										isTrashCard ? "text-text-tertiary" : "text-text-secondary",
									)}
								>
									<Activity size={8} className="shrink-0" />
									{formatCompactElapsedSince(lastAgentResponseAt, elapsedNowMs)}
								</span>
							</Tooltip>
						</>
					) : null}
				</div>
				<div className="flex items-start gap-2 pt-0.5" style={{ minHeight: 24 }}>
					{statusMarker ? <div className="inline-flex items-center">{statusMarker}</div> : null}
					<div className={cn("relative min-w-0 flex-1", showTitleEditButton && "group/title")}>
						{isEditingTitle ? (
							// 标题语义上仍是单串；改 textarea 只为长标题视觉 wraparound + 随内容自增高
							// （原生 field-sizing:content，目标运行环境是现代 Chrome）。Enter 仍保存、Esc 仍取消。
							<textarea
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
							<p
								className={cn(
									"line-clamp-3 m-0 font-medium text-sm",
									isTrashCard && "line-through text-text-tertiary",
								)}
							>
								{displayTitle}
							</p>
						)}
						{showTitleEditButton ? (
							<TaskCardRowHoverActions groupName="title">
								<Tooltip side="bottom" content="Edit title">
									<Button
										icon={<Pencil size={12} />}
										variant="ghost"
										size="xs"
										aria-label="Edit task title"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											setDraftTitle(card.title);
											setIsEditingTitle(true);
										}}
									/>
								</Tooltip>
							</TaskCardRowHoverActions>
						) : null}
					</div>
				</div>
				<div
					className={cn(
						"absolute right-1 -top-[6px] z-10 flex items-center gap-0.5 rounded-md bg-surface-3 px-0.5 shadow-sm transition-opacity",
						"focus-within:opacity-100 focus-within:pointer-events-auto",
						isHovered ? "opacity-100" : "opacity-0 pointer-events-none",
					)}
				>
					<Tooltip side="bottom" content="View original prompt">
						<Button
							icon={<FileText size={12} />}
							variant="ghost"
							size="xs"
							aria-label="View original prompt"
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								setIsPromptViewerOpen(true);
							}}
						/>
					</Tooltip>
					{columnId === "backlog" ? (
						<Tooltip side="bottom" content="Start task">
							<Button
								icon={<Play size={12} />}
								variant="ghost"
								size="xs"
								aria-label="Start task"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onStart?.(card.id);
								}}
							/>
						</Tooltip>
					) : null}
					{columnId === "review" ? (
						<Tooltip side="bottom" content="Move to validation">
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
					{columnId === "in_progress" && sessionSummary?.agentId != null && sessionSummary.agentId !== "cline" ? (
						<Tooltip side="bottom" content="Move to review">
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
						<Tooltip side="bottom" content="Move to done">
							<Button
								icon={isMoveToTrashLoading ? <Spinner size={12} /> : <Archive size={12} />}
								variant="ghost"
								size="xs"
								disabled={isMoveToTrashLoading}
								aria-label="Move task to done"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onMoveToTrash?.(card.id);
								}}
							/>
						</Tooltip>
					) : null}
					{columnId === "trash" ? (
						<Tooltip
							side="bottom"
							content={
								<>
									Restore session
									<br />
									in new worktree
								</>
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
						<Tooltip side="bottom" content="Delete permanently">
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
				</div>
				{isPromptViewerOpen ? (
					<TaskOriginalPromptDialog open card={card} onClose={() => setIsPromptViewerOpen(false)} />
				) : null}
				{!isTrashCard && isParkedAwaitingBackgroundWork ? (
					<div className="mt-1">
						<span className="inline-flex max-w-full items-center gap-1 rounded-md border border-status-purple/30 bg-status-purple/10 px-1.5 py-0.5 text-xs text-status-purple">
							<Hourglass size={12} className="shrink-0" />
							<span className="truncate">
								{sessionSummary?.awaitingDispatchedBackgroundWork?.label
									? `Parked — awaiting ${sessionSummary.awaitingDispatchedBackgroundWork.label}`
									: "Parked — awaiting dispatched background work"}
							</span>
						</span>
					</div>
				) : null}
				{sessionActivity ? (
					<div
						className="flex gap-1.5 items-start mt-[6px]"
						style={{
							color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
						}}
					>
						<span
							className={cn(
								"inline-block shrink-0 rounded-full",
								!isTrashCard && isAgentComputing && "animate-pulse",
							)}
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
							}}
						/>
						<div className="min-w-0 flex-1">
							<p className="m-0 font-mono break-words line-clamp-2" style={{ fontSize: 12 }}>
								{sessionActivity.text}
							</p>
						</div>
					</div>
				) : null}
				{showDirectoryRow ? (
					<div
						data-task-directory=""
						title={copyableDirectoryPath ?? undefined}
						className={cn("group/directory relative mt-1 flex items-start gap-1 font-mono")}
						style={{
							fontSize: 12,
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
							<span className="mx-1" style={{ color: SESSION_ACTIVITY_COLOR.muted }}>
								@
							</span>
							<span>{reviewRefLabel}</span>
							{commitsSinceForkLabel ? (
								<>
									<span className="mx-1">{commitsSinceForkLabel}</span>
								</>
							) : null}
							{reviewChangeSummary ? (
								<>
									<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}> (</span>
									<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>{reviewChangeSummary.filesLabel}</span>
									<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
									<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
									<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>)</span>
								</>
							) : null}
						</span>
						{showDirectoryCopyButton ? (
							<TaskCardRowHoverActions groupName="directory">
								<Tooltip side="bottom" content="Copy directory path">
									<Button
										icon={
											isDirectoryPathCopied ? (
												<Check size={12} className="text-status-green" />
											) : (
												<Copy size={12} />
											)
										}
										variant="ghost"
										size="xs"
										aria-label="Copy directory path"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											handleCopyDirectoryPath();
										}}
									/>
								</Tooltip>
							</TaskCardRowHoverActions>
						) : null}
					</div>
				) : null}
				{showReviewGitActions ? (
					<div className="flex gap-1.5 mt-1.5">
						<Button
							variant="primary"
							size="sm"
							icon={isCommitLoading ? <Spinner size={12} /> : undefined}
							disabled={isAnyGitActionLoading}
							style={{ flex: "1 1 0" }}
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								onCommit?.(card.id);
							}}
						>
							Commit
						</Button>
						<Button
							variant="primary"
							size="sm"
							icon={isOpenPrLoading ? <Spinner size={12} /> : undefined}
							disabled={isAnyGitActionLoading}
							style={{ flex: "1 1 0" }}
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								onOpenPr?.(card.id);
							}}
						>
							Open PR
						</Button>
					</div>
				) : null}
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
			</div>
		</div>
	);

	// 拖拽中把卡壳 portal 到 document.body，避免被祖先 overflow 裁切（@hello-pangea/dnd 惯用法）。
	// 关键：portal 只切换无状态的卡壳 DOM，TaskCardBody 组件本身始终挂载在原位，
	// 故 isHovered/isEditingTitle/最近活动记忆等 hooks 状态在拖拽前后不被重置（与拆分前一致）。
	if (drag?.isDragging && typeof document !== "undefined") {
		return createPortal(cardShell, document.body);
	}
	return cardShell;
}
