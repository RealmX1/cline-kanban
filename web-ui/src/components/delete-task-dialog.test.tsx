import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeleteTaskDialog } from "@/components/delete-task-dialog";
import type { BoardCard } from "@/types";

function createTask(): BoardCard {
	return {
		id: "task-1",
		title: "Delete me",
		prompt: "Delete me",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("DeleteTaskDialog", () => {
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
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("requires two confirmations before deleting", async () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		await act(async () => {
			root.render(<DeleteTaskDialog task={createTask()} onCancel={onCancel} onConfirm={onConfirm} />);
		});

		const findButton = (label: string): HTMLButtonElement | undefined =>
			Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		await act(async () => {
			findButton("Continue")?.click();
		});

		expect(onConfirm).not.toHaveBeenCalled();

		await act(async () => {
			findButton("Delete Task")?.click();
		});

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});
});
