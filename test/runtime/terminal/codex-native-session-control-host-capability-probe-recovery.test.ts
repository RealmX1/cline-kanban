import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PreparedCodexNativeSessionControlHostLaunch,
	prepareCodexNativeSessionControlHostLaunch,
} from "../../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";

interface CapabilityHelpResponse {
	stdout: string;
	stderr: string;
}

const controlledProbeState = vi.hoisted(() => ({
	runtimeHomeDirectoryPath: "",
	commands: [] as { binary: string; arguments: readonly string[] }[],
	respond: async (_binary: string, _arguments: readonly string[]): Promise<CapabilityHelpResponse> => ({
		stdout: "--remote --listen unix://PATH",
		stderr: "",
	}),
}));

vi.mock("node:child_process", () => ({
	execFile: (
		binary: string,
		arguments_: readonly string[],
		_options: unknown,
		callback: (error: Error | null, response?: CapabilityHelpResponse) => void,
	) => {
		controlledProbeState.commands.push({ binary, arguments: arguments_ });
		controlledProbeState.respond(binary, arguments_).then(
			(response) => callback(null, response),
			(error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
		);
	},
}));

vi.mock("../../../src/state/runtime-home-path", () => ({
	getRuntimeHomePath: () => controlledProbeState.runtimeHomeDirectoryPath,
}));

let probeClockNowMs = 0;
const preparedLaunches: PreparedCodexNativeSessionControlHostLaunch[] = [];

beforeEach(async () => {
	controlledProbeState.runtimeHomeDirectoryPath = await mkdtemp(join(tmpdir(), "kanban-control-capability-recovery-"));
	controlledProbeState.commands = [];
	controlledProbeState.respond = async () => ({ stdout: "--remote --listen unix://PATH", stderr: "" });
	probeClockNowMs = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => probeClockNowMs);
});

afterEach(async () => {
	for (const launch of preparedLaunches.splice(0)) await launch.cleanup();
	await rm(controlledProbeState.runtimeHomeDirectoryPath, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function prepareWithControlledCapabilityProbe(binary: string) {
	const prepared = await prepareCodexNativeSessionControlHostLaunch({
		binary,
		arguments: [],
		workingDirectoryPath: controlledProbeState.runtimeHomeDirectoryPath,
		environment: { PATH: "/isolated-capability-probe-path" },
		workspaceId: "isolated-workspace",
		conversationSessionId: "isolated-session",
		runtimeSessionIncarnationId: randomUUID(),
	});
	if (prepared) preparedLaunches.push(prepared);
	return prepared;
}

describe.skipIf(process.platform === "win32")("Codex 原生控制能力探测的同进程失败恢复", () => {
	it.each(["spawn-failure", "help-timeout", "missing-capability", "app-server-help-failure"])(
		"%s：短期失败冷却，恢复后下一次合法启动重新获得端点",
		async (failureMode) => {
			const binary = `isolated-codex-${failureMode}`;
			controlledProbeState.respond = async (_binary, arguments_) => {
				if (failureMode === "app-server-help-failure" && !arguments_.includes("app-server"))
					return { stdout: "--remote unix://PATH", stderr: "" };
				if (failureMode === "missing-capability") return { stdout: "不支持控制宿主", stderr: "" };
				throw Object.assign(new Error("隔离能力探测的受控失败"), {
					code: failureMode === "help-timeout" ? "ETIMEDOUT" : "ENOENT",
				});
			};
			expect(await prepareWithControlledCapabilityProbe(binary)).toBeNull();
			const failedProbeCommandCount = failureMode === "app-server-help-failure" ? 2 : 1;
			expect(controlledProbeState.commands).toHaveLength(failedProbeCommandCount);

			controlledProbeState.respond = async () => ({ stdout: "--remote --listen unix://PATH", stderr: "" });
			probeClockNowMs += 29_999;
			expect(await prepareWithControlledCapabilityProbe(binary)).toBeNull();
			expect(controlledProbeState.commands).toHaveLength(failedProbeCommandCount);

			probeClockNowMs += 1;
			const recovered = await prepareWithControlledCapabilityProbe(binary);
			expect(recovered?.endpoint.conversationSessionId).toBe("isolated-session");
			expect(controlledProbeState.commands.slice(failedProbeCommandCount)).toEqual([
				{ binary, arguments: ["--help"] },
				{ binary, arguments: ["app-server", "--help"] },
			]);
		},
	);

	it("并发失败与冷却后的并发恢复共享探测，成功结果继续缓存", async () => {
		const binary = "isolated-codex-concurrent-recovery";
		let failFirstHelp!: (error: Error) => void;
		controlledProbeState.respond = () =>
			new Promise((_resolveHelp, rejectHelp) => {
				failFirstHelp = rejectHelp;
			});
		const firstFailure = prepareWithControlledCapabilityProbe(binary);
		const secondFailure = prepareWithControlledCapabilityProbe(binary);
		expect(controlledProbeState.commands).toHaveLength(1);
		failFirstHelp(new Error("隔离的瞬态探测失败"));
		expect(await Promise.all([firstFailure, secondFailure])).toEqual([null, null]);

		probeClockNowMs += 30_000;
		let completeRetriedHelp!: (response: CapabilityHelpResponse) => void;
		controlledProbeState.respond = async (_binary, arguments_) =>
			arguments_.includes("app-server")
				? { stdout: "--listen unix://PATH", stderr: "" }
				: new Promise((resolveHelp) => {
						completeRetriedHelp = resolveHelp;
					});
		const firstRecovery = prepareWithControlledCapabilityProbe(binary);
		const secondRecovery = prepareWithControlledCapabilityProbe(binary);
		expect(controlledProbeState.commands).toHaveLength(2);
		completeRetriedHelp({ stdout: "--remote unix://PATH", stderr: "" });
		const recovered = await Promise.all([firstRecovery, secondRecovery]);
		expect(recovered.every((launch) => launch !== null)).toBe(true);
		expect(recovered[0]?.endpoint.socketPath).not.toBe(recovered[1]?.endpoint.socketPath);
		expect(controlledProbeState.commands).toHaveLength(3);

		probeClockNowMs += 60_000;
		expect(await prepareWithControlledCapabilityProbe(binary)).not.toBeNull();
		expect(controlledProbeState.commands).toHaveLength(3);
	});
});
