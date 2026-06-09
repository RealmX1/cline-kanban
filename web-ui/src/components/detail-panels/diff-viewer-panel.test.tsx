import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import type { RuntimeWorkspaceFileChange } from "@/runtime/types";

const hotkeyRegistrations: Array<{
	keys: string;
	callback: (event: KeyboardEvent) => void;
}> = [];

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: (keys: string, callback: (event: KeyboardEvent) => void) => {
		hotkeyRegistrations.push({ keys, callback });
	},
}));

function createRect(top: number): DOMRect {
	return {
		x: 0,
		y: top,
		width: 600,
		height: 24,
		top,
		right: 600,
		bottom: top + 24,
		left: 0,
		toJSON: () => ({}),
	};
}

describe("DiffViewerPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		hotkeyRegistrations.length = 0;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("scrolls to the selected file using section position relative to the scroll container", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const a = 1;\n",
				newText: "const a = 2;\n",
			},
			{
				path: "src/b.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const b = 1;\n",
				newText: "const b = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>();

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		const sections = Array.from(container.querySelectorAll("section"));
		expect(sections).toHaveLength(2);

		const scrollContainer = sections[0]?.parentElement;
		expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
		if (!(scrollContainer instanceof HTMLDivElement)) {
			throw new Error("Expected a diff scroll container.");
		}

		Object.defineProperty(scrollContainer, "scrollTop", {
			configurable: true,
			writable: true,
			value: 200,
		});
		Object.defineProperty(scrollContainer, "clientTop", {
			configurable: true,
			value: 1,
		});
		Object.defineProperty(sections[1]!, "offsetTop", {
			configurable: true,
			value: 620,
		});

		vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue(createRect(100));
		vi.spyOn(sections[0]!, "getBoundingClientRect").mockReturnValue(createRect(140));
		vi.spyOn(sections[1]!, "getBoundingClientRect").mockReturnValue(createRect(460));

		const originalGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
			if (element === scrollContainer) {
				return Object.assign({}, originalGetComputedStyle(element), { paddingTop: "12px" }) as CSSStyleDeclaration;
			}
			return originalGetComputedStyle(element);
		});

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/b.ts"
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(scrollContainer.scrollTop).toBe(547);
	});

	it("re-expands a collapsed file when the same selectedPath is explicitly selected again via an incremented expand token", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const a = 1;\n",
				newText: "const a = 2;\n",
			},
			{
				path: "src/b.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const b = 1;\n",
				newText: "const b = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>();

		// 默认全部折叠：无 selectedPath、token 为 0。
		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					selectedPathExpandToken={0}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(container.querySelector(".kb-diff-row")).toBeNull();

		// 显式选中 src/b.ts（令牌递增）：应展开并渲染其 diff 行。
		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/b.ts"
					selectedPathExpandToken={1}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		const sectionsAfterExpand = Array.from(container.querySelectorAll("section"));
		expect(sectionsAfterExpand).toHaveLength(2);
		const bSectionExpanded = sectionsAfterExpand[1];
		expect(bSectionExpanded?.querySelector(".kb-diff-row")).toBeInstanceOf(HTMLDivElement);

		// 用文件头 chevron 折叠 src/b.ts，但 selectedPath 仍为 src/b.ts（复现「已高亮但折叠」状态）。
		const collapseButton = bSectionExpanded?.querySelector("button.kb-diff-file-header");
		expect(collapseButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			(collapseButton as HTMLButtonElement).click();
		});
		expect(bSectionExpanded?.querySelector(".kb-diff-row")).toBeNull();

		// 再次显式选中同一 selectedPath（仅令牌递增）：必须重新展开折叠的文件。
		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/b.ts"
					selectedPathExpandToken={2}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		const sectionsAfterReexpand = Array.from(container.querySelectorAll("section"));
		expect(sectionsAfterReexpand[1]?.querySelector(".kb-diff-row")).toBeInstanceOf(HTMLDivElement);
	});

	it("does not expand a scroll-synced selectedPath that arrives without an expand token change", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const a = 1;\n",
				newText: "const a = 2;\n",
			},
			{
				path: "src/b.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const b = 1;\n",
				newText: "const b = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>();

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					selectedPathExpandToken={0}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		const scrollContainer = container.querySelector("section")?.parentElement;
		if (!(scrollContainer instanceof HTMLDivElement)) {
			throw new Error("Expected a diff scroll container.");
		}

		// 模拟滚动联动：用户滚动折叠列表，顶部活动项被设为 selectedPath，但令牌不变（仍为 0）。
		await act(async () => {
			scrollContainer.dispatchEvent(new Event("scroll"));
		});
		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/b.ts"
					selectedPathExpandToken={0}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		// 令牌未变化 + 处于滚动联动窗口：只高亮、不展开，避免滚动浏览时级联展开。
		const bSection = Array.from(container.querySelectorAll("section"))[1];
		expect(bSection?.querySelector(".kb-diff-row")).toBeNull();
	});

	it("renders replaced lines side by side in split view", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/example.ts"
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
					viewMode="split"
				/>,
			);
		});

		const splitRows = Array.from(container.querySelectorAll(".kb-diff-split-grid-row"));
		expect(splitRows).toHaveLength(1);
		expect(splitRows[0]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-row-added")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-split-cell-placeholder")).toBeNull();
	});

	it("renders uneven split replacements with an empty placeholder cell", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 2,
				oldText: "const first = 1;\nconst second = 2;\n",
				newText: "const value = 2;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/example.ts"
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
					viewMode="split"
				/>,
			);
		});

		const splitRows = Array.from(container.querySelectorAll(".kb-diff-split-grid-row"));
		expect(splitRows).toHaveLength(2);
		expect(splitRows[0]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-row-added")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[1]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		const placeholderCell = splitRows[1]?.querySelector(".kb-diff-split-cell-right");
		expect(placeholderCell).toBeInstanceOf(HTMLDivElement);
		expect(placeholderCell?.classList.contains("kb-diff-split-cell-placeholder")).toBe(true);
		expect(placeholderCell?.childElementCount).toBe(0);
		expect(placeholderCell?.querySelector(".kb-diff-line-number")).toBeNull();
	});

	it("does not mark the last line changed when only the final newline differs", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 0,
				deletions: 0,
				oldText: "const value = 1;",
				newText: "const value = 1;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="src/example.ts"
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(container.querySelector(".kb-diff-row-added")).toBeNull();
		expect(container.querySelector(".kb-diff-row-removed")).toBeNull();
	});

	it("does not render diff rows for binary file paths", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "assets/logo.png",
				status: "modified",
				additions: 0,
				deletions: 0,
				oldText: "not real image data",
				newText: "still not real image data",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath="assets/logo.png"
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("assets/logo.png");
		expect(container.textContent).toContain("Binary");
		expect(container.querySelector(".kb-diff-row")).toBeNull();
	});

	it("shows shortcut indicators on Add and Send", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>([
			[
				"src/example.ts:added:1",
				{
					filePath: "src/example.ts",
					lineNumber: 1,
					lineText: "const value = 2;",
					variant: "added",
					comment: "Ship this",
				},
			],
		]);

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
					onAddToTerminal={() => {}}
					onSendToTerminal={() => {}}
				/>,
			);
		});

		const buttons = Array.from(container.querySelectorAll("button"));
		const addButton = buttons.find((button) => button.textContent?.includes("Add"));
		const sendButton = buttons.find((button) => button.textContent?.includes("Send"));

		expect(addButton).toBeDefined();
		expect(sendButton).toBeDefined();
		expect(container.querySelector("kbd")).toBeNull();
		expect(sendButton?.textContent).toContain("Shift");
		expect(addButton?.querySelectorAll("svg").length).toBeGreaterThan(0);
		expect(sendButton?.querySelectorAll("svg").length).toBeGreaterThan(0);
	});

	it("uses Cmd or Ctrl Enter to add comments and Cmd or Ctrl Shift Enter to send comments", async () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>([
			[
				"src/example.ts:added:1",
				{
					filePath: "src/example.ts",
					lineNumber: 1,
					lineText: "const value = 2;",
					variant: "added",
					comment: "Ship this",
				},
			],
		]);
		const onCommentsChange = vi.fn();
		const onAddToTerminal = vi.fn();
		const onSendToTerminal = vi.fn();

		await act(async () => {
			root.render(
				<DiffViewerPanel
					workspaceFiles={workspaceFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={onCommentsChange}
					onAddToTerminal={onAddToTerminal}
					onSendToTerminal={onSendToTerminal}
				/>,
			);
		});

		const enterHotkey = hotkeyRegistrations.find((registration) => registration.keys === "meta+enter,ctrl+enter");
		const sendHotkey = hotkeyRegistrations.find(
			(registration) => registration.keys === "meta+shift+enter,ctrl+shift+enter",
		);

		expect(enterHotkey).toBeDefined();
		expect(sendHotkey).toBeDefined();

		act(() => {
			enterHotkey?.callback(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
		});

		expect(onAddToTerminal).toHaveBeenCalledWith("src/example.ts:1 | const value = 2;\n> Ship this");
		expect(onCommentsChange).toHaveBeenCalledWith(new Map());

		onCommentsChange.mockClear();

		act(() => {
			sendHotkey?.callback(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true }));
		});

		expect(onSendToTerminal).toHaveBeenCalledWith("src/example.ts:1 | const value = 2;\n> Ship this");
		expect(onCommentsChange).toHaveBeenCalledWith(new Map());
	});
});
