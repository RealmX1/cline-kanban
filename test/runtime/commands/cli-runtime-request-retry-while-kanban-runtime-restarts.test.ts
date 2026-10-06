// CLI 写动词在 runtime 热重启窗口内等待重试：只重试「确定没发出」的 ECONNREFUSED，且只在有重启证据时。
import { describe, expect, it, vi } from "vitest";
import {
	type CliRuntimeRequestRetryWhileKanbanRuntimeRestartsDependencies,
	MAXIMUM_WAIT_FOR_RESTARTING_KANBAN_RUNTIME_MS,
	readKanbanRuntimeRestartInProgressEvidence,
	retryCliRuntimeRequestWhileKanbanRuntimeRestarts,
} from "../../../src/commands/cli-runtime-request-retry-while-kanban-runtime-restarts";

function buildRuntimeConnectionRefusedError(): Error {
	const systemError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3484"), { code: "ECONNREFUSED" });
	return new TypeError("fetch failed", { cause: systemError });
}

// 假时钟：每次 sleep 把时钟往前拨，不真等。
function createFakeClockDependencies(restartEvidence: string | null) {
	let nowEpochMs = 1_700_000_000_000;
	const stderrWrites: string[] = [];
	const dependencies: CliRuntimeRequestRetryWhileKanbanRuntimeRestartsDependencies = {
		readNowEpochMs: () => nowEpochMs,
		sleep: async (milliseconds) => {
			nowEpochMs += milliseconds;
		},
		writeStderr: (text) => stderrWrites.push(text),
		readKanbanRuntimeRestartInProgressEvidence: vi.fn(async () => restartEvidence),
	};
	return { dependencies, stderrWrites };
}

describe("retryCliRuntimeRequestWhileKanbanRuntimeRestarts", () => {
	it("waits for a restarting runtime and announces the wait once", async () => {
		const { dependencies, stderrWrites } = createFakeClockDependencies("runtime 已离开 2s");
		let attempt = 0;
		const performRuntimeRequest = vi.fn(async () => {
			attempt += 1;
			if (attempt <= 3) {
				throw buildRuntimeConnectionRefusedError();
			}
			return "delivered";
		});

		await expect(retryCliRuntimeRequestWhileKanbanRuntimeRestarts(performRuntimeRequest, dependencies)).resolves.toBe(
			"delivered",
		);

		expect(performRuntimeRequest).toHaveBeenCalledTimes(4);
		expect(stderrWrites).toHaveLength(1);
		expect(stderrWrites[0]).toContain("Kanban runtime 正在重启");
	});

	it("fails at once without restart evidence, exactly as before", async () => {
		const { dependencies, stderrWrites } = createFakeClockDependencies(null);
		const performRuntimeRequest = vi.fn(async () => {
			throw buildRuntimeConnectionRefusedError();
		});

		await expect(
			retryCliRuntimeRequestWhileKanbanRuntimeRestarts(performRuntimeRequest, dependencies),
		).rejects.toThrow("fetch failed");

		expect(performRuntimeRequest).toHaveBeenCalledTimes(1);
		expect(stderrWrites).toEqual([]);
	});

	it("never retries a request that may have been sent (timeout / reset)", async () => {
		const { dependencies } = createFakeClockDependencies("runtime 已离开 2s");
		const performRuntimeRequest = vi.fn(async () => {
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
			});
		});

		await expect(
			retryCliRuntimeRequestWhileKanbanRuntimeRestarts(performRuntimeRequest, dependencies),
		).rejects.toThrow("fetch failed");

		expect(performRuntimeRequest).toHaveBeenCalledTimes(1);
		expect(dependencies.readKanbanRuntimeRestartInProgressEvidence).not.toHaveBeenCalled();
	});

	it("gives up once the runtime has not come back within the wait bound", async () => {
		const { dependencies } = createFakeClockDependencies("runtime 已离开 2s");
		const performRuntimeRequest = vi.fn(async () => {
			throw buildRuntimeConnectionRefusedError();
		});

		await expect(
			retryCliRuntimeRequestWhileKanbanRuntimeRestarts(performRuntimeRequest, dependencies),
		).rejects.toThrow("fetch failed");

		expect(performRuntimeRequest.mock.calls.length).toBeGreaterThan(1);
		expect(dependencies.readNowEpochMs() - 1_700_000_000_000).toBeGreaterThanOrEqual(
			MAXIMUM_WAIT_FOR_RESTARTING_KANBAN_RUNTIME_MS,
		);
	});
});

describe("readKanbanRuntimeRestartInProgressEvidence", () => {
	it("has no evidence outside a hosted session", async () => {
		expect(await readKanbanRuntimeRestartInProgressEvidence({}, Date.now())).toBeNull();
	});

	it("has no evidence when the session's agent session pty host is unreachable", async () => {
		expect(
			await readKanbanRuntimeRestartInProgressEvidence(
				{
					KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH: "/tmp/kanban-nonexistent-agent-session-pty-host.sock",
					KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY: "hosted-session-1",
				},
				Date.now(),
			),
		).toBeNull();
	});
});
