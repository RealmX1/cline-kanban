// 采样器每个 tick 产出的「全部卡片实时资源快照」→ 按 workspace 分组推流。
// 某 workspace 上一轮有数据、这一轮一张卡都没有了（会话全停），也要推一次空列表，否则前端会一直
// 显示最后一次的数字。

import type { RuntimeLiveTaskResourceUsageSnapshot } from "../core/api-contract";

export function createLiveTaskResourceUsageSnapshotPublisher(
	broadcastTaskResourceUsageSnapshotsUpdated: (
		workspaceId: string,
		snapshots: RuntimeLiveTaskResourceUsageSnapshot[],
	) => void,
): (snapshots: readonly RuntimeLiveTaskResourceUsageSnapshot[]) => void {
	let workspaceIdsWithPublishedSnapshots = new Set<string>();
	return (snapshots) => {
		const snapshotsByWorkspaceId = new Map<string, RuntimeLiveTaskResourceUsageSnapshot[]>();
		for (const snapshot of snapshots) {
			const workspaceSnapshots = snapshotsByWorkspaceId.get(snapshot.workspaceId);
			if (workspaceSnapshots) {
				workspaceSnapshots.push(snapshot);
			} else {
				snapshotsByWorkspaceId.set(snapshot.workspaceId, [snapshot]);
			}
		}
		for (const workspaceId of workspaceIdsWithPublishedSnapshots) {
			if (!snapshotsByWorkspaceId.has(workspaceId)) {
				snapshotsByWorkspaceId.set(workspaceId, []);
			}
		}
		const nextWorkspaceIdsWithPublishedSnapshots = new Set<string>();
		for (const [workspaceId, workspaceSnapshots] of snapshotsByWorkspaceId) {
			broadcastTaskResourceUsageSnapshotsUpdated(workspaceId, workspaceSnapshots);
			if (workspaceSnapshots.length > 0) {
				nextWorkspaceIdsWithPublishedSnapshots.add(workspaceId);
			}
		}
		workspaceIdsWithPublishedSnapshots = nextWorkspaceIdsWithPublishedSnapshots;
	};
}
