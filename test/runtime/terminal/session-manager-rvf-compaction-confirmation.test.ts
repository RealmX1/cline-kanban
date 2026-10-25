import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { AgentSessionPtyHostRuntimeFacade } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-facade";
import type { AgentSessionPtyHostControllerToHostMessage } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	applyCodexAutomaticCompactionPhaseObservation,
	resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs,
} from "../../../src/core/codex-rvf-closeout-compaction-aware-confirmation";
import * as taskMessageInjectionLedger from "../../../src/core/task-message-injection-ledger";
import { readTaskMessageInjectionLedger } from "../../../src/core/task-message-injection-ledger";
import { updateRvfAutomaticCloseoutRecords } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import * as rvfCloseoutCompactionConfirmationPersistence from "../../../src/rvf-automatic-closeout/rvf-closeout-compaction-confirmation-persistence";
import { resolveRvfCloseoutCompactionConfirmationPersistence } from "../../../src/rvf-automatic-closeout/rvf-closeout-compaction-confirmation-persistence";
import * as agentSessionAdapters from "../../../src/terminal/agent-session-adapters";
import {
	type CodexNativePromptDeliveryInput,
	type CodexNativePromptDeliveryResult,
	deliverCodexNativePromptWithoutChangingComposer,
} from "../../../src/terminal/codex-native-prompt-delivery";
import { PtySession } from "../../../src/terminal/pty-session";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { parseTerminalSessionAdoptionRecord } from "../../../src/terminal/terminal-session-adoption-record-for-runtime-restart";
import { createRvfCloseoutCompactionConfirmationIsolatedFixture } from "../rvf-automatic-closeout/rvf-closeout-compaction-confirmation-isolated-fixture";

const controlRequest = vi.hoisted(() =>
	vi.fn(async (_method: string): Promise<unknown> => ({ data: [{ id: "new-turn", status: "inProgress" }] })),
);
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: async (
		operation: (port: { request: typeof controlRequest }) => Promise<unknown>,
	) => operation({ request: controlRequest }),
}));

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

function readCurrentSummaryForBindingMutation(manager: TerminalSessionManager): RuntimeTaskSessionSummary {
	const entry = (manager as unknown as { entries: Map<string, { summary: RuntimeTaskSessionSummary }> }).entries.get(
		"conversation",
	);
	if (!entry) throw new Error("隔离接管会话不存在");
	return entry.summary;
}

async function prepareAdoption(
	options: {
		compacting?: boolean;
		nativeSessionChanged?: boolean;
		stopped?: boolean;
		confirmedImmediately?: boolean;
		submissionTransport?: "codex_native_request" | "pty_submission";
		nativeTurnIdReturnedBySubmissionRequest?: string;
		readNativeAcceptance?: "multiple_successors" | "human_successor" | "returned_turn" | "client_message";
		beforeAdoption?: (manager: TerminalSessionManager) => void;
		hostSpawnedAtChanged?: boolean;
		controlHostChanged?: boolean;
		runtimeIncarnationChanged?: boolean;
	} = {},
) {
	controlRequest.mockImplementation(async () => ({ data: [{ id: "new-turn", status: "inProgress" }] }));
	const fixture = await createRvfCloseoutCompactionConfirmationIsolatedFixture();
	vi.useFakeTimers();
	vi.setSystemTime(110_000);
	const context = await resolveRvfCloseoutCompactionConfirmationPersistence({
		workspaceId: fixture.workspaceId,
		summary: fixture.summary,
		idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
	});
	if (!context) throw new Error("隔离自动收尾未获得绑定");
	let snapshot = {
		...fixture.initialSnapshot,
		...(options.submissionTransport
			? { submissionTransport: options.submissionTransport, clientUserMessageId: null }
			: {}),
		...(options.nativeTurnIdReturnedBySubmissionRequest
			? {
					nativeTurnId: options.nativeTurnIdReturnedBySubmissionRequest,
					nativeTurnIdReturnedBySubmissionRequest: options.nativeTurnIdReturnedBySubmissionRequest,
				}
			: {}),
	};
	await context.persistSnapshot(snapshot, null);
	if (options.compacting) {
		snapshot = applyCodexAutomaticCompactionPhaseObservation(snapshot, {
			phase: "started",
			nativeTurnId: "new-turn",
			capturedAtEpochMs: 103_000,
			receivedAtEpochMs: 103_000,
			hookDeliveryId: "pre-before-restart",
		});
		await context.persistSnapshot(snapshot, 0);
	}
	if (options.readNativeAcceptance)
		controlRequest.mockImplementation(async (method) => {
			if (method === "thread/loaded/list") return { data: ["native"], nextCursor: null };
			if (method === "thread/read") return { thread: { id: "native", cwd: fixture.summary.workspacePath } };
			if (method !== "thread/turns/list") throw new Error(`只读接管不得调用 ${method}`);
			const userMessage = {
				id: options.readNativeAcceptance === "client_message" ? "client-message" : "unrelated-user-message",
				type: "userMessage",
				content: [{ type: "text", text: fixture.promptText }],
			};
			return {
				data: [
					...(options.readNativeAcceptance === "returned_turn"
						? [{ id: "later-turn", status: "completed", items: [] }]
						: []),
					{ id: "new-turn", status: "completed", items: [userMessage] },
					...(options.readNativeAcceptance === "multiple_successors"
						? [{ id: "first-successor", status: "completed", items: [] }]
						: []),
					{ id: "old-turn", status: "completed", items: [] },
				],
				nextCursor: null,
			};
		});
	if (options.stopped)
		await updateRvfAutomaticCloseoutRecords(fixture.storePath, () => ({
			records: [
				{ ...fixture.record, status: "paused", explicitStopRequestedAt: 109_000, pauseReason: "用户明确 Stop" },
			],
			value: null,
		}));
	let nativeInput: CodexNativePromptDeliveryInput | undefined;
	let finishNativeObservation: ((result: CodexNativePromptDeliveryResult) => void) | undefined;
	const sender = vi.fn(async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
		nativeInput = input;
		if (options.readNativeAcceptance)
			return deliverCodexNativePromptWithoutChangingComposer({
				...input,
				confirmationDeadlineAtEpochMs: async () => 0,
			});
		if (options.confirmedImmediately)
			return {
				status: "confirmed",
				evidence: {
					clientUserMessageId: "client-message",
					nativeSessionId: "native",
					nativeTurnId: "new-turn",
					nativeUserMessageId: "accepted-message",
				},
			};
		return new Promise((resolveObservation) => {
			finishNativeObservation = resolveObservation;
		});
	});
	const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: sender });
	onTestFinished(() => manager.dispose());
	const handle = {
		pid: 1234,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		hasExited: () => false,
		wasInterrupted: () => false,
		publishTerminalSessionAdoptionRecordForRuntimeRestart: vi.fn(),
	};
	const summary = options.nativeSessionChanged
		? {
				...fixture.summary,
				agentNativeConversationSessionIdentity: {
					...fixture.summary.agentNativeConversationSessionIdentity,
					sourceAgentId: "codex" as const,
					nativeSessionId: "other",
					transcriptPath: null,
					observedAt: 1,
				},
			}
		: fixture.summary;
	if (options.controlHostChanged && summary.codexNativeSessionControlEndpoint)
		summary.codexNativeSessionControlEndpoint.socketPath += ".other-host";
	if (options.runtimeIncarnationChanged) {
		summary.runtimeSessionIncarnationId = "3a46f8a1-1480-46c6-bcc3-19136d9176ac";
		if (summary.codexNativeSessionControlEndpoint)
			summary.codexNativeSessionControlEndpoint.runtimeSessionIncarnationId = summary.runtimeSessionIncarnationId;
	}
	options.beforeAdoption?.(manager);
	const outcome = await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
		{
			taskId: "conversation",
			hostedSessionKind: "task_agent_session",
			pid: 1234,
			spawnedAtEpochMs: options.hostSpawnedAtChanged ? 2 : 1,
			cols: 100,
			rows: 30,
			exitedWhileRuntimeWasAbsent: false,
			terminalSessionAdoptionRecord: {
				terminalSessionAdoptionRecordSchemaVersion: 1,
				recordedAtEpochMs: 109_000,
				summary,
				carriedActiveProcessStateFields: {
					codexAutomaticCompactionPhaseHooksConfigured: true,
					nativeCompactionAwareConfirmation: snapshot,
				},
				rederivationInputs: {
					suppressScrollbackErasure: true,
					suppressDeviceAttributeQueries: false,
					outputReactionEngineWasActive: false,
				},
			},
			adoptHostedTerminalPtyProcess: async () => handle,
			terminateHostedTerminalPtyProcessAfterRefusedAdoption: vi.fn(),
		},
	]);
	expect(outcome[0]?.adoptionOutcome).toBe("adopted_running_session");
	return {
		...fixture,
		manager,
		sender,
		handle,
		nativeInput: () => nativeInput,
		finish: (result: CodexNativePromptDeliveryResult) => finishNativeObservation?.(result),
		currentSummary: () => readCurrentSummaryForBindingMutation(manager),
		snapshot,
	};
}

describe("RVF 压缩确认的真实账本与 hosted 接管衔接", () => {
	it.each(["legacy_hosted_handle", "in_process_pty"] as const)(
		"缺少 hosted 启动时间的 %s 继续使用 runtime 时间",
		async (mode) => {
			const fixture = await createRvfCloseoutCompactionConfirmationIsolatedFixture();
			vi.useFakeTimers();
			vi.setSystemTime(110_000);
			vi.spyOn(agentSessionAdapters, "prepareAgentLaunch").mockResolvedValue({ args: [], env: {} });
			const handle = {
				pid: 1234,
				write: vi.fn(),
				resize: vi.fn(),
				pause: vi.fn(),
				resume: vi.fn(),
				stop: vi.fn(),
				hasExited: () => false,
				wasInterrupted: () => false,
			};
			if (mode === "in_process_pty") vi.spyOn(PtySession, "spawn").mockReturnValue(handle as unknown as PtySession);
			const manager = new TerminalSessionManager({
				...(mode === "legacy_hosted_handle"
					? { hostedTerminalPtyProcessSpawner: { spawnHostedTerminalPtyProcess: async () => handle } }
					: {}),
			});
			onTestFinished(() => manager.dispose());
			await manager.startTaskSession({
				taskId: "legacy-time-source",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: fixture.fixture.fixtureRootDirectoryPath,
				prompt: "",
			});
			const active = (
				manager as unknown as {
					entries: Map<string, { active: { terminalSessionIncarnationSpawnedAtEpochMs: number } }>;
				}
			).entries.get("legacy-time-source")?.active;
			expect(active?.terminalSessionIncarnationSpawnedAtEpochMs).toBe(110_000);
		},
	);

	it("首次 hosted 启动使用 host 时间，runtime 时间不同仍能接管同一提交", async () => {
		const fixture = await createRvfCloseoutCompactionConfirmationIsolatedFixture();
		vi.useFakeTimers();
		vi.setSystemTime(110_000);
		const endpoint = fixture.summary.codexNativeSessionControlEndpoint;
		const identity = fixture.summary.agentNativeConversationSessionIdentity;
		if (!endpoint || !identity) throw new Error("隔离会话缺少原生身份或控制端点");
		const hostSpawnedAtEpochMs = 90_000;
		const sendControlMessage = vi.fn<(message: AgentSessionPtyHostControllerToHostMessage) => void>();
		const sendHostedSessionInputBytes = vi.fn();
		const connection = {
			isClosed: false,
			setEventHandlers: vi.fn(),
			requestSpawnHostedSession: async () => ({
				kind: "spawned",
				hostedSessionChannelNumber: 1,
				pid: 1234,
				spawnedAtEpochMs: hostSpawnedAtEpochMs,
			}),
			sendControlMessage,
			sendHostedSessionInputBytes,
			closeAfterFlushingPendingFrames: async () => {},
		};
		vi.spyOn(AgentSessionPtyHostControllerConnection, "connectAsController").mockResolvedValue(
			connection as unknown as AgentSessionPtyHostControllerConnection,
		);
		vi.spyOn(agentSessionAdapters, "prepareAgentLaunch").mockResolvedValue({
			args: [],
			env: {},
			codexAutomaticCompactionPhaseHooksConfigured: true,
		});
		const facade = await AgentSessionPtyHostRuntimeFacade.start({
			runtimeIdentity: { runtimeHomeDirectoryPath: fixture.fixture.isolatedHomeDirectoryPath, runtimePort: 3996 },
			warn: vi.fn(),
			currentBuildHostDescriptor: {
				hostBuildIdentity: "0011223344556677".repeat(4),
				launchCommand: { executablePath: process.execPath, leadingArguments: [] },
			},
		});
		onTestFinished(() => facade.closeControllerConnectionsAfterFlushingPendingFrames());
		const initialSender = vi.fn(async (input: CodexNativePromptDeliveryInput) => {
			await input.onRequestAttempted({ predecessorNativeTurnId: "old-turn" });
			await input.onNativeTurnStarted?.("new-turn");
			return new Promise<CodexNativePromptDeliveryResult>(() => {});
		});
		const previousManager = new TerminalSessionManager({
			hostedTerminalPtyProcessSpawner: facade.createHostedTerminalPtyProcessSpawnerForWorkspace(
				fixture.workspaceId,
				fixture.fixture.fixtureRootDirectoryPath,
			),
			prepareCodexNativeSessionControlHostLaunch: async (input) => ({
				binary: "codex-control-host",
				args: [],
				endpoint: {
					...endpoint,
					runtimeSessionIncarnationId: input.runtimeSessionIncarnationId,
				},
				cleanup: async () => {},
			}),
			deliverCodexNativePromptWithoutChangingComposer: initialSender,
		});
		onTestFinished(() => previousManager.dispose());
		await previousManager.startTaskSession({
			taskId: "conversation",
			workspaceId: fixture.workspaceId,
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: fixture.fixture.fixtureRootDirectoryPath,
			prompt: "",
		});
		previousManager.applyAgentNativeConversationSessionIdentity("conversation", identity);
		const startedSummary = previousManager.getSummary("conversation");
		if (!startedSummary) throw new Error("首次 hosted 启动没有 summary");
		const context = await resolveRvfCloseoutCompactionConfirmationPersistence({
			workspaceId: fixture.workspaceId,
			summary: startedSummary,
			idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
		});
		if (!context) throw new Error("首次 hosted 启动未获得自动收尾绑定");
		previousManager.submitTaskChatInputWhenReady("conversation", fixture.promptText, {
			idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
			rvfCloseoutCompactionConfirmationPersistence: context,
			onDeliveryOutcome: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(1_100);
		await vi.waitFor(() => expect(initialSender).toHaveBeenCalledOnce());
		await vi.waitFor(async () =>
			expect(await readTaskMessageInjectionLedger(fixture.ledgerPath)).toMatchObject([
				{ nativeCompactionAwareConfirmation: { nativeTurnId: "new-turn" } },
			]),
		);
		const persisted = (await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]
			?.nativeCompactionAwareConfirmation;
		expect(startedSummary.startedAt).not.toBe(hostSpawnedAtEpochMs);
		expect(persisted?.binding.terminalSessionSpawnedAtEpochMs).toBe(hostSpawnedAtEpochMs);
		const latestPublication = sendControlMessage.mock.calls
			.map(([message]) => message)
			.filter((message) => message.type === "put_hosted_session_adoption_record")
			.at(-1);
		const parsed = parseTerminalSessionAdoptionRecord(latestPublication?.adoptionRecord);
		if (parsed.kind !== "usable_adoption_record") throw new Error("首次 hosted 启动未发布可接管记录");
		const resumedSender = vi.fn(
			async (): Promise<CodexNativePromptDeliveryResult> => ({
				status: "confirmed",
				evidence: {
					clientUserMessageId: "client-message",
					nativeSessionId: "native",
					nativeTurnId: "new-turn",
					nativeUserMessageId: "accepted-after-real-hosted-start",
				},
			}),
		);
		const resumedManager = new TerminalSessionManager({
			deliverCodexNativePromptWithoutChangingComposer: resumedSender,
		});
		onTestFinished(() => resumedManager.dispose());
		await resumedManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			{
				taskId: "conversation",
				hostedSessionKind: "task_agent_session",
				pid: 1234,
				spawnedAtEpochMs: hostSpawnedAtEpochMs,
				cols: 100,
				rows: 30,
				exitedWhileRuntimeWasAbsent: false,
				terminalSessionAdoptionRecord: parsed.adoptionRecord,
				adoptHostedTerminalPtyProcess: async () => ({
					pid: 1234,
					write: vi.fn(),
					resize: vi.fn(),
					pause: vi.fn(),
					resume: vi.fn(),
					stop: vi.fn(),
					hasExited: () => false,
					wasInterrupted: () => false,
				}),
				terminateHostedTerminalPtyProcessAfterRefusedAdoption: vi.fn(),
			},
		]);
		await vi.waitFor(async () =>
			expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
				"delivered_and_submit_confirmed",
			),
		);
		expect(resumedSender).toHaveBeenCalledOnce();
		expect(sendHostedSessionInputBytes).not.toHaveBeenCalled();
	});

	it("同宿主热接管沿用原截止和消息关联，只恢复只读观察", async () => {
		const fixture = await prepareAdoption({ compacting: true });
		await vi.waitFor(() => expect(fixture.sender).toHaveBeenCalledOnce());
		const input = fixture.nativeInput();
		expect(input?.previouslySubmitted).toEqual({ predecessorNativeTurnId: "old-turn", nativeTurnId: null });
		expect(await input?.confirmationDeadlineAtEpochMs?.()).toBe(403_000);
		expect(fixture.handle.write).not.toHaveBeenCalled();
		expect(await input?.beforeSubmit()).toBe(false);
		expect(() => input?.onRequestAttempted()).toThrow("不得再次发送");
		fixture.finish({ status: "unconfirmed" });
		await vi.waitFor(async () =>
			expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
				"delivery_failed",
			),
		);
	});

	it.each(["multiple_successors", "human_successor"] as const)(
		"PTY 阶段回合没有提交关联时不冒领同文消息：%s",
		async (readNativeAcceptance) => {
			const fixture = await prepareAdoption({
				compacting: true,
				submissionTransport: "pty_submission",
				readNativeAcceptance,
			});
			await vi.waitFor(async () =>
				expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
					"delivery_failed",
				),
			);
			expect(fixture.nativeInput()?.previouslySubmitted?.nativeTurnId).toBeNull();
			expect(fixture.handle.write).not.toHaveBeenCalled();
			expect(controlRequest.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
		},
	);

	it("旧原生快照缺少提交响应关联时，阶段事件和同文后继不补成接受证明", async () => {
		const fixture = await prepareAdoption({ compacting: true, readNativeAcceptance: "multiple_successors" });
		await vi.waitFor(async () =>
			expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
				"delivery_failed",
			),
		);
		expect(fixture.nativeInput()?.previouslySubmitted?.nativeTurnId).toBeNull();
		expect(fixture.handle.write).not.toHaveBeenCalled();
	});

	it.each(["returned_turn", "client_message"] as const)(
		"明确的提交响应回合或客户端消息关联仍可只读确认：%s",
		async (readNativeAcceptance) => {
			const fixture = await prepareAdoption({
				compacting: true,
				readNativeAcceptance,
				...(readNativeAcceptance === "returned_turn"
					? { nativeTurnIdReturnedBySubmissionRequest: "new-turn" }
					: {}),
			});
			await vi.waitFor(async () =>
				expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
					"delivered_and_submit_confirmed",
				),
			);
			expect(fixture.handle.write).not.toHaveBeenCalled();
			expect(controlRequest.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
		},
	);

	it("实时阶段持久化后才延长，完成后恢复余下普通预算；压缩本身不结算成功", async () => {
		const fixture = await prepareAdoption();
		await vi.waitFor(() => expect(fixture.sender).toHaveBeenCalledOnce());
		const observe = (phase: "started" | "completed", nowMs: number) =>
			fixture.manager.observeRvfCloseoutNativeCompactionPhase("conversation", {
				workspaceId: fixture.workspaceId,
				nativeSessionId: "native",
				nativeTurnId: "new-turn",
				runtimeSessionIncarnationId: fixture.initialSnapshot.binding.runtimeSessionIncarnationId,
				phase,
				capturedAtEpochMs: nowMs,
				receivedAtEpochMs: nowMs,
				hookDeliveryId: `${phase}-${nowMs}`,
			});
		await observe("started", 110_000);
		let persisted = (await readTaskMessageInjectionLedger(fixture.ledgerPath))[0];
		expect(persisted?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		expect(persisted?.nativeCompactionAwareConfirmation?.phase).toBe("waiting_for_automatic_context_compaction");
		expect(await fixture.nativeInput()?.confirmationDeadlineAtEpochMs?.()).toBe(410_000);
		vi.setSystemTime(230_000);
		await observe("completed", 230_000);
		persisted = (await readTaskMessageInjectionLedger(fixture.ledgerPath))[0];
		expect(persisted?.nativeCompactionAwareConfirmation?.accumulatedCompactionWaitMs).toBe(120_000);
		expect(await fixture.nativeInput()?.confirmationDeadlineAtEpochMs?.()).toBe(235_000);
		expect(fixture.handle.write).not.toHaveBeenCalled();
		fixture.finish({ status: "unconfirmed" });
		await vi.waitFor(async () =>
			expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
				"delivery_failed",
			),
		);
	});

	it.each([
		{ nativeSessionChanged: true },
		{ stopped: true },
		{ hostSpawnedAtChanged: true },
		{ controlHostChanged: true },
		{ runtimeIncarnationChanged: true },
	])("换绑或明确 Stop 不恢复投递：%j", async (options) => {
		const fixture = await prepareAdoption(options);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(fixture.sender).not.toHaveBeenCalled();
		expect(fixture.handle.write).not.toHaveBeenCalled();
	});

	it.each<{
		name: string;
		rebind: (summary: RuntimeTaskSessionSummary) => void;
	}>([
		{
			name: "控制宿主 socket",
			rebind: (summary) => {
				if (summary.codexNativeSessionControlEndpoint)
					summary.codexNativeSessionControlEndpoint.socketPath += ".rebound";
			},
		},
		{
			name: "原生转录路径",
			rebind: (summary) => {
				if (summary.agentNativeConversationSessionIdentity)
					summary.agentNativeConversationSessionIdentity.transcriptPath += ".rebound";
			},
		},
		{
			name: "工作区路径",
			rebind: (summary) => {
				summary.workspacePath += ".rebound";
			},
		},
		{
			name: "控制端点 workspaceId",
			rebind: (summary) => {
				if (summary.codexNativeSessionControlEndpoint)
					summary.codexNativeSessionControlEndpoint.workspaceId += "-rebound";
			},
		},
		{
			name: "控制端点 conversationSessionId",
			rebind: (summary) => {
				if (summary.codexNativeSessionControlEndpoint)
					summary.codexNativeSessionControlEndpoint.conversationSessionId += "-rebound";
			},
		},
		{
			name: "控制端点 runtimeSessionIncarnationId",
			rebind: (summary) => {
				if (summary.codexNativeSessionControlEndpoint)
					summary.codexNativeSessionControlEndpoint.runtimeSessionIncarnationId =
						"3a46f8a1-1480-46c6-bcc3-19136d9176ac";
			},
		},
		{
			name: "运行时代际",
			rebind: (summary) => {
				summary.runtimeSessionIncarnationId = "3a46f8a1-1480-46c6-bcc3-19136d9176ac";
			},
		},
		{
			name: "原生会话",
			rebind: (summary) => {
				if (summary.agentNativeConversationSessionIdentity)
					summary.agentNativeConversationSessionIdentity.nativeSessionId = "native-rebound";
			},
		},
		{
			name: "会话启动时间",
			rebind: (summary) => {
				summary.startedAt = 2;
			},
		},
	])("接管观察中更换 $name 后，旧确认不得入账也不得重发", async ({ rebind }) => {
		const fixture = await prepareAdoption();
		await vi.waitFor(() => expect(fixture.sender).toHaveBeenCalledOnce());
		rebind(fixture.currentSummary());
		expect(fixture.nativeInput()?.isCurrent()).toBe(false);
		expect(await fixture.nativeInput()?.confirmationDeadlineAtEpochMs?.()).toBe(0);
		fixture.finish({
			status: "confirmed",
			evidence: {
				clientUserMessageId: "client-message",
				nativeSessionId: "native",
				nativeTurnId: "new-turn",
				nativeUserMessageId: "stale-accepted-message",
			},
		});
		await vi.advanceTimersByTimeAsync(1_000);
		const persisted = (await readTaskMessageInjectionLedger(fixture.ledgerPath))[0];
		expect(persisted?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		expect(persisted?.codex_native_prompt_delivery_evidence).toBeUndefined();
		expect(fixture.sender).toHaveBeenCalledOnce();
		expect(fixture.handle.write).not.toHaveBeenCalled();
	});

	it("同一 active 对象的 PTY 启动代际变化也拒绝旧观察", async () => {
		const fixture = await prepareAdoption();
		await vi.waitFor(() => expect(fixture.sender).toHaveBeenCalledOnce());
		const active = (
			fixture.manager as unknown as {
				entries: Map<string, { active: { terminalSessionIncarnationSpawnedAtEpochMs: number } }>;
			}
		).entries.get("conversation")?.active;
		if (!active) throw new Error("隔离会话没有 active 代际");
		active.terminalSessionIncarnationSpawnedAtEpochMs += 1;
		expect(fixture.nativeInput()?.isCurrent()).toBe(false);
		expect(await fixture.nativeInput()?.confirmationDeadlineAtEpochMs?.()).toBe(0);
		fixture.finish({ status: "unconfirmed" });
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"accepted_pending_submit_confirmation",
		);
		expect(fixture.sender).toHaveBeenCalledOnce();
		expect(fixture.handle.write).not.toHaveBeenCalled();
	});

	it.each(["ledger_read", "binding_resolution", "adoption_snapshot_persistence"] as const)(
		"%s 等待期间换绑后，不安装旧观察或确认",
		async (boundary) => {
			let releaseBoundary: (() => void) | undefined;
			let boundaryIsPending = false;
			const blockedBoundary = new Promise<void>((resolve) => {
				releaseBoundary = resolve;
			});
			const readLedger = taskMessageInjectionLedger.readTaskMessageInjectionLedger;
			const resolvePersistence =
				rvfCloseoutCompactionConfirmationPersistence.resolveRvfCloseoutCompactionConfirmationPersistence;
			const pauseAtBoundary = async () => {
				boundaryIsPending = true;
				await blockedBoundary;
			};
			const fixture = await prepareAdoption({
				beforeAdoption: () => {
					if (boundary === "ledger_read") {
						vi.spyOn(taskMessageInjectionLedger, "readTaskMessageInjectionLedger").mockImplementation(
							async (path) => {
								const records = await readLedger(path);
								if (!boundaryIsPending) await pauseAtBoundary();
								return records;
							},
						);
						return;
					}
					vi.spyOn(
						rvfCloseoutCompactionConfirmationPersistence,
						"resolveRvfCloseoutCompactionConfirmationPersistence",
					).mockImplementation(async (input) => {
						const context = await resolvePersistence(input);
						if (!context || !input.resumeExistingSubmissionOnly) return context;
						if (boundary === "binding_resolution") {
							await pauseAtBoundary();
							return context;
						}
						return {
							...context,
							persistSnapshot: async (...args) => {
								const saved = await context.persistSnapshot(...args);
								await pauseAtBoundary();
								return saved;
							},
						};
					});
				},
			});
			await vi.waitFor(() => expect(boundaryIsPending).toBe(true));
			fixture.currentSummary().workspacePath += ".rebound-during-adoption";
			releaseBoundary?.();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(fixture.sender).not.toHaveBeenCalled();
			expect(fixture.handle.write).not.toHaveBeenCalled();
			const persisted = (await readLedger(fixture.ledgerPath))[0];
			expect(persisted?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
			expect(persisted?.codex_native_prompt_delivery_evidence).toBeUndefined();
		},
	);

	it("截止时间等待授权期间更换转录后，异步返回不得延续旧观察", async () => {
		let releaseAuthorization: (() => void) | undefined;
		let authorizationIsPending = false;
		const blockedAuthorization = new Promise<void>((resolve) => {
			releaseAuthorization = resolve;
		});
		const resolvePersistence =
			rvfCloseoutCompactionConfirmationPersistence.resolveRvfCloseoutCompactionConfirmationPersistence;
		const fixture = await prepareAdoption({
			beforeAdoption: () => {
				vi.spyOn(
					rvfCloseoutCompactionConfirmationPersistence,
					"resolveRvfCloseoutCompactionConfirmationPersistence",
				).mockImplementation(async (input) => {
					const context = await resolvePersistence(input);
					if (!context || !input.resumeExistingSubmissionOnly) return context;
					return {
						...context,
						validateStillAuthorized: async () => {
							authorizationIsPending = true;
							await blockedAuthorization;
							return context.validateStillAuthorized();
						},
					};
				});
			},
		});
		await vi.waitFor(() => expect(fixture.sender).toHaveBeenCalledOnce());
		const deadline = fixture.nativeInput()?.confirmationDeadlineAtEpochMs?.();
		await vi.waitFor(() => expect(authorizationIsPending).toBe(true));
		const identity = fixture.currentSummary().agentNativeConversationSessionIdentity;
		if (!identity) throw new Error("隔离会话缺少原生身份");
		identity.transcriptPath += ".rebound-during-authorization";
		releaseAuthorization?.();
		expect(await deadline).toBe(0);
		fixture.finish({ status: "unconfirmed" });
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"accepted_pending_submit_confirmation",
		);
		expect(fixture.sender).toHaveBeenCalledOnce();
		expect(fixture.handle.write).not.toHaveBeenCalled();
	});

	it("确认后保留同一正文摘要和 fixed deadline，后续清扫不重新执行", async () => {
		const fixture = await prepareAdoption({ compacting: true, confirmedImmediately: true });
		await vi.waitFor(async () =>
			expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
				"delivered_and_submit_confirmed",
			),
		);
		const persisted = (await readTaskMessageInjectionLedger(fixture.ledgerPath))[0];
		expect(persisted?.nativeCompactionAwareConfirmation?.firstSubmissionAtEpochMs).toBe(100_000);
		expect(
			persisted?.nativeCompactionAwareConfirmation &&
				resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(persisted.nativeCompactionAwareConfirmation),
		).toBe(403_000);
		expect(persisted?.codex_native_prompt_delivery_evidence?.nativeUserMessageId).toBe("accepted-message");
		const before = await readFile(fixture.ledgerPath, "utf8");
		await fixture.manager.observeRvfCloseoutNativeCompactionPhase("conversation", {
			workspaceId: fixture.workspaceId,
			nativeSessionId: "native",
			nativeTurnId: "new-turn",
			runtimeSessionIncarnationId: fixture.initialSnapshot.binding.runtimeSessionIncarnationId,
			phase: "completed",
			capturedAtEpochMs: 111_000,
			receivedAtEpochMs: 111_000,
			hookDeliveryId: "late-post",
		});
		expect(await readFile(fixture.ledgerPath, "utf8")).toBe(before);
		expect(fixture.sender).toHaveBeenCalledOnce();
	});
});
