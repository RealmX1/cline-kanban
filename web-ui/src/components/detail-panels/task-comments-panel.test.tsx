import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCommentsPanel } from "@/components/detail-panels/task-comments-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskCommentEntry } from "@/types";

function setControlledTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) {
		throw new Error("Expected textarea value setter");
	}
	setter.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TaskCommentsPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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

	it("adds a new task comment when the new comment textarea loses focus", async () => {
		const onChange = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskCommentsPanel taskCommentEntries={[]} onTaskCommentEntriesChange={onChange} />
				</TooltipProvider>,
			);
		});

		const textarea = container.querySelector("textarea");
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

		await act(async () => {
			if (!textarea) {
				throw new Error("expected textarea");
			}
			setControlledTextareaValue(textarea, "Remember this");
		});

		await act(async () => {
			textarea?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toMatchObject([{ commentText: "Remember this" }]);
	});

	it("updates an existing task comment when the edit textarea loses focus", async () => {
		const onChange = vi.fn();
		const existingCommentEntries: TaskCommentEntry[] = [
			{
				taskCommentEntryId: "comment-1",
				commentText: "Before",
				createdAt: 100,
				updatedAt: 100,
			},
		];

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskCommentsPanel taskCommentEntries={existingCommentEntries} onTaskCommentEntriesChange={onChange} />
				</TooltipProvider>,
			);
		});

		const textareas = container.querySelectorAll("textarea");
		const editTextarea = textareas[1];
		expect(editTextarea).toBeInstanceOf(HTMLTextAreaElement);

		await act(async () => {
			if (!editTextarea) {
				throw new Error("expected edit textarea");
			}
			setControlledTextareaValue(editTextarea, "After");
		});

		await act(async () => {
			editTextarea?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0]).toMatchObject([
			{
				taskCommentEntryId: "comment-1",
				commentText: "After",
				createdAt: 100,
			},
		]);
	});
});
