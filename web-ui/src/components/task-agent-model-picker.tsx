import * as Collapsible from "@radix-ui/react-collapsible";
import {
	getRuntimeAgentCatalogEntry,
	getRuntimeLaunchSupportedAgentCatalog,
	KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID,
} from "@runtime-agent-catalog";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getAgentVisual } from "@/components/agent-visual";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { subscribeCodexConfigurationSyncUpdated } from "@/runtime/codex-configuration-sync-query";
import { fetchTerminalAgentModelSelectionOptions } from "@/runtime/runtime-config-query";
import { readTaskAgentModelListCache, writeTaskAgentModelListCache } from "@/runtime/task-agent-model-list-cache";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTerminalAgentModelSelectionAgentId,
	RuntimeTerminalAgentModelSelectionGroup,
	RuntimeTerminalAgentModelSelectionOptionsResponse,
} from "@/runtime/types";
import { subscribeToTaskVisualizationBrowserEvents } from "@/stores/task-visualization-browser-bridge";

/** One agent icon-button option. `installed` gates grey-out: only `false` greys out (click opens install guide). */
export interface TaskAgentPickerAgentOption {
	value: string;
	label: string;
	/** From RuntimeAgentDefinition.installed. null/undefined (config not loaded / unknown agent) render normally. */
	installed?: boolean | null;
}

/** One terminal-agent model button option. `description` is the concrete model-id shown in the hover tooltip. */
export interface TaskAgentPickerTerminalModelOption {
	value: string;
	label: string;
	description?: string;
	/**
	 * 决定渲染在哪一档：`latest_tracking_alias`（永远可见的别名行）还是 `pinned_version`
	 * （默认收起的具体版本行）。缺省视作别名，于是 codex / cursor 与升级前的缓存条目都照旧单行渲染。
	 */
	modelSelectionGroup?: RuntimeTerminalAgentModelSelectionGroup;
}

/** 收起组里没有条目时（codex / cursor / 降级 fallback）不渲染展开触发器，UI 与改动前完全一致。 */
function isPinnedVersionModelOption(option: TaskAgentPickerTerminalModelOption): boolean {
	return option.modelSelectionGroup === "pinned_version";
}

/**
 * 判定一条 localStorage 缓存是否写于 `modelSelectionGroup` 引入之前。
 *
 * 后端保证「每个 option 都带分档」（`deduplicateModelOptions` 对 codex / cursor 这类不区分档位的
 * 解析结果缺省补 `latest_tracking_alias`），所以「有 option 却无一条带分档」只可能来自旧版本写下的
 * 响应。这类缓存的标签停留在改动前的错标状态（`opus` 标成 "Opus 4.8"，而它实跑的是最新 Opus），
 * 必须当作 cache miss 丢弃，否则升级用户首屏又会看到错标 chip、且 pinned 折叠区恒为空。
 *
 * 判据刻意是「无一条带分档」而不是「存在某条缺分档」：后者会把 codex / cursor 的合法响应
 * （历史上整份都不带该字段）永久判成过期，缓存再也 seed 不了。
 */
function isTaskAgentModelCacheWrittenBeforeModelSelectionGroup(
	response: RuntimeTerminalAgentModelSelectionOptionsResponse,
): boolean {
	return response.options.length > 0 && !response.options.some((option) => option.modelSelectionGroup);
}

/** 别名行与「具体版本」收起行渲染的是同一种 chip，抽出来避免两处各维护一份样式与选中态。 */
function TerminalAgentModelOptionButton({
	option,
	isSelected,
	disabled,
	onSelect,
}: {
	option: TaskAgentPickerTerminalModelOption;
	isSelected: boolean;
	disabled: boolean;
	onSelect: (option: TaskAgentPickerTerminalModelOption) => void;
}): ReactElement {
	return (
		<Tooltip content={option.description ?? option.label}>
			<button
				type="button"
				aria-label={option.label}
				aria-pressed={isSelected}
				className={cn(
					"inline-flex h-8 items-center justify-center rounded-md border px-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-1 focus:ring-offset-surface-0",
					isSelected
						? "border-accent bg-accent/10 text-text-primary"
						: "border-border-bright bg-surface-2 text-text-secondary hover:border-border-focus hover:bg-surface-3 hover:text-text-primary",
				)}
				disabled={disabled}
				onClick={() => onSelect(option)}
			>
				{option.label}
			</button>
		</Tooltip>
	);
}

/** Stable empty default so the agentOptions memo doesn't rebuild when no agents prop is passed. */
const EMPTY_AGENT_DEFINITIONS: RuntimeAgentDefinition[] = [];

// ---------------------------------------------------------------------------
// 维护各 CLI Agent 的模型列表与选择状态。
// ---------------------------------------------------------------------------

export interface UseTaskAgentModelPickerInput {
	active: boolean;
	workspaceId: string | null;
	agentId: RuntimeAgentId | undefined;
	/** Agent definitions from runtimeConfig.agents — carries `installed` for grey-out of not-installed agents. */
	agents?: RuntimeAgentDefinition[];
	/** 给出时，选择器只展示这些 Agent。缺省仍使用完整可启动目录。 */
	selectableAgentIds?: readonly RuntimeAgentId[];
	/** The default agent ID from runtimeConfig.selectedAgentId — used to build the first option label */
	defaultAgentId?: RuntimeAgentId | null;
}

export interface UseTaskAgentModelPickerResult {
	terminalAgentModelCatalog: RuntimeTerminalAgentModelSelectionOptionsResponse | null;
	terminalAgentModelCatalogWarning: string | null;
	retryTerminalAgentModelCatalog: () => void;
	agentOptions: TaskAgentPickerAgentOption[];
	terminalAgentModelOptions: TaskAgentPickerTerminalModelOption[];
	terminalAgentDefaultModelId: string | null;
	isLoadingTerminalAgentModels: boolean;
}

export interface TaskTerminalAgentModelOverrideSettingsChangeOptions {
	rememberSelectionForFutureCreateTasks?: boolean;
}

function isTerminalAgentModelSelectionAgentId(
	agentId: RuntimeAgentId | null | undefined,
): agentId is RuntimeTerminalAgentModelSelectionAgentId {
	return (
		agentId === "claude" || agentId === "codex" || agentId === "cursor" || agentId === "kimi" || agentId === "omp"
	);
}

function getFallbackTerminalAgentDefaultModelOption(agentId: RuntimeTerminalAgentModelSelectionAgentId): {
	value: string;
	label: string;
	defaultModelId: string | null;
} {
	if (agentId === "cursor") {
		return {
			// 标签刻意不含版本号：这是「后端探测结果回来之前」的占位，写死版本号只会在上游发新代次时说谎。
			// 真实标签由后端从 `cursor-agent --list-models` 解析出来后覆盖。
			value: "",
			label: "Default · Cursor Grok",
			defaultModelId: KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID,
		};
	}
	return {
		value: "",
		label: "Default",
		defaultModelId: null,
	};
}

export function useTaskAgentModelPicker({
	active,
	workspaceId,
	agentId,
	agents,
	selectableAgentIds,
	defaultAgentId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const [terminalAgentModelOptions, setTerminalAgentModelOptions] = useState<TaskAgentPickerTerminalModelOption[]>([]);
	const [terminalAgentDefaultModelId, setTerminalAgentDefaultModelId] = useState<string | null>(null);
	const [isLoadingTerminalAgentModels, setIsLoadingTerminalAgentModels] = useState(false);
	const [terminalAgentModelCatalog, setTerminalAgentModelCatalog] =
		useState<RuntimeTerminalAgentModelSelectionOptionsResponse | null>(null);
	const [terminalAgentModelCatalogWarning, setTerminalAgentModelCatalogWarning] = useState<string | null>(null);
	const [terminalAgentModelCatalogRetryGeneration, setTerminalAgentModelCatalogRetryGeneration] = useState(0);
	const retryTerminalAgentModelCatalog = useCallback(
		() => setTerminalAgentModelCatalogRetryGeneration((generation) => generation + 1),
		[],
	);

	// Derive the effective agent: explicit override takes precedence, then the global default
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;

	useEffect(() => {
		if (!active || !isTerminalAgentModelSelectionAgentId(effectiveAgentId)) {
			setTerminalAgentModelCatalog(null);
			setTerminalAgentModelCatalogWarning(null);
			setTerminalAgentModelOptions([]);
			setTerminalAgentDefaultModelId(null);
			setIsLoadingTerminalAgentModels(false);
			return;
		}
		let cancelled = false;
		const fallbackDefaultOption = getFallbackTerminalAgentDefaultModelOption(effectiveAgentId);
		const cacheKey = `terminal:${effectiveAgentId}`;

		// Response → {default option + explicit options} transform, shared by cache-seed and fetch-success.
		const applyResponse = (response: RuntimeTerminalAgentModelSelectionOptionsResponse) => {
			setTerminalAgentModelCatalog(response);
			const defaultOption: TaskAgentPickerTerminalModelOption = {
				value: "",
				label: response.defaultLabel || fallbackDefaultOption.label,
				modelSelectionGroup: "latest_tracking_alias",
			};
			const explicitOptions = response.options
				.filter((option) => option.modelId.trim().length > 0)
				// Kimi 的空值表示自动跟随；同名的具体版本仍须可独立固定。
				// Codex 的 defaultModelId 只用来识别原生默认模型的推理档位。Default 芯片仍表示不传 --model，
				// 所以同名模型必须留在列表里，允许单独钉死。
				.filter(
					(option) =>
						effectiveAgentId === "kimi" ||
						effectiveAgentId === "codex" ||
						option.modelId !== response.defaultModelId,
				)
				.map<TaskAgentPickerTerminalModelOption>((option) => ({
					value: option.modelId,
					label: option.label || option.modelId,
					...(option.description ? { description: option.description } : {}),
					...(option.modelSelectionGroup ? { modelSelectionGroup: option.modelSelectionGroup } : {}),
				}));
			setTerminalAgentDefaultModelId(response.defaultModelId);
			setTerminalAgentModelOptions([defaultOption, ...explicitOptions]);
		};

		const cachedResponse = readTaskAgentModelListCache<RuntimeTerminalAgentModelSelectionOptionsResponse>(cacheKey);
		// 只有「真实成功探测 + 带分档」的缓存才配 seed，其余一律降级成 cache miss（`cached = null`），
		// 这样下面的 warning 分支与 .catch 分支也会把降级响应 apply 出来，而不是把旧内容一直挂在界面上：
		//   - 带 warning 的历史缓存是修复前被降级 fallback 污染的结果（列表退化为单条 Default）；
		//   - 无分档的历史缓存写于 `modelSelectionGroup` 引入之前，标签停在错标状态（`opus` → "Opus 4.8"）。
		// 两者都改显示 fallbackDefaultOption 等首次成功探测覆盖，让旧污染不必等下次成功即自愈。
		const cached =
			cachedResponse &&
			!cachedResponse.warning &&
			!isTaskAgentModelCacheWrittenBeforeModelSelectionGroup(cachedResponse)
				? cachedResponse
				: null;
		if (cached) {
			applyResponse(cached);
		} else {
			setTerminalAgentModelCatalog(null);
			setTerminalAgentModelOptions([fallbackDefaultOption]);
			setTerminalAgentDefaultModelId(fallbackDefaultOption.defaultModelId);
		}
		setIsLoadingTerminalAgentModels(true);
		setTerminalAgentModelCatalogWarning(null);
		let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
		let recoveryAttemptCount = 0;
		let catalogRequestInFlight = false;
		const scheduleRecovery = () => {
			if (effectiveAgentId === "codex" && recoveryAttemptCount < 3) {
				recoveryTimer = setTimeout(
					() => {
						recoveryAttemptCount++;
						requestCatalog();
					},
					2_000 * 2 ** recoveryAttemptCount,
				);
			}
		};
		const requestCatalog = () => {
			if (cancelled || catalogRequestInFlight) return;
			catalogRequestInFlight = true;
			setIsLoadingTerminalAgentModels(true);
			void fetchTerminalAgentModelSelectionOptions(workspaceId, effectiveAgentId)
				.then((response) => {
					if (cancelled) {
						return;
					}
					// 后端 CLI 探测失败会 resolve 成带 warning 的 fallback 响应（列表退化为单条 Default），而非 reject——
					// 因此下面的 .catch 对这类最常见失败永不触发。这种降级结果绝不能写回 localStorage，否则一次
					// `claude --help` 抖动就把好端端的 opus/sonnet/haiku/fable 列表污染成单条 Default 并跨会话持久化。
					// 已有可用缓存时保留旧列表、不覆盖显示；仅真实成功响应才 apply + 落盘。
					if (response.warning) {
						setTerminalAgentModelCatalogWarning(response.warning);
						scheduleRecovery();
						if (!cached) {
							applyResponse(response);
						}
						return;
					}
					applyResponse(response);
					setTerminalAgentModelCatalogWarning(null);
					writeTaskAgentModelListCache(cacheKey, response);
				})
				.catch(() => {
					if (!cancelled) {
						setTerminalAgentModelCatalogWarning("模型目录暂不可读");
						scheduleRecovery();
					}
					if (cancelled || cached) {
						return; // Keep the cached list on failure rather than clearing it.
					}
					setTerminalAgentModelOptions([fallbackDefaultOption]);
					setTerminalAgentDefaultModelId(fallbackDefaultOption.defaultModelId);
				})
				.finally(() => {
					catalogRequestInFlight = false;
					if (!cancelled) {
						setIsLoadingTerminalAgentModels(false);
					}
				});
		};
		requestCatalog();
		const recoverAfterConnectionRestored = () => {
			recoveryAttemptCount = 0;
			clearTimeout(recoveryTimer);
			requestCatalog();
		};
		const recoverWhenVisible = () => {
			if (document.visibilityState === "visible") recoverAfterConnectionRestored();
		};
		const unsubscribeRuntimeReconnected =
			effectiveAgentId === "codex"
				? subscribeCodexConfigurationSyncUpdated((reason) => {
						if (reason === "runtime_reconnected") recoverAfterConnectionRestored();
					})
				: undefined;
		const unsubscribeStreamReconnected =
			effectiveAgentId === "codex"
				? subscribeToTaskVisualizationBrowserEvents((event) => {
						if (event.type === "stream_reconnected" && event.workspaceId === workspaceId)
							recoverAfterConnectionRestored();
					})
				: undefined;
		if (effectiveAgentId === "codex") {
			window.addEventListener("online", recoverAfterConnectionRestored);
			document.addEventListener("visibilitychange", recoverWhenVisible);
		}
		return () => {
			cancelled = true;
			clearTimeout(recoveryTimer);
			unsubscribeRuntimeReconnected?.();
			unsubscribeStreamReconnected?.();
			window.removeEventListener("online", recoverAfterConnectionRestored);
			document.removeEventListener("visibilitychange", recoverWhenVisible);
		};
	}, [active, effectiveAgentId, workspaceId, terminalAgentModelCatalogRetryGeneration]);

	// Derive the effective provider: explicit override takes precedence, then the global default
	const agentOptions = useMemo<TaskAgentPickerAgentOption[]>(() => {
		const selectableAgentIdSet = selectableAgentIds ? new Set(selectableAgentIds) : null;
		const catalog = getRuntimeLaunchSupportedAgentCatalog().filter(
			(agent) => !selectableAgentIdSet || selectableAgentIdSet.has(agent.id),
		);
		const installedByAgentId = new Map(
			(agents ?? EMPTY_AGENT_DEFINITIONS).map((agent) => [agent.id, agent.installed]),
		);
		// 安装状态来自后端检测；尚未加载或未知的 Agent 不作未安装处理。
		const resolveInstalled = (id: RuntimeAgentId): boolean | null => installedByAgentId.get(id) ?? null;
		let firstLabel = "Default";
		if (defaultAgentId) {
			const defaultAgent = catalog.find((a) => a.id === defaultAgentId);
			if (defaultAgent) {
				firstLabel = defaultAgent.label;
			}
		}
		return [
			{ value: "", label: firstLabel, installed: defaultAgentId ? resolveInstalled(defaultAgentId) : null },
			// Exclude the default agent from the explicit list — it's already represented by the first option
			...catalog
				.filter((agent) => agent.id !== defaultAgentId)
				.map((agent) => ({ value: agent.id, label: agent.label, installed: resolveInstalled(agent.id) })),
		];
	}, [agents, defaultAgentId, selectableAgentIds]);

	return {
		terminalAgentModelCatalog,
		terminalAgentModelCatalogWarning,
		retryTerminalAgentModelCatalog,
		agentOptions,
		terminalAgentModelOptions,
		terminalAgentDefaultModelId,
		isLoadingTerminalAgentModels,
	};
}

export function TaskAgentModelPicker({
	renderControls,
	agentId,
	onAgentIdChange,
	terminalAgentModelOverrideSettings,
	onTerminalAgentModelOverrideSettingsChange,
	agentOptions,
	terminalAgentModelOptions = [],
	terminalAgentDefaultModelId = null,
	isLoadingTerminalAgentModels = false,
	defaultAgentId,
}: {
	renderControls?: (controls: { agentSelection: ReactNode; modelSelection: ReactNode }) => ReactNode;
	agentId: RuntimeAgentId | undefined;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	onTerminalAgentModelOverrideSettingsChange?: (
		value: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
		options?: TaskTerminalAgentModelOverrideSettingsChangeOptions,
	) => void;
	agentOptions: TaskAgentPickerAgentOption[];
	terminalAgentModelOptions?: TaskAgentPickerTerminalModelOption[];
	terminalAgentDefaultModelId?: string | null;
	isLoadingTerminalAgentModels?: boolean;
	/** runtimeConfig 的默认 Agent，用于解析继承选择。 */
	defaultAgentId?: RuntimeAgentId | null;
}): ReactElement {
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;
	const showTerminalAgentModelPicker = isTerminalAgentModelSelectionAgentId(effectiveAgentId);
	const handleAgentIconSelection = useCallback(
		(optionValue: string, isSelectedAgentOption: boolean) => {
			if (isSelectedAgentOption) {
				return;
			}
			onAgentIdChange(optionValue ? (optionValue as RuntimeAgentId) : undefined);
			const nextEffectiveAgentId = (optionValue || defaultAgentId || null) as RuntimeAgentId | null;
			if (
				terminalAgentModelOverrideSettings !== undefined &&
				terminalAgentModelOverrideSettings.agentId !== nextEffectiveAgentId
			) {
				onTerminalAgentModelOverrideSettingsChange?.(undefined, {
					rememberSelectionForFutureCreateTasks: false,
				});
			}
		},
		[defaultAgentId, onAgentIdChange, onTerminalAgentModelOverrideSettingsChange, terminalAgentModelOverrideSettings],
	);

	const selectedTerminalAgentModelId =
		isTerminalAgentModelSelectionAgentId(effectiveAgentId) &&
		terminalAgentModelOverrideSettings?.agentId === effectiveAgentId &&
		// Codex 的 defaultModelId 是原生默认模型，只用于推理档位；与 Kimi 一样，同名钉选不能被收成 Default。
		(effectiveAgentId === "kimi" ||
			effectiveAgentId === "codex" ||
			terminalAgentModelOverrideSettings.modelId !== terminalAgentDefaultModelId)
			? terminalAgentModelOverrideSettings.modelId
			: "";

	// 「已选中但已不在返回列表里」的 model id 补成一颗额外 chip。
	// 后端按「每条产品线只显示最新一代」收窄了列表，所以钉在旧代次（如 cursor-grok-4.5-high）的卡片
	// 一定会落在列表之外；不补这颗 chip，界面上看起来就像选择丢了——而卡片实际仍会用那个模型启动。
	// claude 侧靠 "Pinned versions" 折叠区自动展开解决了同类问题，cursor / codex / kimi 没有对应机制。
	const terminalAgentModelOptionsIncludingSelected = useMemo(() => {
		if (
			!selectedTerminalAgentModelId ||
			terminalAgentModelOptions.some((option) => option.value === selectedTerminalAgentModelId)
		) {
			return terminalAgentModelOptions;
		}
		return [
			...terminalAgentModelOptions,
			{ value: selectedTerminalAgentModelId, label: selectedTerminalAgentModelId },
		];
	}, [selectedTerminalAgentModelId, terminalAgentModelOptions]);

	// 别名（含 Default 占位）常驻第一行；钉版本项进入默认收起的第二行。
	const latestTrackingAliasModelOptions = useMemo(
		() => terminalAgentModelOptionsIncludingSelected.filter((option) => !isPinnedVersionModelOption(option)),
		[terminalAgentModelOptionsIncludingSelected],
	);
	const pinnedVersionModelOptions = useMemo(
		() => terminalAgentModelOptionsIncludingSelected.filter(isPinnedVersionModelOption),
		[terminalAgentModelOptionsIncludingSelected],
	);
	const [isPinnedVersionGroupOpen, setIsPinnedVersionGroupOpen] = useState(false);
	// 选中项落在收起组里时（例如上次选的是 Opus 4.8）必须自动展开，否则选中的 chip 不可见、
	// 看上去像是选择丢了。只负责「打开」，用户之后仍可手动收起。
	const isSelectedTerminalAgentModelPinned = pinnedVersionModelOptions.some(
		(option) => option.value === selectedTerminalAgentModelId,
	);
	useEffect(() => {
		if (isSelectedTerminalAgentModelPinned) {
			setIsPinnedVersionGroupOpen(true);
		}
	}, [isSelectedTerminalAgentModelPinned]);

	const selectTerminalAgentModelOption = useCallback(
		(option: TaskAgentPickerTerminalModelOption) => {
			if (!isTerminalAgentModelSelectionAgentId(effectiveAgentId)) {
				return;
			}
			if (!option.value) {
				onTerminalAgentModelOverrideSettingsChange?.(undefined);
				return;
			}
			onTerminalAgentModelOverrideSettingsChange?.({ agentId: effectiveAgentId, modelId: option.value });
		},
		[effectiveAgentId, onTerminalAgentModelOverrideSettingsChange],
	);

	const agentSelection = (
		<>
			<div className="flex flex-col gap-1">
				<span className="text-[11px] text-text-secondary">Agent</span>
				<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Agent">
					{agentOptions.map((option) => {
						const iconAgentId = (option.value || defaultAgentId || undefined) as RuntimeAgentId | undefined;
						const agentVisual = getAgentVisual(iconAgentId);
						const AgentIcon = agentVisual.Icon;
						const isSelectedAgentOption =
							option.value === ""
								? agentId === undefined || agentId === defaultAgentId
								: agentId === option.value;
						// installed === false → not installed: grey base, light up on hover, click opens the
						// install guide instead of selecting. null/true (unknown or installed) render normally.
						const isNotInstalled = option.installed === false;
						const agentButtonAccessibleName = option.value ? option.label : `${option.label} (default agent)`;
						const agentButtonTooltip = isNotInstalled
							? `${option.label} · not installed — click to open the install guide`
							: option.label;

						return (
							<Tooltip key={option.value || "default-agent"} content={agentButtonTooltip}>
								<button
									type="button"
									aria-label={agentButtonAccessibleName}
									aria-pressed={isSelectedAgentOption}
									className={cn(
										"inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-1 focus:ring-offset-surface-0",
										// isNotInstalled takes precedence over isSelectedAgentOption: a not-installed
										// agent can still be the selected option (default agent, or a saved agentId
										// whose binary isn't present) but must never show the accent selected state —
										// it isn't a usable choice, clicking only opens the install guide.
										isNotInstalled
											? "cursor-default border-border bg-surface-2 text-text-tertiary opacity-50 hover:border-border-focus hover:bg-surface-3 hover:text-text-primary hover:opacity-100"
											: isSelectedAgentOption
												? "border-accent bg-accent/10 text-text-primary"
												: "border-border-bright bg-surface-2 text-text-secondary hover:border-border-focus hover:bg-surface-3 hover:text-text-primary",
									)}
									onClick={() => {
										if (isNotInstalled) {
											const installUrl = iconAgentId
												? getRuntimeAgentCatalogEntry(iconAgentId)?.installUrl
												: null;
											if (installUrl) {
												window.open(installUrl, "_blank", "noopener,noreferrer");
											}
											return;
										}
										handleAgentIconSelection(option.value, isSelectedAgentOption);
									}}
								>
									<AgentIcon size={16} className={agentVisual.className} />
								</button>
							</Tooltip>
						);
					})}
				</div>
			</div>{" "}
		</>
	);
	const modelSelection = (
		<>
			{showTerminalAgentModelPicker ? (
				<div className="flex flex-col gap-1">
					<span className="text-[11px] text-text-secondary">
						Model{isLoadingTerminalAgentModels ? " (loading\u2026)" : ""}
					</span>
					<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Agent model">
						{latestTrackingAliasModelOptions.map((option) => (
							<TerminalAgentModelOptionButton
								key={option.value || "default-terminal-agent-model"}
								option={option}
								isSelected={selectedTerminalAgentModelId === option.value}
								disabled={isLoadingTerminalAgentModels && terminalAgentModelOptions.length <= 1}
								onSelect={selectTerminalAgentModelOption}
							/>
						))}
					</div>
					{pinnedVersionModelOptions.length > 0 ? (
						<Collapsible.Root open={isPinnedVersionGroupOpen} onOpenChange={setIsPinnedVersionGroupOpen}>
							<Collapsible.Trigger asChild>
								<button
									type="button"
									className="group flex cursor-pointer items-center gap-1 rounded text-[11px] text-text-tertiary transition-colors hover:text-text-secondary"
								>
									{isPinnedVersionGroupOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
									Pinned versions ({pinnedVersionModelOptions.length})
								</button>
							</Collapsible.Trigger>
							<Collapsible.Content>
								<div
									className="mt-1.5 flex flex-wrap items-center gap-1.5"
									role="group"
									aria-label="Pinned agent model versions"
								>
									{pinnedVersionModelOptions.map((option) => (
										<TerminalAgentModelOptionButton
											key={option.value}
											option={option}
											isSelected={selectedTerminalAgentModelId === option.value}
											disabled={isLoadingTerminalAgentModels && terminalAgentModelOptions.length <= 1}
											onSelect={selectTerminalAgentModelOption}
										/>
									))}
								</div>
							</Collapsible.Content>
						</Collapsible.Root>
					) : null}
				</div>
			) : null}{" "}
		</>
	);
	return (
		<>
			{renderControls ? (
				renderControls({ agentSelection, modelSelection })
			) : (
				<div className="flex flex-col gap-2">
					{agentSelection}
					{modelSelection}
				</div>
			)}
		</>
	);
}
