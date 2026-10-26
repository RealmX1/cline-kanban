import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskVisualizationPreviewPage } from "@/components/task-visualization-preview-page";
import type { TaskVisualizationArtifact } from "@/runtime/types";

const queries = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn() }));
vi.mock("@/runtime/task-visualization-query", () => ({
	fetchTaskVisualizationArtifacts: queries.list,
	prepareTaskVisualizationPreview: queries.prepare,
}));

const firstArtifact: TaskVisualizationArtifact = {
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
const latestArtifact: TaskVisualizationArtifact = {
	...firstArtifact,
	revisionId: "c".repeat(64),
	versionNumber: 2,
	publishedAtMs: 2,
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("IntersectionObserver", undefined);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queries.list.mockReset().mockResolvedValue({
		artifacts: [latestArtifact],
		taskAttribution: { workspaceId: "workspace-a", taskId: "task-a", taskTitle: "真实任务名称" },
	});
	queries.prepare
		.mockReset()
		.mockImplementation(async (_workspaceId: string, _taskId: string, _artifactId: string, revisionId?: string) => {
			const artifact = revisionId === firstArtifact.revisionId ? firstArtifact : latestArtifact;
			if (revisionId !== undefined && revisionId !== artifact.revisionId) throw new Error("未找到指定修订。");
			return {
				artifact,
				contentAccessExpiresAtMs: 1000,
				contentRelativeUrl: `/content/${artifact.revisionId}/chart.html`,
				viewerRelativeUrl: `/task-visualization-preview?revisionId=${artifact.revisionId}`,
			};
		});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	window.history.replaceState(null, "", "/");
	vi.unstubAllGlobals();
});

async function renderViewer(revisionId?: string) {
	const query = new URLSearchParams({
		workspaceId: firstArtifact.workspaceId,
		taskId: firstArtifact.taskId,
		visualizationArtifactId: firstArtifact.visualizationArtifactId,
	});
	if (revisionId !== undefined) query.set("revisionId", revisionId);
	window.history.replaceState(null, "", `/task-visualization-preview?${query}`);
	await act(async () => root.render(<TaskVisualizationPreviewPage />));
}

it("独立页遵循旧修订链接，加载最新版本后才切换内容及新标签链接", async () => {
	await renderViewer(firstArtifact.revisionId);
	expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
		`/content/${firstArtifact.revisionId}/chart.html`,
	);
	expect(container.textContent).toContain("当前第 1 版，第 2 版已就绪");
	expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toContain(
		`revisionId=${firstArtifact.revisionId}`,
	);
	const loadLatestButton = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "加载最新版本",
	);
	expect(loadLatestButton).toBeDefined();
	await act(async () => loadLatestButton?.click());
	expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
		`/content/${latestArtifact.revisionId}/chart.html`,
	);
	expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toContain(
		`revisionId=${latestArtifact.revisionId}`,
	);
	expect(container.textContent).not.toContain("加载最新版本");
});

it("没有修订参数的旧链接打开最新版本", async () => {
	await renderViewer();
	expect(container.querySelector('[aria-label="可视化任务署名"]')?.textContent).toContain("真实任务名称");
	expect(document.title).toContain("task-a · 真实任务名称");
	expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
		`/content/${latestArtifact.revisionId}/chart.html`,
	);
});

it.each(["d".repeat(64), ""])("无效修订参数 %j 显示错误，不静默打开最新版", async (revisionId) => {
	await renderViewer(revisionId);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("未找到指定修订。");
	expect(container.querySelector("iframe")).toBeNull();
});
