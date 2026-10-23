import { collectTaskConversationSessionActivityObservations } from "../core/agent-conversation-activity-observation";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeCrossProjectTaskSwitcherEntry,
} from "../core/api-contract";
import { resolveTaskDescriptionLastUpdatedAt } from "../core/backlog-task-description-last-updated-ordering";
import { isTaskCardWithinCrossProjectTaskSwitcherActivityScope } from "../core/cross-project-recently-active-task-switcher-section-assignment";
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";
import {
	buildTaskActivityDetailFromBoardCardAndTaskSessionFacts,
	resolveCurrentMainConversationTaskSessionFactsWithVerifiedCardOwnership,
	type TaskSessionFactsForCrossProjectTaskViews,
} from "./in-progress-task-detail-projection";

// 跨项目「最近活跃任务」切换面板的条目投影（docs/context-cross-project-recently-active-task-switcher.md）。
//
// 取景（哪些卡进 projects_updated 广播）的判据在 core 的 isTaskCardWithinCrossProjectTaskSwitcherActivityScope——
// 前端合并「显示更早」快照时用同一判据剔除已失效条目，故不在这里另写一份。
// 全 review 列有几百张卡，不设时间窗的话每 150ms 一次的广播会背着它们全量跑。时间窗外的卡由「显示更早」按需查询。
//
// 纯函数：无 I/O，now 由调用方注入。

function buildCrossProjectTaskSwitcherEntryFromBoardCard(
	card: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
	sessionFacts: TaskSessionFactsForCrossProjectTaskViews | undefined,
	lastOpenedByUserAt: number | null,
): RuntimeCrossProjectTaskSwitcherEntry {
	return {
		...buildTaskActivityDetailFromBoardCardAndTaskSessionFacts(card, sessionFacts),
		columnId,
		userTurnKind: sessionFacts?.userTurnKind ?? null,
		isParkedAwaitingDispatchedBackgroundWork: sessionFacts?.isParkedAwaitingDispatchedBackgroundWork ?? false,
		taskDescriptionLastUpdatedAt: resolveTaskDescriptionLastUpdatedAt(card),
		lastOpenedByUserAt,
		pinnedToTaskPinboardAt: card.pinnedToTaskPinboardAt ?? null,
		taskPinboardPinReason: card.taskPinboardPinReason ?? null,
		lastMainAgentConversationModelRequestDispatchObservation:
			sessionFacts?.lastMainAgentConversationModelRequestDispatchObservation ?? null,
		agentProcessStartedAt: sessionFacts?.agentProcessStartedAt ?? null,
		baseRef: card.baseRef,
		...(card.worktreeMode ? { worktreeMode: card.worktreeMode } : {}),
	};
}

export function collectCrossProjectTaskSwitcherEntriesFromBoard(input: {
	board: RuntimeBoardData;
	sessionFactsByTaskId: ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>;
	lastOpenedByUserAtByTaskId: ReadonlyMap<string, number>;
	nowMs: number;
	activityHorizonMs: number;
}): RuntimeCrossProjectTaskSwitcherEntry[] {
	const activityHorizonStartAt = input.nowMs - input.activityHorizonMs;
	const entries: RuntimeCrossProjectTaskSwitcherEntry[] = [];
	// 同一广播按 owner 只分组一次；避免每张卡都重新扫描全部 session。
	const sessionActivityFactsByOwningCardId = new Map<
		string,
		Array<TaskSessionFactsForCrossProjectTaskViews & { taskId: string }>
	>();
	for (const [taskId, facts] of input.sessionFactsByTaskId) {
		const owningCardId = facts.taskConversationSessionMetadata?.workspaceTaskId ?? taskId;
		const group = sessionActivityFactsByOwningCardId.get(owningCardId) ?? [];
		group.push({ taskId, ...facts });
		sessionActivityFactsByOwningCardId.set(owningCardId, group);
	}
	for (const column of input.board.columns) {
		for (const card of column.cards) {
			const entry = buildCrossProjectTaskSwitcherEntryFromBoardCard(
				card,
				column.id,
				resolveCurrentMainConversationTaskSessionFactsWithVerifiedCardOwnership(card, input.sessionFactsByTaskId),
				input.lastOpenedByUserAtByTaskId.get(card.id) ?? null,
			);
			const sessionActivityFacts = sessionActivityFactsByOwningCardId.get(card.id) ?? [];
			const mainSessionId = resolveMainTaskConversationSessionId(card);
			const mainSessionFacts = resolveCurrentMainConversationTaskSessionFactsWithVerifiedCardOwnership(
				card,
				input.sessionFactsByTaskId,
			);
			entry.taskConversationSessionActivityObservations = collectTaskConversationSessionActivityObservations(
				card,
				mainSessionFacts && !sessionActivityFacts.some((facts) => facts.taskId === mainSessionId)
					? [...sessionActivityFacts, { taskId: mainSessionId, ...mainSessionFacts }]
					: sessionActivityFacts,
			);
			if (isTaskCardWithinCrossProjectTaskSwitcherActivityScope(entry, activityHorizonStartAt)) {
				entries.push(entry);
			}
		}
	}
	return entries;
}
