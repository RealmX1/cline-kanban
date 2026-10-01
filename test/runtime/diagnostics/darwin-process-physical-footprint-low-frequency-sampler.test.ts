import { describe, expect, it } from "vitest";

import {
	parseTopMemoryColumnTextToBytes,
	parseTopProcessIdAndPhysicalFootprintOutput,
} from "../../../src/diagnostics/darwin-process-physical-footprint-low-frequency-sampler";

describe("parseTopMemoryColumnTextToBytes", () => {
	it.each([
		["312M", 312 * 1024 ** 2],
		["2G", 2 * 1024 ** 3],
		["512K", 512 * 1024],
		["95M+", 95 * 1024 ** 2],
		["1091M-", 1091 * 1024 ** 2],
	])("parses %s", (memoryColumnText, expectedBytes) => {
		expect(parseTopMemoryColumnTextToBytes(memoryColumnText)).toBe(expectedBytes);
	});

	it("returns null for a column it cannot read", () => {
		expect(parseTopMemoryColumnTextToBytes("N/A")).toBeNull();
	});
});

describe("parseTopProcessIdAndPhysicalFootprintOutput", () => {
	it("reads only the process rows that follow the PID header", () => {
		const topOutput = [
			"Processes: 820 total, 3 running, 817 sleeping, 3748 threads",
			"PhysMem: 25G used (2114M wired, 2409M compressor), 6283M unused.",
			"",
			"PID    MEM  ",
			"54778  312M ",
			"9104   1091M",
			"",
		].join("\n");

		expect(parseTopProcessIdAndPhysicalFootprintOutput(topOutput)).toEqual(
			new Map([
				[54778, 312 * 1024 ** 2],
				[9104, 1091 * 1024 ** 2],
			]),
		);
	});
});
