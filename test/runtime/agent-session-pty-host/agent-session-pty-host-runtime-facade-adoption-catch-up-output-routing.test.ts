// 接管时追赶字节与实时输出的分流：attach 响应之后，追赶帧分散在多个 socket data 事件里到达（host 按 64 KiB 分帧、
// 多次 write）。它们必须全部进 onCatchUpOutput、零字节进 onData，且 adopt 的 promise 只在最后一段追赶交付后 resolve。
//
// 用假的 controller 连接驱动真实的 facade + 链路：每个「socket data 事件」= 一次同步发出的若干帧，事件之间让出一轮事件循环，
// 与真实连接「响应 resolve → 同一 chunk 里的后续帧同步分发 → continuation 在 microtask 里跑」的时序一致。
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
} from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";
import type {
	HostedTerminalPtySessionAdoptionCandidate,
	TerminalPtyProcessExitEvent,
} from "../../../src/terminal/terminal-pty-process-handle";

const HOST_BUILD_IDENTITY_FOR_TEST = "0123456789abcdef".repeat(4);
const ADOPTED_HOSTED_SESSION_CHANNEL_NUMBER = 7;
const CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST = 64 * 1024;

// 只实现 facade 与链路在接管路径上用到的方法；帧的到达由测试逐个「socket data 事件」驱动。
class FakeAgentSessionPtyHostControllerConnectionDrivenByTest {
	isClosed = false;
	readonly sentControlMessages: AgentSessionPtyHostControllerToHostMessage[] = [];
	private eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers | null = null;
	private resolvePendingAttachResponse: ((outcome: AttachHostedSessionOutputStreamOutcome) => void) | null = null;

	constructor(private readonly hostedSessionListings: AgentSessionPtyHostHostedSessionListing[]) {}

	setEventHandlers(eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers): void {
		this.eventHandlers = eventHandlers;
	}

	sendControlMessage(message: AgentSessionPtyHostControllerToHostMessage): void {
		this.sentControlMessages.push(message);
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

	async closeAfterFlushingPendingFrames(): Promise<void> {}

	get attachRequestIsPending(): boolean {
		return this.resolvePendingAttachResponse !== null;
	}

	// 同一个 socket data 事件里先到 attach 响应、再到若干输出帧（真实连接的 dispatchFrames 同步逐帧分发）。
	deliverAttachResponseAndOutputFramesInOneSocketDataEvent(
		attachOutcome: AttachHostedSessionOutputStreamOutcome,
		outputFrames: Array<{ startByteOffset: number; bytes: Buffer }>,
	): void {
		const resolveAttachResponse = this.resolvePendingAttachResponse;
		if (resolveAttachResponse === null) {
			throw new Error("no attach request is pending");
		}
		this.resolvePendingAttachResponse = null;
		resolveAttachResponse(attachOutcome);
		this.deliverOutputFramesInOneSocketDataEvent(outputFrames);
	}

	deliverOutputFramesInOneSocketDataEvent(outputFrames: Array<{ startByteOffset: number; bytes: Buffer }>): void {
		for (const outputFrame of outputFrames) {
			this.eventHandlers?.onHostedSessionOutput(
				ADOPTED_HOSTED_SESSION_CHANNEL_NUMBER,
				outputFrame.startByteOffset,
				outputFrame.bytes,
			);
		}
	}

	closeConnectionFromHostSide(): void {
		this.isClosed = true;
		this.eventHandlers?.onConnectionClosed("connection_closed");
	}
}

// 让出一轮事件循环：上一个「socket data 事件」触发的 microtask（含 attach 响应之后的 continuation）全部跑完。
function yieldToNextSocketDataEventTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function buildHostedSessionListing(
	exitRecord: AgentSessionPtyHostHostedSessionExitRecord | null,
): AgentSessionPtyHostHostedSessionListing {
	return {
		hostedSessionKey: "hosted-session-adopted",
		hostedSessionChannelNumber: ADOPTED_HOSTED_SESSION_CHANNEL_NUMBER,
		hostedSessionDescriptor: {
			workspaceId: "workspace-1",
			taskId: "task-adopted",
			hostedSessionKind: "shell_session",
		},
		pid: 4242,
		spawnedAtEpochMs: 1_000,
		retainedOutputStartByteOffset: 0,
		outputEndByteOffset: 0,
		exitRecord,
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

async function startFacadeOverFakeConnectionAndTakeAdoptionCandidate(
	exitRecord: AgentSessionPtyHostHostedSessionExitRecord | null = null,
): Promise<{
	fakeConnection: FakeAgentSessionPtyHostControllerConnectionDrivenByTest;
	adoptionCandidate: HostedTerminalPtySessionAdoptionCandidate;
}> {
	// /tmp 下的短目录：os.tmpdir()（macOS 的 /var/folders/…）会让 socket 路径触发 sun_path 回退、落进共享目录。
	const runtimeHomeDirectoryPath = mkdtempSync("/tmp/kphc-");
	runtimeHomeDirectoriesRemovedAfterEachTest.push(runtimeHomeDirectoryPath);
	const runtimeIdentity = { runtimeHomeDirectoryPath, runtimePort: 3999 };
	// generation 发现只看文件名；连接本身由下面的 spy 换成假连接。
	const currentGenerationSocketPath = resolveAgentSessionPtyHostSocketPath(
		runtimeIdentity,
		HOST_BUILD_IDENTITY_FOR_TEST,
	);
	mkdirSync(dirname(currentGenerationSocketPath), { recursive: true });
	writeFileSync(currentGenerationSocketPath, "");
	const fakeConnection = new FakeAgentSessionPtyHostControllerConnectionDrivenByTest([
		buildHostedSessionListing(exitRecord),
	]);
	vi.spyOn(AgentSessionPtyHostControllerConnection, "connectAsController").mockResolvedValue(
		fakeConnection as unknown as AgentSessionPtyHostControllerConnection,
	);
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
	});
	const [adoptionCandidate] = facade.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace("workspace-1");
	if (!adoptionCandidate) {
		throw new Error("expected one adoption candidate");
	}
	return { fakeConnection, adoptionCandidate };
}

describe("agent session pty host adoption catch-up output routing", () => {
	it("routes catch-up frames arriving in later socket data events to onCatchUpOutput only and resolves adoption after the last one", async () => {
		const { fakeConnection, adoptionCandidate } = await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const firstCatchUpFrameBytes = Buffer.alloc(CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST, "a");
		const secondCatchUpFrameBytes = Buffer.alloc(CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST, "b");
		const lastCatchUpFrameBytes = Buffer.alloc(100, "c");
		const catchUpEndByteOffset =
			firstCatchUpFrameBytes.byteLength + secondCatchUpFrameBytes.byteLength + lastCatchUpFrameBytes.byteLength;
		const firstLiveFrameBytes = Buffer.from("live-1", "utf8");
		const secondLiveFrameBytes = Buffer.from("live-2", "utf8");
		const observedEventOrder: string[] = [];
		const catchUpOutputChunks: Buffer[] = [];
		const liveOutputChunks: Buffer[] = [];
		let adoptionSettled = false;

		const adoptionPromise = adoptionCandidate
			.adoptHostedTerminalPtyProcess({
				onCatchUpOutput: (bytes) => {
					catchUpOutputChunks.push(bytes);
					observedEventOrder.push(`catch-up:${bytes.byteLength}`);
				},
				onData: (chunk) => {
					liveOutputChunks.push(chunk);
					observedEventOrder.push(`live:${chunk.toString("utf8")}`);
				},
				onExit: () => {
					observedEventOrder.push("exit");
				},
			})
			.then((adoptedHandle) => {
				adoptionSettled = true;
				observedEventOrder.push("adopted");
				return adoptedHandle;
			});
		await yieldToNextSocketDataEventTurn();
		expect(fakeConnection.attachRequestIsPending).toBe(true);

		// socket data 事件 1：attach 响应 + 第一段追赶（同一 chunk，句柄登记之前到达）。
		fakeConnection.deliverAttachResponseAndOutputFramesInOneSocketDataEvent(
			{
				kind: "attached",
				catchUpStartByteOffset: 0,
				catchUpEndByteOffset,
				overwrittenByteCountBeforeCatchUpStart: 0,
			},
			[{ startByteOffset: 0, bytes: firstCatchUpFrameBytes }],
		);
		await yieldToNextSocketDataEventTurn();
		expect(adoptionSettled).toBe(false);

		// socket data 事件 2：第二段追赶，attach 响应的 continuation 早已跑完。
		fakeConnection.deliverOutputFramesInOneSocketDataEvent([
			{ startByteOffset: firstCatchUpFrameBytes.byteLength, bytes: secondCatchUpFrameBytes },
		]);
		await yieldToNextSocketDataEventTurn();
		expect(adoptionSettled).toBe(false);
		expect(liveOutputChunks).toEqual([]);

		// socket data 事件 3：最后一段追赶紧跟着第一段实时输出。
		fakeConnection.deliverOutputFramesInOneSocketDataEvent([
			{
				startByteOffset: firstCatchUpFrameBytes.byteLength + secondCatchUpFrameBytes.byteLength,
				bytes: lastCatchUpFrameBytes,
			},
			{ startByteOffset: catchUpEndByteOffset, bytes: firstLiveFrameBytes },
		]);
		const adoptedHandle = await adoptionPromise;
		fakeConnection.deliverOutputFramesInOneSocketDataEvent([
			{ startByteOffset: catchUpEndByteOffset + firstLiveFrameBytes.byteLength, bytes: secondLiveFrameBytes },
		]);

		expect(adoptedHandle.pid).toBe(4242);
		expect(Buffer.concat(catchUpOutputChunks)).toEqual(
			Buffer.concat([firstCatchUpFrameBytes, secondCatchUpFrameBytes, lastCatchUpFrameBytes]),
		);
		expect(Buffer.concat(liveOutputChunks).toString("utf8")).toBe("live-1live-2");
		expect(observedEventOrder).toEqual([
			`catch-up:${CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST}`,
			`catch-up:${CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST}`,
			"catch-up:100",
			"live:live-1",
			"adopted",
			"live:live-2",
		]);
	});

	it("fails adoption instead of waiting forever when the connection closes before the catch-up range is fully delivered", async () => {
		const { fakeConnection, adoptionCandidate } = await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const liveOutputChunks: Buffer[] = [];
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: () => {},
			onData: (chunk) => liveOutputChunks.push(chunk),
			onExit: () => {},
		});
		await yieldToNextSocketDataEventTurn();
		fakeConnection.deliverAttachResponseAndOutputFramesInOneSocketDataEvent(
			{
				kind: "attached",
				catchUpStartByteOffset: 0,
				catchUpEndByteOffset: 2 * CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST,
				overwrittenByteCountBeforeCatchUpStart: 0,
			},
			[{ startByteOffset: 0, bytes: Buffer.alloc(CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST, "a") }],
		);
		await yieldToNextSocketDataEventTurn();
		fakeConnection.closeConnectionFromHostSide();

		await expect(adoptionPromise).rejects.toThrow(/before catch-up output was fully delivered/);
		expect(liveOutputChunks).toEqual([]);
	});

	it("returns the adopted handle without waiting when the catch-up range is empty and delivers later frames as live output", async () => {
		const { fakeConnection, adoptionCandidate } = await startFacadeOverFakeConnectionAndTakeAdoptionCandidate();
		const catchUpOutputChunks: Buffer[] = [];
		const liveOutputChunks: Buffer[] = [];
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: (bytes) => catchUpOutputChunks.push(bytes),
			onData: (chunk) => liveOutputChunks.push(chunk),
			onExit: () => {},
		});
		await yieldToNextSocketDataEventTurn();
		fakeConnection.deliverAttachResponseAndOutputFramesInOneSocketDataEvent(
			{
				kind: "attached",
				catchUpStartByteOffset: 500,
				catchUpEndByteOffset: 500,
				overwrittenByteCountBeforeCatchUpStart: 0,
			},
			[],
		);
		await adoptionPromise;
		fakeConnection.deliverOutputFramesInOneSocketDataEvent([
			{ startByteOffset: 500, bytes: Buffer.from("live", "utf8") },
		]);

		expect(catchUpOutputChunks).toEqual([]);
		expect(Buffer.concat(liveOutputChunks).toString("utf8")).toBe("live");
	});

	it("delivers the exit recorded while the runtime was absent only after the whole catch-up range", async () => {
		const exitRecord: AgentSessionPtyHostHostedSessionExitRecord = {
			exitCode: 3,
			signal: null,
			exitedAtEpochMs: 2_000,
		};
		const { fakeConnection, adoptionCandidate } =
			await startFacadeOverFakeConnectionAndTakeAdoptionCandidate(exitRecord);
		const observedEventOrder: string[] = [];
		const exitEvents: TerminalPtyProcessExitEvent[] = [];
		const adoptionPromise = adoptionCandidate.adoptHostedTerminalPtyProcess({
			onCatchUpOutput: (bytes) => observedEventOrder.push(`catch-up:${bytes.byteLength}`),
			onData: (chunk) => observedEventOrder.push(`live:${chunk.byteLength}`),
			onExit: (event) => {
				exitEvents.push(event);
				observedEventOrder.push("exit");
			},
		});
		await yieldToNextSocketDataEventTurn();
		fakeConnection.deliverAttachResponseAndOutputFramesInOneSocketDataEvent(
			{
				kind: "attached",
				catchUpStartByteOffset: 0,
				catchUpEndByteOffset: CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST + 10,
				overwrittenByteCountBeforeCatchUpStart: 0,
			},
			[{ startByteOffset: 0, bytes: Buffer.alloc(CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST, "a") }],
		);
		await yieldToNextSocketDataEventTurn();
		expect(observedEventOrder).toEqual([`catch-up:${CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST}`]);
		fakeConnection.deliverOutputFramesInOneSocketDataEvent([
			{ startByteOffset: CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST, bytes: Buffer.alloc(10, "b") },
		]);
		await adoptionPromise;

		expect(observedEventOrder).toEqual([
			`catch-up:${CATCH_UP_OUTPUT_FRAME_BYTE_LENGTH_LIKE_HOST}`,
			"catch-up:10",
			"exit",
		]);
		expect(exitEvents).toEqual([{ exitCode: 3 }]);
		expect(fakeConnection.sentControlMessages).toContainEqual({
			type: "acknowledge_hosted_session_exit",
			hostedSessionKey: "hosted-session-adopted",
		});
	});
});
