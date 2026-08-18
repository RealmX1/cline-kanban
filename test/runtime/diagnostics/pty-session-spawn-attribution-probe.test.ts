import { describe, expect, it } from "vitest";
import {
	deriveProcessFileDescriptorSampleReport,
	readProcessOpenFileDescriptorCount,
} from "../../../src/diagnostics/process-file-descriptor-watermark-monitor";
import {
	findCrossedStderrWatermarkTier,
	getPtySessionSpawnCountSnapshot,
	recordPtySessionExitOutcome,
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

	it("hands out a monotonic sequence number to every created pty and none to a failed spawn", () => {
		// 序号是创建记录与退出记录之间唯一的配对键；失败的 spawn 没有进程、也永远等不到退出事件，
		// 给它占一个号就会在配对时留下一个永远悬空的洞。
		const first = recordPtySessionSpawnOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-seq-1" },
			spawnedPid: 101,
			spawnErrorCode: null,
			spawnErrorMessage: null,
		});
		const failed = recordPtySessionSpawnOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-seq-failed" },
			spawnedPid: null,
			spawnErrorCode: "EMFILE",
			spawnErrorMessage: "too many open files",
		});
		const second = recordPtySessionSpawnOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-seq-2" },
			spawnedPid: 102,
			spawnErrorCode: null,
			spawnErrorMessage: null,
		});

		expect(first).not.toBeNull();
		expect(failed).toBeNull();
		expect(second).toBe((first ?? 0) + 1);
	});
});

describe("live pty session counting", () => {
	it("rises on creation and falls on exit so one record alone proves concurrency", () => {
		// 「先后两次刷新」与「重叠两次刷新」在只有创建记录的通道里逐字同形。存活计数是把两者分开的读数：
		// 先后 ⇒ 第二次创建时计数回落到与第一次相同；重叠 ⇒ 第二次创建时计数比第一次高。
		const baseline = getPtySessionSpawnCountSnapshot().livePtySessionCount;

		const firstSequenceNumber = recordPtySessionSpawnOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-live" },
			spawnedPid: 201,
			spawnErrorCode: null,
			spawnErrorMessage: null,
		});
		const secondSequenceNumber = recordPtySessionSpawnOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-live" },
			spawnedPid: 202,
			spawnErrorCode: null,
			spawnErrorMessage: null,
		});
		expect(getPtySessionSpawnCountSnapshot().livePtySessionCount).toBe(baseline + 2);

		recordPtySessionExitOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-live" },
			ptySessionSpawnSequenceNumber: firstSequenceNumber,
			spawnedPid: 201,
			exitCode: 0,
			exitSignal: null,
			ptySessionLifetimeMs: 1_200,
		});
		recordPtySessionExitOutcome({
			attribution: { reason: "task_agent_session", taskId: "task-live" },
			ptySessionSpawnSequenceNumber: secondSequenceNumber,
			spawnedPid: 202,
			exitCode: 0,
			exitSignal: null,
			ptySessionLifetimeMs: 900,
		});
		expect(getPtySessionSpawnCountSnapshot().livePtySessionCount).toBe(baseline);
	});

	it("never lets an unpaired exit push the live count below zero", () => {
		// 没分配过序号 ⇒ 从来没计入过存活数。照减会把计数带成负数，此后所有并发判读全部作废。
		const baseline = getPtySessionSpawnCountSnapshot().livePtySessionCount;
		recordPtySessionExitOutcome({
			attribution: null,
			ptySessionSpawnSequenceNumber: null,
			spawnedPid: 999,
			exitCode: 1,
			exitSignal: null,
			ptySessionLifetimeMs: 5,
		});
		expect(getPtySessionSpawnCountSnapshot().livePtySessionCount).toBe(baseline);
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
