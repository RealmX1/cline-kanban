import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskVisualizationArtifactsPanel } from "@/components/detail-panels/task-visualization-artifacts-panel";
import { ExpandedForegroundViewProvider } from "@/expanded-foreground-view/expanded-foreground-view-provider";
import type { useTaskVisualizationArtifacts } from "@/hooks/use-task-visualization-artifacts";
import type { TaskVisualizationArtifact } from "@/runtime/types";

const queries = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("@/runtime/task-visualization-query", () => ({ prepareTaskVisualizationPreview: queries.prepare }));
vi.mock("@/expanded-foreground-view/expanded-foreground-view-detached-content", () => ({
	ExpandedForegroundViewDetachedContent: () => null,
}));
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
const acknowledgeRenderedPreview = vi.fn();
const failAutomaticPreview = vi.fn();
const confirmationId = "11111111-1111-4111-8111-111111111111";
const controller = {
	artifacts: [artifact],
	taskAttribution: { workspaceId: "workspace-a", taskId: "task-a", taskTitle: "真实任务名称" },
	isLoading: false,
	error: null,
	selection: {
		visualizationArtifactId: artifact.visualizationArtifactId,
		revisionId: artifact.revisionId,
		selectionRequestKey: 1,
	},
	automaticPreviewError: null,
	failAutomaticPreview,
	refreshArtifacts: vi.fn(),
	selectArtifact: vi.fn(),
	ensureDefaultSelection: vi.fn(),
	retryDefaultSelection: vi.fn(),
	acknowledgeRenderedPreview,
	dismissAutomaticPreview: vi.fn(),
} satisfies ReturnType<typeof useTaskVisualizationArtifacts>;
beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("IntersectionObserver", undefined);
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	acknowledgeRenderedPreview.mockClear();
	failAutomaticPreview.mockClear();
	queries.prepare.mockResolvedValue({
		artifact,
		contentRelativeUrl: "/missing/chart.html",
		viewerRelativeUrl: "/viewer",
		contentAccessExpiresAtMs: 1000,
		contentLoadConfirmationId: confirmationId,
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	window.history.replaceState(null, "", "/");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
it("任务署名在 iframe 外显示，任务名和图表标题独立且全屏保留", async () => {
	await act(async () =>
		root.render(
			<TaskVisualizationArtifactsPanel workspaceId="workspace-a" taskId="task-a" controller={controller} />,
		),
	);
	const attribution = container.querySelector('[aria-label="可视化任务署名"]');
	expect(attribution?.textContent).toContain("task-a");
	expect(attribution?.textContent).toContain("真实任务名称");
	expect(attribution?.textContent).not.toContain(artifact.title);
	const fullscreen = container.querySelector<HTMLButtonElement>('[aria-label="全屏预览"]');
	await act(async () => fullscreen?.click());
	expect(container.querySelector('[aria-label="可视化任务署名"]')?.textContent).toContain("真实任务名称");
});

it("来自另一个 workspace 的同号任务署名不会串入当前预览", async () => {
	const mismatched = {
		...controller,
		taskAttribution: { workspaceId: "workspace-b", taskId: "task-a", taskTitle: "别的项目" },
	};
	await act(async () =>
		root.render(
			<TaskVisualizationArtifactsPanel workspaceId="workspace-a" taskId="task-a" controller={mismatched} />,
		),
	);
	const attribution = container.querySelector('[aria-label="可视化任务署名"]');
	expect(attribution?.textContent).not.toContain("别的项目");
	expect(attribution?.textContent).toContain("任务名暂不可用");
});
it("404 错误文档触发 iframe load 时不写 displayed", async () => {
	await act(async () =>
		root.render(
			<TaskVisualizationArtifactsPanel workspaceId="workspace-a" taskId="task-a" controller={controller} />,
		),
	);
	const iframe = container.querySelector("iframe");
	expect(iframe).not.toBeNull();
	await act(async () => iframe?.dispatchEvent(new Event("load")));
	expect(acknowledgeRenderedPreview).not.toHaveBeenCalled();
});

it("只有当前 frame、opaque origin、本次修订和加载证明全部匹配才确认", async () => {
	await act(async () =>
		root.render(
			<TaskVisualizationArtifactsPanel workspaceId="workspace-a" taskId="task-a" controller={controller} />,
		),
	);
	const frame = container.querySelector("iframe");
	const data = {
		type: "kanban_visualization_content_loaded",
		workspaceId: artifact.workspaceId,
		taskId: artifact.taskId,
		visualizationArtifactId: artifact.visualizationArtifactId,
		revisionId: artifact.revisionId,
		contentLoadConfirmationId: confirmationId,
	};
	for (const event of [
		new MessageEvent("message", { source: window, origin: "null", data }),
		new MessageEvent("message", { source: frame?.contentWindow, origin: window.location.origin, data }),
		new MessageEvent("message", {
			source: frame?.contentWindow,
			origin: "null",
			data: { ...data, contentLoadConfirmationId: "旧证明" },
		}),
		new MessageEvent("message", {
			source: frame?.contentWindow,
			origin: "null",
			data: { ...data, revisionId: "c".repeat(64) },
		}),
	]) {
		await act(async () => window.dispatchEvent(event));
	}
	expect(acknowledgeRenderedPreview).not.toHaveBeenCalled();
	await act(async () =>
		window.dispatchEvent(new MessageEvent("message", { source: frame?.contentWindow, origin: "null", data })),
	);
	expect(acknowledgeRenderedPreview).toHaveBeenCalledExactlyOnceWith(artifact, 1);
});
it("内容未确认成功时有界超时并卸载 iframe，单纯 load 不取消失败计时", async () => {
	vi.useFakeTimers();
	try {
		await act(async () =>
			root.render(
				<TaskVisualizationArtifactsPanel workspaceId="workspace-a" taskId="task-a" controller={controller} />,
			),
		);
		await act(async () => container.querySelector("iframe")?.dispatchEvent(new Event("load")));
		await act(async () => vi.advanceTimersByTime(30_000));
		expect(container.querySelector("iframe")).toBeNull();
		expect(failAutomaticPreview).toHaveBeenCalledWith(1, expect.stringContaining("30 秒"));
		expect(acknowledgeRenderedPreview).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});
it("旧 frame 的迟到证明不能确认新 frame，即使产物和修订相同", async () => {
	await act(async () =>
		root.render(
			<TaskVisualizationArtifactsPanel workspaceId="workspace-a" taskId="task-a" controller={controller} />,
		),
	);
	const oldFrame = container.querySelector("iframe")?.contentWindow;
	queries.prepare.mockResolvedValue({
		artifact,
		contentRelativeUrl: "/retry/chart.html",
		viewerRelativeUrl: "/viewer",
		contentAccessExpiresAtMs: 1000,
		contentLoadConfirmationId: "22222222-2222-4222-8222-222222222222",
	});
	const retry = { ...controller, selection: { ...controller.selection, selectionRequestKey: 2 } };
	await act(async () =>
		root.render(<TaskVisualizationArtifactsPanel workspaceId="workspace-a" taskId="task-a" controller={retry} />),
	);
	const data = { type: "kanban_visualization_content_loaded", ...artifact, contentLoadConfirmationId: confirmationId };
	await act(async () => window.dispatchEvent(new MessageEvent("message", { source: oldFrame, origin: "null", data })));
	await act(async () =>
		window.dispatchEvent(
			new MessageEvent("message", {
				source: container.querySelector("iframe")?.contentWindow,
				origin: "null",
				data,
			}),
		),
	);
	expect(acknowledgeRenderedPreview).not.toHaveBeenCalled();
});

it("返回普通面板选择其他产物后，浏览器前进仍恢复展开链接指定的产物", async () => {
	const otherArtifact = { ...artifact, visualizationArtifactId: "c".repeat(64), title: "另一张图表" };
	function SelectablePanel() {
		const [selection, setSelection] = useState(controller.selection);
		return (
			<TaskVisualizationArtifactsPanel
				workspaceId="workspace-a"
				taskId="task-a"
				taskIncarnationCreatedAtEpochMs={1}
				controller={{
					...controller,
					artifacts: [artifact, otherArtifact],
					selection,
					selectArtifact: (selected) =>
						setSelection({
							visualizationArtifactId: selected.visualizationArtifactId,
							revisionId: selected.revisionId,
							selectionRequestKey: selection.selectionRequestKey + 1,
						}),
				}}
			/>
		);
	}
	window.history.replaceState(null, "", "/workspace-a?task=task-a");
	await act(async () =>
		root.render(
			<ExpandedForegroundViewProvider>
				<SelectablePanel />
			</ExpandedForegroundViewProvider>,
		),
	);
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="全屏预览"]')?.click());
	const back = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
	await act(async () => {
		window.history.back();
		await back;
	});
	const selector = container.querySelector("select");
	await act(async () => {
		if (selector) selector.value = otherArtifact.visualizationArtifactId;
		selector?.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(selector?.value).toBe(otherArtifact.visualizationArtifactId);
	const forward = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
	await act(async () => {
		window.history.forward();
		await forward;
	});
	expect(selector?.value).toBe(artifact.visualizationArtifactId);
	expect(new URLSearchParams(window.location.search).get("expandedVisualizationArtifactId")).toBe(
		artifact.visualizationArtifactId,
	);
});
