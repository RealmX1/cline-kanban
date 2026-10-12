import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createShortTaskId,
	createUniqueTaskId,
	isCompleteShortTaskIdShapedText,
	isPartialOrCompleteShortTaskIdShapedSearchQuery,
	MINIMUM_PARTIAL_TASK_ID_SEARCH_QUERY_CHARACTER_LENGTH,
	SHORT_TASK_ID_CHARACTER_LENGTH,
} from "../../src/core/task-id";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createUniqueTaskId", () => {
	it("uses random entropy in the final fallback", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.123456789);

		const taskId = createUniqueTaskId(new Set(["moi4q"]), () => "moi4qabcdef");

		expect(taskId).toBe("4fzzz");
	});
});

describe("isCompleteShortTaskIdShapedText", () => {
	it("accepts exactly five lowercase alphanumeric characters", () => {
		expect(isCompleteShortTaskIdShapedText("a3f21")).toBe(true);
		expect(isCompleteShortTaskIdShapedText("94c87")).toBe(true);
		// 兜底路径走 Math.random().toString(36)，会产出 g–z，字符集必须覆盖到 z。
		expect(isCompleteShortTaskIdShapedText("zzzzz")).toBe(true);
		expect(isCompleteShortTaskIdShapedText("00000")).toBe(true);
	});

	it("rejects anything that is not a complete lowercase five-character id", () => {
		// 谓词只认小写，容忍用户粘贴的大写是调用方的责任。
		expect(isCompleteShortTaskIdShapedText("A3F21")).toBe(false);
		expect(isCompleteShortTaskIdShapedText("a3f2")).toBe(false);
		expect(isCompleteShortTaskIdShapedText("a3f210")).toBe(false);
		expect(isCompleteShortTaskIdShapedText("a3f-1")).toBe(false);
		expect(isCompleteShortTaskIdShapedText("a3f 1")).toBe(false);
		expect(isCompleteShortTaskIdShapedText("")).toBe(false);
	});

	it("accepts everything the generator can produce (closes the drift loop)", () => {
		expect(SHORT_TASK_ID_CHARACTER_LENGTH).toBe(5);
		expect(isCompleteShortTaskIdShapedText(createShortTaskId(() => "8f2c1a9b-3d4e-4f5a-9b8c-7d6e5f4a3b2c"))).toBe(
			true,
		);

		vi.spyOn(Math, "random").mockReturnValue(0.123456789);
		expect(isCompleteShortTaskIdShapedText(createUniqueTaskId(new Set(["moi4q"]), () => "moi4qabcdef"))).toBe(true);
	});
});

describe("isPartialOrCompleteShortTaskIdShapedSearchQuery", () => {
	it("accepts lowercase alphanumeric text from the minimum partial length up to the complete length", () => {
		expect(MINIMUM_PARTIAL_TASK_ID_SEARCH_QUERY_CHARACTER_LENGTH).toBe(3);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("94c")).toBe(true);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("94c8")).toBe(true);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("94c87")).toBe(true);
	});

	it("rejects text that is too short, too long, uppercase or outside the id character set", () => {
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("")).toBe(false);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("94")).toBe(false);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("94c870")).toBe(false);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("94C")).toBe(false);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("9-c")).toBe(false);
		expect(isPartialOrCompleteShortTaskIdShapedSearchQuery("9 c8")).toBe(false);
	});
});
