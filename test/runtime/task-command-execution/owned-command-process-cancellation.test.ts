import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelOwnedCommandProcesses,
	readOwnedCommandCancellationEvidenceFingerprint,
} from "../../../src/task-command-execution/task-command-execution-supervisor";

const isolatedProcesses = vi.hoisted(() => ({
	directory: "",
	identity: "Wed Oct 28 12:00:00 2026 original-owned-process",
	producerCancelCalls: 0,
}));
vi.mock("../../../src/task-command-execution/task-command-execution-store", () => ({
	taskCommandExecutionArtifactDirectory: () => isolatedProcesses.directory,
}));
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	execFile: (
		command: string,
		arguments_: string[],
		_options: unknown,
		callback: (error: null, value: { stdout: string }) => void,
	) => {
		if (command === "producer-cancel") isolatedProcesses.producerCancelCalls++;
		callback(null, {
			stdout:
				command === "sysctl"
					? "isolated-system-boot-identity"
					: arguments_[0] === "-axo"
						? [123455, 123456].map((pid) => `${pid} S ${isolatedProcesses.identity}`).join("\n")
						: isolatedProcesses.identity,
		});
	},
}));
beforeEach(async () => {
	isolatedProcesses.directory = await mkdtemp(join(tmpdir(), "owned-process-force-termination-"));
	isolatedProcesses.identity = "Wed Oct 28 12:00:00 2026 original-owned-process";
	isolatedProcesses.producerCancelCalls = 0;
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
	it("原子重写相同进度及更新心跳不重置取消补证预算的证据指纹", async () => {
		const record = cancellationRecord();
		const fingerprint = await readOwnedCommandCancellationEvidenceFingerprint(record);
		for (let rewrite = 0; rewrite < 5; rewrite++) {
			const replacementPath = join(isolatedProcesses.directory, "supervisor-progress-replacement.json");
			await writeFile(
				replacementPath,
				JSON.stringify({
					ownedProcesses: [{ pid: 123456, startAndCommand: isolatedProcesses.identity }],
					updatedAtEpochMs: rewrite,
				}),
			);
			await rename(replacementPath, join(isolatedProcesses.directory, "supervisor-progress-nonce.json"));
			expect(await readOwnedCommandCancellationEvidenceFingerprint(record)).toBe(fingerprint);
		}
	});

	it("强监管取消重复写入相同补充身份不制造新的补证资格", async () => {
		const record = cancellationRecord();
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		await cancelOwnedCommandProcesses(record, { superviseProcessGroup: true });
		const fingerprint = await readOwnedCommandCancellationEvidenceFingerprint(record);
		for (let retry = 0; retry < 5; retry++) {
			await cancelOwnedCommandProcesses(record, { superviseProcessGroup: true });
			expect(await readOwnedCommandCancellationEvidenceFingerprint(record)).toBe(fingerprint);
		}
		expect(signal).not.toHaveBeenCalled();
	});

	it.each([
		"owned_generation",
		"native_probe_configuration",
		"supervision_mode",
		"native_observation",
		"file_readability",
	])("取消相关证据变化仍恢复补查资格，变化=%s", async (change) => {
		const record = cancellationRecord();
		await writeFile(
			join(isolatedProcesses.directory, "launch-materials-nonce.json"),
			JSON.stringify({ darwinOriginalParentGenerationProbePath: null }),
		);
		const fingerprint = await readOwnedCommandCancellationEvidenceFingerprint(record);
		if (change === "owned_generation") {
			await writeFile(
				join(isolatedProcesses.directory, "supervisor-progress-nonce.json"),
				JSON.stringify({
					ownedProcesses: [{ pid: 123456, startAndCommand: "Wed Oct 28 12:00:01 2026 new-owned-process" }],
				}),
			);
		} else if (change === "native_probe_configuration") {
			await writeFile(
				join(isolatedProcesses.directory, "launch-materials-nonce.json"),
				JSON.stringify({ darwinOriginalParentGenerationProbePath: "/isolated/native-process-probe" }),
			);
		} else if (change === "supervision_mode") {
			await writeFile(
				join(isolatedProcesses.directory, "launch-materials-nonce.json"),
				JSON.stringify({ superviseProcessGroup: true }),
			);
		} else if (change === "native_observation") {
			isolatedProcesses.identity = "Wed Oct 28 12:00:01 2026 reused-process-identity";
		} else {
			await writeFile(join(isolatedProcesses.directory, "supervisor-progress-nonce.json"), "invalid json");
		}
		expect(await readOwnedCommandCancellationEvidenceFingerprint(record)).not.toBe(fingerprint);
	});

	it("重复取消及重启补证不会重复运行生产方取消命令", async () => {
		vi.spyOn(process, "kill").mockReturnValue(true);
		const record = {
			...cancellationRecord(),
			specification: { workingDirectory: isolatedProcesses.directory, cancelCommand: ["producer-cancel"] },
		};
		await cancelOwnedCommandProcesses(record);
		await cancelOwnedCommandProcesses(record);
		await cancelOwnedCommandProcesses(record, { skipProducerCancelCommand: true });
		expect(isolatedProcesses.producerCancelCalls).toBe(1);
	});
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
