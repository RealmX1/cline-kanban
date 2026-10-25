import { useMemo } from "react";

import {
	type PostDeployVerificationPanelTaskCardBoardSource,
	resolvePostDeployVerificationPanelTaskCardBoardSource,
	resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope,
} from "@/components/post-deploy-verification/post-deploy-verification-workspace-and-panel-task-card-board-source-for-board-or-single-project-scope";
import {
	type RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser,
	useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser,
} from "@/hooks/use-board-snapshot-read-from-runtime-for-post-deploy-verification-workspace-not-hydrated-in-browser";
import { type UsePostDeployVerificationResult, usePostDeployVerification } from "@/hooks/use-post-deploy-verification";
import type { SelectedBoardOrSingleProjectScope } from "@/hooks/use-selected-board-or-single-project-scope";
import { useWorkspacesHavingPostDeployVerificationDeploymentGroupsWhileBoardScopeAllProjectsSelected } from "@/hooks/use-workspaces-having-post-deploy-verification-deployment-groups-while-board-scope-all-projects-selected";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimeProjectSummary,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { BoardData } from "@/types";

export interface UsePostDeployVerificationForBoardOrSingleProjectScopeResult {
	// App 持有的唯一一份 PDV 读模型实例：顶栏按钮的待核对数与面板 controller 共用。
	postDeployVerification: UsePostDeployVerificationResult;
	postDeployVerificationWorkspaceId: string | null;
	postDeployVerificationPanelTaskCardBoardSource: PostDeployVerificationPanelTaskCardBoardSource;
	// 只在 board 来源是 runtime 快照时非 null（还没读到时也是 null）。
	runtimeBoardSnapshotOfPostDeployVerificationWorkspace: RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser | null;
	refetchRuntimeBoardSnapshotOfPostDeployVerificationWorkspace: () => void;
	// 看板「移入 Done」门禁预检的数据源（useBoardInteractions）：预检只对当前项目的看板有效，所以只在面板读的正是
	// 浏览器里当前项目的 board 时给，否则 null / undefined（不预检，全靠服务端门禁拒绝后的兜底）。
	postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck: RuntimePostDeployVerificationDeploymentGroup | null;
	refreshPostDeployVerificationReadModelAfterCurrentProjectDoneEntryGateRejection: (() => void) | undefined;
}

/**
 * Post-Deploy Verification 在两种范围下的读模型与面板数据源（docs/post-deploy-verification.md「面板在 All projects
 * 视图下」）。单项目范围与改动前完全一样：绑定当前项目、读浏览器里的 board。All projects 下面板不跟随当前项目，
 * 绑定有部署组的项目，那个项目的 board 不在浏览器里时改读 runtime 快照。
 *
 * 必须在 useBoardInteractions 之前调用（它读门禁预检的活跃组）。
 */
export function usePostDeployVerificationForBoardOrSingleProjectScope(input: {
	selectedBoardOrSingleProjectScope: SelectedBoardOrSingleProjectScope;
	currentProjectRuntimeWorkspaceId: string | null;
	projectIdOwningHydratedBoard: string | null;
	projects: readonly RuntimeProjectSummary[];
	currentProjectDisplayedBoard: BoardData;
	currentProjectTaskSessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectWorkspacePath: string | null;
	explicitEntryNavigationWorkspaceId?: string | null;
}): UsePostDeployVerificationForBoardOrSingleProjectScopeResult {
	const {
		selectedBoardOrSingleProjectScope,
		currentProjectRuntimeWorkspaceId,
		projectIdOwningHydratedBoard,
		projects,
	} = input;
	const workspacesHavingPostDeployVerificationDeploymentGroups =
		useWorkspacesHavingPostDeployVerificationDeploymentGroupsWhileBoardScopeAllProjectsSelected(
			selectedBoardOrSingleProjectScope === "board_scope_all_projects",
		);
	const availableRegisteredProjectIds = useMemo(
		() =>
			new Set(
				projects.filter((project) => project.availability.status !== "unavailable").map((project) => project.id),
			),
		[projects],
	);
	const postDeployVerificationWorkspaceId = resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
		selectedBoardOrSingleProjectScope,
		currentProjectRuntimeWorkspaceId,
		workspacesHavingPostDeployVerificationDeploymentGroups,
		availableRegisteredProjectIds,
		explicitEntryNavigationWorkspaceId: input.explicitEntryNavigationWorkspaceId,
	});
	const postDeployVerification = usePostDeployVerification(postDeployVerificationWorkspaceId);
	const postDeployVerificationPanelTaskCardBoardSource = resolvePostDeployVerificationPanelTaskCardBoardSource({
		explicitEntryNavigationWorkspaceId: input.explicitEntryNavigationWorkspaceId,
		selectedBoardOrSingleProjectScope,
		postDeployVerificationWorkspaceId,
		currentProjectRuntimeWorkspaceId,
		projectIdOwningHydratedBoard,
	});
	const workspaceIdOwningRuntimeBoardSnapshot =
		postDeployVerificationPanelTaskCardBoardSource.postDeployVerificationPanelTaskCardBoardSourceKind ===
		"runtime_board_snapshot_of_workspace_not_hydrated_in_browser"
			? postDeployVerificationPanelTaskCardBoardSource.workspaceIdOwningRuntimeBoardSnapshot
			: null;
	const taskCountsOfWorkspaceOwningRuntimeBoardSnapshot =
		workspaceIdOwningRuntimeBoardSnapshot === null
			? null
			: (projects.find((project) => project.id === workspaceIdOwningRuntimeBoardSnapshot)?.taskCounts ?? null);
	const { runtimeBoardSnapshot, refetchRuntimeBoardSnapshot } =
		useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser({
			workspaceIdToReadBoardSnapshotFrom: workspaceIdOwningRuntimeBoardSnapshot,
			runtimeBoardColumnMembershipChangeHintOfWorkspace:
				taskCountsOfWorkspaceOwningRuntimeBoardSnapshot === null
					? null
					: JSON.stringify(taskCountsOfWorkspaceOwningRuntimeBoardSnapshot),
			currentProjectBoardHydratedInBrowserForSeeding:
				currentProjectRuntimeWorkspaceId !== null &&
				projectIdOwningHydratedBoard === currentProjectRuntimeWorkspaceId
					? {
							workspaceIdOwningRuntimeBoardSnapshot: currentProjectRuntimeWorkspaceId,
							boardReadFromRuntime: input.currentProjectDisplayedBoard,
							taskSessionsReadFromRuntime: input.currentProjectTaskSessions,
							workspacePathReadFromRuntime: input.currentProjectWorkspacePath,
						}
					: null,
		});

	const isPanelReadingCurrentProjectBoardHydratedInBrowser =
		postDeployVerificationPanelTaskCardBoardSource.postDeployVerificationPanelTaskCardBoardSourceKind ===
		"current_project_board_hydrated_in_browser";
	// 读模型按 workspace 切换是在 effect 里重置的：切换那一帧 activeGroup 还是上一个 workspace 的，用组自带的
	// workspaceId 再挡一次，别把别的项目的组喂给当前项目的预检。
	const activeGroupOfCurrentProject =
		postDeployVerification.activeGroup?.workspaceId === currentProjectRuntimeWorkspaceId
			? postDeployVerification.activeGroup
			: null;
	return {
		postDeployVerification,
		postDeployVerificationWorkspaceId,
		postDeployVerificationPanelTaskCardBoardSource,
		runtimeBoardSnapshotOfPostDeployVerificationWorkspace: runtimeBoardSnapshot,
		refetchRuntimeBoardSnapshotOfPostDeployVerificationWorkspace: refetchRuntimeBoardSnapshot,
		postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck:
			isPanelReadingCurrentProjectBoardHydratedInBrowser ? activeGroupOfCurrentProject : null,
		refreshPostDeployVerificationReadModelAfterCurrentProjectDoneEntryGateRejection:
			isPanelReadingCurrentProjectBoardHydratedInBrowser ? postDeployVerification.refresh : undefined,
	};
}
