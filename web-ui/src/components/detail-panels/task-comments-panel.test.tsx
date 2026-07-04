import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCommentsPanel } from "@/components/detail-panels/task-comments-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskCommentEntry } from "@/types";

function renderPanel(root: Root, panel: ReactElement): void {
	root.render(<TooltipProvider>{panel}</TooltipProvider>);
}

function setControlledTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) {
		throw new Error("Expected textarea value setter");
	}
	setter.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function CommentsHarness(): React.ReactElement {
	const [entries, setEntries] = useState<TaskCommentEntry[]>([]);
	return <TaskCommentsPanel taskCommentEntries={entries} onTaskCommentEntriesChange={setEntries} />;
}

describe("TaskCommentsPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let scrollHeightSpy: ReturnType<typeof vi.spyOn> | null;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		scrollHeightSpy = null;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		scrollHeightSpy?.mockRestore();
		vi.restoreAllMocks();
		act(() => {
			root.unmount();
		});
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
			renderPanel(root, <TaskCommentsPanel taskCommentEntries={[]} onTaskCommentEntriesChange={onChange} />);
		});

		const textarea = container.querySelector("textarea");
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		if (!(textarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected new comment textarea.");
		}

		await act(async () => {
			setControlledTextareaValue(textarea, "Remember this");
		});

		await act(async () => {
			textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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
			renderPanel(
				root,
				<TaskCommentsPanel taskCommentEntries={existingCommentEntries} onTaskCommentEntriesChange={onChange} />,
			);
		});

		const textareas = container.querySelectorAll("textarea");
		const editTextarea = textareas[1];
		expect(editTextarea).toBeInstanceOf(HTMLTextAreaElement);
		if (!(editTextarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected edit comment textarea.");
		}

		await act(async () => {
			setControlledTextareaValue(editTextarea, "After");
		});

		await act(async () => {
			editTextarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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

	it("focuses the saved comment entry after adding it", async () => {
		await act(async () => {
			renderPanel(root, <CommentsHarness />);
		});

		const newCommentTextarea = container.querySelector<HTMLTextAreaElement>(
			'textarea[placeholder="Write a task comment..."]',
		);
		expect(newCommentTextarea).toBeInstanceOf(HTMLTextAreaElement);
		if (!(newCommentTextarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected new comment textarea.");
		}

		await act(async () => {
			setControlledTextareaValue(newCommentTextarea, "Investigate the validation edge case.");
		});
		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent?.trim() === "Add comment")
				?.click();
		});

		const savedCommentTextarea = container.querySelector<HTMLTextAreaElement>(
			'textarea[placeholder="Edit task comment..."]',
		);
		expect(savedCommentTextarea).toBeInstanceOf(HTMLTextAreaElement);
		expect(document.activeElement).toBe(savedCommentTextarea);
	});

	it("collapses long unfocused comment entries without enabling textarea scrolling", async () => {
		scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(220);

		await act(async () => {
			renderPanel(
				root,
				<TaskCommentsPanel
					taskCommentEntries={[
						{
							taskCommentEntryId: "comment-1",
							commentText: ["one", "two", "three", "four", "five", "six"].join("\n"),
							createdAt: 100,
							updatedAt: 100,
						},
					]}
					onTaskCommentEntriesChange={() => {}}
				/>,
			);
		});

		const savedCommentTextarea = container.querySelector<HTMLTextAreaElement>(
			'textarea[placeholder="Edit task comment..."]',
		);
		expect(savedCommentTextarea).toBeInstanceOf(HTMLTextAreaElement);
		if (!(savedCommentTextarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected saved comment textarea.");
		}
		expect(savedCommentTextarea.style.overflowY).toBe("hidden");
		expect(savedCommentTextarea.style.height).not.toBe("220px");
		expect(container.querySelector('button[aria-label="Show full task comment"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("keeps the comment expand control mounted when the control receives focus", async () => {
		scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(220);

		await act(async () => {
			renderPanel(
				root,
				<TaskCommentsPanel
					taskCommentEntries={[
						{
							taskCommentEntryId: "comment-1",
							commentText: ["one", "two", "three", "four", "five", "six"].join("\n"),
							createdAt: 100,
							updatedAt: 100,
						},
					]}
					onTaskCommentEntriesChange={() => {}}
				/>,
			);
		});

		const expandButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show full task comment"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected comment expand button.");
		}

		await act(async () => {
			expandButton.focus();
		});

		expect(container.querySelector('button[aria-label="Show full task comment"]')).toBeInstanceOf(HTMLButtonElement);
	});
});
