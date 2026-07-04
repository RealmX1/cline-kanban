import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptLibraryPanel } from "@/components/detail-panels/prompt-library-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocalStorageKey } from "@/storage/local-storage-store";

function renderPanel(root: Root, panel: ReactElement): void {
	root.render(<TooltipProvider>{panel}</TooltipProvider>);
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
	);
	expect(button).toBeInstanceOf(HTMLButtonElement);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Expected ${label} button.`);
	}
	return button;
}

describe("PromptLibraryPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let scrollHeightSpy: ReturnType<typeof vi.spyOn> | null;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
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
		window.localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("focuses a newly added prompt entry", async () => {
		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		await act(async () => {
			getButton(container, "Add").click();
		});

		const promptTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
		expect(promptTextarea).toBeInstanceOf(HTMLTextAreaElement);
		expect(document.activeElement).toBe(promptTextarea);
	});

	it("collapses long unfocused prompt entries without enabling textarea scrolling", async () => {
		const longPromptText = ["one", "two", "three", "four", "five", "six"].join("\n");
		window.localStorage.setItem(
			LocalStorageKey.PromptLibraryByTask,
			JSON.stringify({
				"task-1": [
					{
						id: "prompt-1",
						text: longPromptText,
						scope: "task",
						createdAt: 100,
						updatedAt: 100,
					},
				],
			}),
		);
		scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(220);

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		const promptTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
		expect(promptTextarea).toBeInstanceOf(HTMLTextAreaElement);
		if (!(promptTextarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected prompt textarea.");
		}
		expect(promptTextarea.style.overflowY).toBe("hidden");
		expect(promptTextarea.style.height).not.toBe("220px");
		expect(container.querySelector('button[aria-label="Show full prompt"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("keeps the prompt expand control mounted when the control receives focus", async () => {
		const longPromptText = ["one", "two", "three", "four", "five", "six"].join("\n");
		window.localStorage.setItem(
			LocalStorageKey.PromptLibraryByTask,
			JSON.stringify({
				"task-1": [
					{
						id: "prompt-1",
						text: longPromptText,
						scope: "task",
						createdAt: 100,
						updatedAt: 100,
					},
				],
			}),
		);
		scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(220);

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		const expandButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show full prompt"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected prompt expand button.");
		}

		await act(async () => {
			expandButton.focus();
		});

		expect(container.querySelector('button[aria-label="Show full prompt"]')).toBeInstanceOf(HTMLButtonElement);
	});
});
