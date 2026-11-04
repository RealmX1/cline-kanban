import type * as FileSystemPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCommandExecutionRecord } from "../../../src/core/task-command-execution-contract";
import { inspectOwnedCommandSupervisor } from "../../../src/task-command-execution/task-command-execution-supervisor";

const machine = vi.hoisted(() => ({ directory: "", boot: "same-boot", liveDescendant: false, unreadable: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FileSystemPromises>();
	return {
		...actual,
		readFile: (...arguments_: Parameters<typeof actual.readFile>) =>
			arguments_[0] === "/proc/sys/kernel/random/boot_id"
				? Promise.resolve(machine.boot)
				: actual.readFile(...arguments_),
	};
});
vi.mock("../../../src/task-command-execution/task-command-execution-store", () => ({
	taskCommandExecutionArtifactDirectory: () => machine.directory,
}));
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	execFile: (
		command: string,
		arguments_: string[],
		_options: unknown,
		callback: (error: Error | null, result?: { stdout: string }) => void,
	) => {
		if (command === "sysctl") return callback(null, { stdout: machine.boot });
		if (machine.unreadable) return callback(Object.assign(new Error("不可读"), { code: "EPERM" }));
		if (arguments_[0] === "-axo") return callback(null, { stdout: "" });
		if (machine.liveDescendant && arguments_[1] === "301")
			return callback(null, { stdout: "Wed Oct 28 12:00:00 2026 owned-descendant" });
		callback(Object.assign(new Error("进程不存在"), { code: 1 }));
	},
}));
beforeEach(async () => {
	machine.directory = await mkdtemp(join(tmpdir(), "owned-supervisor-stale-progress-"));
	machine.boot = "same-boot";
	machine.liveDescendant = false;
	machine.unreadable = false;
	await mkdir(machine.directory, { recursive: true });
	for (const [name, value] of Object.entries({
		"supervisor-identity-nonce.json": {
			pid: 201,
			startAndCommand: "Wed Oct 28 12:00:00 2026 owned-supervisor",
			launchNonce: "nonce",
		},
		"launch-materials-nonce.json": { systemBootIdentity: "same-boot" },
		"supervisor-progress-nonce.json": {
			status: "running",
			ownedProcesses: [{ pid: 301, startAndCommand: "Wed Oct 28 12:00:00 2026 owned-descendant" }],
		},
	}))
		await writeFile(join(machine.directory, name), JSON.stringify(value));
});
afterEach(async () => {
	await rm(machine.directory, { recursive: true, force: true });
});
const record = {
	workspaceId: "workspace",
	executionId: "execution",
	launchNonce: "nonce",
} as TaskCommandExecutionRecord;
describe("监督者失联后的替代进程身份证据", () => {
	it.each([false, true])("缺少首份进度且身份原件缺失为 %s 时，启动材料阻止误判未启动", async (missingIdentity) => {
		await rm(join(machine.directory, "supervisor-progress-nonce.json"));
		if (missingIdentity) await rm(join(machine.directory, "supervisor-identity-nonce.json"));
		machine.liveDescendant = true;
		expect(await inspectOwnedCommandSupervisor(record)).toBe("unknown");
	});
	it("没有启动材料、监督者身份或进程时才判定尚未启动", async () => {
		for (const name of [
			"supervisor-progress-nonce.json",
			"supervisor-identity-nonce.json",
			"launch-materials-nonce.json",
		])
			await rm(join(machine.directory, name));
		expect(await inspectOwnedCommandSupervisor(record)).toBe("not_started");
	});
	it("同一开机身份与过期快照不能排除未登记孤儿，保持 unknown", async () => {
		expect(await inspectOwnedCommandSupervisor(record)).toBe("unknown");
		expect(await inspectOwnedCommandSupervisor(record)).toBe("unknown");
	});
	it("新的开机身份证明旧进程已经退出", async () => {
		machine.boot = "new-boot";
		expect(await inspectOwnedCommandSupervisor(record)).toBe("exited");
	});
	it.each(["exited", "cancelled"])("监督者终结原件 %s 允许恢复", async (status) => {
		await writeFile(
			join(machine.directory, "supervisor-progress-nonce.json"),
			JSON.stringify({ status, ownedProcesses: [] }),
		);
		expect(await inspectOwnedCommandSupervisor(record)).toBe("exited");
	});
	it("所属后代仍存活时保持 running", async () => {
		machine.liveDescendant = true;
		expect(await inspectOwnedCommandSupervisor(record)).toBe("running");
	});
	it("进程查询失败时保留 unknown", async () => {
		machine.unreadable = true;
		expect(await inspectOwnedCommandSupervisor(record)).toBe("unknown");
	});
});
