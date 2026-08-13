import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationLogDialog } from "@/components/notification-log-dialog";
import {
	buildNotificationEntriesSortedByTriggeredAtDescending,
	buildNotificationGroups,
} from "@/hooks/use-notification-center";
import type { RuntimeNotificationFeedEntry } from "@/runtime/types";

type ActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function entry(
	overrides: Partial<RuntimeNotificationFeedEntry> & { taskId: string; triggeredAt: number },
): RuntimeNotificationFeedEntry {
	return {
		id: `${overrides.taskId}:${overrides.triggeredAt}`,
		workspaceId: "ws-a",
		repoName: "repo-a",
		taskTitle: "Task A",
		userTurnKind: "review",
		visitedAt: null,
		isDone: false,
		...overrides,
	};
}

// 一份覆盖三种状态的历史：未读非 done / 已读非 done / 已读且 done（历史视图必须三者都看得见）。
const NOTIFICATION_LOG_BY_WORKSPACE_ID: Record<string, RuntimeNotificationFeedEntry[]> = {
	"ws-a": [
		entry({ taskId: "t-oldest-read", triggeredAt: 1, taskTitle: "Oldest read task", visitedAt: 100 }),
		entry({ taskId: "t-done", triggeredAt: 2, taskTitle: "Done task", visitedAt: 200, isDone: true }),
	],
	"ws-b": [
		entry({
			taskId: "t-newest-unread",
			triggeredAt: 3,
			workspaceId: "ws-b",
			repoName: "repo-b",
			taskTitle: "Newest unread task",
			userTurnKind: "question",
		}),
	],
};

describe("NotificationLogDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	function renderDialog(
		overrides: {
			notificationLogByWorkspaceId?: Record<string, RuntimeNotificationFeedEntry[]>;
			onOpenChange?: (open: boolean) => void;
			onFocusTask?: (workspaceId: string, taskId: string) => void;
			onMarkGroupVisited?: (workspaceId: string, taskId: string) => void;
			onMarkAllHistoryVisited?: () => void;
		} = {},
	): void {
		const log = overrides.notificationLogByWorkspaceId ?? NOTIFICATION_LOG_BY_WORKSPACE_ID;
		act(() => {
			root.render(
				<NotificationLogDialog
					open
					onOpenChange={overrides.onOpenChange ?? (() => {})}
					groups={buildNotificationGroups(log)}
					entriesSortedByTriggeredAtDescending={buildNotificationEntriesSortedByTriggeredAtDescending(log)}
					onFocusTask={overrides.onFocusTask ?? (() => {})}
					onMarkGroupVisited={overrides.onMarkGroupVisited ?? (() => {})}
					onMarkAllHistoryVisited={overrides.onMarkAllHistoryVisited ?? (() => {})}
					onClearAll={() => {}}
				/>,
			);
		});
	}

	function queryButtonByText(text: string): HTMLButtonElement | undefined {
		return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
	}

	function requireButtonByText(text: string): HTMLButtonElement {
		const button = queryButtonByText(text);
		if (!button) {
			throw new Error(`Expected a button labelled "${text}".`);
		}
		return button;
	}

	function clickButtonByText(text: string): void {
		act(() => {
			requireButtonByText(text).click();
		});
	}

	beforeEach(() => {
		previousActEnvironment = (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		}
	});

	it("默认按时间流排列，已读条目与 done 条目一并按 triggeredAt 降序展示", () => {
		renderDialog();

		const timeStreamTab = requireButtonByText("时间流");
		expect(timeStreamTab.getAttribute("aria-selected")).toBe("true");
		expect(requireButtonByText("按 task 分组").getAttribute("aria-selected")).toBe("false");

		const rowTitles = Array.from(document.body.querySelectorAll("p[title]")).map((node) =>
			node.getAttribute("title"),
		);
		expect(rowTitles).toEqual(["repo-b · Newest unread task", "repo-a · Done task", "repo-a · Oldest read task"]);

		const bodyText = document.body.textContent ?? "";
		expect(bodyText).toContain("未读");
		expect(bodyText).toContain("已读");
		expect(bodyText).toContain("Done");
	});

	it("切到「按 task 分组」后同一批数据按组呈现，组间按各组最新通知时间降序", () => {
		renderDialog();
		clickButtonByText("按 task 分组");

		expect(requireButtonByText("按 task 分组").getAttribute("aria-selected")).toBe("true");
		// 分组视图的组头是可点击按钮，按钮文本以 taskTitle 开头。
		const groupHeaderTitles = Array.from(document.body.querySelectorAll('[role="dialog"] button'))
			.map((button) => button.querySelector("span")?.textContent?.trim())
			.filter((text): text is string => Boolean(text) && text !== "时间流" && text !== "按 task 分组");
		expect(groupHeaderTitles).toEqual(["Newest unread task", "Done task", "Oldest read task"]);
	});

	it("点已读条目只跳转并关闭弹窗；点未读条目额外标记整组已读", () => {
		const onFocusTask = vi.fn();
		const onMarkGroupVisited = vi.fn();
		const onOpenChange = vi.fn();
		renderDialog({ onFocusTask, onMarkGroupVisited, onOpenChange });

		const rowButtons = Array.from(document.body.querySelectorAll('[role="dialog"] button')).filter((button) =>
			button.querySelector("p[title]"),
		);
		const [newestUnreadRow, , oldestReadRow] = rowButtons;

		act(() => {
			(oldestReadRow as HTMLButtonElement | undefined)?.click();
		});
		expect(onFocusTask.mock.calls).toEqual([["ws-a", "t-oldest-read"]]);
		expect(onMarkGroupVisited).not.toHaveBeenCalled();
		expect(onOpenChange.mock.calls).toEqual([[false]]);

		act(() => {
			(newestUnreadRow as HTMLButtonElement | undefined)?.click();
		});
		expect(onMarkGroupVisited.mock.calls).toEqual([["ws-b", "t-newest-unread"]]);
		expect(onFocusTask.mock.calls).toEqual([
			["ws-a", "t-oldest-read"],
			["ws-b", "t-newest-unread"],
		]);
	});

	it("「全部已读」有未读时可点、全部已读后禁用", () => {
		const onMarkAllHistoryVisited = vi.fn();
		renderDialog({ onMarkAllHistoryVisited });

		expect(requireButtonByText("全部已读").disabled).toBe(false);
		clickButtonByText("全部已读");
		expect(onMarkAllHistoryVisited).toHaveBeenCalledTimes(1);

		renderDialog({
			onMarkAllHistoryVisited,
			notificationLogByWorkspaceId: {
				"ws-a": [entry({ taskId: "t-read", triggeredAt: 1, visitedAt: 100 })],
			},
		});
		expect(requireButtonByText("全部已读").disabled).toBe(true);
	});

	it("无历史时两种排列各自给出对应空态文案", () => {
		renderDialog({ notificationLogByWorkspaceId: {} });
		expect(document.body.textContent).toContain("按时间倒序列出全部通知");

		clickButtonByText("按 task 分组");
		expect(document.body.textContent).toContain("按 task 分组列出全部通知");
	});
});
