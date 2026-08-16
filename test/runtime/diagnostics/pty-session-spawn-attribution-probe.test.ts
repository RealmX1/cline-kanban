import { describe, expect, it } from "vitest";
import { readProcessOpenFileDescriptorCount } from "../../../src/diagnostics/process-file-descriptor-watermark-monitor";
import { findCrossedStderrWatermarkTier } from "../../../src/diagnostics/pty-session-spawn-attribution-probe";

const WATERMARK_TIERS = [1, 25, 100, 250, 500];

describe("probe stderr watermark tiers", () => {
	it("fires exactly once at the moment a tier is crossed, then stays quiet", () => {
		expect(findCrossedStderrWatermarkTier(0, 1, WATERMARK_TIERS)).toBe(1);
		expect(findCrossedStderrWatermarkTier(1, 2, WATERMARK_TIERS)).toBeNull();
		expect(findCrossedStderrWatermarkTier(24, 25, WATERMARK_TIERS)).toBe(25);
		expect(findCrossedStderrWatermarkTier(25, 99, WATERMARK_TIERS)).toBeNull();
	});

	it("reports only the highest tier when a single step jumps several tiers at once", () => {
		// fd 采样每 60 秒一次，一个采样窗口内跨好几档是常态；逐档各打一行会自己制造噪声。
		expect(findCrossedStderrWatermarkTier(0, 400, WATERMARK_TIERS)).toBe(250);
	});

	it("stays quiet while the value falls back down", () => {
		expect(findCrossedStderrWatermarkTier(400, 20, WATERMARK_TIERS)).toBeNull();
	});
});

describe("process file descriptor census", () => {
	it("counts this process's own open file descriptors without shelling out", () => {
		// fd 快耗尽时恰恰开不出子进程，因此这条读数必须是纯进程内的。
		const openFileDescriptorCount = readProcessOpenFileDescriptorCount();

		if (process.platform === "win32") {
			expect(openFileDescriptorCount).toBeNull();
			return;
		}
		expect(openFileDescriptorCount).not.toBeNull();
		// stdin/stdout/stderr 至少 3 个；上限只为挡住「返回了个荒谬数」。
		expect(openFileDescriptorCount ?? 0).toBeGreaterThanOrEqual(3);
		expect(openFileDescriptorCount ?? 0).toBeLessThan(100_000);
	});
});
