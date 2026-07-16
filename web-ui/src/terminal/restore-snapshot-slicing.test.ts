import { describe, expect, it } from "vitest";

import {
	RESTORE_SNAPSHOT_WRITE_SLICE_CHARS,
	sliceRestoreSnapshotForIncrementalWrite,
} from "@/terminal/restore-snapshot-slicing";

describe("sliceRestoreSnapshotForIncrementalWrite", () => {
	it("空快照 → 空数组(不产生空 write)", () => {
		expect(sliceRestoreSnapshotForIncrementalWrite("")).toEqual([]);
	});

	it("不超过切片上限的快照 → 原样单片", () => {
		const snapshot = "short snapshot content";
		expect(sliceRestoreSnapshotForIncrementalWrite(snapshot)).toEqual([snapshot]);
	});

	it("超限快照按上限切片,拼接后逐字符等于原文,且除末片外每片都等于上限", () => {
		const sliceChars = 8;
		const snapshot = "abcdefghij-klmnopqrst-uvwxyz";
		const slices = sliceRestoreSnapshotForIncrementalWrite(snapshot, sliceChars);
		expect(slices.length).toBeGreaterThan(1);
		expect(slices.join("")).toBe(snapshot);
		for (const slice of slices.slice(0, -1)) {
			expect(slice.length).toBe(sliceChars);
		}
		expect((slices.at(-1) ?? "").length).toBeLessThanOrEqual(sliceChars);
	});

	it("默认上限:数 MB 级快照被切成多片且总量不变", () => {
		const snapshot = "x".repeat(RESTORE_SNAPSHOT_WRITE_SLICE_CHARS * 2 + 123);
		const slices = sliceRestoreSnapshotForIncrementalWrite(snapshot);
		expect(slices.length).toBe(3);
		expect(slices.join("").length).toBe(snapshot.length);
	});

	it("切点落在代理对中间也不丢字符(xterm 跨 write 保持 interim 状态,拼接等于原文即安全)", () => {
		const emojiRun = "🎉".repeat(10); // 每个 emoji 2 个 UTF-16 code unit,奇数切点必然劈开代理对。
		const slices = sliceRestoreSnapshotForIncrementalWrite(emojiRun, 3);
		expect(slices.join("")).toBe(emojiRun);
	});
});
