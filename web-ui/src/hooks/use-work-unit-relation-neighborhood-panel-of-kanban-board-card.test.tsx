import { act, type MouseEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CrossProjectRecentlyActiveTaskSwitcherHostContextProvider,
	type CrossProjectRecentlyActiveTaskSwitcherHostContextValue,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import {
	describeRecordedRelationPresentationMutePreferenceWriteFailureForToast,
	useWorkUnitRelationNeighborhoodPanelOfKanbanBoardCard,
	type WorkUnitRelationNeighborhoodPanelController,
} from "@/hooks/use-work-unit-relation-neighborhood-panel-of-kanban-board-card";
import {
	buildStandardRelationNeighborhoodSummaryResponseForTest,
	buildTrpcClientErrorWithCodeForTest,
	CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
} from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";
import type { RuntimeProjectSummary } from "@/runtime/types";

const { fetchRelationNeighborhoodSummaryMock, setRelationPresentationMutePreferenceMock, showAppToastMock } =
	vi.hoisted(() => ({
		fetchRelationNeighborhoodSummaryMock: vi.fn(),
		setRelationPresentationMutePreferenceMock: vi.fn(),
		showAppToastMock: vi.fn(),
	}));

// 只替换两个传输函数，错误分类沿用真实实现（分类本身是被测行为的一部分）。
vi.mock("@/runtime/work-unit-relation-neighborhood-summary-query", async (importOriginal) => {
	const actualQueryModule: Record<string, unknown> = await importOriginal();
	return {
		...actualQueryModule,
		fetchWorkUnitRelationNeighborhoodSummaryOfKanbanBoardCard: fetchRelationNeighborhoodSummaryMock,
		setRecordedRelationPresentationMutePreferenceFromExplicitUserClick: setRelationPresentationMutePreferenceMock,
	};
});

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
	notifyError: vi.fn(),
}));

const UNUSED_CLICK_EVENT = {} as MouseEvent<HTMLButtonElement>;

function HookHarness({
	workspaceId,
	kanbanBoardCardTaskId,
	onController,
}: {
	workspaceId: string | null;
	kanbanBoardCardTaskId: string | null;
	onController: (controller: WorkUnitRelationNeighborhoodPanelController) => void;
}): null {
	onController(useWorkUnitRelationNeighborhoodPanelOfKanbanBoardCard({ workspaceId, kanbanBoardCardTaskId }));
	return null;
}

function buildCrossProjectTaskOpenHostForTest(
	onOpenTaskInProject: (workspaceId: string, taskId: string) => void,
): CrossProjectRecentlyActiveTaskSwitcherHostContextValue {
	return {
		projects: [
			{
				id: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				path: "/repos/current",
				name: "current-project",
				availability: { status: "available" },
			} as RuntimeProjectSummary,
		],
		notificationLogByWorkspaceId: {},
		currentProjectId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
		isBoardScopeAllProjectsSelected: false,
		focusedTaskInProject: null,
		onOpenTaskInProject,
		onRequestPinCurrentProjectTaskToTaskPinboard: vi.fn(),
		onUnpinCurrentProjectTaskFromTaskPinboard: vi.fn(),
		onEditCurrentProjectTaskPinboardPinReason: vi.fn(),
	};
}

describe("useWorkUnitRelationNeighborhoodPanelOfKanbanBoardCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let controllers: WorkUnitRelationNeighborhoodPanelController[];

	function latestController(): WorkUnitRelationNeighborhoodPanelController {
		const controller = controllers.at(-1);
		expect(controller).toBeDefined();
		return controller!;
	}

	async function flushPendingPromiseCallbacks(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	async function renderHarness(
		props: { workspaceId: string | null; kanbanBoardCardTaskId: string | null },
		wrap: (children: ReactNode) => ReactNode = (children) => children,
	): Promise<void> {
		await act(async () => {
			root.render(wrap(<HookHarness {...props} onController={(controller) => controllers.push(controller)} />));
		});
		await flushPendingPromiseCallbacks();
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		controllers = [];
		fetchRelationNeighborhoodSummaryMock.mockReset();
		setRelationPresentationMutePreferenceMock.mockReset();
		showAppToastMock.mockReset();
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () =>
			buildStandardRelationNeighborhoodSummaryResponseForTest(),
		);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("没有 workspace 时不发请求", async () => {
		await renderHarness({ workspaceId: null, kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST });
		expect(fetchRelationNeighborhoodSummaryMock).not.toHaveBeenCalled();
		expect(latestController().relationNeighborhoodReadState.relationNeighborhoodReadPhase).toBe(
			"no_subject_kanban_board_card",
		);
	});

	it("挂载即读邻域并整理成分区；读取过程绝不触发静音 mutation", async () => {
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		expect(fetchRelationNeighborhoodSummaryMock).toHaveBeenCalledWith({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		const readState = latestController().relationNeighborhoodReadState;
		if (readState.relationNeighborhoodReadPhase !== "relation_neighborhood_loaded") {
			throw new Error(`expected loaded, got ${readState.relationNeighborhoodReadPhase}`);
		}
		expect(
			readState.relationNeighborhoodPanelPresentation.visibleSections.map(
				(section) => section.neighborhoodSummarySectionTitle,
			),
		).toEqual(["来源", "需求修订"]);
		expect(setRelationPresentationMutePreferenceMock).not.toHaveBeenCalled();
	});

	it("SERVICE_UNAVAILABLE 落成「账本不可用」失败态并带原因，绝不落成空邻域", async () => {
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () => {
			throw buildTrpcClientErrorWithCodeForTest("SERVICE_UNAVAILABLE", "Relation ledger database is not open.");
		});
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		expect(latestController().relationNeighborhoodReadState).toEqual({
			relationNeighborhoodReadPhase: "relation_neighborhood_read_failed",
			relationNeighborhoodReadFailure: {
				readFailureKind: "inter_work_unit_relation_ledger_unavailable",
				readFailureReasonMessage: "Relation ledger database is not open.",
			},
		});
	});

	it("NOT_FOUND 与非 tRPC 错误分别分类", async () => {
		fetchRelationNeighborhoodSummaryMock.mockImplementationOnce(async () => {
			throw buildTrpcClientErrorWithCodeForTest("NOT_FOUND", "No Kanban task card with id abc12.");
		});
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		const notFoundState = latestController().relationNeighborhoodReadState;
		expect(
			notFoundState.relationNeighborhoodReadPhase === "relation_neighborhood_read_failed" &&
				notFoundState.relationNeighborhoodReadFailure.readFailureKind,
		).toBe("kanban_board_card_not_known_to_inter_work_unit_relation_ledger");

		fetchRelationNeighborhoodSummaryMock.mockImplementationOnce(async () => {
			throw new TypeError("Failed to fetch");
		});
		await act(async () => {
			latestController().refetchRelationNeighborhood();
		});
		await flushPendingPromiseCallbacks();
		const networkFailureState = latestController().relationNeighborhoodReadState;
		expect(
			networkFailureState.relationNeighborhoodReadPhase === "relation_neighborhood_read_failed" &&
				networkFailureState.relationNeighborhoodReadFailure.readFailureKind,
		).toBe("unexpected_relation_neighborhood_read_failure");
	});

	it("切卡后新邻域到达前显示读取中，不把上一张卡的邻域当成这张卡的", async () => {
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		expect(latestController().relationNeighborhoodReadState.relationNeighborhoodReadPhase).toBe(
			"relation_neighborhood_loaded",
		);
		fetchRelationNeighborhoodSummaryMock.mockImplementation(() => new Promise(() => {}));
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: "zzz99",
		});
		expect(latestController().relationNeighborhoodReadState.relationNeighborhoodReadPhase).toBe(
			"loading_relation_neighborhood",
		);
	});

	it("静音点击处理器：调 mutation 后以 runtime 为准重拉邻域，不弹 toast", async () => {
		let resolvePendingMutePreferenceWrite: (response: unknown) => void = () => {};
		setRelationPresentationMutePreferenceMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePendingMutePreferenceWrite = resolve;
				}),
		);
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		expect(fetchRelationNeighborhoodSummaryMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			latestController().createRecordedRelationMuteToggleButtonClickHandler(
				"relation-subject-created-by-creator",
				true,
			)(UNUSED_CLICK_EVENT);
		});
		expect(
			latestController().relationIdsWithPresentationMuteToggleInFlight.has("relation-subject-created-by-creator"),
		).toBe(true);
		await act(async () => {
			resolvePendingMutePreferenceWrite({
				relationId: "relation-subject-created-by-creator",
				recordedRelationMutedInPresentation: true,
				relationPresentationPreferenceEventRecorded: true,
			});
		});
		await flushPendingPromiseCallbacks();

		expect(setRelationPresentationMutePreferenceMock).toHaveBeenCalledWith({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			relationId: "relation-subject-created-by-creator",
			recordedRelationMutedInPresentation: true,
		});
		expect(fetchRelationNeighborhoodSummaryMock).toHaveBeenCalledTimes(2);
		expect(showAppToastMock).not.toHaveBeenCalled();
		expect(latestController().relationIdsWithPresentationMuteToggleInFlight.size).toBe(0);
	});

	it("静音失败（FORBIDDEN）用 toast 如实提示，不重拉", async () => {
		setRelationPresentationMutePreferenceMock.mockImplementation(async () => {
			throw buildTrpcClientErrorWithCodeForTest("FORBIDDEN", "Verified Web UI page-load nonce required.");
		});
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		await act(async () => {
			latestController().createRecordedRelationMuteToggleButtonClickHandler(
				"relation-subject-forked-creator-muted",
				false,
			)(UNUSED_CLICK_EVENT);
		});
		await flushPendingPromiseCallbacks();

		expect(showAppToastMock).toHaveBeenCalledTimes(1);
		expect(showAppToastMock.mock.calls[0]?.[0]).toMatchObject({
			intent: "danger",
			message: expect.stringContaining("取消静音没有保存：runtime 没有认可这个页面的请求来源"),
		});
		expect(showAppToastMock.mock.calls[0]?.[0].message).toContain("Verified Web UI page-load nonce required.");
		expect(fetchRelationNeighborhoodSummaryMock).toHaveBeenCalledTimes(1);
		expect(latestController().relationIdsWithPresentationMuteToggleInFlight.size).toBe(0);
	});

	it("静音失败 toast 文案：账本不可用 / 找不到关系", () => {
		expect(
			describeRecordedRelationPresentationMutePreferenceWriteFailureForToast(
				{
					writeFailureKind: "inter_work_unit_relation_ledger_unavailable",
					writeFailureReasonMessage: "ledger closed",
				},
				true,
			),
		).toBe("静音没有保存：关系账本暂不可用（ledger closed）");
		expect(
			describeRecordedRelationPresentationMutePreferenceWriteFailureForToast(
				{
					writeFailureKind: "recorded_relation_not_found_in_inter_work_unit_relation_ledger",
					writeFailureReasonMessage: "no such relation",
				},
				true,
			),
		).toBe("静音没有保存：关系账本里找不到这条关系，请刷新关系面板（no such relation）");
	});

	it("有跨项目打开宿主时邻居打开入口就是宿主的 onOpenTaskInProject，没有宿主时为 null", async () => {
		await renderHarness({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
		});
		expect(latestController().openNeighborKanbanBoardCardInItsProject).toBeNull();

		const onOpenTaskInProject = vi.fn();
		await renderHarness(
			{
				workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				kanbanBoardCardTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
			},
			(children) => (
				<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider
					value={buildCrossProjectTaskOpenHostForTest(onOpenTaskInProject)}
				>
					{children}
				</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
			),
		);
		expect(latestController().openNeighborKanbanBoardCardInItsProject).toBe(onOpenTaskInProject);
	});
});
