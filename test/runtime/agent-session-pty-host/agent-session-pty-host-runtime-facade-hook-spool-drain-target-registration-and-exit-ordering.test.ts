// facade + 链路 + 排空协调器在 hook spool 上的接线（假 controller 连接内嵌一份与修复后 host 同语义的内存 spool）：
// - 只为支持 spool 的 host（listing 带 pendingHookSpoolEntryCount）登记排空目标：旧 host 一个 spool 读请求都收不到；
// - 登记即读一次：listing 报 0 条也要在应用函数绑定后读，直投前也要读；
// - 接管失败的会话：不排空、不确认它的 spool；被拒绝并终止时，确认退出要求 host 连同 spool 一并丢弃；
// - 退出：先排空 → 交付退出 → 确认退出 → 再读到 host 不认识会话（确认前才存进来的最后一个 Stop 不丢）→ 注销目标；
// - 上一个 runtime 已确认退出、spool 还没排空的会话：只排空，不进接管候选。
//
// 全部确定性断言：假连接的请求都只走 microtask，让出一轮事件循环即可让在途排空跑完。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionPtyHostControllerConnection,
	type AgentSessionPtyHostControllerConnectionEventHandlers,
} from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { AgentSessionPtyHostRuntimeFacade } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-facade";
import { resolveAgentSessionPtyHostSocketPath } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import type {
	AgentSessionPtyHostControllerToHostMessage,
	AgentSessionPtyHostHostedSessionExitRecord,
	AgentSessionPtyHostHostedSessionListing,
	AttachHostedSessionOutputStreamOutcome,
	HostedSessionHookSpoolEntry,
	ReadHostedSessionHookSpoolEntriesOutcome,
} from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";
import type { HostedTerminalPtySessionAdoptionCandidate } from "../../../src/terminal/terminal-pty-process-handle";

const HOST_BUILD_IDENTITY_FOR_TEST = "0011223344556677".repeat(4);
const HOSTED_SESSION_KEY = "hosted-session-with-hook-spool";
const HOSTED_SESSION_CHANNEL_NUMBER = 5;
const WORKSPACE_ID = "workspace-1";
const TASK_ID = "task-with-hook-spool";

interface InMemoryHookSpoolOfHostedSession {
	hookSpoolEntries: HostedSessionHookSpoolEntry[];
	nextHookSpoolEntrySequenceNumber: number;
	hostStillKnowsHostedSession: boolean;
	exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged: boolean;
}

// 只实现 facade 与链路在接管 / 排空 / 退出路径上用到的方法。spool 语义与修复后的 host 一致：
// 确认退出时 spool 非空（且没要求丢弃）则保留会话，spool 被确认清空后移除，之后的读回 unknown_hosted_session。
class FakeAgentSessionPtyHostControllerConnectionWithInMemoryHookSpool {
	isClosed = false;
	readonly sentControlMessages: AgentSessionPtyHostControllerToHostMessage[] = [];
	readHookSpoolEntriesRequestCount = 0;
	private eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers | null = null;
	private resolvePendingAttachResponse: ((outcome: AttachHostedSessionOutputStreamOutcome) => void) | null = null;
	private readonly inMemoryHookSpool: InMemoryHookSpoolOfHostedSession = {
		hookSpoolEntries: [],
		nextHookSpoolEntrySequenceNumber: 1,
		hostStillKnowsHostedSession: true,
		exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged: false,
	};

	constructor(private readonly hostedSessionListings: AgentSessionPtyHostHostedSessionListing[]) {
		const listing = hostedSessionListings[0];
		this.inMemoryHookSpool.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged =
			listing?.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged === true;
	}

	setEventHandlers(eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers): void {
		this.eventHandlers = eventHandlers;
	}

	sendControlMessage(message: AgentSessionPtyHostControllerToHostMessage): void {
		if (this.isClosed) {
			return;
		}
		this.sentControlMessages.push(message);
		if (message.type === "acknowledge_hosted_session_exit") {
			const spool = this.inMemoryHookSpool;
			if (
				spool.hookSpoolEntries.length === 0 ||
				message.discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession === true
			) {
				spool.hostStillKnowsHostedSession = false;
				spool.hookSpoolEntries = [];
			} else {
				spool.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged = true;
			}
		}
	}

	sendHostedSessionInputBytes(): void {}

	async requestListHostedSessions(): Promise<AgentSessionPtyHostHostedSessionListing[]> {
		return this.hostedSessionListings;
	}

	requestAttachHostedSessionOutputStream(): Promise<AttachHostedSessionOutputStreamOutcome> {
		return new Promise((resolve) => {
			this.resolvePendingAttachResponse = resolve;
		});
	}

	async requestReadHostedSessionHookSpoolEntries(): Promise<ReadHostedSessionHookSpoolEntriesOutcome> {
		this.readHookSpoolEntriesRequestCount += 1;
		const spool = this.inMemoryHookSpool;
		if (!spool.hostStillKnowsHostedSession) {
			return { kind: "unknown_hosted_session" };
		}
		return { kind: "read", hookSpoolEntries: [...spool.hookSpoolEntries] };
	}

	acknowledgeHostedSessionHookSpoolEntries(
		hostedSessionKey: string,
		throughHookSpoolEntrySequenceNumber: number,
	): void {
		this.sendControlMessage({
			type: "acknowledge_hosted_session_hook_spool_entries",
			hostedSessionKey,
			throughHookSpoolEntrySequenceNumber,
		});
		const spool = this.inMemoryHookSpool;
		spool.hookSpoolEntries = spool.hookSpoolEntries.filter(
			(entry) => entry.hookSpoolEntrySequenceNumber > throughHookSpoolEntrySequenceNumber,
		);
		if (spool.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged && spool.hookSpoolEntries.length === 0) {
			spool.hostStillKnowsHostedSession = false;
		}
	}

	async closeAfterFlushingPendingFrames(): Promise<void> {}

	// hooks CLI 直连 host 存进一条；不推通知（模拟通知尚未到达，或会话尚未登记、通知被忽略）。
	appendHookEventWithoutPendingNotification(spooledHookIngestRequest: unknown): void {
		const spool = this.inMemoryHookSpool;
		spool.hookSpoolEntries.push({
			hookSpoolEntrySequenceNumber: spool.nextHookSpoolEntrySequenceNumber,
			spooledAtEpochMs: 0,
			spooledHookIngestRequest,
		});
		spool.nextHookSpoolEntrySequenceNumber += 1;
	}

	respondToPendingAttachRequest(attachOutcome: AttachHostedSessionOutputStreamOutcome): void {
		const resolveAttachResponse = this.resolvePendingAttachResponse;
		if (resolveAttachResponse === null) {
			throw new Error("no attach request is pending");
		}
		this.resolvePendingAttachResponse = null;
		resolveAttachResponse(attachOutcome);
	}

	deliverHostedSessionExited(exitRecord: AgentSessionPtyHostHostedSessionExitRecord): void {
		this.eventHandlers?.onHostedSessionExited(HOSTED_SESSION_KEY, exitRecord);
	}

	sentMessagesOfType(
		messageType: AgentSessionPtyHostControllerToHostMessage["type"],
	): AgentSessionPtyHostControllerToHostMessage[] {
		return this.sentControlMessages.filter((message) => message.type === messageType);
	}

	get hostStillKnowsHostedSession(): boolean {
		return this.inMemoryHookSpool.hostStillKnowsHostedSession;
	}
}

function yieldToNextEventLoopTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const EXIT_RECORD: AgentSessionPtyHostHostedSessionExitRecord = { exitCode: 0, signal: null, exitedAtEpochMs: 2_000 };

function buildHostedSessionListing(
	overrides: Partial<AgentSessionPtyHostHostedSessionListing>,
): AgentSessionPtyHostHostedSessionListing {
	return {
		hostedSessionKey: HOSTED_SESSION_KEY,
		hostedSessionChannelNumber: HOSTED_SESSION_CHANNEL_NUMBER,
		hostedSessionDescriptor: { workspaceId: WORKSPACE_ID, taskId: TASK_ID, hostedSessionKind: "task_agent_session" },
		pid: 6161,
		spawnedAtEpochMs: 1_000,
		retainedOutputStartByteOffset: 0,
		outputEndByteOffset: 0,
		exitRecord: null,
		cols: 80,
		rows: 24,
		adoptionRecord: null,
		...overrides,
	};
}

const runtimeHomeDirectoriesRemovedAfterEachTest: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const runtimeHomeDirectoryPath of runtimeHomeDirectoriesRemovedAfterEachTest.splice(0)) {
		rmSync(runtimeHomeDirectoryPath, { recursive: true, force: true });
	}
});

async function startFacadeOverFakeConnection(
	listing: AgentSessionPtyHostHostedSessionListing,
	prepareInMemoryHookSpool: (fakeConnection: FakeAgentSessionPtyHostControllerConnectionWithInMemoryHookSpool) => void,
): Promise<{
	facade: AgentSessionPtyHostRuntimeFacade;
	fakeConnection: FakeAgentSessionPtyHostControllerConnectionWithInMemoryHookSpool;
	adoptionCandidates: HostedTerminalPtySessionAdoptionCandidate[];
	droppedSpooledHookEventCount: () => number;
}> {
	// /tmp 下的短目录：os.tmpdir()（macOS 的 /var/folders/…）会让 socket 路径触发 sun_path 回退、落进共享目录。
	const runtimeHomeDirectoryPath = mkdtempSync("/tmp/kphd-");
	runtimeHomeDirectoriesRemovedAfterEachTest.push(runtimeHomeDirectoryPath);
	const runtimeIdentity = { runtimeHomeDirectoryPath, runtimePort: 3996 };
	// generation 发现只看文件名；连接本身由下面的 spy 换成假连接。
	const currentGenerationSocketPath = resolveAgentSessionPtyHostSocketPath(
		runtimeIdentity,
		HOST_BUILD_IDENTITY_FOR_TEST,
	);
	mkdirSync(dirname(currentGenerationSocketPath), { recursive: true });
	writeFileSync(currentGenerationSocketPath, "");
	const fakeConnection = new FakeAgentSessionPtyHostControllerConnectionWithInMemoryHookSpool([listing]);
	prepareInMemoryHookSpool(fakeConnection);
	vi.spyOn(AgentSessionPtyHostControllerConnection, "connectAsController").mockResolvedValue(
		fakeConnection as unknown as AgentSessionPtyHostControllerConnection,
	);
	let droppedSpooledHookEventCount = 0;
	const facade = await AgentSessionPtyHostRuntimeFacade.start({
		runtimeIdentity,
		warn: () => {},
		currentBuildHostDescriptor: {
			hostBuildIdentity: HOST_BUILD_IDENTITY_FOR_TEST,
			launchCommand: { executablePath: process.execPath, leadingArguments: [] },
		},
		launchHostAndWaitUntilSocketAcceptsConnections: async () => {
			throw new Error("the test host is already listening; no launch expected");
		},
		recordSpooledHookEventDroppedAfterApplyRetriesExhausted: async () => {
			droppedSpooledHookEventCount += 1;
		},
		waitBeforeRetryingSpooledHookEventApply: async () => {},
	});
	return {
		facade,
		fakeConnection,
		adoptionCandidates: facade.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace(WORKSPACE_ID),
		droppedSpooledHookEventCount: () => droppedSpooledHookEventCount,
	};
}

const EMPTY_CATCH_UP_ATTACH_OUTCOME: AttachHostedSessionOutputStreamOutcome = {
	kind: "attached",
	catchUpStartByteOffset: 0,
	catchUpEndByteOffset: 0,
	overwrittenByteCountBeforeCatchUpStart: 0,
};

describe("agent session pty host facade hook spool drain target registration and exit ordering", () => {
	it("never sends a spool read request to a host whose listing does not report hook spool support, and delivers its exit synchronously", async () => {
		const { facade, fakeConnection, adoptionCandidates } = await startFacadeOverFakeConnection(
			buildHostedSessionListing({}),
			() => {},
		);
		const [adoptionCandidate] = adoptionCandidates;
		if (!adoptionCandidate) {
			throw new Error("expected one adoption candidate");
		}
		const observedExitCodes: number[] = [];
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: () => {},
			onData: () => {},
			onExit: (exitEvent) => observedExitCodes.push(exitEvent.exitCode),
		});
		await yieldToNextEventLoopTurn();
		fakeConnection.respondToPendingAttachRequest(EMPTY_CATCH_UP_ATTACH_OUTCOME);
		await adoptionPromise;
		facade.bindSpooledHookIngestRequestApplier(async () => ({ ok: true }));

		await facade.drainPendingHookSpoolEntriesBeforeDirectHookIngest(WORKSPACE_ID, TASK_ID);
		fakeConnection.deliverHostedSessionExited(EXIT_RECORD);

		expect(observedExitCodes).toEqual([0]);
		expect(fakeConnection.sentMessagesOfType("acknowledge_hosted_session_exit")).toEqual([
			{ type: "acknowledge_hosted_session_exit", hostedSessionKey: HOSTED_SESSION_KEY },
		]);
		await yieldToNextEventLoopTurn();
		expect(fakeConnection.readHookSpoolEntriesRequestCount).toBe(0);
	});

	it("reads the spool of an adopted session once the applier is bound even when the listing reported zero entries, and again before each direct ingest", async () => {
		const { facade, fakeConnection, adoptionCandidates } = await startFacadeOverFakeConnection(
			buildHostedSessionListing({ pendingHookSpoolEntryCount: 0 }),
			() => {},
		);
		const [adoptionCandidate] = adoptionCandidates;
		if (!adoptionCandidate) {
			throw new Error("expected one adoption candidate");
		}
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: () => {},
			onData: () => {},
			onExit: () => {},
		});
		await yieldToNextEventLoopTurn();
		fakeConnection.respondToPendingAttachRequest(EMPTY_CATCH_UP_ATTACH_OUTCOME);
		await adoptionPromise;
		// listing 之后、登记之后才存进来的条目（handover 窗口里 hooks CLI 撞 ECONNREFUSED 存进 spool）。
		fakeConnection.appendHookEventWithoutPendingNotification({ event: "to_review", n: "after-listing" });
		const appliedEvents: unknown[] = [];
		facade.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		await yieldToNextEventLoopTurn();
		expect(appliedEvents).toEqual([{ event: "to_review", n: "after-listing" }]);
		const readCountBeforeDirectIngest = fakeConnection.readHookSpoolEntriesRequestCount;

		fakeConnection.appendHookEventWithoutPendingNotification({ event: "to_review", n: "before-direct-ingest" });
		await facade.drainPendingHookSpoolEntriesBeforeDirectHookIngest(WORKSPACE_ID, TASK_ID);

		expect(appliedEvents).toEqual([
			{ event: "to_review", n: "after-listing" },
			{ event: "to_review", n: "before-direct-ingest" },
		]);
		expect(fakeConnection.readHookSpoolEntriesRequestCount).toBeGreaterThan(readCountBeforeDirectIngest);
	});

	// 「登记后才失败、已排队的排空被注销取消」由协调器单测钉住（接管路径上登记之后的失败只有连接断开，读本身也会失败）。
	it("neither drains nor acknowledges the spool of a session whose adoption failed, and asks the host to discard it with the exit after termination", async () => {
		const { facade, fakeConnection, adoptionCandidates } = await startFacadeOverFakeConnection(
			buildHostedSessionListing({ pendingHookSpoolEntryCount: 2 }),
			(connection) => {
				connection.appendHookEventWithoutPendingNotification({ event: "to_review", n: 1 });
				connection.appendHookEventWithoutPendingNotification({ event: "to_in_progress", n: 2 });
			},
		);
		const [adoptionCandidate] = adoptionCandidates;
		if (!adoptionCandidate) {
			throw new Error("expected one adoption candidate");
		}
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: () => {},
			onData: () => {},
			onExit: () => {},
		});
		await yieldToNextEventLoopTurn();
		fakeConnection.respondToPendingAttachRequest({ kind: "unknown_hosted_session" });
		await expect(adoptionPromise).rejects.toThrow(/disappeared before adoption/);
		const appliedEvents: unknown[] = [];
		facade.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		await yieldToNextEventLoopTurn();
		await facade.drainPendingHookSpoolEntriesBeforeDirectHookIngest(WORKSPACE_ID, TASK_ID);

		expect(appliedEvents).toEqual([]);
		expect(fakeConnection.readHookSpoolEntriesRequestCount).toBe(0);
		expect(fakeConnection.sentMessagesOfType("acknowledge_hosted_session_hook_spool_entries")).toEqual([]);

		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();
		fakeConnection.deliverHostedSessionExited(EXIT_RECORD);

		expect(fakeConnection.sentMessagesOfType("acknowledge_hosted_session_exit")).toEqual([
			{
				type: "acknowledge_hosted_session_exit",
				hostedSessionKey: HOSTED_SESSION_KEY,
				discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession: true,
			},
		]);
	});

	it("drains before delivering the exit, acknowledges it, then keeps reading until the host forgets the session so a Stop spooled before the acknowledgement is not lost", async () => {
		const { facade, fakeConnection, adoptionCandidates, droppedSpooledHookEventCount } =
			await startFacadeOverFakeConnection(
				buildHostedSessionListing({ pendingHookSpoolEntryCount: 1, exitRecord: EXIT_RECORD }),
				(connection) => {
					connection.appendHookEventWithoutPendingNotification({ event: "to_review", n: "before-exit" });
				},
			);
		const [adoptionCandidate] = adoptionCandidates;
		if (!adoptionCandidate) {
			throw new Error("expected one adoption candidate");
		}
		const observedOrder: unknown[] = [];
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: () => {},
			onData: () => {},
			onExit: (exitEvent) => {
				observedOrder.push({ exitCode: exitEvent.exitCode });
				// 交付退出之后、确认退出之前，host 又收到了最后一个 Stop。
				fakeConnection.appendHookEventWithoutPendingNotification({ event: "to_review", n: "final-stop" });
			},
		});
		await yieldToNextEventLoopTurn();
		fakeConnection.respondToPendingAttachRequest(EMPTY_CATCH_UP_ATTACH_OUTCOME);
		await adoptionPromise;
		await yieldToNextEventLoopTurn();
		// 确定性断言：应用函数尚未绑定，spool 还没排空，退出就不能交付。
		expect(observedOrder).toEqual([]);

		facade.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			observedOrder.push(spooledHookIngestRequest);
			return { ok: true };
		});
		await yieldToNextEventLoopTurn();

		expect(observedOrder).toEqual([
			{ event: "to_review", n: "before-exit" },
			{ exitCode: 0 },
			{ event: "to_review", n: "final-stop" },
		]);
		expect(droppedSpooledHookEventCount()).toBe(0);
		expect(fakeConnection.hostStillKnowsHostedSession).toBe(false);
		const exitAcknowledgementIndex = fakeConnection.sentControlMessages.findIndex(
			(message) => message.type === "acknowledge_hosted_session_exit",
		);
		const finalStopAcknowledgementIndex = fakeConnection.sentControlMessages.findIndex(
			(message) =>
				message.type === "acknowledge_hosted_session_hook_spool_entries" &&
				message.throughHookSpoolEntrySequenceNumber === 2,
		);
		expect(fakeConnection.sentControlMessages[exitAcknowledgementIndex]).toEqual({
			type: "acknowledge_hosted_session_exit",
			hostedSessionKey: HOSTED_SESSION_KEY,
		});
		expect(finalStopAcknowledgementIndex).toBeGreaterThan(exitAcknowledgementIndex);

		// host 已不认识这条会话：目标已注销，之后的直投不再碰 socket。
		const readCountAfterHostForgotSession = fakeConnection.readHookSpoolEntriesRequestCount;
		await facade.drainPendingHookSpoolEntriesBeforeDirectHookIngest(WORKSPACE_ID, TASK_ID);
		expect(fakeConnection.readHookSpoolEntriesRequestCount).toBe(readCountAfterHostForgotSession);
	});

	it("delivers the exit of a session with an empty spool without waiting for the applier to be bound", async () => {
		const { fakeConnection, adoptionCandidates } = await startFacadeOverFakeConnection(
			buildHostedSessionListing({ pendingHookSpoolEntryCount: 0 }),
			() => {},
		);
		const [adoptionCandidate] = adoptionCandidates;
		if (!adoptionCandidate) {
			throw new Error("expected one adoption candidate");
		}
		const observedExitCodes: number[] = [];
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: () => {},
			onData: () => {},
			onExit: (exitEvent) => observedExitCodes.push(exitEvent.exitCode),
		});
		await yieldToNextEventLoopTurn();
		fakeConnection.respondToPendingAttachRequest(EMPTY_CATCH_UP_ATTACH_OUTCOME);
		await adoptionPromise;

		fakeConnection.deliverHostedSessionExited(EXIT_RECORD);
		await yieldToNextEventLoopTurn();

		expect(observedExitCodes).toEqual([0]);
		expect(fakeConnection.sentMessagesOfType("acknowledge_hosted_session_exit")).toEqual([
			{ type: "acknowledge_hosted_session_exit", hostedSessionKey: HOSTED_SESSION_KEY },
		]);
		expect(fakeConnection.hostStillKnowsHostedSession).toBe(false);
	});

	it("drains, without offering it for adoption, a session whose exit an earlier runtime acknowledged while its spool still had entries", async () => {
		const { facade, fakeConnection, adoptionCandidates } = await startFacadeOverFakeConnection(
			buildHostedSessionListing({
				pendingHookSpoolEntryCount: 1,
				exitRecord: EXIT_RECORD,
				exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged: true,
			}),
			(connection) => {
				connection.appendHookEventWithoutPendingNotification({ event: "to_review", n: "left-by-earlier-runtime" });
			},
		);
		expect(adoptionCandidates).toEqual([]);
		const appliedEvents: unknown[] = [];
		facade.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		await yieldToNextEventLoopTurn();

		expect(appliedEvents).toEqual([{ event: "to_review", n: "left-by-earlier-runtime" }]);
		expect(fakeConnection.hostStillKnowsHostedSession).toBe(false);
		expect(facade.warnAboutHostedSessionsNotAdoptedDuringStartup()).toBe(0);
	});
});
