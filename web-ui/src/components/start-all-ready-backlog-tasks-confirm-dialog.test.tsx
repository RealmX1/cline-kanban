import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartAllReadyBacklogTasksConfirmDialog } from "@/components/start-all-ready-backlog-tasks-confirm-dialog";
import type { BoardCard } from "@/types";

function createTask(taskId: string, title: string): BoardCard {
	return {
		id: taskId,
		title,
		prompt: title,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("StartAllReadyBacklogTasksConfirmDialog", () => {
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

	function findButton(label: string): HTMLButtonElement | undefined {
		return Array.from(document.body.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === label,
		);
	}

	it("shows the exact task count and titles before confirming", async () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();
		await act(async () => {
			root.render(
				<StartAllReadyBacklogTasksConfirmDialog
					tasks={[createTask("task-1", "First task"), createTask("task-2", "Second task")]}
					onCancel={onCancel}
					onConfirm={onConfirm}
				/>,
			);
		});

		expect(document.body.textContent).toContain("Start 2 ready backlog tasks?");
		expect(document.body.textContent).toContain(
			"This will move 2 ready backlog tasks to In Progress and launch an agent for each task.",
		);
		expect(document.body.textContent).toContain("First task");
		expect(document.body.textContent).toContain("Second task");

		await act(async () => {
			findButton("Cancel")?.click();
		});
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();

		await act(async () => {
			findButton("Start 2 tasks")?.click();
		});
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("uses singular copy for one ready backlog task", async () => {
		await act(async () => {
			root.render(
				<StartAllReadyBacklogTasksConfirmDialog
					tasks={[createTask("task-1", "Only task")]}
					onCancel={() => {}}
					onConfirm={() => {}}
				/>,
			);
		});

		expect(document.body.textContent).toContain("Start 1 ready backlog task?");
		expect(document.body.textContent).toContain(
			"This will move 1 ready backlog task to In Progress and launch its agent.",
		);
		expect(findButton("Start 1 task")).toBeInstanceOf(HTMLButtonElement);
	});
});
