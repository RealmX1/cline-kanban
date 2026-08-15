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
	PencilLine,
	Plus,
	X,
} from "lucide-react";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import type { BranchSelectOption } from "@/components/branch-select-dropdown";
import { BranchSelectDropdown } from "@/components/branch-select-dropdown";
import { DiscardTaskCreateConfirmDialog } from "@/components/discard-task-create-confirm-dialog";
import {
	TaskAgentModelPicker,
	type TaskTerminalAgentModelOverrideSettingsChangeOptions,
	useTaskAgentModelPicker,
} from "@/components/task-agent-model-picker";
import { TaskAgentPermissionModeControl } from "@/components/task-agent-permission-mode-control";
import { TaskAgentSessionInitializationControl } from "@/components/task-agent-session-initialization-control";
import {
	type TaskEditDraftComparableValues,
	TaskEditDraftRecoveryNotice,
} from "@/components/task-edit-draft-recovery-notice";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { TaskWorktreeModeControl } from "@/components/task-worktree-mode-control";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import type { TaskEditDraft } from "@/hooks/task-edit-drafts";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeClineReasoningEffort,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";
import { useTaskCreateDialogPrimaryStartActionPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";
import type { TaskAutoReviewMode, TaskEditorSubmitOptions, TaskImage } from "@/types";
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
	/** 多任务模式下所有非空行 trim 后拼接；单任务模式为空串 */
	multiPromptContent: string;
	imageCount: number;
	startInPlanMode: boolean;
	taskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
	branchRef: string;
	worktreeMode: RuntimeTaskWorktreeMode;
	agentId: RuntimeAgentId | undefined;
	clineSettings: RuntimeTaskClineSettings | undefined;
	terminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
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
		current.multiPromptContent !== baseline.multiPromptContent ||
		current.imageCount !== baseline.imageCount ||
		current.startInPlanMode !== baseline.startInPlanMode ||
		current.taskAgentPermissionMode !== baseline.taskAgentPermissionMode ||
		current.autoReviewEnabled !== baseline.autoReviewEnabled ||
		current.autoReviewMode !== baseline.autoReviewMode ||
		current.branchRef !== baseline.branchRef ||
		current.worktreeMode !== baseline.worktreeMode ||
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
	open,
	onOpenChange,
	prompt,
	onPromptChange,
	images,
	onImagesChange,
	onCreate,
	onCreateAndStart,
	onCreateMultiple,
	onCreateAndStartMultiple,
	onCreateStartAndOpen,
	startInPlanMode,
	onStartInPlanModeChange,
	taskAgentPermissionMode,
	onTaskAgentPermissionModeChange,
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
	taskAgentSessionInitialization,
	onTaskAgentSessionInitializationChange,
	editingTaskId = null,
	editTaskFormSeededFromSavedDraftAt = null,
	onRevertEditTaskFormToSavedTaskContent,
	onAdoptPromotedTaskEditDraft,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	prompt: string;
	onPromptChange: (value: string) => void;
	images: TaskImage[];
	onImagesChange: Dispatch<SetStateAction<TaskImage[]>>;
	onCreate: (options?: TaskEditorSubmitOptions) => string | null;
	onCreateAndStart?: (options?: TaskEditorSubmitOptions) => string | null;
	onCreateMultiple: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	onCreateAndStartMultiple?: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	onCreateStartAndOpen?: (options?: TaskEditorSubmitOptions) => string | null;
	startInPlanMode: boolean;
	onStartInPlanModeChange: (value: boolean) => void;
	taskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	onTaskAgentPermissionModeChange: (value: RuntimeTaskAgentPermissionMode) => void;
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
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	onTaskAgentSessionInitializationChange?: (value: RuntimeTaskAgentSessionInitialization | undefined) => void;
	/** edit 模式下正在编辑的任务 id。草稿通知栏按它取这张卡片的落败副本。 */
	editingTaskId?: string | null;
	/** 值 = 铺表单用的那份草稿的 savedAt；null = 表单就是任务本体，通知栏那一条不出现。 */
	editTaskFormSeededFromSavedDraftAt?: number | null;
	onRevertEditTaskFormToSavedTaskContent?: () => void;
	onAdoptPromotedTaskEditDraft?: (promotedDraft: TaskEditDraft) => void;
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
		onImagesChange([]);
		setMode("single");
		setTaskPrompts([]);
		inputRefs.current = [];
		nextFocusIndexRef.current = null;
		setComposerResetKey((current) => current + 1);
	}, [onImagesChange, propagatePromptDraft]);

	const handleCreateSingle = useCallback(() => {
		const createdTaskId = onCreate({ keepDialogOpen: createMore, promptOverride: promptDraft });
		if (createMore && createdTaskId) {
			resetForCreateMore();
		}
	}, [createMore, onCreate, promptDraft, resetForCreateMore]);

	const handleCreateAndStartSingle = useCallback(() => {
		const createdTaskId = onCreateAndStart?.({ keepDialogOpen: createMore, promptOverride: promptDraft });
		if (createMore && createdTaskId) {
			resetForCreateMore();
		}
	}, [createMore, onCreateAndStart, promptDraft, resetForCreateMore]);

	const handleCreateStartAndOpenSingle = useCallback(() => {
		const createdTaskId = onCreateStartAndOpen?.({ keepDialogOpen: createMore, promptOverride: promptDraft });
		if (createMore && createdTaskId) {
			resetForCreateMore();
		}
	}, [createMore, onCreateStartAndOpen, promptDraft, resetForCreateMore]);

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

	const handleCreateAll = useCallback(() => {
		const validPrompts = getValidPrompts();
		if (validPrompts.length === 0) {
			return;
		}
		const createdTaskIds = onCreateMultiple(validPrompts, { keepDialogOpen: createMore });
		if (createMore && createdTaskIds.length > 0) {
			resetForCreateMore();
		}
	}, [createMore, getValidPrompts, onCreateMultiple, resetForCreateMore]);

	const handleCreateAndStartAll = useCallback(() => {
		const validPrompts = getValidPrompts();
		if (validPrompts.length === 0) {
			return;
		}
		const createdTaskIds = onCreateAndStartMultiple?.(validPrompts, { keepDialogOpen: createMore }) ?? [];
		if (createMore && createdTaskIds.length > 0) {
			resetForCreateMore();
		}
	}, [createMore, getValidPrompts, onCreateAndStartMultiple, resetForCreateMore]);

	const handleInputKeyDown = useCallback(
		(index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
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

	// Cmd/Ctrl+Enter (and Cmd/Ctrl+Shift+Enter) from anywhere in the dialog.
	useHotkeys(
		"mod+enter, mod+shift+enter",
		(event) => {
			if (mode === "multi") {
				if (event.shiftKey) {
					handleCreateAndStartAll();
					return;
				}
				handleCreateAll();
				return;
			}
			if (event.shiftKey) {
				handleRunSingleStartAction("start");
				return;
			}
			handleCreateSingle();
		},
		{
			enabled: open,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: (event) => {
				if (!event.defaultPrevented) return false;
				// Only skip when a textarea or input already handled the shortcut.
				// Radix checkbox also calls preventDefault() on Enter, but that
				// should not block the dialog-level shortcut.
				const tag = (event.target as HTMLElement).tagName?.toLowerCase();
				return tag === "textarea" || tag === "input";
			},
			preventDefault: true,
		},
		[open, mode, handleCreateAll, handleCreateAndStartAll, handleCreateSingle, handleRunSingleStartAction],
	);

	// Alt/Opt+Shift+Enter → Start & Open (single mode only)
	useHotkeys(
		"alt+shift+enter",
		() => {
			if (mode === "single") {
				handleRunSingleStartAction("start_and_open");
			}
		},
		{
			enabled: open && Boolean(onCreateStartAndOpen),
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[open, mode, handleRunSingleStartAction, onCreateStartAndOpen],
	);

	// 关闭守卫仅在 create 模式启用：edit 模式关闭是存草稿（handleCancelEditTask），
	// 不应弹「放弃」二次确认。
	const isCreateMode = taskEditorMode === "create";

	// 每次渲染刷新「当前表单」快照，供关闭时与打开时的基线比较。
	const currentFormSnapshot: TaskCreateFormSnapshot = {
		prompt: promptDraft,
		multiPromptContent: taskPrompts
			.map((value) => value.trim())
			.filter(Boolean)
			.join("\n"),
		imageCount: images.length,
		startInPlanMode,
		taskAgentPermissionMode,
		autoReviewEnabled,
		autoReviewMode,
		branchRef,
		worktreeMode,
		agentId,
		clineSettings,
		terminalAgentModelOverrideSettings,
	};
	const latestFormSnapshotRef = useRef(currentFormSnapshot);
	latestFormSnapshotRef.current = currentFormSnapshot;
	const baselineFormSnapshotRef = useRef<TaskCreateFormSnapshot | null>(null);

	// 打开那一刻捕获基线；关闭时清空。基线来自当次打开后 settle 的默认值。
	useEffect(() => {
		baselineFormSnapshotRef.current = open ? latestFormSnapshotRef.current : null;
	}, [open]);

	const handleCloseRequest = useCallback(() => {
		const baseline = baselineFormSnapshotRef.current;
		const hasEdits = baseline ? hasTaskCreateFormEdits(latestFormSnapshotRef.current, baseline) : false;
		if (hasEdits) {
			setIsDiscardConfirmOpen(true);
			return;
		}
		onOpenChange(false);
	}, [onOpenChange]);

	// X 关闭按钮走 Radix Close → onOpenChange(false)；Esc / 点击外部各自 preventDefault
	// 后也汇到这里。create 模式统一经 handleCloseRequest 守卫；edit 模式直通 base 语义。
	const handleDialogOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				onOpenChange(true);
				return;
			}
			if (isCreateMode) {
				handleCloseRequest();
				return;
			}
			onOpenChange(false);
		},
		[handleCloseRequest, isCreateMode, onOpenChange],
	);

	const handleConfirmDiscard = useCallback(() => {
		setIsDiscardConfirmOpen(false);
		onOpenChange(false);
	}, [onOpenChange]);

	const handleCancelDiscard = useCallback(() => {
		setIsDiscardConfirmOpen(false);
	}, []);

	const dialogTitle =
		taskEditorMode === "edit"
			? "Edit backlog task"
			: mode === "multi"
				? `New tasks${validTaskCount > 0 ? ` (${validTaskCount})` : ""}`
				: "New task";

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
			<Dialog
				open={open}
				onOpenChange={handleDialogOpenChange}
				contentClassName="max-w-2xl"
				onEscapeKeyDown={
					isCreateMode
						? (event) => {
								event.preventDefault();
								if (!isDiscardConfirmOpen) handleCloseRequest();
							}
						: undefined
				}
				onPointerDownOutside={
					isCreateMode
						? (event) => {
								event.preventDefault();
								if (!isDiscardConfirmOpen) handleCloseRequest();
							}
						: undefined
				}
			>
				<DialogHeader title={dialogTitle} icon={<PencilLine size={16} />} />
				<DialogBody>
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
							<TaskPromptComposer
								key={composerResetKey}
								value={promptDraft}
								onValueChange={setPromptDraft}
								onValueBlur={() => propagatePromptDraft(promptDraft)}
								images={images}
								onImagesChange={onImagesChange}
								onSubmit={handleCreateSingle}
								onSubmitAndStart={() => handleRunSingleStartAction("start")}
								placeholder="Describe the task..."
								autoFocus
								workspaceId={workspaceId}
								showAttachImageButton={false}
							/>
							<div className="flex items-center justify-between mt-1.5">
								<p className="text-[11px] text-text-tertiary">
									Use <code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">@file</code> to
									reference files. Drag and drop or{" "}
									<code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">
										{pasteShortcutLabel}
									</code>{" "}
									to add images.
								</p>
								{taskEditorMode === "create" && detectedItems.length >= 2 ? (
									<button
										type="button"
										onClick={handleSplitIntoTasks}
										className="inline-flex items-center gap-1.5 text-[12px] text-status-blue hover:text-[#86BEFF] cursor-pointer shrink-0"
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

					<div className="flex flex-col gap-2.5 mt-4 pt-4 border-t border-border">
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

						<div>
							{/* 权限档位与「Start in plan mode」是两条正交轴：plan 只决定开局先只读规划，
							    不影响这里选定的放权程度（不能同时表达两者的 agent 会在选项 tooltip 里明示）。
							    少数 harness（droid）把两条轴压在同一个单轴设置上，plan 起步会吃掉权限档——
							    所以必须把 startInPlanMode 一并传下去，让控件当场把这个冲突说出来。 */}
							<span className="text-[11px] text-text-secondary block mb-1">Agent permissions</span>
							<TaskAgentPermissionModeControl
								value={taskAgentPermissionMode}
								onChange={onTaskAgentPermissionModeChange}
								selectedAgentId={effectiveTaskAgentPermissionModeAgentId}
								selectedAgentLabel={effectiveTaskAgentPermissionModeAgentLabel}
								startInPlanMode={startInPlanMode}
								idPrefix="task-create-agent-permission-mode"
							/>
						</div>

						<div>
							<span className="text-[11px] text-text-secondary block mb-1">Task workspace</span>
							<TaskWorktreeModeControl
								value={worktreeMode}
								onChange={onWorktreeModeChange}
								idPrefix="task-create-worktree-mode"
							/>
						</div>

						<div>
							<span className="text-[11px] text-text-secondary block mb-1">
								{worktreeMode === "branch" ? "Create worktree from" : "Task base ref"}
							</span>
							<BranchSelectDropdown
								options={branchOptions}
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
										onClick={() => onBranchRefChange(repositoryDefaultBranchRef ?? "")}
									>
										Use {repositoryDefaultBranchRef} instead
									</button>
								</p>
							) : null}
						</div>

						<div className="flex items-center gap-2 flex-wrap">
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
							<NativeSelect
								size="sm"
								value={autoReviewMode}
								onChange={(e) => onAutoReviewModeChange(e.currentTarget.value as TaskAutoReviewMode)}
								style={{ width: "16ch", maxWidth: "100%" }}
							>
								{AUTO_REVIEW_MODE_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
						</div>

						{onAgentIdChange && onClineSettingsChange ? (
							<>
								<TaskAgentModelPicker
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
								{mode === "single" && onTaskAgentSessionInitializationChange ? (
									<TaskAgentSessionInitializationControl
										agentId={agentId}
										defaultAgentId={defaultAgentId}
										workspaceId={workspaceId}
										value={taskAgentSessionInitialization}
										onChange={onTaskAgentSessionInitializationChange}
										onAgentIdChange={onAgentIdChange}
									/>
								) : null}
							</>
						) : null}
					</div>
				</DialogBody>
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
							<Button size="sm" onClick={handleCreateSingle} disabled={!hasPromptDraftContent || !branchRef}>
								<span className="inline-flex items-center">
									{taskEditorMode === "edit" ? "Save changes" : "Create"}
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
											disabled={!hasPromptDraftContent || !branchRef}
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
													disabled={!hasPromptDraftContent || !branchRef}
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
												<span className="inline-flex items-center gap-0.5 text-text-tertiary" aria-hidden>
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
			</Dialog>
			<DiscardTaskCreateConfirmDialog
				open={isDiscardConfirmOpen}
				onCancel={handleCancelDiscard}
				onConfirm={handleConfirmDiscard}
			/>
		</>
	);
}
