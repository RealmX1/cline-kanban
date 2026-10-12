import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CardSessionActivity,
	deriveCardSessionActivity,
	SESSION_ACTIVITY_COLOR,
} from "@/components/board-card-session-activity";
import {
	DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY,
	normalizeTaskSpotlightSearchResultRowFieldVisibility,
	type TaskSpotlightSearchResultRowFieldId,
	type TaskSpotlightSearchResultRowFieldVisibility,
} from "@/components/task-spotlight-search-result-row-field-visibility";
import { useTaskSpotlightSearchActiveResultIndex } from "@/hooks/use-task-spotlight-search-active-result-index";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	buildTaskBoardSearchDocuments,
	DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE,
	normalizeSearchQuery,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMode,
	type TaskBoardSearchResult,
	type TaskSearchMatchedTextFieldScope,
} from "@/search/task-board-search";
import {
	appendTaskSearchQueryToHistory,
	normalizeTaskSearchQueryHistory,
	removeTaskSearchQueryFromHistory,
} from "@/search/task-search-query-history";
import {
	DEFAULT_TASK_SEARCH_RESULT_SORT_ORDER,
	normalizeTaskSearchResultSortOrder,
	type TaskSearchResultSortOrder,
} from "@/search/task-search-result-ordering";
import {
	type AllProjectsTaskSearchIndexStatus,
	useAllProjectsTaskSearchIndex,
} from "@/search/use-all-projects-task-search-index";
import { type TaskBoardSemanticSearchStatus, useTaskBoardSearch } from "@/search/use-task-board-search";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { applyTaskFilterSelection } from "@/task-filtering/apply-task-filter-selection";
import type { TaskFilterControlsAvailableValues } from "@/task-filtering/task-filter-controls";
import {
	deriveTaskSessionActivityFilterCategory,
	EMPTY_TASK_FILTER_SELECTION,
	type TaskFilterSelection,
	type TaskSessionActivityFilterCategory,
} from "@/task-filtering/task-filter-selection";
import type { BoardColumnId, BoardData } from "@/types";
import { useJsonLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

export type TaskSpotlightCrossProjectStatus = AllProjectsTaskSearchIndexStatus;

/** stage 分段的固定顺序与展示名（trash 展示为 "Done"，与看板列语义一致）。 */
const SPOTLIGHT_STAGE_DEFINITIONS: ReadonlyArray<{ columnId: BoardColumnId; label: string }> = [
	{ columnId: "backlog", label: "Backlog" },
	{ columnId: "in_progress", label: "In Progress" },
	{ columnId: "review", label: "Review" },
	{ columnId: "validation", label: "Validation" },
	{ columnId: "trash", label: "Done" },
];

/** 供结果行等外部消费者解析 stage 展示名（trash → "Done"），与 stage 分段共用同一来源防漂移。 */
export function resolveSpotlightStageLabel(columnId: BoardColumnId): string {
	return SPOTLIGHT_STAGE_DEFINITIONS.find((definition) => definition.columnId === columnId)?.label ?? columnId;
}

const SPOTLIGHT_STAGE_FILTER_OPTIONS = SPOTLIGHT_STAGE_DEFINITIONS.map((definition) => ({
	value: definition.columnId,
	label: definition.label,
}));

const EMPTY_DOCUMENTS: readonly TaskBoardSearchDocument[] = [];

// 稳定引用：直接把字面量传给 useJsonLocalStorageValue 会每次渲染换一个新数组。
const EMPTY_TASK_SEARCH_QUERY_HISTORY: string[] = [];

interface StableDocumentsCache {
	signature: string;
	documents: TaskBoardSearchDocument[];
}

/**
 * 会话推流叠加层：把当前项目的 session summary 折成结果行/过滤/排序真正要用的那几个派生值。
 * 刻意**不进 documents**——sessions 每 tick 换引用，混进 documents 会把语义索引反复重建。
 */
interface TaskSessionOverlayEntry {
	agentId: RuntimeAgentId | null;
	sessionActivity: CardSessionActivity | null;
	sessionActivityCategory: TaskSessionActivityFilterCategory;
	agentConversationProgressAtEpochMs: number | null;
}

interface StableTaskSessionOverlayCache {
	signature: string;
	overlayByTaskId: ReadonlyMap<string, TaskSessionOverlayEntry>;
}

const EMPTY_TASK_SESSION_OVERLAY: ReadonlyMap<string, TaskSessionOverlayEntry> = new Map();

// 「此刻」的刷新节拍。结果行的相对时间药丸最细到「分」，过滤的时间窗最细到 24h——30s 一跳足以让读数
// 不显得卡住，又不至于让整屏结果每秒重算一遍。只在弹层开着时走表。
const NOW_REFRESH_INTERVAL_MS = 30_000;

/** 一行结果在渲染时需要、但不在搜索文档里的那些东西（全部来自会话叠加层 + agent 目录）。 */
export interface TaskSpotlightSearchResultRowDisplayContext {
	effectiveAgentId: RuntimeAgentId | null;
	agentLabel: string | null;
	sessionActivity: CardSessionActivity | null;
	agentConversationProgressAtEpochMs: number | null;
}

export interface UseTaskSpotlightSearchControllerInput {
	board: BoardData;
	currentProjectId: string | null;
	currentProjectName: string | null;
	/** 当前项目的默认 agent（runtime config 的 selectedAgentId）；用于补全没有 per-task 覆盖的行。 */
	currentProjectDefaultAgentId: RuntimeAgentId | null;
	/** 当前 workspace 的会话摘要（taskId → summary）。**只对当前项目可得**，跨项目行结构性没有。 */
	taskSessionSummariesByTaskId: Record<string, RuntimeTaskSessionSummary>;
	// 是否允许呼出（无项目时禁用）。
	canOpen: boolean;
	// 跨项目索引查询所用的连接（非 workspace-scoped 端点忽略 scope，用当前项目连接即可）。
	crossProjectWorkspaceId: string | null;
	// 跨项目结果中需剔除的项目（当前项目——实时 board 流更新鲜；以及不可用项目）。
	crossProjectExcludeProjectIds: ReadonlySet<string>;
	onOpenTaskInProject: (projectId: string, taskId: string) => void;
}

export interface TaskSpotlightSearchController {
	isOpen: boolean;
	canOpen: boolean;
	open: () => void;
	close: () => void;
	toggle: () => void;
	query: string;
	setQuery: (query: string) => void;
	/** 最近用过的检索串，最新在前。跨会话持久化，供「调出上次搜的东西」用。 */
	recentSearchQueries: readonly string[];
	/** 删掉某条历史（chips 上的 ×）。 */
	forgetRecentSearchQuery: (query: string) => void;
	mode: TaskBoardSearchMode;
	setMode: (mode: TaskBoardSearchMode) => void;
	/** 文本匹配的字段范围（标题 + prompt / 仅标题 / 仅 prompt），四种模式通用。 */
	matchedTextFieldScope: TaskSearchMatchedTextFieldScope;
	setMatchedTextFieldScope: (matchedTextFieldScope: TaskSearchMatchedTextFieldScope) => void;
	sortOrder: TaskSearchResultSortOrder;
	setSortOrder: (sortOrder: TaskSearchResultSortOrder) => void;
	/** 生效档：空查询浏览时 relevance 会回落（见 task-search-result-ordering）。 */
	effectiveSortOrder: TaskSearchResultSortOrder;
	filterSelection: TaskFilterSelection;
	setFilterSelection: (selection: TaskFilterSelection) => void;
	availableFilterValues: TaskFilterControlsAvailableValues;
	fieldVisibility: TaskSpotlightSearchResultRowFieldVisibility;
	toggleFieldVisibility: (fieldId: TaskSpotlightSearchResultRowFieldId, isVisible: boolean) => void;
	includeOtherProjects: boolean;
	setIncludeOtherProjects: (value: boolean) => void;
	crossProjectStatus: TaskSpotlightCrossProjectStatus;
	isSearchActive: boolean;
	/** 查询串为空、正在按排序档浏览全量任务。 */
	isBrowsingAllTasksWithoutQuery: boolean;
	semanticSearchStatus: TaskBoardSemanticSearchStatus;
	results: TaskBoardSearchResult[];
	/** task id 全等命中、却被过滤条件挡在 results 之外的条数（空态据此说明原因，见下方 useMemo）。 */
	taskIdMatchedResultCountHiddenByFilters: number;
	/** 因「会话状态维度已启用、但跨项目行判不了」而被排除的条数（空态同样要说明）。 */
	resultCountExcludedBecauseSessionActivityIsNotObservable: number;
	resolveResultRowDisplayContext: (document: TaskBoardSearchDocument) => TaskSpotlightSearchResultRowDisplayContext;
	/**
	 * 弹层共用的「此刻」（epoch ms）。**由 controller 唯一持有**：相对时间药丸与「上次修改」时间窗过滤
	 * 必须读同一个数，各自取 `Date.now()` 会让「行上写着 24h 内、却被 24h 过滤筛掉」这种自相矛盾真的发生。
	 */
	nowEpochMs: number;
	activeIndex: number;
	setActiveIndex: (index: number) => void;
	moveActive: (delta: number) => void;
	openActiveResult: () => void;
	openResultAt: (index: number) => void;
	currentProjectId: string | null;
}

function buildDocumentsSignature(documents: readonly TaskBoardSearchDocument[]): string {
	// 内容签名：taskId + columnId（stage 过滤依赖）+ title + prompt + 排序/展示用的五个卡片级字段。
	// 实时 board 流每 tick 换引用但内容不变时，签名一致 → 保持旧 documents 引用 → 语义索引不无谓重建
	// （详见 use-task-board-search 注释）。字段间那个不可见字符是 U+0001，任何字段值里都不可能出现，避免拼接歧义。
	//
	// ⚠️ TaskBoardSearchDocument 每新增一个字段都必须同步进这里：签名漏字段 = 该字段变化后仍命中旧缓存，
	// 消费方拿到的是内容陈旧的 documents（例如卡片换了 agent，结果行还画着旧图标）。派生字段
	// （titleLowerCase / taskSearchSubjectText / 各偏移）不必列——它们全由 title + prompt 唯一决定。
	return documents
		.map((doc) =>
			[
				doc.taskId,
				doc.columnId,
				doc.title,
				doc.prompt,
				doc.taskCreatedAtEpochMs,
				doc.taskLastModifiedAtEpochMs,
				doc.taskAgentOverrideAgentId ?? "",
				doc.mostRecentlyLaunchedAgentSessionAgentId ?? "",
				doc.crossProjectAgentConversationProgressAtEpochMs ?? "",
			].join(""),
		)
		.join("\n");
}

/**
 * parked 任务在结果行上的会话状态文案。**Spotlight 专属的叠加表达**，不进 `deriveCardSessionActivity`：
 * 那个派生是与主看板卡片共享的，看板上 park 由独立的 Parked 徽标（task-card-body）表达，行为不该被这里改动。
 * 结果行只有一条状态行、放不下第二个徽标，所以 park 必须直接说在这条状态行上。
 *
 * 文案与看板徽标同形（`Parked — awaiting <label>`），色值沿用 SESSION_ACTIVITY_COLOR：park 既不是「在算」
 * （thinking 蓝），也不是「等你动手」（waiting 金），用中性的 secondary。
 */
function buildParkedAwaitingDispatchedBackgroundWorkSessionActivity(
	summary: RuntimeTaskSessionSummary,
): CardSessionActivity {
	const dispatchedBackgroundWorkLabel = summary.awaitingDispatchedBackgroundWork?.label?.trim();
	return {
		dotColor: SESSION_ACTIVITY_COLOR.secondary,
		text: dispatchedBackgroundWorkLabel
			? `Parked — awaiting ${dispatchedBackgroundWorkLabel}`
			: "Parked — awaiting dispatched background work",
	};
}

function buildTaskSessionOverlay(
	taskSessionSummariesByTaskId: Record<string, RuntimeTaskSessionSummary>,
): Map<string, TaskSessionOverlayEntry> {
	const overlayByTaskId = new Map<string, TaskSessionOverlayEntry>();
	for (const [taskId, summary] of Object.entries(taskSessionSummariesByTaskId)) {
		// 展示文案与过滤分类必须对 park 给出同一个判断：parked 的主 agent 在 facet 上就是个普通 running 三元组
		// {turnOwner:"agent", liveness:"live", userTurnKind:null}，`deriveCardSessionActivity` 不读 park sidecar，
		// 会把它画成「Thinking...」；而 `deriveTaskSessionActivityFilterCategory` 读 sidecar、判成 Parked。
		// 于是这里**从同一个分类结果派生文案**：按 Parked 筛出来的行绝不会写着 Thinking，反之亦然。
		// 沿用分类里的既有优先级（额度/错误 > park），park 之外一律回落到共享派生。
		const sessionActivityCategory = deriveTaskSessionActivityFilterCategory(summary);
		overlayByTaskId.set(taskId, {
			agentId: summary.agentId,
			sessionActivity:
				sessionActivityCategory === "parked_awaiting_dispatched_background_work"
					? buildParkedAwaitingDispatchedBackgroundWorkSessionActivity(summary)
					: deriveCardSessionActivity(summary),
			sessionActivityCategory,
			agentConversationProgressAtEpochMs: summary.lastConversationProgressObservation?.observedAtMs ?? null,
		});
	}
	return overlayByTaskId;
}

/**
 * 会话叠加层的内容签名。**只纳入本叠加层真正读的那几个量**，而不是整条 summary：
 * summary 每次推流 tick 都换引用、`updatedAt` 也在动，按整条比对等于从不命中缓存，
 * 于是每 tick 都要重排一次结果、重建一次行上下文。
 */
function buildTaskSessionOverlaySignature(overlayByTaskId: ReadonlyMap<string, TaskSessionOverlayEntry>): string {
	return [...overlayByTaskId.entries()]
		.map(([taskId, entry]) =>
			[
				taskId,
				entry.agentId ?? "",
				entry.sessionActivityCategory,
				entry.agentConversationProgressAtEpochMs ?? "",
				entry.sessionActivity?.dotColor ?? "",
				entry.sessionActivity?.text ?? "",
			].join(""),
		)
		.join("\n");
}

/**
 * Spotlight 全局任务搜索的状态与计算中枢（App 级单实例）：
 * - 持有 open/query/mode/排序档/过滤选择/字段开关/跨项目开关/activeIndex；
 * - 组装 documents（当前项目在前，内容签名稳定化），驱动 useTaskBoardSearch；
 * - 对结果做「后置 scope 过滤」（过滤放搜索后，避免改过滤条件触发语义索引重建）；
 * - 把会话推流折成一层**不进 documents** 的叠加层，供排序（agent 活跃档）、过滤（会话状态维度）
 *   与结果行渲染共用；
 * - 暴露键盘导航与「打开选中结果」动作（关弹层后经 onOpenTaskInProject 跳转）。
 */
export function useTaskSpotlightSearchController({
	board,
	currentProjectId,
	currentProjectName,
	currentProjectDefaultAgentId,
	taskSessionSummariesByTaskId,
	canOpen,
	crossProjectWorkspaceId,
	crossProjectExcludeProjectIds,
	onOpenTaskInProject,
}: UseTaskSpotlightSearchControllerInput): TaskSpotlightSearchController {
	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [mode, setMode] = useState<TaskBoardSearchMode>("direct");
	const [matchedTextFieldScope, setMatchedTextFieldScope] = useState<TaskSearchMatchedTextFieldScope>(
		DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE,
	);
	const [filterSelection, setFilterSelection] = useState<TaskFilterSelection>(EMPTY_TASK_FILTER_SELECTION);
	const [includeOtherProjects, setIncludeOtherProjects] = useState(false);
	const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		setNowEpochMs(Date.now());
		const intervalId = window.setInterval(() => setNowEpochMs(Date.now()), NOW_REFRESH_INTERVAL_MS);
		return () => window.clearInterval(intervalId);
	}, [isOpen]);

	const [sortOrder, setSortOrder] = useRawLocalStorageValue<TaskSearchResultSortOrder>(
		LocalStorageKey.TaskSpotlightSearchResultSortOrder,
		DEFAULT_TASK_SEARCH_RESULT_SORT_ORDER,
		normalizeTaskSearchResultSortOrder,
	);
	const [storedFieldVisibility, setStoredFieldVisibility] = useJsonLocalStorageValue(
		LocalStorageKey.TaskSpotlightSearchResultRowFieldVisibility,
		DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY,
	);
	const fieldVisibility = useMemo(
		() => normalizeTaskSpotlightSearchResultRowFieldVisibility(storedFieldVisibility),
		[storedFieldVisibility],
	);
	const toggleFieldVisibility = useCallback(
		(fieldId: TaskSpotlightSearchResultRowFieldId, isVisible: boolean) => {
			setStoredFieldVisibility({ ...fieldVisibility, [fieldId]: isVisible });
		},
		[fieldVisibility, setStoredFieldVisibility],
	);

	const [storedSearchQueryHistory, setStoredSearchQueryHistory] = useJsonLocalStorageValue(
		LocalStorageKey.TaskSpotlightSearchQueryHistory,
		EMPTY_TASK_SEARCH_QUERY_HISTORY,
	);
	const recentSearchQueries = useMemo(
		() => normalizeTaskSearchQueryHistory(storedSearchQueryHistory),
		[storedSearchQueryHistory],
	);
	/**
	 * 记一条「用过的检索串」。只在**终止事件**上调用（打开某个结果、关掉弹层）——逐键记录会把
	 * `k` / `ka` / `kan` 这些前缀全塞进历史，真正想回看的那条反而被自己的前缀挤掉。
	 */
	const rememberSearchQuery = useCallback(
		(usedQuery: string) => {
			setStoredSearchQueryHistory((previous) => {
				const normalizedPrevious = normalizeTaskSearchQueryHistory(previous);
				const next = appendTaskSearchQueryToHistory(normalizedPrevious, usedQuery);
				return next === normalizedPrevious ? previous : [...next];
			});
		},
		[setStoredSearchQueryHistory],
	);
	const forgetRecentSearchQuery = useCallback(
		(forgottenQuery: string) => {
			setStoredSearchQueryHistory((previous) => {
				const normalizedPrevious = normalizeTaskSearchQueryHistory(previous);
				const next = removeTaskSearchQueryFromHistory(normalizedPrevious, forgottenQuery);
				return next === normalizedPrevious ? previous : [...next];
			});
		},
		[setStoredSearchQueryHistory],
	);

	// 跨项目索引按需拉取（弹层开 && 开关开）；enabled 由 false→true 时 useTrpcQuery 自动 refetch，
	// 关闭再打开即重新拉取（stale-while-revalidate 保留旧数据即时可搜）。
	const crossProjectIndex = useAllProjectsTaskSearchIndex({
		enabled: isOpen && includeOtherProjects,
		workspaceId: crossProjectWorkspaceId,
		excludeProjectIds: crossProjectExcludeProjectIds,
	});

	// 关闭/打开结果这些**终止事件**要记录「刚才搜的是什么」，但不该因此让 close/toggle 的函数标识
	// 随每次按键变化——用 ref 读最新查询串，依赖表里就只剩 rememberSearchQuery。
	// open / close / toggle 本身定义在选中行 hook 之后（要用它返回的 setActiveIndex）。
	const latestQueryRef = useRef(query);
	latestQueryRef.current = query;

	// 切换项目时自动关闭弹层（当前项目上下文已失效）。
	useEffect(() => {
		setIsOpen(false);
		setQuery("");
	}, [currentProjectId]);

	const stableDocumentsCacheRef = useRef<StableDocumentsCache>({ signature: "", documents: [] });
	const currentProjectDocuments = useMemo(() => {
		if (!isOpen || !currentProjectId) {
			return EMPTY_DOCUMENTS;
		}
		const nextDocuments = buildTaskBoardSearchDocuments(board, {
			projectId: currentProjectId,
			projectName: currentProjectName ?? currentProjectId,
		});
		const nextSignature = `${currentProjectId} ${currentProjectName ?? ""} ${buildDocumentsSignature(nextDocuments)}`;
		if (nextSignature === stableDocumentsCacheRef.current.signature) {
			return stableDocumentsCacheRef.current.documents;
		}
		stableDocumentsCacheRef.current = { signature: nextSignature, documents: nextDocuments };
		return nextDocuments;
	}, [isOpen, board, currentProjectId, currentProjectName]);

	const crossProjectDocuments = crossProjectIndex.documents;
	const documents = useMemo(() => {
		if (!includeOtherProjects || crossProjectDocuments.length === 0) {
			return currentProjectDocuments;
		}
		return [...currentProjectDocuments, ...crossProjectDocuments];
	}, [includeOtherProjects, currentProjectDocuments, crossProjectDocuments]);

	// ── 会话叠加层（同 documents 一样做内容签名稳定化） ──────────────────────────────────────
	const stableTaskSessionOverlayCacheRef = useRef<StableTaskSessionOverlayCache>({
		signature: "",
		overlayByTaskId: EMPTY_TASK_SESSION_OVERLAY,
	});
	const taskSessionOverlayByTaskId = useMemo(() => {
		if (!isOpen) {
			return EMPTY_TASK_SESSION_OVERLAY;
		}
		const nextOverlay = buildTaskSessionOverlay(taskSessionSummariesByTaskId);
		const nextSignature = buildTaskSessionOverlaySignature(nextOverlay);
		if (nextSignature === stableTaskSessionOverlayCacheRef.current.signature) {
			return stableTaskSessionOverlayCacheRef.current.overlayByTaskId;
		}
		stableTaskSessionOverlayCacheRef.current = { signature: nextSignature, overlayByTaskId: nextOverlay };
		return nextOverlay;
	}, [isOpen, taskSessionSummariesByTaskId]);

	/**
	 * 取一篇文档对应的会话叠加项。**先比 projectId 再取 taskId**：taskId 只在单个 board 内唯一，
	 * 跨项目撞号是常态，直接拿 taskId 查会把别的项目的会话状态安到这一行头上。
	 */
	const resolveTaskSessionOverlayEntry = useCallback(
		(document: TaskBoardSearchDocument): TaskSessionOverlayEntry | null => {
			if (document.projectId !== currentProjectId) {
				return null;
			}
			return taskSessionOverlayByTaskId.get(document.taskId) ?? null;
		},
		[currentProjectId, taskSessionOverlayByTaskId],
	);

	/**
	 * 「对话上次推进」时刻：当前项目读实时会话叠加层，其它项目读跨项目索引投影进文档的快照。
	 * 两路不互相回退——当前项目文档上的快照字段恒为 null，其它项目又查不到叠加项。
	 */
	const resolveAgentConversationProgressAtEpochMs = useCallback(
		(document: TaskBoardSearchDocument): number | null => {
			if (document.projectId !== currentProjectId) {
				return document.crossProjectAgentConversationProgressAtEpochMs;
			}
			return resolveTaskSessionOverlayEntry(document)?.agentConversationProgressAtEpochMs ?? null;
		},
		[currentProjectId, resolveTaskSessionOverlayEntry],
	);

	/**
	 * 这一行此刻的有效 agent。解析次序：活会话 > per-task 覆盖 > 最近一次真正启动过的会话 > 项目默认。
	 *
	 * 与任务卡（`sessionSummary?.agentId ?? card.agentId ?? defaultAgentId`）的唯一差别是中间多了
	 * 「最近一次真正启动过的」这一跳：跨项目行拿不到项目默认，那是它唯一可得的 agent 事实。
	 * 代价是当前项目里「没设覆盖、跑过 X、之后项目默认改成了 Y」的卡片，卡片显示 Y（下次会用它）、
	 * 这里显示 X（它实际用的是它）——搜索结果讲的是历史，显示 X 是对的。
	 */
	const resolveEffectiveAgentId = useCallback(
		(document: TaskBoardSearchDocument): RuntimeAgentId | null => {
			const overlayEntry = resolveTaskSessionOverlayEntry(document);
			return (
				overlayEntry?.agentId ??
				document.taskAgentOverrideAgentId ??
				document.mostRecentlyLaunchedAgentSessionAgentId ??
				(document.projectId === currentProjectId ? currentProjectDefaultAgentId : null)
			);
		},
		[currentProjectDefaultAgentId, currentProjectId, resolveTaskSessionOverlayEntry],
	);

	const resolveResultRowDisplayContext = useCallback(
		(document: TaskBoardSearchDocument): TaskSpotlightSearchResultRowDisplayContext => {
			const overlayEntry = resolveTaskSessionOverlayEntry(document);
			const effectiveAgentId = resolveEffectiveAgentId(document);
			return {
				effectiveAgentId,
				agentLabel: effectiveAgentId ? (getRuntimeAgentCatalogEntry(effectiveAgentId)?.label ?? null) : null,
				sessionActivity: overlayEntry?.sessionActivity ?? null,
				agentConversationProgressAtEpochMs: resolveAgentConversationProgressAtEpochMs(document),
			};
		},
		[resolveAgentConversationProgressAtEpochMs, resolveEffectiveAgentId, resolveTaskSessionOverlayEntry],
	);

	const { isSearchActive, isBrowsingAllTasksWithoutQuery, orderedResults, effectiveSortOrder, semanticSearchStatus } =
		useTaskBoardSearch({
			documents,
			query,
			mode,
			matchedTextFieldScope,
			sortOrder,
			resolveAgentConversationProgressAtEpochMs,
			isBrowsingAllTasksWithoutQueryEnabled: isOpen,
		});

	// 过滤放在搜索**之后**：过滤条件是用户随手改的 scope，改它不该触发语义索引重建。
	// 时间窗为 any 时把 now 钉成 0：这一维度此时根本不读它，钉住可以让 nowEpochMs 每 30s 的跳动
	// 不去无谓地重算整张结果列表。
	const filterEvaluationNowEpochMs = filterSelection.lastModifiedWindow === "any" ? 0 : nowEpochMs;
	const filterApplication = useMemo(
		() =>
			applyTaskFilterSelection({
				rows: orderedResults,
				selection: filterSelection,
				nowEpochMs: filterEvaluationNowEpochMs,
				describeRow: (result: TaskBoardSearchResult) => ({
					projectId: result.document.projectId,
					columnId: result.document.columnId as BoardColumnId,
					agentId: resolveEffectiveAgentId(result.document),
					taskLastModifiedAtEpochMs: result.document.taskLastModifiedAtEpochMs,
					sessionActivityCategory:
						result.document.projectId === currentProjectId
							? (resolveTaskSessionOverlayEntry(result.document)?.sessionActivityCategory ?? "no_live_session")
							: null,
				}),
			}),
		[
			currentProjectId,
			filterEvaluationNowEpochMs,
			filterSelection,
			orderedResults,
			resolveEffectiveAgentId,
			resolveTaskSessionOverlayEntry,
		],
	);
	const results = filterApplication.filteredRows;

	// ID 命中（全等 / 片段 / 容错）却被过滤条件挡掉时，空态必须说明原因 —— 否则用户拷了个 id 却看到
	// "No matching tasks"，会以为任务不存在。过滤是用户显式设定的 scope，不为 ID 命中豁免，
	// 只补一句诚实的解释。
	const taskIdMatchedResultCountHiddenByFilters = useMemo(() => {
		const visibleResults = new Set(results);
		return orderedResults.filter((result) => result.matchSources.includes("taskId") && !visibleResults.has(result))
			.length;
	}, [orderedResults, results]);

	const availableFilterValues = useMemo<TaskFilterControlsAvailableValues>(() => {
		const projectNameById = new Map<string, string>();
		const agentIds = new Set<RuntimeAgentId>();
		for (const document of documents) {
			if (!projectNameById.has(document.projectId)) {
				projectNameById.set(document.projectId, document.projectName);
			}
			const agentId = resolveEffectiveAgentId(document);
			if (agentId) {
				agentIds.add(agentId);
			}
		}
		return {
			stageColumnIds: SPOTLIGHT_STAGE_FILTER_OPTIONS,
			projects: [...projectNameById.entries()].map(([projectId, projectName]) => ({
				value: projectId,
				label: projectName,
			})),
			agents: [...agentIds].map((agentId) => ({
				value: agentId,
				label: getRuntimeAgentCatalogEntry(agentId)?.label ?? agentId,
			})),
		};
	}, [documents, resolveEffectiveAgentId]);

	// 选中行的收敛与导航（含「纯实时重排时选中行跟着同一个任务走」）见该 hook 的注释。
	// `results` 来自 `filterApplication.filteredRows`，其依赖含会话叠加层——当前项目有 agent 在产出时，
	// 成员与顺序不变、数组引用却每隔几秒换一次；启用「上次修改」时间窗后 nowEpochMs 的 30s 心跳同样会重算。
	// 所以那边只认结果集身份签名、不认数组引用。
	const {
		activeIndex: activeIndexClamped,
		setActiveIndex,
		moveActive,
	} = useTaskSpotlightSearchActiveResultIndex({
		results,
		isBrowsingAllTasksWithoutQuery,
		resultOrderingIntentSignature: [
			mode,
			matchedTextFieldScope,
			effectiveSortOrder,
			normalizeSearchQuery(query),
		].join("\u0001"),
	});

	const open = useCallback(() => {
		if (!canOpen) {
			return;
		}
		setQuery("");
		setActiveIndex(-1);
		setIsOpen(true);
	}, [canOpen, setActiveIndex]);

	const close = useCallback(() => {
		rememberSearchQuery(latestQueryRef.current);
		setIsOpen(false);
		setQuery("");
	}, [rememberSearchQuery]);

	const toggle = useCallback(() => {
		setIsOpen((previous) => {
			if (previous) {
				rememberSearchQuery(latestQueryRef.current);
				setQuery("");
				return false;
			}
			if (!canOpen) {
				return false;
			}
			setQuery("");
			setActiveIndex(-1);
			return true;
		});
	}, [canOpen, rememberSearchQuery, setActiveIndex]);

	const openResultAt = useCallback(
		(index: number) => {
			const result = results[index];
			if (!result) {
				return;
			}
			rememberSearchQuery(latestQueryRef.current);
			setIsOpen(false);
			setQuery("");
			onOpenTaskInProject(result.document.projectId, result.document.taskId);
		},
		[results, onOpenTaskInProject, rememberSearchQuery],
	);

	const openActiveResult = useCallback(() => {
		if (activeIndexClamped < 0) {
			return;
		}
		openResultAt(activeIndexClamped);
	}, [activeIndexClamped, openResultAt]);

	return {
		isOpen,
		canOpen,
		open,
		close,
		toggle,
		query,
		setQuery,
		recentSearchQueries,
		forgetRecentSearchQuery,
		mode,
		setMode,
		matchedTextFieldScope,
		setMatchedTextFieldScope,
		sortOrder,
		setSortOrder,
		effectiveSortOrder,
		filterSelection,
		setFilterSelection,
		availableFilterValues,
		fieldVisibility,
		toggleFieldVisibility,
		includeOtherProjects,
		setIncludeOtherProjects,
		crossProjectStatus: crossProjectIndex.status,
		isSearchActive,
		isBrowsingAllTasksWithoutQuery,
		semanticSearchStatus,
		results,
		taskIdMatchedResultCountHiddenByFilters,
		resultCountExcludedBecauseSessionActivityIsNotObservable:
			filterApplication.rowCountExcludedBecauseSessionActivityIsNotObservable,
		resolveResultRowDisplayContext,
		nowEpochMs,
		activeIndex: activeIndexClamped,
		setActiveIndex,
		moveActive,
		openActiveResult,
		openResultAt,
		currentProjectId,
	};
}
