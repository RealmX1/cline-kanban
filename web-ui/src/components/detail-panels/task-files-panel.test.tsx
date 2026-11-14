import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskFilesPanel } from "./task-files-panel";

const { listDirectory, download } = vi.hoisted(() => ({ listDirectory: vi.fn(), download: vi.fn() }));
vi.mock("@/runtime/task-file-download-query", () => ({
	fetchTaskDirectory: listDirectory,
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

it("按需进入目录、面包屑返回、刷新，并复用下载动作", async () => {
	listDirectory.mockImplementation(async (_workspace, input) =>
		input.path
			? { path: input.path, entries: [{ name: "中文.bin", path: "目录/中文.bin", kind: "file" }] }
			: {
					path: "",
					entries: [
						{ name: "目录", path: "目录", kind: "directory" },
						{ name: ".hidden", path: ".hidden", kind: "file" },
					],
				},
	);
	await act(async () =>
		root.render(<TaskFilesPanel workspaceId="workspace" taskId="task" taskCreatedAtEpochMs={1} />),
	);
	expect(container.textContent).toContain(".hidden");
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="进入目录 目录"]')!.click());
	expect(container.textContent).toContain("中文.bin");
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="下载文件 中文.bin"]')!.click());
	expect(download).toHaveBeenCalledWith(
		"workspace",
		{ taskId: "task", expectedTaskIncarnationCreatedAtEpochMs: 1, source: "task_file", path: "目录/中文.bin" },
		expect.any(AbortSignal),
	);
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="返回任务根目录"]')!.click());
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新任务文件"]')!.click());
	expect(listDirectory).toHaveBeenCalledTimes(4);
});

it("任务切换后忽略旧任务迟到的响应", async () => {
	let finishOldRequest: ((value: unknown) => void) | undefined;
	listDirectory.mockImplementation((_workspace, input) =>
		input.taskId === "old"
			? new Promise((resolve) => {
					finishOldRequest = resolve;
				})
			: Promise.resolve({ path: "", entries: [{ name: "新文件", path: "新文件", kind: "file" }] }),
	);
	await act(async () => root.render(<TaskFilesPanel workspaceId="workspace" taskId="old" taskCreatedAtEpochMs={1} />));
	await act(async () => root.render(<TaskFilesPanel workspaceId="workspace" taskId="new" taskCreatedAtEpochMs={2} />));
	await act(async () => finishOldRequest?.({ path: "", entries: [{ name: "旧文件", path: "旧文件", kind: "file" }] }));
	expect(container.textContent).toContain("新文件");
	expect(container.textContent).not.toContain("旧文件");
});

it("读取失败提供明确提示和重试", async () => {
	listDirectory.mockRejectedValueOnce(new Error("目录暂不可读")).mockResolvedValueOnce({ path: "", entries: [] });
	await act(async () =>
		root.render(<TaskFilesPanel workspaceId="workspace" taskId="task" taskCreatedAtEpochMs={1} />),
	);
	expect(container.textContent).toContain("目录暂不可读");
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新任务文件"]')!.click());
	expect(container.textContent).toContain("此目录没有文件");
});
