import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFindingsSection } from "@/components/findings/session-findings-section";
import type { RuntimeExploratoryFindingEntry } from "@/runtime/types";

const { confirmFindingMock, rejectFindingMock, notifyErrorMock } = vi.hoisted(() => ({
	confirmFindingMock: vi.fn(),
	rejectFindingMock: vi.fn(),
	notifyErrorMock: vi.fn(),
}));

vi.mock("@/runtime/findings-query", () => ({
	confirmExploratoryFinding: confirmFindingMock,
	rejectExploratoryFinding: rejectFindingMock,
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: vi.fn(),
}));

function createFinding(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
	return {
		findingId: "finding-1",
		findingTitle: "本会话的结论",
		findingBodyMarkdown: "结论正文全文",
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

// 「本会话 findings」section（蓝图 §G.2）：切片过滤、待确认角标与行内动作、展开正文、加载态。
describe("SessionFindingsSection", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		confirmFindingMock.mockReset();
		rejectFindingMock.mockReset();
		notifyErrorMock.mockReset();
		confirmFindingMock.mockImplementation(async () => ({ finding: null }));
		rejectFindingMock.mockImplementation(async () => ({ removed: true }));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	async function renderSection(findings: RuntimeExploratoryFindingEntry[] | null): Promise<void> {
		await act(async () => {
			root.render(
				<SessionFindingsSection
					workspaceId="workspace-1"
					conversationSessionTaskId="session-1"
					findings={findings}
				/>,
			);
		});
	}

	async function expandSection(): Promise<void> {
		const sectionButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Findings"),
		);
		expect(sectionButton).toBeDefined();
		await act(async () => {
			sectionButton?.click();
		});
	}

	it("默认折叠：只渲染 header", async () => {
		await renderSection([createFinding()]);
		expect(container.textContent).toContain("Findings");
		expect(container.textContent).not.toContain("本会话的结论");
	});

	it("切片只含 provenanceLinks 命中当前会话的条目；archived 不进切片", async () => {
		await renderSection([
			createFinding({ findingId: "f-1", findingTitle: "本会话结论甲" }),
			createFinding({
				findingId: "f-2",
				findingTitle: "别的会话结论",
				provenanceLinks: [
					{
						linkKind: "turn_anchor",
						conversationSessionTaskId: "session-2",
						turnNumber: 1,
						turnCheckpointCommit: null,
					},
				],
			}),
			createFinding({ findingId: "f-3", findingStatus: "archived", findingTitle: "已归档的旧结论" }),
		]);
		await expandSection();
		expect(container.textContent).toContain("本会话结论甲");
		expect(container.textContent).not.toContain("别的会话结论");
		expect(container.textContent).not.toContain("已归档的旧结论");
	});

	it("待确认条目带角标（header 计数 + 行 badge）与行内确认/拒绝按钮", async () => {
		await renderSection([
			createFinding({
				findingId: "f-pending",
				findingStatus: "suggested_pending_confirmation",
				findingTitle: "待确认建议",
			}),
		]);
		// header 角标在折叠态也可见。
		expect(container.textContent).toContain("1 to confirm");
		await expandSection();
		expect(container.textContent).toContain("Pending confirmation");

		await act(async () => {
			(
				container.querySelector("button[aria-label='Confirm finding 待确认建议']") as HTMLButtonElement | null
			)?.click();
		});
		expect(confirmFindingMock).toHaveBeenCalledWith("workspace-1", "f-pending");
		await act(async () => {
			(
				container.querySelector("button[aria-label='Reject finding 待确认建议']") as HTMLButtonElement | null
			)?.click();
		});
		expect(rejectFindingMock).toHaveBeenCalledWith("workspace-1", "f-pending");
	});

	it("确认/拒绝失败时 toast 报错（notifyError）", async () => {
		confirmFindingMock.mockImplementation(async () => {
			throw new Error("状态机违规");
		});
		await renderSection([
			createFinding({
				findingId: "f-pending",
				findingStatus: "suggested_pending_confirmation",
				findingTitle: "待确认建议",
			}),
		]);
		await expandSection();
		await act(async () => {
			(
				container.querySelector("button[aria-label='Confirm finding 待确认建议']") as HTMLButtonElement | null
			)?.click();
		});
		expect(notifyErrorMock).toHaveBeenCalledWith("状态机违规");
	});

	it("点击条目展开正文（简单展开，不做深链跳转）", async () => {
		await renderSection([createFinding({ findingTitle: "本会话结论甲" })]);
		await expandSection();
		expect(container.textContent).not.toContain("结论正文全文");
		const rowButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("本会话结论甲"),
		);
		expect(rowButton).toBeDefined();
		await act(async () => {
			rowButton?.click();
		});
		expect(container.textContent).toContain("结论正文全文");
	});

	it("findings 未加载（null）时 section 显示加载态", async () => {
		await renderSection(null);
		await expandSection();
		expect(container.textContent).toContain("Loading findings…");
	});
});
