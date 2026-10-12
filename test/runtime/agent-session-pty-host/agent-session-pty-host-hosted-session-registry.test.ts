import { describe, expect, it, type Mock, vi } from "vitest";
import {
	AgentSessionPtyHostHostedSessionRegistry,
	type HostedPtyProcess,
	type SpawnHostedPtyProcess,
} from "../../../src/agent-session-pty-host/host-process/agent-session-pty-host-hosted-session-registry";
import type { SpawnHostedSessionRequestMessage } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";

type FakeHostedPtyProcess = HostedPtyProcess & {
	emitData(text: string): void;
	emitExit(exitCode: number, signal?: number): void;
	pause: Mock<() => void>;
	resume: Mock<() => void>;
};

function createFakeHostedPtyProcess(pid: number): FakeHostedPtyProcess {
	let dataListener: ((data: string | Buffer | Uint8Array) => void) | null = null;
	let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
	return {
		pid,
		onData: (listener) => {
			dataListener = listener;
		},
		onExit: (listener) => {
			exitListener = listener;
		},
		write: vi.fn<(data: string | Buffer) => void>(),
		resize: vi.fn<(cols: number, rows: number) => void>(),
		pause: vi.fn<() => void>(),
		resume: vi.fn<() => void>(),
		kill: vi.fn<(signal?: string) => void>(),
		emitData: (text) => dataListener?.(text),
		emitExit: (exitCode, signal) => exitListener?.({ exitCode, signal }),
	};
}

function buildSpawnRequest(hostedSessionKey: string): SpawnHostedSessionRequestMessage {
	return {
		type: "spawn_hosted_session_request",
		requestId: `request-${hostedSessionKey}`,
		hostedSessionKey,
		hostedSessionDescriptor: {
			workspaceId: "workspace-1",
			taskId: "task-1",
			hostedSessionKind: "task_agent_session",
		},
		binary: "/bin/sh",
		args: [],
		cwd: "/",
		env: { TERM: "xterm-256color" },
		terminalName: "xterm-256color",
		cols: 80,
		rows: 24,
	};
}

function createRegistryWithFakePtyProcesses() {
	const fakePtyProcesses: FakeHostedPtyProcess[] = [];
	const spawnHostedPtyProcess: SpawnHostedPtyProcess = () => {
		const fakePtyProcess = createFakeHostedPtyProcess(1000 + fakePtyProcesses.length);
		fakePtyProcesses.push(fakePtyProcess);
		return fakePtyProcess;
	};
	const subscribedOutput: Array<{ channel: number; startByteOffset: number; text: string }> = [];
	const exitedHostedSessionKeys: string[] = [];
	const registry = new AgentSessionPtyHostHostedSessionRegistry(
		spawnHostedPtyProcess,
		{
			onSubscribedHostedSessionOutput: (channel, startByteOffset, bytes) => {
				subscribedOutput.push({ channel, startByteOffset, text: bytes.toString("utf8") });
			},
			onHostedSessionExited: (hostedSessionKey) => {
				exitedHostedSessionKeys.push(hostedSessionKey);
			},
			onHostedSessionSetChanged: () => {},
		},
		() => 1_700_000_000_000,
		64,
	);
	return { registry, fakePtyProcesses, subscribedOutput, exitedHostedSessionKeys };
}

describe("AgentSessionPtyHostHostedSessionRegistry", () => {
	it("streams output with absolute offsets while the controller is subscribed and keeps buffering after it disconnects", () => {
		const { registry, fakePtyProcesses, subscribedOutput } = createRegistryWithFakePtyProcesses();
		const outcome = registry.spawnHostedSession(buildSpawnRequest("session-a"));
		expect(outcome).toMatchObject({ kind: "spawned", pid: 1000 });
		const fakePtyProcess = fakePtyProcesses[0];
		if (!fakePtyProcess || outcome.kind !== "spawned") {
			throw new Error("spawn failed");
		}

		fakePtyProcess.emitData("hello ");
		registry.releaseControllerStateAfterControllerDisconnected();
		fakePtyProcess.emitData("while runtime is away");

		expect(subscribedOutput).toEqual([
			{ channel: outcome.hostedSessionChannelNumber, startByteOffset: 0, text: "hello " },
		]);
		expect(registry.listHostedSessions()[0]).toMatchObject({
			hostedSessionKey: "session-a",
			outputEndByteOffset: "hello while runtime is away".length,
			exitRecord: null,
		});
	});

	it("resumes PTY reading when the controller that requested a pause disconnects", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-a"));
		const fakePtyProcess = fakePtyProcesses[0];

		registry.setControllerRequestedOutputPause("session-a", true);
		expect(fakePtyProcess?.pause).toHaveBeenCalledTimes(1);
		registry.releaseControllerStateAfterControllerDisconnected();

		expect(fakePtyProcess?.resume).toHaveBeenCalledTimes(1);
	});

	it("pauses only subscribed sessions under socket backpressure", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-a"));
		registry.releaseControllerStateAfterControllerDisconnected();
		registry.spawnHostedSession(buildSpawnRequest("session-b"));

		registry.setSocketBackpressureActive(true);

		expect(fakePtyProcesses[0]?.pause).not.toHaveBeenCalled();
		expect(fakePtyProcesses[1]?.pause).toHaveBeenCalledTimes(1);
		registry.setSocketBackpressureActive(false);
		expect(fakePtyProcesses[1]?.resume).toHaveBeenCalledTimes(1);
	});

	it("keeps the exit record until the controller acknowledges it", () => {
		const { registry, fakePtyProcesses, exitedHostedSessionKeys } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-a"));

		fakePtyProcesses[0]?.emitExit(3);

		expect(exitedHostedSessionKeys).toEqual(["session-a"]);
		expect(registry.hasRunningHostedSessions()).toBe(false);
		expect(registry.listHostedSessions()[0]?.exitRecord).toEqual({
			exitCode: 3,
			signal: null,
			exitedAtEpochMs: 1_700_000_000_000,
		});
		registry.acknowledgeHostedSessionExit("session-a");
		expect(registry.hostedSessionCount).toBe(0);
	});

	it("does not acknowledge a session that is still running", () => {
		const { registry } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-a"));

		registry.acknowledgeHostedSessionExit("session-a");

		expect(registry.hostedSessionCount).toBe(1);
	});

	it("rejects a duplicate hosted session key and reports spawn errors without registering a session", () => {
		const { registry } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-a"));
		expect(registry.spawnHostedSession(buildSpawnRequest("session-a"))).toMatchObject({
			kind: "spawn_failed",
			errorCode: "DUPLICATE_HOSTED_SESSION_KEY",
		});

		const failingRegistry = new AgentSessionPtyHostHostedSessionRegistry(
			() => {
				const spawnError = new Error("posix_spawnp failed") as NodeJS.ErrnoException;
				spawnError.code = "ENOENT";
				throw spawnError;
			},
			{
				onSubscribedHostedSessionOutput: () => {},
				onHostedSessionExited: () => {},
				onHostedSessionSetChanged: () => {},
			},
		);
		expect(failingRegistry.spawnHostedSession(buildSpawnRequest("session-b"))).toEqual({
			kind: "spawn_failed",
			errorCode: "ENOENT",
			errorMessage: "posix_spawnp failed",
		});
		expect(failingRegistry.hostedSessionCount).toBe(0);
	});
});
