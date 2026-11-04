import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	cancelOwnedCommandProcesses,
	inspectOwnedCommandSupervisor,
	readSystemBootIdentity,
} from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

const nativeIdentityFailureSimulation = vi.hoisted(() => ({ sameSecondReuse: false }));

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	execFile: (
		_command: string,
		arguments_: string[],
		_options: unknown,
		callback: (error: Error | null, result?: { stdout: string }) => void,
	) => {
		if (_command === "sysctl") return callback(null, { stdout: "same-boot" });
		if (arguments_[1] === "301")
			return callback(null, {
				stdout: nativeIdentityFailureSimulation.sameSecondReuse
					? "Wed Oct 28 12:00:00 2026 unrelated-reused-pid"
					: "Wed Oct 28 12:01:00 2026 unrelated-reused-pid",
			});
		callback(Object.assign(new Error("原进程不存在"), { code: 1 }));
	},
}));

it("PID 被其他启动代际复用时不发送信号，也不能据此证明原执行全体退出", async () => {
	const sandbox = createTempDir("owned-supervisor-pid-reuse-");
	const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
	try {
		const directory = join(sandbox.path, "supervisor-artifacts");
		await mkdir(directory);
		for (const [name, value] of Object.entries({
			"supervisor-identity-nonce.json": { pid: 201, startAndCommand: "Wed Oct 28 12:00:00 2026 supervisor" },
			"launch-materials-nonce.json": { systemBootIdentity: await readSystemBootIdentity() },
			"supervisor-progress-nonce.json": {
				status: "running",
				ownedProcesses: [{ pid: 301, startAndCommand: "Wed Oct 28 12:00:00 2026 original-descendant" }],
			},
		}))
			await writeFile(join(directory, name), JSON.stringify(value));
		const reference = { workspaceId: "workspace", executionId: "execution", launchNonce: "nonce" };
		await cancelOwnedCommandProcesses(
			{
				...reference,
				previousLaunchNonces: [],
				revocationFile: join(directory, "revoked.json"),
				specification: { workingDirectory: directory },
			},
			{ artifactDirectory: directory },
		);
		expect(kill).not.toHaveBeenCalled();
		expect(await inspectOwnedCommandSupervisor(reference, { artifactDirectory: directory })).toBe("unknown");
	} finally {
		kill.mockRestore();
		sandbox.cleanup();
	}
});

it("新 PDV 的原生 probe 不可用时，即使秒级 lstart 相同也不允许 runtime cancel 发信号", async () => {
	const sandbox = createTempDir("owned-supervisor-precise-native-unavailable-");
	const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
	nativeIdentityFailureSimulation.sameSecondReuse = true;
	try {
		const directory = join(sandbox.path, "supervisor-artifacts");
		await mkdir(directory);
		const expected = { pid: 301, startAndCommand: "Wed Oct 28 12:00:00 2026 original-command" };
		for (const [name, value] of Object.entries({
			"supervisor-identity-nonce.json": { pid: 201, startAndCommand: "Wed Oct 28 12:00:00 2026 supervisor" },
			"launch-materials-nonce.json": {
				systemBootIdentity: await readSystemBootIdentity(),
				superviseProcessGroup: true,
				darwinOriginalParentGenerationProbePath: null,
			},
			"supervisor-progress-nonce.json": { status: "running", ownedProcesses: [expected] },
		}))
			await writeFile(join(directory, name), JSON.stringify(value));
		const reference = { workspaceId: "workspace", executionId: "execution", launchNonce: "nonce" };
		const observed = await cancelOwnedCommandProcesses(
			{
				...reference,
				previousLaunchNonces: [],
				revocationFile: join(directory, "revoked.json"),
				specification: { workingDirectory: directory },
			},
			{ artifactDirectory: directory },
		);
		expect(kill).not.toHaveBeenCalled();
		expect(JSON.stringify(observed)).toContain("precise_native_process_generation_unavailable_no_signal");
		expect(await inspectOwnedCommandSupervisor(reference, { artifactDirectory: directory })).toBe("unknown");
	} finally {
		nativeIdentityFailureSimulation.sameSecondReuse = false;
		kill.mockRestore();
		sandbox.cleanup();
	}
});
