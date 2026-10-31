import type { RuntimePostDeployVerificationDeploymentGroup } from "../core/api-contract";
import type { LocalDeploymentExecutionManifest } from "./local-deployment-execution-contract";

type AcceptedDeploymentGroupIdentity = Pick<
	RuntimePostDeployVerificationDeploymentGroup,
	"deploymentId" | "workspaceId" | "deployedSourceCommit" | "previousDeployedSourceCommit" | "foldedAtIso"
>;

/** marker 是 runtime-home 全局状态；跨 workspace 的顺序只能由接受关系证明，不能由墙钟猜测。 */
export function verifyLocalDeploymentRegistrationEffectFromPersistedEvidence(input: {
	manifest: LocalDeploymentExecutionManifest;
	deploymentGroups: readonly AcceptedDeploymentGroupIdentity[];
	marker: { deploymentId: string; deployedSourceCommit: string };
}): boolean {
	const registeredGroup = input.deploymentGroups.find(
		(group) =>
			group.deploymentId === input.manifest.executionId &&
			group.workspaceId === input.manifest.workspaceId &&
			group.deployedSourceCommit === input.manifest.candidateSourceCommit &&
			group.previousDeployedSourceCommit === input.manifest.previousDeployedSourceCommit,
	);
	if (!registeredGroup) return false;
	const markerGroup = input.deploymentGroups.find(
		(group) =>
			group.deploymentId === input.marker.deploymentId &&
			group.deployedSourceCommit === input.marker.deployedSourceCommit,
	);
	if (!markerGroup) return false;
	if (markerGroup.deploymentId === registeredGroup.deploymentId) return true;
	if (
		markerGroup.workspaceId === registeredGroup.workspaceId &&
		registeredGroup.foldedAtIso !== null &&
		markerGroup.foldedAtIso === null
	)
		return true;
	const visitedDeploymentIds = new Set<string>();
	let predecessorCommit = markerGroup.previousDeployedSourceCommit;
	while (predecessorCommit !== null) {
		const predecessors = input.deploymentGroups.filter((group) => group.deployedSourceCommit === predecessorCommit);
		// 同一 SHA 多次部署时，commit 不能替代执行身份；缺少唯一前驱便保留未知。
		if (predecessors.length !== 1) return false;
		const predecessor = predecessors[0];
		if (predecessor.deploymentId === registeredGroup.deploymentId) return true;
		if (visitedDeploymentIds.has(predecessor.deploymentId)) return false;
		visitedDeploymentIds.add(predecessor.deploymentId);
		predecessorCommit = predecessor.previousDeployedSourceCommit;
	}
	return false;
}
