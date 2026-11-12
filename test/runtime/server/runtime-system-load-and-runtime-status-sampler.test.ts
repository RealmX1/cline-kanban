import { statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RuntimeSystemLoadAndRuntimeStatusSnapshot,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { startRuntimeSystemLoadAndRuntimeStatusSampler } from "../../../src/server/runtime-system-load-and-runtime-status-sampler";

vi.mock("node:os", () => ({ cpus: vi.fn(), freemem: vi.fn(), totalmem: vi.fn() }));
vi.mock("node:fs/promises", () => ({ statfs: vi.fn() }));

function cpuTimes(idle: number, user: number) {
	return { model: "test", speed: 1, times: { idle, user, nice: 0, sys: 0, irq: 0 } };
}

function session(
	taskId: string,
	agentId: "codex" | "omp" | null,
	liveness: "live" | "exited",
): RuntimeTaskSessionSummary {
	return {
		taskId,
		agentId,
		state: "running",
		turnOwner: "agent",
		liveness,
		userTurnKind: null,
		workspacePath: "/isolated",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("宿主机统一负载采样", () => {
	const snapshots: RuntimeSystemLoadAndRuntimeStatusSnapshot[] = [];
	let stop: (() => void) | undefined;
	const listAgentSessionSummaries = vi.fn(() => [] as RuntimeTaskSessionSummary[]);
	const start = () => {
		stop = startRuntimeSystemLoadAndRuntimeStatusSampler({
			dataDirectoryPath: "/isolated/kanban",
			listAgentSessionSummaries,
			onSnapshot: (snapshot) => snapshots.push(snapshot),
		});
	};
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetAllMocks();
		snapshots.length = 0;
		vi.mocked(cpus).mockReturnValue([cpuTimes(100, 100), cpuTimes(100, 100)]);
		vi.mocked(totalmem).mockReturnValue(32_000);
		vi.mocked(freemem).mockReturnValue(12_000);
		vi.mocked(statfs).mockResolvedValue({ bsize: 4, bavail: 30, blocks: 100 } as Awaited<ReturnType<typeof statfs>>);
		listAgentSessionSummaries.mockReturnValue([]);
	});
	afterEach(() => {
		stop?.();
		vi.useRealTimers();
	});

	it("首样本 CPU 未知，随后按整机容量计算差值，磁盘使用可分配余量", async () => {
		start();
		await vi.advanceTimersByTimeAsync(0);
		expect(snapshots[0]).toMatchObject({
			cpuUsagePercent: null,
			memory: { usedBytes: 20_000, totalBytes: 32_000 },
			disk: { availableBytes: 120, totalBytes: 400 },
			liveAgentSessionCount: 0,
		});
		vi.mocked(cpus).mockReturnValue([cpuTimes(150, 150), cpuTimes(200, 100)]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(snapshots[1].cpuUsagePercent).toBe(25);
		expect(snapshots[1].runtimeUptimeSeconds).toBeGreaterThanOrEqual(0);
		expect(statfs).toHaveBeenCalledWith("/isolated/kanban");
	});

	it("每项独立失败并在下轮恢复，CPU 失败后重新建立基线", async () => {
		vi.mocked(cpus).mockImplementationOnce(() => {
			throw new Error("CPU 不可读");
		});
		vi.mocked(freemem).mockImplementationOnce(() => {
			throw new Error("内存不可读");
		});
		vi.mocked(statfs).mockRejectedValueOnce(new Error("磁盘不可读"));
		listAgentSessionSummaries.mockImplementationOnce(() => {
			throw new Error("会话不可读");
		});
		start();
		await vi.advanceTimersByTimeAsync(0);
		expect(snapshots[0]).toMatchObject({
			cpuUsagePercent: null,
			memory: null,
			disk: null,
			liveAgentSessionCount: null,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(snapshots[1]).toMatchObject({
			cpuUsagePercent: null,
			memory: { usedBytes: 20_000 },
			disk: { availableBytes: 120 },
			liveAgentSessionCount: 0,
		});
		vi.mocked(cpus).mockReturnValue([cpuTimes(200, 200), cpuTimes(200, 200)]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(snapshots[2].cpuUsagePercent).toBe(50);
	});

	it("统计主、侧、首页及 ACP 活跃 Agent，排除 shell 与已退出会话，并以 facet 为准", async () => {
		listAgentSessionSummaries.mockReturnValue([
			session("main", "codex", "live"),
			session("side", "codex", "live"),
			session("__home_agent__:codex", "codex", "live"),
			session("acp", "omp", "live"),
			session("shell", null, "live"),
			session("exited", "codex", "exited"),
		]);
		start();
		await vi.advanceTimersByTimeAsync(0);
		expect(snapshots[0].liveAgentSessionCount).toBe(4);
	});

	it("CPU 数量变化、计数回退或零间隔时不捏造使用率", async () => {
		start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(snapshots[1].cpuUsagePercent).toBeNull();
		vi.mocked(cpus).mockReturnValue([cpuTimes(200, 200)]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(snapshots[2].cpuUsagePercent).toBeNull();
		vi.mocked(cpus).mockReturnValue([cpuTimes(1, 1)]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(snapshots[3].cpuUsagePercent).toBeNull();
	});

	it("慢采样不重叠，停止时不发布尚未完成的采样", async () => {
		let finishDiskRead: ((value: Awaited<ReturnType<typeof statfs>>) => void) | undefined;
		vi.mocked(statfs).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishDiskRead = resolve;
				}),
		);
		start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(statfs).toHaveBeenCalledTimes(1);
		stop?.();
		finishDiskRead?.({ bsize: 4, bavail: 30, blocks: 100 } as Awaited<ReturnType<typeof statfs>>);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(snapshots).toHaveLength(0);
	});
});
