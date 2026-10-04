import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeCrossProjectTaskSwitcherEntry,
} from "../core/api-contract";
import { resolveTaskDescriptionLastUpdatedAt } from "../core/backlog-task-description-last-updated-ordering";
import { isTaskCardWithinCrossProjectTaskSwitcherActivityScope } from "../core/cross-project-recently-active-task-switcher-section-assignment";
import {
	buildTaskActivityDetailFromBoardCardAndTaskSessionFacts,
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
	for (const column of input.board.columns) {
		for (const card of column.cards) {
			const entry = buildCrossProjectTaskSwitcherEntryFromBoardCard(
				card,
				column.id,
				input.sessionFactsByTaskId.get(card.id),
				input.lastOpenedByUserAtByTaskId.get(card.id) ?? null,
			);
			if (isTaskCardWithinCrossProjectTaskSwitcherActivityScope(entry, activityHorizonStartAt)) {
				entries.push(entry);
			}
		}
	}
	return entries;
}
