import type { RuntimeAgentId, RuntimeCrossProjectTaskSwitcherEntry } from "./api-contract";
import {
	CODING_AGENT_PROMPT_CACHE_RETENTION_MEASURED_LOWER_BOUND_BY_AGENT_ID,
	type CodingAgentPromptCacheRetentionMeasuredLowerBound,
} from "./coding-agent-prompt-cache-retention-measured-ttl-lower-bounds";
import { isLowConfidenceLastConversationProgressEvidence } from "./last-conversation-progress-observation";
import { isAgentOutputWithinActiveWindow, RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS } from "./session-activity";

// 跨项目「最近活跃任务」切换面板的区归属（领域词汇见 docs/context-cross-project-recently-active-task-switcher.md）。
//
// 四个区自上而下：
//   Pinned                      —— 各项目 Task Pinboard 的汇总。**允许**与下面三区重复。
//   Running                     —— agent 正持有回合且近 5 分钟有输出，或已 park 在等自己派发的后台工作。
//   Cache warm · your turn      —— agent 没在持有回合、且按 agent 的实测 TTL 估算主对话 prompt cache 仍热；按失效时刻升序。
//   剩余区                       —— 其余全部，三种排序模式可切换。
// 下面三区**互斥**，优先级 Running > 缓存倒计时 > 剩余。区归属只读 session facet 与时间戳，**不读 board 列**
// （唯一例外是排除 Done）：列自动流转只在打开着该项目的浏览器里跑，没人看的项目列会滞后。
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
	| "last_substantive_agent_terminal_output"
	| "high_confidence_last_conversation_progress_observation_fallback";

export interface CrossProjectTaskSwitcherPromptCacheWarmthEstimate {
	// 计时起点：主对话最后一次向模型发请求的时刻（取不到时的回落见 resolveMainAgentConversationPromptCacheWarmthAnchor）。
	promptCacheWarmthAnchorAt: number;
	// 起点读自哪个信号；倒计时药丸的 tooltip 据此说明。
	promptCacheWarmthAnchorSource: CrossProjectTaskSwitcherPromptCacheWarmthAnchorSource;
	promptCacheExpectedExpiryAt: number;
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
	// 与 Board Overview 的 Active 同一判据（lastOutputAt 含 spinner 重绘，spinner 期应算在跑）。
	return (
		entry.isParkedAwaitingDispatchedBackgroundWork ||
		isAgentOutputWithinActiveWindow(entry.lastOutputAt, nowMs, RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS)
	);
}

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
		| "lastConversationProgressObservation"
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
		| "lastSubstantiveOutputAt"
		| "lastConversationProgressObservation"
		| "lastMainAgentConversationModelRequestDispatchObservation"
	>,
	measuredLowerBound: CodingAgentPromptCacheRetentionMeasuredLowerBound,
): Pick<
	CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
	"promptCacheWarmthAnchorAt" | "promptCacheWarmthAnchorSource"
> | null {
	if (
		measuredLowerBound.promptCacheWarmthAnchorSignal === "main_agent_conversation_model_request_dispatch_hook_events"
	) {
		const dispatchObservation = entry.lastMainAgentConversationModelRequestDispatchObservation;
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
	// 兜底：还没观测到过发请求事件的会话（本字段上线前最后一次请求的存量会话、hook 丢投）。对话推进
	// 观测略晚于真实请求（停止时刻、Notification 会把它往后推），所以只在没有更好信号时用；低置信的
	// TUI 猜测会被恢复重播刷成 now，不用。
	const progressObservation = entry.lastConversationProgressObservation;
	if (progressObservation && !isLowConfidenceLastConversationProgressEvidence(progressObservation.evidenceKind)) {
		return {
			promptCacheWarmthAnchorAt: progressObservation.observedAtMs,
			promptCacheWarmthAnchorSource: "high_confidence_last_conversation_progress_observation_fallback",
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
		if (isCrossProjectTaskSwitcherEntryRunning(entry, input.nowMs)) {
			runningEntries.push(entryInProject);
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
	// Running 内按最近输出倒序：刚刚还在吐字的排前面。
	runningEntries.sort((left, right) => (right.entry.lastOutputAt ?? 0) - (left.entry.lastOutputAt ?? 0));
	// 最快失效的排最前。
	promptCacheWarmAwaitingUserEntries.sort(
		(left, right) =>
			left.promptCacheWarmthEstimate.promptCacheExpectedExpiryAt -
			right.promptCacheWarmthEstimate.promptCacheExpectedExpiryAt,
	);
	return {
		pinnedEntries,
		runningEntries,
		promptCacheWarmAwaitingUserEntries,
		remainingSection: assignRemainingSection(remainingCandidates, input),
	};
}
