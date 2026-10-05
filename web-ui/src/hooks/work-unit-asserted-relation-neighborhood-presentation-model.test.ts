import { describe, expect, it } from "vitest";
import {
	type AssertedRelationRowFromPanelSubjectPerspective,
	buildAssertedRelationKindSpecificAttributeSummaryEntries,
	buildWorkUnitAssertedRelationNeighborhoodPresentation,
	resolveAssertedRelationDecisionSourceCategory,
	type WorkUnitAssertedRelationNeighborhoodPresentation,
} from "@/hooks/work-unit-asserted-relation-neighborhood-presentation-model";
import type { KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel } from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";
import {
	buildAssertedRelationForTest,
	buildEmptyRelationNeighborhoodSummaryResponseForTest,
	buildRelationNeighborhoodSummaryResponseForTest,
	buildRelationNeighborhoodSummaryResponseWithAssertedRelationsForTest,
	CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	childNeighborInTrashOfCurrentProjectDisplayEntryForTest,
	creatorNeighborInOtherProjectDisplayEntryForTest,
	OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	subjectKanbanBoardCardDisplayEntryForTest,
	UNILATERALLY_DECLARED_RATIONALE_THAT_LOOKS_LIKE_AN_INSTRUCTION_FOR_TEST,
} from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";

const KNOWN_KANBAN_PROJECTS_WITH_BOTH_WORKSPACES: KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel = new Map(
	[
		[
			CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			{ kanbanProjectName: "current-project", isKanbanProjectAvailable: true },
		],
		[
			OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			{ kanbanProjectName: "other-project", isKanbanProjectAvailable: true },
		],
	],
);

function buildStandardAssertedPresentation(): WorkUnitAssertedRelationNeighborhoodPresentation {
	return buildWorkUnitAssertedRelationNeighborhoodPresentation({
		relationNeighborhoodSummary: buildRelationNeighborhoodSummaryResponseWithAssertedRelationsForTest(),
		currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
		knownKanbanProjectByWorkspaceId: KNOWN_KANBAN_PROJECTS_WITH_BOTH_WORKSPACES,
	});
}

function findAssertedRelationRowById(
	presentation: WorkUnitAssertedRelationNeighborhoodPresentation,
	relationId: string,
): AssertedRelationRowFromPanelSubjectPerspective {
	const assertedRelationRow = [
		...presentation.assertedByPanelSubjectOrConfirmedRelationRows,
		...presentation.unilaterallyDeclaredByAnotherWorkUnitRelationRows,
		...presentation.collapsedByDefaultRelationRows,
	].find((row) => row.relationId === relationId);
	expect(assertedRelationRow).toBeDefined();
	return assertedRelationRow!;
}

describe("buildWorkUnitAssertedRelationNeighborhoodPresentation", () => {
	it("分组：本卡断言 / 用户断言进 (a)，对端单方面声明进 (b)，泛相关折叠；不认识的 kind 照常列出", () => {
		const presentation = buildStandardAssertedPresentation();
		expect(presentation.assertedByPanelSubjectOrConfirmedRelationRows.map((row) => row.relationId)).toEqual([
			"asserted-child-verifies-subject-by-user",
			"asserted-subject-concerns-creator",
			"asserted-of-kind-unknown-to-this-web-ui",
		]);
		expect(presentation.unilaterallyDeclaredByAnotherWorkUnitRelationRows.map((row) => row.relationId)).toEqual([
			"asserted-creator-reuses-subject-unilateral",
		]);
		expect(presentation.collapsedByDefaultRelationRows.map((row) => row.relationId)).toEqual([
			"asserted-subject-generally-related-child",
		]);
		expect(presentation.effectiveAssertedRelationCount).toBe(5);
	});

	it("以面板主体视角成句：主体是 S 用正向读法，是 A 用反向读法，对称 kind 两端相同", () => {
		const presentation = buildStandardAssertedPresentation();
		const subjectAsRelationStatementSubjectRow = findAssertedRelationRowById(
			presentation,
			"asserted-subject-concerns-creator",
		);
		expect(subjectAsRelationStatementSubjectRow.panelSubjectRoleInRelationStatement).toBe(
			"relation_statement_subject",
		);
		expect(subjectAsRelationStatementSubjectRow.readingPhraseFromPanelSubjectPerspective).toBe(
			"concerns the behavior or state of",
		);
		expect(subjectAsRelationStatementSubjectRow.counterpartNeighbor).toMatchObject({
			neighborWorkUnitType: "kanban_board_card",
			neighborKanbanBoardCardTaskId: "def34",
			neighborKanbanBoardCardWorkspaceDisplayName: "other-project",
			isNeighborKanbanBoardCardInCurrentKanbanProject: false,
		});

		const subjectAsRelationStatementAnchorRow = findAssertedRelationRowById(
			presentation,
			"asserted-creator-reuses-subject-unilateral",
		);
		expect(subjectAsRelationStatementAnchorRow.panelSubjectRoleInRelationStatement).toBe("relation_statement_anchor");
		expect(subjectAsRelationStatementAnchorRow.readingPhraseFromPanelSubjectPerspective).toBe(
			"has its produced outputs reused by",
		);

		const subject = subjectKanbanBoardCardDisplayEntryForTest.workUnit;
		const other = creatorNeighborInOtherProjectDisplayEntryForTest.workUnit;
		const symmetricRelationReadFromBothEnds = [
			{ relationStatementSubjectWorkUnitRef: subject, relationStatementAnchorWorkUnitRef: other },
			{ relationStatementSubjectWorkUnitRef: other, relationStatementAnchorWorkUnitRef: subject },
		].map(
			(endpoints) =>
				buildWorkUnitAssertedRelationNeighborhoodPresentation({
					relationNeighborhoodSummary: buildRelationNeighborhoodSummaryResponseForTest({
						subjectWorkUnit: subjectKanbanBoardCardDisplayEntryForTest,
						neighborWorkUnits: [creatorNeighborInOtherProjectDisplayEntryForTest],
						recordedRelations: [],
						assertedRelations: [
							buildAssertedRelationForTest({
								relationId: "symmetric-cross-repository-counterpart",
								relationKind: "reference_is_cross_repository_counterpart_with",
								...endpoints,
								relationAsserterWorkUnitRef: subject,
								assertedRelationKindSpecificAttributes: {
									sharedCrossRepositoryContractPointer: "api/schema.json",
								},
							}),
						],
					}),
					currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
					knownKanbanProjectByWorkspaceId: KNOWN_KANBAN_PROJECTS_WITH_BOTH_WORKSPACES,
				}).assertedByPanelSubjectOrConfirmedRelationRows[0]?.readingPhraseFromPanelSubjectPerspective,
		);
		expect(symmetricRelationReadFromBothEnds).toEqual([
			"is the cross-repository counterpart of",
			"is the cross-repository counterpart of",
		]);
	});

	it("决策来源与断言方标签", () => {
		const presentation = buildStandardAssertedPresentation();
		const assertedByThisTaskRow = findAssertedRelationRowById(presentation, "asserted-subject-concerns-creator");
		expect(assertedByThisTaskRow.assertedRelationDecisionSourceLabel).toBe("Agent assertion · not reviewed by you");
		expect(assertedByThisTaskRow.relationAsserter).toEqual({
			relationAsserterKind: "panel_subject_work_unit",
			relationAsserterDisplayLabel: "this task",
		});
		expect(assertedByThisTaskRow.isUnilaterallyDeclaredByAnotherWorkUnitWithoutConfirmation).toBe(false);

		const assertedByUserRow = findAssertedRelationRowById(presentation, "asserted-child-verifies-subject-by-user");
		expect(assertedByUserRow.assertedRelationDecisionSourceLabel).toBe("Asserted by you");
		expect(assertedByUserRow.relationAsserter.relationAsserterKind).toBe("web_ui_user");

		const unilateralRow = findAssertedRelationRowById(presentation, "asserted-creator-reuses-subject-unilateral");
		expect(unilateralRow.isUnilaterallyDeclaredByAnotherWorkUnitWithoutConfirmation).toBe(true);
		expect(unilateralRow.relationAssertionRationaleOneSentence).toBe(
			UNILATERALLY_DECLARED_RATIONALE_THAT_LOOKS_LIKE_AN_INSTRUCTION_FOR_TEST,
		);
		expect(unilateralRow.relationAsserter).toMatchObject({
			relationAsserterKind: "other_work_unit",
			relationAsserterDisplayLabel: "Creator card in other project",
		});

		expect(
			resolveAssertedRelationDecisionSourceCategory(["user_decided_in_web_ui_with_verified_user_decision_nonce"]),
		).toBe("confirmed_by_user_in_web_ui");
		expect(
			resolveAssertedRelationDecisionSourceCategory([
				"strategy_requires_no_user_review",
				"independent_automated_verification_passed_after_user_accepted_calibration_sample",
			]),
		).toBe("independently_verified_by_automated_verifier");
	});

	it("对端断言、但经用户确认过的关系不算单方面声明，进 (a)", () => {
		const presentation = buildWorkUnitAssertedRelationNeighborhoodPresentation({
			relationNeighborhoodSummary: buildRelationNeighborhoodSummaryResponseForTest({
				subjectWorkUnit: subjectKanbanBoardCardDisplayEntryForTest,
				neighborWorkUnits: [childNeighborInTrashOfCurrentProjectDisplayEntryForTest],
				recordedRelations: [],
				assertedRelations: [
					buildAssertedRelationForTest({
						relationId: "asserted-by-child-confirmed-by-user",
						relationKind: "reference_requirement_originates_from",
						relationStatementSubjectWorkUnitRef: childNeighborInTrashOfCurrentProjectDisplayEntryForTest.workUnit,
						relationStatementAnchorWorkUnitRef: subjectKanbanBoardCardDisplayEntryForTest.workUnit,
						decisionSourcesOfEffectiveAssertion: [
							"strategy_requires_no_user_review",
							"user_decided_in_web_ui_with_verified_user_decision_nonce",
						],
					}),
				],
			}),
			currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			knownKanbanProjectByWorkspaceId: KNOWN_KANBAN_PROJECTS_WITH_BOTH_WORKSPACES,
		});
		expect(presentation.unilaterallyDeclaredByAnotherWorkUnitRelationRows).toEqual([]);
		expect(presentation.assertedByPanelSubjectOrConfirmedRelationRows[0]).toMatchObject({
			relationId: "asserted-by-child-confirmed-by-user",
			assertedRelationDecisionSourceLabel: "Confirmed by you",
			readingPhraseFromPanelSubjectPerspective: "originated requirements of",
		});
	});

	it("对称关系被对端 agent 重断言并入后：与 runtime 文本渲染同一判据，本卡视角按单方面声明分组，并列出对端贡献方", () => {
		const subject = subjectKanbanBoardCardDisplayEntryForTest.workUnit;
		const counterpart = creatorNeighborInOtherProjectDisplayEntryForTest.workUnit;
		const buildPresentationOfSymmetricRelation = (input: {
			relationContributingAgentWorkUnitRefs: Array<typeof subject>;
			decisionSourcesOfEffectiveAssertion?: string[];
		}) =>
			buildWorkUnitAssertedRelationNeighborhoodPresentation({
				relationNeighborhoodSummary: buildRelationNeighborhoodSummaryResponseForTest({
					subjectWorkUnit: subjectKanbanBoardCardDisplayEntryForTest,
					neighborWorkUnits: [creatorNeighborInOtherProjectDisplayEntryForTest],
					recordedRelations: [],
					assertedRelations: [
						buildAssertedRelationForTest({
							relationId: "symmetric-counterpart-merged-by-other-endpoint",
							relationKind: "reference_is_cross_repository_counterpart_with",
							relationStatementSubjectWorkUnitRef: subject,
							relationStatementAnchorWorkUnitRef: counterpart,
							relationAsserterWorkUnitRef: subject,
							relationContributingAgentWorkUnitRefs: input.relationContributingAgentWorkUnitRefs,
							decisionSourcesOfEffectiveAssertion: input.decisionSourcesOfEffectiveAssertion,
							assertedRelationKindSpecificAttributes: {
								sharedCrossRepositoryContractPointer: "written by the counterpart agent",
							},
						}),
					],
				}),
				currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				knownKanbanProjectByWorkspaceId: KNOWN_KANBAN_PROJECTS_WITH_BOTH_WORKSPACES,
			});

		const mergedByCounterpart = buildPresentationOfSymmetricRelation({
			relationContributingAgentWorkUnitRefs: [subject, counterpart],
		});
		expect(mergedByCounterpart.assertedByPanelSubjectOrConfirmedRelationRows).toEqual([]);
		const [unilateralRow] = mergedByCounterpart.unilaterallyDeclaredByAnotherWorkUnitRelationRows;
		expect(unilateralRow?.isUnilaterallyDeclaredByAnotherWorkUnitWithoutConfirmation).toBe(true);
		expect(unilateralRow?.relationAsserter.relationAsserterKind).toBe("panel_subject_work_unit");
		expect(unilateralRow?.otherAgentWorkUnitNeighborsThatMergedContentByReassertion).toEqual([
			expect.objectContaining({ neighborWorkUnitType: "kanban_board_card", neighborKanbanBoardCardTaskId: "def34" }),
		]);

		const reassertedOnlyByPanelSubject = buildPresentationOfSymmetricRelation({
			relationContributingAgentWorkUnitRefs: [subject],
		});
		expect(reassertedOnlyByPanelSubject.unilaterallyDeclaredByAnotherWorkUnitRelationRows).toEqual([]);
		expect(
			reassertedOnlyByPanelSubject.assertedByPanelSubjectOrConfirmedRelationRows[0]
				?.otherAgentWorkUnitNeighborsThatMergedContentByReassertion,
		).toEqual([]);

		const confirmedByUserAfterMerge = buildPresentationOfSymmetricRelation({
			relationContributingAgentWorkUnitRefs: [subject, counterpart],
			decisionSourcesOfEffectiveAssertion: [
				"strategy_requires_no_user_review",
				"user_decided_in_web_ui_with_verified_user_decision_nonce",
			],
		});
		expect(confirmedByUserAfterMerge.unilaterallyDeclaredByAnotherWorkUnitRelationRows).toEqual([]);
		expect(confirmedByUserAfterMerge.assertedByPanelSubjectOrConfirmedRelationRows[0]).toMatchObject({
			relationId: "symmetric-counterpart-merged-by-other-endpoint",
			assertedRelationDecisionSourceLabel: "Confirmed by you",
		});
	});

	it("本版界面不认识的 kind：通用读法点明主体角色，不崩、不吞", () => {
		const unknownKindRow = findAssertedRelationRowById(
			buildStandardAssertedPresentation(),
			"asserted-of-kind-unknown-to-this-web-ui",
		);
		expect(unknownKindRow.isRelationKindRecognizedByThisWebUi).toBe(false);
		expect(unknownKindRow.readingPhraseFromPanelSubjectPerspective).toBe(
			'has an asserted relation "reference_kind_added_in_a_later_runtime" (as subject) with',
		);
		expect(unknownKindRow.assertedRelationKindSpecificAttributeSummaryEntries).toEqual([
			{
				attributeKey: "attributeAddedInALaterRuntime",
				attributeDisplayLabel: "attributeAddedInALaterRuntime",
				attributeDisplayValues: ['{"nested":true}'],
			},
		]);
	});

	it("专有属性摘要：已知属性按固定顺序与展示名，泛相关理由与断言理由相同时不重复", () => {
		const presentation = buildStandardAssertedPresentation();
		expect(
			findAssertedRelationRowById(presentation, "asserted-subject-concerns-creator")
				.assertedRelationKindSpecificAttributeSummaryEntries,
		).toEqual([
			{
				attributeKey: "concernedAspectSummary",
				attributeDisplayLabel: "Aspect",
				attributeDisplayValues: ["retry loop"],
			},
			{
				attributeKey: "concernNature",
				attributeDisplayLabel: "Nature",
				attributeDisplayValues: ["diagnoses failure of"],
			},
		]);
		expect(
			findAssertedRelationRowById(presentation, "asserted-child-verifies-subject-by-user")
				.assertedRelationKindSpecificAttributeSummaryEntries,
		).toEqual([
			{
				attributeKey: "claimsUnderVerification",
				attributeDisplayLabel: "Claims",
				attributeDisplayValues: ["cache is invalidated (pending)"],
			},
		]);
		expect(
			findAssertedRelationRowById(presentation, "asserted-subject-generally-related-child")
				.assertedRelationKindSpecificAttributeSummaryEntries,
		).toEqual([]);
		expect(
			buildAssertedRelationKindSpecificAttributeSummaryEntries({
				assertedRelationKindSpecificAttributes: { reusedOutputPointers: ["a.md", "b.md"], reusedOutputSummary: "" },
				relationAssertionRationaleOneSentence: "irrelevant",
			}),
		).toEqual([
			{
				attributeKey: "reusedOutputPointers",
				attributeDisplayLabel: "Reused output pointers",
				attributeDisplayValues: ["a.md", "b.md"],
			},
		]);
	});

	it("没有断言型关系（含旧 runtime 不带该字段）时为空", () => {
		const emptyPresentation = buildWorkUnitAssertedRelationNeighborhoodPresentation({
			relationNeighborhoodSummary: buildEmptyRelationNeighborhoodSummaryResponseForTest(),
			currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			knownKanbanProjectByWorkspaceId: null,
		});
		expect(emptyPresentation.effectiveAssertedRelationCount).toBe(0);

		const { assertedRelations: _omittedByOlderRuntime, ...responseFromOlderRuntime } =
			buildEmptyRelationNeighborhoodSummaryResponseForTest();
		expect(
			buildWorkUnitAssertedRelationNeighborhoodPresentation({
				relationNeighborhoodSummary: responseFromOlderRuntime as ReturnType<
					typeof buildEmptyRelationNeighborhoodSummaryResponseForTest
				>,
				currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				knownKanbanProjectByWorkspaceId: null,
			}).effectiveAssertedRelationCount,
		).toBe(0);
	});
});
