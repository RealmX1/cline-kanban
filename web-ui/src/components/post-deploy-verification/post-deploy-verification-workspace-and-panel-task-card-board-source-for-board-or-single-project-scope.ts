import type { SelectedBoardOrSingleProjectScope } from "@/hooks/use-selected-board-or-single-project-scope";
import type { RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary } from "@/runtime/types";

// Post-Deploy Verification 面板在两种范围下绑定哪个 workspace、条目卡体读哪份 board（docs/post-deploy-verification.md
// 「面板在 All projects 视图下」一节）。纯函数，App 经 use-post-deploy-verification-for-board-or-single-project-scope 调用。

/**
 * 面板（以及顶栏按钮的待核对数）绑定的 workspace：
 *   - 单项目范围：当前项目（与改动前一致；没有部署记录的项目不显示按钮）；
 *   - All projects：面板不跟随当前项目。当前项目自己有部署组时仍选它——看板「移入 Done」门禁预检只认当前项目的读模型；
 *     否则选最近部署过、已注册且可用的项目；列表还没加载过、或没有任何候选时退回当前项目。
 */
export function resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope(input: {
	selectedBoardOrSingleProjectScope: SelectedBoardOrSingleProjectScope;
	currentProjectRuntimeWorkspaceId: string | null;
	// null = 从未加载过（不是「没有任何部署组」，那是空数组）。已按最近部署时间新→旧排序（服务端保证）。
	workspacesHavingPostDeployVerificationDeploymentGroups:
		| readonly RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary[]
		| null;
	availableRegisteredProjectIds: ReadonlySet<string>;
}): string | null {
	const { currentProjectRuntimeWorkspaceId, workspacesHavingPostDeployVerificationDeploymentGroups } = input;
	if (
		input.selectedBoardOrSingleProjectScope === "single_project_scope" ||
		workspacesHavingPostDeployVerificationDeploymentGroups === null
	) {
		return currentProjectRuntimeWorkspaceId;
	}
	if (
		currentProjectRuntimeWorkspaceId !== null &&
		workspacesHavingPostDeployVerificationDeploymentGroups.some(
			(summary) => summary.workspaceId === currentProjectRuntimeWorkspaceId,
		)
	) {
		return currentProjectRuntimeWorkspaceId;
	}
	const mostRecentlyDeployedAvailableRegisteredWorkspace = workspacesHavingPostDeployVerificationDeploymentGroups.find(
		(summary) => input.availableRegisteredProjectIds.has(summary.workspaceId),
	);
	return mostRecentlyDeployedAvailableRegisteredWorkspace?.workspaceId ?? currentProjectRuntimeWorkspaceId;
}

/**
 * 面板条目卡体（以及 controller 判列、原因对话框取标题）读哪份 board：
 *   - current_project_board_hydrated_in_browser：浏览器里当前项目的 displayedBoard（推流 + overlay，动作与主看板同一组）；
 *   - runtime_board_snapshot_of_workspace_not_hydrated_in_browser：PDV workspace 的 board 不在浏览器里，向 runtime 读快照。
 * taskId 只在一个项目内唯一，所以「用浏览器里的 board」必须确认它装的就是 PDV workspace 的数据：跨项目打开任务时
 * currentProjectId 先变、board 晚一拍才换（use-cross-project-task-open-in-project.ts 的过渡窗口），只比 currentProjectId
 * 会把另一个项目的同号卡当成条目、甚至对它移列。
 */
export type PostDeployVerificationPanelTaskCardBoardSource =
	| { postDeployVerificationPanelTaskCardBoardSourceKind: "no_post_deploy_verification_workspace" }
	| {
			postDeployVerificationPanelTaskCardBoardSourceKind: "current_project_board_hydrated_in_browser";
			workspaceIdOwningCurrentProjectBoard: string;
	  }
	| {
			postDeployVerificationPanelTaskCardBoardSourceKind: "runtime_board_snapshot_of_workspace_not_hydrated_in_browser";
			workspaceIdOwningRuntimeBoardSnapshot: string;
	  };

export function resolvePostDeployVerificationPanelTaskCardBoardSource(input: {
	selectedBoardOrSingleProjectScope: SelectedBoardOrSingleProjectScope;
	postDeployVerificationWorkspaceId: string | null;
	currentProjectRuntimeWorkspaceId: string | null;
	projectIdOwningHydratedBoard: string | null;
}): PostDeployVerificationPanelTaskCardBoardSource {
	const { postDeployVerificationWorkspaceId } = input;
	if (postDeployVerificationWorkspaceId === null) {
		return { postDeployVerificationPanelTaskCardBoardSourceKind: "no_post_deploy_verification_workspace" };
	}
	// 单项目范围的 PDV workspace 恒为当前项目，沿用改动前的行为（始终读浏览器里的 board）。
	const isBrowserBoardHoldingPostDeployVerificationWorkspace =
		input.selectedBoardOrSingleProjectScope === "single_project_scope" ||
		(postDeployVerificationWorkspaceId === input.currentProjectRuntimeWorkspaceId &&
			postDeployVerificationWorkspaceId === input.projectIdOwningHydratedBoard);
	return isBrowserBoardHoldingPostDeployVerificationWorkspace
		? {
				postDeployVerificationPanelTaskCardBoardSourceKind: "current_project_board_hydrated_in_browser",
				workspaceIdOwningCurrentProjectBoard: postDeployVerificationWorkspaceId,
			}
		: {
				postDeployVerificationPanelTaskCardBoardSourceKind:
					"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
				workspaceIdOwningRuntimeBoardSnapshot: postDeployVerificationWorkspaceId,
			};
}
