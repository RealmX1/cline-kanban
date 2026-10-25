import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTaskVisualizationArtifacts } from "@/hooks/use-task-visualization-artifacts";
import type {
	RuntimeStateStreamClientMessage,
	TaskVisualizationArtifact,
	TaskVisualizationPreviewRequestedMessage,
} from "@/runtime/types";
import {
	attachTaskVisualizationRuntimeStreamSender,
	declareTaskVisualizationBrowserContext,
	deliverTaskVisualizationStreamMessage,
	notifyTaskVisualizationStreamDisconnected,
	readTaskVisualizationBrowserPageId,
} from "@/stores/task-visualization-browser-bridge";

const queries = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/runtime/task-visualization-query", () => ({ fetchTaskVisualizationArtifacts: queries.list }));
const artifact: TaskVisualizationArtifact = {
	workspaceId: "workspace-a",
	taskId: "task-a",
	visualizationArtifactId: "a".repeat(64),
	revisionId: "b".repeat(64),
	versionNumber: 1,
	title: "任务图表",
	entryHtmlRelativePath: "chart.html",
	publishedAtMs: 1,
	sourceConversationSessionId: null,
};
let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useTaskVisualizationArtifacts>;
let detachSender: () => void;
const outgoing: RuntimeStateStreamClientMessage[] = [];
const failedFrameCounts: number[] = [];
const opened = vi.fn();
function Harness({ workspaceId = "workspace-a", taskId = "task-a", foregroundEligible = true }) {
	latest = useTaskVisualizationArtifacts({
		workspaceId,
		taskId,
		onAutomaticPreview: opened,
		isAutomaticPreviewForegroundEligible: foregroundEligible,
	});
	return (
		<div>
			{latest.artifacts.map((entry) => entry.title).join(",")}
			{latest.selection ? <iframe title="已挂载预览" /> : null}
		</div>
	);
}
function offer(): TaskVisualizationPreviewRequestedMessage {
	return {
		type: "task_visualization_preview_requested",
		workspaceId: "workspace-a",
		taskId: "task-a",
		browserPageId: readTaskVisualizationBrowserPageId(),
		deliveryAttemptId: crypto.randomUUID(),
		deliveryState: "offered",
		previewRequest: {
			previewRequestId: crypto.randomUUID(),
			visualizationArtifactId: artifact.visualizationArtifactId,
			revisionId: artifact.revisionId,
			requestedAtMs: 1,
			displayedAtMs: null,
		},
	};
}
async function grant(message: TaskVisualizationPreviewRequestedMessage) {
	await act(async () => deliverTaskVisualizationStreamMessage(message));
	await act(async () => deliverTaskVisualizationStreamMessage({ ...message, deliveryState: "accepted" }));
}
beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queries.list.mockReset().mockResolvedValue({ artifacts: [artifact] });
	opened.mockClear();
	outgoing.length = 0;
	failedFrameCounts.length = 0;
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	detachSender = attachTaskVisualizationRuntimeStreamSender("workspace-a", (message) => {
		outgoing.push(message);
		if (message.type === "acknowledge_task_visualization_preview" && message.outcome === "failed")
			failedFrameCounts.push(container.querySelectorAll("iframe").length);
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	detachSender();
	container.remove();
	vi.restoreAllMocks();
});

it("切到其他前台视图只暂停自动投递，手动阅读的 iframe 与选择保持", async () => {
	await act(async () => root.render(<Harness />));
	await act(async () => latest.selectArtifact(artifact));
	const selection = latest.selection;
	const frame = container.querySelector("iframe");
	await act(async () => root.render(<Harness foregroundEligible={false} />));
	const message = offer();
	await act(async () => deliverTaskVisualizationStreamMessage(message));
	expect(latest.selection).toBe(selection);
	expect(container.querySelector("iframe")).toBe(frame);
	expect(outgoing).toContainEqual(
		expect.objectContaining({
			type: "acknowledge_task_visualization_preview",
			outcome: "declined",
			deliveryAttemptId: message.deliveryAttemptId,
		}),
	);
	await act(async () => root.render(<Harness />));
	expect(latest.selection).toBe(selection);
	expect(container.querySelector("iframe")).toBe(frame);
	expect(opened).not.toHaveBeenCalled();
});

it("跨项目切换清空旧清单，不接收其他项目同号任务的自动预览", async () => {
	await act(async () => root.render(<Harness />));
	expect(container.textContent).toContain("任务图表");
	queries.list.mockResolvedValue({ artifacts: [] });
	await act(async () => root.render(<Harness workspaceId="workspace-b" />));
	expect(container.textContent).not.toContain("任务图表");
	await grant(offer());
	expect(opened).not.toHaveBeenCalled();
});
it("offer 只确认接受，匹配服务端 grant 后才挂载，错误页面和未请求 grant 不打开", async () => {
	await act(async () => root.render(<Harness />));
	const message = offer();
	await act(async () => deliverTaskVisualizationStreamMessage({ ...message, deliveryState: "accepted" }));
	expect(opened).not.toHaveBeenCalled();
	await act(async () => deliverTaskVisualizationStreamMessage(message));
	expect(outgoing.at(-1)).toMatchObject({ outcome: "accepted", deliveryAttemptId: message.deliveryAttemptId });
	expect(opened).not.toHaveBeenCalled();
	expect(latest.selection).toBeNull();
	await act(async () =>
		deliverTaskVisualizationStreamMessage({
			...message,
			deliveryState: "accepted",
			browserPageId: crypto.randomUUID(),
		}),
	);
	expect(opened).not.toHaveBeenCalled();
	await act(async () =>
		deliverTaskVisualizationStreamMessage({
			...message,
			deliveryState: "accepted",
			previewRequest: { ...message.previewRequest, previewRequestId: crypto.randomUUID() },
		}),
	);
	expect(opened).not.toHaveBeenCalled();
	await act(async () => deliverTaskVisualizationStreamMessage({ ...message, deliveryState: "accepted" }));
	expect(opened).toHaveBeenCalledTimes(1);
	expect(container.querySelector("iframe")).not.toBeNull();
	await grant(message);
	expect(opened).toHaveBeenCalledTimes(1);
});
it("当前 frame 真正确认后才 displayed，相同修订旧 selection 的迟到回执无效", async () => {
	await act(async () => root.render(<Harness />));
	const first = offer();
	await grant(first);
	const staleKey = latest.selection?.selectionRequestKey ?? 0;
	const current = offer();
	await grant(current);
	const currentKey = latest.selection?.selectionRequestKey ?? 0;
	outgoing.length = 0;
	await act(async () => latest.acknowledgeRenderedPreview(artifact, staleKey));
	expect(outgoing).toHaveLength(0);
	await act(async () => latest.acknowledgeRenderedPreview(artifact, currentKey));
	expect(outgoing.at(-1)).toMatchObject({
		outcome: "displayed",
		previewRequestId: current.previewRequest.previewRequestId,
	});
	await grant(current);
	expect(opened).toHaveBeenCalledTimes(2);
});
it("关闭未加载预览后重放不重新抢回，失败释放在 frame 卸载后发生", async () => {
	await act(async () => root.render(<Harness />));
	declareTaskVisualizationBrowserContext("workspace-a", "task-a", true);
	const dismissed = offer();
	await grant(dismissed);
	await act(async () => latest.dismissAutomaticPreview());
	await grant(dismissed);
	expect(opened).toHaveBeenCalledTimes(1);
	const failed = offer();
	await grant(failed);
	await act(async () => latest.failAutomaticPreview(latest.selection?.selectionRequestKey, "模拟内容失败"));
	expect(latest.selection).toBeNull();
	expect(failedFrameCounts).toEqual([0]);
	expect(outgoing.at(-1)).toMatchObject({ outcome: "failed", failureReason: "模拟内容失败" });
});
it("取消或断线先移除旧 frame，迟到 grant 与成功回执不重新打开", async () => {
	await act(async () => root.render(<Harness />));
	const message = offer();
	await grant(message);
	const key = latest.selection?.selectionRequestKey ?? 0;
	await act(async () =>
		deliverTaskVisualizationStreamMessage({
			...message,
			deliveryState: "cancelled",
			deliveryFailureReason: "已超时",
		}),
	);
	expect(failedFrameCounts).toEqual([0]);
	expect(container.querySelector("iframe")).toBeNull();
	await act(async () => latest.acknowledgeRenderedPreview(artifact, key));
	await grant(message);
	expect(opened).toHaveBeenCalledTimes(1);
	const next = offer();
	await grant(next);
	await act(async () => notifyTaskVisualizationStreamDisconnected("workspace-a"));
	expect(container.querySelector("iframe")).toBeNull();
	expect(failedFrameCounts).toEqual([0, 0, 0]);
});
