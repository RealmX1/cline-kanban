import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskOriginalPromptDialog } from "@/components/task-original-prompt-dialog";
import type { BoardCard } from "@/types";

const MULTILINE_PROMPT = "fix the bug:\n\n  - first step\n  - second step\n\nkeep   inner   spacing intact";

function createTask(overrides?: Partial<BoardCard>): BoardCard {
	return {
		id: "task-1",
		title: "Fix the bug",
		prompt: MULTILINE_PROMPT,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("TaskOriginalPromptDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let previousClipboardDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		previousClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousClipboardDescriptor) {
			Object.defineProperty(navigator, "clipboard", previousClipboardDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "clipboard");
		}
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders the full multi-line prompt verbatim", async () => {
		await act(async () => {
			root.render(<TaskOriginalPromptDialog open card={createTask()} onClose={() => {}} />);
		});

		const promptBlock = document.body.querySelector("pre");
		expect(promptBlock).not.toBeNull();
		expect(promptBlock?.textContent).toBe(MULTILINE_PROMPT);
	});

	it("copies the raw prompt text to the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		await act(async () => {
			root.render(<TaskOriginalPromptDialog open card={createTask()} onClose={() => {}} />);
		});

		const copyButton = Array.from(document.body.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Copy prompt",
		);
		expect(copyButton).toBeDefined();

		await act(async () => {
			copyButton?.click();
		});

		expect(writeText).toHaveBeenCalledExactlyOnceWith(MULTILINE_PROMPT);
	});

	it("结构化正文原样显示和复制，不执行标签也不解码实体", async () => {
		const structuredPrompt = [
			'<task-initial-prompt schema-version="1">',
			'  <task-original-user-request request-id="request-1" source-reference="synthetic:&quot;request-1&quot;">',
			'保留 &amp; &lt; &gt; "引号" 和 &lt;/task-original-user-request&gt;。',
			"  </task-original-user-request>",
			"</task-initial-prompt>",
		].join("\n");
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		await act(async () => {
			root.render(
				<TaskOriginalPromptDialog open card={createTask({ prompt: structuredPrompt })} onClose={() => {}} />,
			);
		});
		expect(document.body.querySelector("pre")?.textContent).toBe(structuredPrompt);
		expect(document.body.querySelector("task-initial-prompt")).toBeNull();
		const copyButton = Array.from(document.body.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Copy prompt",
		);
		expect(copyButton).toBeDefined();
		await act(async () => {
			copyButton?.click();
		});
		expect(writeText).toHaveBeenCalledExactlyOnceWith(structuredPrompt);
	});

	it("renders read-only image chips when the task has attached images", async () => {
		const card = createTask({
			images: [{ id: "image-1", data: "aGVsbG8=", mimeType: "image/png", name: "screenshot.png" }],
		});

		await act(async () => {
			root.render(<TaskOriginalPromptDialog open card={card} onClose={() => {}} />);
		});

		expect(document.body.textContent).toContain("Attached images");
		expect(document.body.textContent).toContain("screenshot.png");
		expect(document.body.querySelector('button[aria-label="Delete screenshot.png"]')).toBeNull();
	});
});
