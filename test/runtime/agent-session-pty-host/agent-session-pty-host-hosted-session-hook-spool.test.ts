// host 侧的 hook spool：runtime 缺席期间 hooks CLI 存进来的事件，按序保留到 runtime 回来确认。
import { describe, expect, it, vi } from "vitest";
import {
	AgentSessionPtyHostHostedSessionRegistry,
	type HostedPtyProcess,
} from "../../../src/agent-session-pty-host/host-process/agent-session-pty-host-hosted-session-registry";
import type { SpawnHostedSessionRequestMessage } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";

function createFakeHostedPtyProcess(): HostedPtyProcess & { emitExit(exitCode: number): void } {
	let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
	return {
		pid: 4242,
		onData: () => {},
		onExit: (listener) => {
			exitListener = listener;
		},
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		kill: vi.fn(),
		emitExit: (exitCode) => exitListener?.({ exitCode }),
	};
}

const SPAWN_REQUEST: SpawnHostedSessionRequestMessage = {
	type: "spawn_hosted_session_request",
	requestId: "request-1",
	hostedSessionKey: "hosted-session-1",
	hostedSessionDescriptor: { workspaceId: "workspace-1", taskId: "task-1", hostedSessionKind: "task_agent_session" },
	binary: "/bin/sh",
	args: [],
	cwd: "/",
	env: {},
	terminalName: "xterm-256color",
	cols: 80,
	rows: 24,
};

function createRegistryWithOneHostedSession() {
	const fakePtyProcess = createFakeHostedPtyProcess();
	const pendingNotifications: Array<{ hostedSessionKey: string; pendingHookSpoolEntryCount: number }> = [];
	let hostedSessionSetChangeCount = 0;
	const registry = new AgentSessionPtyHostHostedSessionRegistry(
		() => fakePtyProcess,
		{
			onSubscribedHostedSessionOutput: () => {},
			onHostedSessionExited: () => {},
			onHostedSessionSetChanged: () => {
				hostedSessionSetChangeCount += 1;
			},
			onHostedSessionHookSpoolEntriesPending: (hostedSessionKey, pendingHookSpoolEntryCount) => {
				pendingNotifications.push({ hostedSessionKey, pendingHookSpoolEntryCount });
			},
		},
		() => 1_700_000_000_000,
	);
	registry.spawnHostedSession(SPAWN_REQUEST);
	return {
		registry,
		fakePtyProcess,
		pendingNotifications,
		hostedSessionSetChangeCount: () => hostedSessionSetChangeCount,
	};
}

function readSpooledEvents(registry: AgentSessionPtyHostHostedSessionRegistry): unknown[] {
	const outcome = registry.readHostedSessionHookSpoolEntries("hosted-session-1");
	return outcome.kind === "read" ? outcome.hookSpoolEntries.map((entry) => entry.spooledHookIngestRequest) : [];
}

describe("AgentSessionPtyHostHostedSessionRegistry hook spool", () => {
	it("keeps lifecycle events in order and collapses adjacent activity into the latest one", () => {
		const { registry, pendingNotifications } = createRegistryWithOneHostedSession();

		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "activity", n: 1 }, true);
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "activity", n: 2 }, true);
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "to_review", n: 3 }, false);
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "activity", n: 4 }, true);
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "to_in_progress", n: 5 }, false);

		expect(readSpooledEvents(registry)).toEqual([
			{ event: "activity", n: 2 },
			{ event: "to_review", n: 3 },
			{ event: "activity", n: 4 },
			{ event: "to_in_progress", n: 5 },
		]);
		expect(pendingNotifications.at(-1)).toEqual({
			hostedSessionKey: "hosted-session-1",
			pendingHookSpoolEntryCount: 4,
		});
		expect(registry.listHostedSessions()[0]?.pendingHookSpoolEntryCount).toBe(4);
	});

	it("removes only the acknowledged prefix so events appended during a drain survive", () => {
		const { registry } = createRegistryWithOneHostedSession();
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { n: 1 }, false);
		const readDuringDrain = registry.readHostedSessionHookSpoolEntries("hosted-session-1");
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { n: 2 }, false);

		const lastReadSequenceNumber =
			readDuringDrain.kind === "read" ? readDuringDrain.hookSpoolEntries.at(-1)?.hookSpoolEntrySequenceNumber : -1;
		registry.acknowledgeHostedSessionHookSpoolEntries("hosted-session-1", lastReadSequenceNumber ?? -1);

		expect(readSpooledEvents(registry)).toEqual([{ n: 2 }]);
	});

	it("still accepts the final Stop of a session that exited but whose exit is not acknowledged yet", () => {
		const { registry, fakePtyProcess } = createRegistryWithOneHostedSession();
		fakePtyProcess.emitExit(0);

		const outcome = registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "to_review" }, false);

		expect(outcome.kind).toBe("spooled");
	});

	it("keeps a session whose exit is acknowledged while its spool is not empty, and removes it once the spool is acknowledged", () => {
		const { registry, fakePtyProcess, pendingNotifications, hostedSessionSetChangeCount } =
			createRegistryWithOneHostedSession();
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "to_review", n: 1 }, false);
		fakePtyProcess.emitExit(0);
		const setChangeCountBeforeExitAcknowledgement = hostedSessionSetChangeCount();

		expect(registry.acknowledgeHostedSessionExit("hosted-session-1")).toEqual({
			kind: "hosted_session_retained_until_hook_spool_drained",
			pendingHookSpoolEntryCount: 1,
		});

		// 会话还在：spool 可读、listing 标明「退出已确认、等排空」，并再推一次「有待取条目」。
		expect(readSpooledEvents(registry)).toEqual([{ event: "to_review", n: 1 }]);
		expect(registry.listHostedSessions()[0]).toMatchObject({
			hostedSessionKey: "hosted-session-1",
			exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged: true,
			pendingHookSpoolEntryCount: 1,
		});
		expect(pendingNotifications.at(-1)).toEqual({
			hostedSessionKey: "hosted-session-1",
			pendingHookSpoolEntryCount: 1,
		});
		expect(hostedSessionSetChangeCount()).toBe(setChangeCountBeforeExitAcknowledgement);
		expect(registry.hostedSessionCount).toBe(1);
		// 确认退出之后才到的最后一个 Stop 照收。
		expect(
			registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "to_review", n: 2 }, false),
		).toEqual({ kind: "spooled", hookSpoolEntrySequenceNumber: 2 });

		registry.acknowledgeHostedSessionHookSpoolEntries("hosted-session-1", 1);
		expect(registry.hostedSessionCount).toBe(1);
		registry.acknowledgeHostedSessionHookSpoolEntries("hosted-session-1", 2);

		expect(registry.hostedSessionCount).toBe(0);
		expect(hostedSessionSetChangeCount()).toBe(setChangeCountBeforeExitAcknowledgement + 1);
		expect(registry.readHostedSessionHookSpoolEntries("hosted-session-1")).toEqual({
			kind: "unknown_hosted_session",
		});
		expect(registry.appendHookEventToHostedSessionSpool("hosted-session-1", {}, false)).toEqual({
			kind: "spool_rejected",
			reason: "unknown_hosted_session",
		});
	});

	it("removes the session at once when its exit is acknowledged with an empty spool", () => {
		const { registry, fakePtyProcess } = createRegistryWithOneHostedSession();
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "to_review" }, false);
		registry.acknowledgeHostedSessionHookSpoolEntries("hosted-session-1", 1);
		fakePtyProcess.emitExit(0);

		expect(registry.acknowledgeHostedSessionExit("hosted-session-1")).toEqual({
			kind: "hosted_session_removed",
			discardedHookSpoolEntryCount: 0,
		});
		expect(registry.hostedSessionCount).toBe(0);
	});

	it("removes the session together with a non-empty spool only when the controller asks to discard it", () => {
		const { registry, fakePtyProcess } = createRegistryWithOneHostedSession();
		registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "to_review" }, false);
		fakePtyProcess.emitExit(0);

		expect(registry.acknowledgeHostedSessionExit("hosted-session-1", true)).toEqual({
			kind: "hosted_session_removed",
			discardedHookSpoolEntryCount: 1,
		});
		expect(registry.readHostedSessionHookSpoolEntries("hosted-session-1")).toEqual({
			kind: "unknown_hosted_session",
		});
	});

	it("rejects lifecycle events once the per-session bound is reached but keeps accepting activity", () => {
		const { registry } = createRegistryWithOneHostedSession();
		let lastOutcome = registry.appendHookEventToHostedSessionSpool("hosted-session-1", { n: 0 }, false);
		for (let entryIndex = 1; lastOutcome.kind === "spooled" && entryIndex < 10_000; entryIndex += 1) {
			lastOutcome = registry.appendHookEventToHostedSessionSpool("hosted-session-1", { n: entryIndex }, false);
		}

		expect(lastOutcome).toEqual({ kind: "spool_rejected", reason: "hook_spool_full" });
		expect(registry.appendHookEventToHostedSessionSpool("hosted-session-1", { event: "activity" }, true).kind).toBe(
			"spooled",
		);
	});
});
