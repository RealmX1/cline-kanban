import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeLiveTaskResourceUsageSnapshot } from "@/runtime/types";
import {
	replaceTaskResourceUsageSnapshots,
	resetTaskResourceUsageSnapshotStore,
	useTaskResourceUsageSnapshotValue,
} from "@/stores/task-resource-usage-snapshot-store";

function snapshot(
	attributedTaskCardId: string | null,
	overrides: Partial<RuntimeLiveTaskResourceUsageSnapshot> = {},
): RuntimeLiveTaskResourceUsageSnapshot {
	return {
		workspaceId: "repo",
		attributedTaskCardId,
		sampledAtEpochMs: 1,
		attributedProcessCount: 3,
		residentSetSizeKibibytesSumUpperBound: 100_000,
		cpuPercentOfOneCoreOverLastSampleInterval: 5,
		survivedSessionRootExitProcessCount: 0,
		survivedSessionRootExitResidentSetSizeKibibytesSum: 0,
		agentHarnessRootPhysicalFootprintBytes: null,
		processCountByProcessClassification: {},
		residentSetSizeKibibytesSumUpperBoundByProcessClassification: {},
		mcpServerInstances: [],
		...overrides,
	};
}

function mountRenderCountingSubscriber(taskCardId: string): { renderCount: () => number; unmount: () => void } {
	let renders = 0;
	function Subscriber(): null {
		useTaskResourceUsageSnapshotValue(taskCardId);
		renders += 1;
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	act(() => root.render(createElement(Subscriber)));
	return { renderCount: () => renders, unmount: () => act(() => root.unmount()) };
}

let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	resetTaskResourceUsageSnapshotStore();
});

afterEach(() => {
	resetTaskResourceUsageSnapshotStore();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("task resource usage snapshot store", () => {
	it("re-renders a card only when its visible numbers change, not on every tick's new timestamp", () => {
		const subscriber = mountRenderCountingSubscriber("aa111");
		const rendersAfterMount = subscriber.renderCount();

		act(() => replaceTaskResourceUsageSnapshots([snapshot("aa111")]));
		act(() => replaceTaskResourceUsageSnapshots([snapshot("aa111", { sampledAtEpochMs: 2 })]));
		expect(subscriber.renderCount()).toBe(rendersAfterMount + 1);

		act(() =>
			replaceTaskResourceUsageSnapshots([snapshot("aa111", { residentSetSizeKibibytesSumUpperBound: 200_000 })]),
		);
		expect(subscriber.renderCount()).toBe(rendersAfterMount + 2);
		subscriber.unmount();
	});

	it("does not wake up other cards when one card's numbers change", () => {
		const other = mountRenderCountingSubscriber("bb222");
		const rendersAfterMount = other.renderCount();

		act(() => replaceTaskResourceUsageSnapshots([snapshot("aa111")]));

		expect(other.renderCount()).toBe(rendersAfterMount);
		other.unmount();
	});

	it("ignores workspace-level snapshots that belong to no card", () => {
		function Probe(): null {
			expect(useTaskResourceUsageSnapshotValue("")).toBeNull();
			return null;
		}
		act(() => replaceTaskResourceUsageSnapshots([snapshot(null)]));
		const host = document.createElement("div");
		const root = createRoot(host);
		act(() => root.render(createElement(Probe)));
		act(() => root.unmount());
	});
});
