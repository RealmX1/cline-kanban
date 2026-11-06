import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskResourceUsageDetailPanel } from "@/components/detail-panels/task-resource-usage-detail-panel";
import { TaskSessionInformationActions } from "@/components/detail-panels/task-session-information-actions";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	replaceTaskResourceUsageSnapshots,
	resetTaskResourceUsageSnapshotStore,
} from "@/stores/task-resource-usage-snapshot-store";

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	resetTaskResourceUsageSnapshotStore();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	resetTaskResourceUsageSnapshotStore();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("TaskResourceUsageDetailPanel", () => {
	it("没有终端工具的会话可经窄屏更多菜单打开任务资源明细", async () => {
		replaceTaskResourceUsageSnapshots([
			{
				workspaceId: "repo",
				attributedTaskCardId: "ab12c",
				sampledAtEpochMs: 1,
				attributedProcessCount: 1,
				residentSetSizeKibibytesSumUpperBound: 300_000,
				cpuPercentOfOneCoreOverLastSampleInterval: 12,
				survivedSessionRootExitProcessCount: 0,
				survivedSessionRootExitResidentSetSizeKibibytesSum: 0,
				agentHarnessRootPhysicalFootprintBytes: null,
				processCountByProcessClassification: { agent_harness_root_process: 1 },
				residentSetSizeKibibytesSumUpperBoundByProcessClassification: { agent_harness_root_process: 300_000 },
				mcpServerInstances: [],
			},
		]);
		await act(async () =>
			root.render(
				<TooltipProvider>
					<TaskSessionInformationActions
						workspaceId="repo"
						taskId="ab12c"
						taskConversationSessionId="ab12c-side-session"
						taskCreatedAtEpochMs={1}
						summary={null}
						pendingUserDecisionIdentityForRefresh={null}
					/>
				</TooltipProvider>,
			),
		);
		const moreInformationTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="会话更多信息"]')!;
		await act(async () => moreInformationTrigger.click());
		const moreInformation = document.querySelector('[role="dialog"][aria-label="会话更多信息"]');
		expect(moreInformation).not.toBeNull();
		const resourceDetailsTrigger = moreInformation!.querySelector<HTMLButtonElement>(
			'button[aria-label="展开资源占用明细"]',
		)!;
		await act(async () => resourceDetailsTrigger.click());
		const resourceDetails = document.querySelector('[role="dialog"][aria-label="资源占用"]');
		expect(resourceDetails?.textContent).toContain("CPU 12%");
		expect(document.activeElement).toBe(resourceDetails);
		const closeResourceDetails = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		await act(async () => resourceDetails!.dispatchEvent(closeResourceDetails));
		expect(closeResourceDetails.defaultPrevented).toBe(true);
		expect(document.querySelector('[role="dialog"][aria-label="资源占用"]')).toBeNull();
		expect(document.querySelector('[role="dialog"][aria-label="会话更多信息"]')).toBe(moreInformation);
		await vi.waitFor(() => expect(document.activeElement).toBe(resourceDetailsTrigger));
		await act(async () =>
			resourceDetailsTrigger.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			),
		);
		expect(document.querySelector('[role="dialog"][aria-label="会话更多信息"]')).toBeNull();
		await vi.waitFor(() => expect(document.activeElement).toBe(moreInformationTrigger));
	});

	it("stays hidden until the task has attributed processes", () => {
		act(() => root.render(<TaskResourceUsageDetailPanel taskCardId="ab12c" />));

		expect(container.textContent).toBe("");
	});

	it("summarizes the task in one line and breaks it down by process classification on demand", () => {
		act(() => root.render(<TaskResourceUsageDetailPanel taskCardId="ab12c" />));
		act(() =>
			replaceTaskResourceUsageSnapshots([
				{
					workspaceId: "repo",
					attributedTaskCardId: "ab12c",
					sampledAtEpochMs: 1,
					attributedProcessCount: 6,
					residentSetSizeKibibytesSumUpperBound: 700_000,
					cpuPercentOfOneCoreOverLastSampleInterval: 12.4,
					survivedSessionRootExitProcessCount: 1,
					survivedSessionRootExitResidentSetSizeKibibytesSum: 90_000,
					agentHarnessRootPhysicalFootprintBytes: null,
					processCountByProcessClassification: { agent_harness_root_process: 1, mcp_server_process: 5 },
					residentSetSizeKibibytesSumUpperBoundByProcessClassification: {
						agent_harness_root_process: 300_000,
						mcp_server_process: 400_000,
					},
					mcpServerInstances: [
						{ mcpServerInstanceLabel: "serena", processCount: 5, residentSetSizeKibibytesSum: 400_000 },
					],
				},
			]),
		);

		expect(container.textContent).toContain("资源占用 · 6 个进程 · RSS 上界 684M · CPU 12% · 残留 1 个");
		expect(container.textContent).not.toContain("MCP server");

		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="展开资源占用明细"]')?.click());

		expect(container.textContent).toContain("MCP server");
		expect(container.textContent).toContain("serena 391M");
		expect(container.textContent).toContain("会话已结束、仍在运行的残留进程 1 个");
	});

	it("shows the task's cumulative model tokens and worktree disk size once the monitors have them", () => {
		act(() => root.render(<TaskResourceUsageDetailPanel taskCardId="ab12c" />));
		act(() =>
			replaceTaskResourceUsageSnapshots([
				{
					workspaceId: "repo",
					attributedTaskCardId: "ab12c",
					sampledAtEpochMs: 1,
					attributedProcessCount: 1,
					residentSetSizeKibibytesSumUpperBound: 300_000,
					cpuPercentOfOneCoreOverLastSampleInterval: null,
					survivedSessionRootExitProcessCount: 0,
					survivedSessionRootExitResidentSetSizeKibibytesSum: 0,
					agentHarnessRootPhysicalFootprintBytes: null,
					processCountByProcessClassification: { agent_harness_root_process: 1 },
					residentSetSizeKibibytesSumUpperBoundByProcessClassification: { agent_harness_root_process: 300_000 },
					mcpServerInstances: [],
					modelTokenUsageAcrossTaskSessions: {
						sessionCount: 2,
						cumulativeInputTokens: 1_200,
						cumulativeCacheCreationInputTokens: 350_000,
						cumulativeCacheReadInputTokens: 12_400_000,
						cumulativeOutputTokens: 48_000,
					},
					latestWorktreeDiskUsageBytes: 2 * 1024 ** 3,
				},
			]),
		);
		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="展开资源占用明细"]')?.click());

		expect(container.textContent).toContain(
			"模型 token（2 个会话累计）：输入 1k · 缓存写 350k · 缓存读 12.4M · 输出 48k",
		);
		expect(container.textContent).toContain("worktree 磁盘（不含软链的依赖，最近一次测量）：2.0G");
	});
});
