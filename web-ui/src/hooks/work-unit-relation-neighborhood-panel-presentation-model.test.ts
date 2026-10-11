import { describe, expect, it } from "vitest";
import {
	buildWorkUnitRelationNeighborhoodPanelPresentation,
	type KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel,
	type WorkUnitRelationNeighborPresentation,
	type WorkUnitRelationSentenceFromPanelSubjectPerspective,
} from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";
import {
	buildEmptyRelationNeighborhoodSummaryResponseForTest,
	buildStandardRelationNeighborhoodSummaryResponseForTest,
	CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
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

function buildStandardPresentation(
	knownKanbanProjectByWorkspaceId: KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel = KNOWN_KANBAN_PROJECTS_WITH_BOTH_WORKSPACES,
) {
	return buildWorkUnitRelationNeighborhoodPanelPresentation({
		relationNeighborhoodSummary: buildStandardRelationNeighborhoodSummaryResponseForTest(),
		currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
		knownKanbanProjectByWorkspaceId,
	});
}

function findRelationSentenceById(
	relationSentences: WorkUnitRelationSentenceFromPanelSubjectPerspective[],
	relationId: string,
): WorkUnitRelationSentenceFromPanelSubjectPerspective {
	const relationSentence = relationSentences.find((sentence) => sentence.relationId === relationId);
	if (!relationSentence) {
		throw new Error(`relation sentence ${relationId} not found`);
	}
	return relationSentence;
}

function expectKanbanBoardCardNeighbor(
	neighbor: WorkUnitRelationNeighborPresentation,
): Extract<WorkUnitRelationNeighborPresentation, { neighborWorkUnitType: "kanban_board_card" }> {
	if (neighbor.neighborWorkUnitType !== "kanban_board_card") {
		throw new Error("expected a kanban board card neighbor");
	}
	return neighbor;
}

// dd2db 1b Relations 面板展示模型：分区、主体视角读法、折叠计数、静音归组、墓碑 / trash / 可打开性。
describe("buildWorkUnitRelationNeighborhoodPanelPresentation", () => {
	it("按注册表分区优先级排出「来源」「需求修订」两个可见分区，默认不可见的 kind 不进可见分区", () => {
		const presentation = buildStandardPresentation();
		expect(presentation.visibleSections.map((section) => section.neighborhoodSummarySectionTitle)).toEqual([
			"来源",
			"需求修订",
		]);
		expect(presentation.visibleSections[0]?.relationSentences.map((sentence) => sentence.relationId)).toEqual([
			// 两条都是主来源，按最近更新从新到旧。
			"relation-subject-created-child",
			"relation-subject-created-by-creator",
		]);
		expect(presentation.visibleSections[1]?.relationSentences.map((sentence) => sentence.relationId)).toEqual([
			"relation-subject-requirements-amended-by-tombstone",
		]);
	});

	it("主体是 S 用正向读法，是 A 用反向读法，对方一律是另一端", () => {
		const provenanceSentences = buildStandardPresentation().visibleSections[0]?.relationSentences ?? [];
		const subjectAsRelationStatementSubject = findRelationSentenceById(
			provenanceSentences,
			"relation-subject-created-by-creator",
		);
		expect(subjectAsRelationStatementSubject.panelSubjectRoleInRelationStatement).toBe("relation_statement_subject");
		expect(subjectAsRelationStatementSubject.readingPhraseFromPanelSubjectPerspective).toBe("was created by");
		expect(
			expectKanbanBoardCardNeighbor(subjectAsRelationStatementSubject.counterpartNeighbor)
				.neighborKanbanBoardCardTaskId,
		).toBe("def34");

		const subjectAsRelationStatementAnchor = findRelationSentenceById(
			provenanceSentences,
			"relation-subject-created-child",
		);
		expect(subjectAsRelationStatementAnchor.panelSubjectRoleInRelationStatement).toBe("relation_statement_anchor");
		expect(subjectAsRelationStatementAnchor.readingPhraseFromPanelSubjectPerspective).toBe("created");
		expect(
			expectKanbanBoardCardNeighbor(subjectAsRelationStatementAnchor.counterpartNeighbor)
				.neighborKanbanBoardCardTaskId,
		).toBe("ghi56");
	});

	it("派发控制与生命周期折叠成按读法分组的计数，读法同样以主体视角", () => {
		const presentation = buildStandardPresentation();
		expect(
			presentation.collapsedCountGroups.map((group) => [
				group.readingPhraseFromPanelSubjectPerspective,
				group.collapsedRelationSentences.length,
			]),
		).toEqual([
			["had its board lifecycle transitioned by", 1],
			["dispatched or controlled the agent session of", 1],
		]);
	});

	it("静音的关系移出常规分区与折叠计数，单独归进已静音组（不彻底消失）", () => {
		const presentation = buildStandardPresentation();
		const allNonMutedRelationIds = [
			...presentation.visibleSections.flatMap((section) => section.relationSentences),
			...presentation.collapsedCountGroups.flatMap((group) => group.collapsedRelationSentences),
		].map((sentence) => sentence.relationId);
		expect(allNonMutedRelationIds).not.toContain("relation-subject-forked-creator-muted");
		expect(presentation.mutedInPresentationRelationSentences.map((sentence) => sentence.relationId)).toEqual([
			"relation-subject-forked-creator-muted",
		]);
		expect(presentation.mutedInPresentationRelationSentences[0]?.relationMutedInPresentationAt).toBe(6_000);
		expect(presentation.mutedInPresentationRelationSentences[0]?.readingPhraseFromPanelSubjectPerspective).toBe(
			"forked the conversation session of",
		);
	});

	it("本版不认识的 kind 只计数、不列出；会话归属冲突如实计数", () => {
		const presentation = buildStandardPresentation();
		expect(presentation.unrecognizedRelationKindRelationCount).toBe(1);
		expect(presentation.conversationSessionOwnershipConflictCount).toBe(1);
		expect(presentation.hasNoRecordedRelationAtAll).toBe(false);
	});

	it("交互轴关系带出次数与改动字段", () => {
		const amendment = buildStandardPresentation().visibleSections[1]?.relationSentences[0];
		expect(amendment?.relationOccurrenceCountAcrossTaskMutationEventKinds).toBe(2);
		expect(amendment?.changedKanbanBoardCardFieldNames).toEqual(["prompt", "title"]);
	});

	it("邻居卡：跨项目在板可打开，trash 标出且可打开，墓碑不可打开并给出原因", () => {
		const presentation = buildStandardPresentation();
		const provenanceSentences = presentation.visibleSections[0]?.relationSentences ?? [];
		const creatorInOtherProject = expectKanbanBoardCardNeighbor(
			findRelationSentenceById(provenanceSentences, "relation-subject-created-by-creator").counterpartNeighbor,
		);
		expect(creatorInOtherProject.neighborKanbanBoardCardCurrentTitle).toBe("Creator card in other project");
		expect(creatorInOtherProject.neighborKanbanBoardCardWorkspaceDisplayName).toBe("other-project");
		expect(creatorInOtherProject.isNeighborKanbanBoardCardInCurrentKanbanProject).toBe(false);
		expect(creatorInOtherProject.neighborKanbanBoardCardPresenceOnBoardStatus).toBe("on_kanban_board");
		expect(creatorInOtherProject.neighborKanbanBoardCardOpenInProjectAvailability).toEqual({
			isNeighborKanbanBoardCardOpenable: true,
		});

		const childInTrash = expectKanbanBoardCardNeighbor(
			findRelationSentenceById(provenanceSentences, "relation-subject-created-child").counterpartNeighbor,
		);
		expect(childInTrash.isNeighborKanbanBoardCardInCurrentKanbanProject).toBe(true);
		expect(childInTrash.neighborKanbanBoardCardPresenceOnBoardStatus).toBe("moved_to_done_trash_column");
		expect(childInTrash.neighborKanbanBoardCardOpenInProjectAvailability.isNeighborKanbanBoardCardOpenable).toBe(
			true,
		);

		const tombstone = expectKanbanBoardCardNeighbor(
			findRelationSentenceById(
				presentation.visibleSections[1]?.relationSentences ?? [],
				"relation-subject-requirements-amended-by-tombstone",
			).counterpartNeighbor,
		);
		expect(tombstone.neighborKanbanBoardCardPresenceOnBoardStatus).toBe(
			"permanently_removed_from_kanban_board_tombstone",
		);
		expect(tombstone.neighborKanbanBoardCardOpenInProjectAvailability).toEqual({
			isNeighborKanbanBoardCardOpenable: false,
			neighborKanbanBoardCardNotOpenableReason: expect.stringContaining("永久删除"),
		});
	});

	it("没有跨项目打开宿主时邻居只展示；workspace 名回落到仓库路径末段", () => {
		const presentation = buildStandardPresentation(null);
		const creator = expectKanbanBoardCardNeighbor(
			findRelationSentenceById(
				presentation.visibleSections[0]?.relationSentences ?? [],
				"relation-subject-created-by-creator",
			).counterpartNeighbor,
		);
		expect(creator.neighborKanbanBoardCardWorkspaceDisplayName).toBe(
			`${OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST}-repository-checkout`,
		);
		expect(creator.neighborKanbanBoardCardOpenInProjectAvailability.isNeighborKanbanBoardCardOpenable).toBe(false);
	});

	it("邻居所在项目不在当前 Kanban 项目列表里时不可打开", () => {
		const presentation = buildStandardPresentation(
			new Map([
				[
					CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
					{ kanbanProjectName: "current-project", isKanbanProjectAvailable: true },
				],
			]),
		);
		const creator = expectKanbanBoardCardNeighbor(
			findRelationSentenceById(
				presentation.visibleSections[0]?.relationSentences ?? [],
				"relation-subject-created-by-creator",
			).counterpartNeighbor,
		);
		expect(creator.neighborKanbanBoardCardOpenInProjectAvailability).toEqual({
			isNeighborKanbanBoardCardOpenable: false,
			neighborKanbanBoardCardNotOpenableReason: expect.stringContaining("项目列表"),
		});
	});

	it("空邻域：没有任何分区，标记为一条关系都没有", () => {
		const presentation = buildWorkUnitRelationNeighborhoodPanelPresentation({
			relationNeighborhoodSummary: buildEmptyRelationNeighborhoodSummaryResponseForTest(),
			currentKanbanProjectWorkspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			knownKanbanProjectByWorkspaceId: KNOWN_KANBAN_PROJECTS_WITH_BOTH_WORKSPACES,
		});
		expect(presentation.hasNoRecordedRelationAtAll).toBe(true);
		expect(presentation.visibleSections).toEqual([]);
		expect(presentation.collapsedCountGroups).toEqual([]);
		expect(presentation.mutedInPresentationRelationSentences).toEqual([]);
	});
});
