// dd2db 2.1「添加关系」对话框里的对端卡片选择器。搜索链路与结果行都复用 Spotlight（见
// use-work-unit-relation-counterpart-kanban-board-card-picker-search.ts 的说明）：跨全部注册项目可选，
// 选中后对端选择器是 { kanban_board_card_by_bare_task_id, bareTaskId, workspaceId }，跨项目不会撞号。

import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { RefreshCw, Search, X } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useState } from "react";
import {
	resolveTaskSpotlightSearchResultRowTimePillKind,
	TaskSpotlightSearchResultRow,
} from "@/components/task-spotlight-search-result-row";
import { DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY } from "@/components/task-spotlight-search-result-row-field-visibility";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useWorkUnitRelationCounterpartKanbanBoardCardPickerSearch } from "@/hooks/use-work-unit-relation-counterpart-kanban-board-card-picker-search";
import type { SelectedCounterpartKanbanBoardCardForAddReferenceRelation } from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";
import type { TaskBoardSearchDocument } from "@/search/task-board-search";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";

function buildSelectedCounterpartFromTaskSearchDocument(
	document: TaskBoardSearchDocument,
): SelectedCounterpartKanbanBoardCardForAddReferenceRelation {
	return {
		counterpartKanbanBoardCardWorkspaceId: document.projectId,
		counterpartKanbanBoardCardTaskId: document.taskId,
		counterpartKanbanBoardCardTitle: document.title || document.prompt.slice(0, 80) || `task ${document.taskId}`,
		counterpartKanbanProjectDisplayName: document.projectName,
	};
}

export function WorkUnitRelationCounterpartKanbanBoardCardPicker({
	subjectKanbanBoardCardWorkspaceId,
	subjectKanbanBoardCardTaskId,
	selectedCounterpartKanbanBoardCard,
	onSelectedCounterpartKanbanBoardCardChange,
	searchInputElementId,
}: {
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
	selectedCounterpartKanbanBoardCard: SelectedCounterpartKanbanBoardCardForAddReferenceRelation | null;
	onSelectedCounterpartKanbanBoardCardChange: (
		selectedCounterpartKanbanBoardCard: SelectedCounterpartKanbanBoardCardForAddReferenceRelation | null,
	) => void;
	searchInputElementId: string;
}): ReactElement {
	const isMobile = useIsMobile();
	// 结果行的相对时间药丸共用同一个「此刻」（与 Spotlight 同理：各行各取 Date.now() 会读数不一致）。
	const [nowEpochMsForResultRowTimePills] = useState(() => Date.now());
	const pickerSearch = useWorkUnitRelationCounterpartKanbanBoardCardPickerSearch({
		isCounterpartPickerSearchActive: selectedCounterpartKanbanBoardCard === null,
		connectionWorkspaceIdForAllProjectsTaskSearchIndex: subjectKanbanBoardCardWorkspaceId,
		subjectKanbanBoardCardWorkspaceId,
		subjectKanbanBoardCardTaskId,
	});

	if (selectedCounterpartKanbanBoardCard) {
		return (
			<div
				className="flex items-center gap-2 rounded-md border border-border-bright bg-surface-2 px-2 py-1.5 text-xs"
				data-selected-counterpart-kanban-board-card={`${selectedCounterpartKanbanBoardCard.counterpartKanbanBoardCardWorkspaceId}:${selectedCounterpartKanbanBoardCard.counterpartKanbanBoardCardTaskId}`}
			>
				<span className="min-w-0 flex-1 truncate text-text-primary">
					{selectedCounterpartKanbanBoardCard.counterpartKanbanBoardCardTitle}
				</span>
				<span className="shrink-0 font-mono text-[10px] text-text-tertiary">
					{selectedCounterpartKanbanBoardCard.counterpartKanbanBoardCardTaskId}
				</span>
				<span className="shrink-0 rounded-sm border border-border px-1.5 text-[10px] text-text-secondary">
					{selectedCounterpartKanbanBoardCard.counterpartKanbanProjectDisplayName}
					{selectedCounterpartKanbanBoardCard.counterpartKanbanBoardCardWorkspaceId ===
					subjectKanbanBoardCardWorkspaceId
						? "（本项目）"
						: ""}
				</span>
				<Button
					variant="ghost"
					size="xs"
					icon={<X size={12} />}
					aria-label="Choose a different task"
					onClick={() => onSelectedCounterpartKanbanBoardCardChange(null)}
				/>
			</div>
		);
	}

	const {
		counterpartSearchQuery,
		setCounterpartSearchQuery,
		allProjectsTaskSearchIndexStatus,
		refetchAllProjectsTaskSearchIndex,
		shownCounterpartSearchResults,
		effectiveSortOrder,
		activeCounterpartSearchResultIndex,
		setActiveCounterpartSearchResultIndex,
		moveActiveCounterpartSearchResult,
	} = pickerSearch;

	const handleCounterpartSearchInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (isKeyboardEventEmittedDuringImeComposition(event)) {
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveActiveCounterpartSearchResult(event.key === "ArrowDown" ? 1 : -1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const activeResult = shownCounterpartSearchResults[activeCounterpartSearchResultIndex];
			if (activeResult) {
				onSelectedCounterpartKanbanBoardCardChange(
					buildSelectedCounterpartFromTaskSearchDocument(activeResult.document),
				);
			}
		}
	};

	return (
		<div className="flex flex-col rounded-md border border-border-bright bg-surface-1">
			<div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
				<Search size={13} className="pointer-events-none shrink-0 text-text-tertiary" />
				<input
					id={searchInputElementId}
					type="text"
					value={counterpartSearchQuery}
					onChange={(event) => setCounterpartSearchQuery(event.target.value)}
					onKeyDown={handleCounterpartSearchInputKeyDown}
					placeholder="Search tasks in all projects (title, prompt or task id)"
					className="min-w-0 flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
				/>
				{allProjectsTaskSearchIndexStatus === "loading" ? <Spinner size={12} /> : null}
			</div>
			<div className="max-h-56 min-h-[64px] overflow-y-auto overscroll-contain p-1">
				{allProjectsTaskSearchIndexStatus === "error" ? (
					<div className="flex items-center gap-2 px-2 py-3 text-xs text-status-orange">
						Could not load the task list.
						<Button
							variant="ghost"
							size="xs"
							icon={<RefreshCw size={11} />}
							onClick={refetchAllProjectsTaskSearchIndex}
						>
							Retry
						</Button>
					</div>
				) : shownCounterpartSearchResults.length === 0 ? (
					<div className="px-2 py-3 text-center text-xs text-text-tertiary">
						{allProjectsTaskSearchIndexStatus === "ready" ? "No matching tasks" : "Loading tasks…"}
					</div>
				) : (
					shownCounterpartSearchResults.map((result, resultIndex) => {
						const effectiveAgentId =
							result.document.taskAgentOverrideAgentId ??
							result.document.mostRecentlyLaunchedAgentSessionAgentId;
						return (
							<div
								key={`${result.document.projectId}:${result.document.taskId}`}
								data-counterpart-candidate-kanban-board-card={`${result.document.projectId}:${result.document.taskId}`}
							>
								<TaskSpotlightSearchResultRow
									result={result}
									isActive={resultIndex === activeCounterpartSearchResultIndex}
									isCrossProject={result.document.projectId !== subjectKanbanBoardCardWorkspaceId}
									fieldVisibility={DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY}
									effectiveAgentId={effectiveAgentId}
									agentLabel={
										effectiveAgentId ? (getRuntimeAgentCatalogEntry(effectiveAgentId)?.label ?? null) : null
									}
									sessionActivity={null}
									timePillKind={resolveTaskSpotlightSearchResultRowTimePillKind(effectiveSortOrder)}
									agentConversationProgressAtEpochMs={null}
									nowEpochMs={nowEpochMsForResultRowTimePills}
									shouldUseMobileMinimumTouchTarget={isMobile}
									onSelect={() =>
										onSelectedCounterpartKanbanBoardCardChange(
											buildSelectedCounterpartFromTaskSearchDocument(result.document),
										)
									}
									onHover={() => setActiveCounterpartSearchResultIndex(resultIndex)}
								/>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
