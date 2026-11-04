import { expect, it, vi } from "vitest";
import { inspectOwnedCommandSupervisor } from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	execFile: (
		_command: string,
		_arguments: string[],
		options: { maxBuffer?: number },
		callback: (error: Error | null, result?: { stdout: string }) => void,
	) => {
		const stdout = "unrelated-process-with-large-arguments\n".repeat(50_000);
		if ((options.maxBuffer ?? 1024 * 1024) < Buffer.byteLength(stdout))
			return callback(
				Object.assign(new Error("原生进程表超过默认输出容量"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
			);
		callback(null, { stdout });
	},
}));

it("超过 1MiB 的原生进程表不会把首次派发误判成已启动未知", async () => {
	const sandbox = createTempDir("owned-supervisor-initial-observation-capacity-");
	try {
		expect(
			await inspectOwnedCommandSupervisor(
				{ workspaceId: "workspace", executionId: "execution", launchNonce: "nonce" },
				{ artifactDirectory: sandbox.path, preventRedispatch: true, superviseProcessGroup: true },
			),
		).toBe("not_started");
	} finally {
		sandbox.cleanup();
	}
});
