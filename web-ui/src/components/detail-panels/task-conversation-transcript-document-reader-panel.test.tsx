import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskConversationTranscriptDocumentReaderPanel } from "@/components/detail-panels/task-conversation-transcript-document-reader-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskConversationHistoryPageResponse } from "@/runtime/types";
import {
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests,
	startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins,
	USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";

const { fetchPage, saveConfig } = vi.hoisted(() => ({ fetchPage: vi.fn(), saveConfig: vi.fn() }));
vi.mock("@/runtime/task-conversation-history-query", () => ({ fetchTaskConversationHistoryPage: fetchPage }));
vi.mock("@/runtime/runtime-config-query", () => ({
	fetchRuntimeConfig: async () => ({
		userInterfacePreferencesSharedAcrossBrowserOrigins:
			USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
	}),
	saveRuntimeConfig: saveConfig,
}));
const snapshot: RuntimeTaskConversationHistoryPageResponse = {
	availability: "available",
	nextCursor: "older",
	notice: null,
	messages: [
		{ id: "user", role: "user", content: "用户提问", createdAt: 1 },
		{ id: "assistant", role: "assistant", content: "回答正文", createdAt: 2 },
		{ id: "tool", role: "tool", content: "工具的完整输出", meta: { toolName: "exec_command" }, createdAt: 3 },
		{ id: "reasoning", role: "reasoning", content: "已经持久化的可读推理", createdAt: 4 },
		{ id: "system", role: "system", content: "系统记录", createdAt: 5 },
	],
};
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("原生会话转录文档", () => {
	let root: Root;
	let container: HTMLDivElement;
	let previousActEnvironment: boolean | undefined;
	const readerScrollRef = createRef<HTMLElement>() as { current: HTMLElement | null };
	async function render(isVisible = true, nativeTranscriptBindingKey?: string) {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<div hidden={!isVisible}>
						<TaskConversationTranscriptDocumentReaderPanel
							workspaceId="project"
							workspaceTaskId="host-task"
							taskConversationSessionId="side-session"
							nativeTranscriptBindingKey={nativeTranscriptBindingKey}
							isVisible={isVisible}
							scrollContainerRef={readerScrollRef}
						/>
					</div>
				</TooltipProvider>,
			),
		);
	}
	function click(label: string) {
		const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes(label));
		expect(button, label).toBeDefined();
		act(() => button?.click());
	}
	function visibleRoles() {
		return [...container.querySelectorAll<HTMLElement>("[data-history-message-role]")]
			.filter((element) => !element.hidden)
			.map((element) => element.dataset.historyMessageRole);
	}
	beforeEach(async () => {
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		fetchPage.mockReset().mockResolvedValue(snapshot);
		resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
		saveConfig.mockReset().mockImplementation(async (_workspace, input) => ({
			userInterfacePreferencesSharedAcrossBrowserOrigins: {
				...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				...input.userInterfacePreferencesSharedAcrossBrowserOrigins,
			},
		}));
		await act(async () => startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins());
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.useRealTimers();
		container.remove();
		resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});
	it("首次网络读取失败显示错误，不伪装成尚无记录", async () => {
		vi.useFakeTimers();
		fetchPage.mockRejectedValue(new Error("隔离网络错误"));
		await render();
		await act(async () => vi.runAllTimersAsync());
		expect(container.textContent).toContain("隔离网络错误");
		expect(container.textContent).not.toContain("尚无已持久化");
	});
	it("默认全部记录，工具与可读推理逐条折叠；三级可见度保存并保留展开状态", async () => {
		await render();
		expect(fetchPage).toHaveBeenCalledWith("project", {
			workspaceTaskId: "host-task",
			taskConversationSessionId: "side-session",
			cursor: null,
			transcriptReadConsistency: "stable_snapshot",
		});
		expect(visibleRoles()).toEqual(["user", "assistant", "tool", "reasoning", "system"]);
		expect(container.textContent).not.toContain("工具的完整输出");
		expect(container.textContent).not.toContain("已经持久化的可读推理");
		click("exec_command");
		click("可读推理");
		expect(container.textContent).toContain("工具的完整输出");
		expect(container.textContent).toContain("已经持久化的可读推理");
		const select = container.querySelector("select")!;
		for (const [value, roles] of [
			["conversation_only", ["user", "assistant"]],
			["conversation_and_tools", ["user", "assistant", "tool"]],
			["all_records", ["user", "assistant", "tool", "reasoning", "system"]],
		] as const) {
			await act(async () => {
				select.value = value;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
			expect(visibleRoles()).toEqual(roles);
		}
		expect(saveConfig).toHaveBeenLastCalledWith(null, {
			userInterfacePreferencesSharedAcrossBrowserOrigins: {
				taskConversationTranscriptDocumentVisibility: "all_records",
			},
		});
		expect(container.querySelector('[data-history-message-id="tool"] button')?.getAttribute("aria-expanded")).toBe(
			"true",
		);
	});
	it("搜索只筛选已加载记录，切回终端再返回保持快照、筛选、展开和阅读位置", async () => {
		await render();
		click("exec_command");
		const input = container.querySelector("input")!;
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "工具");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(visibleRoles()).toEqual(["tool"]);
		const scroller = readerScrollRef.current!;
		act(() => {
			scroller.scrollTop = 321;
			scroller.dispatchEvent(new Event("scroll"));
		});
		await render(false);
		await render(true);
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("工具");
		expect(scroller.scrollTop).toBe(321);
		expect(container.querySelector('[data-history-message-id="tool"] button')?.getAttribute("aria-expanded")).toBe(
			"true",
		);
	});
	it("加载早页按增加的高度保持阅读锚点，显式刷新换快照并定位末尾", async () => {
		await render();
		const scroller = readerScrollRef.current!;
		let height = 1000;
		Object.defineProperty(scroller, "scrollHeight", { get: () => height });
		Object.defineProperty(scroller, "clientHeight", { get: () => 200 });
		act(() => {
			scroller.scrollTop = 220;
			scroller.dispatchEvent(new Event("scroll"));
		});
		let resolveOlder: (page: RuntimeTaskConversationHistoryPageResponse) => void = () => {};
		fetchPage.mockReturnValueOnce(
			new Promise<RuntimeTaskConversationHistoryPageResponse>((resolve) => {
				resolveOlder = resolve;
			}),
		);
		click("加载更早记录");
		act(() => {
			scroller.scrollTop = 500;
			scroller.dispatchEvent(new Event("scroll"));
		});
		height = 1600;
		await act(async () =>
			resolveOlder({
				...snapshot,
				messages: [{ id: "older", role: "assistant", content: "更早记录", createdAt: 0 }],
				nextCursor: null,
			}),
		);
		expect(scroller.scrollTop).toBe(1100);
		expect(container.textContent).toContain("更早记录");
		fetchPage.mockResolvedValueOnce({
			...snapshot,
			messages: [{ id: "newest", role: "assistant", content: "新快照正文", createdAt: 6 }],
		});
		await act(async () => click("刷新到最新"));
		expect(container.querySelector('[data-history-message-id="older"]')).toBeNull();
		expect(container.textContent).toContain("新快照正文");
		expect(scroller.scrollTop).toBe(1600);
	});
	it("首次等待绑定不消耗定位末尾意图，自动补读成功后显示最新记录", async () => {
		fetchPage.mockResolvedValueOnce({
			availability: "unavailable",
			messages: [],
			nextCursor: null,
			notice: "等待绑定",
			unavailabilityReason: "binding_pending",
		});
		await render(true, "unbound");
		expect(container.textContent).toContain("等待绑定");
		const scroller = readerScrollRef.current!;
		Object.defineProperty(scroller, "scrollHeight", { get: () => 1600 });
		Object.defineProperty(scroller, "clientHeight", { get: () => 200 });
		await render(true, "bound");
		expect(fetchPage).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("回答正文");
		expect(scroller.scrollTop).toBe(1600);
	});
});
