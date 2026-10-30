import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTaskVisualizationArtifacts } from "@/hooks/use-task-visualization-artifacts";
import type * as TaskVisualizationQuery from "@/runtime/task-visualization-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
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
	notifyTaskVisualizationStreamReconnected,
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
function Harness({ workspaceId = "workspace-a", taskId = "task-a", foregroundEligible = true, observeBrowser = true }) {
	latest = useTaskVisualizationArtifacts({
		workspaceId,
		taskId,
		observeBrowser,
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
	vi.useRealTimers();
});

it.each(["", '{"result":'])("清单 JSON 响应 %j 无法解析时按 400ms、1200ms 有界重试", async (response) => {
	vi.useFakeTimers();
	queries.list.mockImplementationOnce(async () => JSON.parse(response));
	await act(async () => root.render(<Harness />));
	expect(latest.isLoading).toBe(true);
	expect(latest.error).toBeNull();
	await act(async () => vi.advanceTimersByTimeAsync(399));
	expect(queries.list).toHaveBeenCalledTimes(1);
	await act(async () => vi.advanceTimersByTimeAsync(1));
	expect(queries.list).toHaveBeenCalledTimes(2);
	expect(latest.artifacts).toEqual([artifact]);
	expect(latest.isLoading).toBe(false);
});

it.each(["online", "visibilitychange", "stream_reconnected", "manual"])(
	"重试耗尽后通过 %s 补读，保留任务名、选中旧修订与 iframe",
	async (event) => {
		vi.useFakeTimers();
		const taskAttribution = { workspaceId: "workspace-a", taskId: "task-a", taskTitle: "原任务名" };
		queries.list.mockResolvedValue({ artifacts: [artifact], taskAttribution });
		await act(async () => root.render(<Harness />));
		await act(async () => latest.selectArtifact(artifact));
		const selection = latest.selection;
		const frame = container.querySelector("iframe");
		queries.list.mockRejectedValue(new SyntaxError("Unexpected end of JSON input"));
		await act(async () => latest.refreshArtifacts());
		await act(async () => vi.advanceTimersByTimeAsync(400));
		await act(async () => vi.advanceTimersByTimeAsync(1200));
		expect(queries.list).toHaveBeenCalledTimes(4);
		expect(latest.error).toBe("Unexpected end of JSON input");
		expect(latest.isLoading).toBe(false);
		expect(latest.artifacts).toEqual([artifact]);
		expect(latest.taskAttribution).toEqual(taskAttribution);
		expect(container.querySelector("iframe")).toBe(frame);
		await act(async () => vi.advanceTimersByTimeAsync(30_000));
		expect(queries.list).toHaveBeenCalledTimes(4);
		const nextArtifact = { ...artifact, revisionId: "c".repeat(64), versionNumber: 2 };
		queries.list.mockResolvedValue({ artifacts: [nextArtifact], taskAttribution });
		await act(async () => {
			if (event === "manual") latest.refreshArtifacts();
			else if (event === "stream_reconnected") notifyTaskVisualizationStreamReconnected("workspace-a");
			else if (event === "visibilitychange") document.dispatchEvent(new Event(event));
			else window.dispatchEvent(new Event(event));
		});
		expect(queries.list).toHaveBeenCalledTimes(5);
		expect(latest.error).toBeNull();
		expect(latest.artifacts).toEqual([nextArtifact]);
		expect(latest.selection).toBe(selection);
		expect(container.querySelector("iframe")).toBe(frame);
	},
);

it("请求每 8 秒超时后重试，第三次超时停止并可手动补读", async () => {
	vi.useFakeTimers();
	const signals: AbortSignal[] = [];
	queries.list.mockImplementation((_workspaceId, _taskId, signal: AbortSignal) => {
		signals.push(signal);
		return new Promise(() => {});
	});
	await act(async () => root.render(<Harness />));
	await act(async () => vi.advanceTimersByTimeAsync(7999));
	expect(signals[0]).toHaveProperty("aborted", false);
	await act(async () => vi.advanceTimersByTimeAsync(1));
	expect(signals[0]).toHaveProperty("aborted", true);
	await act(async () => vi.advanceTimersByTimeAsync(400));
	await act(async () => vi.advanceTimersByTimeAsync(8000));
	await act(async () => vi.advanceTimersByTimeAsync(1200));
	await act(async () => vi.advanceTimersByTimeAsync(8000));
	expect(queries.list).toHaveBeenCalledTimes(3);
	expect(signals.every((signal) => signal.aborted)).toBe(true);
	expect(latest.isLoading).toBe(false);
	expect(latest.error).toBeTruthy();
	queries.list.mockResolvedValue({ artifacts: [artifact] });
	await act(async () => latest.refreshArtifacts());
	expect(latest.artifacts).toEqual([artifact]);
	expect(latest.error).toBeNull();
});

it("真实 tRPC 合批未取消时仍按期限结束清单读取，拒绝迟到结果并允许恢复", async () => {
	vi.useFakeTimers();
	const actualQuery = await vi.importActual<typeof TaskVisualizationQuery>("@/runtime/task-visualization-query");
	const workspaceId = "workspace-batched-list-timeout";
	const client = getRuntimeTrpcClient(workspaceId);
	const unrelatedReads: Promise<unknown>[] = [];
	const pendingResponses: { signal: AbortSignal | null | undefined; release: () => void }[] = [];
	const lateTaskAttribution = { workspaceId, taskId: "task-a", taskTitle: "迟到任务名" };
	const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
		(input, init) =>
			new Promise<Response>((resolve) => {
				const paths = new URL(String(input), "http://kanban.test").pathname.replace("/api/trpc/", "").split(",");
				expect(paths).toEqual(["taskVisualizationArtifacts.list", "projects.list"]);
				pendingResponses.push({
					signal: init?.signal,
					release: () =>
						resolve(
							new Response(
								JSON.stringify(
									paths.map((path) => ({
										result: {
											data:
												path === "projects.list"
													? []
													: { artifacts: [artifact], taskAttribution: lateTaskAttribution },
										},
									})),
								),
								{ headers: { "content-type": "application/json" } },
							),
						),
				});
			}),
	);
	queries.list.mockImplementation((scope: string, taskId: string, signal: AbortSignal) => {
		const read = actualQuery.fetchTaskVisualizationArtifacts(scope, taskId, signal);
		unrelatedReads.push(client.projects.list.query());
		return read;
	});
	await act(async () => root.render(<Harness workspaceId={workspaceId} />));
	await act(async () => vi.advanceTimersByTimeAsync(25_601));
	expect(pendingResponses).toHaveLength(3);
	expect(pendingResponses.every(({ signal }) => signal?.aborted === false)).toBe(true);
	expect(latest.isLoading).toBe(false);
	expect(latest.error).toBeTruthy();
	const timeoutError = latest.error;
	await act(async () => {
		for (const response of pendingResponses) response.release();
		await Promise.all(unrelatedReads);
	});
	expect(latest.artifacts).toEqual([]);
	expect(latest.taskAttribution).toBeNull();
	expect(latest.error).toBe(timeoutError);
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify([{ result: { data: { artifacts: [artifact] } } }, { result: { data: [] } }]), {
			headers: { "content-type": "application/json" },
		}),
	);
	await act(async () => latest.refreshArtifacts());
	await act(async () => vi.advanceTimersByTimeAsync(1));
	expect(latest.artifacts).toEqual([artifact]);
	expect(latest.error).toBeNull();
});

it.each(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"])("%s 错误不自动重试", async (code) => {
	vi.useFakeTimers();
	queries.list.mockRejectedValue(Object.assign(new Error("任务不可访问"), { data: { code } }));
	await act(async () => root.render(<Harness />));
	await act(async () => vi.advanceTimersByTimeAsync(30_000));
	expect(queries.list).toHaveBeenCalledTimes(1);
	expect(latest.error).toBe("任务不可访问");
});

it("切换任务取消旧请求，迟到响应不覆盖当前任务，卸载取消重试", async () => {
	vi.useFakeTimers();
	let resolveOld = (_value: unknown) => {};
	queries.list.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveOld = resolve;
			}),
	);
	await act(async () => root.render(<Harness />));
	const oldSignal = queries.list.mock.calls[0]?.[2] as AbortSignal;
	const nextArtifact = { ...artifact, taskId: "task-b", title: "目标任务图" };
	queries.list.mockResolvedValue({ artifacts: [nextArtifact] });
	await act(async () => root.render(<Harness taskId="task-b" />));
	expect(oldSignal.aborted).toBe(true);
	await act(async () => resolveOld({ artifacts: [artifact] }));
	expect(latest.artifacts).toEqual([nextArtifact]);
	queries.list.mockRejectedValue(new SyntaxError("响应为空"));
	await act(async () => latest.refreshArtifacts());
	const requestCount = queries.list.mock.calls.length;
	await act(async () => root.render(null));
	await act(async () => vi.advanceTimersByTimeAsync(30_000));
	expect(queries.list).toHaveBeenCalledTimes(requestCount);
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

it("空归属停止加载，恢复与跨项目切换清空旧清单，不接收其他项目同号任务的自动预览", async () => {
	await act(async () => root.render(<Harness workspaceId="" />));
	expect(queries.list).not.toHaveBeenCalled();
	expect(latest.isLoading).toBe(false);
	await act(async () => root.render(<Harness />));
	expect(container.textContent).toContain("任务图表");
	await act(async () => root.render(<Harness workspaceId="" />));
	expect(latest.isLoading).toBe(false);
	expect(latest.artifacts).toEqual([]);
	expect(queries.list).toHaveBeenCalledTimes(1);
	await act(async () => root.render(<Harness />));
	expect(container.textContent).toContain("任务图表");
	expect(queries.list).toHaveBeenCalledTimes(2);
	queries.list.mockResolvedValue({ artifacts: [] });
	await act(async () => root.render(<Harness workspaceId="workspace-b" />));
	expect(container.textContent).not.toContain("任务图表");
	await grant(offer());
	expect(opened).not.toHaveBeenCalled();
});
it("任务名暂缺时自动补证，恢复后停止重试并显示真实名称", async () => {
	vi.useFakeTimers();
	try {
		queries.list
			.mockResolvedValueOnce({
				artifacts: [artifact],
				taskAttribution: { workspaceId: "workspace-a", taskId: "task-a", taskTitle: null },
			})
			.mockResolvedValue({
				artifacts: [artifact],
				taskAttribution: { workspaceId: "workspace-a", taskId: "task-a", taskTitle: "恢复后的任务名" },
			});
		await act(async () => root.render(<Harness />));
		expect(queries.list).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTimeAsync(1000));
		expect(latest.taskAttribution?.taskTitle).toBe("恢复后的任务名");
		await act(async () => vi.advanceTimersByTimeAsync(60_000));
		expect(queries.list).toHaveBeenCalledTimes(2);
	} finally {
		vi.useRealTimers();
	}
});
it("默认选最新产物并按 ID 打破同时间平局，重复调用和更新保留当前修订", async () => {
	const newestArtifact = { ...artifact, visualizationArtifactId: "c".repeat(64), publishedAtMs: 2 };
	queries.list.mockResolvedValue({
		artifacts: [{ ...newestArtifact, visualizationArtifactId: "d".repeat(64) }, artifact, newestArtifact],
	});
	await act(async () => root.render(<Harness />));
	await act(async () => latest.ensureDefaultSelection());
	expect(latest.selection).toMatchObject({
		visualizationArtifactId: newestArtifact.visualizationArtifactId,
		revisionId: newestArtifact.revisionId,
	});
	const selection = latest.selection;
	queries.list.mockResolvedValue({ artifacts: [{ ...newestArtifact, revisionId: "e".repeat(64) }] });
	await act(async () => latest.refreshArtifacts());
	await act(async () => {
		latest.ensureDefaultSelection();
		latest.ensureDefaultSelection();
	});
	expect(latest.selection).toBe(selection);
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
	await act(async () => latest.refreshArtifacts());
	await act(async () => latest.ensureDefaultSelection());
	expect(latest.selection).toBeNull();
	await act(async () => latest.retryDefaultSelection());
	expect(latest.selection?.visualizationArtifactId).toBe(artifact.visualizationArtifactId);
});
it("停止浏览器观察时在卸载后释放自动预览，恢复观察不会重挂", async () => {
	await act(async () => root.render(<Harness />));
	await grant(offer());
	await act(async () => root.render(<Harness observeBrowser={false} />));
	expect(container.querySelector("iframe")).toBeNull();
	expect(failedFrameCounts).toEqual([0]);
	await act(async () => root.render(<Harness />));
	await act(async () => latest.ensureDefaultSelection());
	expect(latest.selection).toBeNull();
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
