import { describe, expect, it } from "vitest";

import { buildPromptMatchSnippet } from "@/search/task-search-prompt-match-snippet";

describe("buildPromptMatchSnippet", () => {
	it("windows around the first match and shifts positions into the snippet coordinate space", () => {
		const snippet = buildPromptMatchSnippet("0123456789abcdefghij", new Set([10, 11]), 5);

		expect(snippet.text).toBe("56789abcde");
		expect([...snippet.matchCharacterPositions].sort((a, b) => a - b)).toEqual([5, 6]);
		expect(snippet.hasLeadingEllipsis).toBe(true);
		expect(snippet.hasTrailingEllipsis).toBe(true);
	});

	it("omits the leading ellipsis when the first match sits within the opening window", () => {
		const snippet = buildPromptMatchSnippet("0123456789abcdefghij", new Set([1]), 5);

		expect(snippet.text).toBe("0123456789");
		expect([...snippet.matchCharacterPositions]).toEqual([1]);
		expect(snippet.hasLeadingEllipsis).toBe(false);
		expect(snippet.hasTrailingEllipsis).toBe(true);
	});

	it("omits the trailing ellipsis when the window reaches the end of the prompt", () => {
		const snippet = buildPromptMatchSnippet("0123456789abcdefghij", new Set([18]), 5);

		expect(snippet.hasTrailingEllipsis).toBe(false);
		expect(snippet.hasLeadingEllipsis).toBe(true);
	});

	it("falls back to the opening window when there are no match positions", () => {
		const snippet = buildPromptMatchSnippet("0123456789abcdefghij", new Set<number>(), 5);

		expect(snippet.text).toBe("0123456789");
		expect(snippet.matchCharacterPositions.size).toBe(0);
		expect(snippet.hasLeadingEllipsis).toBe(false);
		expect(snippet.hasTrailingEllipsis).toBe(true);
	});
});
