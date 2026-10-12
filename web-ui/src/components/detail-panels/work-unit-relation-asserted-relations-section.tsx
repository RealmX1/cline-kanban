// dd2db 2.1：Relations 面板里的「Asserted relations」区块——当前卡一度邻域里生效中的断言型（参照）关系。
// 分组与标签在 work-unit-asserted-relation-neighborhood-presentation-model 里算好，这里只渲染：
// - (a)「Asserted」：本卡断言的、或经用户 / 独立核验确认的；
// - (b)「Declared by another task · not confirmed」：别的工作单元单方面声明的，理由按引用数据展示（那是别的 agent 写的话）；
// - 泛相关默认折叠。
// 每行的「Revoke」只展开两个选项；选项按钮的 onClick 才是撤销决策（点击事件原样交给传输层，runtime 据此拒绝合成点击）。
// 刻意不用 Radix 菜单承载选项：菜单项的键盘激活走程序化 click，isTrusted 为 false，会被 runtime 当成合成事件拒绝。

import type { RelationAssertionRevocationReason } from "@runtime-inter-work-unit-relation-assertion-lifecycle-event-contract";
import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { type MouseEvent, type ReactElement, useState } from "react";
import {
	formatEpochMsAsUtcMinuteForRelationTooltip,
	RelationNeighborhoodSectionHeading,
	RelationNeighborWorkUnitReference,
	RelationStatusBadge,
} from "@/components/detail-panels/work-unit-relation-neighborhood-panel-neighbor-reference-and-badges";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { WorkUnitRelationNeighborhoodPanelController } from "@/hooks/use-work-unit-relation-neighborhood-panel-of-kanban-board-card";
import type {
	AssertedRelationDecisionSourceCategory,
	AssertedRelationRowFromPanelSubjectPerspective,
	WorkUnitAssertedRelationNeighborhoodPresentation,
} from "@/hooks/work-unit-asserted-relation-neighborhood-presentation-model";

export const ASSERTED_RELATIONS_GROUP_TITLE_FOR_ASSERTED_OR_CONFIRMED = "Asserted";
export const ASSERTED_RELATIONS_GROUP_TITLE_FOR_UNILATERAL_DECLARATIONS = "Declared by another task · not confirmed";

const DECISION_SOURCE_BADGE_CLASS_NAME_BY_DECISION_SOURCE_CATEGORY: Record<
	AssertedRelationDecisionSourceCategory,
	string
> = {
	asserted_directly_by_user_in_web_ui: "bg-status-blue/15 text-status-blue",
	confirmed_by_user_in_web_ui: "bg-status-blue/15 text-status-blue",
	independently_verified_by_automated_verifier: "bg-status-green/15 text-status-green",
	agent_assertion_not_reviewed_by_user: "bg-surface-3 text-text-secondary",
};

// 两个撤销选项（RELATION_ASSERTION_REVOCATION_REASONS 的全部取值，顺序即展示顺序）。
const RELATION_ASSERTION_REVOCATION_CHOICES: ReadonlyArray<{
	relationAssertionRevocationReason: RelationAssertionRevocationReason;
	revocationChoiceLabel: string;
	revocationChoiceExplanation: string;
}> = [
	{
		relationAssertionRevocationReason: "relation_ended_naturally",
		revocationChoiceLabel: "Relation ended",
		revocationChoiceExplanation: "The relation simply ended. Nothing is remembered about it.",
	},
	{
		relationAssertionRevocationReason: "relation_was_incorrect",
		revocationChoiceLabel: "Relation was wrong",
		revocationChoiceExplanation:
			"Kanban remembers that you rejected it: agents won't assert it again unless they bring new evidence or either task's requirements change.",
	},
];

function AssertedRelationAsserterLabel({
	assertedRelationRow,
	controller,
}: {
	assertedRelationRow: AssertedRelationRowFromPanelSubjectPerspective;
	controller: WorkUnitRelationNeighborhoodPanelController;
}): ReactElement | null {
	const relationAsserter = assertedRelationRow.relationAsserter;
	switch (relationAsserter.relationAsserterKind) {
		case "web_ui_user":
			// 决策来源标签已经写着「Asserted by you」时不重复。
			return assertedRelationRow.assertedRelationDecisionSourceCategory ===
				"asserted_directly_by_user_in_web_ui" ? null : (
				<span>Asserted by you</span>
			);
		case "panel_subject_work_unit":
			return <span>Asserted by this task</span>;
		case "other_work_unit":
			return (
				<span className="inline-flex flex-wrap items-center gap-1">
					Declared by
					<RelationNeighborWorkUnitReference
						neighbor={relationAsserter.relationAsserterNeighbor}
						openNeighborKanbanBoardCardInItsProject={controller.openNeighborKanbanBoardCardInItsProject}
					/>
				</span>
			);
		default:
			return <span>Asserted by {relationAsserter.relationAsserterDisplayLabel}</span>;
	}
}

function AssertedRelationRationale({
	assertedRelationRow,
}: {
	assertedRelationRow: AssertedRelationRowFromPanelSubjectPerspective;
}): ReactElement {
	if (assertedRelationRow.isUnilaterallyDeclaredByAnotherWorkUnitWithoutConfirmation) {
		// 别的 agent 写的话：按引用数据展示（引号 + 引用块），明确不是面板自己的说明文字。
		return (
			<figure className="mt-1">
				<figcaption className="text-[11px] text-text-tertiary">
					Stated rationale (quoted from another task):
				</figcaption>
				<blockquote
					className="mt-0.5 border-l-2 border-border-bright pl-2 text-[11px] italic break-words text-text-secondary"
					data-quoted-rationale-from-another-work-unit=""
				>
					“{assertedRelationRow.relationAssertionRationaleOneSentence}”
				</blockquote>
			</figure>
		);
	}
	return (
		<div className="mt-0.5 break-words text-[11px] text-text-secondary">
			Rationale: {assertedRelationRow.relationAssertionRationaleOneSentence}
		</div>
	);
}

function AssertedRelationRow({
	assertedRelationRow,
	panelSubjectSelfReferenceInSentence,
	controller,
}: {
	assertedRelationRow: AssertedRelationRowFromPanelSubjectPerspective;
	panelSubjectSelfReferenceInSentence: string;
	controller: WorkUnitRelationNeighborhoodPanelController;
}): ReactElement {
	const [isRevocationChoiceListExpanded, setIsRevocationChoiceListExpanded] = useState(false);
	const isRevocationInFlight = controller.relationIdsWithAssertionRevocationInFlight.has(
		assertedRelationRow.relationId,
	);
	return (
		<div
			className="px-2 py-1 hover:bg-surface-2"
			data-asserted-relation-id={assertedRelationRow.relationId}
			title={`首次 ${formatEpochMsAsUtcMinuteForRelationTooltip(assertedRelationRow.relationFirstEstablishedAt)} · 最近 ${formatEpochMsAsUtcMinuteForRelationTooltip(assertedRelationRow.relationLastUpdatedAt)}`}
		>
			<div className="flex items-start gap-1.5">
				<div className="min-w-0 flex-1 text-xs leading-5">
					<span className="text-text-secondary">
						{panelSubjectSelfReferenceInSentence} {assertedRelationRow.readingPhraseFromPanelSubjectPerspective}
					</span>{" "}
					<RelationNeighborWorkUnitReference
						neighbor={assertedRelationRow.counterpartNeighbor}
						openNeighborKanbanBoardCardInItsProject={controller.openNeighborKanbanBoardCardInItsProject}
					/>
					<div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-text-tertiary">
						<RelationStatusBadge
							className={
								DECISION_SOURCE_BADGE_CLASS_NAME_BY_DECISION_SOURCE_CATEGORY[
									assertedRelationRow.assertedRelationDecisionSourceCategory
								]
							}
						>
							{assertedRelationRow.assertedRelationDecisionSourceLabel}
						</RelationStatusBadge>
						<AssertedRelationAsserterLabel assertedRelationRow={assertedRelationRow} controller={controller} />
						{assertedRelationRow.otherAgentWorkUnitNeighborsThatMergedContentByReassertion.length > 0 ? (
							// 对称关系被对端 agent 重断言并入过内容：如实列出，免得整条关系看起来只归首个断言方。
							<span className="inline-flex flex-wrap items-center gap-1">
								· Also declared by
								{assertedRelationRow.otherAgentWorkUnitNeighborsThatMergedContentByReassertion.map(
									(neighbor) => (
										<RelationNeighborWorkUnitReference
											key={neighbor.neighborWorkUnitKey}
											neighbor={neighbor}
											openNeighborKanbanBoardCardInItsProject={
												controller.openNeighborKanbanBoardCardInItsProject
											}
										/>
									),
								)}
							</span>
						) : null}
						{assertedRelationRow.isRelationKindRecognizedByThisWebUi ? null : (
							<RelationStatusBadge className="bg-status-orange/15 text-status-orange">
								本版界面不认识这个关系种类
							</RelationStatusBadge>
						)}
					</div>
					{assertedRelationRow.assertedRelationKindSpecificAttributeSummaryEntries.map((attributeSummaryEntry) => (
						<div key={attributeSummaryEntry.attributeKey} className="break-words text-[11px] text-text-secondary">
							<span className="text-text-tertiary">{attributeSummaryEntry.attributeDisplayLabel}:</span>{" "}
							{attributeSummaryEntry.attributeDisplayValues.join("; ")}
						</div>
					))}
					{assertedRelationRow.relationAssertionEvidencePointers.length > 0 ? (
						<div className="break-words text-[11px] text-text-secondary">
							<span className="text-text-tertiary">Evidence:</span>{" "}
							{assertedRelationRow.relationAssertionEvidencePointers.join(", ")}
						</div>
					) : null}
					<AssertedRelationRationale assertedRelationRow={assertedRelationRow} />
				</div>
				<Button
					variant="ghost"
					size="xs"
					icon={isRevocationInFlight ? <Spinner size={11} /> : <Undo2 size={12} />}
					aria-label="Revoke this relation"
					aria-expanded={isRevocationChoiceListExpanded}
					title="Revoke this relation"
					disabled={isRevocationInFlight}
					onClick={() => setIsRevocationChoiceListExpanded((current) => !current)}
				/>
			</div>
			{isRevocationChoiceListExpanded ? (
				<div
					role="group"
					aria-label="Why revoke this relation?"
					className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-1.5 text-[11px]"
				>
					{RELATION_ASSERTION_REVOCATION_CHOICES.map((revocationChoice) => {
						const revocationChoiceClickHandler =
							controller.createEffectiveRelationAssertionRevocationChoiceClickHandler(
								assertedRelationRow.relationId,
								revocationChoice.relationAssertionRevocationReason,
							);
						return (
							<div key={revocationChoice.relationAssertionRevocationReason} className="flex items-start gap-1.5">
								<Button
									variant={
										revocationChoice.relationAssertionRevocationReason === "relation_was_incorrect"
											? "danger"
											: "default"
									}
									size="xs"
									className="shrink-0 px-1.5"
									onClick={(revocationChoiceClickEvent: MouseEvent<HTMLButtonElement>) => {
										setIsRevocationChoiceListExpanded(false);
										revocationChoiceClickHandler(revocationChoiceClickEvent);
									}}
								>
									{revocationChoice.revocationChoiceLabel}
								</Button>
								<span className="text-text-secondary">{revocationChoice.revocationChoiceExplanation}</span>
							</div>
						);
					})}
					<div>
						<Button variant="ghost" size="xs" onClick={() => setIsRevocationChoiceListExpanded(false)}>
							Cancel
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}

export function WorkUnitRelationAssertedRelationsSection({
	assertedRelationNeighborhoodPresentation,
	panelSubjectSelfReferenceInSentence,
	controller,
}: {
	assertedRelationNeighborhoodPresentation: WorkUnitAssertedRelationNeighborhoodPresentation;
	panelSubjectSelfReferenceInSentence: string;
	controller: WorkUnitRelationNeighborhoodPanelController;
}): ReactElement | null {
	const [isCollapsedByDefaultGroupExpanded, setIsCollapsedByDefaultGroupExpanded] = useState(false);
	const {
		assertedByPanelSubjectOrConfirmedRelationRows,
		unilaterallyDeclaredByAnotherWorkUnitRelationRows,
		collapsedByDefaultRelationRows,
	} = assertedRelationNeighborhoodPresentation;
	if (assertedRelationNeighborhoodPresentation.effectiveAssertedRelationCount === 0) {
		return null;
	}
	const renderAssertedRelationRow = (assertedRelationRow: AssertedRelationRowFromPanelSubjectPerspective) => (
		<AssertedRelationRow
			key={assertedRelationRow.relationId}
			assertedRelationRow={assertedRelationRow}
			panelSubjectSelfReferenceInSentence={panelSubjectSelfReferenceInSentence}
			controller={controller}
		/>
	);
	return (
		<section aria-label="Asserted relations">
			{assertedByPanelSubjectOrConfirmedRelationRows.length > 0 ? (
				<section aria-label={ASSERTED_RELATIONS_GROUP_TITLE_FOR_ASSERTED_OR_CONFIRMED}>
					<RelationNeighborhoodSectionHeading>
						{ASSERTED_RELATIONS_GROUP_TITLE_FOR_ASSERTED_OR_CONFIRMED}
					</RelationNeighborhoodSectionHeading>
					{assertedByPanelSubjectOrConfirmedRelationRows.map(renderAssertedRelationRow)}
				</section>
			) : null}
			{unilaterallyDeclaredByAnotherWorkUnitRelationRows.length > 0 ? (
				<section aria-label={ASSERTED_RELATIONS_GROUP_TITLE_FOR_UNILATERAL_DECLARATIONS}>
					<RelationNeighborhoodSectionHeading>
						{ASSERTED_RELATIONS_GROUP_TITLE_FOR_UNILATERAL_DECLARATIONS}
					</RelationNeighborhoodSectionHeading>
					{unilaterallyDeclaredByAnotherWorkUnitRelationRows.map(renderAssertedRelationRow)}
				</section>
			) : null}
			{collapsedByDefaultRelationRows.length > 0 ? (
				<section aria-label="Asserted relations collapsed by default">
					<button
						type="button"
						onClick={() => setIsCollapsedByDefaultGroupExpanded((current) => !current)}
						aria-expanded={isCollapsedByDefaultGroupExpanded}
						aria-label={`Asserted relations collapsed by default: ${collapsedByDefaultRelationRows.length}`}
						className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs text-text-secondary hover:bg-surface-2"
					>
						{isCollapsedByDefaultGroupExpanded ? (
							<ChevronDown size={12} className="shrink-0 text-text-tertiary" />
						) : (
							<ChevronRight size={12} className="shrink-0 text-text-tertiary" />
						)}
						<span className="min-w-0 flex-1">
							Collapsed by default (generally related)
							<span className="text-text-primary"> · {collapsedByDefaultRelationRows.length}</span>
						</span>
					</button>
					{isCollapsedByDefaultGroupExpanded ? (
						<div className="pl-3">{collapsedByDefaultRelationRows.map(renderAssertedRelationRow)}</div>
					) : null}
				</section>
			) : null}
		</section>
	);
}
