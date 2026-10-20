import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskRetainedCommittedLineChangeHistory } from "@/runtime/types";
import { TaskRetainedCommittedLineChangeIndicator } from "./task-retained-committed-line-change-indicator";

const fetchHistory = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/task-retained-committed-line-change-history-query", () => ({
	fetchTaskRetainedCommittedLineChangeHistory: fetchHistory,
}));
const history: RuntimeTaskRetainedCommittedLineChangeHistory = {
	summary: {
		status: "complete",
		commitCount: 1,
		additions: 123,
		deletions: 45,
		historyVersion: "test-history",
		unavailableReason: null,
	},
	commits: [
		{
			commitSha: "1234567890abcdef",
			subject: "任务提交标题",
			committedAtMs: 1_700_000_000_000,
			additions: 123,
			deletions: 45,
		},
	],
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	fetchHistory.mockReset();
	fetchHistory.mockResolvedValue(history);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});
function trigger(): HTMLButtonElement {
	const button = container.querySelector("button");
	if (!button) throw new Error("找不到累计指标");
	return button;
}

function createCommittedLineChangeIndicatorForTest(taskId: string, summary = history.summary) {
	return (
		<TaskRetainedCommittedLineChangeIndicator
			workspaceId="project-a"
			taskId={taskId}
			baseRef="main"
			summary={summary}
		/>
	);
}

describe("已提交累计指标", () => {
	it("总计常驻且仅在悬浮时读取明细，点击不打开宿主卡片", async () => {
		const openCard = vi.fn();
		act(() =>
			root.render(
				<div onClick={openCard} role="presentation">
					{createCommittedLineChangeIndicatorForTest("task-hover")}
				</div>,
			),
		);
		expect(trigger().textContent).toBe("已提交 +123 −45");
		expect(fetchHistory).not.toHaveBeenCalled();
		await act(async () => trigger().dispatchEvent(new Event("pointerover", { bubbles: true })));
		expect(document.body.textContent).toContain("任务提交标题");
		expect(fetchHistory).toHaveBeenCalledWith("project-a", { taskId: "task-hover", baseRef: "main" });
		act(() => trigger().click());
		expect(openCard).not.toHaveBeenCalled();
	});

	it("零值常驻，未知历史不显示为零", () => {
		act(() =>
			root.render(
				createCommittedLineChangeIndicatorForTest("task-zero", {
					...history.summary,
					additions: 0,
					deletions: 0,
					commitCount: 0,
				}),
			),
		);
		expect(trigger().textContent).toBe("已提交 +0 −0");
		act(() =>
			root.render(
				<TaskRetainedCommittedLineChangeIndicator workspaceId="project-a" taskId="task-zero" baseRef="main" />,
			),
		);
		expect(trigger().textContent).toBe("已提交 —");
	});

	it("支持触屏点击，加载失败可重试", async () => {
		fetchHistory.mockRejectedValueOnce(new Error("离线"));
		act(() => root.render(createCommittedLineChangeIndicatorForTest("task-retry")));
		await act(async () => trigger().click());
		expect(document.body.textContent).toContain("明细加载失败");
		const retryButton = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "重试");
		expect(retryButton).toBeDefined();
		await act(async () => retryButton?.click());
		expect(document.body.textContent).toContain("任务提交标题");
		expect(fetchHistory).toHaveBeenCalledTimes(2);
	});

	it.each(["ArrowDown", "Enter"])("键盘 %s 进入明细后，Escape 关闭并恢复按钮焦点", async (key) => {
		act(() => root.render(createCommittedLineChangeIndicatorForTest("task-keyboard")));
		await act(async () => trigger().focus());
		act(() => trigger().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
		expect(document.activeElement?.getAttribute("aria-label")).toBe("任务已提交增删行明细");
		await act(async () =>
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger());
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
	});

	it("悬浮展开和移出关闭都保留外部焦点", async () => {
		vi.useFakeTimers();
		try {
			act(() =>
				root.render(
					<>
						{createCommittedLineChangeIndicatorForTest("task-hover-focus")}
						<button type="button">外部操作</button>
					</>,
				),
			);
			const outsideButton = container.querySelectorAll("button")[1];
			if (!outsideButton) throw new Error("找不到外部按钮");
			act(() => outsideButton.focus());
			await act(async () => trigger().dispatchEvent(new Event("pointerover", { bubbles: true })));
			expect(document.querySelector('[role="dialog"]')).not.toBeNull();
			expect(document.activeElement).toBe(outsideButton);
			await act(async () =>
				outsideButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
			);
			expect(document.querySelector('[role="dialog"]')).toBeNull();
			expect(document.activeElement).toBe(outsideButton);
			await act(async () => trigger().dispatchEvent(new Event("pointerover", { bubbles: true })));
			act(() => trigger().dispatchEvent(new Event("pointerout", { bubbles: true })));
			await act(async () => vi.advanceTimersByTime(200));
			expect(document.querySelector('[role="dialog"]')).toBeNull();
			expect(document.activeElement).toBe(outsideButton);
		} finally {
			vi.useRealTimers();
		}
	});

	it("点击外部关闭明细后保留外部按钮焦点", async () => {
		act(() =>
			root.render(
				<>
					{createCommittedLineChangeIndicatorForTest("task-outside-focus")}
					<button type="button">外部操作</button>
				</>,
			),
		);
		await act(async () => trigger().focus());
		act(() => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(document.activeElement?.getAttribute("aria-label")).toBe("任务已提交增删行明细");
		const outsideButton = container.querySelectorAll("button")[1];
		if (!outsideButton) throw new Error("找不到外部按钮");
		await act(async () => {
			outsideButton.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			outsideButton.focus();
			outsideButton.click();
		});
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(outsideButton);
	});
});
