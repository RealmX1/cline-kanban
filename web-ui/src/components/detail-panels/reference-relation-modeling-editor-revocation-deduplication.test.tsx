import type { AssertedInterWorkUnitRelation } from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import type { RelationModelingPreviewResponse } from "@runtime-work-unit-relation-modeling-api-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReferenceRelationModelingEditor } from "@/hooks/use-reference-relation-modeling-editor";
import { ReferenceRelationModelingEditor } from "./reference-relation-modeling-editor";

const queries = vi.hoisted(() => ({
	readRelationModelingEditorDraft: vi.fn(),
	persistRelationModelingEditorDraft: vi.fn(),
	readRelationModelingPreview: vi.fn(),
	applyReferenceRelationModelingChangesFromExplicitUserGesture: vi.fn(),
	resolveRelationModelingCounterpart: vi.fn(),
}));
vi.mock("@/runtime/work-unit-relation-modeling-query", () => queries);
vi.mock("./reference-relation-modeling-graph", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ReferenceRelationModelingGraph: () => null,
}));

const savedRelation: AssertedInterWorkUnitRelation = {
	relationId: "saved-reference-relation",
	relationKind: "reference_is_generally_related_with",
	relationStatementSubjectWorkUnitRef: {
		workUnitType: "kanban_board_card",
		workspaceId: "project-a",
		taskId: "task-a",
		taskIncarnationCreatedAtEpochMs: 1,
	},
	relationStatementAnchorWorkUnitRef: {
		workUnitType: "kanban_board_card",
		workspaceId: "project-a",
		taskId: "counterpart-task",
		taskIncarnationCreatedAtEpochMs: 2,
	},
	relationAssertionNaturalKey: "saved-reference-natural-key",
	assertionEffectivenessState: "applied_and_effective",
	assertedRelationStateVersion: 3,
	relationFirstEstablishedAt: 1,
	relationLastUpdatedAt: 2,
	relationAsserterActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce",
	relationAsserterWorkUnitRef: null,
	relationAsserterPolicyIdentityKey: "kanban_web_ui_user_with_verified_page_load_nonce",
	relationContributingAgentWorkUnitRefs: [],
	relationAssertionRationaleOneSentence: "共享验收目标",
	relationAssertionEvidencePointers: [],
	assertedRelationKindSpecificAttributes: {},
	effectiveConfirmableChangeIdForCurrentAssertionState: "saved-reference-change",
	effectiveConfirmableChangeDecisionSource: "asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
	effectiveConfirmableChangeAppliedAt: 2,
	decisionSourcesOfEffectiveAssertion: ["asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce"],
	reassertingActorKinds: [],
	revokedAt: null,
	relationAssertionRevocationReason: null,
	revokedByActorKind: null,
};
const savedPreview: RelationModelingPreviewResponse = {
	rootWorkUnitKey: "current-task",
	workUnits: [],
	relations: [
		{
			relationId: savedRelation.relationId,
			subjectKey: "current-task",
			anchorKey: "counterpart-task",
			relationKind: savedRelation.relationKind,
			relationPresentationState: "saved",
			assertedRelation: savedRelation,
		},
	],
	truncated: false,
	projectedThroughGlobalCommittedEventSequence: 1,
};

let controller: ReturnType<typeof useReferenceRelationModelingEditor>;
let root: Root;
let container: HTMLDivElement;
const onRelationsSaved = vi.fn();
function Harness() {
	controller = useReferenceRelationModelingEditor({ workspaceId: "project-a", taskId: "task-a" });
	return (
		<ReferenceRelationModelingEditor
			controller={controller}
			workspaceId="project-a"
			taskId="task-a"
			onRelationsSaved={onRelationsSaved}
		/>
	);
}

async function clickButton(label: string) {
	const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!button) throw new Error(`找不到按钮：${label}`);
	await act(async () => button.click());
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	localStorage.clear();
	sessionStorage.clear();
	vi.resetAllMocks();
	queries.readRelationModelingEditorDraft.mockResolvedValue(null);
	queries.persistRelationModelingEditorDraft.mockResolvedValue({ saved: true });
	queries.readRelationModelingPreview
		.mockReturnValue(new Promise<RelationModelingPreviewResponse>(() => {}))
		.mockResolvedValueOnce(savedPreview);
	queries.applyReferenceRelationModelingChangesFromExplicitUserGesture.mockResolvedValue({
		modelingSubmissionId: "saved-revocation",
		alreadyApplied: false,
	});
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	await act(async () => root.render(<Harness />));
	await act(async () => vi.advanceTimersByTimeAsync(150));
	await clickButton("列表");
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("关系预览刷新完成前的撤销去重", () => {
	it.each([
		["结束关系", "结束关系", "relation_ended_naturally"],
		["标记关系有误", "标记关系有误", "relation_was_incorrect"],
		["结束关系", "标记关系有误", "relation_was_incorrect"],
		["标记关系有误", "结束关系", "relation_ended_naturally"],
	])("先点击 %s，再点击 %s，保存时只提交最新理由 %s", async (firstAction, latestAction, expectedReason) => {
		await clickButton(firstAction);
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(2);
		expect(controller.preview).toEqual(savedPreview);
		await clickButton(latestAction);
		await clickButton("保存关系变更");
		expect(queries.applyReferenceRelationModelingChangesFromExplicitUserGesture).toHaveBeenCalledExactlyOnceWith(
			"project-a",
			expect.objectContaining({
				relationRevocations: [
					{
						relationId: savedRelation.relationId,
						expectedAssertedRelationStateVersion: savedRelation.assertedRelationStateVersion,
						relationAssertionRevocationReason: expectedReason,
					},
				],
			}),
		);
		expect(onRelationsSaved).toHaveBeenCalledOnce();
	});
});
