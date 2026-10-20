import { ReferenceRelationModelingEditor } from "@/components/detail-panels/reference-relation-modeling-editor";
import { useReferenceRelationModelingEditor } from "@/hooks/use-reference-relation-modeling-editor";
// dd2db 1b：任务详情（Focus View 右栏）里的 Relations 可折叠 section——当前卡的一度记录型关系邻域。
// 挂载点由 card-detail-view 决定：与「探索线 / 本会话 findings」同位、在 sessions 面板下方；不在 BoardCard 上加任何入口
// （BoardCard 有主看板与 Focus View 两条宿主链，加入口就得两边 gating 同步）。
//
// 分区、读法、静音归组都在 use-work-unit-relation-neighborhood-panel-of-kanban-board-card 里算好，这里只渲染。
// 读失败（关系账本不可用等）如实显示原因，绝不显示成「没有关系」。静音按钮的点击处理器由 hook 造好，只绑在 onClick 上。
// dd2db 2.1 起：断言型关系区块在 work-unit-relation-asserted-relations-section，「添加关系」对话框在
// work-unit-relation-add-reference-relation-dialog；两者的决策调用同样只绑在按钮 onClick 上。

import type { InterWorkUnitRelationAssertionWriteResponse } from "@runtime-work-unit-relation-assertion-write-api-contract";
import { Bell, BellOff, ChevronDown, ChevronRight, Plus, RefreshCw, TriangleAlert, Waypoints } from "lucide-react";
import { type MouseEventHandler, type ReactElement, type ReactNode, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { WorkUnitRelationAddReferenceRelationDialog } from "@/components/detail-panels/work-unit-relation-add-reference-relation-dialog";
import { WorkUnitRelationAssertedRelationsSection } from "@/components/detail-panels/work-unit-relation-asserted-relations-section";
import {
	formatEpochMsAsUtcMinuteForRelationTooltip,
	RelationNeighborhoodSectionHeading,
	RelationNeighborWorkUnitReference,
	RelationStatusBadge,
} from "@/components/detail-panels/work-unit-relation-neighborhood-panel-neighbor-reference-and-badges";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import {
	useWorkUnitRelationNeighborhoodPanelOfKanbanBoardCard,
	type WorkUnitRelationNeighborhoodPanelController,
} from "@/hooks/use-work-unit-relation-neighborhood-panel-of-kanban-board-card";
import type { WorkUnitAssertedRelationNeighborhoodPresentation } from "@/hooks/work-unit-asserted-relation-neighborhood-presentation-model";
import type {
	WorkUnitRelationNeighborhoodPanelPresentation,
	WorkUnitRelationSentenceFromPanelSubjectPerspective,
} from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";
import type { WorkUnitRelationNeighborhoodSummaryReadFailure } from "@/runtime/work-unit-relation-neighborhood-summary-query";

const RELATION_NEIGHBORHOOD_READ_FAILURE_HEADLINE_BY_READ_FAILURE_KIND: Record<
	WorkUnitRelationNeighborhoodSummaryReadFailure["readFailureKind"],
	string
> = {
	inter_work_unit_relation_ledger_unavailable: "关系暂不可用",
	kanban_board_card_not_known_to_inter_work_unit_relation_ledger: "关系账本还不认识这张卡",
	bare_task_id_matches_more_than_one_kanban_board_card: "这个任务 id 对应多张卡，无法确定是哪一张",
	unexpected_relation_neighborhood_read_failure: "读取关系失败",
};

function countListedRelationsInPresentation(
	presentation: WorkUnitRelationNeighborhoodPanelPresentation,
	assertedRelationNeighborhoodPresentation: WorkUnitAssertedRelationNeighborhoodPresentation,
): number {
	return (
		presentation.visibleSections.reduce((total, section) => total + section.relationSentences.length, 0) +
		presentation.collapsedCountGroups.reduce((total, group) => total + group.collapsedRelationSentences.length, 0) +
		assertedRelationNeighborhoodPresentation.effectiveAssertedRelationCount
	);
}

function describeReferenceRelationAssertionWriteSuccessForToast(
	writeResponse: InterWorkUnitRelationAssertionWriteResponse,
): string {
	if (writeResponse.relationAssertionWriteOutcome === "reassertion_merged_into_already_effective_assertion") {
		return "这条关系已经存在，这次填写的内容已合并进原关系。";
	}
	return `已添加关系：${writeResponse.relationStatementReadFromSubjectPerspective}`;
}

function RecordedRelationSentenceRow({
	relationSentence,
	panelSubjectSelfReferenceInSentence,
	controller,
}: {
	relationSentence: WorkUnitRelationSentenceFromPanelSubjectPerspective;
	panelSubjectSelfReferenceInSentence: string;
	controller: WorkUnitRelationNeighborhoodPanelController;
}): ReactElement {
	const isMutedInPresentation = relationSentence.relationMutedInPresentationAt !== null;
	const isMuteToggleInFlight = controller.relationIdsWithPresentationMuteToggleInFlight.has(
		relationSentence.relationId,
	);
	const relationDetailParts: string[] = [];
	if (relationSentence.relationOccurrenceCountAcrossTaskMutationEventKinds > 0) {
		relationDetailParts.push(`${relationSentence.relationOccurrenceCountAcrossTaskMutationEventKinds} 次`);
	}
	if (relationSentence.changedKanbanBoardCardFieldNames.length > 0) {
		relationDetailParts.push(`字段：${relationSentence.changedKanbanBoardCardFieldNames.join(", ")}`);
	}
	const muteToggleButtonClickHandler: MouseEventHandler<HTMLButtonElement> =
		controller.createRecordedRelationMuteToggleButtonClickHandler(
			relationSentence.relationId,
			!isMutedInPresentation,
		);
	return (
		<div
			className={cn("flex items-start gap-1.5 px-2 py-1 hover:bg-surface-2", isMutedInPresentation && "opacity-60")}
			data-relation-id={relationSentence.relationId}
			title={`首次 ${formatEpochMsAsUtcMinuteForRelationTooltip(relationSentence.relationFirstEstablishedAt)} · 最近 ${formatEpochMsAsUtcMinuteForRelationTooltip(relationSentence.relationLastUpdatedAt)}`}
		>
			<div className="min-w-0 flex-1 text-xs leading-5">
				<span className="text-text-secondary">
					{panelSubjectSelfReferenceInSentence} {relationSentence.readingPhraseFromPanelSubjectPerspective}
				</span>{" "}
				<RelationNeighborWorkUnitReference
					neighbor={relationSentence.counterpartNeighbor}
					openNeighborKanbanBoardCardInItsProject={controller.openNeighborKanbanBoardCardInItsProject}
				/>
				{relationSentence.isCreationTimePrimaryProvenanceOfRelationStatementSubjectCard ||
				relationDetailParts.length > 0 ||
				isMutedInPresentation ? (
					<div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-text-tertiary">
						{relationSentence.isCreationTimePrimaryProvenanceOfRelationStatementSubjectCard ? (
							<RelationStatusBadge className="bg-status-blue/15 text-status-blue">
								创建时主来源
							</RelationStatusBadge>
						) : null}
						{isMutedInPresentation ? (
							<RelationStatusBadge className="bg-surface-3 text-text-tertiary">已静音</RelationStatusBadge>
						) : null}
						{relationDetailParts.length > 0 ? <span>{relationDetailParts.join(" · ")}</span> : null}
					</div>
				) : null}
			</div>
			<Button
				variant="ghost"
				size="xs"
				icon={
					isMuteToggleInFlight ? (
						<Spinner size={11} />
					) : isMutedInPresentation ? (
						<Bell size={12} />
					) : (
						<BellOff size={12} />
					)
				}
				aria-label={isMutedInPresentation ? "取消静音这条关系" : "静音这条关系"}
				title={isMutedInPresentation ? "取消静音：重新在邻域摘要里列出" : "静音：只在展示里隐藏，关系本身照常记录"}
				disabled={isMuteToggleInFlight}
				onClick={muteToggleButtonClickHandler}
			/>
		</div>
	);
}

function ExpandableRelationSentenceGroup({
	groupHeaderContent,
	groupAccessibleLabel,
	relationSentences,
	panelSubjectSelfReferenceInSentence,
	controller,
}: {
	groupHeaderContent: ReactNode;
	groupAccessibleLabel: string;
	relationSentences: WorkUnitRelationSentenceFromPanelSubjectPerspective[];
	panelSubjectSelfReferenceInSentence: string;
	controller: WorkUnitRelationNeighborhoodPanelController;
}): ReactElement {
	const [isGroupExpanded, setIsGroupExpanded] = useState(false);
	return (
		<div>
			<button
				type="button"
				onClick={() => setIsGroupExpanded((current) => !current)}
				aria-expanded={isGroupExpanded}
				aria-label={groupAccessibleLabel}
				className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs text-text-secondary hover:bg-surface-2"
			>
				{isGroupExpanded ? (
					<ChevronDown size={12} className="shrink-0 text-text-tertiary" />
				) : (
					<ChevronRight size={12} className="shrink-0 text-text-tertiary" />
				)}
				<span className="min-w-0 flex-1">{groupHeaderContent}</span>
			</button>
			{isGroupExpanded ? (
				<div className="pl-3">
					{relationSentences.map((relationSentence) => (
						<RecordedRelationSentenceRow
							key={relationSentence.relationId}
							relationSentence={relationSentence}
							panelSubjectSelfReferenceInSentence={panelSubjectSelfReferenceInSentence}
							controller={controller}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

function LoadedRelationNeighborhoodBody({
	presentation,
	assertedRelationNeighborhoodPresentation,
	controller,
}: {
	presentation: WorkUnitRelationNeighborhoodPanelPresentation;
	assertedRelationNeighborhoodPresentation: WorkUnitAssertedRelationNeighborhoodPresentation;
	controller: WorkUnitRelationNeighborhoodPanelController;
}): ReactElement {
	const subjectSelfReference = presentation.panelSubjectSelfReferenceInSentence;
	return (
		<>
			{presentation.hasNoRecordedRelationAtAll &&
			assertedRelationNeighborhoodPresentation.effectiveAssertedRelationCount === 0 ? (
				<div className="px-3 py-2 text-xs text-text-tertiary">还没有记录到与其他工作单元的关系</div>
			) : null}
			{presentation.visibleSections.map((section) => (
				<section
					key={section.neighborhoodSummarySectionPriority}
					aria-label={section.neighborhoodSummarySectionTitle}
				>
					<RelationNeighborhoodSectionHeading>
						{section.neighborhoodSummarySectionTitle}
					</RelationNeighborhoodSectionHeading>
					{section.relationSentences.map((relationSentence) => (
						<RecordedRelationSentenceRow
							key={relationSentence.relationId}
							relationSentence={relationSentence}
							panelSubjectSelfReferenceInSentence={subjectSelfReference}
							controller={controller}
						/>
					))}
				</section>
			))}
			{/* 断言型（参照）关系排在来源、需求修订之后、折叠计数之前（与 runtime 邻域摘要的分区顺序一致）。 */}
			<WorkUnitRelationAssertedRelationsSection
				assertedRelationNeighborhoodPresentation={assertedRelationNeighborhoodPresentation}
				panelSubjectSelfReferenceInSentence={subjectSelfReference}
				controller={controller}
			/>
			{presentation.collapsedCountGroups.length > 0 ? (
				<section aria-label="折叠（仅计数）">
					<RelationNeighborhoodSectionHeading>折叠（仅计数）</RelationNeighborhoodSectionHeading>
					{presentation.collapsedCountGroups.map((collapsedCountGroup) => (
						<ExpandableRelationSentenceGroup
							key={collapsedCountGroup.collapsedCountGroupKey}
							groupAccessibleLabel={`${subjectSelfReference} ${collapsedCountGroup.readingPhraseFromPanelSubjectPerspective}：${collapsedCountGroup.collapsedRelationSentences.length} 个工作单元`}
							groupHeaderContent={
								<>
									{subjectSelfReference} {collapsedCountGroup.readingPhraseFromPanelSubjectPerspective}
									<span className="text-text-primary">
										：{collapsedCountGroup.collapsedRelationSentences.length} 个工作单元
									</span>
								</>
							}
							relationSentences={collapsedCountGroup.collapsedRelationSentences}
							panelSubjectSelfReferenceInSentence={subjectSelfReference}
							controller={controller}
						/>
					))}
				</section>
			) : null}
			{presentation.mutedInPresentationRelationSentences.length > 0 ? (
				<section aria-label="已静音">
					<ExpandableRelationSentenceGroup
						groupAccessibleLabel={`已静音的关系：${presentation.mutedInPresentationRelationSentences.length} 条`}
						groupHeaderContent={
							<span className="text-text-tertiary">
								已静音（{presentation.mutedInPresentationRelationSentences.length}）· 只在展示里隐藏，可取消静音
							</span>
						}
						relationSentences={presentation.mutedInPresentationRelationSentences}
						panelSubjectSelfReferenceInSentence={subjectSelfReference}
						controller={controller}
					/>
				</section>
			) : null}
			{presentation.unrecognizedRelationKindRelationCount > 0 ? (
				<div className="px-3 py-1 text-[11px] text-text-tertiary">
					另有 {presentation.unrecognizedRelationKindRelationCount} 条关系的种类本版界面还不认识，未列出。
				</div>
			) : null}
			{presentation.conversationSessionOwnershipConflictCount > 0 ? (
				<div className="flex items-start gap-1 px-3 py-1 text-[11px] text-status-orange">
					<TriangleAlert size={12} className="mt-0.5 shrink-0" />
					<span>
						{presentation.conversationSessionOwnershipConflictCount}{" "}
						处共享会话冲突：一张已把会话交给别的卡的卡，又续跑了同一个会话。
					</span>
				</div>
			) : null}
		</>
	);
}

function RelationNeighborhoodReadFailureBody({
	readFailure,
	onRetry,
}: {
	readFailure: WorkUnitRelationNeighborhoodSummaryReadFailure;
	onRetry: () => void;
}): ReactElement {
	return (
		<div className="flex flex-col gap-1 px-3 py-2 text-xs" role="status">
			<div className="flex items-center gap-1.5 font-medium text-status-orange">
				<TriangleAlert size={12} className="shrink-0" />
				{RELATION_NEIGHBORHOOD_READ_FAILURE_HEADLINE_BY_READ_FAILURE_KIND[readFailure.readFailureKind]}
			</div>
			{readFailure.readFailureReasonMessage ? (
				<div className="break-words text-[11px] text-text-secondary">
					原因：{readFailure.readFailureReasonMessage}
				</div>
			) : null}
			<div>
				<Button variant="ghost" size="xs" icon={<RefreshCw size={11} />} onClick={onRetry}>
					重试
				</Button>
			</div>
		</div>
	);
}

function RelationNeighborhoodHeaderSummaryBadge({
	controller,
}: {
	controller: WorkUnitRelationNeighborhoodPanelController;
}): ReactElement | null {
	const readState = controller.relationNeighborhoodReadState;
	switch (readState.relationNeighborhoodReadPhase) {
		case "loading_relation_neighborhood":
			return <Spinner size={11} className="ml-auto shrink-0" />;
		case "relation_neighborhood_read_failed":
			return (
				<span className="ml-auto shrink-0 rounded-sm bg-status-orange/15 px-1.5 py-px text-[11px] font-medium text-status-orange">
					{readState.relationNeighborhoodReadFailure.readFailureKind ===
					"inter_work_unit_relation_ledger_unavailable"
						? "暂不可用"
						: "读取失败"}
				</span>
			);
		case "relation_neighborhood_loaded": {
			const listedRelationCount = countListedRelationsInPresentation(
				readState.relationNeighborhoodPanelPresentation,
				readState.assertedRelationNeighborhoodPresentation,
			);
			const mutedRelationCount =
				readState.relationNeighborhoodPanelPresentation.mutedInPresentationRelationSentences.length;
			if (listedRelationCount === 0 && mutedRelationCount === 0) {
				return null;
			}
			return (
				<span className="ml-auto shrink-0 text-[11px] text-text-tertiary">
					{listedRelationCount}
					{mutedRelationCount > 0 ? ` · 已静音 ${mutedRelationCount}` : ""}
				</span>
			);
		}
		default:
			return null;
	}
}

export function WorkUnitRelationNeighborhoodPanel({
	workspaceId,
	kanbanBoardCardTaskId,
	initiallyExpanded = false,
}: {
	workspaceId: string | null;
	kanbanBoardCardTaskId: string;
	initiallyExpanded?: boolean;
}): ReactElement {
	const controller = useWorkUnitRelationNeighborhoodPanelOfKanbanBoardCard({ workspaceId, kanbanBoardCardTaskId });
	const [isRelationNeighborhoodPanelExpanded, setIsRelationNeighborhoodPanelExpanded] = useState(initiallyExpanded);
	const [isAddReferenceRelationDialogOpen, setIsAddReferenceRelationDialogOpen] = useState(false);
	const [isModelingEditorOpen, setIsModelingEditorOpen] = useState(false);
	const modeling = useReferenceRelationModelingEditor({
		workspaceId,
		taskId: kanbanBoardCardTaskId,
		active: isRelationNeighborhoodPanelExpanded && isModelingEditorOpen,
	});
	const readState = controller.relationNeighborhoodReadState;
	const handleReferenceRelationAssertionWriteSucceeded = (
		writeResponse: InterWorkUnitRelationAssertionWriteResponse,
	) => {
		setIsAddReferenceRelationDialogOpen(false);
		controller.refetchRelationNeighborhood();
		showAppToast({
			intent: "success",
			message: describeReferenceRelationAssertionWriteSuccessForToast(writeResponse),
		});
	};

	return (
		<section
			className={cn(
				"flex flex-col border-t border-border bg-surface-1",
				isModelingEditorOpen ? "min-h-0 shrink" : "shrink-0",
			)}
			aria-label="Relations"
		>
			<div className="flex h-8 shrink-0 items-center hover:bg-surface-3">
				<button
					type="button"
					onClick={() => {
						const nextIsExpanded = !isRelationNeighborhoodPanelExpanded;
						setIsRelationNeighborhoodPanelExpanded(nextIsExpanded);
						// 展开时重拉一次：关系可能在详情页开着期间被别的卡改动。
						if (nextIsExpanded) {
							controller.refetchRelationNeighborhood();
						}
					}}
					className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
					aria-expanded={isRelationNeighborhoodPanelExpanded}
				>
					{isRelationNeighborhoodPanelExpanded ? (
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
					) : (
						<ChevronRight size={14} className="shrink-0 text-text-secondary" />
					)}
					<Waypoints size={13} className="shrink-0 text-text-tertiary" />
					<span className="text-xs font-medium text-text-primary">Relations</span>
					<RelationNeighborhoodHeaderSummaryBadge controller={controller} />
				</button>
				{isRelationNeighborhoodPanelExpanded && workspaceId ? (
					<Button
						size="xs"
						variant="ghost"
						onClick={() => {
							setIsModelingEditorOpen((value) => !value);
							controller.refetchRelationNeighborhood();
						}}
					>
						{isModelingEditorOpen ? "查看关系摘要" : "关系图与建模"}
					</Button>
				) : null}
				{isRelationNeighborhoodPanelExpanded && workspaceId && !isModelingEditorOpen ? (
					<Button
						variant="ghost"
						size="xs"
						className="mr-0.5"
						icon={<Plus size={11} />}
						title="Add a relation from this task to another task"
						onClick={() => setIsAddReferenceRelationDialogOpen(true)}
					>
						Add relation
					</Button>
				) : null}
				{isRelationNeighborhoodPanelExpanded && !isModelingEditorOpen ? (
					<Button
						variant="ghost"
						size="xs"
						className="mr-1"
						icon={
							controller.isRelationNeighborhoodRefetchInFlight ? <Spinner size={11} /> : <RefreshCw size={11} />
						}
						aria-label="刷新关系"
						disabled={controller.isRelationNeighborhoodRefetchInFlight}
						onClick={controller.refetchRelationNeighborhood}
					/>
				) : null}
			</div>
			{workspaceId ? (
				<WorkUnitRelationAddReferenceRelationDialog
					isAddReferenceRelationDialogOpen={isAddReferenceRelationDialogOpen}
					onAddReferenceRelationDialogOpenChange={setIsAddReferenceRelationDialogOpen}
					subjectKanbanBoardCardWorkspaceId={workspaceId}
					subjectKanbanBoardCardTaskId={kanbanBoardCardTaskId}
					onReferenceRelationAssertionWriteSucceeded={handleReferenceRelationAssertionWriteSucceeded}
				/>
			) : null}
			{isRelationNeighborhoodPanelExpanded && isModelingEditorOpen && workspaceId ? (
				<div className="max-h-[65vh] min-h-0 overflow-y-auto border-t border-border px-3">
					<ReferenceRelationModelingEditor
						key={`${workspaceId}:${kanbanBoardCardTaskId}`}
						controller={modeling}
						workspaceId={workspaceId}
						taskId={kanbanBoardCardTaskId}
						onRelationsSaved={controller.refetchRelationNeighborhood}
						rootTitle={
							modeling.preview?.workUnits.find(
								(entry) => entry.workUnitKey === modeling.preview?.rootWorkUnitKey,
							)?.kanbanBoardCardIdentity?.currentTitle ?? `任务 ${kanbanBoardCardTaskId}`
						}
					/>
				</div>
			) : null}
			{isRelationNeighborhoodPanelExpanded && !isModelingEditorOpen ? (
				<div className="max-h-64 min-h-0 overflow-y-auto border-t border-border py-1">
					{readState.relationNeighborhoodReadPhase === "loading_relation_neighborhood" ? (
						<div className="flex items-center gap-2 px-3 py-2 text-xs text-text-tertiary">
							<Spinner size={12} />
							正在读取关系…
						</div>
					) : readState.relationNeighborhoodReadPhase === "relation_neighborhood_read_failed" ? (
						<RelationNeighborhoodReadFailureBody
							readFailure={readState.relationNeighborhoodReadFailure}
							onRetry={controller.refetchRelationNeighborhood}
						/>
					) : readState.relationNeighborhoodReadPhase === "relation_neighborhood_loaded" ? (
						<LoadedRelationNeighborhoodBody
							presentation={readState.relationNeighborhoodPanelPresentation}
							assertedRelationNeighborhoodPresentation={readState.assertedRelationNeighborhoodPresentation}
							controller={controller}
						/>
					) : (
						<div className="px-3 py-2 text-xs text-text-tertiary">没有可读取关系的任务卡。</div>
					)}
				</div>
			) : null}
		</section>
	);
}
