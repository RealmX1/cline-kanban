import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type { GetDirectlyRelatedTaskPreviewPageResponse } from "@runtime-work-unit-relation-read-api-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDirectlyRelatedTaskPreviewPages } from "./use-directly-related-task-preview-pages";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/directly-related-task-preview-query", () => ({
	fetchDirectlyRelatedTaskPreviewPage: read,
	buildQualifiedTaskPreviewIdentityKey: (task: KanbanBoardCardWorkUnitQualifiedReference) => JSON.stringify(task),
}));
const task: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "project-a",
	taskId: "same",
	taskIncarnationCreatedAtEpochMs: 1,
};
function page(title: string, nextCursor: string | null = null): GetDirectlyRelatedTaskPreviewPageResponse {
	return {
		subjectTask: task,
		entries: [
			{
				task: { ...task, taskId: title },
				title,
				workspaceRepositoryPath: null,
				lastKnownBoardColumnId: "review",
				permanentlyRemovedFromBoardAt: null,
				identityKnownToLedger: true,
				mutedOnly: false,
				relations: [],
			},
		],
		totalTaskCount: 2,
		mutedOnlyTaskCount: 0,
		standaloneSessionCount: 0,
		neighborhoodRevision: title,
		nextCursor,
	};
}
let root: Root;
let latest: ReturnType<typeof useDirectlyRelatedTaskPreviewPages>;
function Harness({
	subject = task,
	open = true,
}: {
	subject?: KanbanBoardCardWorkUnitQualifiedReference;
	open?: boolean;
}) {
	latest = useDirectlyRelatedTaskPreviewPages(subject, open);
	return null;
}
beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	root = createRoot(document.createElement("div"));
	read.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("关联分页的懒加载、恢复与迟到请求", () => {
	it("关闭时不读，首开才读，翻页保留已有条目", async () => {
		read.mockResolvedValueOnce(page("第一页", "next")).mockResolvedValueOnce(page("第二页"));
		await act(async () => root.render(<Harness open={false} />));
		expect(read).not.toHaveBeenCalled();
		await act(async () => root.render(<Harness />));
		expect(latest.page?.entries[0]?.title).toBe("第一页");
		await act(async () => latest.loadMore());
		expect(latest.page?.entries.map((entry) => entry.title)).toEqual(["第一页", "第二页"]);
	});
	it("游标失效仅重读一次首页，不把两个版本混在一起", async () => {
		read
			.mockResolvedValueOnce(page("旧首页", "expired"))
			.mockRejectedValueOnce(new Error("RELATED_TASK_PREVIEW_PAGE_EXPIRED"))
			.mockResolvedValueOnce(page("新首页"));
		await act(async () => root.render(<Harness />));
		await act(async () => latest.loadMore());
		expect(read).toHaveBeenCalledTimes(3);
		expect(read).toHaveBeenLastCalledWith(task, undefined, true);
		expect(latest.page?.entries.map((entry) => entry.title)).toEqual(["新首页"]);
	});
	it("重读失败保留旧内容并可显式重试；持续变化不会自动无限请求", async () => {
		read
			.mockResolvedValueOnce(page("保留首页", "expired"))
			.mockRejectedValueOnce(new Error("RELATED_TASK_PREVIEW_PAGE_EXPIRED"))
			.mockRejectedValueOnce(new Error("读取暂不可用"));
		await act(async () => root.render(<Harness />));
		await act(async () => latest.loadMore());
		expect(latest.page?.entries[0]?.title).toBe("保留首页");
		expect(latest.error).toContain("读取暂不可用");
		expect(read).toHaveBeenCalledTimes(3);
		read.mockResolvedValueOnce(page("恢复首页"));
		await act(async () => latest.retry());
		expect(latest.error).toBeNull();
		expect(latest.page?.entries[0]?.title).toBe("恢复首页");
	});
	it("换项目或一世后，旧请求迟到不能串入新卡", async () => {
		let finishOld: (value: GetDirectlyRelatedTaskPreviewPageResponse) => void = () => {};
		read
			.mockReturnValueOnce(
				new Promise((resolve) => {
					finishOld = resolve;
				}),
			)
			.mockResolvedValueOnce(page("新一世"));
		await act(async () => root.render(<Harness />));
		await act(async () =>
			root.render(<Harness subject={{ ...task, workspaceId: "project-b", taskIncarnationCreatedAtEpochMs: 2 }} />),
		);
		await act(async () => finishOld(page("旧一世")));
		expect(latest.page?.entries[0]?.title).toBe("新一世");
	});
});
