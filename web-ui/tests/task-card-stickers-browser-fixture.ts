import type { RuntimeBoardCard } from "../../src/core/api-contract";

export function createTaskStickerBrowserFixtureCard(id: string): RuntimeBoardCard & { title: string } {
	return {
		id,
		title: `便签测试 ${id}`,
		prompt: "卡片正文保留在原位置",
		baseRef: "main",
		startInPlanMode: false,
		createdAt: 1,
		updatedAt: 2,
		taskStickerEntries: [
			{
				taskStickerEntryId: "first",
				stickerText: "第一张首行\n第一张完整正文",
				isCollapsed: false,
				createdAt: 10,
				updatedAt: 10,
			},
			{
				taskStickerEntryId: "second",
				stickerText: "第二张首行\n第二张完整正文",
				isCollapsed: false,
				createdAt: 11,
				updatedAt: 11,
			},
		],
	};
}
