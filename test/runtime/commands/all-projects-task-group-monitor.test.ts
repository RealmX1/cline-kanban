import { describe, expect, it, vi } from "vitest";
import {
	type AllProjectsTaskGroupMonitorEvent,
	AllProjectsTaskGroupQueryRuntimeCompatibilityError,
	runAllProjectsTaskGroupMonitor,
} from "../../../src/commands/all-projects-task-group-monitor";
import type { RuntimeAllProjectsTaskGroupQuerySnapshot } from "../../../src/core/api-contract";

const emptySnapshot: RuntimeAllProjectsTaskGroupQuerySnapshot = { observedAtMs: 1, recentDays: 7, projects: [] };
const incompleteSnapshot: RuntimeAllProjectsTaskGroupQuerySnapshot = {
	...emptySnapshot,
	projects: [
		{
			workspaceId: "unknown",
			projectName: "未知",
			projectPath: "/unknown",
			taskEntriesReadStatus: "unavailable",
			unavailableReason: "看板无法读取",
			crossProjectTaskSwitcherEntries: [],
		},
	],
};

function monitorHarness() {
	let nowMs = 0;
	const controller = new AbortController();
	const events: AllProjectsTaskGroupMonitorEvent[] = [];
	const delays: number[] = [];
	return {
		controller,
		events,
		delays,
		dependencies: {
			filters: { group: "running" as const },
			intervalMs: 5_000,
			exitWhenEmpty: true,
			signal: controller.signal,
			now: () => nowMs,
			emit: async (event: AllProjectsTaskGroupMonitorEvent) => {
				events.push(event);
			},
			wait: async (durationMs: number) => {
				delays.push(durationMs);
				nowMs += durationMs;
			},
		},
	};
}

describe("全项目任务组持续监控", () => {
	it("不兼容 runtime 明确失败，不进入空结果确认或反复重试", async () => {
		const harness = monitorHarness();
		const querySnapshot = vi.fn(async () => {
			throw new AllProjectsTaskGroupQueryRuntimeCompatibilityError("缺少新接口");
		});
		expect(await runAllProjectsTaskGroupMonitor({ ...harness.dependencies, querySnapshot })).toBe(1);
		expect(querySnapshot).toHaveBeenCalledTimes(1);
		expect(harness.delays).toEqual([]);
		expect(harness.events.at(-1)).toMatchObject({ reason: "runtime_incompatible" });
	});

	it("不响应的读取也受单次超时和剩余恢复预算约束，结束时不残留计时器", async () => {
		vi.useFakeTimers();
		try {
			const harness = monitorHarness();
			const requestSignals: AbortSignal[] = [];
			const querySnapshot = vi.fn((signal: AbortSignal) => {
				requestSignals.push(signal);
				return new Promise<RuntimeAllProjectsTaskGroupQuerySnapshot>(() => {});
			});
			const result = runAllProjectsTaskGroupMonitor({
				...harness.dependencies,
				querySnapshot,
				now: Date.now,
				wait: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
			});
			await vi.runAllTimersAsync();
			expect(await result).toBe(1);
			expect(querySnapshot).toHaveBeenCalledTimes(2);
			expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it("完整空结果须连续两次；服务故障及部分覆盖均重置确认", async () => {
		const harness = monitorHarness();
		const querySnapshot = vi
			.fn()
			.mockResolvedValueOnce(emptySnapshot)
			.mockRejectedValueOnce(new Error("运行时暂不可达"))
			.mockResolvedValueOnce(emptySnapshot)
			.mockResolvedValueOnce(incompleteSnapshot)
			.mockResolvedValue(emptySnapshot);
		expect(await runAllProjectsTaskGroupMonitor({ ...harness.dependencies, querySnapshot })).toBe(0);
		expect(querySnapshot).toHaveBeenCalledTimes(6);
		expect(harness.events.at(-1)).toMatchObject({
			eventType: "all_projects_task_group_monitor_stopped",
			reason: "selected_result_empty_confirmed",
			exitCode: 0,
		});
		expect(harness.events.some((event) => event.eventType === "all_projects_task_group_query_unavailable")).toBe(
			true,
		);
	});

	it("持续不可读按同一预算有界重试，不把部分覆盖当作空成功", async () => {
		const harness = monitorHarness();
		const querySnapshot = vi.fn(async () => incompleteSnapshot);
		expect(await runAllProjectsTaskGroupMonitor({ ...harness.dependencies, querySnapshot })).toBe(1);
		expect(harness.delays.slice(0, 3)).toEqual([2_000, 5_000, 10_000]);
		expect(harness.delays.reduce((sum, delay) => sum + delay, 0)).toBe(60_000);
		expect(harness.events.at(-1)).toMatchObject({ reason: "query_unavailable_budget_exhausted", exitCode: 1 });
	});

	it("默认不因空结果退出，运行超过普通 CLI 超时仍可观察；SIGTERM 可中断", async () => {
		const harness = monitorHarness();
		const querySnapshot = vi.fn(async () => {
			if (harness.delays.length >= 8) harness.controller.abort("SIGTERM");
			return emptySnapshot;
		});
		expect(
			await runAllProjectsTaskGroupMonitor({ ...harness.dependencies, exitWhenEmpty: false, querySnapshot }),
		).toBe(143);
		expect(harness.delays.reduce((sum, delay) => sum + delay, 0)).toBe(40_000);
	});

	it("中断会取消尚未完成的读取，即使读取器没有响应取消也能退出", async () => {
		const harness = monitorHarness();
		let requestSignal: AbortSignal | undefined;
		const result = runAllProjectsTaskGroupMonitor({
			...harness.dependencies,
			querySnapshot: (signal) => {
				requestSignal = signal;
				return new Promise(() => {});
			},
		});
		await Promise.resolve();
		harness.controller.abort("SIGINT");
		expect(await result).toBe(130);
		expect(requestSignal?.aborted).toBe(true);
	});

	it.each([
		"all_projects_task_group_snapshot",
		"all_projects_task_group_query_unavailable",
		"selected_result_empty_confirmed",
		"runtime_incompatible",
		"query_unavailable_budget_exhausted",
		"interrupted",
	] as const)("输出停在 %s 时，两种中断均能结束且不残留计时器", async (blockedOutputPhase) => {
		vi.useFakeTimers();
		try {
			for (const signalName of ["SIGINT", "SIGTERM"]) {
				const harness = monitorHarness();
				if (blockedOutputPhase === "interrupted") harness.controller.abort(signalName);
				let exitCode: number | undefined;
				const outputSignals: AbortSignal[] = [];
				void runAllProjectsTaskGroupMonitor({
					...harness.dependencies,
					querySnapshot: async () => {
						if (blockedOutputPhase === "runtime_incompatible")
							throw new AllProjectsTaskGroupQueryRuntimeCompatibilityError("接口不兼容");
						if (
							blockedOutputPhase === "all_projects_task_group_query_unavailable" ||
							blockedOutputPhase === "query_unavailable_budget_exhausted"
						)
							throw new Error("运行时暂不可达");
						return emptySnapshot;
					},
					emit: async (event, signal) => {
						harness.events.push(event);
						if (
							event.eventType !== blockedOutputPhase &&
							!(
								event.eventType === "all_projects_task_group_monitor_stopped" &&
								(event.reason === blockedOutputPhase || event.reason === "interrupted")
							)
						)
							return;
						outputSignals.push(signal);
						harness.controller.abort(signalName);
						return new Promise(() => {});
					},
				}).then((result) => {
					exitCode = result;
				});
				await vi.runAllTimersAsync();
				expect(exitCode).toBe(signalName === "SIGTERM" ? 143 : 130);
				expect(harness.events.at(-1)).toMatchObject({ reason: "interrupted", exitCode });
				expect(outputSignals.length).toBeGreaterThan(0);
				expect(outputSignals.every((signal) => signal.aborted)).toBe(true);
				expect(vi.getTimerCount()).toBe(0);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("正常慢输出没有中断预算，完整写完后才继续下一次查询与停止事件", async () => {
		vi.useFakeTimers();
		try {
			const harness = monitorHarness();
			let completeFirstSnapshotOutput = () => {};
			let exitCode: number | undefined;
			const querySnapshot = vi.fn(async () => emptySnapshot);
			const result = runAllProjectsTaskGroupMonitor({
				...harness.dependencies,
				querySnapshot,
				emit: async (event) => {
					harness.events.push(event);
					if (harness.events.length === 1)
						await new Promise<void>((resolve) => {
							completeFirstSnapshotOutput = resolve;
						});
				},
			}).then((value) => {
				exitCode = value;
			});
			await vi.advanceTimersByTimeAsync(60_000);
			expect(exitCode).toBeUndefined();
			expect(querySnapshot).toHaveBeenCalledTimes(1);
			completeFirstSnapshotOutput();
			await result;
			expect(exitCode).toBe(0);
			expect(harness.events.map((event) => event.eventType)).toEqual([
				"all_projects_task_group_snapshot",
				"all_projects_task_group_snapshot",
				"all_projects_task_group_monitor_stopped",
			]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
