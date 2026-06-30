import { describe, expect, it } from "vitest";
import { formatCompactElapsedSince } from "./format-compact-elapsed";

const NOW = 1_000_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

describe("formatCompactElapsedSince", () => {
	it('renders sub-minute and future timestamps as "now"', () => {
		expect(formatCompactElapsedSince(NOW, NOW)).toBe("now");
		expect(formatCompactElapsedSince(NOW - 59 * SECOND, NOW)).toBe("now");
		expect(formatCompactElapsedSince(NOW + 10 * MINUTE, NOW)).toBe("now"); // 未来夹到 0
	});

	it("picks the coarsest single-unit bucket at each boundary", () => {
		expect(formatCompactElapsedSince(NOW - MINUTE, NOW)).toBe("1m");
		expect(formatCompactElapsedSince(NOW - 59 * MINUTE, NOW)).toBe("59m");
		expect(formatCompactElapsedSince(NOW - HOUR, NOW)).toBe("1h");
		expect(formatCompactElapsedSince(NOW - 23 * HOUR, NOW)).toBe("23h");
		expect(formatCompactElapsedSince(NOW - DAY, NOW)).toBe("1d");
		expect(formatCompactElapsedSince(NOW - 6 * DAY, NOW)).toBe("6d");
		expect(formatCompactElapsedSince(NOW - WEEK, NOW)).toBe("1w");
		expect(formatCompactElapsedSince(NOW - 51 * WEEK, NOW)).toBe("51w");
		expect(formatCompactElapsedSince(NOW - YEAR, NOW)).toBe("1y");
		expect(formatCompactElapsedSince(NOW - 3 * YEAR, NOW)).toBe("3y");
	});
});
