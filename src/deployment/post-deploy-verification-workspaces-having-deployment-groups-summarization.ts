import type {
	RuntimePostDeployVerificationState,
	RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary,
} from "../core/api-contract";

// All projects 视图的 PDV 面板用：从全局 state 快照里列出有部署组（活跃或已折叠进历史都算——单项目视图里只要有组，
// 顶栏按钮就显示）的 workspace，按最近一次部署时间新→旧排序。纯函数，不读盘。
export function summarizeWorkspacesHavingPostDeployVerificationDeploymentGroupsFromStateSnapshot(
	state: RuntimePostDeployVerificationState,
): RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary[] {
	const latestDeploymentGroupDeployedAtIsoByWorkspaceId = new Map<string, string>();
	for (const deploymentGroup of state.deploymentGroups) {
		const latestDeployedAtIsoSoFar = latestDeploymentGroupDeployedAtIsoByWorkspaceId.get(deploymentGroup.workspaceId);
		if (
			latestDeployedAtIsoSoFar === undefined ||
			Date.parse(deploymentGroup.deployedAtIso) > Date.parse(latestDeployedAtIsoSoFar)
		) {
			latestDeploymentGroupDeployedAtIsoByWorkspaceId.set(
				deploymentGroup.workspaceId,
				deploymentGroup.deployedAtIso,
			);
		}
	}
	return [...latestDeploymentGroupDeployedAtIsoByWorkspaceId.entries()]
		.map(([workspaceId, latestDeploymentGroupDeployedAtIso]) => ({ workspaceId, latestDeploymentGroupDeployedAtIso }))
		.sort(
			(left, right) =>
				Date.parse(right.latestDeploymentGroupDeployedAtIso) - Date.parse(left.latestDeploymentGroupDeployedAtIso),
		);
}
