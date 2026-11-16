import { describe, expect, it } from "vitest";
import { formatLineChangeCountWithThousandsSuffix } from "./format-line-change-count-with-thousands-suffix";

describe("增删行数的 K 缩写", () => {
	it.each([
		[0, "0"],
		[1, "1"],
		[999, "999"],
		[1_000, "1.0K"],
		[1_049, "1.0K"],
		[1_050, "1.1K"],
		[1_234, "1.2K"],
		[9_949, "9.9K"],
		[9_950, "10.0K"],
		[9_999, "10.0K"],
		[10_000, "10K"],
		[10_499, "10K"],
		[10_500, "11K"],
		[12_345, "12K"],
		[12_500, "13K"],
		[1_000_000, "1000K"],
	])("%i 行显示为 %s", (lineChangeCount, expectedText) => {
		expect(formatLineChangeCountWithThousandsSuffix(lineChangeCount)).toBe(expectedText);
	});
});
