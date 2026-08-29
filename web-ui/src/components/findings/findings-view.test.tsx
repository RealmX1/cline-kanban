import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsView } from "@/components/findings/findings-view";
import type { RuntimeExploratoryFindingEntry } from "@/runtime/types";

const { confirmMock, rejectMock, archiveMock, notifyErrorMock } = vi.hoisted(() => ({
	confirmMock: vi.fn(),
	rejectMock: vi.fn(),
	archiveMock: vi.fn(),
	notifyErrorMock: vi.fn(),
}));

vi.mock("@/runtime/findings-query", () => ({
	confirmExploratoryFinding: confirmMock,
	rejectExploratoryFinding: rejectMock,
	archiveExploratoryFinding: archiveMock,
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: vi.fn(),
}));

function createFinding(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
	return {
		findingId: "finding-1",
		findingTitle: "存储方案 SQLite",
		findingBodyMarkdown: "单文件就够，别上 Postgres",
		findingStatus: "active",
		supersededByFindingId: null,
		findingGenerationSource: "user_saved",
		provenanceLinks: [
			{
				linkKind: "turn_anchor",
				conversationSessionTaskId: "session-1",
				turnNumber: 2,
				turnCheckpointCommit: "commit-2",
			},
		],
		originConversationSessionTaskId: "session-1",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function findButtonByText(text: string): HTMLButtonElement | null {
	return (Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FindingsView", () => {
	let container: HTMLDivElement;
	let root: Root;

	async function renderView(props: Partial<Parameters<typeof FindingsView>[0]> = {}): Promise<void> {
		await act(async () => {
			root.render(<FindingsView workspaceId="workspace-1" findings={[]} queryPhase="ready" {...props} />);
		});
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		confirmMock.mockReset();
		rejectMock.mockReset();
		archiveMock.mockReset();
		notifyErrorMock.mockReset();
		confirmMock.mockImplementation(async () => ({ finding: null }));
		rejectMock.mockImplementation(async () => ({ removed: true }));
		archiveMock.mockImplementation(async () => ({ finding: null }));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("findings 未加载（null）时显示加载态", async () => {
		await renderView({ findings: null, queryPhase: "loading" });
		expect(container.querySelector("[class*=animate-spin]") ?? container.textContent).toBeTruthy();
		expect(container.textContent).not.toContain("No findings yet");
	});

	it("卡片显示标题 / 状态 badge / 正文摘要 / provenance 来源标注", async () => {
		await renderView({
			findings: [
				createFinding(),
				createFinding({
					findingId: "f-2",
					findingStatus: "suggested_pending_confirmation",
					findingTitle: "部署流水线",
				}),
			],
		});
		expect(container.textContent).toContain("存储方案 SQLite");
		expect(container.textContent).toContain("Active");
		expect(container.textContent).toContain("Pending confirmation");
		expect(container.textContent).toContain("单文件就够");
		expect(container.textContent).toContain("Session session-1 · T2");
	});

	it("archived 默认不进列表，「显示已归档」开关放行", async () => {
		await renderView({
			findings: [
				createFinding(),
				createFinding({ findingId: "f-archived", findingStatus: "archived", findingTitle: "旧结论" }),
			],
		});
		expect(container.textContent).not.toContain("旧结论");
		await act(async () => {
			findButtonByText("Show archived")?.click();
		});
		expect(container.textContent).toContain("旧结论");
		expect(container.textContent).toContain("Archived");
	});

	it("搜索框按标题 + 正文 substring 过滤", async () => {
		await renderView({
			findings: [
				createFinding(),
				createFinding({ findingId: "f-2", findingTitle: "部署流水线", findingBodyMarkdown: "GitHub Actions" }),
			],
		});
		const searchInput = container.querySelector("input[aria-label='Search findings']") as HTMLInputElement | null;
		expect(searchInput).not.toBeNull();
		await act(async () => {
			setInputValue(searchInput!, "actions");
		});
		expect(container.textContent).toContain("部署流水线");
		expect(container.textContent).not.toContain("存储方案 SQLite");
		await act(async () => {
			setInputValue(searchInput!, "不存在的词");
		});
		expect(container.textContent).toContain("No findings match");
	});

	it("待确认条目的「确认」按钮 → confirmFinding", async () => {
		await renderView({
			findings: [createFinding({ findingId: "f-pending", findingStatus: "suggested_pending_confirmation" })],
		});
		await act(async () => {
			findButtonByText("Confirm")?.click();
		});
		expect(confirmMock).toHaveBeenCalledWith("workspace-1", "f-pending");
	});

	it("待确认条目的「拒绝」按钮 → rejectFinding", async () => {
		await renderView({
			findings: [createFinding({ findingId: "f-pending", findingStatus: "suggested_pending_confirmation" })],
		});
		await act(async () => {
			findButtonByText("Reject")?.click();
		});
		expect(rejectMock).toHaveBeenCalledWith("workspace-1", "f-pending");
	});

	it("active 条目的「归档」→ archiveFinding(archived=true)", async () => {
		await renderView({ findings: [createFinding({ findingId: "f-active" })] });
		await act(async () => {
			findButtonByText("Archive")?.click();
		});
		expect(archiveMock).toHaveBeenCalledWith("workspace-1", "f-active", true);
	});

	it("superseded 条目不渲染「归档」按钮（服务端状态机禁止归档 superseded，互链审计不经 archive 改写）", async () => {
		await renderView({
			findings: [
				createFinding({
					findingId: "f-superseded",
					findingStatus: "superseded",
					findingTitle: "已被取代的旧结论",
					supersededByFindingId: "f-active",
				}),
			],
		});
		expect(container.textContent).toContain("已被取代的旧结论");
		expect(container.textContent).toContain("Superseded");
		expect(findButtonByText("Archive")).toBeNull();
	});

	it("archived 条目的「恢复」→ archiveFinding(archived=false)", async () => {
		await renderView({
			findings: [createFinding({ findingId: "f-archived", findingStatus: "archived", findingTitle: "旧结论" })],
		});
		await act(async () => {
			findButtonByText("Show archived")?.click();
		});
		await act(async () => {
			findButtonByText("Restore")?.click();
		});
		expect(archiveMock).toHaveBeenCalledWith("workspace-1", "f-archived", false);
	});

	it("操作失败 toast 报错（notifyError）", async () => {
		confirmMock.mockImplementation(async () => {
			throw new Error("状态机违规");
		});
		await renderView({
			findings: [createFinding({ findingId: "f-pending", findingStatus: "suggested_pending_confirmation" })],
		});
		await act(async () => {
			findButtonByText("Confirm")?.click();
		});
		expect(notifyErrorMock).toHaveBeenCalledWith("状态机违规");
	});

	it("空集合显示引导文案", async () => {
		await renderView({ findings: [] });
		expect(container.textContent).toContain("No findings yet");
	});
});
