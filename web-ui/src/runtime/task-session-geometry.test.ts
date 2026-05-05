import { describe, expect, it } from "vitest";

import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";

describe("estimateTaskSessionGeometry", () => {
	it("uses fixed terminal width and near-full viewport height", () => {
		expect(estimateTaskSessionGeometry(1440, 900)).toEqual({
			cols: 60,
			rows: 53,
		});
	});

	it("keeps terminal columns independent of viewport width", () => {
		expect(estimateTaskSessionGeometry(900, 900).cols).toBe(60);
		expect(estimateTaskSessionGeometry(1800, 900).cols).toBe(60);
	});

	it("enforces minimum terminal dimensions", () => {
		expect(estimateTaskSessionGeometry(100, 100)).toEqual({
			cols: 60,
			rows: 12,
		});
	});
});
