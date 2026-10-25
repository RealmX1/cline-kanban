import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAllProjectsTaskGroupQueryCommands } from "../../../src/commands/task-all-projects-group-query";

afterEach(() => {
	process.exitCode = undefined;
});

function commandHarness() {
	const outputs: unknown[] = [];
	const querySnapshot = vi.fn(async () => ({ observedAtMs: 1, recentDays: 7 as const, projects: [] }));
	const listSingleProjectTasks = vi.fn(async () => ({ ok: true, tasks: [], workspacePath: "/legacy" }));
	const program = new Command();
	registerAllProjectsTaskGroupQueryCommands(program.command("task"), {
		querySnapshot,
		listSingleProjectTasks,
		runTaskCommand: async (handler) => {
			try {
				outputs.push(await handler());
			} catch (error) {
				outputs.push({ ok: false, error: String(error) });
				process.exitCode = 1;
			}
		},
	});
	return {
		outputs,
		querySnapshot,
		listSingleProjectTasks,
		run: (args: string[]) => program.parseAsync(["node", "kanban", "task", ...args]),
	};
}

describe("任务分组 CLI 接口与兼容性", () => {
	it.each([
		["SIGINT", ["watch", "--all-projects", "--group", "running"]],
		["SIGTERM", ["watch", "--all-projects", "--group", "running"]],
		["SIGINT", ["watch", "--all-projects", "--exit-when-empty"]],
		["SIGTERM", ["watch", "--all-projects", "--exit-when-empty"]],
	] as const)("%s 可取消未回调的 stdout 写入，包含参数错误的输出：%j", async (signalName, args) => {
		vi.useFakeTimers();
		const previousSignalListeners = process.listeners(signalName);
		let interrupted = false;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			if (!interrupted) {
				interrupted = true;
				process.listeners(signalName).find((listener) => !previousSignalListeners.includes(listener))?.(signalName);
			}
			return false;
		});
		try {
			const runningCommand = commandHarness().run([...args]);
			await vi.runAllTimersAsync();
			await runningCommand;
			expect(interrupted).toBe(true);
			expect(process.exitCode).toBe(signalName === "SIGTERM" ? 143 : 130);
			expect(process.listeners(signalName)).toEqual(previousSignalListeners);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			write.mockRestore();
			vi.useRealTimers();
		}
	});

	it("缺少完整性信息的旧响应必须失败，不能将默认空数据当作成功", async () => {
		const harness = commandHarness();
		harness.querySnapshot.mockResolvedValue({
			observedAtMs: 1,
			recentDays: 7,
			projects: [{ workspaceId: "old", crossProjectTaskSwitcherEntries: [] }],
		} as never);
		await harness.run(["list", "--all-projects", "--group", "running"]);
		expect(process.exitCode).toBe(1);
		expect(harness.outputs[0]).toMatchObject({ ok: false, error: expect.stringContaining("完整性") });
	});

	it("旧 runtime 无 procedure 时给出明确兼容性错误", async () => {
		const harness = commandHarness();
		harness.querySnapshot.mockRejectedValue({ data: { code: "NOT_FOUND" } });
		await harness.run(["list", "--all-projects"]);
		expect(process.exitCode).toBe(1);
		expect(harness.outputs[0]).toMatchObject({ ok: false, error: expect.stringContaining("不支持") });
	});
	it("既有单项目 list 继续走原读取与输出，完全不查询全项目快照", async () => {
		const harness = commandHarness();
		await harness.run(["list", "--project-path", "/legacy", "--column", "done"]);
		expect(harness.listSingleProjectTasks).toHaveBeenCalledWith({ projectPath: "/legacy", column: "trash" });
		expect(harness.querySnapshot).not.toHaveBeenCalled();
	});

	it("全项目查询不解析调用者 cwd，完整空快照是有效结果", async () => {
		const harness = commandHarness();
		await harness.run(["list", "--all-projects", "--group", "running"]);
		expect(harness.listSingleProjectTasks).not.toHaveBeenCalled();
		expect(harness.outputs[0]).toMatchObject({ ok: true, count: 0, groups: [{ group: "running", tasks: [] }] });
	});

	it.each([
		["list", "--group", "running"],
		["list", "--all-projects", "--project-path", "/legacy"],
		["list", "--query", "needle"],
		["watch", "--all-projects", "--exit-when-empty"],
	])("拒绝有歧义的参数组合 %j", async (...args) => {
		const harness = commandHarness();
		await harness.run(args);
		expect(process.exitCode).toBe(1);
		expect(harness.querySnapshot).not.toHaveBeenCalled();
	});
});
