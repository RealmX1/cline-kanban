import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskConversationHistory } from "@/hooks/use-task-conversation-history";
import type { RuntimeTaskConversationHistoryPageResponse } from "@/runtime/types";

const fetchPage = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/task-conversation-history-query", () => ({ fetchTaskConversationHistoryPage: fetchPage }));
type History = ReturnType<typeof useTaskConversationHistory>;
let captured: History;
const globalThisWithReactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
function Harness({
	workspaceId,
	sessionId = "main",
	stable = false,
	bindingKey,
}: {
	workspaceId: string;
	sessionId?: string;
	stable?: boolean;
	bindingKey?: string;
}) {
	captured = useTaskConversationHistory({
		workspaceId,
		workspaceTaskId: "task",
		taskConversationSessionId: sessionId,
		...(stable ? { transcriptReadConsistency: "stable_snapshot" as const } : {}),
		nativeTranscriptBindingKey: bindingKey,
	});
	return <div>{captured.page?.messages.map((message) => message.content).join("|")}</div>;
}
function page(content: string, nextCursor: string | null = null): RuntimeTaskConversationHistoryPageResponse {
	return {
		availability: "available",
		messages: [{ id: content, role: "assistant", content, createdAt: 1 }],
		nextCursor,
		notice: null,
	};
}
describe("只读历史分页与查询归属", () => {
	let root: Root;
	let container: HTMLDivElement;
	let previousActEnvironment: boolean | undefined;
	beforeEach(() => {
		previousActEnvironment = globalThisWithReactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
		globalThisWithReactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		root = createRoot(container);
		fetchPage.mockReset();
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.useRealTimers();
		globalThisWithReactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});
	it("读取最新页后可以加载更早记录，保持时间顺序", async () => {
		fetchPage.mockResolvedValueOnce(page("最新", "older")).mockResolvedValueOnce(page("更早"));
		await act(async () => root.render(<Harness workspaceId="project" />));
		await act(async () => captured.loadOlder());
		expect(container.textContent).toBe("更早|最新");
		expect(fetchPage).toHaveBeenLastCalledWith("project", {
			workspaceTaskId: "task",
			taskConversationSessionId: "main",
			cursor: "older",
		});
	});
	it("切项目立即清空旧消息，迟到响应不能串入同号任务", async () => {
		let resolveOld: (response: RuntimeTaskConversationHistoryPageResponse) => void = () => {};
		fetchPage.mockReturnValueOnce(
			new Promise<RuntimeTaskConversationHistoryPageResponse>((resolve) => {
				resolveOld = resolve;
			}),
		);
		await act(async () => root.render(<Harness workspaceId="old" />));
		fetchPage.mockResolvedValueOnce(page("新项目"));
		await act(async () => root.render(<Harness workspaceId="new" />));
		await act(async () => resolveOld(page("旧项目")));
		expect(container.textContent).toBe("新项目");
	});
	it("早页读取失败保留已读内容，刷新后可以重试", async () => {
		fetchPage.mockResolvedValueOnce(page("已读", "older")).mockRejectedValueOnce(new Error("读取失败"));
		await act(async () => root.render(<Harness workspaceId="project" />));
		await act(async () => captured.loadOlder());
		expect(container.textContent).toBe("已读");
		expect(captured.error).toBe("读取失败");
		fetchPage.mockResolvedValueOnce(page("重新读取"));
		await act(async () => captured.refresh());
		expect(container.textContent).toBe("重新读取");
	});
	it("刷新失败保留已加载内容", async () => {
		fetchPage.mockResolvedValueOnce(page("已读")).mockRejectedValueOnce(new Error("读取失败"));
		await act(async () => root.render(<Harness workspaceId="project" />));
		await act(async () => captured.refresh());
		expect(container.textContent).toBe("已读");
		expect(captured.error).toBe("读取失败");
	});
	it("稳定快照的临时错误最多自动重试两次，身份错误不重试", async () => {
		vi.useFakeTimers();
		fetchPage.mockRejectedValue(new Error("临时连接失败"));
		await act(async () => root.render(<Harness workspaceId="project" stable />));
		await act(async () => vi.runAllTimersAsync());
		expect(fetchPage).toHaveBeenCalledTimes(3);
		expect(captured.error).toBe("临时连接失败");
		fetchPage.mockReset().mockResolvedValue({
			...page(""),
			messages: [],
			availability: "unavailable",
			unavailabilityReason: "identity_mismatch",
			notice: "身份不符",
		});
		await act(async () => captured.refresh());
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});
	it("首次缺少绑定时，绑定就绪后自动补读；已成功的快照不随绑定观测刷新", async () => {
		fetchPage.mockResolvedValueOnce({
			...page(""),
			messages: [],
			availability: "unavailable",
			unavailabilityReason: "binding_pending",
			notice: "等待绑定",
		});
		await act(async () => root.render(<Harness workspaceId="project" stable bindingKey="missing" />));
		fetchPage.mockResolvedValueOnce(page("绑定后正文"));
		await act(async () => root.render(<Harness workspaceId="project" stable bindingKey="ready" />));
		expect(container.textContent).toBe("绑定后正文");
		await act(async () => root.render(<Harness workspaceId="project" stable bindingKey="observed-again" />));
		expect(fetchPage).toHaveBeenCalledTimes(2);
	});
	it("切换会话后拒绝旧会话迟到的分页", async () => {
		fetchPage.mockResolvedValueOnce(page("主会话", "older"));
		await act(async () => root.render(<Harness workspaceId="project" />));
		let resolveOlder: (response: RuntimeTaskConversationHistoryPageResponse) => void = () => {};
		fetchPage.mockReturnValueOnce(
			new Promise<RuntimeTaskConversationHistoryPageResponse>((resolve) => {
				resolveOlder = resolve;
			}),
		);
		act(() => {
			void captured.loadOlder();
		});
		fetchPage.mockResolvedValueOnce(page("侧会话"));
		await act(async () => root.render(<Harness workspaceId="project" sessionId="side" />));
		await act(async () => resolveOlder(page("旧分页")));
		expect(container.textContent).toBe("侧会话");
	});
});
