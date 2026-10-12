import { describe, expect, it } from "vitest";

import type { RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary } from "@/runtime/types";
import {
	resolvePostDeployVerificationPanelTaskCardBoardSource,
	resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope,
} from "./post-deploy-verification-workspace-and-panel-task-card-board-source-for-board-or-single-project-scope";

// 服务端已按最近部署时间新→旧排序。
const CLINE_KANBAN_THEN_OTHER_DEPLOYED_PROJECT: RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary[] =
	[
		{ workspaceId: "cline-kanban", latestDeploymentGroupDeployedAtIso: "2026-10-12T00:00:00.000Z" },
		{ workspaceId: "other-deployed-project", latestDeploymentGroupDeployedAtIso: "2026-10-01T00:00:00.000Z" },
	];
const ALL_REGISTERED_PROJECTS_AVAILABLE = new Set([
	"cline-kanban",
	"other-deployed-project",
	"project-without-deploys",
]);

describe("resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope", () => {
	it("单项目范围：恒为当前项目（没有部署记录也一样，与改动前一致）", () => {
		expect(
			resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
				selectedBoardOrSingleProjectScope: "single_project_scope",
				currentProjectRuntimeWorkspaceId: "project-without-deploys",
				workspacesHavingPostDeployVerificationDeploymentGroups: CLINE_KANBAN_THEN_OTHER_DEPLOYED_PROJECT,
				availableRegisteredProjectIds: ALL_REGISTERED_PROJECTS_AVAILABLE,
			}),
		).toBe("project-without-deploys");
	});

	it("All projects、列表还没加载过：先用当前项目", () => {
		expect(
			resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				currentProjectRuntimeWorkspaceId: "project-without-deploys",
				workspacesHavingPostDeployVerificationDeploymentGroups: null,
				availableRegisteredProjectIds: ALL_REGISTERED_PROJECTS_AVAILABLE,
			}),
		).toBe("project-without-deploys");
	});

	it("All projects、当前项目自己有部署组：保持当前项目（即便别的项目部署得更近）", () => {
		expect(
			resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				currentProjectRuntimeWorkspaceId: "other-deployed-project",
				workspacesHavingPostDeployVerificationDeploymentGroups: CLINE_KANBAN_THEN_OTHER_DEPLOYED_PROJECT,
				availableRegisteredProjectIds: ALL_REGISTERED_PROJECTS_AVAILABLE,
			}),
		).toBe("other-deployed-project");
	});

	it("All projects、当前项目没有部署组：选最近部署过的项目", () => {
		expect(
			resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				currentProjectRuntimeWorkspaceId: "project-without-deploys",
				workspacesHavingPostDeployVerificationDeploymentGroups: CLINE_KANBAN_THEN_OTHER_DEPLOYED_PROJECT,
				availableRegisteredProjectIds: ALL_REGISTERED_PROJECTS_AVAILABLE,
			}),
		).toBe("cline-kanban");
	});

	it("All projects、当前项目还没有（尚未选中任何项目）：同样选最近部署过的项目", () => {
		expect(
			resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				currentProjectRuntimeWorkspaceId: null,
				workspacesHavingPostDeployVerificationDeploymentGroups: CLINE_KANBAN_THEN_OTHER_DEPLOYED_PROJECT,
				availableRegisteredProjectIds: ALL_REGISTERED_PROJECTS_AVAILABLE,
			}),
		).toBe("cline-kanban");
	});

	it("All projects：跳过不可用 / 未注册的项目", () => {
		expect(
			resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				currentProjectRuntimeWorkspaceId: "project-without-deploys",
				workspacesHavingPostDeployVerificationDeploymentGroups: CLINE_KANBAN_THEN_OTHER_DEPLOYED_PROJECT,
				availableRegisteredProjectIds: new Set(["other-deployed-project", "project-without-deploys"]),
			}),
		).toBe("other-deployed-project");
	});

	it("All projects、没有任何部署组 / 没有可用候选：退回当前项目", () => {
		for (const workspacesHavingPostDeployVerificationDeploymentGroups of [
			[],
			CLINE_KANBAN_THEN_OTHER_DEPLOYED_PROJECT,
		]) {
			expect(
				resolvePostDeployVerificationWorkspaceIdShownForBoardOrSingleProjectScope({
					selectedBoardOrSingleProjectScope: "board_scope_all_projects",
					currentProjectRuntimeWorkspaceId: "project-without-deploys",
					workspacesHavingPostDeployVerificationDeploymentGroups,
					availableRegisteredProjectIds: new Set(["project-without-deploys"]),
				}),
			).toBe("project-without-deploys");
		}
	});
});

describe("resolvePostDeployVerificationPanelTaskCardBoardSource", () => {
	it("没有 PDV workspace：no_post_deploy_verification_workspace", () => {
		expect(
			resolvePostDeployVerificationPanelTaskCardBoardSource({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				postDeployVerificationWorkspaceId: null,
				currentProjectRuntimeWorkspaceId: null,
				projectIdOwningHydratedBoard: null,
			}),
		).toEqual({ postDeployVerificationPanelTaskCardBoardSourceKind: "no_post_deploy_verification_workspace" });
	});

	it("单项目范围：恒读浏览器里的 board（含过渡窗口，与改动前一致）", () => {
		expect(
			resolvePostDeployVerificationPanelTaskCardBoardSource({
				selectedBoardOrSingleProjectScope: "single_project_scope",
				postDeployVerificationWorkspaceId: "cline-kanban",
				currentProjectRuntimeWorkspaceId: "cline-kanban",
				projectIdOwningHydratedBoard: "project-without-deploys",
			}),
		).toEqual({
			postDeployVerificationPanelTaskCardBoardSourceKind: "current_project_board_hydrated_in_browser",
			workspaceIdOwningCurrentProjectBoard: "cline-kanban",
		});
	});

	it("All projects、PDV workspace 就是当前项目且 board 已水合：读浏览器里的 board", () => {
		expect(
			resolvePostDeployVerificationPanelTaskCardBoardSource({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				postDeployVerificationWorkspaceId: "cline-kanban",
				currentProjectRuntimeWorkspaceId: "cline-kanban",
				projectIdOwningHydratedBoard: "cline-kanban",
			}),
		).toEqual({
			postDeployVerificationPanelTaskCardBoardSourceKind: "current_project_board_hydrated_in_browser",
			workspaceIdOwningCurrentProjectBoard: "cline-kanban",
		});
	});

	it("All projects、PDV workspace 不是当前项目：读 runtime 快照", () => {
		expect(
			resolvePostDeployVerificationPanelTaskCardBoardSource({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				postDeployVerificationWorkspaceId: "cline-kanban",
				currentProjectRuntimeWorkspaceId: "project-without-deploys",
				projectIdOwningHydratedBoard: "project-without-deploys",
			}),
		).toEqual({
			postDeployVerificationPanelTaskCardBoardSourceKind:
				"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
			workspaceIdOwningRuntimeBoardSnapshot: "cline-kanban",
		});
	});

	it("All projects、过渡窗口（currentProjectId 已是 PDV workspace，board 还是上一个项目的）：读 runtime 快照", () => {
		expect(
			resolvePostDeployVerificationPanelTaskCardBoardSource({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				postDeployVerificationWorkspaceId: "cline-kanban",
				currentProjectRuntimeWorkspaceId: "cline-kanban",
				projectIdOwningHydratedBoard: "project-without-deploys",
			}),
		).toEqual({
			postDeployVerificationPanelTaskCardBoardSourceKind:
				"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
			workspaceIdOwningRuntimeBoardSnapshot: "cline-kanban",
		});
	});

	it("All projects、反向过渡窗口（board 还是 PDV workspace 的，currentProjectId 已切走）：读 runtime 快照", () => {
		expect(
			resolvePostDeployVerificationPanelTaskCardBoardSource({
				selectedBoardOrSingleProjectScope: "board_scope_all_projects",
				postDeployVerificationWorkspaceId: "cline-kanban",
				currentProjectRuntimeWorkspaceId: "project-without-deploys",
				projectIdOwningHydratedBoard: "cline-kanban",
			}),
		).toEqual({
			postDeployVerificationPanelTaskCardBoardSourceKind:
				"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
			workspaceIdOwningRuntimeBoardSnapshot: "cline-kanban",
		});
	});
});
