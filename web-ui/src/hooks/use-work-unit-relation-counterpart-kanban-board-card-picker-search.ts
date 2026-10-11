// dd2db 2.1「添加关系」对话框的对端卡片选择器：复用 Spotlight 的搜索链路——跨全部注册项目的任务索引
// （useAllProjectsTaskSearchIndex，与 Spotlight「All projects」开关同一个端点）+ 搜索计算核心（useTaskBoardSearch，
// direct 模式与 task id 置顶规则）——只是结果用来「选中」而不是「打开」。
//
// 为什么不直接复用 TaskSpotlightSearchDialog：它由 App 级单例 controller 驱动（当前项目的实时 board、会话推流叠加层、
// localStorage 里的检索历史 / 排序档 / 字段开关、选中即跳转），面板拿不到 board，且借用会把选择器里的检索写进
// Spotlight 的历史。这里只取搜索与结果行两层，当前项目也走同一份索引（快照即可，选卡不需要实时会话状态）。

import { useEffect, useMemo, useState } from "react";
import {
	DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE,
	type TaskBoardSearchDocument,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";
import type { TaskSearchResultSortOrder } from "@/search/task-search-result-ordering";
import {
	type AllProjectsTaskSearchIndexStatus,
	useAllProjectsTaskSearchIndex,
} from "@/search/use-all-projects-task-search-index";
import { useTaskBoardSearch } from "@/search/use-task-board-search";

// 一屏列这么多就够挑；要找别的就多打几个字。不做虚拟列表。
export const MAXIMUM_COUNTERPART_KANBAN_BOARD_CARD_PICKER_RESULTS_SHOWN = 40;

// 选择器不排除任何项目：当前项目也从同一份跨项目索引里挑（引用稳定，免得索引文档每次渲染重算）。
const NO_PROJECT_IDS_EXCLUDED_FROM_COUNTERPART_PICKER_INDEX: ReadonlySet<string> = new Set();

// 选择器没有会话推流，但跨项目索引本身逐任务带着「对话上次推进」快照（当前项目那份也是服务端用内存摘要覆盖过的）。
// direct 的 Relevance 按它排序（与 Spotlight「All projects」同一口径），行上的活跃药丸也读它。
// 模块级函数、引用稳定（useTaskBoardSearch 要求）。
export function resolveAgentConversationProgressForCounterpartPickerFromAllProjectsTaskSearchIndex(
	document: TaskBoardSearchDocument,
): number | null {
	return document.crossProjectAgentConversationProgressAtEpochMs;
}

export interface WorkUnitRelationCounterpartKanbanBoardCardPickerSearch {
	counterpartSearchQuery: string;
	setCounterpartSearchQuery: (counterpartSearchQuery: string) => void;
	allProjectsTaskSearchIndexStatus: AllProjectsTaskSearchIndexStatus;
	refetchAllProjectsTaskSearchIndex: () => void;
	shownCounterpartSearchResults: TaskBoardSearchResult[];
	effectiveSortOrder: TaskSearchResultSortOrder;
	activeCounterpartSearchResultIndex: number;
	setActiveCounterpartSearchResultIndex: (activeCounterpartSearchResultIndex: number) => void;
	moveActiveCounterpartSearchResult: (delta: 1 | -1) => void;
}

export function useWorkUnitRelationCounterpartKanbanBoardCardPickerSearch(input: {
	isCounterpartPickerSearchActive: boolean;
	// 跨项目索引端点不是 workspace-scoped，用面板所在项目的连接即可。
	connectionWorkspaceIdForAllProjectsTaskSearchIndex: string;
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
}): WorkUnitRelationCounterpartKanbanBoardCardPickerSearch {
	const [counterpartSearchQuery, setCounterpartSearchQuery] = useState("");
	const [activeCounterpartSearchResultIndex, setActiveCounterpartSearchResultIndex] = useState(0);
	const allProjectsTaskSearchIndex = useAllProjectsTaskSearchIndex({
		enabled: input.isCounterpartPickerSearchActive,
		workspaceId: input.connectionWorkspaceIdForAllProjectsTaskSearchIndex,
		excludeProjectIds: NO_PROJECT_IDS_EXCLUDED_FROM_COUNTERPART_PICKER_INDEX,
	});
	const allProjectsTaskSearchDocuments = allProjectsTaskSearchIndex.documents;
	const { subjectKanbanBoardCardWorkspaceId, subjectKanbanBoardCardTaskId } = input;
	// 面板主体那张卡自己不能当对端（自指关系 runtime 也会拒绝）。
	const counterpartCandidateDocuments = useMemo(
		() =>
			allProjectsTaskSearchDocuments.filter(
				(document) =>
					!(
						document.projectId === subjectKanbanBoardCardWorkspaceId &&
						document.taskId === subjectKanbanBoardCardTaskId
					),
			),
		[allProjectsTaskSearchDocuments, subjectKanbanBoardCardWorkspaceId, subjectKanbanBoardCardTaskId],
	);
	const { orderedResults, effectiveSortOrder } = useTaskBoardSearch({
		documents: counterpartCandidateDocuments,
		query: counterpartSearchQuery,
		mode: "direct",
		matchedTextFieldScope: DEFAULT_TASK_SEARCH_MATCHED_TEXT_FIELD_SCOPE,
		sortOrder: "relevance",
		resolveAgentConversationProgressAtEpochMs:
			resolveAgentConversationProgressForCounterpartPickerFromAllProjectsTaskSearchIndex,
		isBrowsingAllTasksWithoutQueryEnabled: input.isCounterpartPickerSearchActive,
	});
	const shownCounterpartSearchResults = useMemo(
		() => orderedResults.slice(0, MAXIMUM_COUNTERPART_KANBAN_BOARD_CARD_PICKER_RESULTS_SHOWN),
		[orderedResults],
	);

	// 改了查询就回到第一条（有查询时第一条就是最佳命中，回车直接选它）。
	useEffect(() => {
		setActiveCounterpartSearchResultIndex(0);
	}, [counterpartSearchQuery]);

	const shownCounterpartSearchResultCount = shownCounterpartSearchResults.length;
	const moveActiveCounterpartSearchResult = (delta: 1 | -1) => {
		setActiveCounterpartSearchResultIndex((currentIndex) => {
			if (shownCounterpartSearchResultCount === 0) {
				return 0;
			}
			return (currentIndex + delta + shownCounterpartSearchResultCount) % shownCounterpartSearchResultCount;
		});
	};

	return {
		counterpartSearchQuery,
		setCounterpartSearchQuery,
		allProjectsTaskSearchIndexStatus: allProjectsTaskSearchIndex.status,
		refetchAllProjectsTaskSearchIndex: allProjectsTaskSearchIndex.refetch,
		shownCounterpartSearchResults,
		effectiveSortOrder,
		activeCounterpartSearchResultIndex: Math.min(
			activeCounterpartSearchResultIndex,
			Math.max(shownCounterpartSearchResultCount - 1, 0),
		),
		setActiveCounterpartSearchResultIndex,
		moveActiveCounterpartSearchResult,
	};
}
