import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskMainSessionPlanDownloadButton } from "./task-main-session-plan-download-button";

const { readPlan, download } = vi.hoisted(() => ({ readPlan: vi.fn(), download: vi.fn() }));
vi.mock("@/runtime/task-file-download-query", () => ({
	fetchTaskMainSessionPlan: readPlan,
	startTaskFileDownload: download,
}));
const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	vi.resetAllMocks();
});
const candidate = {
	candidateId: "candidate",
	fileName: "计划.md",
	sourceKind: "file",
	sourceReference: "/plans/计划.md",
};
const mount = async (taskId = "task") =>
	act(async () =>
		root.render(
			<TaskMainSessionPlanDownloadButton workspaceId="workspace" taskId={taskId} taskCreatedAtEpochMs={1} />,
		),
	);
const click = async (name: string) =>
	act(async () =>
		[...document.querySelectorAll("button")]
			.find((button) => button.textContent === name || button.getAttribute("aria-label") === name)
			?.click(),
	);

it("单一计划直接下载，查询只携带任务身份", async () => {
	readPlan.mockResolvedValue({ availability: "available", candidates: [candidate], notice: null });
	await mount();
	await click("下载主会话 Plan");
	expect(readPlan).toHaveBeenCalledWith("workspace", { taskId: "task", expectedTaskIncarnationCreatedAtEpochMs: 1 });
	expect(download).toHaveBeenCalledWith(
		"workspace",
		{
			taskId: "task",
			expectedTaskIncarnationCreatedAtEpochMs: 1,
			source: "main_session_plan",
			candidateId: "candidate",
		},
		expect.any(AbortSignal),
	);
});
it("多个同版文件先列候选，再下载选中的文件", async () => {
	readPlan.mockResolvedValue({
		availability: "available",
		candidates: [candidate, { ...candidate, candidateId: "other", fileName: "另一计划.md" }],
		notice: null,
	});
	await mount();
	await click("下载主会话 Plan");
	expect(download).not.toHaveBeenCalled();
	expect(document.body.textContent).toContain("请选择要下载的文件");
	await click("另一计划.md");
	expect(download.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ candidateId: "other" }));
});
it("暂不可读显示未知原因，并允许重新读取", async () => {
	readPlan
		.mockResolvedValueOnce({ availability: "unknown", candidates: [], notice: "原生历史暂不可读" })
		.mockResolvedValueOnce({ availability: "available", candidates: [candidate], notice: null });
	await mount();
	await click("下载主会话 Plan");
	expect(document.body.textContent).toContain("原生历史暂不可读");
	await click("重新读取 Plan");
	expect(download).toHaveBeenCalledTimes(1);
});
it("切换任务后丢弃旧 Plan 查询的迟到响应", async () => {
	let finish: ((value: unknown) => void) | undefined;
	readPlan.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	await mount();
	await click("下载主会话 Plan");
	await mount("new-task");
	await act(async () => finish?.({ availability: "available", candidates: [candidate], notice: null }));
	expect(download).not.toHaveBeenCalled();
});
