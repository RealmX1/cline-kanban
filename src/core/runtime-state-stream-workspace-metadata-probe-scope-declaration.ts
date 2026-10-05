import type { RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient } from "./api-contract";

// 状态流 WS URL 上声明初始 git 元数据探测范围的参数名（值是 JSON），浏览器与服务端共用。
export const RUNTIME_WORKSPACE_METADATA_PROBE_SCOPE_URL_SEARCH_PARAM = "workspaceMetadataProbeScope";

// 整个项目：单项目范围的声明，也是没声明（旧客户端）时服务端的默认。
export const ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE: RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient =
	{ workspaceMetadataProbeScopeKind: "all_tracked_task_worktrees_of_workspace" };

// 一个浏览器标签页决定探测范围所需的全部输入。
export interface WorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab {
	isBoardScopeAllProjectsSelected: boolean;
	// Focus View 里打开着（或跨项目打开在途）的任务；没有时 null。
	focusedTaskInProject: { workspaceId: string; taskId: string } | null;
}

/**
 * 这个标签页连到 `workspaceId` 时要声明的范围。单项目范围下看板与 stage 列表逐卡显示 git 状态，要整个项目；
 * All projects（Board Scope）下屏幕上只有焦点任务要逐卡 git 状态（跨项目面板的行另走按需轮询），
 * auto-review 要的 Review 列任务由服务端自己并上。
 */
export function resolveWorkspaceMetadataProbeScopeDeclaredForWorkspace(
	inputs: WorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab,
	workspaceId: string,
): RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient {
	if (!inputs.isBoardScopeAllProjectsSelected) {
		return ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE;
	}
	return {
		workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
		focusedTaskIds:
			inputs.focusedTaskInProject?.workspaceId === workspaceId ? [inputs.focusedTaskInProject.taskId] : [],
	};
}
