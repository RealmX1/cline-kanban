// 接管时 attach / 追赶失败后的拒绝路径：session-manager 在 adopt 抛错后调用 terminateHostedTerminalPtyProcessAfterRefusedAdoption。
// - 连接仍可用（host 回 unknown_hosted_session、attach 请求超时）：必须真正发出 stop_hosted_session，会话不进未接管告警；
// - 连接已断开（attach 在途或追赶交付完之前断开）：stop 发不出去，会话必须仍列在未接管告警名单里；
// - 同一候选不能被并发 / 重复接管。
//
// 用假的 controller 连接驱动真实的 facade + 链路；断开的时序与真实连接一致：先置 closed、reject 在途请求，再同步通知 onConnectionClosed。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionPtyHostControllerConnection,
	type AgentSessionPtyHostControllerConnectionEventHandlers,
	AgentSessionPtyHostUnreachableError,
} from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { AgentSessionPtyHostRuntimeFacade } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-facade";
import { resolveAgentSessionPtyHostSocketPath } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import type {
	AgentSessionPtyHostControllerToHostMessage,
	AgentSessionPtyHostHostedSessionListing,
	AttachHostedSessionOutputStreamOutcome,
} from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";
import type { HostedTerminalPtySessionAdoptionCandidate } from "../../../src/terminal/terminal-pty-process-handle";

const HOST_BUILD_IDENTITY_FOR_TEST = "fedcba9876543210".repeat(4);
const HOSTED_SESSION_KEY_OF_ADOPTION_CANDIDATE = "hosted-session-refused-after-attach-failure";
const HOSTED_SESSION_CHANNEL_NUMBER_OF_ADOPTION_CANDIDATE = 9;

interface PendingAttachRequestControlledByTest {
	resolve: (outcome: AttachHostedSessionOutputStreamOutcome) => void;
	reject: (error: Error) => void;
}

// 只实现 facade 与链路在接管 / 拒绝路径上用到的方法；attach 的结局与连接断开由测试逐步驱动。
class FakeAgentSessionPtyHostControllerConnectionWithTestControlledAttach {
	isClosed = false;
	readonly sentControlMessages: AgentSessionPtyHostControllerToHostMessage[] = [];
	attachRequestCount = 0;
	private eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers | null = null;
	private pendingAttachRequest: PendingAttachRequestControlledByTest | null = null;

	constructor(private readonly hostedSessionListings: AgentSessionPtyHostHostedSessionListing[]) {}

	setEventHandlers(eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers): void {
		this.eventHandlers = eventHandlers;
	}

	// 与真实连接一致：已断开时静默丢弃。
	sendControlMessage(message: AgentSessionPtyHostControllerToHostMessage): void {
		if (this.isClosed) {
			return;
		}
		this.sentControlMessages.push(message);
	}

	sendHostedSessionInputBytes(): void {}

	async requestListHostedSessions(): Promise<AgentSessionPtyHostHostedSessionListing[]> {
		return this.hostedSessionListings;
	}

	requestAttachHostedSessionOutputStream(): Promise<AttachHostedSessionOutputStreamOutcome> {
		this.attachRequestCount += 1;
		if (this.isClosed) {
			return Promise.reject(
				new AgentSessionPtyHostUnreachableError("agent session pty host connection closed", false),
			);
		}
		return new Promise((resolve, reject) => {
			this.pendingAttachRequest = { resolve, reject };
		});
	}

	async closeAfterFlushingPendingFrames(): Promise<void> {}

	get attachRequestIsPending(): boolean {
		return this.pendingAttachRequest !== null;
	}

	respondToPendingAttachRequest(attachOutcome: AttachHostedSessionOutputStreamOutcome): void {
		this.takePendingAttachRequest().resolve(attachOutcome);
	}

	// 真实连接的请求期限到期：连接本身仍可用。
	expirePendingAttachRequestDeadlineWhileConnectionStaysOpen(): void {
		this.takePendingAttachRequest().reject(
			new AgentSessionPtyHostUnreachableError("agent session pty host request timed out", false),
		);
	}

	deliverOutputFrame(startByteOffset: number, bytes: Buffer): void {
		this.eventHandlers?.onHostedSessionOutput(
			HOSTED_SESSION_CHANNEL_NUMBER_OF_ADOPTION_CANDIDATE,
			startByteOffset,
			bytes,
		);
	}

	closeConnectionFromHostSide(): void {
		this.isClosed = true;
		const pendingAttachRequest = this.pendingAttachRequest;
		this.pendingAttachRequest = null;
		pendingAttachRequest?.reject(
			new AgentSessionPtyHostUnreachableError("agent session pty host connection closed", false),
		);
		this.eventHandlers?.onConnectionClosed("connection_closed");
	}

	sentStopHostedSessionMessages(): AgentSessionPtyHostControllerToHostMessage[] {
		return this.sentControlMessages.filter((message) => message.type === "stop_hosted_session");
	}

	private takePendingAttachRequest(): PendingAttachRequestControlledByTest {
		const pendingAttachRequest = this.pendingAttachRequest;
		if (pendingAttachRequest === null) {
			throw new Error("no attach request is pending");
		}
		this.pendingAttachRequest = null;
		return pendingAttachRequest;
	}
}

function yieldToNextEventLoopTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function buildRunningHostedSessionListing(): AgentSessionPtyHostHostedSessionListing {
	return {
		hostedSessionKey: HOSTED_SESSION_KEY_OF_ADOPTION_CANDIDATE,
		hostedSessionChannelNumber: HOSTED_SESSION_CHANNEL_NUMBER_OF_ADOPTION_CANDIDATE,
		hostedSessionDescriptor: {
			workspaceId: "workspace-1",
			taskId: "task-refused-after-attach-failure",
			hostedSessionKind: "task_agent_session",
		},
		pid: 5151,
		spawnedAtEpochMs: 1_000,
		retainedOutputStartByteOffset: 0,
		outputEndByteOffset: 0,
		exitRecord: null,
		cols: 80,
		rows: 24,
		adoptionRecord: null,
	};
}

const runtimeHomeDirectoriesRemovedAfterEachTest: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const runtimeHomeDirectoryPath of runtimeHomeDirectoriesRemovedAfterEachTest.splice(0)) {
		rmSync(runtimeHomeDirectoryPath, { recursive: true, force: true });
	}
});

async function startFacadeOverFakeConnectionAndTakeAdoptionCandidate(): Promise<{
	facade: AgentSessionPtyHostRuntimeFacade;
	fakeConnection: FakeAgentSessionPtyHostControllerConnectionWithTestControlledAttach;
	adoptionCandidate: HostedTerminalPtySessionAdoptionCandidate;
	warnings: string[];
}> {
	// /tmp 下的短目录：os.tmpdir()（macOS 的 /var/folders/…）会让 socket 路径触发 sun_path 回退、落进共享目录。
	const runtimeHomeDirectoryPath = mkdtempSync("/tmp/kphr-");
	runtimeHomeDirectoriesRemovedAfterEachTest.push(runtimeHomeDirectoryPath);
	const runtimeIdentity = { runtimeHomeDirectoryPath, runtimePort: 3998 };
	// generation 发现只看文件名；连接本身由下面的 spy 换成假连接。
	const currentGenerationSocketPath = resolveAgentSessionPtyHostSocketPath(
		runtimeIdentity,
		HOST_BUILD_IDENTITY_FOR_TEST,
	);
	mkdirSync(dirname(currentGenerationSocketPath), { recursive: true });
	writeFileSync(currentGenerationSocketPath, "");
	const fakeConnection = new FakeAgentSessionPtyHostControllerConnectionWithTestControlledAttach([
		buildRunningHostedSessionListing(),
	]);
	vi.spyOn(AgentSessionPtyHostControllerConnection, "connectAsController").mockResolvedValue(
		fakeConnection as unknown as AgentSessionPtyHostControllerConnection,
	);
	const warnings: string[] = [];
	const facade = await AgentSessionPtyHostRuntimeFacade.start({
		runtimeIdentity,
		warn: (message) => warnings.push(message),
		currentBuildHostDescriptor: {
			hostBuildIdentity: HOST_BUILD_IDENTITY_FOR_TEST,
			launchCommand: { executablePath: process.execPath, leadingArguments: [] },
		},
		launchHostAndWaitUntilSocketAcceptsConnections: async () => {
			throw new Error("the test host is already listening; no launch expected");
		},
	});
	const [adoptionCandidate] = facade.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace("workspace-1");
	if (!adoptionCandidate) {
		throw new Error("expected one adoption candidate");
	}
	return { facade, fakeConnection, adoptionCandidate, warnings };
}

const ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING = {
	onCatchUpOutput: () => {},
	onData: () => {},
	onExit: () => {},
};

describe("agent session pty host refused adoption termination after output stream attach failure", () => {
	it("sends stop_hosted_session when the host answers unknown_hosted_session, and refuses adopting the candidate again", async () => {
		const { facade, fakeConnection, adoptionCandidate } =
			await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess(
			ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING,
		);
		await yieldToNextEventLoopTurn();
		fakeConnection.respondToPendingAttachRequest({ kind: "unknown_hosted_session" });
		await expect(adoptionPromise).rejects.toThrow(/disappeared before adoption/);

		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();

		expect(fakeConnection.sentStopHostedSessionMessages()).toEqual([
			{ type: "stop_hosted_session", hostedSessionKey: HOSTED_SESSION_KEY_OF_ADOPTION_CANDIDATE, force: true },
		]);
		await expect(
			adoptionCandidate.adoptHostedTerminalPtyProcess(ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING),
		).rejects.toThrow(/cannot be adopted again/);
		expect(fakeConnection.attachRequestCount).toBe(1);
		// 再次拒绝不重复下令。
		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();
		expect(fakeConnection.sentStopHostedSessionMessages()).toHaveLength(1);
		expect(facade.warnAboutHostedSessionsNotAdoptedDuringStartup()).toBe(0);
	});

	it("sends stop_hosted_session when the attach request times out while the connection stays open", async () => {
		const { facade, fakeConnection, adoptionCandidate } =
			await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess(
			ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING,
		);
		await yieldToNextEventLoopTurn();
		fakeConnection.expirePendingAttachRequestDeadlineWhileConnectionStaysOpen();
		await expect(adoptionPromise).rejects.toThrow(/timed out/);

		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();

		expect(fakeConnection.sentStopHostedSessionMessages()).toEqual([
			{ type: "stop_hosted_session", hostedSessionKey: HOSTED_SESSION_KEY_OF_ADOPTION_CANDIDATE, force: true },
		]);
		expect(facade.warnAboutHostedSessionsNotAdoptedDuringStartup()).toBe(0);
	});

	it("keeps the session in the not-adopted warning when the connection closes while the attach request is pending", async () => {
		const { facade, fakeConnection, adoptionCandidate, warnings } =
			await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess(
			ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING,
		);
		await yieldToNextEventLoopTurn();
		expect(fakeConnection.attachRequestIsPending).toBe(true);
		fakeConnection.closeConnectionFromHostSide();
		await expect(adoptionPromise).rejects.toThrow(/connection closed/);

		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();

		expect(fakeConnection.sentStopHostedSessionMessages()).toEqual([]);
		expect(facade.warnAboutHostedSessionsNotAdoptedDuringStartup()).toBe(1);
		expect(warnings.at(-1)).toContain("workspace-1/task-refused-after-attach-failure pid=5151");
		expect(warnings.at(-1)).toContain(
			"refused_adoption_but_termination_undeliverable_because_host_connection_closed",
		);
		await expect(
			adoptionCandidate.adoptHostedTerminalPtyProcess(ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING),
		).rejects.toThrow(/cannot be adopted again/);
	});

	it("keeps the session in the not-adopted warning when the connection closes before the catch-up range is fully delivered", async () => {
		const { facade, fakeConnection, adoptionCandidate } =
			await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess(
			ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING,
		);
		await yieldToNextEventLoopTurn();
		fakeConnection.respondToPendingAttachRequest({
			kind: "attached",
			catchUpStartByteOffset: 0,
			catchUpEndByteOffset: 200,
			overwrittenByteCountBeforeCatchUpStart: 0,
		});
		await yieldToNextEventLoopTurn();
		fakeConnection.deliverOutputFrame(0, Buffer.alloc(100, "a"));
		fakeConnection.closeConnectionFromHostSide();
		await expect(adoptionPromise).rejects.toThrow(/before catch-up output was fully delivered/);

		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();

		expect(fakeConnection.sentStopHostedSessionMessages()).toEqual([]);
		expect(facade.warnAboutHostedSessionsNotAdoptedDuringStartup()).toBe(1);
	});

	it("rejects a concurrent adoption while the attach is in flight and counts the adopted session as settled", async () => {
		const { facade, fakeConnection, adoptionCandidate } =
			await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess(
			ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING,
		);
		await yieldToNextEventLoopTurn();
		await expect(
			adoptionCandidate.adoptHostedTerminalPtyProcess(ADOPTION_CALLBACKS_THAT_IGNORE_EVERYTHING),
		).rejects.toThrow(/cannot be adopted again/);
		// 接管在途时的终止请求不生效：句柄的去留由接管调用方决定。
		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();
		fakeConnection.respondToPendingAttachRequest({
			kind: "attached",
			catchUpStartByteOffset: 0,
			catchUpEndByteOffset: 0,
			overwrittenByteCountBeforeCatchUpStart: 0,
		});
		const adoptedHandle = await adoptionPromise;

		expect(adoptedHandle.pid).toBe(5151);
		expect(fakeConnection.attachRequestCount).toBe(1);
		adoptionCandidate.terminateHostedTerminalPtyProcessAfterRefusedAdoption();
		expect(fakeConnection.sentStopHostedSessionMessages()).toEqual([]);
		expect(facade.warnAboutHostedSessionsNotAdoptedDuringStartup()).toBe(0);
	});
});
