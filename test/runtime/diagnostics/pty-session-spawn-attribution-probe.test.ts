import { describe, expect, it } from "vitest";
import {
	deriveProcessFileDescriptorSampleReport,
	readProcessOpenFileDescriptorCount,
} from "../../../src/diagnostics/process-file-descriptor-watermark-monitor";
import {
	findCrossedStderrWatermarkTier,
	getPtySessionSpawnCountSnapshot,
	recordPtySessionSpawnOutcome,
} from "../../../src/diagnostics/pty-session-spawn-attribution-probe";

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

describe("pty session spawn outcome counting", () => {
	it("keeps a failed spawn out of the count that fd growth is reconciled against", () => {
		// node-pty 的 kqueue 分配（pty.cc:500 SetupExitCallback）在所有 throw 点（412/415/455/488）之后，
		// 因此抛错的 spawn 不产生本轮要对账的泄漏；把它算进创建数会让 fd 增量去对一个不存在的会话。
		const before = getPtySessionSpawnCountSnapshot();

		recordPtySessionSpawnOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-failed-spawn" },
			spawnedPid: null,
			spawnErrorCode: "EBADF",
			spawnErrorMessage: "posix_spawn_file_actions_adddup2 failed",
		});
		const afterFailure = getPtySessionSpawnCountSnapshot();
		expect(afterFailure.succeededTotalCount).toBe(before.succeededTotalCount);
		expect(afterFailure.failedTotalCount).toBe(before.failedTotalCount + 1);

		recordPtySessionSpawnOutcome({
			attribution: { reason: "shell_session", taskId: "task-ok-spawn" },
			spawnedPid: 4321,
			spawnErrorCode: null,
			spawnErrorMessage: null,
		});
		const afterSuccess = getPtySessionSpawnCountSnapshot();
		expect(afterSuccess.succeededTotalCount).toBe(before.succeededTotalCount + 1);
		expect(afterSuccess.failedTotalCount).toBe(before.failedTotalCount + 1);
		expect(afterSuccess.succeededCountsByReason.shell_session).toBe(
			(before.succeededCountsByReason.shell_session ?? 0) + 1,
		);
		// 失败的那次不得出现在按 reason 的成功分桶里。
		expect(afterSuccess.succeededCountsByReason.task_agent_session).toBe(
			before.succeededCountsByReason.task_agent_session,
		);
	});
});

describe("process file descriptor sampling baseline", () => {
	it("marks the first sample as a baseline instead of reporting the whole fd table as one minute of growth", () => {
		// 进程启动时已有的 fd 不是「这一分钟涨出来的」；拿 0 当上一份样本会把它们整体误报成增量。
		expect(deriveProcessFileDescriptorSampleReport(null, 9_400)).toEqual({
			isBaselineSample: true,
			deltaSincePreviousSample: null,
			crossedStderrWatermarkTier: null,
		});
	});

	it("reports growth against the real baseline once one exists", () => {
		expect(deriveProcessFileDescriptorSampleReport(9_400, 9_530)).toEqual({
			isBaselineSample: false,
			deltaSincePreviousSample: 130,
			crossedStderrWatermarkTier: 9_500,
		});
	});

	it("reports a negative delta when file descriptors are released, without a watermark warning", () => {
		expect(deriveProcessFileDescriptorSampleReport(9_530, 9_400)).toEqual({
			isBaselineSample: false,
			deltaSincePreviousSample: -130,
			crossedStderrWatermarkTier: null,
		});
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
