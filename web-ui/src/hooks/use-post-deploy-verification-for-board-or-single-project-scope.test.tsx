import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import type { UsePostDeployVerificationResult } from "@/hooks/use-post-deploy-verification";
import { usePostDeployVerificationForBoardOrSingleProjectScope } from "@/hooks/use-post-deploy-verification-for-board-or-single-project-scope";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimeProjectSummary,
	RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary,
} from "@/runtime/types";

// 只测本 hook 的组合逻辑：列表 query、读模型、快照读取都换成可控替身。
const workspacesHavingPostDeployVerificationDeploymentGroupsReturned = vi.hoisted(() => ({
	value: null as RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary[] | null,
	isBoardScopeAllProjectsSelectedSeen: [] as boolean[],
}));
vi.mock(
	"@/hooks/use-workspaces-having-post-deploy-verification-deployment-groups-while-board-scope-all-projects-selected",
	() => ({
		useWorkspacesHavingPostDeployVerificationDeploymentGroupsWhileBoardScopeAllProjectsSelected: (
			isBoardScopeAllProjectsSelected: boolean,
		) => {
			workspacesHavingPostDeployVerificationDeploymentGroupsReturned.isBoardScopeAllProjectsSelectedSeen.push(
				isBoardScopeAllProjectsSelected,
			);
			return workspacesHavingPostDeployVerificationDeploymentGroupsReturned.value;
		},
	}),
);

const postDeployVerificationReadModel = vi.hoisted(() => ({
	workspaceIdsPassed: [] as Array<string | null>,
	// 模拟「读模型按 workspace 切换在 effect 里重置」：返回的活跃组属于这个 workspace，而不一定是刚传入的那个。
	workspaceIdOwningReturnedActiveGroup: null as string | null,
	refresh: vi.fn(),
}));
vi.mock("@/hooks/use-post-deploy-verification", () => ({
	usePostDeployVerification: (workspaceId: string | null): UsePostDeployVerificationResult => {
		postDeployVerificationReadModel.workspaceIdsPassed.push(workspaceId);
		const workspaceIdOwningReturnedActiveGroup =
			postDeployVerificationReadModel.workspaceIdOwningReturnedActiveGroup ?? workspaceId;
		const activeGroup: RuntimePostDeployVerificationDeploymentGroup | null =
			workspaceIdOwningReturnedActiveGroup === null
				? null
				: {
						deploymentId: "00000000-0000-4000-8000-000000000001",
						workspaceId: workspaceIdOwningReturnedActiveGroup,
						deployedSourceCommit: "abcdef1",
						previousDeployedSourceCommit: null,
						deployedAtIso: "2026-10-12T00:00:00.000Z",
						foldedAtIso: null,
						tasks: [],
					};
		return {
			activeGroup,
			refresh: postDeployVerificationReadModel.refresh,
		} as unknown as UsePostDeployVerificationResult;
	},
}));

const runtimeBoardSnapshotReader = vi.hoisted(() => ({
	workspaceIdsRequested: [] as Array<string | null>,
	seedWorkspaceIdsGiven: [] as Array<string | null>,
}));
vi.mock(
	"@/hooks/use-board-snapshot-read-from-runtime-for-post-deploy-verification-workspace-not-hydrated-in-browser",
	() => ({
		useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser: (input: {
			workspaceIdToReadBoardSnapshotFrom: string | null;
			currentProjectBoardHydratedInBrowserForSeeding: { workspaceIdOwningRuntimeBoardSnapshot: string } | null;
		}) => {
			runtimeBoardSnapshotReader.workspaceIdsRequested.push(input.workspaceIdToReadBoardSnapshotFrom);
			runtimeBoardSnapshotReader.seedWorkspaceIdsGiven.push(
				input.currentProjectBoardHydratedInBrowserForSeeding?.workspaceIdOwningRuntimeBoardSnapshot ?? null,
			);
			return { runtimeBoardSnapshot: null, refetchRuntimeBoardSnapshot: vi.fn() };
		},
	}),
);

type HookInput = Parameters<typeof usePostDeployVerificationForBoardOrSingleProjectScope>[0];
type HookResult = ReturnType<typeof usePostDeployVerificationForBoardOrSingleProjectScope>;

let container: HTMLDivElement;
let root: Root;
let latestHookResult: HookResult | null = null;
let previousActEnvironment: boolean | undefined;

function HookHarness(props: HookInput): null {
	latestHookResult = usePostDeployVerificationForBoardOrSingleProjectScope(props);
	return null;
}

function renderHookWith(input: Partial<HookInput>): HookResult {
	act(() => {
		root.render(
			<HookHarness
				selectedBoardOrSingleProjectScope="board_scope_all_projects"
				currentProjectRuntimeWorkspaceId="project-without-deploys"
				projectIdOwningHydratedBoard="project-without-deploys"
				projects={REGISTERED_PROJECTS}
				currentProjectDisplayedBoard={createInitialBoardData()}
				currentProjectTaskSessions={{}}
				currentProjectWorkspacePath="/repo/project-without-deploys"
				{...input}
			/>,
		);
	});
	if (!latestHookResult) {
		throw new Error("hook 尚未渲染");
	}
	return latestHookResult;
}

function buildProjectSummary(id: string): RuntimeProjectSummary {
	return {
		id,
		path: `/repo/${id}`,
		name: id,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 1, trash: 0 },
		availability: { status: "available" },
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: [],
	} as RuntimeProjectSummary;
}

const REGISTERED_PROJECTS = [buildProjectSummary("cline-kanban"), buildProjectSummary("project-without-deploys")];

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	latestHookResult = null;
	workspacesHavingPostDeployVerificationDeploymentGroupsReturned.value = [
		{ workspaceId: "cline-kanban", latestDeploymentGroupDeployedAtIso: "2026-10-12T00:00:00.000Z" },
	];
	workspacesHavingPostDeployVerificationDeploymentGroupsReturned.isBoardScopeAllProjectsSelectedSeen.length = 0;
	postDeployVerificationReadModel.workspaceIdsPassed.length = 0;
	postDeployVerificationReadModel.workspaceIdOwningReturnedActiveGroup = null;
	runtimeBoardSnapshotReader.workspaceIdsRequested.length = 0;
	runtimeBoardSnapshotReader.seedWorkspaceIdsGiven.length = 0;
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("usePostDeployVerificationForBoardOrSingleProjectScope", () => {
	it("单项目范围：与改动前一致——绑定当前项目、读浏览器里的 board、给门禁预检；不拉跨项目列表", () => {
		const result = renderHookWith({
			selectedBoardOrSingleProjectScope: "single_project_scope",
			currentProjectRuntimeWorkspaceId: "cline-kanban",
			projectIdOwningHydratedBoard: "cline-kanban",
		});
		expect(result.postDeployVerificationWorkspaceId).toBe("cline-kanban");
		expect(postDeployVerificationReadModel.workspaceIdsPassed.at(-1)).toBe("cline-kanban");
		expect(
			result.postDeployVerificationPanelTaskCardBoardSource.postDeployVerificationPanelTaskCardBoardSourceKind,
		).toBe("current_project_board_hydrated_in_browser");
		expect(runtimeBoardSnapshotReader.workspaceIdsRequested.at(-1)).toBeNull();
		expect(
			result.postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck?.workspaceId,
		).toBe("cline-kanban");
		expect(result.refreshPostDeployVerificationReadModelAfterCurrentProjectDoneEntryGateRejection).toBe(
			postDeployVerificationReadModel.refresh,
		);
		expect(
			workspacesHavingPostDeployVerificationDeploymentGroupsReturned.isBoardScopeAllProjectsSelectedSeen.at(-1),
		).toBe(false);
	});

	it("单项目范围、当前项目没有部署记录：仍绑定当前项目（顶栏按钮照旧不显示）", () => {
		const result = renderHookWith({ selectedBoardOrSingleProjectScope: "single_project_scope" });
		expect(result.postDeployVerificationWorkspaceId).toBe("project-without-deploys");
	});

	it("All projects、当前项目没有部署记录：绑定 cline-kanban、读它的 runtime 快照，当前项目不做门禁预检", () => {
		const result = renderHookWith({});
		expect(result.postDeployVerificationWorkspaceId).toBe("cline-kanban");
		expect(postDeployVerificationReadModel.workspaceIdsPassed.at(-1)).toBe("cline-kanban");
		expect(result.postDeployVerificationPanelTaskCardBoardSource).toEqual({
			postDeployVerificationPanelTaskCardBoardSourceKind:
				"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
			workspaceIdOwningRuntimeBoardSnapshot: "cline-kanban",
		});
		expect(runtimeBoardSnapshotReader.workspaceIdsRequested.at(-1)).toBe("cline-kanban");
		expect(runtimeBoardSnapshotReader.seedWorkspaceIdsGiven.at(-1)).toBe("project-without-deploys");
		expect(result.postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck).toBeNull();
		expect(result.refreshPostDeployVerificationReadModelAfterCurrentProjectDoneEntryGateRejection).toBeUndefined();
	});

	it("All projects、cline-kanban 是当前项目且 board 已水合：读浏览器里的 board，给门禁预检", () => {
		const result = renderHookWith({
			currentProjectRuntimeWorkspaceId: "cline-kanban",
			projectIdOwningHydratedBoard: "cline-kanban",
		});
		expect(
			result.postDeployVerificationPanelTaskCardBoardSource.postDeployVerificationPanelTaskCardBoardSourceKind,
		).toBe("current_project_board_hydrated_in_browser");
		expect(runtimeBoardSnapshotReader.workspaceIdsRequested.at(-1)).toBeNull();
		expect(
			result.postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck?.workspaceId,
		).toBe("cline-kanban");
	});

	it("All projects、跨项目打开的过渡窗口（currentProjectId 已是 cline-kanban，board 还是上一个项目的）：读快照、不预检", () => {
		const result = renderHookWith({
			currentProjectRuntimeWorkspaceId: "cline-kanban",
			projectIdOwningHydratedBoard: "project-without-deploys",
		});
		expect(result.postDeployVerificationWorkspaceId).toBe("cline-kanban");
		expect(runtimeBoardSnapshotReader.workspaceIdsRequested.at(-1)).toBe("cline-kanban");
		// 过渡窗口里浏览器 board 不属于当前项目，不能拿来当种子。
		expect(runtimeBoardSnapshotReader.seedWorkspaceIdsGiven.at(-1)).toBeNull();
		expect(result.postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck).toBeNull();
	});

	it("读模型还停在上一个 workspace 的那一帧：不把别的项目的活跃组喂给当前项目的预检", () => {
		postDeployVerificationReadModel.workspaceIdOwningReturnedActiveGroup = "project-without-deploys";
		const result = renderHookWith({
			selectedBoardOrSingleProjectScope: "single_project_scope",
			currentProjectRuntimeWorkspaceId: "cline-kanban",
			projectIdOwningHydratedBoard: "cline-kanban",
		});
		expect(result.postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck).toBeNull();
	});

	it("All projects、列表还没加载过：先绑定当前项目", () => {
		workspacesHavingPostDeployVerificationDeploymentGroupsReturned.value = null;
		const result = renderHookWith({});
		expect(result.postDeployVerificationWorkspaceId).toBe("project-without-deploys");
		expect(
			workspacesHavingPostDeployVerificationDeploymentGroupsReturned.isBoardScopeAllProjectsSelectedSeen.at(-1),
		).toBe(true);
	});
});
