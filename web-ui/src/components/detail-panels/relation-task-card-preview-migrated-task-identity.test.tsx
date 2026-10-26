import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type { WorkUnitDisplayEntry } from "@runtime-work-unit-relation-read-api-contract";
import type { ReactFlowProps } from "@xyflow/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { ReferenceRelationModelingEditor } from "@/components/detail-panels/reference-relation-modeling-editor";
import { RelationTaskCardPreviewLayout } from "@/components/detail-panels/relation-task-card-preview-layout";
import { RelationNeighborWorkUnitReference } from "@/components/detail-panels/work-unit-relation-neighborhood-panel-neighbor-reference-and-badges";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ExpandedForegroundViewContext } from "@/expanded-foreground-view/expanded-foreground-view-context";
import type { ReferenceRelationModelingEditorController } from "@/hooks/use-reference-relation-modeling-editor";
import { useRelationTaskCardPreview } from "@/hooks/use-relation-task-card-preview";
import { buildWorkUnitAssertedRelationNeighborhoodPresentation } from "@/hooks/work-unit-asserted-relation-neighborhood-presentation-model";
import { buildWorkUnitRelationNeighborhoodPanelPresentation } from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";
import {
	buildAssertedRelationForTest,
	buildKanbanBoardCardDisplayEntryForTest,
	buildRecordedRelationForTest,
	buildRelationNeighborhoodSummaryResponseForTest,
} from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";

const { readSnapshot, resolveCandidates, openTask, openRelations } = vi.hoisted(() => ({
	readSnapshot: vi.fn(),
	resolveCandidates: vi.fn(),
	openTask: vi.fn(),
	openRelations: vi.fn(),
}));
vi.mock("@/runtime/directly-related-task-preview-query", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	fetchQualifiedTaskCardSnapshotForRelatedPreview: readSnapshot,
}));
vi.mock("@/runtime/cross-project-task-worktree-git-metadata-query", () => ({
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries: async () => ({ tasks: [] }),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string) => ({
		workUnit: {
			resolveKanbanBoardCardIdentityByBareTaskId: {
				query: (input: unknown) => resolveCandidates(workspaceId, input),
			},
		},
	}),
}));
vi.mock("@/utils/react-use", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useMeasure: () => [vi.fn(), { width: 900, height: 360 }],
}));
vi.mock("@xyflow/react", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ReactFlow: ({ nodes = [], onNodeClick }: ReactFlowProps) => (
		<div>
			{nodes.map((node) => (
				<button
					key={node.id}
					type="button"
					className="react-flow__node"
					data-id={node.id}
					aria-label={`图节点 ${node.id}`}
					onClick={(event) => onNodeClick?.(event, node)}
				>
					{node.data.label as ReactNode}
				</button>
			))}
		</div>
	),
}));
vi.mock("@/components/detail-panels/work-unit-relation-counterpart-kanban-board-card-picker", () => ({
	WorkUnitRelationCounterpartKanbanBoardCardPicker: () => null,
}));

const rootEntry = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: "project-a",
	taskId: "root",
	currentTitle: "当前任务",
});
const canonicalTask: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "project-b",
	taskId: "review",
	taskIncarnationCreatedAtEpochMs: 1_000,
};
const currentTask = { ...canonicalTask, workspaceId: "project-a" };
const currentDisplayEntry = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: currentTask.workspaceId,
	taskId: currentTask.taskId,
	currentTitle: "已迁移的任务",
});
const migratedEntry: WorkUnitDisplayEntry = {
	...currentDisplayEntry,
	workUnitKey: "kanban_board_card:project-b:review:1000",
	workUnit: canonicalTask,
	kanbanBoardCardIdentity: {
		...currentDisplayEntry.kanbanBoardCardIdentity!,
		kanbanBoardCard: currentTask,
		canonicalKanbanBoardCard: canonicalTask,
	},
};
const knownProjects = new Map([["project-a", { kanbanProjectName: "迁入项目", isKanbanProjectAvailable: true }]]);
const summary = buildRelationNeighborhoodSummaryResponseForTest({
	subjectWorkUnit: rootEntry,
	neighborWorkUnits: [migratedEntry],
	recordedRelations: [
		buildRecordedRelationForTest({
			relationId: "recorded-migrated-neighbor",
			relationKind: "provenance_created_by",
			relationStatementSubjectWorkUnitRef: rootEntry.workUnit,
			relationStatementAnchorWorkUnitRef: canonicalTask,
		}),
	],
	assertedRelations: [
		buildAssertedRelationForTest({
			relationId: "asserted-migrated-neighbor",
			relationKind: "reference_concerns",
			relationStatementSubjectWorkUnitRef: rootEntry.workUnit,
			relationStatementAnchorWorkUnitRef: canonicalTask,
		}),
	],
});
const presentationInput = {
	relationNeighborhoodSummary: summary,
	currentKanbanProjectWorkspaceId: "project-a",
	knownKanbanProjectByWorkspaceId: knownProjects,
};
const recordedNeighbor = () =>
	buildWorkUnitRelationNeighborhoodPanelPresentation(presentationInput).visibleSections[0]!.relationSentences[0]!
		.counterpartNeighbor;
const assertedNeighbor = () =>
	buildWorkUnitAssertedRelationNeighborhoodPresentation(presentationInput)
		.assertedByPanelSubjectOrConfirmedRelationRows[0]!.counterpartNeighbor;

function Host({ children }: { children: ReactNode }) {
	return (
		<TooltipProvider>
			<ExpandedForegroundViewContext.Provider
				value={{
					target: null,
					ownerSurfaceId: null,
					open: openRelations,
					close: vi.fn(),
					dismissForTaskNavigation: vi.fn(),
					registerSurface: vi.fn(),
					releaseSurface: vi.fn(),
				}}
			>
				<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider
					value={{
						projects: [
							{
								id: "project-a",
								name: "迁入项目",
								path: "/repos/project-a",
								availability: { status: "available" },
								taskCounts: { backlog: 0, in_progress: 0, review: 2, validation: 0, trash: 0 },
								inProgressTaskDetails: [],
								crossProjectTaskSwitcherEntries: [],
							},
						],
						currentProjectId: "project-a",
						notificationLogByWorkspaceId: {},
						isBoardScopeAllProjectsSelected: false,
						focusedTaskInProject: null,
						onOpenTaskInProject: openTask,
						onRequestPinCurrentProjectTaskToTaskPinboard: vi.fn(),
						onUnpinCurrentProjectTaskFromTaskPinboard: vi.fn(),
						onEditCurrentProjectTaskPinboardPinReason: vi.fn(),
					}}
				>
					{children}
				</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
			</ExpandedForegroundViewContext.Provider>
		</TooltipProvider>
	);
}
function SummaryHarness({ asserted }: { asserted: boolean }) {
	const controller = useRelationTaskCardPreview();
	return (
		<RelationTaskCardPreviewLayout controller={controller}>
			<RelationNeighborWorkUnitReference
				neighbor={asserted ? assertedNeighbor() : recordedNeighbor()}
				openNeighborKanbanBoardCardInItsProject={openTask}
			/>
		</RelationTaskCardPreviewLayout>
	);
}
function editorController(relationKind = "provenance_created_by"): ReferenceRelationModelingEditorController {
	return {
		suggestions: null,
		suggestionsLoading: false,
		suggestionsError: null,
		requestSuggestions: vi.fn(),
		draft: {
			referenceRelationDrafts: [],
			relationRevocations: [],
			createdTaskId: null,
			createdTaskCardSnapshot: null,
			modelingSubmissionId: "migration-test-submission",
			creationPrompt: "",
			creationTitle: "",
		},
		ready: true,
		preview: {
			rootWorkUnitKey: rootEntry.workUnitKey,
			workUnits: [rootEntry, migratedEntry],
			relations: [
				{
					relationId: "root-to-migrated-task",
					subjectKey: rootEntry.workUnitKey,
					anchorKey: migratedEntry.workUnitKey,
					relationKind,
					relationPresentationState: "saved",
					assertedRelation: null,
				},
			],
			truncated: false,
			projectedThroughGlobalCommittedEventSequence: 1,
		},
		error: null,
		draftPersistenceError: null,
		saving: false,
		depth: 2,
		setDepth: vi.fn(),
		addDraft: vi.fn(),
		updateDraft: vi.fn(),
		applyToTask: vi.fn(),
		readLatestDraft: vi.fn(),
		persistDraftNow: vi.fn(),
		refresh: vi.fn(),
		hasChanges: false,
		discard: vi.fn(),
	};
}
let root: Root;
let container: HTMLDivElement;
async function render(contents: ReactNode) {
	await act(async () => root.render(<Host>{contents}</Host>));
}
async function clickButton(label: string) {
	const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label,
	);
	if (!button) throw new Error(`找不到按钮：${label}`);
	await act(async () => button.click());
}
async function prepareRelationForm() {
	const controller = editorController();
	await render(<ReferenceRelationModelingEditor controller={controller} workspaceId="project-a" taskId="root" />);
	await clickButton(`图节点 ${migratedEntry.workUnitKey}`);
	await clickButton("与当前任务建立关系");
	const kind = container.querySelector<HTMLSelectElement>('select[aria-label="关系类型"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
			kind,
			"reference_is_generally_related_with",
		);
		kind.dispatchEvent(new Event("change", { bubbles: true }));
	});
	const reasonLabel = [...container.querySelectorAll("label")].find(
		(label) => label.firstChild?.textContent?.trim() === "关系理由",
	);
	const reason = reasonLabel!.querySelector("input")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "复用迁移前的工作产物");
		reason.dispatchEvent(new Event("input", { bubbles: true }));
	});
	return controller;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	readSnapshot.mockImplementation(async (task: KanbanBoardCardWorkUnitQualifiedReference) => ({
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: {
			taskCard: {
				id: task.taskId,
				title: "完整任务卡片",
				prompt: "完整任务描述",
				startInPlanMode: false,
				baseRef: "main",
				createdAt: 1_000,
				updatedAt: 1_000,
			},
			boardColumnIdContainingTaskCard: "review",
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		},
	}));
	resolveCandidates.mockImplementation(async (workspaceId: string) => ({
		kanbanBoardCardIdentityCandidates: workspaceId === "project-a" ? [migratedEntry.kanbanBoardCardIdentity] : [],
	}));
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("关系预览保留 canonical 图身份并使用迁移后的位置", () => {
	it.each([false, true])("摘要断言型：%s，当前项目徽标、读卡及两处导航均指向迁入项目", async (asserted) => {
		const neighbor = asserted ? assertedNeighbor() : recordedNeighbor();
		expect(neighbor.neighborWorkUnitKey).toBe(migratedEntry.workUnitKey);
		expect(neighbor).toMatchObject({
			neighborKanbanBoardCardWorkspaceId: "project-a",
			neighborKanbanBoardCardTaskId: "review",
			neighborKanbanBoardCardTaskIncarnationCreatedAtEpochMs: 1_000,
			neighborKanbanBoardCardWorkspaceDisplayName: "迁入项目",
			isNeighborKanbanBoardCardInCurrentKanbanProject: true,
			neighborKanbanBoardCardOpenInProjectAvailability: { isNeighborKanbanBoardCardOpenable: true },
		});
		await render(<SummaryHarness asserted={asserted} />);
		await clickButton(`预览 ${migratedEntry.workUnitDisplayLabel}`);
		expect(readSnapshot.mock.calls[0]?.[0]).toEqual(currentTask);
		await clickButton("打开任务");
		expect(openTask).toHaveBeenLastCalledWith("project-a", "review", 1_000);
		await clickButton(`打开 ${migratedEntry.workUnitDisplayLabel}`);
		expect(openTask).toHaveBeenCalledTimes(2);
		expect(openTask).toHaveBeenLastCalledWith("project-a", "review", 1_000);
	});
	it.each(["provenance_created_by", "reference_concerns"])(
		"图关系 %s 保留 canonical key 并按当前位置读卡与导航",
		async (relationKind) => {
			await render(
				<ReferenceRelationModelingEditor
					controller={editorController(relationKind)}
					workspaceId="project-a"
					taskId="root"
				/>,
			);
			expect(container.querySelector(`[data-id="${migratedEntry.workUnitKey}"]`)?.textContent).toContain(
				"project-a · review",
			);
			await clickButton(`图节点 ${migratedEntry.workUnitKey}`);
			expect(readSnapshot.mock.calls[0]?.[0]).toEqual(currentTask);
			await clickButton("以此任务为中心");
			expect(openRelations).toHaveBeenLastCalledWith({ ...currentTask, viewKind: "task_relations" });
			await clickButton("打开任务");
			expect(openTask).toHaveBeenLastCalledWith("project-a", "review", 1_000);
		},
	);
	it("未迁移的根任务仍按完整身份读取", async () => {
		await render(
			<ReferenceRelationModelingEditor controller={editorController()} workspaceId="project-a" taskId="root" />,
		);
		await clickButton(`图节点 ${rootEntry.workUnitKey}`);
		expect(readSnapshot.mock.calls[0]?.[0]).toEqual(rootEntry.workUnit);
	});
	it("合法迁移按当前位置解析候选，并以 canonical 端点加入关系草稿", async () => {
		const controller = await prepareRelationForm();
		await clickButton("加入关系草稿");
		expect(resolveCandidates).toHaveBeenCalledWith("project-a", { bareTaskId: "review" });
		expect(controller.addDraft).toHaveBeenCalledOnce();
		expect(vi.mocked(controller.addDraft).mock.calls[0]?.[0].counterpartWorkUnit).toEqual(canonicalTask);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});
	it("迁移后同 ID 重建的候选不能绕过创建时间门禁", async () => {
		const controller = await prepareRelationForm();
		resolveCandidates.mockResolvedValue({
			kanbanBoardCardIdentityCandidates: [
				{
					...migratedEntry.kanbanBoardCardIdentity,
					kanbanBoardCard: { ...currentTask, taskIncarnationCreatedAtEpochMs: 2_000 },
					canonicalKanbanBoardCard: { ...canonicalTask, taskIncarnationCreatedAtEpochMs: 2_000 },
				},
			],
		});
		await clickButton("加入关系草稿");
		expect(controller.addDraft).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("预览中的任务已删除并重建");
	});
});
