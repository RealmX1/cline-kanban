import * as Collapsible from "@radix-ui/react-collapsible";
import {
	getRuntimeAgentCatalogEntry,
	getRuntimeLaunchSupportedAgentCatalog,
	KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID,
} from "@runtime-agent-catalog";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getAgentVisual } from "@/components/agent-visual";
import { ClineChatModelSelector } from "@/components/detail-panels/cline-chat-model-selector";
import {
	buildClineAgentModelPickerOptions,
	buildClineSelectedModelButtonText,
	getClineReasoningEnabledModelIds,
} from "@/components/detail-panels/cline-model-picker-options";
import { SearchSelectDropdown } from "@/components/search-select-dropdown";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import {
	fetchClineProviderCatalog,
	fetchClineProviderModels,
	fetchTerminalAgentModelSelectionOptions,
} from "@/runtime/runtime-config-query";
import { readTaskAgentModelListCache, writeTaskAgentModelListCache } from "@/runtime/task-agent-model-list-cache";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeClineProviderCatalogItem,
	RuntimeClineProviderModel,
	RuntimeClineReasoningEffort,
	RuntimeTaskClineSettings,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTerminalAgentModelSelectionAgentId,
	RuntimeTerminalAgentModelSelectionGroup,
	RuntimeTerminalAgentModelSelectionOptionsResponse,
} from "@/runtime/types";

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
// Hook: manages fetch state for Cline provider catalog + model lists
// ---------------------------------------------------------------------------

export interface UseTaskAgentModelPickerInput {
	active: boolean;
	workspaceId: string | null;
	agentId: RuntimeAgentId | undefined;
	clineSettings?: RuntimeTaskClineSettings;
	/** Agent definitions from runtimeConfig.agents — carries `installed` for grey-out of not-installed agents. */
	agents?: RuntimeAgentDefinition[];
	/** The default agent ID from runtimeConfig.selectedAgentId — used to build the first option label */
	defaultAgentId?: RuntimeAgentId | null;
	/** The default Cline provider ID from runtimeConfig.clineProviderSettings.providerId */
	defaultProviderId?: string | null;
	/** The default Cline model ID from runtimeConfig.clineProviderSettings.modelId */
	defaultModelId?: string | null;
}

export interface UseTaskAgentModelPickerResult {
	agentOptions: TaskAgentPickerAgentOption[];
	clineProviderOptions: Array<{ value: string; label: string }>;
	clineModelOptions: Array<{ value: string; label: string }>;
	terminalAgentModelOptions: TaskAgentPickerTerminalModelOption[];
	terminalAgentDefaultModelId: string | null;
	effectiveDefaultModelId: string | null;
	providerModels: RuntimeClineProviderModel[];
	isLoadingProviders: boolean;
	isLoadingModels: boolean;
	isLoadingTerminalAgentModels: boolean;
	/** Map of provider ID → its default model ID (from the provider catalog). */
	providerDefaultModels: Record<string, string>;
}

export interface TaskTerminalAgentModelOverrideSettingsChangeOptions {
	rememberSelectionForFutureCreateTasks?: boolean;
}

function isTerminalAgentModelSelectionAgentId(
	agentId: RuntimeAgentId | null | undefined,
): agentId is RuntimeTerminalAgentModelSelectionAgentId {
	return agentId === "claude" || agentId === "codex" || agentId === "cursor";
}

function getFallbackTerminalAgentDefaultModelOption(agentId: RuntimeTerminalAgentModelSelectionAgentId): {
	value: string;
	label: string;
	defaultModelId: string | null;
} {
	if (agentId === "cursor") {
		return {
			value: "",
			label: "Default · Cursor Grok 4.5 High",
			defaultModelId: KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID,
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
	clineSettings,
	agents,
	defaultAgentId,
	defaultProviderId,
	defaultModelId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const [providerCatalog, setProviderCatalog] = useState<RuntimeClineProviderCatalogItem[]>([]);
	const [providerModels, setProviderModels] = useState<RuntimeClineProviderModel[]>([]);
	const [terminalAgentModelOptions, setTerminalAgentModelOptions] = useState<TaskAgentPickerTerminalModelOption[]>([]);
	const [terminalAgentDefaultModelId, setTerminalAgentDefaultModelId] = useState<string | null>(null);
	const [isLoadingProviders, setIsLoadingProviders] = useState(false);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const [isLoadingTerminalAgentModels, setIsLoadingTerminalAgentModels] = useState(false);

	// Derive the effective agent: explicit override takes precedence, then the global default
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;

	useEffect(() => {
		if (!active || effectiveAgentId !== "cline") {
			return;
		}
		let cancelled = false;
		const cacheKey = `cline-catalog:${workspaceId}`;
		const cached = readTaskAgentModelListCache<RuntimeClineProviderCatalogItem[]>(cacheKey);
		if (cached) {
			setProviderCatalog(cached);
		}
		setIsLoadingProviders(true);
		void fetchClineProviderCatalog(workspaceId)
			.then((catalog) => {
				if (!cancelled) {
					setProviderCatalog(catalog);
					writeTaskAgentModelListCache(cacheKey, catalog);
				}
			})
			.catch(() => {
				if (!cancelled && !cached) {
					setProviderCatalog([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingProviders(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, workspaceId]);

	useEffect(() => {
		if (!active || !isTerminalAgentModelSelectionAgentId(effectiveAgentId)) {
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
			const defaultOption: TaskAgentPickerTerminalModelOption = {
				value: "",
				label: response.defaultLabel || fallbackDefaultOption.label,
				modelSelectionGroup: "latest_tracking_alias",
			};
			const explicitOptions = response.options
				.filter((option) => option.modelId.trim().length > 0)
				.filter((option) => option.modelId !== response.defaultModelId)
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
			setTerminalAgentModelOptions([fallbackDefaultOption]);
			setTerminalAgentDefaultModelId(fallbackDefaultOption.defaultModelId);
		}
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
					if (!cached) {
						applyResponse(response);
					}
					return;
				}
				applyResponse(response);
				writeTaskAgentModelListCache(cacheKey, response);
			})
			.catch(() => {
				if (cancelled || cached) {
					return; // Keep the cached list on failure rather than clearing it.
				}
				setTerminalAgentModelOptions([fallbackDefaultOption]);
				setTerminalAgentDefaultModelId(fallbackDefaultOption.defaultModelId);
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingTerminalAgentModels(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, workspaceId]);

	// Derive the effective provider: explicit override takes precedence, then the global default
	const clineProviderId = clineSettings?.providerId;
	const effectiveProviderId = (clineProviderId ?? defaultProviderId ?? "").trim() || null;

	useEffect(() => {
		if (!active || effectiveAgentId !== "cline" || !effectiveProviderId) {
			setProviderModels([]);
			return;
		}
		let cancelled = false;
		const cacheKey = `cline-models:${workspaceId}:${effectiveProviderId}`;
		const cached = readTaskAgentModelListCache<RuntimeClineProviderModel[]>(cacheKey);
		if (cached) {
			setProviderModels(cached);
		}
		setIsLoadingModels(true);
		void fetchClineProviderModels(workspaceId, effectiveProviderId)
			.then((models) => {
				if (!cancelled) {
					setProviderModels(models);
					writeTaskAgentModelListCache(cacheKey, models);
				}
			})
			.catch(() => {
				if (!cancelled && !cached) {
					setProviderModels([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingModels(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, effectiveProviderId, workspaceId]);

	const agentOptions = useMemo<TaskAgentPickerAgentOption[]>(() => {
		const catalog = getRuntimeLaunchSupportedAgentCatalog();
		const installedByAgentId = new Map(
			(agents ?? EMPTY_AGENT_DEFINITIONS).map((agent) => [agent.id, agent.installed]),
		);
		// Cline is the in-process SDK agent → always available. Otherwise read backend detection;
		// null (config not yet loaded / unknown agent) renders normally rather than greyed.
		const resolveInstalled = (id: RuntimeAgentId): boolean | null =>
			id === "cline" ? true : (installedByAgentId.get(id) ?? null);
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
	}, [agents, defaultAgentId]);

	const clineProviderOptions = useMemo(() => {
		let firstLabel = "Default";
		if (defaultProviderId) {
			const defaultProvider = providerCatalog.find((p) => p.id === defaultProviderId);
			firstLabel = defaultProvider ? defaultProvider.name : defaultProviderId;
		}
		return [
			{ value: "", label: firstLabel },
			// Exclude the default provider from the explicit list — it's already represented by the first option
			...providerCatalog.filter((p) => p.id !== defaultProviderId).map((p) => ({ value: p.id, label: p.name })),
		];
	}, [providerCatalog, defaultProviderId]);

	// Map of provider ID → its catalog default model ID. Used by the component to
	// auto-select the right model when the user switches providers.
	const providerDefaultModels = useMemo(() => {
		const map: Record<string, string> = {};
		for (const p of providerCatalog) {
			if (p.defaultModelId) {
				map[p.id] = p.defaultModelId;
			}
		}
		return map;
	}, [providerCatalog]);

	// When an explicit provider override is selected, the "Default" model label should
	// reflect that provider's default model — not the global settings model.
	const effectiveDefaultModelId = useMemo(() => {
		if (clineProviderId) {
			const provider = providerCatalog.find((p) => p.id === clineProviderId);
			return provider?.defaultModelId ?? null;
		}
		const inheritedProviderDefaultModelId =
			providerCatalog.find((p) => p.id === defaultProviderId)?.defaultModelId ?? null;
		return defaultModelId ?? inheritedProviderDefaultModelId;
	}, [clineProviderId, defaultModelId, defaultProviderId, providerCatalog]);

	const clineModelOptions = useMemo(() => {
		let defaultLabel = "Default";
		if (effectiveDefaultModelId) {
			const defaultModel = providerModels.find((m) => m.id === effectiveDefaultModelId);
			defaultLabel = defaultModel ? defaultModel.name : effectiveDefaultModelId;
		}
		return [
			{ value: "", label: defaultLabel },
			// Exclude the default model from the explicit list — it's already represented by the first option
			...providerModels.filter((m) => m.id !== effectiveDefaultModelId).map((m) => ({ value: m.id, label: m.name })),
		];
	}, [providerModels, effectiveDefaultModelId]);

	return {
		agentOptions,
		clineProviderOptions,
		clineModelOptions,
		terminalAgentModelOptions,
		terminalAgentDefaultModelId,
		effectiveDefaultModelId,
		providerModels,
		isLoadingProviders,
		isLoadingModels,
		isLoadingTerminalAgentModels,
		providerDefaultModels,
	};
}

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

// ---------------------------------------------------------------------------
// Component: renders Agent, Cline provider, and Cline model pickers
// ---------------------------------------------------------------------------

export function TaskAgentModelPicker({
	agentId,
	onAgentIdChange,
	clineSettings,
	onClineSettingsChange,
	terminalAgentModelOverrideSettings,
	onTerminalAgentModelOverrideSettingsChange,
	agentOptions,
	clineProviderOptions,
	clineModelOptions,
	terminalAgentModelOptions = [],
	terminalAgentDefaultModelId = null,
	effectiveDefaultModelId = null,
	providerModels = [],
	isLoadingProviders,
	isLoadingModels,
	isLoadingTerminalAgentModels = false,
	onPopoverOpenChange,
	defaultAgentId,
	defaultProviderId,
	defaultReasoningEffort,
	providerDefaultModels,
}: {
	agentId: RuntimeAgentId | undefined;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
	clineSettings?: RuntimeTaskClineSettings | undefined;
	onClineSettingsChange?: (value: RuntimeTaskClineSettings | undefined) => void;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	onTerminalAgentModelOverrideSettingsChange?: (
		value: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
		options?: TaskTerminalAgentModelOverrideSettingsChangeOptions,
	) => void;
	agentOptions: TaskAgentPickerAgentOption[];
	clineProviderOptions: Array<{ value: string; label: string }>;
	clineModelOptions: Array<{ value: string; label: string }>;
	terminalAgentModelOptions?: TaskAgentPickerTerminalModelOption[];
	terminalAgentDefaultModelId?: string | null;
	effectiveDefaultModelId?: string | null;
	providerModels?: RuntimeClineProviderModel[];
	isLoadingProviders: boolean;
	isLoadingModels: boolean;
	isLoadingTerminalAgentModels?: boolean;
	onPopoverOpenChange?: (open: boolean) => void;
	/** The default agent ID from runtimeConfig — used to decide if Cline pickers should show by default */
	defaultAgentId?: RuntimeAgentId | null;
	/** The default Cline provider ID from runtimeConfig — used to decide if model picker should show by default */
	defaultProviderId?: string | null;
	/** The global default reasoning effort from runtimeConfig.clineProviderSettings.reasoningEffort */
	defaultReasoningEffort?: RuntimeClineReasoningEffort | null;
	/** Map of provider ID → its default model ID (from the provider catalog). */
	providerDefaultModels?: Record<string, string>;
}): ReactElement {
	const clineProviderId = clineSettings?.providerId;
	const clineModelId = clineSettings?.modelId;
	const clineReasoningEffort = clineSettings?.reasoningEffort;

	const updateTaskClineSettings = useCallback(
		(updater: (current: RuntimeTaskClineSettings | undefined) => RuntimeTaskClineSettings | undefined) => {
			onClineSettingsChange?.(updater(cloneTaskClineSettings(clineSettings)));
		},
		[clineSettings, onClineSettingsChange],
	);

	// Show the Cline provider picker when the effective agent is "cline"
	// (either explicitly overridden to cline, or defaulting to cline)
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;
	const showClineProviderPicker = effectiveAgentId === "cline";
	const showTerminalAgentModelPicker = isTerminalAgentModelSelectionAgentId(effectiveAgentId);

	// Show the Cline model picker when a provider is effectively selected
	// (either explicitly overridden, or the global default provider is set)
	const effectiveProviderId = clineProviderId ?? defaultProviderId ?? null;
	const showClineModelPicker = showClineProviderPicker && Boolean(effectiveProviderId);
	const hasTaskClineSettingsOverride = clineSettings !== undefined;
	const selectedTaskReasoningEffort = clineReasoningEffort ?? "";
	const [isProviderPopoverOpen, setIsProviderPopoverOpen] = useState(false);
	const [isModelPopoverOpen, setIsModelPopoverOpen] = useState(false);
	const [reasoningEffort, setReasoningEffort] = useState<RuntimeClineReasoningEffort | "">(
		hasTaskClineSettingsOverride ? selectedTaskReasoningEffort : (defaultReasoningEffort ?? ""),
	);
	const setReasoningEffortWithOverride = useCallback(
		(nextReasoningEffort: RuntimeClineReasoningEffort | "") => {
			setReasoningEffort(nextReasoningEffort);
			updateTaskClineSettings((currentSettings) => {
				const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
				if (nextReasoningEffort) {
					nextSettings.reasoningEffort = nextReasoningEffort;
					return nextSettings;
				}
				delete nextSettings.reasoningEffort;
				if (
					nextSettings.providerId ||
					nextSettings.modelId ||
					currentSettings !== undefined ||
					Boolean(defaultReasoningEffort)
				) {
					return nextSettings;
				}
				return undefined;
			});
		},
		[defaultReasoningEffort, updateTaskClineSettings],
	);

	const modelPickerOptions = useMemo(() => {
		const defaultOption = clineModelOptions.find((option) => option.value === "");
		const explicitOptions = clineModelOptions.filter((option) => option.value !== "");
		const providerId = (effectiveProviderId ?? "").trim();

		if (!providerId || explicitOptions.length === 0) {
			return {
				options: defaultOption ? [defaultOption, ...explicitOptions] : explicitOptions,
				recommendedModelIds: [] as string[],
				shouldPinSelectedModelToTop: true,
			};
		}

		const orderedOptions = buildClineAgentModelPickerOptions(providerId, providerModels);
		const explicitOptionByValue = new Map(explicitOptions.map((option) => [option.value, option] as const));
		const orderedExplicit = orderedOptions.options
			.map((option) => explicitOptionByValue.get(option.value))
			.filter((option): option is { value: string; label: string } => option !== undefined);
		const orderedExplicitValueSet = new Set(orderedExplicit.map((option) => option.value));
		const remainingExplicit = explicitOptions.filter((option) => !orderedExplicitValueSet.has(option.value));

		return {
			options: defaultOption ? [defaultOption, ...orderedExplicit, ...remainingExplicit] : orderedExplicit,
			recommendedModelIds: orderedOptions.recommendedModelIds,
			shouldPinSelectedModelToTop: orderedOptions.shouldPinSelectedModelToTop,
		};
	}, [clineModelOptions, effectiveProviderId, providerModels]);

	const reasoningEnabledModelIds = useMemo(() => getClineReasoningEnabledModelIds(providerModels), [providerModels]);
	const reasoningEnabledModelIdSet = useMemo(() => new Set(reasoningEnabledModelIds), [reasoningEnabledModelIds]);
	const effectiveSelectedModelId = (clineModelId ?? effectiveDefaultModelId ?? "").trim();
	const selectedModelCapabilityKnown = useMemo(
		() => providerModels.some((model) => model.id === effectiveSelectedModelId),
		[effectiveSelectedModelId, providerModels],
	);
	const selectedModelSupportsReasoningEffort = reasoningEnabledModelIdSet.has(effectiveSelectedModelId);

	useEffect(() => {
		if (!hasTaskClineSettingsOverride) {
			return;
		}
		if (selectedTaskReasoningEffort !== reasoningEffort) {
			setReasoningEffort(selectedTaskReasoningEffort);
		}
	}, [hasTaskClineSettingsOverride, reasoningEffort, selectedTaskReasoningEffort]);

	useEffect(() => {
		if (hasTaskClineSettingsOverride) {
			return;
		}
		const inheritedReasoningEffort = defaultReasoningEffort ?? "";
		if (reasoningEffort !== inheritedReasoningEffort) {
			setReasoningEffort(inheritedReasoningEffort);
		}
	}, [defaultReasoningEffort, hasTaskClineSettingsOverride, reasoningEffort]);

	useEffect(() => {
		onPopoverOpenChange?.(isProviderPopoverOpen || isModelPopoverOpen);
	}, [isModelPopoverOpen, isProviderPopoverOpen, onPopoverOpenChange]);

	useEffect(() => {
		if (!showClineProviderPicker) {
			setIsProviderPopoverOpen(false);
			setIsModelPopoverOpen(false);
			return;
		}
		if (!showClineModelPicker) {
			setIsModelPopoverOpen(false);
		}
	}, [showClineModelPicker, showClineProviderPicker]);

	const handleAgentIconSelection = useCallback(
		(optionValue: string, isSelectedAgentOption: boolean) => {
			if (isSelectedAgentOption) {
				return;
			}
			onAgentIdChange(optionValue ? (optionValue as RuntimeAgentId) : undefined);
			if (optionValue !== "cline") {
				onClineSettingsChange?.(undefined);
				setReasoningEffort("");
			}
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
		[
			defaultAgentId,
			onAgentIdChange,
			onClineSettingsChange,
			onTerminalAgentModelOverrideSettingsChange,
			terminalAgentModelOverrideSettings,
		],
	);

	useEffect(() => {
		if (!selectedModelCapabilityKnown) {
			return;
		}
		if (!selectedModelSupportsReasoningEffort && reasoningEffort) {
			setReasoningEffortWithOverride("");
		}
	}, [
		reasoningEffort,
		selectedModelCapabilityKnown,
		selectedModelSupportsReasoningEffort,
		setReasoningEffortWithOverride,
	]);

	const selectedModelButtonText = useMemo(
		() =>
			buildClineSelectedModelButtonText({
				modelOptions: modelPickerOptions.options,
				selectedModelId: clineModelId ?? "",
				reasoningEffort,
				showReasoningEffort: selectedModelSupportsReasoningEffort,
				isModelLoading: isLoadingModels,
			}),
		[
			clineModelId,
			isLoadingModels,
			modelPickerOptions.options,
			reasoningEffort,
			selectedModelSupportsReasoningEffort,
		],
	);
	const selectedTerminalAgentModelId =
		isTerminalAgentModelSelectionAgentId(effectiveAgentId) &&
		terminalAgentModelOverrideSettings?.agentId === effectiveAgentId &&
		terminalAgentModelOverrideSettings.modelId !== terminalAgentDefaultModelId
			? terminalAgentModelOverrideSettings.modelId
			: "";

	// 别名（含 Default 占位）常驻第一行；钉版本项进入默认收起的第二行。
	const latestTrackingAliasModelOptions = useMemo(
		() => terminalAgentModelOptions.filter((option) => !isPinnedVersionModelOption(option)),
		[terminalAgentModelOptions],
	);
	const pinnedVersionModelOptions = useMemo(
		() => terminalAgentModelOptions.filter(isPinnedVersionModelOption),
		[terminalAgentModelOptions],
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

	// When models finish loading and the currently selected model isn't in the
	// options list, auto-select the first real model so the button never shows
	// "No models available". Pick the first non-empty option (skipping the
	// "Default" placeholder) so the user immediately sees a concrete model name.
	//
	// Guard: also skip when model options only contains the "Default"
	// placeholder (length <= 1). This prevents a race condition where the
	// effect fires on the initial render before models have been fetched —
	// at that point isLoadingModels is still false (hasn't been set to true
	// yet by the fetch effect) and the stale/empty options list would
	// incorrectly clear a valid saved clineModelId.
	useEffect(() => {
		if (isLoadingModels || !clineModelId || modelPickerOptions.options.length <= 1) {
			return;
		}
		const modelExists = modelPickerOptions.options.some((opt) => opt.value === clineModelId);
		if (!modelExists) {
			const firstRealModel = modelPickerOptions.options.find((opt) => opt.value !== "");
			updateTaskClineSettings((currentSettings) => {
				const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
				if (firstRealModel?.value) {
					nextSettings.modelId = firstRealModel.value;
					return nextSettings;
				}
				delete nextSettings.modelId;
				const preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;
				return nextSettings.providerId || nextSettings.reasoningEffort || preserveEmptyOverride
					? nextSettings
					: undefined;
			});
		}
	}, [clineModelId, isLoadingModels, modelPickerOptions.options, updateTaskClineSettings]);

	return (
		<div className="flex flex-col gap-2">
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
			</div>
			{showClineProviderPicker ? (
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<div className="min-w-0">
						<span className="text-[11px] text-text-secondary block mb-1">
							Provider{isLoadingProviders ? " (loading\u2026)" : ""}
						</span>
						<SearchSelectDropdown
							options={clineProviderOptions}
							selectedValue={clineProviderId ?? ""}
							onSelect={(value) => {
								const newProviderId = value || undefined;
								const newDefaultModel =
									newProviderId && providerDefaultModels ? providerDefaultModels[newProviderId] : undefined;
								updateTaskClineSettings((currentSettings) => {
									const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
									if (newProviderId) {
										nextSettings.providerId = newProviderId;
									} else {
										delete nextSettings.providerId;
									}
									if (newDefaultModel) {
										nextSettings.modelId = newDefaultModel;
									} else {
										delete nextSettings.modelId;
									}
									delete nextSettings.reasoningEffort;
									const preserveEmptyOverride =
										newProviderId !== undefined ||
										(currentSettings !== undefined && Object.keys(currentSettings).length === 0);
									return nextSettings.providerId || nextSettings.modelId || preserveEmptyOverride
										? nextSettings
										: undefined;
								});
								setReasoningEffort(
									newProviderId || (clineSettings !== undefined && Object.keys(clineSettings).length === 0)
										? ""
										: (defaultReasoningEffort ?? ""),
								);
							}}
							disabled={isLoadingProviders}
							fill
							size="sm"
							placeholder="Search providers..."
							emptyText="No providers available"
							noResultsText="No matching providers"
							showSelectedIndicator
							onPopoverOpenChange={setIsProviderPopoverOpen}
						/>
					</div>
					{showClineModelPicker ? (
						<div className="min-w-0">
							<span className="text-[11px] text-text-secondary block mb-1">
								Model{isLoadingModels ? " (loading\u2026)" : ""}
							</span>
							<ClineChatModelSelector
								modelOptions={modelPickerOptions.options}
								recommendedModelIds={modelPickerOptions.recommendedModelIds}
								pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
								selectedModelId={clineModelId ?? ""}
								selectedModelButtonText={selectedModelButtonText}
								onSelectModel={(value) => {
									updateTaskClineSettings((currentSettings) => {
										const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
										if (value) {
											nextSettings.modelId = value;
										} else {
											delete nextSettings.modelId;
										}
										if (!value || !reasoningEnabledModelIdSet.has(value)) {
											delete nextSettings.reasoningEffort;
										}
										const preserveEmptyOverride =
											currentSettings !== undefined && Object.keys(currentSettings).length === 0;
										return nextSettings.providerId ||
											nextSettings.modelId ||
											nextSettings.reasoningEffort ||
											preserveEmptyOverride
											? nextSettings
											: undefined;
									});
									if (!value && !clineProviderId) {
										setReasoningEffort(
											clineSettings !== undefined && Object.keys(clineSettings).length === 0
												? ""
												: (defaultReasoningEffort ?? ""),
										);
										return;
									}
									if (!value || !reasoningEnabledModelIdSet.has(value)) {
										setReasoningEffortWithOverride("");
									}
								}}
								reasoningEnabledModelIds={reasoningEnabledModelIds}
								defaultOptionSupportsReasoningEffort={!clineModelId && selectedModelSupportsReasoningEffort}
								selectedReasoningEffort={reasoningEffort}
								onSelectReasoningEffort={(nextReasoningEffort) =>
									setReasoningEffortWithOverride(nextReasoningEffort)
								}
								disabled={isLoadingModels}
								isModelLoading={isLoadingModels}
								fill
								triggerVariant="default"
								onPopoverOpenChange={setIsModelPopoverOpen}
							/>
						</div>
					) : null}
				</div>
			) : null}
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
			) : null}
		</div>
	);
}
