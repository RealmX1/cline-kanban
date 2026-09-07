import { beforeEach, describe, expect, it } from "vitest";

import {
	clearAllBoardColumnScrollOffsets,
	readBoardColumnScrollOffset,
	writeBoardColumnScrollOffset,
} from "@/stores/board-column-scroll-offset-store";

describe("board-column-scroll-offset-store", () => {
	beforeEach(() => {
		clearAllBoardColumnScrollOffsets();
	});

	it("returns undefined for a column that was never written", () => {
		expect(readBoardColumnScrollOffset("/repo-a", "backlog")).toBeUndefined();
	});

	it("reads back what was written", () => {
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 120, revealedCardCount: 30 });
		expect(readBoardColumnScrollOffset("/repo-a", "backlog")).toEqual({ scrollTop: 120, revealedCardCount: 30 });
	});

	it("keys records per workspace + column so same-named columns never cross-talk", () => {
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 120, revealedCardCount: 30 });
		writeBoardColumnScrollOffset("/repo-b", "backlog", { scrollTop: 456, revealedCardCount: 10 });
		writeBoardColumnScrollOffset("/repo-a", "in_progress", { scrollTop: 32, revealedCardCount: 20 });

		expect(readBoardColumnScrollOffset("/repo-a", "backlog")?.scrollTop).toBe(120);
		expect(readBoardColumnScrollOffset("/repo-b", "backlog")?.scrollTop).toBe(456);
		expect(readBoardColumnScrollOffset("/repo-a", "in_progress")?.scrollTop).toBe(32);
		expect(readBoardColumnScrollOffset("/repo-a", "review")).toBeUndefined();
	});

	it("keeps a null workspace key in its own bucket, independent of any real workspace", () => {
		writeBoardColumnScrollOffset(null, "backlog", { scrollTop: 64, revealedCardCount: 10 });
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 120, revealedCardCount: 30 });

		expect(readBoardColumnScrollOffset(null, "backlog")?.scrollTop).toBe(64);
		expect(readBoardColumnScrollOffset("/repo-a", "backlog")?.scrollTop).toBe(120);
	});

	it("overwrites the existing record for the same key", () => {
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 120, revealedCardCount: 30 });
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 200, revealedCardCount: 40 });

		expect(readBoardColumnScrollOffset("/repo-a", "backlog")).toEqual({ scrollTop: 200, revealedCardCount: 40 });
	});

	it("skips the write when the values did not change, keeping the stored record object", () => {
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 120, revealedCardCount: 30 });
		const stored = readBoardColumnScrollOffset("/repo-a", "backlog");

		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 120, revealedCardCount: 30 });

		expect(readBoardColumnScrollOffset("/repo-a", "backlog")).toBe(stored);
	});

	it("rejects corrupt records instead of memorizing them", () => {
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: Number.NaN, revealedCardCount: 30 });
		writeBoardColumnScrollOffset("/repo-a", "in_progress", { scrollTop: 120, revealedCardCount: Number.NaN });
		writeBoardColumnScrollOffset("/repo-a", "review", { scrollTop: -1, revealedCardCount: 30 });
		writeBoardColumnScrollOffset("/repo-a", "validation", { scrollTop: 120, revealedCardCount: -1 });
		writeBoardColumnScrollOffset("/repo-a", "trash", {
			scrollTop: 120,
			revealedCardCount: Number.POSITIVE_INFINITY,
		});

		expect(readBoardColumnScrollOffset("/repo-a", "backlog")).toBeUndefined();
		expect(readBoardColumnScrollOffset("/repo-a", "in_progress")).toBeUndefined();
		expect(readBoardColumnScrollOffset("/repo-a", "review")).toBeUndefined();
		expect(readBoardColumnScrollOffset("/repo-a", "validation")).toBeUndefined();
		expect(readBoardColumnScrollOffset("/repo-a", "trash")).toBeUndefined();
	});

	it("clearAllBoardColumnScrollOffsets wipes every workspace bucket", () => {
		writeBoardColumnScrollOffset("/repo-a", "backlog", { scrollTop: 120, revealedCardCount: 30 });
		writeBoardColumnScrollOffset(null, "review", { scrollTop: 12, revealedCardCount: 10 });

		clearAllBoardColumnScrollOffsets();

		expect(readBoardColumnScrollOffset("/repo-a", "backlog")).toBeUndefined();
		expect(readBoardColumnScrollOffset(null, "review")).toBeUndefined();
	});
});
