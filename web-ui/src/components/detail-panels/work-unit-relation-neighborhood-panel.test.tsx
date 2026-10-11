import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	CrossProjectRecentlyActiveTaskSwitcherHostContextProvider,
	type CrossProjectRecentlyActiveTaskSwitcherHostContextValue,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { WorkUnitRelationNeighborhoodPanel } from "@/components/detail-panels/work-unit-relation-neighborhood-panel";
import {
	buildEmptyRelationNeighborhoodSummaryResponseForTest,
	buildStandardRelationNeighborhoodSummaryResponseForTest,
	buildTrpcClientErrorWithCodeForTest,
	CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
} from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";
import type { RuntimeProjectSummary } from "@/runtime/types";

const { fetchRelationNeighborhoodSummaryMock, setRelationPresentationMutePreferenceMock, showAppToastMock } =
	vi.hoisted(() => ({
		fetchRelationNeighborhoodSummaryMock: vi.fn(),
		setRelationPresentationMutePreferenceMock: vi.fn(),
		showAppToastMock: vi.fn(),
	}));

// 只替换两个传输函数，错误分类沿用真实实现。
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

function buildKanbanProjectSummaryForTest(workspaceId: string, projectName: string): RuntimeProjectSummary {
	return {
		id: workspaceId,
		path: `/repos/${projectName}`,
		name: projectName,
		availability: { status: "available" },
	} as RuntimeProjectSummary;
}

// dd2db 1b Relations 面板：分区渲染、主体视角成句、墓碑 / trash 标记、跨项目打开、读失败如实显示、空邻域、静音切换。
describe("WorkUnitRelationNeighborhoodPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let onOpenTaskInProject: Mock<(workspaceId: string, taskId: string) => void>;

	async function flushPendingPromiseCallbacks(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	async function renderPanel(): Promise<void> {
		const crossProjectTaskOpenHost: CrossProjectRecentlyActiveTaskSwitcherHostContextValue = {
			projects: [
				buildKanbanProjectSummaryForTest(CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST, "current-project"),
				buildKanbanProjectSummaryForTest(OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST, "other-project"),
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
		await act(async () => {
			root.render(
				<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider value={crossProjectTaskOpenHost}>
					<WorkUnitRelationNeighborhoodPanel
						workspaceId={CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST}
						kanbanBoardCardTaskId={SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST}
					/>
				</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>,
			);
		});
		await flushPendingPromiseCallbacks();
	}

	function findPanelHeaderToggleButton(): HTMLButtonElement {
		const headerToggleButton = container.querySelector<HTMLButtonElement>('section[aria-label="Relations"] button');
		expect(headerToggleButton).not.toBeNull();
		return headerToggleButton!;
	}

	async function clickElement(element: Element): Promise<void> {
		await act(async () => {
			element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await flushPendingPromiseCallbacks();
	}

	async function expandPanel(): Promise<void> {
		await clickElement(findPanelHeaderToggleButton());
	}

	function findRelationRow(relationId: string): HTMLElement {
		const relationRow = container.querySelector<HTMLElement>(`[data-relation-id="${relationId}"]`);
		expect(relationRow).not.toBeNull();
		return relationRow!;
	}

	function findButtonByAccessibleLabel(scope: ParentNode, accessibleLabel: string): HTMLButtonElement {
		const button = scope.querySelector<HTMLButtonElement>(`button[aria-label="${accessibleLabel}"]`);
		expect(button).not.toBeNull();
		return button!;
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onOpenTaskInProject = vi.fn();
		fetchRelationNeighborhoodSummaryMock.mockReset();
		setRelationPresentationMutePreferenceMock.mockReset();
		showAppToastMock.mockReset();
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () =>
			buildStandardRelationNeighborhoodSummaryResponseForTest(),
		);
		setRelationPresentationMutePreferenceMock.mockImplementation(
			async (input: { relationId: string; recordedRelationMutedInPresentation: boolean }) => ({
				relationId: input.relationId,
				recordedRelationMutedInPresentation: input.recordedRelationMutedInPresentation,
				relationPresentationPreferenceEventRecorded: true,
			}),
		);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("默认收起，头部给出已列出关系数与静音数；展开后按「来源」「需求修订」「折叠（仅计数）」分区", async () => {
		await renderPanel();
		expect(findPanelHeaderToggleButton().getAttribute("aria-expanded")).toBe("false");
		// 可见 3 条 + 折叠 2 条；静音 1 条。
		expect(findPanelHeaderToggleButton().textContent).toContain("5 · 已静音 1");

		await expandPanel();
		const sectionTitles = [...container.querySelectorAll('section[aria-label="Relations"] section')].map((section) =>
			section.getAttribute("aria-label"),
		);
		expect(sectionTitles).toEqual(["来源", "需求修订", "折叠（仅计数）", "已静音"]);
		const collapsedCountSection = container.querySelector('section[aria-label="折叠（仅计数）"]');
		expect(collapsedCountSection?.textContent).toContain(
			"This task had its board lifecycle transitioned by：1 个工作单元",
		);
		expect(collapsedCountSection?.textContent).toContain(
			"This task dispatched or controlled the agent session of：1 个工作单元",
		);
		expect(container.textContent).toContain("另有 1 条关系的种类本版界面还不认识，未列出。");
	});

	it("以主体视角成句：主体是 S 用正向读法、是 A 用反向读法", async () => {
		await renderPanel();
		await expandPanel();
		const subjectAsRelationStatementSubjectRow = findRelationRow("relation-subject-created-by-creator");
		expect(subjectAsRelationStatementSubjectRow.textContent).toContain("This task was created by");
		expect(subjectAsRelationStatementSubjectRow.textContent).toContain("Creator card in other project");
		expect(subjectAsRelationStatementSubjectRow.textContent).toContain("other-project");
		expect(subjectAsRelationStatementSubjectRow.textContent).toContain("创建时主来源");

		const subjectAsRelationStatementAnchorRow = findRelationRow("relation-subject-created-child");
		expect(subjectAsRelationStatementAnchorRow.textContent).toContain("This task created");
		expect(subjectAsRelationStatementAnchorRow.textContent).not.toContain("was created by");
		expect(subjectAsRelationStatementAnchorRow.textContent).toContain("Child card in Done");
		expect(subjectAsRelationStatementAnchorRow.textContent).toContain("current-project（本项目）");
		expect(subjectAsRelationStatementAnchorRow.textContent).toContain("在 Done（trash）");

		const amendmentRow = findRelationRow("relation-subject-requirements-amended-by-tombstone");
		expect(amendmentRow.textContent).toContain("This task had its requirements amended by");
		expect(amendmentRow.textContent).toContain("2 次 · 字段：prompt, title");
	});

	it("跨项目邻居可点开（走宿主的 onOpenTaskInProject）；墓碑邻居只展示、不可点", async () => {
		await renderPanel();
		await expandPanel();
		await clickElement(
			findButtonByAccessibleLabel(
				findRelationRow("relation-subject-created-by-creator"),
				"打开 task def34 [workspace-other-project]",
			),
		);
		expect(onOpenTaskInProject).toHaveBeenCalledWith(OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST, "def34");

		const tombstoneRow = findRelationRow("relation-subject-requirements-amended-by-tombstone");
		expect(tombstoneRow.textContent).toContain("墓碑 · 已永久删除");
		expect(tombstoneRow.querySelector('button[aria-label^="打开"]')).toBeNull();
	});

	it("SERVICE_UNAVAILABLE 如实显示「关系暂不可用」与原因，绝不显示成「没有关系」", async () => {
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () => {
			throw buildTrpcClientErrorWithCodeForTest("SERVICE_UNAVAILABLE", "Relation ledger database is not open.");
		});
		await renderPanel();
		expect(findPanelHeaderToggleButton().textContent).toContain("暂不可用");
		await expandPanel();
		expect(container.textContent).toContain("关系暂不可用");
		expect(container.textContent).toContain("原因：Relation ledger database is not open.");
		expect(container.textContent).not.toContain("还没有记录到与其他工作单元的关系");
	});

	it("空邻域显示「还没有记录到与其他工作单元的关系」", async () => {
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () =>
			buildEmptyRelationNeighborhoodSummaryResponseForTest(),
		);
		await renderPanel();
		await expandPanel();
		expect(container.textContent).toContain("还没有记录到与其他工作单元的关系");
		expect(container.querySelector('section[aria-label="来源"]')).toBeNull();
	});

	it("已静音的关系收在「已静音」组里、置灰并标「已静音」，点「取消静音」才调用 mutation", async () => {
		await renderPanel();
		await expandPanel();
		expect(container.querySelector('[data-relation-id="relation-subject-forked-creator-muted"]')).toBeNull();
		expect(setRelationPresentationMutePreferenceMock).not.toHaveBeenCalled();

		await clickElement(findButtonByAccessibleLabel(container, "已静音的关系：1 条"));
		const mutedRow = findRelationRow("relation-subject-forked-creator-muted");
		expect(mutedRow.className).toContain("opacity-60");
		expect(mutedRow.textContent).toContain("已静音");
		expect(mutedRow.textContent).toContain("This task forked the conversation session of");

		await clickElement(findButtonByAccessibleLabel(mutedRow, "取消静音这条关系"));
		expect(setRelationPresentationMutePreferenceMock).toHaveBeenCalledWith({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			relationId: "relation-subject-forked-creator-muted",
			recordedRelationMutedInPresentation: false,
		});
	});

	it("点可见关系的「静音」按钮：调用 mutation 后重拉邻域", async () => {
		await renderPanel();
		await expandPanel();
		const fetchCallCountBeforeMute = fetchRelationNeighborhoodSummaryMock.mock.calls.length;
		await clickElement(
			findButtonByAccessibleLabel(findRelationRow("relation-subject-created-by-creator"), "静音这条关系"),
		);
		expect(setRelationPresentationMutePreferenceMock).toHaveBeenCalledWith({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			relationId: "relation-subject-created-by-creator",
			recordedRelationMutedInPresentation: true,
		});
		expect(fetchRelationNeighborhoodSummaryMock.mock.calls.length).toBe(fetchCallCountBeforeMute + 1);
	});

	it("静音失败（SERVICE_UNAVAILABLE）用 toast 如实提示", async () => {
		setRelationPresentationMutePreferenceMock.mockImplementation(async () => {
			throw buildTrpcClientErrorWithCodeForTest("SERVICE_UNAVAILABLE", "Relation ledger database is not open.");
		});
		await renderPanel();
		await expandPanel();
		await clickElement(
			findButtonByAccessibleLabel(findRelationRow("relation-subject-created-by-creator"), "静音这条关系"),
		);
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: "danger",
				message: "静音没有保存：关系账本暂不可用（Relation ledger database is not open.）",
			}),
		);
	});
});
