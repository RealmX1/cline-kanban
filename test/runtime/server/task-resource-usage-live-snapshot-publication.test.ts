import { describe, expect, it, vi } from "vitest";

import type { RuntimeLiveTaskResourceUsageSnapshot } from "../../../src/core/api-contract";
import { createLiveTaskResourceUsageSnapshotPublisher } from "../../../src/server/task-resource-usage-live-snapshot-publication";

function snapshot(workspaceId: string, attributedTaskCardId: string): RuntimeLiveTaskResourceUsageSnapshot {
	return {
		workspaceId,
		attributedTaskCardId,
		sampledAtEpochMs: 1,
		attributedProcessCount: 1,
		residentSetSizeKibibytesSumUpperBound: 100,
		cpuPercentOfOneCoreOverLastSampleInterval: null,
		survivedSessionRootExitProcessCount: 0,
		survivedSessionRootExitResidentSetSizeKibibytesSum: 0,
		agentHarnessRootPhysicalFootprintBytes: null,
		processCountByProcessClassification: {},
		residentSetSizeKibibytesSumUpperBoundByProcessClassification: {},
		mcpServerInstances: [],
	};
}

describe("createLiveTaskResourceUsageSnapshotPublisher", () => {
	it("broadcasts each workspace's cards separately", () => {
		const broadcast = vi.fn();
		const publish = createLiveTaskResourceUsageSnapshotPublisher(broadcast);

		publish([snapshot("repo-a", "aa111"), snapshot("repo-b", "bb222"), snapshot("repo-a", "aa333")]);

		expect(broadcast).toHaveBeenCalledWith("repo-a", [snapshot("repo-a", "aa111"), snapshot("repo-a", "aa333")]);
		expect(broadcast).toHaveBeenCalledWith("repo-b", [snapshot("repo-b", "bb222")]);
	});

	it("clears a workspace once none of its cards has a live process any more, then stops re-sending the empty list", () => {
		const broadcast = vi.fn();
		const publish = createLiveTaskResourceUsageSnapshotPublisher(broadcast);

		publish([snapshot("repo-a", "aa111")]);
		broadcast.mockClear();
		publish([]);
		expect(broadcast).toHaveBeenCalledWith("repo-a", []);

		broadcast.mockClear();
		publish([]);
		expect(broadcast).not.toHaveBeenCalled();
	});
});
