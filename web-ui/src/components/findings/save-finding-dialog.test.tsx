import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { SaveFindingDialog } from "@/components/findings/save-finding-dialog";
import type { RuntimeExploratoryFindingEntry, RuntimeSaveExploratoryFindingRequest } from "@/runtime/types";

const { saveFindingMock, showAppToastMock } = vi.hoisted(() => ({
	saveFindingMock: vi.fn(),
	showAppToastMock: vi.fn(),
}));

vi.mock("@/runtime/findings-query", () => ({
	saveExploratoryFinding: saveFindingMock,
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
	notifyError: vi.fn(),
}));

function createFinding(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
	return {
		findingId: "finding-1",
		findingTitle: "存储方案 SQLite",
		findingBodyMarkdown: "正文",
		findingStatus: "active",
		supersededByFindingId: null,
		findingGenerationSource: "user_saved",
		provenanceLinks: [
			{
				linkKind: "turn_anchor",
				conversationSessionTaskId: "session-1",
				turnNumber: 1,
				turnCheckpointCommit: null,
			},
		],
		originConversationSessionTaskId: "session-1",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
	descriptor?.set?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButtonByText(text: string): HTMLButtonElement | null {
	return (Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) ??
		null) as HTMLButtonElement | null;
}

describe("SaveFindingDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let onCloseMock: Mock<() => void>;

	function renderDialog(props: Partial<Parameters<typeof SaveFindingDialog>[0]> = {}): void {
		act(() => {
			root.render(
				<SaveFindingDialog
					workspaceId="workspace-1"
					conversationSessionTaskId="session-1"
					anchor={{ turnNumber: 3, turnCheckpointCommit: "commit-3" }}
					initialBodyMarkdown="预填的正文摘录"
					existingFindings={[]}
					onClose={onCloseMock}
					{...props}
				/>,
			);
		});
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onCloseMock = vi.fn<() => void>();
		saveFindingMock.mockReset();
		saveFindingMock.mockImplementation(async () => ({ finding: createFinding() }));
		showAppToastMock.mockReset();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("预填正文进 textarea；锚 caption 标注 turn 号", () => {
		renderDialog();
		const textarea = document.body.querySelector("textarea");
		expect(textarea?.value).toBe("预填的正文摘录");
		expect(document.body.textContent).toContain("Anchored to turn T3");
	});

	it("无锚（null）→ 明示 freeform 降级 caption", () => {
		renderDialog({ anchor: null });
		expect(document.body.textContent).toContain("freeform note");
		expect(document.body.textContent).not.toContain("Anchored to turn");
	});

	it("标题为空时保存按钮禁用", () => {
		renderDialog();
		const saveButton = findButtonByText("Save finding");
		expect(saveButton).not.toBeNull();
		expect(saveButton?.disabled).toBe(true);
	});

	it("相似标题警告：规范化标题相等/前缀包含即提示，但不阻断保存", async () => {
		renderDialog({ existingFindings: [createFinding({ findingTitle: "存储方案: SQLite 单文件" })] });
		const titleInput = document.body.querySelector("#save-finding-title") as HTMLInputElement | null;
		expect(titleInput).not.toBeNull();
		await act(async () => {
			setInputValue(titleInput!, "存储方案 SQLite");
		});
		expect(document.body.textContent).toContain("A similar finding already exists: 存储方案: SQLite 单文件");
		// 警告不阻断：保存按钮仍可用。
		expect(findButtonByText("Save finding")?.disabled).toBe(false);
	});

	it("保存：mutation 参数携带锚三元 provenance 与 UI 生成 findingId；成功后 toast + 关 dialog", async () => {
		renderDialog();
		const titleInput = document.body.querySelector("#save-finding-title") as HTMLInputElement;
		await act(async () => {
			setInputValue(titleInput, "  存储方案定了  ");
		});
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		expect(saveFindingMock).toHaveBeenCalledTimes(1);
		const [workspaceId, request] = saveFindingMock.mock.calls[0] as [string, RuntimeSaveExploratoryFindingRequest];
		expect(workspaceId).toBe("workspace-1");
		expect(typeof request.findingId).toBe("string");
		expect(request.findingId.length).toBeGreaterThan(0);
		expect(request.findingTitle).toBe("存储方案定了");
		expect(request.findingBodyMarkdown).toBe("预填的正文摘录");
		expect(request.provenanceLinks).toEqual([
			{
				linkKind: "turn_anchor",
				conversationSessionTaskId: "session-1",
				turnNumber: 3,
				turnCheckpointCommit: "commit-3",
			},
		]);
		expect(request.originConversationSessionTaskId).toBe("session-1");
		expect(showAppToastMock).toHaveBeenCalledWith({ intent: "success", message: "Finding saved" });
		expect(onCloseMock).toHaveBeenCalledTimes(1);
	});

	it("无锚保存：provenance 降级 user_authored_freeform（turnNumber/commit 置 null，绝不伪造锚）", async () => {
		renderDialog({ anchor: null });
		const titleInput = document.body.querySelector("#save-finding-title") as HTMLInputElement;
		await act(async () => {
			setInputValue(titleInput, "自由笔记");
		});
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		const [, request] = saveFindingMock.mock.calls[0] as [string, RuntimeSaveExploratoryFindingRequest];
		expect(request.provenanceLinks).toEqual([
			{
				linkKind: "user_authored_freeform",
				conversationSessionTaskId: "session-1",
				turnNumber: null,
				turnCheckpointCommit: null,
			},
		]);
	});

	it("正文被编辑后按编辑内容保存", async () => {
		renderDialog();
		const titleInput = document.body.querySelector("#save-finding-title") as HTMLInputElement;
		const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			setInputValue(titleInput, "改过的标题");
			setTextareaValue(textarea, "改过的正文");
		});
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		const [, request] = saveFindingMock.mock.calls[0] as [string, RuntimeSaveExploratoryFindingRequest];
		expect(request.findingBodyMarkdown).toBe("改过的正文");
	});

	it("保存失败：留在对话框内联报错，不关 dialog 不 toast", async () => {
		saveFindingMock.mockImplementation(async () => {
			throw new Error("server exploded");
		});
		renderDialog();
		const titleInput = document.body.querySelector("#save-finding-title") as HTMLInputElement;
		await act(async () => {
			setInputValue(titleInput, "会失败的保存");
		});
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		expect(document.body.textContent).toContain("server exploded");
		expect(onCloseMock).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("同一 dialog 会话内重试复用同一 findingId（服务端按 id 幂等去重的前提）", async () => {
		// 首次 mutation 按「已落盘但响应丢失」模拟（抛错），重试必须带同一 id，
		// 服务端才能按 id 幂等回现状而不是落成重复 finding。
		saveFindingMock.mockImplementationOnce(async () => {
			throw new Error("response lost");
		});
		renderDialog();
		const titleInput = document.body.querySelector("#save-finding-title") as HTMLInputElement;
		await act(async () => {
			setInputValue(titleInput, "重试同 id");
		});
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		expect(document.body.textContent).toContain("response lost");
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		expect(saveFindingMock).toHaveBeenCalledTimes(2);
		const [, firstRequest] = saveFindingMock.mock.calls[0] as [string, RuntimeSaveExploratoryFindingRequest];
		const [, retryRequest] = saveFindingMock.mock.calls[1] as [string, RuntimeSaveExploratoryFindingRequest];
		expect(retryRequest.findingId).toBe(firstRequest.findingId);
		expect(showAppToastMock).toHaveBeenCalledWith({ intent: "success", message: "Finding saved" });
	});

	it("首个请求发出后字段冻结：重试恒用首次载荷（服务端按 id 幂等回旧条目，改内容重试会静默丢失）", async () => {
		// 场景：首个 mutation 已落盘但响应丢失（抛错模拟）。服务端幂等语义是「同
		// findingId 已存在 → 忽略新 title/body、回旧条目」，而 UI 成功路径不读返回内容
		// ——若失败后允许改内容再重试，改动会被幂等吞掉却提示成功。故首次提交后字段
		// 只读，重试必须带首次快照。
		saveFindingMock.mockImplementationOnce(async () => {
			throw new Error("response lost");
		});
		renderDialog();
		const titleInput = document.body.querySelector("#save-finding-title") as HTMLInputElement;
		const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			setInputValue(titleInput, "首次标题");
		});
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		expect(document.body.textContent).toContain("response lost");
		// UI 防线：失败后字段只读，并明示「想改内容须关掉重开」。
		expect(titleInput.disabled).toBe(true);
		expect(textarea.disabled).toBe(true);
		expect(document.body.textContent).toContain("Close and reopen the dialog to edit it.");
		// 快照防线：即使 state 被以任何方式改动，重试也必须用首次载荷。
		await act(async () => {
			setInputValue(titleInput, "篡改的标题");
			setTextareaValue(textarea, "篡改的正文");
		});
		await act(async () => {
			findButtonByText("Save finding")?.click();
		});
		expect(saveFindingMock).toHaveBeenCalledTimes(2);
		const [, firstRequest] = saveFindingMock.mock.calls[0] as [string, RuntimeSaveExploratoryFindingRequest];
		const [, retryRequest] = saveFindingMock.mock.calls[1] as [string, RuntimeSaveExploratoryFindingRequest];
		expect(retryRequest.findingId).toBe(firstRequest.findingId);
		expect(retryRequest.findingTitle).toBe("首次标题");
		expect(retryRequest.findingBodyMarkdown).toBe("预填的正文摘录");
	});
});
