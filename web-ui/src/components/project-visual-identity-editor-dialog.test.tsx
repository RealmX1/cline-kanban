import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectVisualIdentityEditorDialog } from "@/components/project-visual-identity-editor-dialog";
import * as queries from "@/runtime/project-visual-identity-query";
import type { RuntimeProjectSummary } from "@/runtime/types";

const project: RuntimeProjectSummary = {
	id: "project-1",
	name: "cline-kanban",
	path: "/project",
	availability: { status: "available" },
	taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
	inProgressTaskDetails: [],
	crossProjectTaskSwitcherEntries: [],
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
function button(text: string) {
	return [...document.querySelectorAll("button")].find((item) => item.textContent === text);
}
it("预览可改色、中文和英文搜索、取消不写入，失败可重试", async () => {
	const save = vi
		.spyOn(queries, "saveProjectVisualIdentity")
		.mockRejectedValueOnce(new Error("模拟保存失败"))
		.mockResolvedValue({ iconSource: "preset", presetIconId: "KanbanSquare", colorId: "red", imageAssetId: null });
	const close = vi.fn();
	await act(async () => root.render(<ProjectVisualIdentityEditorDialog project={project} onClose={close} />));
	await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="红"]')?.click());
	expect(document.querySelector('[aria-label="红"]')?.getAttribute("aria-pressed")).toBe("true");
	expect(save).not.toHaveBeenCalled();
	await act(async () => button("保存")?.click());
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("模拟保存失败");
	expect(close).not.toHaveBeenCalled();
	await act(async () => button("保存")?.click());
	expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ colorId: "red", workspaceId: project.id }));
	expect(close).toHaveBeenCalledOnce();
});
it("恢复默认先预览，取消不触发远端 reset", async () => {
	const reset = vi
		.spyOn(queries, "resetProjectVisualIdentity")
		.mockResolvedValue({ iconSource: "preset", presetIconId: "KanbanSquare", colorId: "blue", imageAssetId: null });
	const close = vi.fn();
	await act(async () => root.render(<ProjectVisualIdentityEditorDialog project={project} onClose={close} />));
	await act(async () => button("恢复默认")?.click());
	expect(reset).not.toHaveBeenCalled();
	await act(async () => button("取消")?.click());
	expect(close).toHaveBeenCalledOnce();
	expect(reset).not.toHaveBeenCalled();
});
