import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { AgentSessionPtyHostControllerSocketServer } from "../../../src/agent-session-pty-host/host-process/agent-session-pty-host-controller-socket-server";
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
			taskId: `task-${hostedSessionKey}`,
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
	beforeEach(() => {
		vi.useFakeTimers();
		// 假 PTY 的 PID 不应成为向宿主进程组发信号的理由。
		vi.spyOn(process, "kill").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each(["orphan_reclamation", "runtime_soft_stop"] as const)(
		"%s：根退出且记录已确认后，仍持有进程组直到 SIGKILL 升级结束",
		(terminationSource) => {
			const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
			registry.spawnHostedSession(buildSpawnRequest("orphan-with-descendants"));
			registry.putHostedSessionAdoptionRecord("orphan-with-descendants", {}, 1_699_999_000_000);

			if (terminationSource === "orphan_reclamation") {
				registry.reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(1_700_000_000_000);
			} else {
				registry.stopHostedSession("orphan-with-descendants", false);
			}
			fakePtyProcesses[0]?.emitExit(0, 15);
			registry.acknowledgeHostedSessionExit("orphan-with-descendants");

			expect(registry.hostedSessionCount).toBe(0);
			expect(registry.hasHostedSessionProcessGroupsAwaitingSigkillEscalation()).toBe(true);
			vi.advanceTimersByTime(5_000);
			expect(process.kill).toHaveBeenCalledWith(-1000, "SIGKILL");
			expect(fakePtyProcesses[0]?.kill).not.toHaveBeenCalledWith("SIGKILL");
			expect(registry.hasHostedSessionProcessGroupsAwaitingSigkillEscalation()).toBe(false);
		},
	);
	it("同一会话先软停止再全停只安排一次进程组升级", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-a"));

		registry.stopHostedSession("session-a", false);
		registry.terminateAllRunningHostedSessionsWithSigkillEscalation();
		fakePtyProcesses[0]?.emitExit(0, 15);
		vi.advanceTimersByTime(5_000);

		const sigkillSignals = vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal === "SIGKILL");
		expect(sigkillSignals).toEqual([[-1000, "SIGKILL"]]);
		expect(registry.hasHostedSessionProcessGroupsAwaitingSigkillEscalation()).toBe(false);
	});

	it("向 hosted PTY 逐字转发二进制鼠标报告和拆分的 UTF-8 输入", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		const outcome = registry.spawnHostedSession(buildSpawnRequest("binary-input-session"));
		if (outcome.kind !== "spawned") throw new Error("测试 PTY 未启动");
		const chineseInput = Buffer.from("中文", "utf8");
		const inputChunks = [
			Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0xcb, 0x2d]),
			chineseInput.subarray(0, 1),
			chineseInput.subarray(1),
		];

		for (const chunk of inputChunks) registry.writeHostedSessionInput(outcome.hostedSessionChannelNumber, chunk);

		expect(fakePtyProcesses[0].write).toHaveBeenCalledTimes(inputChunks.length);
		for (const [index, chunk] of inputChunks.entries()) {
			expect(fakePtyProcesses[0].write).toHaveBeenNthCalledWith(index + 1, chunk);
		}
	});

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

	it("更换 session key 也不能并发创建同一 workspace/conversation 的第二份活会话", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		const original = buildSpawnRequest("session-a");
		registry.spawnHostedSession(original);
		expect(registry.spawnHostedSession({ ...original, hostedSessionKey: "different-key" })).toMatchObject({
			kind: "spawn_failed",
			errorCode: "DUPLICATE_RUNNING_CONVERSATION_SESSION",
		});
		expect(fakePtyProcesses).toHaveLength(1);
		fakePtyProcesses[0]?.emitExit(0);
		expect(registry.spawnHostedSession({ ...original, hostedSessionKey: "different-key" }).kind).toBe("spawned");
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

	it("reclaims only running sessions whose orphan reclamation deadline has passed and records why they exited", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-past-deadline"));
		registry.spawnHostedSession(buildSpawnRequest("session-future-deadline"));
		registry.spawnHostedSession(buildSpawnRequest("session-in-agent-turn"));
		registry.putHostedSessionAdoptionRecord("session-past-deadline", { recordedBy: "detach" }, 1_699_999_000_000);
		registry.putHostedSessionAdoptionRecord("session-future-deadline", { recordedBy: "detach" }, 1_700_000_500_000);
		// agent 回合中：runtime 推 null，绝不回收。
		registry.putHostedSessionAdoptionRecord("session-in-agent-turn", { recordedBy: "detach" }, null);

		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBe(1_699_999_000_000);
		const reclaimedHostedSessions =
			registry.reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(1_700_000_000_000);

		expect(reclaimedHostedSessions.map((reclaimed) => reclaimed.hostedSessionKey)).toEqual(["session-past-deadline"]);
		expect(fakePtyProcesses[0]?.kill).toHaveBeenCalled();
		expect(fakePtyProcesses[1]?.kill).not.toHaveBeenCalled();
		expect(fakePtyProcesses[2]?.kill).not.toHaveBeenCalled();
		// 已在回收中的会话不再计入下一个期限。
		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBe(1_700_000_500_000);

		fakePtyProcesses[0]?.emitExit(0, 15);
		expect(
			registry.listHostedSessions().find((listing) => listing.hostedSessionKey === "session-past-deadline")
				?.exitRecord,
		).toMatchObject({ signal: 15, hostedSessionTerminatedByHostReason: "reclaimed_by_host_while_runtime_absent" });
	});

	it("drops a stale orphan reclamation deadline when the next adoption record carries none", () => {
		const { registry } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-a"));
		registry.putHostedSessionAdoptionRecord("session-a", { recordedBy: "detach" }, 1_699_999_000_000);
		// 新 runtime 接管后平时推的记录一律带 null：会话又跑起来了，旧期限不能再杀它。
		registry.putHostedSessionAdoptionRecord("session-a", { recordedBy: "adopting runtime" }, null);

		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBeNull();
		expect(registry.reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(1_800_000_000_000)).toEqual([]);
	});

	it.each([
		{ event: "to_in_progress", coalescible: false },
		{ event: "activity", coalescible: true },
		{ event: "to_review", coalescible: false },
		{ event: "unknown_hook_event", coalescible: false },
	])("离线新增 $event 待核对时，旧期限不再授权调度或终止", ({ event, coalescible }) => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		registry.spawnHostedSession(buildSpawnRequest("session-with-unreconciled-hook"));
		registry.putHostedSessionAdoptionRecord(
			"session-with-unreconciled-hook",
			{ identity: "retained" },
			1_700_000_001_000,
		);
		registry.releaseControllerStateAfterControllerDisconnected();
		const hook = { event, hookEventCapturedAtEpochMs: 1_700_000_000_500 };

		expect(registry.appendHookEventToHostedSessionSpool("session-with-unreconciled-hook", hook, coalescible)).toEqual(
			{
				kind: "spooled",
				hookSpoolEntrySequenceNumber: 1,
			},
		);
		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBeNull();
		expect(registry.reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(1_700_000_001_001)).toEqual([]);
		expect(fakePtyProcesses[0]?.kill).not.toHaveBeenCalled();
		expect(process.kill).not.toHaveBeenCalled();
		expect(registry.listHostedSessions()[0]).toMatchObject({
			adoptionRecord: { identity: "retained" },
			pendingHookSpoolEntryCount: 1,
			hostedSessionOrphanReclamationEligibleAtEpochMs: null,
		});
		expect(registry.readHostedSessionHookSpoolEntries("session-with-unreconciled-hook")).toMatchObject({
			kind: "read",
			hookSpoolEntries: [{ spooledHookIngestRequest: hook }],
		});
	});

	it("spool 全部核对后仍须重新发布期限，接管记录不能越过待核对的新条目", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		const hostedSessionKey = "session-with-reconciled-hook";
		registry.spawnHostedSession(buildSpawnRequest(hostedSessionKey));
		registry.putHostedSessionAdoptionRecord(hostedSessionKey, {}, 1_700_000_001_000);
		registry.releaseControllerStateAfterControllerDisconnected();
		registry.appendHookEventToHostedSessionSpool(hostedSessionKey, { event: "to_in_progress" }, false);
		registry.putHostedSessionAdoptionRecord(hostedSessionKey, { runtime: "successor" }, 1_700_000_002_000);
		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBeNull();
		// 排空途中再到一条，确认旧前缀不能把新条目的未知状态清掉。
		registry.appendHookEventToHostedSessionSpool(hostedSessionKey, { event: "to_review" }, false);
		registry.acknowledgeHostedSessionHookSpoolEntries(hostedSessionKey, 1);
		registry.putHostedSessionAdoptionRecord(hostedSessionKey, { runtime: "successor" }, 1_700_000_003_000);
		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBeNull();
		registry.acknowledgeHostedSessionHookSpoolEntries(hostedSessionKey, 2);
		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBeNull();
		expect(registry.reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(1_700_000_004_000)).toEqual([]);

		registry.putHostedSessionAdoptionRecord(hostedSessionKey, { runtime: "reconciled successor" }, 1_700_000_005_000);
		registry.releaseControllerStateAfterControllerDisconnected();
		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBe(1_700_000_005_000);
		expect(registry.reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(1_700_000_005_000)).toEqual([
			{ hostedSessionKey, pid: 1000, orphanReclamationEligibleAtEpochMs: 1_700_000_005_000 },
		]);
		expect(fakePtyProcesses[0]?.kill).toHaveBeenCalledOnce();
	});

	it("一个会话有新 hook 时，无新活动的其他到期会话仍可合法回收", () => {
		const { registry, fakePtyProcesses } = createRegistryWithFakePtyProcesses();
		for (const hostedSessionKey of ["session-with-new-hook", "session-without-new-hook"]) {
			registry.spawnHostedSession(buildSpawnRequest(hostedSessionKey));
			registry.putHostedSessionAdoptionRecord(hostedSessionKey, {}, 1_700_000_001_000);
		}
		registry.releaseControllerStateAfterControllerDisconnected();
		registry.appendHookEventToHostedSessionSpool("session-with-new-hook", { event: "activity" }, true);

		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBe(1_700_000_001_000);
		expect(registry.reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(1_700_000_001_000)).toEqual([
			{
				hostedSessionKey: "session-without-new-hook",
				pid: 1001,
				orphanReclamationEligibleAtEpochMs: 1_700_000_001_000,
			},
		]);
		expect(fakePtyProcesses[0]?.kill).not.toHaveBeenCalled();
		expect(fakePtyProcesses[1]?.kill).toHaveBeenCalledOnce();
		expect(registry.resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions()).toBeNull();
	});

	it.each(["serving", "retiring_when_drained"])("%s：旧期限到期后不因未核对 hook 零延时重排", (hostLifecycleState) => {
		vi.setSystemTime(1_700_000_000_000);
		const fakePtyProcess = createFakeHostedPtyProcess(1000);
		// 不监听 socket；只执行真实 host 的消息处理与定时器，所有进程信号均已 mock。
		const server = new AgentSessionPtyHostControllerSocketServer({
			socketPath: "/never-listened-orphan-reclamation-regression.sock",
			hostBuildIdentity: "isolated-orphan-reclamation-regression",
			spawnHostedPtyProcess: () => fakePtyProcess,
			idleExitAfterMilliseconds: 10_000,
			unacknowledgedExitRecordRetentionMilliseconds: 10_000,
			appendHostLogEntry: () => {},
			requestHostProcessExit: vi.fn(),
		});
		const hostInternals = server as unknown as {
			hostedSessionRegistry: AgentSessionPtyHostHostedSessionRegistry;
			hostLifecycleState: string;
			handleControllerControlMessage(message: unknown): void;
			handleHostedSessionCliClientRequest(socket: unknown, message: unknown): void;
		};
		hostInternals.hostLifecycleState = hostLifecycleState;
		hostInternals.hostedSessionRegistry.spawnHostedSession(
			buildSpawnRequest("session-with-pending-hook-at-deadline"),
		);
		hostInternals.handleControllerControlMessage({
			type: "put_hosted_session_adoption_record",
			hostedSessionKey: "session-with-pending-hook-at-deadline",
			adoptionRecord: {},
			hostedSessionOrphanReclamationEligibleAtEpochMs: Date.now() + 1_000,
		});
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(500);
		hostInternals.handleHostedSessionCliClientRequest(
			{ destroyed: false, write: vi.fn() },
			{
				type: "append_hook_event_to_hosted_session_spool_request",
				requestId: "new-hook-before-deadline",
				hostedSessionKey: "session-with-pending-hook-at-deadline",
				spooledHookIngestRequest: { event: "to_in_progress", hookEventCapturedAtEpochMs: Date.now() },
			},
		);
		vi.advanceTimersByTime(500);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(vi.getTimerCount()).toBe(0);
		expect(fakePtyProcess.kill).not.toHaveBeenCalled();
		expect(process.kill).not.toHaveBeenCalled();
		expect(hostInternals.hostedSessionRegistry.listHostedSessions()[0]?.pendingHookSpoolEntryCount).toBe(1);
	});
});
