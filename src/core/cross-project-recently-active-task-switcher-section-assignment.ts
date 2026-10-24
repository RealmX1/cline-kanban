import {
	resolveLastAgentConversationPromptCacheReferenceObservation,
	resolveLastEffectiveAgentConversationActivityObservation,
} from "./agent-conversation-activity-observation";
import type { RuntimeAgentId, RuntimeCrossProjectTaskSwitcherEntry, RuntimeInProgressTaskDetail } from "./api-contract";
import {
	CODING_AGENT_PROMPT_CACHE_RETENTION_MEASURED_LOWER_BOUND_BY_AGENT_ID,
	type CodingAgentPromptCacheRetentionMeasuredLowerBound,
} from "./coding-agent-prompt-cache-retention-measured-ttl-lower-bounds";

// 跨项目「最近活跃任务」切换面板的区归属（领域词汇见 docs/context-cross-project-recently-active-task-switcher.md）。
//
// 四个区自上而下：Pinned → Running → Cache warm · your turn → Recent。
// Pinned 允许与主分组重复；主分组按 Running > Cache warm > Recent 互斥归属。
// Running 只看可信 Agent 回合、进程存活或明确后台等待，不读 PTY 输出新鲜度。
// Recent 包含所有阶段，统一按最近触达截取 7 / 30 天，再应用阶段多选与排序。
// Cache warm 继续只收 In progress / Review，避免提醒用户接续已交付验证或完成的对话。
//
// 纯函数，前后端共用（web-ui 经 @runtime-cross-project-recently-active-task-switcher-section-assignment 引用）。

// 也是 projects_updated 广播的取景时间窗（workspace-registry 用它算广播条目；前端合并快照时按同一窗口判取景范围）。
export const CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS = 7 * 24 * 60 * 60_000;
// 「显示更早」把剩余区的时间窗放宽到这里；服务端按需查询同一窗口（不进广播，见 projects-api）。
export const CROSS_PROJECT_TASK_SWITCHER_EXTENDED_REMAINING_SECTION_ACTIVITY_HORIZON_MS = 30 * 24 * 60 * 60_000;
export type CrossProjectTaskSwitcherRemainingSectionOrderingMode =
	// ① 统一「最后被碰」：max(对话推进, 我最后打开, Description 编辑)。
	| "most_recently_touched_by_conversation_progress_or_user_open_or_description_edit"
	// ② 按对话推进（与 Spotlight「Agent activity」同源）；无记录的任务置后，按 Description 更新时间倒序。
	| "most_recent_conversation_progress_only";

export const CROSS_PROJECT_TASK_SWITCHER_REMAINING_SECTION_ORDERING_MODES: readonly CrossProjectTaskSwitcherRemainingSectionOrderingMode[] =
	[
		"most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
		"most_recent_conversation_progress_only",
	];

export interface CrossProjectTaskSwitcherEntryInProject {
	workspaceId: string;
	projectName: string;
	entry: RuntimeCrossProjectTaskSwitcherEntry;
}

export type CrossProjectTaskSwitcherPromptCacheWarmthAnchorSource =
	| "main_agent_conversation_model_request_dispatch_observation"
	// 手动 /compact 完成后、还没有新请求：对话层已被摘要替换。行上不显示倒计时，改显示「已压缩」。
	| "manual_compaction_replaced_main_conversation_without_follow_up_request"
	| "cursor_agent_output_cache_reference_estimate"
	| "main_agent_conversation_request_processing_cache_reference_estimate"
	| "last_substantive_agent_terminal_output";

export interface CrossProjectTaskSwitcherPromptCacheWarmthEstimate {
	// 计时起点来自请求专用投影；Cursor 使用单独标识的新输出近似。
	promptCacheWarmthAnchorAt: number;
	// 起点读自哪个信号；倒计时药丸的 tooltip 据此说明。
	promptCacheWarmthAnchorSource: CrossProjectTaskSwitcherPromptCacheWarmthAnchorSource;
	// 区归属与排序用的失效时刻。起点是手动压缩时它只决定「在区里留多久」，行上不显示倒计时。
	promptCacheExpectedExpiryAt: number;
	// 仅起点是手动压缩、且 harness 报了压缩后上下文大小时有值（行上显示「回复需重写约 N k」）。
	mainAgentConversationContextTokenCountAfterCompactionReportedByHarness?: number;
}

export interface CrossProjectTaskSwitcherPromptCacheWarmEntryInProject extends CrossProjectTaskSwitcherEntryInProject {
	promptCacheWarmthEstimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate;
}

export interface CrossProjectTaskSwitcherRemainingEntryInProject extends CrossProjectTaskSwitcherEntryInProject {
	remainingSectionOrderingKeyAt: number;
}

export type CrossProjectTaskSwitcherRecentTaskStageFilter =
	| "in_progress_and_review"
	| "backlog"
	| "validation"
	| "done";

export interface CrossProjectTaskSwitcherRemainingSection {
	orderingMode: CrossProjectTaskSwitcherRemainingSectionOrderingMode;
	entries: CrossProjectTaskSwitcherRemainingEntryInProject[];
}

export interface CrossProjectTaskSwitcherSections {
	pinnedEntries: CrossProjectTaskSwitcherEntryInProject[];
	runningEntries: CrossProjectTaskSwitcherEntryInProject[];
	promptCacheWarmAwaitingUserEntries: CrossProjectTaskSwitcherPromptCacheWarmEntryInProject[];
	remainingSection: CrossProjectTaskSwitcherRemainingSection;
}

export interface AssignCrossProjectTaskSwitcherSectionsInput {
	entriesInProjects: readonly CrossProjectTaskSwitcherEntryInProject[];
	nowMs: number;
	remainingSectionOrderingMode: CrossProjectTaskSwitcherRemainingSectionOrderingMode;
	remainingSectionActivityHorizonMs: number;
	// 空选择表示 All；多个阶段取并集，不影响 Running / Cache warm / Pinned。
	selectedRecentTaskStageFilters?: readonly CrossProjectTaskSwitcherRecentTaskStageFilter[];
	// 空选择表示所有项目；使用 workspaceId 避免同名项目或同号任务串组。
	selectedRecentProjectWorkspaceIds?: readonly string[];
	// 测试注入用；缺省为实测表。
	promptCacheRetentionMeasuredLowerBoundByAgentId?: Readonly<
		Partial<Record<RuntimeAgentId, CodingAgentPromptCacheRetentionMeasuredLowerBound>>
	>;
}

// taskId 跨项目会撞号，任何跨项目集合一律以 (workspaceId, taskId) 作键。格式与通知中心的组键一致。
export function buildCrossProjectTaskSwitcherEntryKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

export function isCrossProjectTaskSwitcherEntryRunning(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		"turnOwner" | "liveness" | "isParkedAwaitingDispatchedBackgroundWork"
	>,
	_nowMs: number,
): boolean {
	if (entry.turnOwner !== "agent") {
		return false;
	}
	// 静默、转圈和重绘均不能证明回合结束。存活性由运行时负责，明确 park 仍由 agent 持有回合。
	return entry.liveness === "live" || entry.isParkedAwaitingDispatchedBackgroundWork;
}

// Cache warm 区只收「还等着人回复 agent」的列：In progress / Review。用户把任务移进 Validation（交给验证）或
// Done，就是表态「这一轮对话我不打算再接」，此时缓存还热也没有提醒的意义（2026-10-04 用户反馈）。Backlog 没有
// 会话锚点，本来就进不来。阶段资格维持既有口径；Recent 的阶段筛选同样按 board 列读取。
export function isTaskCardBoardColumnEligibleForPromptCacheWarmAwaitingUserSection(
	columnId: RuntimeCrossProjectTaskSwitcherEntry["columnId"],
): boolean {
	return columnId === "in_progress" || columnId === "review";
}

// Running 区的排序输入。
export type RunningSectionArrivalOrderingFacts = Pick<
	RuntimeInProgressTaskDetail,
	"agentResponseGenerationTurnStarted"
> &
	Partial<Pick<RuntimeCrossProjectTaskSwitcherEntry, "agentProcessStartedAt">>;

// 「它是什么时候进入 Running 的」：本轮 agent 回合的开始时刻；旧 runtime 没有这个字段时回落到 agent 进程
// 启动时刻；两者都没有就排到末尾（+∞）。刻意不读 lastOutputAt——spinner 每次重绘都推进它，按它排会让
// 成员没变的 Running 区每秒重排（2026-10-04 实测相邻样本 30/38 次顺序变化）。
export function resolveRunningSectionArrivalOrderingKeyAt(facts: RunningSectionArrivalOrderingFacts): number {
	return (
		facts.agentResponseGenerationTurnStarted?.startedAt ?? facts.agentProcessStartedAt ?? Number.POSITIVE_INFINITY
	);
}

// 先进入的在前、后进入的在后；同一时刻按稳定键兜底，保证确定性。按调用方的条目形状产出比较器：
// 切换面板的条目跨项目，稳定键必须是 (workspaceId, taskId)。
export function createComparatorByCurrentAgentTurnStartAscendingThenStableKey<TItem>(
	resolveOrderingFacts: (item: TItem) => RunningSectionArrivalOrderingFacts,
	resolveStableKey: (item: TItem) => string,
): (left: TItem, right: TItem) => number {
	return (left, right) => {
		const leftOrderingKeyAt = resolveRunningSectionArrivalOrderingKeyAt(resolveOrderingFacts(left));
		const rightOrderingKeyAt = resolveRunningSectionArrivalOrderingKeyAt(resolveOrderingFacts(right));
		if (leftOrderingKeyAt !== rightOrderingKeyAt) {
			// 不用减法：两侧都是 +∞ 时差为 NaN。
			return leftOrderingKeyAt < rightOrderingKeyAt ? -1 : 1;
		}
		return resolveStableKey(left).localeCompare(resolveStableKey(right));
	};
}

export const compareRunningSectionEntriesByCurrentAgentTurnStartAscendingThenStableKey =
	createComparatorByCurrentAgentTurnStartAscendingThenStableKey<CrossProjectTaskSwitcherEntryInProject>(
		(entryInProject) => entryInProject.entry,
		(entryInProject) =>
			buildCrossProjectTaskSwitcherEntryKey(entryInProject.workspaceId, entryInProject.entry.taskId),
	);

// 主 agent 没在持有回合、且主对话的 prompt cache 估计仍热时返回估算；否则 null。**不看是否已读**：读过但
// 没回复的任务，缓存照样在流失。
//
// 资格按缓存所在位置分两类（见 CodingAgentPromptCacheRetentionScope）：
//   - 服务端缓存（Claude / Cursor）：只要求 turnOwner !== "agent"。不要求「可通知的用户回合」——runtime
//     重启、会话被回收后 facet 变成 none，但服务端缓存照样热，用户此刻回复照样命中。
//   - 同进程缓存（Codex / Kimi）：要求 agent 进程还活着，且起点不早于当前进程的启动时刻——恢复出来的
//     新进程拿不到旧进程的缓存。
export function estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		| "turnOwner"
		| "liveness"
		| "agentId"
		| "lastSubstantiveOutputAt"
		| "lastMainAgentConversationModelRequestDispatchObservation"
		| "lastAgentConversationPromptCacheReferenceObservation"
		| "agentProcessStartedAt"
	>,
	nowMs: number,
	promptCacheRetentionMeasuredLowerBoundByAgentId: Readonly<
		Partial<Record<RuntimeAgentId, CodingAgentPromptCacheRetentionMeasuredLowerBound>>
	> = CODING_AGENT_PROMPT_CACHE_RETENTION_MEASURED_LOWER_BOUND_BY_AGENT_ID,
): CrossProjectTaskSwitcherPromptCacheWarmthEstimate | null {
	if (entry.turnOwner === "agent") {
		return null;
	}
	const measuredLowerBound = entry.agentId
		? promptCacheRetentionMeasuredLowerBoundByAgentId[entry.agentId]
		: undefined;
	if (!measuredLowerBound) {
		return null;
	}
	const isPromptCacheLostWhenAgentProcessExits =
		measuredLowerBound.promptCacheRetentionScope === "same_agent_process_only_cache_lost_when_agent_process_exits";
	if (isPromptCacheLostWhenAgentProcessExits && entry.liveness !== "live") {
		return null;
	}
	const anchor = resolveMainAgentConversationPromptCacheWarmthAnchor(entry, measuredLowerBound);
	if (anchor === null) {
		return null;
	}
	if (
		isPromptCacheLostWhenAgentProcessExits &&
		(entry.agentProcessStartedAt == null || anchor.promptCacheWarmthAnchorAt < entry.agentProcessStartedAt)
	) {
		return null;
	}
	const promptCacheExpectedExpiryAt =
		anchor.promptCacheWarmthAnchorAt + measuredLowerBound.promptCacheRetentionTtlLowerBoundMs;
	if (nowMs >= promptCacheExpectedExpiryAt) {
		return null;
	}
	return { ...anchor, promptCacheExpectedExpiryAt };
}

// 缓存只读取请求专用参考。真实交棒、进程恢复和普通活动都不能补满缓存期限。
function resolveMainAgentConversationPromptCacheWarmthAnchor(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		| "lastSubstantiveOutputAt"
		| "lastMainAgentConversationModelRequestDispatchObservation"
		| "lastAgentConversationPromptCacheReferenceObservation"
	>,
	measuredLowerBound: CodingAgentPromptCacheRetentionMeasuredLowerBound,
): Omit<CrossProjectTaskSwitcherPromptCacheWarmthEstimate, "promptCacheExpectedExpiryAt"> | null {
	const cacheReferenceObservation = resolveLastAgentConversationPromptCacheReferenceObservation(entry);
	if (
		measuredLowerBound.promptCacheWarmthAnchorSignal === "main_agent_conversation_model_request_dispatch_hook_events"
	) {
		const dispatchObservation = cacheReferenceObservation;
		if (
			dispatchObservation?.evidenceKind ===
			"manual_compact_command_completed_main_conversation_prompt_cache_replaced_without_follow_up_request"
		) {
			// 手动压缩完成（2026-10-05 用户拍板 B′）：任务留在 Cache warm 区，但行上不显示倒计时，改显示「已压缩，
			// 回复需重写」。实测压缩请求只按 5 分钟档读了被替换前的旧前缀，下一条回复不论早晚都要重写 86k–103k，
			// 「又热了 55 分钟」会误导，所以压缩观测采用独立的展示来源。
			// EXPERIMENT_NODE: 手动压缩后 Cache warm 取舍（A 续期 / B 退出 / B′ 留区显示「已压缩」，当前 B′）及留区时长（当前按该 agent 的 TTL 下界，可改 5 分钟档）
			return {
				promptCacheWarmthAnchorAt: dispatchObservation.observedAtMs,
				promptCacheWarmthAnchorSource: "manual_compaction_replaced_main_conversation_without_follow_up_request",
				...(dispatchObservation.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness !== undefined
					? {
							mainAgentConversationContextTokenCountAfterCompactionReportedByHarness:
								dispatchObservation.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness,
						}
					: {}),
			};
		}
		if (dispatchObservation) {
			return {
				promptCacheWarmthAnchorAt: dispatchObservation.observedAtMs,
				promptCacheWarmthAnchorSource:
					dispatchObservation.evidenceKind === "cursor_agent_output_cache_reference_estimate" ||
					dispatchObservation.evidenceKind ===
						"main_agent_conversation_request_processing_cache_reference_estimate"
						? dispatchObservation.evidenceKind
						: "main_agent_conversation_model_request_dispatch_observation",
			};
		}
	} else if (cacheReferenceObservation != null) {
		return {
			promptCacheWarmthAnchorAt: cacheReferenceObservation.observedAtMs,
			promptCacheWarmthAnchorSource: "cursor_agent_output_cache_reference_estimate",
		};
	}
	return null;
}

// 模式 ① 的排序键：三个「人或对话真正碰过它」的时刻取最大。刻意**不**用 card.updatedAt——
// 列自动流转移列也会推进它，打开一个列滞后的项目时会一次性把一批卡顶上来。
export function resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		| "lastConversationProgressObservation"
		| "lastEffectiveAgentConversationActivityObservation"
		| "lastOpenedByUserAt"
		| "taskDescriptionLastUpdatedAt"
	>,
): number {
	return Math.max(
		resolveLastEffectiveAgentConversationActivityObservation(entry)?.observedAtMs ?? 0,
		entry.lastOpenedByUserAt ?? 0,
		entry.taskDescriptionLastUpdatedAt,
	);
}

// 取景判据由服务端投影与前端扩展快照合并共用。置顶和 agent 回合可越过时间窗；
// 其余所有阶段（包括 Backlog 与内部列名 trash 对应的 Done）统一按最近触达限定范围。
// 停止生成不是对话推进，不能让旧任务因会话恢复重新进入 Recent。
export function isTaskCardWithinCrossProjectTaskSwitcherActivityScope(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		| "pinnedToTaskPinboardAt"
		| "columnId"
		| "turnOwner"
		| "agentResponseGenerationStopped"
		| "lastConversationProgressObservation"
		| "lastEffectiveAgentConversationActivityObservation"
		| "lastAgentConversationUserHandoffObservation"
		| "lastOpenedByUserAt"
		| "taskDescriptionLastUpdatedAt"
	>,
	activityHorizonStartAt: number,
): boolean {
	if (entry.pinnedToTaskPinboardAt !== null) {
		return true;
	}
	if (entry.turnOwner === "agent") {
		return true;
	}
	return resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(entry) >= activityHorizonStartAt;
}

function compareRecentEntriesByOrderingTimestampDescendingWithDescriptionFallbackThenStableKey(
	left: CrossProjectTaskSwitcherRemainingEntryInProject,
	right: CrossProjectTaskSwitcherRemainingEntryInProject,
): number {
	if (right.remainingSectionOrderingKeyAt !== left.remainingSectionOrderingKeyAt) {
		return right.remainingSectionOrderingKeyAt - left.remainingSectionOrderingKeyAt;
	}
	// 只有 Conversation progress 的无记录条目使用 -∞。保留它们落在有记录任务之后的语义，
	// 再按 Description 更新时间排序；最近打开和创建时间均不参与兜底。
	if (left.remainingSectionOrderingKeyAt === Number.NEGATIVE_INFINITY) {
		const descriptionLastUpdatedAtDifference =
			right.entry.taskDescriptionLastUpdatedAt - left.entry.taskDescriptionLastUpdatedAt;
		if (descriptionLastUpdatedAtDifference !== 0) {
			return descriptionLastUpdatedAtDifference;
		}
	}
	return buildCrossProjectTaskSwitcherEntryKey(left.workspaceId, left.entry.taskId).localeCompare(
		buildCrossProjectTaskSwitcherEntryKey(right.workspaceId, right.entry.taskId),
	);
}

function assignRemainingSection(
	remainingCandidates: readonly CrossProjectTaskSwitcherEntryInProject[],
	input: AssignCrossProjectTaskSwitcherSectionsInput,
): CrossProjectTaskSwitcherRemainingSection {
	const activityHorizonStartAt = input.nowMs - input.remainingSectionActivityHorizonMs;
	const selectedStageFilters = input.selectedRecentTaskStageFilters ?? [];
	const entries = remainingCandidates
		.filter(({ workspaceId, entry }) => {
			if (
				input.selectedRecentProjectWorkspaceIds?.length &&
				!input.selectedRecentProjectWorkspaceIds.includes(workspaceId)
			) {
				return false;
			}
			if (resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(entry) < activityHorizonStartAt) {
				return false;
			}
			return (
				selectedStageFilters.length === 0 ||
				selectedStageFilters.some((stageFilter) => {
					if (stageFilter === "in_progress_and_review") {
						return entry.columnId === "in_progress" || entry.columnId === "review";
					}
					return entry.columnId === (stageFilter === "done" ? "trash" : stageFilter);
				})
			);
		})
		.map((entryInProject) => ({
			...entryInProject,
			remainingSectionOrderingKeyAt:
				input.remainingSectionOrderingMode === "most_recent_conversation_progress_only"
					? (resolveLastEffectiveAgentConversationActivityObservation(entryInProject.entry)?.observedAtMs ??
						Number.NEGATIVE_INFINITY)
					: resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(entryInProject.entry),
		}))
		.sort(compareRecentEntriesByOrderingTimestampDescendingWithDescriptionFallbackThenStableKey);
	return { orderingMode: input.remainingSectionOrderingMode, entries };
}

export function assignCrossProjectTaskSwitcherSections(
	input: AssignCrossProjectTaskSwitcherSectionsInput,
): CrossProjectTaskSwitcherSections {
	const pinnedEntries: CrossProjectTaskSwitcherEntryInProject[] = [];
	const runningEntries: CrossProjectTaskSwitcherEntryInProject[] = [];
	const promptCacheWarmAwaitingUserEntries: CrossProjectTaskSwitcherPromptCacheWarmEntryInProject[] = [];
	const remainingCandidates: CrossProjectTaskSwitcherEntryInProject[] = [];
	for (const entryInProject of input.entriesInProjects) {
		const { entry } = entryInProject;
		if (entry.pinnedToTaskPinboardAt !== null) {
			pinnedEntries.push(entryInProject);
		}
		if (isCrossProjectTaskSwitcherEntryRunning(entry, input.nowMs)) {
			runningEntries.push(entryInProject);
			continue;
		}
		if (!isTaskCardBoardColumnEligibleForPromptCacheWarmAwaitingUserSection(entry.columnId)) {
			// 非 In progress / Review 的任务不进 Cache warm，交给 Recent 的统一时间窗与阶段筛选。
			remainingCandidates.push(entryInProject);
			continue;
		}
		const promptCacheWarmthEstimate = estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn(
			entry,
			input.nowMs,
			input.promptCacheRetentionMeasuredLowerBoundByAgentId,
		);
		if (promptCacheWarmthEstimate) {
			promptCacheWarmAwaitingUserEntries.push({ ...entryInProject, promptCacheWarmthEstimate });
			continue;
		}
		remainingCandidates.push(entryInProject);
	}
	pinnedEntries.sort(
		(left, right) =>
			(right.entry.pinnedToTaskPinboardAt ?? 0) - (left.entry.pinnedToTaskPinboardAt ?? 0) ||
			buildCrossProjectTaskSwitcherEntryKey(left.workspaceId, left.entry.taskId).localeCompare(
				buildCrossProjectTaskSwitcherEntryKey(right.workspaceId, right.entry.taskId),
			),
	);
	// Running 内先进入的在前、后进入的在后；顺序只在回合边沿变化，不随 agent 输出抖动。
	runningEntries.sort(compareRunningSectionEntriesByCurrentAgentTurnStartAscendingThenStableKey);
	// 最快失效的排最前；同一失效时刻按键兜底。
	promptCacheWarmAwaitingUserEntries.sort(
		(left, right) =>
			left.promptCacheWarmthEstimate.promptCacheExpectedExpiryAt -
				right.promptCacheWarmthEstimate.promptCacheExpectedExpiryAt ||
			buildCrossProjectTaskSwitcherEntryKey(left.workspaceId, left.entry.taskId).localeCompare(
				buildCrossProjectTaskSwitcherEntryKey(right.workspaceId, right.entry.taskId),
			),
	);
	return {
		pinnedEntries,
		runningEntries,
		promptCacheWarmAwaitingUserEntries,
		remainingSection: assignRemainingSection(remainingCandidates, input),
	};
}
