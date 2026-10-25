import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as RadixSwitch from "@radix-ui/react-switch";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import {
	ArrowBigUp,
	ArrowLeft,
	Check,
	ChevronDown,
	Command,
	CornerDownLeft,
	List,
	Option,
	Plus,
	X,
} from "lucide-react";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import type { BranchSelectOption } from "@/components/branch-select-dropdown";
import { BranchSelectDropdown } from "@/components/branch-select-dropdown";
import { ReferenceRelationModelingEditor } from "@/components/detail-panels/reference-relation-modeling-editor";
import { DiscardTaskCreateConfirmDialog } from "@/components/discard-task-create-confirm-dialog";
import type { PostDeployVerificationFollowUpTaskCreationDraftSeed } from "@/components/post-deploy-verification/post-deploy-verification-follow-up-task-creation-draft";
import {
	TaskAgentModelPicker,
	type TaskTerminalAgentModelOverrideSettingsChangeOptions,
	useTaskAgentModelPicker,
} from "@/components/task-agent-model-picker";
import { TaskAgentPermissionModeControl } from "@/components/task-agent-permission-mode-control";
import { TaskAgentSessionInitializationControl } from "@/components/task-agent-session-initialization-control";
import { TaskConversationModeControl } from "@/components/task-conversation-mode-control";
import {
	type TaskCreationTargetProjectField,
	TaskCreationTargetProjectFieldControl,
} from "@/components/task-creation-target-project-field";
import {
	type TaskEditDraftComparableValues,
	TaskEditDraftRecoveryNotice,
} from "@/components/task-edit-draft-recovery-notice";
import { TaskEditorFloatingWindow } from "@/components/task-editor-floating-window";
import {
	TaskEditorHiddenSettingsManager,
	TaskEditorSettingGroup,
	TaskEditorSettingPresentationProvider,
} from "@/components/task-editor-setting-groups";
import { TaskNameInputWithAiSuggestions } from "@/components/task-name-input-with-ai-suggestions";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { TaskWorktreeModeControl } from "@/components/task-worktree-mode-control";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import type { TaskEditDraft } from "@/hooks/task-edit-drafts";
import { useGitRepositoryInfoOfOtherProjectForTaskEditorDialog } from "@/hooks/use-git-repository-info-of-other-project-for-task-editor-dialog";
import { useReferenceRelationModelingEditor } from "@/hooks/use-reference-relation-modeling-editor";
import { useTaskEditorClipboardTaskReference } from "@/hooks/use-task-editor-clipboard-task-reference";
import { ensureOneRuntimeAllocatedTaskIdReadyForTaskEditorSubmission } from "@/runtime/runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards";
import {
	readTaskCardWithBoardColumnInWorkspace,
	transferNeverStartedBacklogTaskToProjectInWorkspace,
	updateTaskCardFieldValuesInWorkspace,
} from "@/runtime/task-card-action-query";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeClineReasoningEffort,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskConversationMode,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";
import { useTaskCreateDialogPrimaryStartActionPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";
import {
	collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent,
	type TriggeringExplicitUserGestureEvent,
} from "@/runtime/work-unit-relation-assertion-write-query";
import { ensureRelationModelingCreatedTaskCardPersisted } from "@/runtime/work-unit-relation-modeling-query";
import { waitForAlreadyRequestedNewTaskCardRuntimePersistenceWithoutRetrying } from "@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start";
import { startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import {
	rememberTaskProjectAssignmentAnalysisAccepted,
	runTaskProjectAssignmentPreflight,
} from "@/state/task-project-assignment-preflight";
import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";
import type { TaskAutoReviewMode, TaskEditorSubmitOptions, TaskImage } from "@/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import { isMacPlatform, pasteShortcutLabel } from "@/utils/platform";
import { useDebouncedEffect } from "@/utils/react-use";

const AUTO_REVIEW_MODE_OPTIONS: Array<{ value: TaskAutoReviewMode; label: string }> = [
	{ value: "commit", label: "Make commit" },
	{ value: "pr", label: "Make PR" },
];

type TaskCreateStartAction = "start" | "start_and_open";

const DEFAULT_PRIMARY_START_ACTION: TaskCreateStartAction = "start";

/**
 * 关闭 New task 对话框前，用来判断「本次会话内是否改动过表单」的快照。
 * 基线在对话框打开那一刻捕获，关闭时与当前值逐字段比较，只认本次打开后的改动
 * （sticky 偏好如 auto-review 若本次没动，则基线==当前，不算脏）。
 * 仅在 create 模式下用于二次确认；edit 模式关闭是存草稿而非丢弃，不走此守卫。
 */
export interface TaskCreateFormSnapshot {
	prompt: string;
	/** 名字输入框。留空是常态（= 用描述推导），但用户敲进去的名字同样是「改动过表单」。 */
	taskName: string;
	/** 多任务模式下所有非空行 trim 后拼接；单任务模式为空串 */
	multiPromptContent: string;
	imageCount: number;
	startInPlanMode: boolean;
	taskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	taskConversationMode: RuntimeTaskConversationMode;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
	branchRef: string;
	worktreeMode: RuntimeTaskWorktreeMode;
	agentId: RuntimeAgentId | undefined;
	clineSettings: RuntimeTaskClineSettings | undefined;
	terminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	projectWorkspaceId?: string | null;
}

function isSameClineSettings(
	left: RuntimeTaskClineSettings | undefined,
	right: RuntimeTaskClineSettings | undefined,
): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function isSameTerminalAgentModelOverrideSettings(
	left: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
	right: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
): boolean {
	return (left?.agentId ?? null) === (right?.agentId ?? null) && (left?.modelId ?? null) === (right?.modelId ?? null);
}

export function hasTaskCreateFormEdits(current: TaskCreateFormSnapshot, baseline: TaskCreateFormSnapshot): boolean {
	return (
		current.prompt.trim() !== baseline.prompt.trim() ||
		current.taskName.trim() !== baseline.taskName.trim() ||
		current.multiPromptContent !== baseline.multiPromptContent ||
		current.imageCount !== baseline.imageCount ||
		current.startInPlanMode !== baseline.startInPlanMode ||
		current.taskAgentPermissionMode !== baseline.taskAgentPermissionMode ||
		current.taskConversationMode !== baseline.taskConversationMode ||
		current.autoReviewEnabled !== baseline.autoReviewEnabled ||
		current.autoReviewMode !== baseline.autoReviewMode ||
		current.branchRef !== baseline.branchRef ||
		current.worktreeMode !== baseline.worktreeMode ||
		current.projectWorkspaceId !== baseline.projectWorkspaceId ||
		JSON.stringify(current.taskAgentSessionInitialization) !==
			JSON.stringify(baseline.taskAgentSessionInitialization) ||
		current.agentId !== baseline.agentId ||
		!isSameClineSettings(current.clineSettings, baseline.clineSettings) ||
		!isSameTerminalAgentModelOverrideSettings(
			current.terminalAgentModelOverrideSettings,
			baseline.terminalAgentModelOverrideSettings,
		)
	);
}

function ButtonShortcut({
	includeShift = false,
	modifier = "mod",
}: {
	includeShift?: boolean;
	modifier?: "mod" | "alt";
}): ReactElement {
	return (
		<span className="inline-flex items-center gap-0.5 ml-1.5" aria-hidden>
			{modifier === "alt" ? (
				isMacPlatform ? (
					<Option size={12} />
				) : (
					<span className="text-[10px] font-medium leading-none">Alt</span>
				)
			) : (
				<Command size={12} />
			)}
			{includeShift ? <ArrowBigUp size={12} /> : null}
			<CornerDownLeft size={12} />
		</span>
	);
}

/**
 * 本地草稿在停止输入这么久之后主动上抛一次。
 *
 * 这不是第二层去抖，而是崩溃兜底：正常的上抛时机是失焦 / 关闭 / 提交，但用户可能一口气
 * 敲很久都不失焦，期间浏览器崩溃就会丢掉全部内容。按「停顿」而非「固定周期」触发的好处是
 * ——匀速连续输入时它永远不会在中途触发（击键间隔远小于该窗口），因此不会给 `App` 贡献
 * 任何一次额外重渲；只有用户停下来思考时才落一次盘。
 */
const PROMPT_DRAFT_IDLE_PROPAGATION_DELAY_MS = 1_500;

function parseListItems(text: string): string[] {
	const lines = text.split("\n");
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

	if (nonEmptyLines.length < 2) {
		return [];
	}

	const numberedRegex = /^\s*\d+[.)]\s+(.+)$/;
	const numberedItems = nonEmptyLines.map((line) => numberedRegex.exec(line));
	if (numberedItems.every((match) => match !== null)) {
		return numberedItems.map((match) => match[1]!.trim());
	}

	const bulletRegex = /^\s*[-*+•]\s+(.+)$/;
	const bulletItems = nonEmptyLines.map((line) => bulletRegex.exec(line));
	if (bulletItems.every((match) => match !== null)) {
		return bulletItems.map((match) => match[1]!.trim());
	}

	return [];
}

export function TaskEditorDialog({
	suspendedTaskEditorTitle,
	onResumeSuspendedTaskEditor,
	open,
	onOpenChange,
	prompt,
	onPromptChange,
	images,
	onImagesChange,
	onCreate,
	onCreateAndStart,
	onCreateMultiple: _onCreateMultiple,
	onCreateAndStartMultiple,
	onCreateStartAndOpen,
	startInPlanMode,
	onStartInPlanModeChange,
	taskAgentPermissionMode,
	onTaskAgentPermissionModeChange,
	taskConversationMode,
	onTaskConversationModeChange,
	autoReviewEnabled,
	onAutoReviewEnabledChange,
	autoReviewMode,
	onAutoReviewModeChange,
	startInPlanModeDisabled = false,
	workspaceId,
	branchRef,
	branchOptions,
	onBranchRefChange,
	taskCreateBaseRefRememberedForCurrentProject = null,
	repositoryDefaultBranchRef = null,
	rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists = null,
	resolvedDefaultTaskCreateBaseRef = null,
	worktreeMode,
	onWorktreeModeChange,
	agentId,
	onAgentIdChange,
	clineSettings,
	onClineSettingsChange,
	terminalAgentModelOverrideSettings,
	onTerminalAgentModelOverrideSettingsChange,
	agents,
	defaultAgentId,
	defaultProviderId,
	defaultModelId,
	defaultReasoningEffort,
	taskEditorMode = "create",
	creatingTaskName,
	onCreatingTaskNameChange,
	editorSessionWorkspaceId = workspaceId,
	editingTaskName = "",
	onEditingTaskNameChange,
	taskAgentSessionInitialization,
	onTaskAgentSessionInitializationChange,
	editingTaskId = null,
	editTaskFormSeededFromSavedDraftAt = null,
	onRevertEditTaskFormToSavedTaskContent,
	onAdoptPromotedTaskEditDraft,
	taskCreationTargetProjectField,
	onOpenCreatedTaskWithRelations,
	postDeployVerificationFollowUpTaskCreationDraftSeed,
}: {
	suspendedTaskEditorTitle?: string | null;
	onResumeSuspendedTaskEditor?: () => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	prompt: string;
	onPromptChange: (value: string) => void;
	images: TaskImage[];
	onImagesChange: Dispatch<SetStateAction<TaskImage[]>>;
	onOpenCreatedTaskWithRelations?: (workspaceId: string, taskId: string) => void;
	onCreate: (options?: TaskEditorSubmitOptions) => string | null;
	onCreateAndStart?: (options?: TaskEditorSubmitOptions) => string | null;
	onCreateMultiple: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	onCreateAndStartMultiple?: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	onCreateStartAndOpen?: (options?: TaskEditorSubmitOptions) => string | null;
	startInPlanMode: boolean;
	onStartInPlanModeChange: (value: boolean) => void;
	taskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	onTaskAgentPermissionModeChange: (value: RuntimeTaskAgentPermissionMode) => void;
	taskConversationMode: RuntimeTaskConversationMode;
	onTaskConversationModeChange: (value: RuntimeTaskConversationMode) => void;
	autoReviewEnabled: boolean;
	onAutoReviewEnabledChange: (value: boolean) => void;
	autoReviewMode: TaskAutoReviewMode;
	onAutoReviewModeChange: (value: TaskAutoReviewMode) => void;
	startInPlanModeDisabled?: boolean;
	workspaceId: string | null;
	branchRef: string;
	branchOptions: BranchSelectOption[];
	onBranchRefChange: (value: string) => void;
	/** 本项目上次成功建卡用的 ref（跨 origin 偏好里记的）。仅用于说明文案，不参与解析。 */
	taskCreateBaseRefRememberedForCurrentProject?: string | null;
	/** 仓库默认分支。用于「不记的话本该是它」这句提示与那个复位按钮。 */
	repositoryDefaultBranchRef?: string | null;
	/** 记忆值指向的分支已消失、因而被丢弃时的那个名字。 */
	rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists?: string | null;
	/**
	 * 建卡模式下自动解析出来的那个 base ref（`defaultCreateTaskBranchRef`）。
	 *
	 * 用来判定「下拉框现在显示的还是不是自动解析的结果」——用户手动改过之后，那两条解释来源的提示
	 * 就都不再成立。
	 */
	resolvedDefaultTaskCreateBaseRef?: string | null;
	worktreeMode: RuntimeTaskWorktreeMode;
	onWorktreeModeChange: (value: RuntimeTaskWorktreeMode) => void;
	agentId?: RuntimeAgentId | undefined;
	onAgentIdChange?: (value: RuntimeAgentId | undefined) => void;
	clineSettings?: RuntimeTaskClineSettings | undefined;
	onClineSettingsChange?: (value: RuntimeTaskClineSettings | undefined) => void;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	onTerminalAgentModelOverrideSettingsChange?: (
		value: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
		options?: TaskTerminalAgentModelOverrideSettingsChangeOptions,
	) => void;
	/** Agent definitions from runtimeConfig.agents — carries `installed` so the picker can grey out not-installed agents */
	agents?: RuntimeAgentDefinition[];
	/** Default agent ID from runtimeConfig.selectedAgentId, used to show "Default (AgentName)" in picker */
	defaultAgentId?: RuntimeAgentId | null;
	/** Default Cline provider ID from runtimeConfig.clineProviderSettings.providerId */
	defaultProviderId?: string | null;
	/** Default Cline model ID from runtimeConfig.clineProviderSettings.modelId */
	defaultModelId?: string | null;
	/** Default Cline reasoning effort from runtimeConfig.clineProviderSettings.reasoningEffort */
	defaultReasoningEffort?: RuntimeClineReasoningEffort | null;
	taskEditorMode?: "create" | "edit";
	creatingTaskName?: string;
	onCreatingTaskNameChange?: (value: string) => void;
	/** 本次打开时固定的草稿归属，不随目标选择或迁移后的物理位置变化。 */
	editorSessionWorkspaceId?: string | null;
	editingTaskName?: string;
	onEditingTaskNameChange?: (value: string) => void;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	onTaskAgentSessionInitializationChange?: (value: RuntimeTaskAgentSessionInitialization | undefined) => void;
	/** edit 模式下正在编辑的任务 id。草稿通知栏按它取这张卡片的落败副本。 */
	editingTaskId?: string | null;
	/** 值 = 铺表单用的那份草稿的 savedAt；null = 表单就是任务本体，通知栏那一条不出现。 */
	editTaskFormSeededFromSavedDraftAt?: number | null;
	onRevertEditTaskFormToSavedTaskContent?: () => void;
	onAdoptPromotedTaskEditDraft?: (promotedDraft: TaskEditDraft) => void;
	/** 由当前项目或目标任务提供归属；全项目创建可选，其他情况只读。 */
	taskCreationTargetProjectField?: TaskCreationTargetProjectField;
	postDeployVerificationFollowUpTaskCreationDraftSeed?: PostDeployVerificationFollowUpTaskCreationDraftSeed | null;
}): ReactElement {
	// 逐字输入下沉到这里，不再每次按键都经 `onPromptChange` 打到 `App` 根节点。
	// 那条老路径会把 1566 行的 `App` 连同整棵卡片树一起重渲，是「在任务创建界面打字很卡」的主因。
	const [promptDraft, setPromptDraft] = useState(prompt);
	// 父层值发生了非本组件引起的变化（打开编辑另一张卡、create-more 重置、切回单任务模式等）
	// 时采纳它。渲染期直接 setState 是 React 官方的「随 prop 变化调整 state」写法，
	// 比 effect 少一次多余提交；父层回声（值与本地一致）会被 React 自动 bail out。
	const lastPromptFromParentRef = useRef(prompt);
	if (prompt !== lastPromptFromParentRef.current) {
		lastPromptFromParentRef.current = prompt;
		setPromptDraft(prompt);
	}
	// 组件在对话框关闭后仍保持挂载（`App` 无条件渲染 `<TaskEditorDialog open={...}/>`），
	// 所以本地草稿必须在关闭那一刻显式拉回父层当前值。create 路径下父层 `newTaskPrompt`
	// 本就是空串，提交 / Discard 关闭都不产生 prop 变化，上面那段「随 prop 变化调整 state」
	// 因此不会被触发；若不在这里对齐，已提交的文本会作为幽灵草稿留在本地 state 里，
	// 下次打开 New task 时原样重现（再点一次 Create 就是重复任务）。
	const previousDialogOpenStateRef = useRef(open);
	if (previousDialogOpenStateRef.current !== open) {
		previousDialogOpenStateRef.current = open;
		if (!open) {
			lastPromptFromParentRef.current = prompt;
			setPromptDraft(prompt);
		}
	}
	const propagatePromptDraft = useCallback(
		(nextPrompt: string) => {
			if (nextPrompt === lastPromptFromParentRef.current) {
				return;
			}
			lastPromptFromParentRef.current = nextPrompt;
			onPromptChange(nextPrompt);
		},
		[onPromptChange],
	);
	// 见 PROMPT_DRAFT_IDLE_PROPAGATION_DELAY_MS：停止输入后的崩溃兜底上抛。
	// `open` 守卫是必需的：底层 `react-use` 的 useTimeoutFn 只在卸载时清定时器，且每次渲染
	// 都会把最新闭包写进 callback ref。对话框关闭并不会取消已挂起的这一拍，于是「最后一次
	// 击键后 1.5 秒内提交」（点 Create / Cmd+Enter，textarea 不失焦）会让它在关闭之后才 fire，
	// 把已提交或已丢弃的文本重新写回父层。关闭后本地草稿已由上面的开关同步拉平，这里不再上抛。
	useDebouncedEffect(
		() => {
			if (!open) {
				return;
			}
			propagatePromptDraft(promptDraft);
		},
		PROMPT_DRAFT_IDLE_PROPAGATION_DELAY_MS,
		[open, promptDraft, propagatePromptDraft],
	);

	// 宿主保存创建名称，挂起后可与正文、设置一起恢复；独立调用方仍可使用本地状态。
	const [localNewTaskName, setLocalNewTaskName] = useState("");
	const newTaskName = creatingTaskName ?? localNewTaskName;
	const setNewTaskName = onCreatingTaskNameChange ?? setLocalNewTaskName;
	const taskName = taskEditorMode === "edit" ? editingTaskName : newTaskName;
	const setTaskName = taskEditorMode === "edit" ? (onEditingTaskNameChange ?? setNewTaskName) : setNewTaskName;
	const [mode, setMode] = useState<"single" | "multi">("single");
	const [createMore, setCreateMore] = useState(false);
	const [composerResetKey, setComposerResetKey] = useState(0);
	const [taskPrompts, setTaskPrompts] = useState<string[]>([]);
	const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
	const nextFocusIndexRef = useRef<number | null>(null);
	const startInPlanModeId = useId();
	const autoReviewEnabledId = useId();
	const createMoreId = useId();
	const [primaryStartAction, setPrimaryStartAction] = useTaskCreateDialogPrimaryStartActionPreference();
	const [isDiscardConfirmOpen, setIsDiscardConfirmOpen] = useState(false);
	const {
		agentOptions,
		clineProviderOptions,
		clineModelOptions,
		effectiveDefaultModelId,
		providerModels,
		isLoadingProviders,
		isLoadingModels,
		terminalAgentModelOptions,
		terminalAgentDefaultModelId,
		isLoadingTerminalAgentModels,
		providerDefaultModels,
	} = useTaskAgentModelPicker({
		active: open,
		workspaceId,
		agentId,
		clineSettings,
		agents,
		defaultAgentId,
		defaultProviderId,
		defaultModelId,
	});

	// 权限档位的能力标注要跟随「这张卡实际会用哪个 agent」：卡片没显式选就落到工作区默认 agent。
	const effectiveTaskAgentPermissionModeAgentId = agentId ?? defaultAgentId ?? null;
	const effectiveTaskAgentPermissionModeAgentLabel =
		(effectiveTaskAgentPermissionModeAgentId === null
			? null
			: (agents?.find((agent) => agent.id === effectiveTaskAgentPermissionModeAgentId)?.label ??
				getRuntimeAgentCatalogEntry(effectiveTaskAgentPermissionModeAgentId)?.label)) ?? "This agent";

	// 只在「当前显示的正是被记住的那条 ref、且它确实偏离了仓库默认分支」时提示。两个条件都必要：
	// 用户当次手动改过下拉框就不该再说是记住的；记忆值恰好等于默认分支时提示只是噪声。
	const isShowingRememberedTaskCreateBaseRefHint =
		taskEditorMode === "create" &&
		!!taskCreateBaseRefRememberedForCurrentProject &&
		branchRef === taskCreateBaseRefRememberedForCurrentProject &&
		!!repositoryDefaultBranchRef &&
		branchRef !== repositoryDefaultBranchRef;

	// 「记忆的分支没了、已回落」这条同样只在建卡模式、且下拉框现在显示的确实就是那个回落结果时才成立。
	// 少了任一条件，它就会把编辑模式下卡片自己的 baseRef、或用户手动挑的分支，说成是自动回落的产物。
	const isShowingDiscardedRememberedTaskCreateBaseRefHint =
		taskEditorMode === "create" &&
		!!rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists &&
		!!resolvedDefaultTaskCreateBaseRef &&
		branchRef === resolvedDefaultTaskCreateBaseRef;

	// `useDeferredValue` 在这里是划算的，与「不要把它放在 hook / App 根节点」并不矛盾：
	// 双 commit 的代价完全取决于被重渲的子树大小。放根节点要把 51 个 hook 调用点付两遍；
	// 放这里，deferred 那一遍只重渲对话框内「检测到 N 项」这一小块提示。
	const deferredPromptDraft = useDeferredValue(promptDraft);
	const detectedItems = useMemo(() => parseListItems(deferredPromptDraft), [deferredPromptDraft]);
	const hasPromptDraftContent = useMemo(() => promptDraft.trim().length > 0, [promptDraft]);
	const validTaskCount = useMemo(() => taskPrompts.filter((p) => p.trim()).length, [taskPrompts]);
	const effectivePrimaryStartAction =
		onCreateStartAndOpen || primaryStartAction === "start" ? primaryStartAction : DEFAULT_PRIMARY_START_ACTION;
	const secondaryStartAction = effectivePrimaryStartAction === "start" ? "start_and_open" : "start";

	// Reset state when dialog closes
	useEffect(() => {
		if (!open) {
			setLocalNewTaskName("");
			setMode("single");
			setCreateMore(false);
			setComposerResetKey(0);
			setTaskPrompts([]);
			setIsDiscardConfirmOpen(false);
			inputRefs.current = [];
			nextFocusIndexRef.current = null;
		}
	}, [open]);

	// Handle pending focus after render
	useEffect(() => {
		if (nextFocusIndexRef.current !== null) {
			const idx = nextFocusIndexRef.current;
			nextFocusIndexRef.current = null;
			requestAnimationFrame(() => {
				inputRefs.current[idx]?.focus();
			});
		}
	});

	const handleSplitIntoTasks = useCallback(() => {
		onTaskAgentSessionInitializationChange?.(undefined);
		setTaskPrompts(detectedItems);
		setMode("multi");
		nextFocusIndexRef.current = 0;
	}, [detectedItems, onTaskAgentSessionInitializationChange]);

	const handleBackToSingle = useCallback(() => {
		const joined = taskPrompts
			.filter((p) => p.trim())
			.map((p, i) => `${i + 1}. ${p}`)
			.join("\n");
		setPromptDraft(joined);
		propagatePromptDraft(joined);
		setMode("single");
		setTaskPrompts([]);
	}, [taskPrompts, propagatePromptDraft]);

	const handleUpdateTaskPrompt = useCallback((index: number, value: string) => {
		setTaskPrompts((prev) => {
			const next = [...prev];
			next[index] = value;
			return next;
		});
	}, []);

	const handleRemoveTask = useCallback((index: number) => {
		setTaskPrompts((prev) => {
			if (prev.length <= 1) {
				return prev;
			}
			nextFocusIndexRef.current = Math.min(index, prev.length - 2);
			return prev.filter((_, i) => i !== index);
		});
	}, []);

	const handleAddTask = useCallback((afterIndex?: number) => {
		setTaskPrompts((prev) => {
			const insertIndex = afterIndex !== undefined ? afterIndex + 1 : prev.length;
			nextFocusIndexRef.current = insertIndex;
			const next = [...prev];
			next.splice(insertIndex, 0, "");
			return next;
		});
	}, []);

	const getValidPrompts = useCallback(() => {
		return taskPrompts.filter((p) => p.trim());
	}, [taskPrompts]);

	const resetForCreateMore = useCallback(() => {
		setPromptDraft("");
		propagatePromptDraft("");
		// 下一张卡是新的一张，上一张的名字与候选都不该跟过去。名字在这里清；候选轮次是
		// TaskNameInputWithAiSuggestions 的本地 state，靠下面 setComposerResetKey 换 key 重挂来清
		//（对话框整个关掉时不需要这一步：Radix 关闭即卸载内容，那些 state 自然没了）。
		setNewTaskName("");
		onImagesChange([]);
		setMode("single");
		setTaskPrompts([]);
		inputRefs.current = [];
		nextFocusIndexRef.current = null;
		setComposerResetKey((current) => current + 1);
	}, [onImagesChange, propagatePromptDraft]);

	const [temporarilyRevealedSettingKeys, setTemporarilyRevealedSettingKeys] = useState<ReadonlySet<string>>(new Set());
	const revealAndFocusRelations = useCallback(() => {
		setTemporarilyRevealedSettingKeys(new Set(["relations"]));
		requestAnimationFrame(() => {
			const section = document.querySelector<HTMLElement>('[data-task-editor-setting="relations"]');
			section?.scrollIntoView({ block: "nearest" });
			section?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
		});
	}, []);
	const clipboardTaskReference = useTaskEditorClipboardTaskReference({
		open,
		workspaceId,
		taskId: taskEditorMode === "edit" ? editingTaskId : null,
		onRecognized: revealAndFocusRelations,
	});

	const [localSelectedTargetWorkspaceId, setLocalSelectedTargetWorkspaceId] = useState<string | null>(workspaceId);
	const selectableTargetProjectField =
		taskCreationTargetProjectField?.taskCreationTargetProjectFieldPresentation ===
		"target_project_selectable_in_board_scope"
			? taskCreationTargetProjectField
			: null;
	useEffect(() => {
		if (!selectableTargetProjectField) setLocalSelectedTargetWorkspaceId(workspaceId);
	}, [workspaceId, editingTaskId, open, selectableTargetProjectField]);
	const targetWorkspaceId =
		selectableTargetProjectField?.selectedTargetWorkspaceId ?? localSelectedTargetWorkspaceId ?? workspaceId;
	const setSelectedTargetWorkspaceId = (nextWorkspaceId: string) => {
		if (selectableTargetProjectField) selectableTargetProjectField.onSelectTargetWorkspaceId(nextWorkspaceId);
		else setLocalSelectedTargetWorkspaceId(nextWorkspaceId);
	};
	const { gitRepositoryInfoOfOtherProject: selectedTargetGit } = useGitRepositoryInfoOfOtherProjectForTaskEditorDialog(
		targetWorkspaceId !== workspaceId ? targetWorkspaceId : null,
	);
	const effectiveBranchOptions = selectedTargetGit
		? selectedTargetGit.branches.map((branch) => ({ value: branch.name, label: branch.name }))
		: branchOptions;
	const effectiveProjectField: TaskCreationTargetProjectField | undefined =
		taskCreationTargetProjectField?.taskCreationTargetProjectFieldPresentation ===
		"target_project_selectable_in_board_scope"
			? {
					...taskCreationTargetProjectField,
					selectedTargetWorkspaceId: targetWorkspaceId,
					onSelectTargetWorkspaceId: setSelectedTargetWorkspaceId,
				}
			: taskCreationTargetProjectField;
	useEffect(() => {
		if (
			!selectableTargetProjectField &&
			selectedTargetGit &&
			!selectedTargetGit.branches.some((branch) => branch.name === branchRef)
		) {
			onBranchRefChange(selectedTargetGit.defaultBranch ?? selectedTargetGit.branches[0]?.name ?? "");
		}
	}, [selectableTargetProjectField, selectedTargetGit, branchRef, onBranchRefChange]);
	const submissionInFlightRef = useRef(false);
	const submissionOperationTokenRef = useRef<symbol | null>(null);
	const [isTaskEditorPersisting, setIsTaskEditorPersisting] = useState(false);

	const submissionImagesRevisionRef = useRef({ images, revision: 0 });
	if (submissionImagesRevisionRef.current.images !== images)
		submissionImagesRevisionRef.current = { images, revision: submissionImagesRevisionRef.current.revision + 1 };
	const latestSubmissionInputRef = useRef("");
	latestSubmissionInputRef.current = JSON.stringify({
		open,
		editorIdentity: editingTaskId,
		taskEditorMode,
		workspaceId: targetWorkspaceId,
		prompt: promptDraft,
		title: taskName,
		branchRef,
		imagesRevision: submissionImagesRevisionRef.current.revision,
		startInPlanMode,
		taskAgentPermissionMode,
		taskConversationMode,
		autoReviewEnabled,
		autoReviewMode,
		worktreeMode,
		agentId,
		clineSettings,
		terminalAgentModelOverrideSettings,
		taskAgentSessionInitialization,
		mode,
		taskPrompts,
	});

	const relationModeling = useReferenceRelationModelingEditor({
		workspaceId: editorSessionWorkspaceId,
		taskId: taskEditorMode === "edit" ? editingTaskId : null,
		draftTaskTitle: taskName || "待创建任务",
		draftTaskPrompt: promptDraft,
		active: open && mode === "single",
	});
	const [processedFollowUpSeedInitializationId, setProcessedFollowUpSeedInitializationId] = useState<string | null>(
		null,
	);
	const [followUpSeedAwaitingDiscardConfirmation, setFollowUpSeedAwaitingDiscardConfirmation] =
		useState<PostDeployVerificationFollowUpTaskCreationDraftSeed | null>(null);
	useEffect(() => {
		if (!open) setFollowUpSeedAwaitingDiscardConfirmation(null);
	}, [open]);
	const isTaskCreationWaitingForRelationDraftHydration =
		taskEditorMode === "create" &&
		mode === "single" &&
		(!relationModeling.ready ||
			(!!postDeployVerificationFollowUpTaskCreationDraftSeed &&
				processedFollowUpSeedInitializationId !==
					postDeployVerificationFollowUpTaskCreationDraftSeed.initializationId));
	const [isRelationAwareCreationInFlight, setIsRelationAwareCreationInFlight] = useState(false);
	useEffect(() => {
		submissionOperationTokenRef.current = null;
		submissionInFlightRef.current = false;
		setIsRelationAwareCreationInFlight(false);
		setIsTaskEditorPersisting(false);
	}, [open, editorSessionWorkspaceId, editingTaskId]);
	const [hasUnstagedRelationForm, setHasUnstagedRelationForm] = useState(false);
	const [relationAwareCreationError, setRelationAwareCreationError] = useState<string | null>(null);
	const lastCreationGestureRef = useRef<{ event: TriggeringExplicitUserGestureEvent; observedAt: number } | null>(
		null,
	);
	const relationRecoveryAppliedRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			relationModeling.ready &&
			relationModeling.draft.creationPrompt &&
			relationRecoveryAppliedRef.current !== editorSessionWorkspaceId
		) {
			relationRecoveryAppliedRef.current = editorSessionWorkspaceId;
			setPromptDraft(relationModeling.draft.creationPrompt);
			setTaskName(relationModeling.draft.creationTitle);
		}
	}, [
		relationModeling.ready,
		relationModeling.draft.creationPrompt,
		relationModeling.draft.creationTitle,
		editorSessionWorkspaceId,
	]);
	const updateRelationDraft = relationModeling.updateDraft;
	const initializeFollowUpTaskCreationDraft = useCallback(
		(seed: PostDeployVerificationFollowUpTaskCreationDraftSeed) => {
			updateRelationDraft({
				referenceRelationDrafts: seed.referenceRelationDrafts,
				relationRevocations: [],
				createdTaskId: null,
				createdTaskCardSnapshot: null,
				creationPrompt: seed.prompt,
				creationTitle: seed.title,
			});
			relationRecoveryAppliedRef.current = seed.workspaceId;
			setPromptDraft(seed.prompt);
			propagatePromptDraft(seed.prompt);
			setNewTaskName(seed.title);
			setProcessedFollowUpSeedInitializationId(seed.initializationId);
			setRelationAwareCreationError(null);
		},
		[updateRelationDraft, propagatePromptDraft],
	);
	useEffect(() => {
		const seed = postDeployVerificationFollowUpTaskCreationDraftSeed;
		if (
			!open ||
			taskEditorMode !== "create" ||
			!seed ||
			seed.workspaceId !== workspaceId ||
			!relationModeling.ready ||
			processedFollowUpSeedInitializationId === seed.initializationId
		)
			return;
		// 恢复的草稿与本次来源不能静默合并；沿用现有放弃确认，并保留已创建任务的身份。
		if (
			relationModeling.hasChanges ||
			relationModeling.draft.createdTaskId ||
			relationModeling.draft.creationPrompt ||
			promptDraft.trim()
		) {
			setFollowUpSeedAwaitingDiscardConfirmation(seed);
			setIsDiscardConfirmOpen(true);
			return;
		}
		initializeFollowUpTaskCreationDraft(seed);
	}, [
		open,
		taskEditorMode,
		postDeployVerificationFollowUpTaskCreationDraftSeed,
		workspaceId,
		relationModeling.ready,
		relationModeling.hasChanges,
		relationModeling.draft.createdTaskId,
		relationModeling.draft.creationPrompt,
		promptDraft,
		processedFollowUpSeedInitializationId,
		initializeFollowUpTaskCreationDraft,
	]);

	const submitSingleTask = async (
		action: "create" | "start" | "start_and_open",
		promptOverride?: string,
		keepOpenOverride?: boolean,
	) => {
		if (
			submissionInFlightRef.current ||
			isTaskCreationWaitingForRelationDraftHydration ||
			!targetWorkspaceId ||
			!branchRef
		)
			return false;
		if (hasUnstagedRelationForm) {
			setRelationAwareCreationError("请先将当前关系加入草稿，或取消关系编辑，再提交任务。");
			revealAndFocusRelations();
			return false;
		}
		const submittingPrompt = promptOverride ?? promptDraft;
		const submittingTitle = promptOverride ? "" : taskName;
		if (!submittingPrompt.trim()) return false;
		const inputSnapshot = latestSubmissionInputRef.current;
		let acceptedAssignmentInputSnapshot = inputSnapshot;
		const isSubmittedInputStillCurrent = () =>
			latestSubmissionInputRef.current === inputSnapshot ||
			latestSubmissionInputRef.current === acceptedAssignmentInputSnapshot;
		const relationSnapshot = JSON.stringify({
			drafts: relationModeling.readLatestDraft().referenceRelationDrafts,
			revocations: relationModeling.readLatestDraft().relationRevocations,
		});
		const gesture = lastCreationGestureRef.current;
		// 在用户动作发生时读取来源证据，分析耗时不能伪造新的用户手势。
		const characteristics =
			gesture && performance.now() - gesture.observedAt <= 1000
				? collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(gesture.event)
				: null;
		if (relationModeling.hasChanges && !characteristics) {
			setRelationAwareCreationError("请点击提交按钮或使用快捷键保存关系。");
			return false;
		}
		const operationToken = Symbol("task-editor-submission");
		submissionOperationTokenRef.current = operationToken;
		submissionInFlightRef.current = true;
		setIsRelationAwareCreationInFlight(true);
		setRelationAwareCreationError(null);
		try {
			const assignment = await runTaskProjectAssignmentPreflight({
				workspaceId: targetWorkspaceId,
				title: submittingTitle,
				prompt: submittingPrompt,
				baseRef: branchRef,
				isStillCurrent: () =>
					latestSubmissionInputRef.current === inputSnapshot &&
					JSON.stringify({
						drafts: relationModeling.readLatestDraft().referenceRelationDrafts,
						revocations: relationModeling.readLatestDraft().relationRevocations,
					}) === relationSnapshot,
			});
			if (!assignment) return false;
			if (taskEditorMode === "create")
				await ensureOneRuntimeAllocatedTaskIdReadyForTaskEditorSubmission(assignment.workspaceId);
			if (latestSubmissionInputRef.current !== inputSnapshot) return false;
			acceptedAssignmentInputSnapshot = JSON.stringify({
				...(JSON.parse(inputSnapshot) as Record<string, unknown>),
				workspaceId: assignment.workspaceId,
				branchRef: assignment.baseRef,
			});
			setIsTaskEditorPersisting(true);
			setSelectedTargetWorkspaceId(assignment.workspaceId);
			onBranchRefChange(assignment.baseRef);
			let persistence: Promise<boolean> | null = null;
			const recoveredTaskId =
				taskEditorMode === "create" && !promptOverride ? relationModeling.draft.createdTaskId : null;
			const taskId = recoveredTaskId
				? recoveredTaskId
				: onCreate({
						keepDialogOpen: true,
						preserveFormUntilCreationConfirmed: true,
						promptOverride: submittingPrompt,
						taskNameOverride: submittingTitle,
						targetWorkspaceIdOverride: assignment.workspaceId,
						baseRefOverride: assignment.baseRef,
						onTaskPersistenceRequested: (requested) => {
							persistence = requested;
						},
						onTaskCardAllocatedForRelationModeling: (card) => {
							if (!promptOverride)
								relationModeling.updateDraft({
									createdTaskId: card.id,
									createdTaskWorkspaceId: assignment.workspaceId,
									createdTaskCardSnapshot: card,
									creationPrompt: submittingPrompt,
									creationTitle: taskName,
								});
						},
					});
			if (!taskId) return false;
			if (recoveredTaskId) {
				const draft = relationModeling.readLatestDraft();
				const sourceWorkspaceId = draft.createdTaskWorkspaceId ?? workspaceId;
				if (!sourceWorkspaceId) throw new Error("恢复草稿缺少所属项目，请重新选择该任务。");
				let recoveredSnapshot = draft.createdTaskCardSnapshot;
				if (!recoveredSnapshot) {
					const existing = await readTaskCardWithBoardColumnInWorkspace(sourceWorkspaceId, taskId);
					if (existing.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
						throw new Error("恢复草稿对应的任务尚未确认存在，未创建重复任务。");
					recoveredSnapshot = existing.taskCardSnapshot.taskCard;
				} else await ensureRelationModelingCreatedTaskCardPersisted(sourceWorkspaceId, recoveredSnapshot);

				await updateTaskCardFieldValuesInWorkspace(sourceWorkspaceId, {
					taskId,
					expectedTaskIncarnationCreatedAtEpochMs: recoveredSnapshot.createdAt,
					taskCardFieldUpdate: {
						taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
						taskCardFieldValuePatch: {
							title: taskName.trim() || null,
							prompt: submittingPrompt,
							images,
							startInPlanMode,
							taskAgentPermissionMode,
							taskConversationMode,
							autoReviewEnabled,
							autoReviewMode,
							worktreeMode,
							baseRef: assignment.baseRef,
							agentId: agentId ?? null,
							clineSettings: clineSettings ?? null,
							terminalAgentModelOverrideSettings: terminalAgentModelOverrideSettings ?? null,
							taskAgentSessionInitialization: taskAgentSessionInitialization ?? null,
						},
					},
					boardMutationInitiator: "web_ui_user_gesture",
				});
				if (sourceWorkspaceId !== assignment.workspaceId)
					await transferNeverStartedBacklogTaskToProjectInWorkspace(sourceWorkspaceId, {
						operationId: createRandomUuidV4WithInsecureContextFallback(),
						taskId,
						taskIncarnationCreatedAtEpochMs: recoveredSnapshot.createdAt,
						targetWorkspaceId: assignment.workspaceId,
						targetBaseRef: assignment.baseRef,
					});
				relationModeling.updateDraft({
					createdTaskWorkspaceId: assignment.workspaceId,
					creationPrompt: submittingPrompt,
					creationTitle: taskName,
				});
				await relationModeling.persistDraftNow();
			}
			if (taskEditorMode === "edit") {
				if (persistence && !(await persistence)) throw new Error("任务更改尚未保存，草稿已保留。");
			} else {
				const persisted = await waitForAlreadyRequestedNewTaskCardRuntimePersistenceWithoutRetrying({
					workspaceId: assignment.workspaceId,
					taskId,
				});
				if (!persisted.ok) {
					const snapshot = relationModeling.readLatestDraft().createdTaskCardSnapshot;
					if (snapshot) await ensureRelationModelingCreatedTaskCardPersisted(assignment.workspaceId, snapshot);
					else throw new Error(`任务尚未确认保存：${persisted.message}`);
				}
			}
			if (!isSubmittedInputStillCurrent())
				throw new Error("提交期间输入又有更改，新的草稿已保留，请核对后再次保存。");
			if (relationModeling.hasChanges && characteristics)
				await relationModeling.applyToTask(taskId, characteristics, assignment.workspaceId);
			if (!isSubmittedInputStillCurrent())
				throw new Error("保存关系期间输入又有更改，新的草稿已保留，尚未启动任务。");
			rememberTaskProjectAssignmentAnalysisAccepted(
				assignment.workspaceId,
				taskId,
				submittingTitle,
				submittingPrompt,
			);
			if (action !== "create") {
				const started = await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime({
					workspaceId: assignment.workspaceId,
					taskId,
					skipTaskProjectAssignmentPreflight: true,
					agentTerminalGeometryForTaskSessionSpawn: resolveAgentTerminalGeometryForTaskSessionSpawn(taskId),
				});
				if (started.taskCardActionCommandExecutionOutcome === "command_failed")
					throw new Error(started.commandFailureMessage);
				if (started.taskCardActionCommandExecutionOutcome !== "command_completed_by_runtime")
					throw new Error("任务仍有其他操作在执行，请稍后重试启动。");
				if (started.response.ensuredTaskWorktreeWarningMessage)
					showAppToast({ intent: "warning", message: started.response.ensuredTaskWorktreeWarningMessage });
				if (
					started.response.agentSessionStartOutcome === "task_worktree_ensure_failed" ||
					started.response.agentSessionStartOutcome === "agent_session_start_failed"
				)
					throw new Error(started.response.agentSessionStartFailureMessage ?? "任务已保存，但 Agent 启动失败。");
				if (action === "start_and_open") onOpenCreatedTaskWithRelations?.(assignment.workspaceId, taskId);
			}
			relationModeling.discard();
			if (!isSubmittedInputStillCurrent()) return true;
			if (!(keepOpenOverride ?? (createMore && taskEditorMode === "create"))) onOpenChange(false);
			else if (!promptOverride) resetForCreateMore();
			return true;
		} catch (failure) {
			const message = failure instanceof Error ? failure.message : String(failure);
			if (submissionOperationTokenRef.current === operationToken) {
				setRelationAwareCreationError(message);
				notifyError(message);
			}
			return false;
		} finally {
			if (submissionOperationTokenRef.current === operationToken) {
				submissionInFlightRef.current = false;
				submissionOperationTokenRef.current = null;
				setIsRelationAwareCreationInFlight(false);
				setIsTaskEditorPersisting(false);
			}
		}
	};
	const handleCreateSingle = () => {
		void submitSingleTask("create");
	};
	const handleCreateAndStartSingle = () => {
		void submitSingleTask("start");
	};
	const handleCreateStartAndOpenSingle = () => {
		void submitSingleTask("start_and_open");
	};

	const handleRunSingleStartAction = useCallback(
		(action: TaskCreateStartAction) => {
			setPrimaryStartAction(action);
			if (action === "start_and_open") {
				handleCreateStartAndOpenSingle();
				return;
			}
			handleCreateAndStartSingle();
		},
		[handleCreateAndStartSingle, handleCreateStartAndOpenSingle, setPrimaryStartAction],
	);

	const submitMultipleTasks = async (action: "create" | "start") => {
		const prompts = getValidPrompts();
		for (let index = 0; index < prompts.length; index++) {
			if (!(await submitSingleTask(action, prompts[index], true))) {
				setTaskPrompts(prompts.slice(index));
				return;
			}
		}
		if (createMore) resetForCreateMore();
		else onOpenChange(false);
	};
	const handleCreateAll = () => {
		void submitMultipleTasks("create");
	};
	const handleCreateAndStartAll = () => {
		void submitMultipleTasks("start");
	};

	const handleAnalyzeProject = async () => {
		if (!targetWorkspaceId || !promptDraft.trim() || submissionInFlightRef.current) return;
		const snapshot = latestSubmissionInputRef.current;
		const operationToken = Symbol("manual-task-project-analysis");
		submissionOperationTokenRef.current = operationToken;
		submissionInFlightRef.current = true;
		setIsRelationAwareCreationInFlight(true);
		try {
			const result = await runTaskProjectAssignmentPreflight({
				workspaceId: targetWorkspaceId,
				title: taskName,
				prompt: promptDraft,
				baseRef: branchRef,
				isStillCurrent: () => latestSubmissionInputRef.current === snapshot,
			});
			if (result) {
				setSelectedTargetWorkspaceId(result.workspaceId);
				onBranchRefChange(result.baseRef);
			}
		} catch (failure) {
			notifyError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			if (submissionOperationTokenRef.current === operationToken) {
				submissionInFlightRef.current = false;
				submissionOperationTokenRef.current = null;
				setIsRelationAwareCreationInFlight(false);
			}
		}
	};

	const handleInputKeyDown = useCallback(
		(index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
			// 输入法组字期间，按键属于输入法本身（上屏字符原文、翻候选页、取消组字），处理器必须整体让开。
			if (isKeyboardEventEmittedDuringImeComposition(event)) {
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.shiftKey) {
					handleCreateAndStartAll();
					return;
				}
				handleCreateAll();
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				handleAddTask(index);
				return;
			}
			if (event.key === "Backspace" && taskPrompts[index] === "" && taskPrompts.length > 1) {
				event.preventDefault();
				handleRemoveTask(index);
			}
		},
		[handleAddTask, handleCreateAll, handleCreateAndStartAll, handleRemoveTask, taskPrompts],
	);

	const setInputRef = useCallback((index: number, el: HTMLInputElement | null) => {
		inputRefs.current[index] = el;
	}, []);

	const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (isKeyboardEventEmittedDuringImeComposition(event) || event.defaultPrevented || event.key !== "Enter") return;
		if (!branchRef || !hasPromptDraftContent || isRelationAwareCreationInFlight) return;
		if (event.altKey && event.shiftKey && onCreateStartAndOpen && mode === "single") {
			event.preventDefault();
			handleRunSingleStartAction("start_and_open");
		} else if (event.metaKey || event.ctrlKey) {
			event.preventDefault();
			if (mode === "multi") {
				if (event.shiftKey) handleCreateAndStartAll();
				else handleCreateAll();
			} else if (event.shiftKey) handleRunSingleStartAction("start");
			else handleCreateSingle();
		}
	};

	// 创建与编辑在显式关闭时共用未保存更改守卫。
	// 每次渲染刷新「当前表单」快照，供关闭时与打开时的基线比较。
	const currentFormSnapshot: TaskCreateFormSnapshot = {
		prompt: promptDraft,
		taskName,
		multiPromptContent: taskPrompts
			.map((value) => value.trim())
			.filter(Boolean)
			.join("\n"),
		imageCount: images.length,
		startInPlanMode,
		taskAgentPermissionMode,
		taskConversationMode,
		autoReviewEnabled,
		autoReviewMode,
		branchRef,
		worktreeMode,
		agentId,
		clineSettings,
		terminalAgentModelOverrideSettings,
		taskAgentSessionInitialization,
		projectWorkspaceId: targetWorkspaceId,
	};
	const latestFormSnapshotRef = useRef(currentFormSnapshot);
	latestFormSnapshotRef.current = currentFormSnapshot;
	const baselineFormSnapshotRef = useRef<TaskCreateFormSnapshot | null>(null);

	// 打开那一刻捕获基线；关闭时清空。基线来自当次打开后 settle 的默认值。
	useEffect(() => {
		baselineFormSnapshotRef.current = open ? latestFormSnapshotRef.current : null;
	}, [open]);

	const handleCloseRequest = useCallback(() => {
		if (isRelationAwareCreationInFlight) return;
		const baseline = baselineFormSnapshotRef.current;
		const hasEdits = baseline ? hasTaskCreateFormEdits(latestFormSnapshotRef.current, baseline) : false;
		if (hasEdits || relationModeling.hasChanges || relationModeling.draft.createdTaskId || hasUnstagedRelationForm) {
			setIsDiscardConfirmOpen(true);
			return;
		}
		onOpenChange(false);
	}, [
		onOpenChange,
		relationModeling.hasChanges,
		relationModeling.draft.createdTaskId,
		hasUnstagedRelationForm,
		isRelationAwareCreationInFlight,
	]);

	// X 关闭按钮走 Radix Close → onOpenChange(false)；Esc / 点击外部各自 preventDefault
	// 后也汇到这里。create 模式统一经 handleCloseRequest 守卫；edit 模式直通 base 语义。
	const handleDialogOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				onOpenChange(true);
				return;
			}
			if (open) {
				handleCloseRequest();
				return;
			}
			onOpenChange(false);
		},
		[handleCloseRequest, open, onOpenChange],
	);

	const handleConfirmDiscard = useCallback(() => {
		setIsDiscardConfirmOpen(false);
		relationModeling.discard();
		if (
			followUpSeedAwaitingDiscardConfirmation &&
			followUpSeedAwaitingDiscardConfirmation.workspaceId === workspaceId &&
			followUpSeedAwaitingDiscardConfirmation.initializationId ===
				postDeployVerificationFollowUpTaskCreationDraftSeed?.initializationId
		) {
			initializeFollowUpTaskCreationDraft(followUpSeedAwaitingDiscardConfirmation);
			setFollowUpSeedAwaitingDiscardConfirmation(null);
			return;
		}
		onOpenChange(false);
	}, [
		onOpenChange,
		relationModeling.discard,
		followUpSeedAwaitingDiscardConfirmation,
		workspaceId,
		postDeployVerificationFollowUpTaskCreationDraftSeed,
		initializeFollowUpTaskCreationDraft,
	]);

	const handleCancelDiscard = useCallback(() => {
		if (followUpSeedAwaitingDiscardConfirmation) {
			setProcessedFollowUpSeedInitializationId(followUpSeedAwaitingDiscardConfirmation.initializationId);
			setFollowUpSeedAwaitingDiscardConfirmation(null);
		}
		setIsDiscardConfirmOpen(false);
	}, [followUpSeedAwaitingDiscardConfirmation]);

	const dialogTitle =
		taskEditorMode === "edit"
			? "编辑 Backlog 任务"
			: mode === "multi"
				? `New tasks${validTaskCount > 0 ? ` (${validTaskCount})` : ""}`
				: "创建任务";

	const taskCountLabel = validTaskCount === 1 ? "task" : "tasks";
	const primaryStartLabel =
		taskEditorMode === "edit"
			? effectivePrimaryStartAction === "start"
				? "Save and start"
				: "Save, start and open"
			: effectivePrimaryStartAction === "start"
				? "Start task"
				: "Start and open";
	const primaryStartShortcutModifier = effectivePrimaryStartAction === "start" ? "mod" : "alt";
	const secondaryStartLabel = secondaryStartAction === "start" ? "Start task" : "Start and open";
	const secondaryStartShortcutModifier = secondaryStartAction === "start" ? "mod" : "alt";

	return (
		<>
			<TaskEditorFloatingWindow
				open={open}
				onOpenChange={handleDialogOpenChange}
				title={dialogTitle}
				onClickCapture={(event) => {
					lastCreationGestureRef.current = { event: event.nativeEvent, observedAt: performance.now() };
				}}
				onKeyDownCapture={(event) => {
					lastCreationGestureRef.current = { event: event.nativeEvent, observedAt: performance.now() };
				}}
				onKeyDown={handleEditorKeyDown}
				onFocusCapture={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null))
						clipboardTaskReference.checkClipboard();
				}}
				onPasteCapture={(event) => {
					void clipboardTaskReference.processPastedText(event.clipboardData.getData("text/plain"));
				}}
			>
				<TaskEditorSettingPresentationProvider
					temporarilyRevealedKeys={temporarilyRevealedSettingKeys}
					onUserPresentationChange={(key) =>
						setTemporarilyRevealedSettingKeys((previous) => {
							const next = new Set(previous);
							next.delete(key);
							return next;
						})
					}
				>
					<DialogBody>
						<fieldset disabled={isTaskEditorPersisting} className="min-w-0">
							{suspendedTaskEditorTitle && onResumeSuspendedTaskEditor ? (
								<Button size="sm" onClick={onResumeSuspendedTaskEditor} className="mb-3 max-w-full truncate">
									返回草稿：{suspendedTaskEditorTitle}
								</Button>
							) : null}
							<div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
								<div className="min-w-0 space-y-3">
									{/* 草稿通知栏。只在 edit 模式出现：create 模式没有「任务已保存的内容」可以改回去，
					    也不存在按 taskId 归属的落败副本。它不阻塞保存——只是把一直存在却看不见的事实说出来。 */}
									{taskEditorMode === "edit" && editingTaskId !== null ? (
										<TaskEditDraftRecoveryNotice
											workspaceId={workspaceId}
											taskId={editingTaskId}
											seededFromSavedDraftAt={editTaskFormSeededFromSavedDraftAt}
											currentFormValues={
												{
													// 用 dialog 内部的 promptDraft 而不是父层 prompt：逐字输入下沉在这里，
													// 父层那份要等失焦/提交才追平，拿它做对照会把「已经改过了」说成没差别。
													taskTitleOverride: taskName,
													prompt: promptDraft,
													images,
													startInPlanMode,
													taskAgentPermissionMode,
													autoReviewEnabled,
													autoReviewMode,
													branchRef,
													worktreeMode,
													agentId,
													clineSettings,
													terminalAgentModelOverrideSettings,
													taskAgentSessionInitialization,
												} satisfies TaskEditDraftComparableValues
											}
											onRevertToSavedTaskContent={() => onRevertEditTaskFormToSavedTaskContent?.()}
											onSupersededCopyPromotedToCurrentDraft={(promotedDraft) =>
												onAdoptPromotedTaskEditDraft?.(promotedDraft)
											}
										/>
									) : null}
									{mode === "single" ? (
										<div>
											<TaskNameInputWithAiSuggestions
												key={`task-name-input-${editingTaskId ?? composerResetKey}`}
												taskName={taskName}
												onTaskNameChange={setTaskName}
												taskDescription={promptDraft}
												preserveNameUntilSuggestionIsPicked={taskEditorMode === "edit"}
											/>

											<TaskPromptComposer
												key={`task-prompt-composer-${composerResetKey}`}
												value={promptDraft}
												onValueChange={setPromptDraft}
												onValueBlur={() => propagatePromptDraft(promptDraft)}
												images={images}
												onImagesChange={onImagesChange}
												onSubmit={handleCreateSingle}
												onSubmitAndStart={() => handleRunSingleStartAction("start")}
												placeholder="Describe the task..."
												autoFocus
												workspaceId={targetWorkspaceId}
												showAttachImageButton
												showPseudoHtmlBlockInsertButton
											/>
											<div className="flex items-center justify-between mt-1.5">
												<p className="text-[11px] text-text-tertiary">
													Use{" "}
													<code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">
														@file
													</code>{" "}
													to reference files. Drag and drop or{" "}
													<code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">
														{pasteShortcutLabel}
													</code>{" "}
													also adds images.
												</p>
												{taskEditorMode === "create" && detectedItems.length >= 2 ? (
													<button
														type="button"
														onClick={handleSplitIntoTasks}
														disabled={
															isTaskCreationWaitingForRelationDraftHydration ||
															relationModeling.hasChanges ||
															Boolean(relationModeling.draft.createdTaskId) ||
															hasUnstagedRelationForm ||
															isRelationAwareCreationInFlight
														}
														title={
															relationModeling.hasChanges ||
															relationModeling.draft.createdTaskId ||
															hasUnstagedRelationForm
																? "请先完成或放弃关系草稿，再拆分为多个任务。"
																: undefined
														}
														className="inline-flex items-center gap-1.5 text-[12px] text-status-blue hover:text-[#86BEFF] cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-default"
													>
														<List size={12} />
														Split into {detectedItems.length} tasks
													</button>
												) : null}
											</div>
										</div>
									) : (
										<div>
											<div className="flex flex-col gap-1.5">
												{taskPrompts.map((taskPrompt, index) => (
													<div key={index} className="flex items-center gap-1.5">
														<span className="text-[12px] text-text-tertiary text-right shrink-0 tabular-nums">
															{index + 1}.
														</span>
														<input
															ref={(el) => setInputRef(index, el)}
															type="text"
															value={taskPrompt}
															onChange={(e) => handleUpdateTaskPrompt(index, e.target.value)}
															onKeyDown={(e) => handleInputKeyDown(index, e)}
															placeholder="Describe the task..."
															className="flex-1 min-w-0 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
														/>
														<Button
															variant="ghost"
															size="sm"
															icon={<X size={14} />}
															onClick={() => handleRemoveTask(index)}
															aria-label={`Remove task ${index + 1}`}
														/>
													</div>
												))}
											</div>
											<div className="flex items-center justify-between mt-3">
												<button
													type="button"
													onClick={() => handleAddTask()}
													className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
												>
													<Plus size={12} />
													Add task
												</button>
												<button
													type="button"
													onClick={handleBackToSingle}
													className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
												>
													<ArrowLeft size={12} />
													Back to single prompt
												</button>
											</div>
										</div>
									)}
								</div>
								<div className="min-w-0 space-y-5">
									<TaskEditorSettingGroup
										title="项目与 Git"
										settings={[
											{
												key: "project",
												label: "所属项目",
												content: (
													<>
														{taskCreationTargetProjectField ? (
															<div className="mb-4">
																<TaskCreationTargetProjectFieldControl
																	taskCreationTargetProjectField={effectiveProjectField!}
																/>
															</div>
														) : null}
														<Button
															size="sm"
															disabled={!promptDraft.trim() || isRelationAwareCreationInFlight}
															onClick={() => void handleAnalyzeProject()}
														>
															分析项目归属
														</Button>
														{selectedTargetGit && targetWorkspaceId !== workspaceId ? (
															<p className="mt-2 text-xs text-text-secondary">
																已按目标项目校验基础分支：{branchRef}
															</p>
														) : null}
													</>
												),
											},
											{
												key: "worktree_mode",
												label: "任务工作区",
												summary: worktreeMode,
												content: (
													<>
														<div>
															<span className="text-[11px] text-text-secondary block mb-1">
																Task workspace
															</span>
															<TaskWorktreeModeControl
																value={worktreeMode}
																onChange={onWorktreeModeChange}
																idPrefix="task-create-worktree-mode"
															/>
														</div>
													</>
												),
											},
											{
												key: "base_ref",
												label: "基础分支",
												summary: branchRef,
												content: (
													<>
														<div>
															<span className="text-[11px] text-text-secondary block mb-1">
																{worktreeMode === "branch" ? "Create worktree from" : "Task base ref"}
															</span>
															<BranchSelectDropdown
																options={effectiveBranchOptions}
																selectedValue={branchRef}
																onSelect={onBranchRefChange}
																fill
																size="sm"
																emptyText="No branches detected"
															/>
															{/* 记住上次的选择会让默认值悄悄偏离仓库默认分支——那正是这条提示存在的理由：
							    被记住这件事必须看得见，而且要能一键退出。两条提示都只在**建卡**模式、且下拉框
							    当前显示的正是那个自动解析出来的值时才成立；编辑既有卡片显示的是那张卡自己的
							    baseRef、用户手动改过之后显示的是他自己的选择，那两种情况下把它说成
							    「记住的 / 回落的结果」都是在撒谎。 */}
															{isShowingDiscardedRememberedTaskCreateBaseRefHint ? (
																<p className="text-[11px] text-text-tertiary mt-1">
																	Last used{" "}
																	<code className="text-text-secondary">
																		{rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists}
																	</code>{" "}
																	for this project, but that branch no longer exists — fell back to{" "}
																	<code className="text-text-secondary">{branchRef}</code>.
																</p>
															) : isShowingRememberedTaskCreateBaseRefHint ? (
																<p className="text-[11px] text-text-tertiary mt-1">
																	Remembered from the last task you created in this project.{" "}
																	<button
																		type="button"
																		className="underline underline-offset-2 hover:text-text-secondary"
																		onClick={() =>
																			onBranchRefChange(repositoryDefaultBranchRef ?? "")
																		}
																	>
																		Use {repositoryDefaultBranchRef} instead
																	</button>
																</p>
															) : null}
														</div>
													</>
												),
											},
										]}
									/>
									{onAgentIdChange && onClineSettingsChange ? (
										<TaskAgentModelPicker
											renderControls={({ agentSelection, modelSelection }) => (
												<TaskEditorSettingGroup
													title="Agent 与上下文"
													settings={[
														{
															key: "agent",
															label: "Agent",
															summary: agentId ?? defaultAgentId ?? "默认",
															content: agentSelection,
														},
														{
															key: "model",
															label: "模型与参数",
															summary: terminalAgentModelOverrideSettings?.modelId ?? "默认",
															content: modelSelection,
														},
														{
															key: "session_initialization",
															label: "会话上下文",
															content: (
																<>
																	{mode === "single" && onTaskAgentSessionInitializationChange ? (
																		<TaskAgentSessionInitializationControl
																			agentId={agentId}
																			defaultAgentId={defaultAgentId}
																			workspaceId={targetWorkspaceId}
																			value={taskAgentSessionInitialization}
																			onChange={onTaskAgentSessionInitializationChange}
																			onAgentIdChange={onAgentIdChange}
																		/>
																	) : null}
																</>
															),
														},
													]}
												/>
											)}
											agentId={agentId}
											onAgentIdChange={onAgentIdChange}
											clineSettings={clineSettings}
											onClineSettingsChange={onClineSettingsChange}
											terminalAgentModelOverrideSettings={terminalAgentModelOverrideSettings}
											onTerminalAgentModelOverrideSettingsChange={onTerminalAgentModelOverrideSettingsChange}
											agentOptions={agentOptions}
											clineProviderOptions={clineProviderOptions}
											clineModelOptions={clineModelOptions}
											terminalAgentModelOptions={terminalAgentModelOptions}
											terminalAgentDefaultModelId={terminalAgentDefaultModelId}
											effectiveDefaultModelId={effectiveDefaultModelId}
											providerModels={providerModels}
											isLoadingProviders={isLoadingProviders}
											isLoadingModels={isLoadingModels}
											isLoadingTerminalAgentModels={isLoadingTerminalAgentModels}
											defaultAgentId={defaultAgentId}
											defaultProviderId={defaultProviderId}
											defaultReasoningEffort={defaultReasoningEffort}
											providerDefaultModels={providerDefaultModels}
										/>
									) : null}
									<TaskEditorSettingGroup
										title="运行方式"
										settings={[
											{
												key: "plan_mode",
												label: "Plan Mode",
												summary: startInPlanMode ? "开启" : "关闭",
												content: (
													<>
														<label
															htmlFor={startInPlanModeId}
															className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
														>
															<RadixCheckbox.Root
																id={startInPlanModeId}
																checked={startInPlanMode}
																onCheckedChange={(checked) => onStartInPlanModeChange(checked === true)}
																disabled={startInPlanModeDisabled}
																className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
															>
																<RadixCheckbox.Indicator>
																	<Check size={10} className="text-white" />
																</RadixCheckbox.Indicator>
															</RadixCheckbox.Root>
															Start in plan mode
														</label>
													</>
												),
											},
											{
												key: "conversation_mode",
												label: "会话模式",
												summary: taskConversationMode,
												content: (
													<>
														<div>
															{/* 会话模式声明（蓝图 §A.1）：探索会话的结构与结论本身是资产——默认展开
							    session map 面板、agent 经指令文件维护 map。快照语义：只影响下一次启动，
							    活会话不热切换。与「Start in plan mode」/权限档位都是正交轴。 */}
															<span className="text-[11px] text-text-secondary block mb-1">
																Session mode
															</span>
															<TaskConversationModeControl
																value={taskConversationMode}
																onChange={onTaskConversationModeChange}
																idPrefix="task-editor-conversation-mode"
															/>
															{taskConversationMode === "exploratory" ? (
																<p className="text-[11px] text-text-tertiary mt-1">
																	For research and exploration — the agent keeps a session map of
																	milestones and findings. Applies to the next session start.
																</p>
															) : null}
														</div>
													</>
												),
											},
											{
												key: "permissions",
												label: "Agent 权限",
												summary: taskAgentPermissionMode,
												content: (
													<>
														<div>
															{/* 权限档位与「Start in plan mode」是两条正交轴：plan 只决定开局先只读规划，
							    不影响这里选定的放权程度（不能同时表达两者的 agent 会在选项 tooltip 里明示）。
							    少数 harness（droid）把两条轴压在同一个单轴设置上，plan 起步会吃掉权限档——
							    所以必须把 startInPlanMode 一并传下去，让控件当场把这个冲突说出来。 */}
															<span className="text-[11px] text-text-secondary block mb-1">
																Agent permissions
															</span>
															<TaskAgentPermissionModeControl
																value={taskAgentPermissionMode}
																onChange={onTaskAgentPermissionModeChange}
																selectedAgentId={effectiveTaskAgentPermissionModeAgentId}
																selectedAgentLabel={effectiveTaskAgentPermissionModeAgentLabel}
																startInPlanMode={startInPlanMode}
																idPrefix="task-create-agent-permission-mode"
															/>
														</div>
													</>
												),
											},
										]}
									/>
									<TaskEditorSettingGroup
										title="自动评审"
										settings={[
											{
												key: "auto_review_enabled",
												label: "自动评审",
												summary: autoReviewEnabled ? "开启" : "关闭",
												content: (
													<label
														htmlFor={autoReviewEnabledId}
														className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
													>
														<RadixCheckbox.Root
															id={autoReviewEnabledId}
															checked={autoReviewEnabled}
															onCheckedChange={(checked) => onAutoReviewEnabledChange(checked === true)}
															className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
														>
															<RadixCheckbox.Indicator>
																<Check size={10} className="text-white" />
															</RadixCheckbox.Indicator>
														</RadixCheckbox.Root>
														Automatically
													</label>
												),
											},
											{
												key: "auto_review_mode",
												label: "收尾方式",
												summary: autoReviewMode,
												content: (
													<NativeSelect
														size="sm"
														value={autoReviewMode}
														onChange={(e) =>
															onAutoReviewModeChange(e.currentTarget.value as TaskAutoReviewMode)
														}
														style={{ width: "16ch", maxWidth: "100%" }}
													>
														{AUTO_REVIEW_MODE_OPTIONS.map((option) => (
															<option key={option.value} value={option.value}>
																{option.label}
															</option>
														))}
													</NativeSelect>
												),
											},
										]}
									/>
								</div>
							</div>
							{mode === "single" && workspaceId ? (
								<TaskEditorSettingGroup
									className="mt-5"
									title="任务关系"
									settings={[
										{
											key: "relations",
											label: "关系建模",
											content: (
												<ReferenceRelationModelingEditor
													key={workspaceId}
													controller={relationModeling}
													clipboardSelectionRequest={clipboardTaskReference.selectionRequest}
													workspaceId={workspaceId}
													taskId={taskEditorMode === "edit" ? editingTaskId : null}
													rootTitle={taskName || "待创建任务"}
													onUnstagedFormChange={setHasUnstagedRelationForm}
													creationInFlight={isRelationAwareCreationInFlight}
												/>
											),
										},
									]}
								/>
							) : null}
							<TaskEditorHiddenSettingsManager
								settings={[
									{ key: "project", label: "所属项目" },
									{ key: "worktree_mode", label: "任务工作区" },
									{ key: "base_ref", label: "基础分支" },
									{ key: "agent", label: "Agent" },
									{ key: "model", label: "模型与参数" },
									{ key: "session_initialization", label: "会话上下文" },
									{ key: "plan_mode", label: "Plan Mode" },
									{ key: "conversation_mode", label: "会话模式" },
									{ key: "permissions", label: "Agent 权限" },
									{ key: "auto_review_enabled", label: "自动评审" },
									{ key: "auto_review_mode", label: "收尾方式" },
									{ key: "relations", label: "关系建模" },
								]}
							/>
						</fieldset>
					</DialogBody>

					{relationAwareCreationError ? (
						<p role="alert" className="px-4 py-2 text-xs text-status-orange">
							{relationAwareCreationError}
						</p>
					) : null}
					{isRelationAwareCreationInFlight ? (
						<p role="status" className="px-4 py-2 text-xs text-text-secondary">
							正在分析项目归属或保存任务…
						</p>
					) : null}
					<DialogFooter>
						{taskEditorMode === "create" ? (
							<label
								htmlFor={createMoreId}
								className="mr-auto flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
							>
								<RadixSwitch.Root
									id={createMoreId}
									checked={createMore}
									onCheckedChange={setCreateMore}
									className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer"
								>
									<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
								</RadixSwitch.Root>
								<span>Create more</span>
							</label>
						) : (
							<span className="mr-auto" />
						)}
						{mode === "single" ? (
							<>
								<Button
									size="sm"
									onClick={handleCreateSingle}
									disabled={
										!hasPromptDraftContent ||
										!branchRef ||
										isTaskCreationWaitingForRelationDraftHydration ||
										isRelationAwareCreationInFlight
									}
								>
									<span className="inline-flex items-center">
										{taskEditorMode === "edit" ? "保存更改" : "创建任务"}
										<ButtonShortcut />
									</span>
								</Button>
								{onCreateAndStart ? (
									<DropdownMenu.Root>
										<div className="inline-flex items-center">
											<Button
												variant="primary"
												size="sm"
												onClick={() => handleRunSingleStartAction(primaryStartAction)}
												disabled={
													!hasPromptDraftContent ||
													!branchRef ||
													isTaskCreationWaitingForRelationDraftHydration ||
													isRelationAwareCreationInFlight
												}
												className={onCreateStartAndOpen ? "rounded-r-none" : undefined}
											>
												<span className="inline-flex items-center">
													{primaryStartLabel}
													<ButtonShortcut includeShift modifier={primaryStartShortcutModifier} />
												</span>
											</Button>
											{onCreateStartAndOpen ? (
												<DropdownMenu.Trigger asChild>
													<Button
														variant="primary"
														size="sm"
														disabled={
															!hasPromptDraftContent ||
															!branchRef ||
															isTaskCreationWaitingForRelationDraftHydration ||
															isRelationAwareCreationInFlight
														}
														className="rounded-l-none border-l border-white/20 px-1"
														aria-label="More start options"
													>
														<ChevronDown size={12} />
													</Button>
												</DropdownMenu.Trigger>
											) : null}
										</div>
										<DropdownMenu.Portal>
											<DropdownMenu.Content
												side="bottom"
												align="end"
												sideOffset={4}
												className="z-50 rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
												onCloseAutoFocus={(event) => event.preventDefault()}
											>
												<DropdownMenu.Item
													className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-[12px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3 whitespace-nowrap"
													onSelect={() => handleRunSingleStartAction(secondaryStartAction)}
												>
													{secondaryStartLabel}
													<span
														className="inline-flex items-center gap-0.5 text-text-tertiary"
														aria-hidden
													>
														{secondaryStartShortcutModifier === "alt" ? (
															isMacPlatform ? (
																<Option size={10} />
															) : (
																<span className="text-[10px] font-medium leading-none">Alt</span>
															)
														) : (
															<Command size={10} />
														)}
														<ArrowBigUp size={10} />
														<CornerDownLeft size={10} />
													</span>
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Portal>
									</DropdownMenu.Root>
								) : null}
							</>
						) : (
							<>
								<Button size="sm" onClick={handleCreateAll} disabled={validTaskCount === 0 || !branchRef}>
									<span className="inline-flex items-center">
										Create {validTaskCount} {taskCountLabel}
										<ButtonShortcut />
									</span>
								</Button>
								{onCreateAndStartMultiple ? (
									<Button
										variant="primary"
										size="sm"
										onClick={handleCreateAndStartAll}
										disabled={validTaskCount === 0 || !branchRef}
									>
										<span className="inline-flex items-center">
											Start {validTaskCount} {taskCountLabel}
											<ButtonShortcut includeShift />
										</span>
									</Button>
								) : null}
							</>
						)}
					</DialogFooter>
				</TaskEditorSettingPresentationProvider>
			</TaskEditorFloatingWindow>
			<DiscardTaskCreateConfirmDialog
				open={isDiscardConfirmOpen}
				alreadyCreatedTaskId={relationModeling.draft.createdTaskId}
				onCancel={handleCancelDiscard}
				onConfirm={handleConfirmDiscard}
			/>
		</>
	);
}
