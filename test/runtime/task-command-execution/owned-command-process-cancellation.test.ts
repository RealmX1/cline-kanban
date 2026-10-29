import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelOwnedCommandProcesses } from "../../../src/task-command-execution/task-command-execution-supervisor";

const isolatedProcesses = vi.hoisted(() => ({
	directory: "",
	identity: "Wed Oct 28 12:00:00 2026 original-owned-process",
}));
vi.mock("../../../src/task-command-execution/task-command-execution-store", () => ({
	taskCommandExecutionArtifactDirectory: () => isolatedProcesses.directory,
}));
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	execFile: (
		_command: string,
		_arguments: string[],
		_options: unknown,
		callback: (error: null, value: { stdout: string }) => void,
	) => {
		callback(null, { stdout: isolatedProcesses.identity });
	},
}));
beforeEach(async () => {
	isolatedProcesses.directory = await mkdtemp(join(tmpdir(), "owned-process-force-termination-"));
	isolatedProcesses.identity = "Wed Oct 28 12:00:00 2026 original-owned-process";
	await writeFile(
		join(isolatedProcesses.directory, "supervisor-progress-nonce.json"),
		JSON.stringify({ ownedProcesses: [{ pid: 123456, startAndCommand: isolatedProcesses.identity }] }),
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(isolatedProcesses.directory, { recursive: true, force: true });
});
function cancellationRecord(previousLaunchNonces: string[] = []) {
	return {
		workspaceId: "workspace",
		executionId: "execution",
		launchNonce: "nonce",
		previousLaunchNonces,
		revocationFile: join(isolatedProcesses.directory, "revocation.json"),
		specification: { workingDirectory: isolatedProcesses.directory },
	};
}
describe("所属进程取消的强制终止与身份复核", () => {
	it.each(["unchanged", "command_changed", "pid_reused"])("宽限后重新核验进程代际，变化=%s", async (change) => {
		const identityChanges = change === "pid_reused";
		if (change === "command_changed") isolatedProcesses.identity = "Wed Oct 28 12:00:00 2026 execed-worker";
		const signal = vi.spyOn(process, "kill").mockImplementation((_pid, requestedSignal) => {
			if (identityChanges && requestedSignal === "SIGTERM")
				isolatedProcesses.identity = "Wed Oct 28 12:00:01 2026 reused-process-identity";
			return true;
		});
		const record = cancellationRecord();
		const observation = await cancelOwnedCommandProcesses(record);
		expect(signal.mock.calls).toEqual(
			identityChanges
				? [[123456, "SIGTERM"]]
				: [
						[123456, "SIGTERM"],
						[123456, "SIGKILL"],
					],
		);
		expect(JSON.stringify(observation)).toContain(
			identityChanges ? "identity_changed_no_signal" : "force_termination_requested",
		);
		expect(await readFile(join(isolatedProcesses.directory, "supervisor-progress-nonce.json"), "utf8")).toContain(
			"original-owned-process",
		);
	});

	it("取消同一执行全部已登记启动，不因一次恢复丢失旧 worker 的归属", async () => {
		await writeFile(
			join(isolatedProcesses.directory, "supervisor-progress-previous-nonce.json"),
			JSON.stringify({
				ownedProcesses: [{ pid: 123455, startAndCommand: isolatedProcesses.identity }],
			}),
		);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		await cancelOwnedCommandProcesses(cancellationRecord(["previous-nonce"]));
		expect(signal.mock.calls).toEqual(
			expect.arrayContaining([
				[123455, "SIGTERM"],
				[123455, "SIGKILL"],
				[123456, "SIGTERM"],
				[123456, "SIGKILL"],
			]),
		);
	});

	it("无法解析启动时刻的相同字符串不授予终止资格", async () => {
		isolatedProcesses.identity = "无法证明启动时刻";
		await writeFile(
			join(isolatedProcesses.directory, "supervisor-progress-nonce.json"),
			JSON.stringify({
				ownedProcesses: [{ pid: 123456, startAndCommand: isolatedProcesses.identity }],
			}),
		);
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		await cancelOwnedCommandProcesses(cancellationRecord());
		expect(signal).not.toHaveBeenCalled();
	});
});
