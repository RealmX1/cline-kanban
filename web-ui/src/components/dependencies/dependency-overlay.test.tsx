import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { DependencyOverlay } from "@/components/dependencies/dependency-overlay";
import type { BoardDependency } from "@/types";

function createRect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

const DEPENDENCY: BoardDependency = {
	id: "dep-1",
	fromTaskId: "source-task",
	toTaskId: "target-task",
	createdAt: 1,
};

describe("DependencyOverlay", () => {
	let boardContainer: HTMLElement;
	let boardColumn: HTMLElement;
	let holder: HTMLDivElement;
	let root: Root;
	let rectSpy: Mock<() => DOMRect>;
	let previousActEnvironment: boolean | undefined;

	const renderOverlay = async (dependencies: BoardDependency[]) => {
		await act(async () => {
			root.render(
				<DependencyOverlay containerRef={{ current: boardContainer }} dependencies={dependencies} draft={null} />,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
	};

	const appendAndFlush = async (node: Node) => {
		await act(async () => {
			boardColumn.appendChild(node);
		});
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
	};

	const removeAndFlush = async (node: Node) => {
		await act(async () => {
			node.parentNode?.removeChild(node);
		});
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			return window.setTimeout(() => {
				callback(performance.now());
			}, 16);
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle: number) => {
			window.clearTimeout(handle);
		});
		rectSpy = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function getBoundingClientRect(this: HTMLElement) {
				if (this.dataset.boardContainer !== undefined) {
					return createRect(0, 0, 800, 600);
				}
				if (this.dataset.taskId === "source-task") {
					return createRect(20, 20, 160, 96);
				}
				if (this.dataset.taskId === "target-task") {
					return createRect(300, 20, 160, 96);
				}
				return createRect(0, 0, 0, 0);
			});
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		boardContainer = document.createElement("div");
		boardContainer.dataset.boardContainer = "true";
		boardColumn = document.createElement("section");
		boardColumn.dataset.columnId = "backlog";
		for (const taskId of ["source-task", "target-task"]) {
			const card = document.createElement("div");
			card.dataset.taskId = taskId;
			boardColumn.appendChild(card);
		}
		boardContainer.appendChild(boardColumn);
		document.body.appendChild(boardContainer);

		holder = document.createElement("div");
		document.body.appendChild(holder);
		root = createRoot(holder);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		vi.useRealTimers();
		boardContainer.remove();
		holder.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("does not remeasure when hover-gated Tooltip button DOM mounts and unmounts", async () => {
		// A-P0-6's Tooltip hover gating swaps a card button between a raw child
		// and a Radix Root/Trigger on every hover pass. Those triggers live in
		// hosts task-card-body marks with [data-card-hover-actions]; churn
		// confined there cannot move any anchor, so it must not wake the layout
		// refresh — otherwise every hover over a board with dependency edges
		// runs getBoundingClientRect over every card (forced synchronous
		// layout).
		await renderOverlay([DEPENDENCY]);
		const card = boardContainer.querySelector<HTMLElement>('[data-task-id="source-task"]');
		if (!card) {
			throw new Error("test fixture is missing the source-task card");
		}
		const hoverActions = document.createElement("div");
		hoverActions.setAttribute("data-card-hover-actions", "");
		await act(async () => {
			card.appendChild(hoverActions);
		});
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		rectSpy.mockClear();

		const button = document.createElement("button");
		await act(async () => {
			hoverActions.appendChild(button);
		});
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		expect(rectSpy).not.toHaveBeenCalled();

		await removeAndFlush(button);
		expect(rectSpy).not.toHaveBeenCalled();
	});

	it("remeasures when a conditional row is added or removed inside a card", async () => {
		// Conditional rows inside a card (parked badge, delivery-contention
		// notice, session-activity row, directory row) carry no data-task-id of
		// their own, yet mounting or unmounting them changes the card's height
		// and shifts every card below it. The overlay must remeasure, or
		// dependency paths stay pinned to stale coordinates until the next
		// scroll/resize.
		await renderOverlay([DEPENDENCY]);
		rectSpy.mockClear();

		const card = boardContainer.querySelector<HTMLElement>('[data-task-id="source-task"]');
		if (!card) {
			throw new Error("test fixture is missing the source-task card");
		}
		const row = document.createElement("div");
		await act(async () => {
			card.appendChild(row);
		});
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		expect(rectSpy).toHaveBeenCalled();

		rectSpy.mockClear();
		await removeAndFlush(row);
		expect(rectSpy).toHaveBeenCalled();
	});

	it("does not remeasure when a self-marked hover trigger is added or removed", async () => {
		// Some gated triggers carry the mark on the trigger element itself
		// (e.g. the git-status indicator span in the directory row): the
		// mutation target is an ordinary card subtree, so only the changed
		// node's own mark can classify the churn.
		await renderOverlay([DEPENDENCY]);
		rectSpy.mockClear();

		const card = boardContainer.querySelector<HTMLElement>('[data-task-id="source-task"]');
		if (!card) {
			throw new Error("test fixture is missing the source-task card");
		}
		const trigger = document.createElement("span");
		trigger.setAttribute("data-card-hover-actions", "");
		await act(async () => {
			card.appendChild(trigger);
		});
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		expect(rectSpy).not.toHaveBeenCalled();

		await removeAndFlush(trigger);
		expect(rectSpy).not.toHaveBeenCalled();
	});

	it("remeasures when an element subtree containing a card is added or removed", async () => {
		await renderOverlay([DEPENDENCY]);
		rectSpy.mockClear();

		const wrapper = document.createElement("div");
		const card = document.createElement("div");
		card.dataset.taskId = "extra-task";
		wrapper.appendChild(card);

		await appendAndFlush(wrapper);
		expect(rectSpy).toHaveBeenCalled();

		rectSpy.mockClear();
		await removeAndFlush(wrapper);
		expect(rectSpy).toHaveBeenCalled();
	});

	it("observes with exactly the anchor-moving attributeFilter", async () => {
		const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");

		await renderOverlay([DEPENDENCY]);

		expect(observeSpy).toHaveBeenCalledTimes(1);
		const [target, options] = observeSpy.mock.calls[0] ?? [];
		expect(target).toBe(boardContainer);
		expect(options?.subtree).toBe(true);
		expect(options?.childList).toBe(true);
		expect(options?.attributes).toBe(true);
		expect([...(options?.attributeFilter ?? [])].sort()).toEqual([
			"data-column-id",
			"data-programmatic-card-move",
			"data-task-id",
			"style",
		]);
	});

	it("never observes when the board has no dependencies and no draft", async () => {
		const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");

		await renderOverlay([]);

		expect(observeSpy).not.toHaveBeenCalled();
	});
});
