import { describe, expect, it } from "vitest";

import {
	isAllowedCrossColumnCardMove,
	isCardDropDisabled,
	type ProgrammaticCardMoveInFlight,
} from "@/state/drag-rules";

describe("drag rules", () => {
	it("keeps manual in-progress to review drops disabled", () => {
		expect(isCardDropDisabled("review", "in_progress")).toBe(true);
	});

	it("allows the matching programmatic in-progress to review drop", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-2",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(true);
	});

	it("allows the matching programmatic review to in-progress drop", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "review",
			toColumnId: "in_progress",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("in_progress", "review", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		expect(
			isCardDropDisabled("in_progress", "review", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: {
					...move,
					toColumnId: "review",
				},
			}),
		).toBe(true);
	});

	it("allows manual trash to review drops", () => {
		expect(isCardDropDisabled("review", "trash")).toBe(false);
	});

	it("allows free in-progress and review drops into validation", () => {
		expect(isAllowedCrossColumnCardMove("in_progress", "validation")).toBe(true);
		expect(isAllowedCrossColumnCardMove("review", "validation")).toBe(true);
		expect(isCardDropDisabled("validation", "in_progress")).toBe(false);
		expect(isCardDropDisabled("validation", "review")).toBe(false);
	});

	it("blocks manual drops into validation from non in-progress/review columns", () => {
		expect(isAllowedCrossColumnCardMove("backlog", "validation")).toBe(false);
		expect(isAllowedCrossColumnCardMove("trash", "validation")).toBe(false);
		expect(isCardDropDisabled("validation", "backlog")).toBe(true);
		expect(isCardDropDisabled("validation", "trash")).toBe(true);
	});

	it("allows manual validation to done drops", () => {
		expect(isAllowedCrossColumnCardMove("validation", "trash")).toBe(true);
		expect(isCardDropDisabled("trash", "validation")).toBe(false);
	});

	it("only allows validation to in-progress as a matching programmatic move", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "validation",
			toColumnId: "in_progress",
			insertAtTop: true,
		};

		// Manual drag (no programmatic move in flight) stays disabled.
		expect(isAllowedCrossColumnCardMove("validation", "in_progress")).toBe(false);
		expect(isCardDropDisabled("in_progress", "validation")).toBe(true);

		// The matching programmatic auto-move (session running) is allowed.
		expect(
			isCardDropDisabled("in_progress", "validation", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		// A non-matching task id is still blocked.
		expect(
			isCardDropDisabled("in_progress", "validation", {
				activeDragTaskId: "task-2",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(true);
	});

	it("allows manual validation to review drops (mirror of review to validation)", () => {
		expect(isAllowedCrossColumnCardMove("validation", "review")).toBe(true);
		expect(isCardDropDisabled("review", "validation")).toBe(false);
	});
});
