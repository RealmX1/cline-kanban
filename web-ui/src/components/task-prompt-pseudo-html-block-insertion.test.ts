import { describe, expect, it } from "vitest";

import {
	buildTaskPromptWithPseudoHtmlBlockInserted,
	normalizePseudoHtmlBlockName,
} from "@/components/task-prompt-pseudo-html-block-insertion";

describe("normalizePseudoHtmlBlockName", () => {
	it("keeps an already-clean name unchanged", () => {
		expect(normalizePseudoHtmlBlockName("trajectory")).toBe("trajectory");
	});

	it("folds interior whitespace into underscores", () => {
		expect(normalizePseudoHtmlBlockName("  expected   output ")).toBe("expected_output");
	});

	it("drops characters that cannot appear in a tag name", () => {
		expect(normalizePseudoHtmlBlockName("<answer/>")).toBe("answer");
	});

	it("returns null when nothing survives normalization", () => {
		expect(normalizePseudoHtmlBlockName("  <> ")).toBeNull();
		expect(normalizePseudoHtmlBlockName("")).toBeNull();
	});
});

describe("buildTaskPromptWithPseudoHtmlBlockInserted", () => {
	it("inserts an empty block into an empty prompt and puts the caret inside it", () => {
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue: "",
			selectionStart: 0,
			selectionEnd: 0,
			blockName: "trajectory",
		});
		expect(result.nextPromptValue).toBe("<trajectory>\n\n</trajectory>");
		expect(result.nextSelectionStart).toBe("<trajectory>\n".length);
		expect(result.nextSelectionEnd).toBe(result.nextSelectionStart);
	});

	it("wraps the current selection and keeps that text selected", () => {
		const promptValue = "before\nselected text\nafter";
		const selectionStart = promptValue.indexOf("selected text");
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue,
			selectionStart,
			selectionEnd: selectionStart + "selected text".length,
			blockName: "question",
		});
		expect(result.nextPromptValue).toBe("before\n\n<question>\nselected text\n</question>\n\nafter");
		expect(result.nextPromptValue.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe("selected text");
	});

	it("adds a blank line on both sides when the caret sits mid-paragraph", () => {
		const promptValue = "leadingtrailing";
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue,
			selectionStart: "leading".length,
			selectionEnd: "leading".length,
			blockName: "answer",
		});
		expect(result.nextPromptValue).toBe("leading\n\n<answer>\n\n</answer>\n\ntrailing");
	});

	it("does not add extra newlines when the neighbouring text already has a blank line", () => {
		const promptValue = "leading\n\n\n\ntrailing";
		const caretIndex = "leading\n\n".length;
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue,
			selectionStart: caretIndex,
			selectionEnd: caretIndex,
			blockName: "answer",
		});
		expect(result.nextPromptValue).toBe("leading\n\n<answer>\n\n</answer>\n\ntrailing");
	});

	it("drops surrounding whitespace-only text so the block is not indented", () => {
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue: "   \n  ",
			selectionStart: 4,
			selectionEnd: 4,
			blockName: "trajectory",
		});
		expect(result.nextPromptValue).toBe("<trajectory>\n\n</trajectory>");
	});

	it("keeps the whitespace inside a selected line instead of trimming it away", () => {
		const promptValue = "  padded  ";
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue,
			selectionStart: 0,
			selectionEnd: promptValue.length,
			blockName: "answer",
		});
		expect(result.nextPromptValue).toBe("<answer>\n  padded  \n</answer>");
		expect(result.nextPromptValue.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe("  padded  ");
	});

	it("keeps the indentation of a selected indented code block", () => {
		// 这条是 trim() 最典型的受害者：首行缩进被吃掉后整块代码就对不齐了。
		const promptValue = "intro\n\n    const value = 1;\n    return value;\n\ntail";
		const selectedText = "    const value = 1;\n    return value;";
		const selectionStart = promptValue.indexOf(selectedText);
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue,
			selectionStart,
			selectionEnd: selectionStart + selectedText.length,
			blockName: "code",
		});
		expect(result.nextPromptValue).toBe("intro\n\n<code>\n    const value = 1;\n    return value;\n</code>\n\ntail");
		expect(result.nextPromptValue.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe(selectedText);
	});

	it("drops blank lines at the selection edges while keeping the indented content byte for byte", () => {
		const promptValue = "\n   \n    indented body  \n  \n";
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue,
			selectionStart: 0,
			selectionEnd: promptValue.length,
			blockName: "answer",
		});
		expect(result.nextPromptValue).toBe("<answer>\n    indented body  \n</answer>");
		expect(result.nextPromptValue.slice(result.nextSelectionStart, result.nextSelectionEnd)).toBe(
			"    indented body  ",
		);
	});

	it("yields an empty block when the whole selection is blank lines", () => {
		const promptValue = "head\n\n   \n\ntail";
		const selectionStart = "head\n\n".length;
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue,
			selectionStart,
			selectionEnd: selectionStart + "   ".length,
			blockName: "answer",
		});
		expect(result.nextPromptValue).toBe("head\n\n<answer>\n\n</answer>\n\ntail");
		expect(result.nextSelectionEnd).toBe(result.nextSelectionStart);
	});

	it("clamps out-of-range selections instead of producing undefined slices", () => {
		const result = buildTaskPromptWithPseudoHtmlBlockInserted({
			promptValue: "text",
			selectionStart: 999,
			selectionEnd: -5,
			blockName: "answer",
		});
		expect(result.nextPromptValue).toBe("text\n\n<answer>\n\n</answer>");
	});
});
