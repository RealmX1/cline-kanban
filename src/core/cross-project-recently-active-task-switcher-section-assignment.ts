import type { RuntimeAgentId, RuntimeCrossProjectTaskSwitcherEntry, RuntimeInProgressTaskDetail } from "./api-contract";
import {
	CODING_AGENT_PROMPT_CACHE_RETENTION_MEASURED_LOWER_BOUND_BY_AGENT_ID,
	type CodingAgentPromptCacheRetentionMeasuredLowerBound,
} from "./coding-agent-prompt-cache-retention-measured-ttl-lower-bounds";
import { isAgentOutputWithinActiveWindow, RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS } from "./session-activity";

// 跨项目「最近活跃任务」切换面板的区归属（领域词汇见 docs/context-cross-project-recently-active-task-switcher.md）。
//
// 五个区自上而下：
//   Pinned                      —— 各项目 Task Pinboard 的汇总。**允许**与下面四区重复。
//   Backlog                     —— 各项目的完整待办，不受时间窗限制；按 Description 更新时间倒序。
//   Running                     —— agent 正持有回合且近 5 分钟有输出，或已 park 在等自己派发的后台工作；按本轮
//                                  agent 回合开始时刻升序（后来的放后面），不随输出抖动。
//   Cache warm · your turn      —— agent 没在持有回合、且按 agent 的实测 TTL 估算主对话 prompt cache 仍热；按失效时刻升序。
//   剩余区                       —— 其余全部，三种排序模式可切换。
// 下面四区**互斥**，Backlog 按列优先归属，其余优先级 Running > 缓存倒计时 > 剩余。
// 其余区归属只读 session facet 与时间戳（例外：排除 Done；Validation 不进缓存倒计时区）：列自动流转只在打开着该项目的浏览器里跑，没人看的项目列会滞后。
//
// 纯函数，前后端共用（web-ui 经 @runtime-cross-project-recently-active-task-switcher-section-assignment 引用）。

// 也是 projects_updated 广播的取景时间窗（workspace-registry 用它算广播条目；前端合并快照时按同一窗口判取景范围）。
export const CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS = 7 * 24 * 60 * 60_000;
// 「显示更早」把剩余区的时间窗放宽到这里；服务端按需查询同一窗口（不进广播，见 projects-api）。
export const CROSS_PROJECT_TASK_SWITCHER_EXTENDED_REMAINING_SECTION_ACTIVITY_HORIZON_MS = 30 * 24 * 60 * 60_000;
// 模式 ② 里「我最近打开」子区的条数上限。
// EXPERIMENT_NODE: 「我最近打开」子区取 10 条；太少会漏掉刚切走的任务，太多又回到「列表太长」。
export const CROSS_PROJECT_TASK_SWITCHER_RECENTLY_OPENED_BY_USER_SUBSECTION_MAXIMUM_ENTRY_COUNT = 10;

export type CrossProjectTaskSwitcherRemainingSectionOrderingMode =
	// ① 统一「最后被碰」：max(对话推进, 我最后打开, Description 编辑)。
	| "most_recently_touched_by_conversation_progress_or_user_open_or_description_edit"
	// ② 未读交接 + 我最近打开，两个子区。
	| "unread_handoffs_then_recently_opened_by_user"
	// ③ 只按对话推进（与 Spotlight「Agent activity」同源）。
	| "most_recent_conversation_progress_only";

export const CROSS_PROJECT_TASK_SWITCHER_REMAINING_SECTION_ORDERING_MODES: readonly CrossProjectTaskSwitcherRemainingSectionOrderingMode[] =
	[
		"most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
		"unread_handoffs_then_recently_opened_by_user",
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
	| "last_substantive_agent_terminal_output";

export interface CrossProjectTaskSwitcherPromptCacheWarmthEstimate {
	// 计时起点：主对话最后一次向模型发请求的时刻；Cursor 用实质终端输出。
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

export type CrossProjectTaskSwitcherRemainingSection =
	| {
			orderingMode:
				| "most_recently_touched_by_conversation_progress_or_user_open_or_description_edit"
				| "most_recent_conversation_progress_only";
			entries: CrossProjectTaskSwitcherRemainingEntryInProject[];
	  }
	| {
			orderingMode: "unread_handoffs_then_recently_opened_by_user";
			unreadHandoffEntries: CrossProjectTaskSwitcherRemainingEntryInProject[];
			recentlyOpenedByUserEntries: CrossProjectTaskSwitcherRemainingEntryInProject[];
	  };

export interface CrossProjectTaskSwitcherSections {
	pinnedEntries: CrossProjectTaskSwitcherEntryInProject[];
	backlogEntries: CrossProjectTaskSwitcherEntryInProject[];
	runningEntries: CrossProjectTaskSwitcherEntryInProject[];
	promptCacheWarmAwaitingUserEntries: CrossProjectTaskSwitcherPromptCacheWarmEntryInProject[];
	remainingSection: CrossProjectTaskSwitcherRemainingSection;
}

export interface AssignCrossProjectTaskSwitcherSectionsInput {
	entriesInProjects: readonly CrossProjectTaskSwitcherEntryInProject[];
	nowMs: number;
	remainingSectionOrderingMode: CrossProjectTaskSwitcherRemainingSectionOrderingMode;
	remainingSectionActivityHorizonMs: number;
	// 有未读通知（visitedAt 为空）的任务键，见 buildCrossProjectTaskSwitcherEntryKey。
	unreadHandoffEntryKeys: ReadonlySet<string>;
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
		"turnOwner" | "lastOutputAt" | "isParkedAwaitingDispatchedBackgroundWork"
	>,
	nowMs: number,
): boolean {
	if (entry.turnOwner !== "agent") {
		return false;
	}
	// 读 lastOutputAt（含 spinner 重绘）：spinner 期应算在跑。
	return (
		entry.isParkedAwaitingDispatchedBackgroundWork ||
		isAgentOutputWithinActiveWindow(entry.lastOutputAt, nowMs, RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS)
	);
}

// Cache warm 区只收「还等着人回复 agent」的列：In progress / Review。用户把任务移进 Validation（交给验证）或
// Done，就是表态「这一轮对话我不打算再接」，此时缓存还热也没有提醒的意义（2026-10-04 用户反馈）。Backlog 没有
// 会话锚点，本来就进不来。这是区归属里唯二读 board 列的地方（另一处是排除 Done），列滞后的代价只是晚一点下放。
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

// 倒计时起点。**绝不读 agentResponseGenerationStopped**：会话恢复（换 incarnation）也算一次「停止生成」
// 边沿，起点会被刷成恢复时刻（2026-10-03 实测偏差 11~21 小时），runtime 重启后它又被清空。
function resolveMainAgentConversationPromptCacheWarmthAnchor(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		"lastSubstantiveOutputAt" | "lastMainAgentConversationModelRequestDispatchObservation"
	>,
	measuredLowerBound: CodingAgentPromptCacheRetentionMeasuredLowerBound,
): Omit<CrossProjectTaskSwitcherPromptCacheWarmthEstimate, "promptCacheExpectedExpiryAt"> | null {
	if (
		measuredLowerBound.promptCacheWarmthAnchorSignal === "main_agent_conversation_model_request_dispatch_hook_events"
	) {
		const dispatchObservation = entry.lastMainAgentConversationModelRequestDispatchObservation;
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
				promptCacheWarmthAnchorSource: "main_agent_conversation_model_request_dispatch_observation",
			};
		}
	} else if (entry.lastSubstantiveOutputAt != null) {
		return {
			promptCacheWarmthAnchorAt: entry.lastSubstantiveOutputAt,
			promptCacheWarmthAnchorSource: "last_substantive_agent_terminal_output",
		};
	}
	return null;
}

// 模式 ① 的排序键：三个「人或对话真正碰过它」的时刻取最大。刻意**不**用 card.updatedAt——
// 列自动流转移列也会推进它，打开一个列滞后的项目时会一次性把一批卡顶上来。
export function resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		"lastConversationProgressObservation" | "lastOpenedByUserAt" | "taskDescriptionLastUpdatedAt"
	>,
): number {
	return Math.max(
		entry.lastConversationProgressObservation?.observedAtMs ?? 0,
		entry.lastOpenedByUserAt ?? 0,
		entry.taskDescriptionLastUpdatedAt,
	);
}

// 取景判据（哪些卡进条目列表）——服务端投影与前端合并共用的**单一判据**，两侧不得各写一份。
// 刻意比面板任何一个区都宽、但有上界：
//   - 已置顶的卡，不论在哪一列（Pinned 区是各项目 Pinboard 的汇总，Pinboard 本身也收 Done 列的卡）；
//   - Backlog 全量进入，不受时间窗限制；
//   - 其余只取非 Done 列，且满足其一：agent 正持有回合（Running 候选，turnOwner==="agent" 蕴含活进程），
//     或「最后被碰」/ 本轮停止生成的时刻落在时间窗内。
// 服务端：广播用默认 7 天窗、「显示更早」用 30 天窗。前端：「显示更早」快照里落在**广播**取景范围内、
// 却不在广播里的条目说明已失效（取消置顶 / 移入 Done / 已删除），不得按快照旧状态补回。
export function isTaskCardWithinCrossProjectTaskSwitcherActivityScope(
	entry: Pick<
		RuntimeCrossProjectTaskSwitcherEntry,
		| "pinnedToTaskPinboardAt"
		| "columnId"
		| "turnOwner"
		| "agentResponseGenerationStopped"
		| "lastConversationProgressObservation"
		| "lastOpenedByUserAt"
		| "taskDescriptionLastUpdatedAt"
	>,
	activityHorizonStartAt: number,
): boolean {
	if (entry.pinnedToTaskPinboardAt !== null) {
		return true;
	}
	if (entry.columnId === "trash") {
		return false;
	}
	// Backlog 是完整待办列表，不受近期活动时间窗限制；前端快照合并也用此判据避免复活旧条目。
	if (entry.columnId === "backlog") {
		return true;
	}
	if (entry.turnOwner === "agent") {
		return true;
	}
	return (
		resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(entry) >= activityHorizonStartAt ||
		(entry.agentResponseGenerationStopped?.stoppedAt ?? 0) >= activityHorizonStartAt
	);
}

function compareByOrderingKeyDescendingThenStableKey(
	left: CrossProjectTaskSwitcherRemainingEntryInProject,
	right: CrossProjectTaskSwitcherRemainingEntryInProject,
): number {
	if (right.remainingSectionOrderingKeyAt !== left.remainingSectionOrderingKeyAt) {
		return right.remainingSectionOrderingKeyAt - left.remainingSectionOrderingKeyAt;
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
	switch (input.remainingSectionOrderingMode) {
		case "most_recently_touched_by_conversation_progress_or_user_open_or_description_edit": {
			const entries = remainingCandidates
				.map((entryInProject) => ({
					...entryInProject,
					remainingSectionOrderingKeyAt: resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(
						entryInProject.entry,
					),
				}))
				.filter((entryInProject) => entryInProject.remainingSectionOrderingKeyAt >= activityHorizonStartAt)
				.sort(compareByOrderingKeyDescendingThenStableKey);
			return { orderingMode: input.remainingSectionOrderingMode, entries };
		}
		case "most_recent_conversation_progress_only": {
			const entries: CrossProjectTaskSwitcherRemainingEntryInProject[] = [];
			for (const entryInProject of remainingCandidates) {
				const observedAtMs = entryInProject.entry.lastConversationProgressObservation?.observedAtMs;
				if (observedAtMs === undefined || observedAtMs < activityHorizonStartAt) {
					continue;
				}
				entries.push({ ...entryInProject, remainingSectionOrderingKeyAt: observedAtMs });
			}
			return {
				orderingMode: input.remainingSectionOrderingMode,
				entries: entries.sort(compareByOrderingKeyDescendingThenStableKey),
			};
		}
		case "unread_handoffs_then_recently_opened_by_user": {
			const unreadHandoffEntries: CrossProjectTaskSwitcherRemainingEntryInProject[] = [];
			const recentlyOpenedByUserEntries: CrossProjectTaskSwitcherRemainingEntryInProject[] = [];
			for (const entryInProject of remainingCandidates) {
				const entryKey = buildCrossProjectTaskSwitcherEntryKey(
					entryInProject.workspaceId,
					entryInProject.entry.taskId,
				);
				if (input.unreadHandoffEntryKeys.has(entryKey)) {
					unreadHandoffEntries.push({
						...entryInProject,
						remainingSectionOrderingKeyAt: resolveMostRecentlyTouchedAtForCrossProjectTaskSwitcherEntry(
							entryInProject.entry,
						),
					});
					continue;
				}
				const lastOpenedByUserAt = entryInProject.entry.lastOpenedByUserAt;
				if (lastOpenedByUserAt !== null && lastOpenedByUserAt >= activityHorizonStartAt) {
					recentlyOpenedByUserEntries.push({
						...entryInProject,
						remainingSectionOrderingKeyAt: lastOpenedByUserAt,
					});
				}
			}
			return {
				orderingMode: input.remainingSectionOrderingMode,
				unreadHandoffEntries: unreadHandoffEntries.sort(compareByOrderingKeyDescendingThenStableKey),
				recentlyOpenedByUserEntries: recentlyOpenedByUserEntries
					.sort(compareByOrderingKeyDescendingThenStableKey)
					.slice(0, CROSS_PROJECT_TASK_SWITCHER_RECENTLY_OPENED_BY_USER_SUBSECTION_MAXIMUM_ENTRY_COUNT),
			};
		}
	}
}

export function assignCrossProjectTaskSwitcherSections(
	input: AssignCrossProjectTaskSwitcherSectionsInput,
): CrossProjectTaskSwitcherSections {
	const pinnedEntries: CrossProjectTaskSwitcherEntryInProject[] = [];
	const backlogEntries: CrossProjectTaskSwitcherEntryInProject[] = [];
	const runningEntries: CrossProjectTaskSwitcherEntryInProject[] = [];
	const promptCacheWarmAwaitingUserEntries: CrossProjectTaskSwitcherPromptCacheWarmEntryInProject[] = [];
	const remainingCandidates: CrossProjectTaskSwitcherEntryInProject[] = [];
	for (const entryInProject of input.entriesInProjects) {
		const { entry } = entryInProject;
		if (entry.pinnedToTaskPinboardAt !== null) {
			pinnedEntries.push(entryInProject);
		}
		if (entry.columnId === "trash") {
			continue;
		}
		if (entry.columnId === "backlog") {
			backlogEntries.push(entryInProject);
			continue;
		}
		if (isCrossProjectTaskSwitcherEntryRunning(entry, input.nowMs)) {
			runningEntries.push(entryInProject);
			continue;
		}
		if (!isTaskCardBoardColumnEligibleForPromptCacheWarmAwaitingUserSection(entry.columnId)) {
			// 已移入 Validation 的任务即使缓存仍热也不进 Cache warm，交给剩余区按它的排序模式与时间窗决定显不显示。
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
	backlogEntries.sort(
		(left, right) =>
			right.entry.taskDescriptionLastUpdatedAt - left.entry.taskDescriptionLastUpdatedAt ||
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
		backlogEntries,
		runningEntries,
		promptCacheWarmAwaitingUserEntries,
		remainingSection: assignRemainingSection(remainingCandidates, input),
	};
}
