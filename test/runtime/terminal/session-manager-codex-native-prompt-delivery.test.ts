import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../../src/config/user-interface-preferences-shared-across-browser-origins";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import * as nativeDeliveryJournal from "../../../src/core/codex-native-prompt-delivery-journal";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../../../src/core/task-message-injection-ledger";
import {
	deliverOwnedCommandResultToActiveSession,
	readOwnedCommandResultReadinessTimeoutObservedAtEpochMs,
	reconcileOwnedCommandResultPromptDelivery,
} from "../../../src/server/owned-command-result-prompt-delivery";
import * as managedTaskPromptDelivery from "../../../src/state/managed-task-prompt-delivery-coordinator";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../../../src/state/queued-task-prompt-delivery-store";
import * as runtimeHeartbeat from "../../../src/state/runtime-process-instance-heartbeat-registry";
import * as workspaceState from "../../../src/state/workspace-state";
import { createTaskCommandExecutionService } from "../../../src/task-command-execution/task-command-execution-service";
import { mutateTaskCommandExecutions } from "../../../src/task-command-execution/task-command-execution-store";
import type {
	CodexNativePromptDeliveryInput,
	CodexNativePromptDeliveryResult,
} from "../../../src/terminal/codex-native-prompt-delivery";
import { createIdleHarnessBackgroundSessionReclaimWatchState } from "../../../src/terminal/harness-background-session-reclaim-watch-after-unsafe-resume-refusal";
import { type TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../../../src/terminal/session-manager";
import {
	createTerminalInputBoxOccupancyTrackerState,
	recordTerminalInputBytesIntoOccupancyTracker,
} from "../../../src/terminal/terminal-input-box-occupancy";
import type { PendingProgrammaticDeliveryReceipt } from "../../../src/terminal/terminal-session-active-process-state";
import { canTransitionTaskForHookEvent } from "../../../src/trpc/hook-event-task-transition-gate";

const INCARNATION = "e96aa879-02a4-480e-bbd6-97b7e5e83843";
const managedRecording = vi.hoisted(() => ({ begin: vi.fn(), settle: vi.fn() }));
const readNativeActivity = vi.hoisted(() => vi.fn());
vi.mock("../../../src/agent-session-history/native-agent-conversation-activity-reader", () => ({
	readNativeAgentConversationActivity: readNativeActivity,
}));
vi.mock("../../../src/state/managed-task-prompt-delivery-coordinator", async (importOriginal) => ({
	...(await importOriginal<typeof managedTaskPromptDelivery>()),
	beginManagedTaskPromptDelivery: managedRecording.begin,
	settleManagedTaskPromptDeliveryWithoutBlocking: managedRecording.settle,
}));
function installSession(manager: TerminalSessionManager, draft = "HUMAN_DRAFT") {
	const tracker = createTerminalInputBoxOccupancyTrackerState();
	if (draft) recordTerminalInputBytesIntoOccupancyTracker(tracker, Buffer.from(draft), 1);
	const write = vi.fn();
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "conversation-1",
		agentId: "codex",
		workspacePath: "/workspace",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		state: "awaiting_review",
		reviewReason: "hook",
		exitCode: null,
		runtimeSessionIncarnationId: INCARNATION,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "thread-1",
			transcriptPath: null,
			observedAt: 1,
		},
		codexNativeSessionControlEndpoint: {
			socketPath: "/isolated/control.sock",
			workspaceId: "workspace-1",
			conversationSessionId: "conversation-1",
			runtimeSessionIncarnationId: INCARNATION,
		},
	});
	const active = {
		terminalSessionIncarnationSpawnedAtEpochMs: 1,
		session: { write },
		inputBoxOccupancyTracker: tracker,
		lastUserInputAt: null as number | null,
		deferredStartupPromptText: null,
		taskChatInputDeliveryTimer: null,
		taskChatInputDeliveryGeneration: 0,
		submitConfirmTimer: null,
		submitConfirmGeneration: 0,
		programmaticDeliveryReceipt: null as PendingProgrammaticDeliveryReceipt | null,
		outputReactionScanBuffer: null,
		ptyOutputChunkArrivalSequenceNumber: 0,
		awaitingCodexPromptAfterEnter: false,
		suppressSubstantiveOutputUntilContinues: false,
		terminalSessionIncarnationToken: INCARNATION,
		recentlyAppliedHookEventDeliveryIdempotencyKeys: [],
	};
	const entry = {
		summary,
		active,
		listeners: new Map(),
		harnessBackgroundSessionReclaimWatchState: createIdleHarnessBackgroundSessionReclaimWatchState(),
		restartRequest: { kind: "task", request: { workspaceId: "workspace-1" } },
		terminalStateMirror: {
			getScreenSnapshot: async () => ({
				columnCount: 80,
				cursorRow: 0,
				cursorColumn: draft ? draft.length + 2 : 2,
				lines: [
					{
						text: `› ${draft || "Ask Codex to do anything"}`,
						isWrapped: false,
						dimmedTextColumnRanges: draft ? [] : [[2, 80]],
					},
				],
			}),
			getViewportSnapshot: async () => ({
				snapshot: `› ${draft || "Ask Codex to do anything"}`,
				rows: 24,
				cols: 80,
			}),
		},
	};
	(manager as unknown as { entries: Map<string, unknown> }).entries.set("conversation-1", entry);
	return {
		entry,
		active,
		tracker,
		write,
		setDraft: (value: string) => {
			draft = value;
		},
	};
}

describe("session manager 的 Codex 原生投递", () => {
	it.each([
		"two_owned_results",
		"timeout_then_restart",
		"timeout_then_transport_receipt_readback",
		"timeout_then_withdrawal_receipt_readback",
		"timeout_then_withdrawal_after_intent",
		"withdrawn_while_waiting",
	] as const)("所属结果经统一投递出口和终端门禁（%s）", async (scenario) => {
		vi.useRealTimers();
		const actualManagedDelivery = await vi.importActual<typeof managedTaskPromptDelivery>(
			"../../../src/state/managed-task-prompt-delivery-coordinator",
		);
		managedRecording.begin.mockImplementation(actualManagedDelivery.beginManagedTaskPromptDelivery);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const runtimeInstance = vi
			.spyOn(runtimeHeartbeat, "getThisRuntimeProcessInstanceId")
			.mockReturnValue("runtime-before-restart");
		const runtimeLiveness = vi
			.spyOn(runtimeHeartbeat, "readRuntimeProcessInstanceLiveness")
			.mockResolvedValue("dead");
		const directory = await mkdtemp(join(tmpdir(), "owned-result-terminal-chain-"));
		const workspaceDirectory = vi
			.spyOn(workspaceState, "getWorkspaceDirectoryPath")
			.mockImplementation((id) => join(directory, "workspaces", id));
		const workspacesRoot = vi
			.spyOn(workspaceState, "getWorkspacesRootPath")
			.mockReturnValue(join(directory, "workspaces"));
		const runtimeHome = vi.spyOn(workspaceState, "getRuntimeHomePath").mockReturnValue(directory);
		const workingDirectoryPath = await realpath(directory);
		const nativeSendInvocations = vi.fn<(clientUserMessageId: string) => void>();
		let nativeReady = scenario === "two_owned_results";
		let withdrawNoticeAfterIntent: (() => Promise<void>) | undefined;
		const native = vi.fn(async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
			const journal = input.deliveryJournal;
			if (!journal) throw new Error("缺少原生账本");
			const operation = await journal.prepare({
				workspaceId: input.workspaceId,
				conversationSessionId: input.summary.taskId,
				nativeSessionId: "thread-1",
				workingDirectoryPath,
				clientUserMessageId: input.clientUserMessageId,
				text: input.text,
			});
			if (!nativeReady) return { status: "not_ready" };
			if (operation.requestMayHaveBeenSent || !(await input.beforeSubmit())) return { status: "cancelled" };
			await journal.recordRequestIntent(null);
			await withdrawNoticeAfterIntent?.();
			await input.onRequestAttempted();
			if ((await input.validateImmediatelyBeforeNativeTurnStartRequest?.()) === false) {
				await journal.recordRequestNotInvoked?.();
				return { status: "cancelled" };
			}
			await journal.recordRequestInvoked();
			nativeSendInvocations(operation.clientUserMessageId);
			manager.confirmAcceptedAgentConversationInput("conversation-1", {
				observedAtMs: Date.now(),
				eventId: operation.clientUserMessageId,
				nativeSessionId: "thread-1",
				runtimeSessionIncarnationId: INCARNATION,
				submittedPromptText: input.text,
				acceptedNativeAgentTurnIsInProgress: true,
			});
			const evidence = {
				clientUserMessageId: operation.clientUserMessageId,
				nativeSessionId: "thread-1",
				nativeTurnId: operation.clientUserMessageId,
				nativeUserMessageId: operation.clientUserMessageId,
			};
			if (scenario !== "timeout_then_transport_receipt_readback") await journal.recordAcceptance(evidence);
			return { status: "confirmed", evidence };
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { entry, active, write } = installSession(manager);
		entry.summary = runtimeTaskSessionSummarySchema.parse({
			...entry.summary,
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			workspacePath: directory,
		});
		Object.assign(active, { outputReactionEngine: null, outputReactionSession: null });
		const acp = new AcpTaskSessionService();
		const launch = vi.fn(async () => {});
		const warnings = vi.fn<(message: string) => void>();
		const createService = () =>
			createTaskCommandExecutionService({
				readOwner: async (_workspaceId, _taskId, record) => ({
					taskId: "task",
					taskIncarnationCreatedAtEpochMs: 7,
					conversationSessionId: "conversation-1",
					nativeSessionId: "thread-1",
					worktreePath: directory,
					summary: manager.getSummary("conversation-1"),
					isNativeInputSubmissionBusy: manager.hasPendingProgrammaticTaskChatInputDelivery(
						"conversation-1",
						record?.resultDelivery?.resultId,
					),
				}),
				park: async (record) =>
					manager.parkTaskSessionAwaitingDispatchedBackgroundWork("conversation-1", {
						owningCommandExecutionId: record.executionId,
					}).ok,
				unpark: async (record) => {
					manager.unparkTaskSession("conversation-1", record.executionId);
				},
				deliver: (record, validate, settled) =>
					deliverOwnedCommandResultToActiveSession({
						record,
						scope: { workspaceId: "workspace-1", workspacePath: directory },
						summary: manager.getSummary("conversation-1"),
						validateBeforeTerminalWrite: validate,
						settled,
						warn: warnings,
						transport: {
							getScopedTerminalManager: async () => manager,
							getScopedAcpTaskSessionService: async () => acp,
							loadScopedRuntimeConfig: async () => ({
								globalConfigPath: join(directory, "config.json"),
								projectConfigPath: null,
								selectedAgentId: "codex",
								selectedShortcutLabel: null,
								agentAutonomousModeEnabled: false,
								newTaskStartInPlanModeByDefault: false,
								ompAgentSessionTransportForNewTasks: "pty_terminal",
								readyForReviewNotificationsEnabled: false,
								notificationSoundEnabled: false,
								autoContinueOnConnectionDropEnabled: false,
								programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: false,
								postDeployVerificationForceCompleteEnabled: false,
								shortcuts: [],
								commitPromptTemplate: "",
								openPrPromptTemplate: "",
								commitPromptTemplateDefault: "",
								openPrPromptTemplateDefault: "",
								userInterfacePreferencesSharedAcrossBrowserOrigins:
									USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
							}),
						},
					}),
				reconcileDelivery: (record) =>
					reconcileOwnedCommandResultPromptDelivery(record, (sessionId) => manager.getSummary(sessionId)),
				readReadinessTimeoutObservedAtEpochMs: readOwnedCommandResultReadinessTimeoutObservedAtEpochMs,
				listWorkspaceIds: async () => ["workspace-1"],
				warn: warnings,
				launch,
				inspectWorker: async () => "running",
			});
		let service = createService();
		try {
			const start = (name: string) =>
				service.start("workspace-1", {
					taskId: "task",
					idempotencyKey: name,
					specification: {
						command: ["isolated-no-process"],
						resumeCommand: ["isolated-no-process"],
						workingDirectory: directory,
						resultFile: join(directory, `${name}.json`),
						materialSha256: "a".repeat(64),
						label: name,
					},
				});
			if (scenario !== "two_owned_results") {
				const execution = await start("delayed-result");
				const resultFile = execution.specification.resultFile;
				if (scenario === "timeout_then_withdrawal_after_intent")
					withdrawNoticeAfterIntent = () =>
						writeFile(resultFile, JSON.stringify({ disposition: "machine_evidence_pending" }));
				await writeFile(
					resultFile,
					JSON.stringify({
						disposition: "agent_review_ready",
						agentContinuationNotice: {
							noticeId: "frozen-producer-notice",
							stage: "final_agent_review",
							text: "冻结的所属结果",
						},
					}),
				);
				await service.sweepExecution("workspace-1", execution.executionId);
				const delivery = (await service.inspect("workspace-1", execution)).resultDelivery;
				if (!delivery) throw new Error("未登记所属结果");
				const readQueueEntry = async () =>
					(await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace-1")).entriesByTaskId[
						"conversation-1"
					]?.find((entry) => entry.queueEntryId === delivery.resultId);
				const ledgerPath = getTaskMessageInjectionLedgerPath(join(directory, "workspaces", "workspace-1"));
				const readInjection = async () => (await readTaskMessageInjectionLedger(ledgerPath))[0];
				if (scenario === "withdrawn_while_waiting") {
					await vi.waitFor(
						async () =>
							expect((await readInjection())?.codex_native_prompt_delivery_operation?.sendPhase).toBe(
								"registered",
							),
						{ timeout: 8_000 },
					);
					await writeFile(resultFile, JSON.stringify({ disposition: "machine_evidence_pending" }));
					nativeReady = true;
					await vi.waitFor(
						async () =>
							expect(await readQueueEntry()).toMatchObject({
								deliveryState: "cancelled",
								lastDeliveryFailureNote: expect.stringContaining("原后台通知已从当前可投递清单撤下"),
								managedDelivery: { terminalDeliveryReceipt: { reason: "cancelled_before_delivery" } },
							}),
						{ timeout: 8_000 },
					);
					expect(nativeSendInvocations).not.toHaveBeenCalled();
					expect(write).not.toHaveBeenCalled();
					expect((await readInjection())?.codex_native_prompt_delivery_operation?.actualSendAttemptCount).toBe(0);
					return;
				}
				now += 61_000;
				await vi.waitFor(
					async () =>
						expect(await readQueueEntry()).toMatchObject({
							deliveryState: "settled_failed",
							managedDelivery: { terminalDeliveryReceipt: { reason: "terminal_prompt_readiness_timeout" } },
						}),
					{ timeout: 8_000 },
				);
				let originalClientUserMessageId: string | undefined;
				await vi.waitFor(async () => {
					const injection = await readInjection();
					expect(injection).toMatchObject({
						terminal_delivery_failure_reason: "terminal_prompt_readiness_timeout",
						codex_native_prompt_delivery_operation: { sendPhase: "registered", actualSendAttemptCount: 0 },
					});
					originalClientUserMessageId = injection.codex_native_prompt_delivery_operation?.clientUserMessageId;
				});
				expect(nativeSendInvocations).not.toHaveBeenCalled();
				expect(
					manager.getSummary("conversation-1")?.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds,
				).toEqual([execution.executionId]);
				if (scenario === "timeout_then_restart") {
					// 原生账本已落超时，模拟所属执行仍只读得到交给 transport 的状态。
					now = Date.parse((await readInjection()).terminal_delivery_status_updated_at);
					await mutateTaskCommandExecutions("workspace-1", (records) => ({
						records: records.map((record) => ({
							...record,
							resultDelivery: record.resultDelivery && {
								...record.resultDelivery,
								state: "known_not_submitted" as const,
								awaitingTransportReceipt: true,
								nativeReceipt: { status: "accepted_pending_submit_confirmation", reason: null },
								lastPreflightFailureEvidenceSha256: null,
								retryPreflightNotBeforeEpochMs: null,
							},
						})),
						result: undefined,
					}));
				}
				service.stop();
				runtimeInstance.mockReturnValue("runtime-after-restart");
				service = createService();
				nativeReady = true;
				await service.sweepExecution("workspace-1", execution.executionId);
				expect(native).toHaveBeenCalledTimes(1);
				now += 30_001;
				const lostQueueWrite =
					scenario === "timeout_then_transport_receipt_readback" ||
					scenario === "timeout_then_withdrawal_receipt_readback"
						? vi
								.spyOn(managedTaskPromptDelivery, "settleManagedTaskPromptDelivery")
								.mockResolvedValueOnce(undefined)
						: null;
				await service.sweepExecution("workspace-1", execution.executionId);
				if (scenario === "timeout_then_withdrawal_receipt_readback")
					await writeFile(resultFile, JSON.stringify({ disposition: "machine_evidence_pending" }));
				if (lostQueueWrite) {
					try {
						await vi.waitFor(() => expect(lostQueueWrite).toHaveBeenCalledOnce(), { timeout: 8_000 });
						expect((await readQueueEntry())?.deliveryState).toBe("settled_failed");
						await managedTaskPromptDelivery.reconcileManagedTaskPromptDeliveryReceipts(
							"workspace-1",
							await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace-1"),
						);
					} finally {
						lostQueueWrite.mockRestore();
					}
				}
				if (
					scenario === "timeout_then_withdrawal_receipt_readback" ||
					scenario === "timeout_then_withdrawal_after_intent"
				) {
					await vi.waitFor(async () => expect((await readQueueEntry())?.deliveryState).toBe("cancelled"), {
						timeout: 8_000,
					});
					expect(await readQueueEntry()).toMatchObject({
						deliveryState: "cancelled",
						lastDeliveryFailureNote: expect.stringContaining("原后台通知已从当前可投递清单撤下"),
						managedDelivery: {
							previousUnconfirmedTerminalDeliveryReceipt: { reason: "terminal_prompt_readiness_timeout" },
						},
					});
					expect(nativeSendInvocations).not.toHaveBeenCalled();
					expect(write).not.toHaveBeenCalled();
					expect((await readInjection())?.codex_native_prompt_delivery_operation).toMatchObject({
						sendPhase: "registered",
						actualSendAttemptCount: 0,
					});
					return;
				}
				await vi.waitFor(
					async () =>
						expect(await readQueueEntry()).toMatchObject({
							deliveryState: "settled_delivered",
							managedDelivery: {
								previousUnconfirmedTerminalDeliveryReceipt: { reason: "terminal_prompt_readiness_timeout" },
							},
						}),
					{ timeout: 8_000 },
				);
				await service.sweepExecution("workspace-1", execution.executionId);
				expect(nativeSendInvocations).toHaveBeenCalledExactlyOnceWith(originalClientUserMessageId);
				expect((await service.inspect("workspace-1", execution)).resultDelivery).toMatchObject({
					resultId: delivery.resultId,
					state: "native_accepted",
					readinessTimeoutRecoveryAttemptedEvidenceSha256s: [expect.any(String)],
				});
				expect((await readInjection())?.terminal_delivery_failure_reason).toBe("terminal_prompt_readiness_timeout");
				expect(manager.getSummary("conversation-1")?.awaitingDispatchedBackgroundWork).toBeNull();
				expect(write).not.toHaveBeenCalled();
				expect(warnings).not.toHaveBeenCalled();
				return;
			}
			const first = await start("first-result");
			const second = await start("second-result");
			for (const record of [first, second])
				await writeFile(record.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
			await service.sweepExecution("workspace-1", first.executionId);
			await service.sweepExecution("workspace-1", second.executionId);
			await vi.waitFor(
				async () =>
					expect((await service.inspect("workspace-1", first)).resultDelivery?.state).toBe("native_accepted"),
				{ timeout: 8_000 },
			);
			expect(
				manager.getSummary("conversation-1")?.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds,
			).toEqual([second.executionId]);
			expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(false);
			expect(native).toHaveBeenCalledTimes(1);
			await service.sweepExecution("workspace-1", second.executionId);
			await vi.waitFor(
				async () =>
					expect((await service.inspect("workspace-1", second)).resultDelivery?.state).toBe("native_accepted"),
				{ timeout: 8_000 },
			);
			expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(true);
			expect(manager.transitionToReview("conversation-1", "hook")).toMatchObject({
				turnOwner: "user",
				userTurnKind: "review",
				awaitingDispatchedBackgroundWork: null,
			});
			await service.sweepExecution("workspace-1", first.executionId);
			await service.sweepExecution("workspace-1", second.executionId);
			expect(native).toHaveBeenCalledTimes(2);
			expect(launch).toHaveBeenCalledTimes(2);
			expect(write).not.toHaveBeenCalled();
		} finally {
			service.stop();
			const pendingDeliveryId = active.programmaticDeliveryReceipt?.idempotencyKey;
			if (pendingDeliveryId) manager.cancelTaskChatInputDelivery("conversation-1", pendingDeliveryId);
			acp.disposeAllTaskSessions();
			workspaceDirectory.mockRestore();
			workspacesRoot.mockRestore();
			runtimeHome.mockRestore();
			runtimeInstance.mockRestore();
			runtimeLiveness.mockRestore();
			clock.mockRestore();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("原生投递准备期间开始暂存时先暂停，暂存结束后沿用原消息继续提交", async () => {
		let enterNativeSubmit!: () => void;
		const nativePreparation = new Promise<void>((resolve) => {
			enterNativeSubmit = resolve;
		});
		let finishStash!: () => void;
		const stashCompletion = new Promise<void>((resolve) => {
			finishStash = resolve;
		});
		const nativeWrite = vi.fn();
		const manager = new TerminalSessionManager({
			deliverCodexNativePromptWithoutChangingComposer: async (input) => {
				await nativePreparation;
				if (!(await input.beforeSubmit())) return { status: "cancelled" };
				nativeWrite();
				return {
					status: "confirmed",
					evidence: {
						clientUserMessageId: input.clientUserMessageId,
						nativeSessionId: "thread-1",
						nativeTurnId: "turn-1",
						nativeUserMessageId: "message-1",
					},
				};
			},
		});
		const { write } = installSession(manager, "");
		const outcome = vi.fn();
		manager.submitTaskChatInputWhenReady("conversation-1", "原消息", { onDeliveryOutcome: outcome });
		await vi.advanceTimersByTimeAsync(1_100);
		const stash = manager.runTaskTerminalInputBoxStashAttemptExclusivelyPerTask(
			"conversation-1",
			() => stashCompletion,
			() => undefined,
		);
		enterNativeSubmit();
		await vi.advanceTimersByTimeAsync(200);
		expect(nativeWrite).not.toHaveBeenCalled();
		expect(outcome).not.toHaveBeenCalled();
		finishStash();
		await stash;
		await vi.advanceTimersByTimeAsync(100);
		expect(nativeWrite).toHaveBeenCalledTimes(1);
		expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered_and_submit_confirmed" }));
		expect(write).not.toHaveBeenCalled();
		manager.dispose();
	});
	it("hard stop 在冻结 host 或进入 detach 前就封住原生投递和新投递", async () => {
		let captured: CodexNativePromptDeliveryInput | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const nativeWrite = vi.fn();
		const manager = new TerminalSessionManager({
			deliverCodexNativePromptWithoutChangingComposer: async (input) => {
				captured = input;
				await gate;
				if (await input.beforeSubmit()) nativeWrite();
				return { status: "cancelled" };
			},
		});
		installSession(manager, "");
		const outcome = vi.fn();
		manager.submitTaskChatInputWhenReady("conversation-1", "旧消息", { onDeliveryOutcome: outcome });
		await vi.advanceTimersByTimeAsync(1100);
		manager.revokeProgrammaticInputDeliveryEligibilityForRuntimeHandover();
		expect(captured?.isCurrent()).toBe(false);
		expect(manager.submitTaskChatInputWhenReady("conversation-1", "迟到的新消息")).toBeNull();
		release();
		await vi.advanceTimersByTimeAsync(1);
		expect(nativeWrite).not.toHaveBeenCalled();
		expect(outcome).not.toHaveBeenCalled();
	});
	it.each(["beforeSubmit之前", "beforeSubmit之后", "响应返回之前"] as const)(
		"handover 在 %s 暂停时撤销写入资格且不结算迟到回执",
		async (pausePhase) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const nativeWrite = vi.fn();
			let nativeInput: CodexNativePromptDeliveryInput | undefined;
			const native = vi.fn(
				async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
					nativeInput = input;
					if (pausePhase === "beforeSubmit之前") await gate;
					if (!(await input.beforeSubmit())) return { status: "cancelled" };
					if (pausePhase === "beforeSubmit之后") await gate;
					await input.onRequestAttempted();
					if (!input.isCurrent()) return { status: "unconfirmed" };
					nativeWrite();
					if (pausePhase === "响应返回之前") await gate;
					return {
						status: "confirmed",
						evidence: {
							clientUserMessageId: input.clientUserMessageId,
							nativeSessionId: "thread-1",
							nativeTurnId: "turn-2",
							nativeUserMessageId: "user-2",
						},
					};
				},
			);
			const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
			const { active, entry } = installSession(manager, "");
			Object.assign(active, {
				session: { ...active.session, detachFromRuntimeForHandoverRestartWithoutSignallingProcess: vi.fn() },
				terminalProtocolFilter: { pendingChunk: null },
				outputReactionEngine: null,
			});
			const outcome = vi.fn();
			manager.submitTaskChatInputWhenReady("conversation-1", "正文", { onDeliveryOutcome: outcome });
			await vi.advanceTimersByTimeAsync(1100);
			expect(nativeInput).toBeDefined();
			const receiptPhase = active.programmaticDeliveryReceipt?.phase;
			const generationBeforeDetach = active.submitConfirmGeneration;
			await manager.detachHostedPtySessionsForRuntimeHandover({
				readHostedSessionOrphanReclamationEligibleAtEpochMs: () => null,
			});
			expect(nativeInput?.isCurrent()).toBe(false);
			expect(active.submitConfirmGeneration).toBeGreaterThan(generationBeforeDetach);
			release();
			await vi.advanceTimersByTimeAsync(1);
			expect(nativeWrite).toHaveBeenCalledTimes(pausePhase === "响应返回之前" ? 1 : 0);
			expect(outcome).not.toHaveBeenCalled();
			expect(active.programmaticDeliveryReceipt?.phase).toBe(receiptPhase);
			expect(entry.active).toBe(active);
		},
	);
	it("所属结果让位于在途 PTY 回执，自己的写前核验可以排除自己的回执", () => {
		const manager = new TerminalSessionManager();
		const { active } = installSession(manager, "");
		const firstOutcome = vi.fn();
		manager.submitTaskChatInputWhenReady("conversation-1", "FIRST", {
			idempotencyKey: "first-result",
			owningCommandExecutionId: "first-execution",
			onDeliveryOutcome: firstOutcome,
		});
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(true);
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1", "first-result")).toBe(false);
		expect(
			manager.submitTaskChatInputWhenReady("conversation-1", "SECOND", {
				idempotencyKey: "second-result",
				owningCommandExecutionId: "second-execution",
				onDeliveryOutcome: vi.fn(),
			}),
		).toBeNull();
		expect(firstOutcome).not.toHaveBeenCalled();
		expect(active.programmaticDeliveryReceipt?.idempotencyKey).toBe("first-result");
	});
	it("所属结果排队后仍挡住 Review，尚未提交时同文接受不解除等待", () => {
		const manager = new TerminalSessionManager();
		const { entry } = installSession(manager, "");
		Object.assign(entry.summary, {
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			reviewReason: null,
		});
		entry.summary.awaitingDispatchedBackgroundWork = {
			sinceMs: 1,
			owningCommandExecutionIds: ["execution", "other-execution"],
		};
		manager.submitTaskChatInputWhenReady("conversation-1", "RESULT", {
			owningCommandExecutionId: "execution",
			onDeliveryOutcome: vi.fn(),
		});
		expect(entry.summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toEqual([
			"execution",
			"other-execution",
		]);
		expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(false);
		manager.confirmAcceptedAgentConversationInput("conversation-1", {
			observedAtMs: Date.now(),
			eventId: "not-this-delivery",
			nativeSessionId: "thread-1",
			runtimeSessionIncarnationId: INCARNATION,
			submittedPromptText: "RESULT",
			acceptedNativeAgentTurnIsInProgress: true,
		});
		expect(entry.summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toEqual([
			"execution",
			"other-execution",
		]);
		expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(false);
	});
	it("没有执行身份的程序化输入在排队和接受后均保留其他所属等待", () => {
		const manager = new TerminalSessionManager();
		const { entry } = installSession(manager, "");
		Object.assign(entry.summary, {
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			reviewReason: null,
		});
		entry.summary.awaitingDispatchedBackgroundWork = {
			sinceMs: 1,
			owningCommandExecutionIds: ["other-execution"],
		};
		manager.submitTaskChatInputWhenReady("conversation-1", "普通提示", { onDeliveryOutcome: vi.fn() });
		expect(entry.summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toEqual(["other-execution"]);
		manager.confirmAcceptedAgentConversationInput("conversation-1", {
			observedAtMs: Date.now(),
			eventId: "ordinary-prompt-accepted",
			nativeSessionId: "thread-1",
			runtimeSessionIncarnationId: INCARNATION,
			submittedPromptText: "普通提示",
			acceptedNativeAgentTurnIsInProgress: true,
		});
		expect(entry.summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toEqual(["other-execution"]);
		expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(false);
	});
	it("只剩无归属等待时，没有执行身份的程序化输入仍清除空 owner", () => {
		const manager = new TerminalSessionManager();
		const { entry } = installSession(manager, "");
		Object.assign(entry.summary, {
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			reviewReason: null,
		});
		entry.summary.awaitingDispatchedBackgroundWork = {
			sinceMs: 1,
			label: "其他后台等待",
			hasUnownedBackgroundWorkWait: true,
			owningCommandExecutionIds: [],
		};
		manager.submitTaskChatInputWhenReady("conversation-1", "普通提示", { onDeliveryOutcome: vi.fn() });
		expect(entry.summary.awaitingDispatchedBackgroundWork ?? null).toBeNull();
	});
	it("所属等待抽干后的空数组不再挡住新输入清除无归属等待", () => {
		const manager = new TerminalSessionManager();
		const { entry } = installSession(manager, "");
		Object.assign(entry.summary, {
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			reviewReason: null,
		});
		entry.summary.awaitingDispatchedBackgroundWork = {
			sinceMs: 1,
			label: "其他后台等待",
			hasUnownedBackgroundWorkWait: true,
			owningCommandExecutionIds: [],
		};
		expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(false);
		manager.confirmAcceptedAgentConversationInput("conversation-1", {
			observedAtMs: Date.now(),
			eventId: "new-user-input",
			nativeSessionId: "thread-1",
			runtimeSessionIncarnationId: INCARNATION,
			submittedPromptText: "继续",
			acceptedNativeAgentTurnIsInProgress: true,
		});
		expect(entry.summary.awaitingDispatchedBackgroundWork ?? null).toBeNull();
		expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(true);
	});
	it.each([true, false])("其他后台等待保留时，当前结果仍可原生接续：自身等待存在=%s", async (stillOwnsWait) => {
		const native = vi.fn(async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
			if (!(await input.beforeSubmit())) return { status: "cancelled" };
			await input.onRequestAttempted();
			return {
				status: "confirmed",
				evidence: {
					clientUserMessageId: input.clientUserMessageId,
					nativeSessionId: "thread-1",
					nativeTurnId: "continued-turn",
					nativeUserMessageId: "continued-result",
				},
			};
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { entry, write } = installSession(manager);
		entry.summary.awaitingDispatchedBackgroundWork = {
			sinceMs: 1,
			owningCommandExecutionIds: stillOwnsWait ? ["execution", "other-execution"] : ["other-execution"],
		};
		const outcome = vi.fn();
		expect(
			manager.submitTaskChatInputWhenReady("conversation-1", "RESULT", {
				owningCommandExecutionId: "execution",
				idempotencyKey: "result",
				onDeliveryOutcome: outcome,
			}),
		).not.toBeNull();
		expect(entry.summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toEqual(
			stillOwnsWait ? ["execution", "other-execution"] : ["other-execution"],
		);
		expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(false);
		await vi.advanceTimersByTimeAsync(1500);
		expect(native).toHaveBeenCalledTimes(1);
		expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered_and_submit_confirmed" }));
		expect(entry.summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toEqual(["other-execution"]);
		manager.confirmAcceptedAgentConversationInput("conversation-1", {
			observedAtMs: Date.now(),
			eventId: "accepted-owned-result",
			nativeSessionId: "thread-1",
			runtimeSessionIncarnationId: INCARNATION,
			submittedPromptText: "RESULT",
			acceptedNativeAgentTurnIsInProgress: true,
		});
		expect(entry.summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toEqual(["other-execution"]);
		expect(canTransitionTaskForHookEvent(entry.summary, "to_review")).toBe(false);
		expect(write).not.toHaveBeenCalled();
	});
	it.each(["human_input", "persistent_revocation"] as const)(
		"持久化 PTY 意图期间 %s 不会被备用投递覆盖",
		async (interruption) => {
			let markEntered!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				markEntered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const createOriginal = nativeDeliveryJournal.createCodexNativePromptDeliveryJournal;
			const journal = vi
				.spyOn(nativeDeliveryJournal, "createCodexNativePromptDeliveryJournal")
				.mockImplementation((binding) => ({
					...createOriginal(binding),
					recordTerminalPtyWriteIntent: async () => {
						markEntered();
						await gate;
					},
				}));
			try {
				const native = vi.fn(async (): Promise<CodexNativePromptDeliveryResult> => ({ status: "unavailable" }));
				const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
				const { write } = installSession(manager, "");
				let revoked = false;
				manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
					idempotencyKey: "owned-result",
					validateBeforeTerminalWrite: async () => {
						if (revoked) throw new Error("所属执行已有持久撤销意图");
					},
					codexNativeDeliveryLedgerBinding: {
						ledgerPath: "/isolated-unused-ledger",
						ledgerTaskId: "card",
						idempotencyKey: "owned-result",
					},
					onDeliveryOutcome: vi.fn(),
				});
				await vi.advanceTimersByTimeAsync(1100);
				await entered;
				if (interruption === "human_input") manager.writeInput("conversation-1", Buffer.from("人工草稿"));
				else revoked = true;
				release();
				await vi.advanceTimersByTimeAsync(1);
				expect(write.mock.calls.some(([text]) => String(text).includes("INJECTION"))).toBe(false);
			} finally {
				release();
				journal.mockRestore();
			}
		},
	);
	it("Stop 持久撤销等待期间，后续人工输入保持字节顺序", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const manager = new TerminalSessionManager({ beforeUserTerminalInterrupt: async () => gate });
		const { write } = installSession(manager, "");
		manager.writeInput("conversation-1", Buffer.from([0x03]));
		manager.writeInput("conversation-1", Buffer.from("后续输入\r"));
		expect(write).not.toHaveBeenCalled();
		release();
		await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
		expect(write.mock.calls.map(([bytes]) => bytes.toString("hex"))).toEqual([
			"03",
			Buffer.from("后续输入\r").toString("hex"),
		]);
	});
	it.each(["claude", "codex"] as const)("%s 的原始按键不充当空侧会话的用户消息接受证据", (agentId) => {
		for (const role of ["by_the_way", "task_collaborator"] as const) {
			for (const rawInput of ["y\r", "1\r", "\r", "\n", "尚未被接受的真实正文\r"]) {
				const manager = new TerminalSessionManager();
				const { entry, write } = installSession(manager, "");
				entry.summary.agentId = agentId;
				entry.summary.agentNativeConversationSessionIdentity = null;
				entry.summary.taskConversationSessionMetadata = {
					workspaceTaskId: "host-task",
					taskConversationSessionRole: role,
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: 1,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
				};
				entry.summary.taskConversationSessionNativeIdentityRecovery = {
					runtimeSessionIncarnationId: INCARNATION,
					forkSourceNativeSessionId: null,
					resumeRequestedAtMs: Date.now(),
					consecutiveUnchangedProbeCount: 0,
					lastEvidenceFingerprint: null,
					nextProbeAtMs: 0,
				};
				manager.writeInput("conversation-1", Buffer.from(rawInput));
				const summary = manager.getSummary("conversation-1");
				expect(summary?.taskConversationSessionMetadata?.latestUserMessagePreview).toBeNull();
				expect(summary?.agentConversationPromptSubmissionAcceptance ?? null).toBeNull();
				expect(summary?.taskConversationSessionNativeIdentityRecovery).toMatchObject({
					runtimeSessionIncarnationId: INCARNATION,
					resumeRequestedAtMs: null,
				});
				expect(write).toHaveBeenCalledExactlyOnceWith(Buffer.from(rawInput));
			}
		}
	});

	it.each(["claude", "codex"] as const)("%s 的空侧会话在首次真实接受后显示用户原文预览", (agentId) => {
		for (const role of ["by_the_way", "task_collaborator"] as const) {
			const manager = new TerminalSessionManager();
			const { entry } = installSession(manager, "");
			entry.summary.agentId = agentId;
			if (entry.summary.agentNativeConversationSessionIdentity)
				entry.summary.agentNativeConversationSessionIdentity.sourceAgentId = agentId;
			entry.summary.taskConversationSessionMetadata = {
				workspaceTaskId: "host-task",
				taskConversationSessionRole: role,
				taskConversationSessionContextSource: "started_from_scratch",
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: null,
			};
			const acceptedInput = {
				observedAtMs: Date.now(),
				eventId: "first-real-user-input",
				nativeSessionId: "thread-1",
				runtimeSessionIncarnationId: INCARNATION,
				submittedPromptText: "  首次真实消息  ",
			};
			manager.confirmAcceptedAgentConversationInput("conversation-1", {
				...acceptedInput,
				runtimeSessionIncarnationId: "stale-incarnation",
			});
			expect(
				manager.getSummary("conversation-1")?.taskConversationSessionMetadata?.latestUserMessagePreview,
			).toBeNull();
			manager.confirmAcceptedAgentConversationInput("conversation-1", acceptedInput);
			expect(manager.getSummary("conversation-1")?.taskConversationSessionMetadata?.latestUserMessagePreview).toBe(
				"首次真实消息",
			);
		}
	});

	it("纯 /plan 只初始化模式，不登记投递、不记接受、不增加回合", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { active, write } = installSession(manager, "");
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "/plan" });
		const summaryBefore = manager.getSummary("conversation-1");
		expect(
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1"),
		).toBe(true);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(write.mock.calls).toEqual([["\x1b[200~/plan\x1b[201~"], ["\r"]]);
		expect(managedRecording.begin).not.toHaveBeenCalled();
		expect(readNativeActivity).not.toHaveBeenCalled();
		expect(manager.getSummary("conversation-1")).toEqual(summaryBefore);
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
	});

	it("已受理但尚未写入的首条消息等待 Plan 初始化，不形成互相等待", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { active, write } = installSession(manager, "");
		const observer = vi.fn();
		const queuedFirstPrompt: PendingProgrammaticDeliveryReceipt = {
			idempotencyKey: "first-input",
			phase: "awaiting_readiness",
			promptText: "首条真实消息",
			outputChunkArrivalSequenceNumberAtSubmitCarriageReturn: null,
			queuedBehindActiveAgentTurn: false,
			settled: false,
			observer,
		};
		Object.assign(active, {
			workspaceTrustBuffer: null,
			deferredStartupPromptText: "/plan",
			programmaticDeliveryReceipt: queuedFirstPrompt,
		});
		expect(
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1"),
		).toBe(true);
		expect(active.deferredStartupPromptText).toBe("/plan");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(active.deferredStartupPromptText).toBeNull();
		expect(active.programmaticDeliveryReceipt).toBe(queuedFirstPrompt);
		expect(write.mock.calls).toEqual([["\x1b[200~/plan\x1b[201~"], ["\r"]]);
		expect(observer).not.toHaveBeenCalled();
		expect(managedRecording.begin).not.toHaveBeenCalled();
	});

	it("输入框有草稿时纯 /plan 等待，随后只初始化一次", async () => {
		const manager = new TerminalSessionManager();
		const { active, write, tracker, setDraft } = installSession(manager, "草稿");
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "/plan" });
		const tryInitialize = () =>
			(
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1");
		expect(await tryInitialize()).toBe(false);
		expect(write).not.toHaveBeenCalled();
		Object.assign(tracker, createTerminalInputBoxOccupancyTrackerState());
		setDraft("");
		expect(await tryInitialize()).toBe(true);
		expect(await tryInitialize()).toBe(false);
	});
	beforeEach(() => {
		managedRecording.begin.mockReset();
		managedRecording.settle.mockReset();
		readNativeActivity.mockReset();
		readNativeActivity.mockResolvedValue({
			events: [],
			cursor: { transport: "codex_control", predecessorTurnId: "prior-turn", seenEventIds: ["prior-input"] },
		});
		vi.useFakeTimers();
		vi.setSystemTime(600_000);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it.each([true, false])("自动 PTY 投递 startup=%s：原生接受才释放确认回执", async (startup) => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		const handle = { deliveryId: "automatic-delivery", settle: vi.fn() };
		managedRecording.begin.mockResolvedValue({ handle });
		const promptText = startup ? "初始提示正文" : "连接恢复正文";
		if (startup) {
			Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: promptText });
			expect(
				await (
					manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
				).trySubmitDeferredStartupPrompt("conversation-1"),
			).toBe(true);
		} else {
			expect(
				await (
					manager as unknown as {
						writePasteSubmissionWithConfirm(taskId: string, target: unknown, text: string): Promise<boolean>;
					}
				).writePasteSubmissionWithConfirm("conversation-1", active, promptText),
			).toBe(true);
		}
		expect(write).toHaveBeenCalledOnce();
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(true);
		await vi.advanceTimersByTimeAsync(1600);
		expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(readNativeActivity).toHaveBeenCalledOnce();
		expect(managedRecording.settle).not.toHaveBeenCalled();
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(true);
		manager.confirmAcceptedAgentConversationInput("conversation-1", {
			observedAtMs: Date.now(),
			eventId: "new-automatic-input",
			nativeSessionId: "thread-1",
			runtimeSessionIncarnationId: INCARNATION,
			submittedPromptText: promptText,
		});
		expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
			status: "delivered_and_submit_confirmed",
			reason: null,
		});
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
		await vi.advanceTimersByTimeAsync(70_000);
		expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(managedRecording.settle).toHaveBeenCalledOnce();
	});

	it.each([true, false])("自动 PTY 投递 startup=%s：确认预算耗尽后诚实失败", async (startup) => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		const handle = { deliveryId: "unconfirmed-automatic-delivery", settle: vi.fn() };
		managedRecording.begin.mockResolvedValue({ handle });
		await (
			manager as unknown as {
				writePasteSubmissionWithConfirm(
					taskId: string,
					target: unknown,
					text: string,
					options: { waitsForStartupCompletion: boolean },
				): Promise<boolean>;
			}
		).writePasteSubmissionWithConfirm("conversation-1", active, "无法确认的正文", {
			waitsForStartupCompletion: startup,
		});
		await vi.advanceTimersByTimeAsync(70_000);
		expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
			status: "delivery_failed",
			reason: "submit_confirmation_budget_exhausted",
		});
		expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
	});

	it.each([
		{ startup: true, confirmsAutomaticInput: true },
		{ startup: false, confirmsAutomaticInput: true },
		{ startup: true, confirmsAutomaticInput: false },
		{ startup: false, confirmsAutomaticInput: false },
	])(
		"自动 writer startup=$startup、确认=$confirmsAutomaticInput：旧 intent 在自动投递落定后继续",
		async ({ startup, confirmsAutomaticInput }) => {
			const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
			const { entry, active, write } = installSession(manager, "");
			entry.summary.agentId = "claude";
			entry.terminalStateMirror.getViewportSnapshot = async () => ({
				snapshot: "╭──────────────────────╮\n│ > │\n╰──────────────────────╯",
				cols: 80,
				rows: 24,
			});
			Object.assign(active, {
				workspaceTrustBuffer: null,
				deferredStartupPromptText: startup ? "必须先发送的首发" : null,
			});
			const handle = { deliveryId: "startup-before-pending-message", settle: vi.fn() };
			managedRecording.begin.mockResolvedValue({ handle });
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("conversation-1", "原来尚未写出的消息", {
				idempotencyKey: "original-pending-message",
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			});
			const originalReceipt = active.programmaticDeliveryReceipt;
			const originalDeliveryGeneration = active.taskChatInputDeliveryGeneration;
			if (startup)
				await (
					manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
				).trySubmitDeferredStartupPrompt("conversation-1");
			else
				await (
					manager as unknown as {
						writePasteSubmissionWithConfirm(taskId: string, target: unknown, text: string): Promise<boolean>;
					}
				).writePasteSubmissionWithConfirm("conversation-1", active, "必须先发送的首发");
			expect(outcomes).toEqual([]);
			expect(active.programmaticDeliveryReceipt).toBe(originalReceipt);
			expect(active.taskChatInputDeliveryGeneration).toBe(originalDeliveryGeneration);
			await vi.advanceTimersByTimeAsync(1600);
			expect(write.mock.calls.filter(([text]) => String(text).includes("原来尚未写出的消息"))).toHaveLength(0);
			if (confirmsAutomaticInput)
				manager.confirmAcceptedAgentConversationInput("conversation-1", {
					observedAtMs: Date.now(),
					eventId: "accepted-startup-input",
					nativeSessionId: "thread-1",
					runtimeSessionIncarnationId: INCARNATION,
					submittedPromptText: "必须先发送的首发",
				});
			else {
				for (
					let confirmationTick = 0;
					confirmationTick < 30 && !managedRecording.settle.mock.calls.length;
					confirmationTick++
				)
					await vi.advanceTimersByTimeAsync(2500);
			}
			expect(outcomes).toEqual([]);
			expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
				status: confirmsAutomaticInput ? "delivered_and_submit_confirmed" : "delivery_failed",
				reason: confirmsAutomaticInput ? null : "submit_confirmation_budget_exhausted",
			});
			await vi.advanceTimersByTimeAsync(2500);
			expect(write.mock.calls.filter(([text]) => String(text).includes("原来尚未写出的消息"))).toHaveLength(1);
			manager.confirmAcceptedAgentConversationInput("conversation-1", {
				observedAtMs: Date.now(),
				eventId: "accepted-original-pending-input",
				nativeSessionId: "thread-1",
				runtimeSessionIncarnationId: INCARNATION,
				submittedPromptText: "原来尚未写出的消息",
			});
			expect(outcomes).toEqual([
				{
					status: confirmsAutomaticInput
						? "delivered_queued_behind_active_agent_turn"
						: "delivered_and_submit_confirmed",
					reason: null,
				},
			]);
			expect(manager.hasPendingProgrammaticTaskChatInputDelivery("conversation-1")).toBe(false);
		},
	);

	it.each(["human_input", "native_identity", "submit_generation"] as const)(
		"自动 writer 读取原生基线期间 %s 改变，不再写 CR 或结算尚未写出的消息",
		async (change) => {
			const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
			const { entry, active, write } = installSession(manager, "");
			entry.summary.agentId = "claude";
			Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "必须先发送的首发" });
			const handle = { deliveryId: "automatic-read-in-flight", settle: vi.fn() };
			managedRecording.begin.mockResolvedValue({ handle });
			const outcomes: TaskChatInputDeliveryOutcome[] = [];
			manager.submitTaskChatInputWhenReady("conversation-1", "仍待发送的消息", {
				idempotencyKey: "preserved-pending-message",
				onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			});
			let releaseNativeBaseline: (value: unknown) => void = () => {};
			readNativeActivity.mockReturnValueOnce(
				new Promise((resolveBaseline) => {
					releaseNativeBaseline = resolveBaseline;
				}),
			);
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt(taskId: string): Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1");
			await vi.advanceTimersByTimeAsync(1600);
			expect(readNativeActivity).toHaveBeenCalledOnce();
			if (change === "human_input") manager.writeInput("conversation-1", Buffer.from("人工草稿"));
			else if (change === "native_identity")
				Object.assign(entry.summary.agentNativeConversationSessionIdentity ?? {}, { nativeSessionId: "changed" });
			else active.submitConfirmGeneration += 1;
			releaseNativeBaseline({
				events: [],
				cursor: { transport: "codex_control", predecessorTurnId: "prior-turn", seenEventIds: [] },
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(0);
			expect(outcomes).toEqual([]);
			expect(managedRecording.settle).toHaveBeenCalledExactlyOnceWith(handle, {
				status: "delivery_failed",
				reason: change === "human_input" ? "submit_confirmation_budget_exhausted" : "session_ended_before_delivery",
			});
		},
	);

	it("deferred 启动提示在首字节写出前登记，粘贴本身不冒充确认", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "初始提示正文" });
		let releaseRegistration: (value: unknown) => void = () => {};
		managedRecording.begin.mockReturnValueOnce(
			new Promise((resolveRegistration) => {
				releaseRegistration = resolveRegistration;
			}),
		);
		const submitting = (
			manager as unknown as { trySubmitDeferredStartupPrompt: (taskId: string) => Promise<boolean> }
		).trySubmitDeferredStartupPrompt("conversation-1");
		expect(write).not.toHaveBeenCalled();
		expect(managedRecording.begin).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "初始提示正文",
				deliveryStrategy: "session_startup",
				origin: expect.objectContaining({ messageType: "session_startup" }),
			}),
		);
		const handle = { deliveryId: "startup-record", settle: vi.fn() };
		releaseRegistration({ handle });
		expect(await submitting).toBe(true);
		expect(write).toHaveBeenCalledOnce();
		expect(handle.settle).not.toHaveBeenCalled();
	});

	it("首发登记期间人开始输入则取消，不覆盖人工草稿", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "初始提示正文" });
		const handle = { deliveryId: "cancelled-startup", settle: vi.fn(async () => {}) };
		managedRecording.begin.mockImplementationOnce(async () => {
			active.lastUserInputAt = 600_001;
			return { handle };
		});
		expect(
			await (
				manager as unknown as { trySubmitDeferredStartupPrompt: (taskId: string) => Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1"),
		).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(handle.settle).toHaveBeenCalledWith({ status: "delivery_failed", reason: "cancelled_before_delivery" });
	});

	it("首发登记失败保留正文并有界重试，三次后不随屏幕重绘无限重试", async () => {
		const manager = new TerminalSessionManager({ enableManagedTaskPromptDeliveryRecording: true });
		const { entry, active, write } = installSession(manager, "");
		entry.summary.agentId = "claude";
		Object.assign(active, { workspaceTrustBuffer: null, deferredStartupPromptText: "仍需提交的初始正文" });
		managedRecording.begin.mockRejectedValue(new Error("登记文件暂不可写"));
		const submit = () =>
			(
				manager as unknown as { trySubmitDeferredStartupPrompt: (taskId: string) => Promise<boolean> }
			).trySubmitDeferredStartupPrompt("conversation-1");
		await expect(submit()).rejects.toThrow("登记文件暂不可写");
		await vi.advanceTimersByTimeAsync(3001);
		expect(managedRecording.begin).toHaveBeenCalledTimes(3);
		expect(await submit()).toBe(false);
		expect(active.deferredStartupPromptText).toBe("仍需提交的初始正文");
		expect(write).not.toHaveBeenCalled();
	});

	it("草稿存在仍走原生通道，不写 PTY、不调用暂存，并保留输入账本", async () => {
		const native = vi.fn(async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
			expect(await input.beforeSubmit()).toBe(true);
			input.onRequestAttempted();
			return {
				status: "confirmed",
				evidence: {
					clientUserMessageId: input.clientUserMessageId,
					nativeSessionId: "thread-1",
					nativeTurnId: "turn-2",
					nativeUserMessageId: "user-2",
				},
			};
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { tracker, write } = installSession(manager);
		const stash = vi.fn();
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			preemptivelyStashHumanInputBox: stash,
			mayAutoStashAbsentHumanInputBox: true,
		});
		await vi.advanceTimersByTimeAsync(1100);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(stash).not.toHaveBeenCalled();
		expect(tracker.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		expect(outcomes[0]).toMatchObject({
			status: "delivered_and_submit_confirmed",
			reason: null,
			codexNativePromptDeliveryEvidence: { nativeTurnId: "turn-2", nativeUserMessageId: "user-2" },
		});
	});

	it("原生写出后确认失败时不切回 PTY，也不重发", async () => {
		const native = vi.fn(async (input: CodexNativePromptDeliveryInput): Promise<CodexNativePromptDeliveryResult> => {
			input.onRequestAttempted();
			return { status: "unconfirmed" };
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager, "");
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(20_000);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "codex_native_prompt_delivery_unconfirmed" }]);
	});

	it("人在当前终端打字时仍然让路", async () => {
		const native = vi.fn();
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { active, write } = installSession(manager);
		active.lastUserInputAt = Date.now();
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION");
		await vi.advanceTimersByTimeAsync(3000);
		expect(native).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("模态待答时不发起原生投递", async () => {
		const native = vi.fn();
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { entry, write } = installSession(manager);
		Object.assign(entry.summary, { turnOwner: "user", liveness: "live", userTurnKind: "question" });
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", { deferWhileUserTurn: true });
		await vi.advanceTimersByTimeAsync(3000);
		expect(native).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("原生能力不可用且框非空时，不抢占草稿或盲写 PTY", async () => {
		const native = vi.fn(async (): Promise<CodexNativePromptDeliveryResult> => ({ status: "unavailable" }));
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const stash = vi.fn();
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			preemptivelyStashHumanInputBox: stash,
			mayAutoStashAbsentHumanInputBox: true,
		});
		await vi.advanceTimersByTimeAsync(3000);
		expect(write).not.toHaveBeenCalled();
		expect(stash).not.toHaveBeenCalled();
	});

	it("原生不可用但当前屏幕确证为空时，仍可使用既有 PTY 后备", async () => {
		const native = vi.fn(async (): Promise<CodexNativePromptDeliveryResult> => ({ status: "unavailable" }));
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager, "");
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION");
		await vi.advanceTimersByTimeAsync(1100);
		expect(write.mock.calls.some(([text]) => String(text).includes("INJECTION"))).toBe(true);
		expect(write.mock.calls.some(([text]) => text === "\u0013")).toBe(false);
	});

	it("删至空框后，连续可信空框读数能解除输入侧的残留争用闩", async () => {
		const manager = new TerminalSessionManager();
		const { tracker } = installSession(manager, "");
		recordTerminalInputBytesIntoOccupancyTracker(tracker, Buffer.from("abc\u007f\u007f\u007f"), 1);
		expect(tracker.hasUncommittedInputFromInputSideByteTracking).toBe(true);
		await manager.resolveTaskTerminalInputBoxOccupancy("conversation-1");
		await manager.resolveTaskTerminalInputBoxOccupancy("conversation-1");
		const occupancy = await manager.resolveTaskTerminalInputBoxOccupancy("conversation-1");
		expect(occupancy?.hasUncommittedInput).toBe(false);
		expect(tracker.hasUncommittedInputFromInputSideByteTracking).toBe(false);
	});

	it("原生预检期间取消后，提交回调不能越过代际检查", async () => {
		let submittedInput: CodexNativePromptDeliveryInput | undefined;
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			submittedInput = input;
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			idempotencyKey: "native-key",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		expect(manager.cancelTaskChatInputDelivery("conversation-1", "native-key")).toBe("cancelled_before_delivery");
		expect(await submittedInput?.beforeSubmit()).toBe(false);
		finishNative({ status: "cancelled" });
		await vi.advanceTimersByTimeAsync(2000);
		expect(write).not.toHaveBeenCalled();
		expect(native).toHaveBeenCalledOnce();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "cancelled_before_delivery" }]);
	});

	it("原生请求已尝试后不能声称取消成功，确认仍只收敛一次", async () => {
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			idempotencyKey: "native-key",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		expect(manager.cancelTaskChatInputDelivery("conversation-1", "native-key")).toBe("already_delivered");
		expect(outcomes).toEqual([]);
		finishNative({ status: "unconfirmed" });
		await vi.advanceTimersByTimeAsync(2000);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "codex_native_prompt_delivery_unconfirmed" }]);
	});

	it("另起 PTY 确认链及其预算终态都不能结算原生回执", async () => {
		let nativeInput!: CodexNativePromptDeliveryInput;
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			nativeInput = input;
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { active } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		// 复现独立连接续跑占用 PTY 确认通道，覆盖其清理旧回执及确认超时两个出口。
		(
			manager as unknown as {
				writePasteSubmissionWithConfirm(taskId: string, target: unknown, text: string): void;
			}
		).writePasteSubmissionWithConfirm("conversation-1", active, "独立 PTY 续跑");
		expect(outcomes).toEqual([]);
		await vi.advanceTimersByTimeAsync(70_000);
		expect(outcomes).toEqual([]);
		const evidence = {
			clientUserMessageId: nativeInput.clientUserMessageId,
			nativeSessionId: "thread-1",
			nativeTurnId: "turn-2",
			nativeUserMessageId: "user-2",
		};
		finishNative({ status: "confirmed", evidence });
		await vi.advanceTimersByTimeAsync(0);
		expect(native).toHaveBeenCalledOnce();
		expect(outcomes).toEqual([
			{ status: "delivered_and_submit_confirmed", reason: null, codexNativePromptDeliveryEvidence: evidence },
		]);
	});

	it("后续投递取代原生请求后，迟到接受不能确认后续回执", async () => {
		let nativeInput!: CodexNativePromptDeliveryInput;
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			nativeInput = input;
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { write } = installSession(manager);
		const originalOutcomes: TaskChatInputDeliveryOutcome[] = [];
		const laterOutcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => originalOutcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		manager.submitTaskChatInputWhenReady("conversation-1", "LATER", {
			idempotencyKey: "later-key",
			onDeliveryOutcome: (outcome) => laterOutcomes.push(outcome),
		});
		expect(nativeInput.isCurrent()).toBe(false);
		finishNative({
			status: "confirmed",
			evidence: {
				clientUserMessageId: nativeInput.clientUserMessageId,
				nativeSessionId: "thread-1",
				nativeTurnId: "turn-2",
				nativeUserMessageId: "user-2",
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(originalOutcomes).toEqual([{ status: "delivery_failed", reason: "superseded_by_later_delivery" }]);
		expect(laterOutcomes).toEqual([]);
		expect(manager.cancelTaskChatInputDelivery("conversation-1", "later-key")).toBe("cancelled_before_delivery");
		expect(laterOutcomes).toEqual([{ status: "delivery_failed", reason: "cancelled_before_delivery" }]);
		expect(native).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
	});

	it.each([
		"native_session",
		"transcript_path",
		"runtime_incarnation",
		"started_at",
		"workspace_path",
		"control_endpoint",
	])("原生查询返回的同时 %s 改变时，不把旧会话的确认记给新绑定", async (change) => {
		let finishNative!: (result: CodexNativePromptDeliveryResult) => void;
		const native = vi.fn((input: CodexNativePromptDeliveryInput) => {
			input.onRequestAttempted();
			return new Promise<CodexNativePromptDeliveryResult>((done) => {
				finishNative = done;
			});
		});
		const manager = new TerminalSessionManager({ deliverCodexNativePromptWithoutChangingComposer: native });
		const { entry, write } = installSession(manager);
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady("conversation-1", "INJECTION", {
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(1100);
		if (change === "native_session")
			Object.assign(entry.summary.agentNativeConversationSessionIdentity ?? {}, {
				nativeSessionId: "another-thread",
			});
		else if (change === "transcript_path")
			Object.assign(entry.summary.agentNativeConversationSessionIdentity ?? {}, {
				transcriptPath: "/another/rollout.jsonl",
			});
		else if (change === "runtime_incarnation") entry.summary.runtimeSessionIncarnationId = "another-incarnation";
		else if (change === "started_at") entry.summary.startedAt = 2;
		else if (change === "workspace_path") entry.summary.workspacePath = "/another/workspace";
		else
			Object.assign(entry.summary.codexNativeSessionControlEndpoint ?? {}, { socketPath: "/another/control.sock" });
		finishNative({
			status: "confirmed",
			evidence: {
				clientUserMessageId: "client-1",
				nativeSessionId: "thread-1",
				nativeTurnId: "turn-2",
				nativeUserMessageId: "user-2",
			},
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "codex_native_prompt_delivery_unconfirmed" }]);
	});
});
