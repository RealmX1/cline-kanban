import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskEditorDialog } from "@/components/task-editor-dialog";

type Props = ComponentProps<typeof TaskEditorDialog>;

function makeProps(overrides: Partial<Props> = {}): Props {
	return {
		open: true,
		onOpenChange: vi.fn(),
		taskEditorMode: "create",
		prompt: "",
		onPromptChange: vi.fn(),
		images: [],
		onImagesChange: vi.fn(),
		onCreate: vi.fn(() => null),
		onCreateMultiple: vi.fn(() => []),
		startInPlanMode: false,
		onStartInPlanModeChange: vi.fn(),
		autoReviewEnabled: false,
		onAutoReviewEnabledChange: vi.fn(),
		autoReviewMode: "commit",
		onAutoReviewModeChange: vi.fn(),
		workspaceId: "project-1",
		branchRef: "main",
		branchOptions: [{ value: "main", label: "main" }],
		onBranchRefChange: vi.fn(),
		worktreeMode: "branch",
		onWorktreeModeChange: vi.fn(),
		agents: [],
		defaultAgentId: "claude",
		...overrides,
	};
}

function findButtonByText(label: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === label) as
		| HTMLButtonElement
		| undefined;
}

function findCloseButton(): HTMLButtonElement | null {
	return document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]');
}

describe("TaskEditorDialog close guard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		// Radix + rich inputs touch a few DOM APIs jsdom does not implement.
		if (typeof globalThis.ResizeObserver === "undefined") {
			globalThis.ResizeObserver = class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			} as unknown as typeof ResizeObserver;
		}
		Element.prototype.scrollIntoView ??= () => {};
		Element.prototype.hasPointerCapture ??= () => false;
		Element.prototype.setPointerCapture ??= () => {};
		Element.prototype.releasePointerCapture ??= () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "{}",
			})),
		);

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function render(props: Props): Promise<void> {
		await act(async () => {
			root.render(<TaskEditorDialog {...props} />);
		});
	}

	it("closes immediately via the X button when the form has no edits", async () => {
		const onOpenChange = vi.fn();
		await render(makeProps({ onOpenChange, prompt: "" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(findButtonByText("Discard")).toBeUndefined();
	});

	it("asks for confirmation via the X button when the form has edits, and does not close until confirmed", async () => {
		const onOpenChange = vi.fn();
		// 打开时基线为空 prompt；随后受控地填入内容，模拟用户输入。
		await render(makeProps({ onOpenChange, prompt: "" }));
		await render(makeProps({ onOpenChange, prompt: "Fix the bug" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		// 有编辑 → 弹确认，不直接关闭
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText("Discard")).toBeDefined();
		expect(findButtonByText("Keep editing")).toBeDefined();

		await act(async () => {
			findButtonByText("Discard")?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("keeps the dialog open when the user chooses to keep editing", async () => {
		const onOpenChange = vi.fn();
		await render(makeProps({ onOpenChange, prompt: "" }));
		await render(makeProps({ onOpenChange, prompt: "Fix the bug" }));

		await act(async () => {
			findCloseButton()?.click();
		});
		expect(findButtonByText("Discard")).toBeDefined();

		await act(async () => {
			findButtonByText("Keep editing")?.click();
		});

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText("Discard")).toBeUndefined();
	});

	it("does NOT guard in edit mode: closes directly even with edits (edit close saves a draft)", async () => {
		const onOpenChange = vi.fn();
		// edit 模式：即便表单有改动，关闭也不弹「放弃」确认——直通 base 的关闭语义。
		await render(makeProps({ onOpenChange, taskEditorMode: "edit", prompt: "" }));
		await render(makeProps({ onOpenChange, taskEditorMode: "edit", prompt: "Edited body" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(findButtonByText("Discard")).toBeUndefined();
	});
});
