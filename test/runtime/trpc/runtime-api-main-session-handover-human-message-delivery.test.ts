import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../../src/config/user-interface-preferences-shared-across-browser-origins";
import {
	type RuntimeBoardCard,
	type RuntimeBoardData,
	type RuntimeTaskSessionSummary,
	type RuntimeWorkspaceStateResponse,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import { mergeSummaryWithFacets } from "../../../src/core/session-activity";
import { projectTaskConversationSessionsForMainSessionBinding } from "../../../src/core/task-main-conversation-session-binding";
import type { TaskMainSessionHandoverRecord } from "../../../src/core/task-main-session-handover-contract";
import { completeTaskMainSessionHandoverAfterUserMessage } from "../../../src/state/complete-task-main-session-handover-after-user-message";
import type { mutateWorkspaceState, RuntimeWorkspaceAtomicMutationResult } from "../../../src/state/workspace-state";
import { type TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTerminalInputBoxOccupancyTrackerState } from "../../../src/terminal/terminal-input-box-occupancy";
import type { TerminalScreenSnapshot } from "../../../src/terminal/terminal-input-box-reader";
import type { PendingProgrammaticDeliveryReceipt } from "../../../src/terminal/terminal-session-active-process-state";
import { createHooksApi } from "../../../src/trpc/hooks-api";
import { createRuntimeApi } from "../../../src/trpc/runtime-api";
import { confirmTestNativeUserInputAcceptance } from "../../utilities/confirm-test-native-user-input-acceptance";
import { KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE } from "../../utilities/task-mutation-intent-for-test-fixture";

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	loadPersistedWorkspaceStateById: vi.fn(),
	mutateWorkspaceState: vi.fn<typeof mutateWorkspaceState>(),
}));

// 只替换持久化边界；完成 sink、统一 transport 出口、终端的延迟写入与确认链均执行真身。
vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => ({
	...(await importOriginal()),
	...workspaceStateMocks,
}));
vi.mock("../../../src/cline-sdk/cline-provider-service.js", () => ({ createClineProviderService: () => ({}) }));
vi.mock("../../../src/cline-sdk/cline-mcp-settings-service.js", () => ({ createClineMcpSettingsService: () => ({}) }));
vi.mock("../../../src/cline-sdk/cline-mcp-runtime-service.js", () => ({ createClineMcpRuntimeService: () => ({}) }));
vi.mock("../../../src/inter-work-unit-relation-ledger/task-message-delivery-request-event-recording.js", () => ({
	recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking: vi.fn(),
	recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking: vi.fn(),
	recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking: vi.fn(),
}));
vi.mock("../../../src/diagnostics/hook-ingest-tool-call-and-hook-cli-resource-usage-journal-recorder.js", () => ({
	recordHookIngestToolCallAndHookCliResourceUsageToJournal: vi.fn(),
}));
vi.mock("../../../src/notifications/notification-signal-capture.js", () => ({
	captureNotificationSignal: vi.fn(),
	recordNotificationSignalDecision: vi.fn(),
}));
// 本套件只验证 UserPromptSubmit 的交接 sink，不启动额外的任务生命周期转移。
vi.mock("../../../src/trpc/hook-event-task-transition-gate.js", () => ({ canTransitionTaskForHookEvent: () => false }));

const scope = { workspaceId: "handover-human-delivery-workspace", workspacePath: "/isolated/handover-workspace" };
const humanPrompt = "继续检查下一部分";
const targetSessionId = "codex-main-session";
const runtimeConfig: RuntimeConfigState = {
	userInterfacePreferencesSharedAcrossBrowserOrigins:
		USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
	selectedAgentId: "codex",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	newTaskStartInPlanModeByDefault: false,
	ompAgentSessionTransportForNewTasks: "pty_terminal",
	readyForReviewNotificationsEnabled: true,
	notificationSoundEnabled: true,
	autoContinueOnConnectionDropEnabled: false,
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: false,
	postDeployVerificationForceCompleteEnabled: false,
	shortcuts: [],
	commitPromptTemplate: "commit",
	openPrPromptTemplate: "pr",
	commitPromptTemplateDefault: "commit",
	openPrPromptTemplateDefault: "pr",
	globalConfigPath: "/isolated/global-config.json",
	projectConfigPath: "/isolated/project-config.json",
};

function createHandover(status: TaskMainSessionHandoverRecord["status"]): TaskMainSessionHandoverRecord {
	return {
		handoverId: "handover-before-human-message",
		sourceTaskConversationSessionId: "task-1",
		targetTaskConversationSessionId: targetSessionId,
		destination: { kind: "new_codex_session" },
		status,
		createdAt: 1,
		updatedAt: 2,
		userContextNotes: "",
		additionalPlanReferencePaths: [],
		materialDirectoryPath: "/isolated/persistent-handover-material",
		errorMessage: status === "failed" ? "报告投递尚未确认" : null,
		reportDeliveryStartedAt: 1,
		reportDeliveryAttempt: 1,
	};
}

function createSession(taskId: string, agentId: "claude" | "codex"): RuntimeTaskSessionSummary {
	return runtimeTaskSessionSummarySchema.parse({
		taskId,
		agentId,
		state: "awaiting_review",
		workspacePath: scope.workspacePath,
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		runtimeSessionIncarnationId: "handover-human-delivery-incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: agentId,
			nativeSessionId: `native-${taskId}`,
			transcriptPath: null,
			observedAt: 1,
		},
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		taskConversationSessionMetadata: {
			workspaceTaskId: "task-1",
			taskConversationSessionRole: taskId === targetSessionId ? "main" : "task_collaborator",
			taskConversationSessionContextSource: "main",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
			taskAutomationSuspendedForMainSessionHandover: true,
		},
	});
}

// 只替换 PTY 和读屏 I/O；真实 manager 自己安排 paste、CR、确认 tick 并生成回执。
function installTerminalSession(manager: TerminalSessionManager, summary: RuntimeTaskSessionSummary) {
	const write = vi.fn();
	let screenText = "model: test\n› ";
	const screenSnapshot = (): TerminalScreenSnapshot => {
		const lines: TerminalScreenSnapshot["lines"] = screenText.split("\n").map((text) => ({ text, isWrapped: false }));
		const composerRow = lines.findIndex((line) => line.text.startsWith("› "));
		if (composerRow >= 0 && lines[composerRow].text === "› ") {
			// 空框 fixture 提供当前 Codex 的真实占位样式与光标证据；真人正文仍保持普通文本。
			lines[composerRow] = {
				text: "› Ask Codex to do anything",
				isWrapped: false,
				dimmedTextColumnRanges: [[2, 26]],
			};
		}
		return { lines, columnCount: 80, ...(composerRow >= 0 ? { cursorRow: composerRow, cursorColumn: 2 } : {}) };
	};
	const entry = {
		summary,
		active: {
			session: { write },
			outputReactionEngine: null,
			outputReactionScanBuffer: null,
			deferredStartupPromptText: null,
			lastUserInputAt: null,
			taskChatInputDeliveryTimer: null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			programmaticDeliveryReceipt: null as PendingProgrammaticDeliveryReceipt | null,
			awaitingCodexPromptAfterEnter: false,
			inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			ptyOutputChunkArrivalSequenceNumber: 0,
			terminalSessionIncarnationToken: "handover-human-delivery-incarnation",
		},
		terminalStateMirror: {
			getSnapshot: async () => ({ snapshot: screenText, cols: 80, rows: 24 }),
			getViewportSnapshot: async () => ({ snapshot: screenText, cols: 80, rows: 24 }),
			getScreenSnapshot: async () => screenSnapshot(),
		},
		listenerIdCounter: 1,
		listeners: new Map(),
	};
	(manager as unknown as { entries: Map<string, typeof entry> }).entries.set(summary.taskId, entry);
	return {
		entry,
		write,
		setScreenText: (text: string) => {
			screenText = text;
		},
	};
}

describe("真人消息确认提交后才解除主会话交接 hold", () => {
	let persistedState: RuntimeWorkspaceStateResponse;
	let savedCompletionCount: number;

	function currentCard(): RuntimeBoardCard {
		return persistedState.board.columns[0].cards[0];
	}

	function expectHandoverHeld(status: TaskMainSessionHandoverRecord["status"]) {
		expect(currentCard().taskMainSessionHandover?.status).toBe(status);
		for (const session of Object.values(persistedState.sessions)) {
			expect(session.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover).toBe(true);
		}
		expect(savedCompletionCount).toBe(0);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
		savedCompletionCount = 0;
		const board: RuntimeBoardData = {
			columns: [
				{
					id: "in_progress",
					title: "进行中",
					cards: [
						{
							id: "task-1",
							title: "交接任务",
							prompt: "原始需求",
							baseRef: "main",
							startInPlanMode: false,
							createdAt: 1,
							updatedAt: 1,
							mainTaskConversationSessionId: targetSessionId,
							taskMainSessionHandover: createHandover("awaiting_user_message"),
						},
					],
				},
			],
		};
		persistedState = {
			repoPath: scope.workspacePath,
			statePath: "/isolated/state.json",
			git: { currentBranch: null, defaultBranch: null, branches: [] },
			board,
			sessions: {
				"task-1": createSession("task-1", "claude"),
				[targetSessionId]: createSession(targetSessionId, "codex"),
			},
			revision: 1,
		};
		workspaceStateMocks.loadWorkspaceBoardById.mockImplementation(async () => structuredClone(persistedState.board));
		workspaceStateMocks.loadPersistedWorkspaceStateById.mockImplementation(async () =>
			structuredClone(persistedState),
		);
		workspaceStateMocks.mutateWorkspaceState.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_path, _intent, mutate) => {
			const mutation: RuntimeWorkspaceAtomicMutationResult<unknown> = mutate(persistedState);
			if (mutation.save !== false) {
				const wasCompleted = currentCard().taskMainSessionHandover?.status === "completed";
				persistedState = {
					...persistedState,
					board: mutation.board,
					sessions: projectTaskConversationSessionsForMainSessionBinding(
						mutation.board,
						mutation.sessions ?? persistedState.sessions,
					),
					revision: persistedState.revision + 1,
				};
				if (!wasCompleted && currentCard().taskMainSessionHandover?.status === "completed")
					savedCompletionCount += 1;
			}
			return { value: mutation.value, state: persistedState, saved: mutation.save !== false };
		});
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function createSendingApi(manager: TerminalSessionManager, acpSummary: RuntimeTaskSessionSummary | null = null) {
		let currentAcpSummary = acpSummary;
		let settleAcpAcceptance: ((accepted: boolean) => void) | undefined;
		const acpService = {
			getSummary: vi.fn((sessionId: string) => (sessionId === currentAcpSummary?.taskId ? currentAcpSummary : null)),
			sendTaskSessionInput: vi.fn<AcpTaskSessionService["sendTaskSessionInput"]>(
				async (_sessionId, _text, _images, onAcceptanceSettled) => {
					settleAcpAcceptance = onAcceptanceSettled;
					if (currentAcpSummary)
						currentAcpSummary = {
							...currentAcpSummary,
							agentConversationPromptSubmissionAcceptance: {
								status: "pending",
								attemptedAtMs: Date.now(),
								runtimeSessionIncarnationId: currentAcpSummary.runtimeSessionIncarnationId ?? "acp-incarnation",
							},
						};
					return currentAcpSummary;
				},
			),
			applyTaskConversationSessionMetadata: vi.fn<AcpTaskSessionService["applyTaskConversationSessionMetadata"]>(
				(sessionId, metadata) => {
					if (sessionId !== currentAcpSummary?.taskId) return null;
					expect(currentCard().taskMainSessionHandover?.status).toBe("completed");
					currentAcpSummary = { ...currentAcpSummary, taskConversationSessionMetadata: metadata };
					return currentAcpSummary;
				},
			),

			listMessages: vi.fn(() => [
				{ id: "human-message", role: "user", content: humanPrompt, createdAt: Date.now() },
			]),
		};
		const confirmAcpPromptAcceptance = (accepted: boolean) => {
			if (currentAcpSummary?.agentConversationPromptSubmissionAcceptance)
				currentAcpSummary = {
					...currentAcpSummary,
					agentConversationPromptSubmissionAcceptance: {
						...currentAcpSummary.agentConversationPromptSubmissionAcceptance,
						status: accepted ? "accepted" : "unconfirmed",
					},
				};
			settleAcpAcceptance?.(accepted);
		};

		const api = createRuntimeApi({
			getActiveWorkspaceId: () => scope.workspaceId,
			loadScopedRuntimeConfig: async () => runtimeConfig,
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: async () => manager,
			getScopedClineTaskSessionService: async () =>
				({
					sendTaskSessionInput: async () => null,
					rebindPersistedTaskSession: async () => null,
				}) as unknown as ClineTaskSessionService,
			getScopedAcpTaskSessionService: async () => acpService as unknown as AcpTaskSessionService,
			resolveInteractiveShellCommand: () => ({ binary: "zsh", args: [] }),
			runCommand: vi.fn(),
			getUpdateStatus: vi.fn(),
			runUpdateNow: vi.fn(),
		});
		return { api, acpService, confirmAcpPromptAcceptance };
	}

	async function sendHumanMessage(api: ReturnType<typeof createRuntimeApi>) {
		return api.sendTaskChatMessage(
			scope,
			{ taskId: "task-1", text: humanPrompt },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
	}

	function observeRealTerminalReceipts(manager: TerminalSessionManager) {
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		const originalSubmit = manager.submitTaskChatInputWhenReady.bind(manager);
		vi.spyOn(manager, "submitTaskChatInputWhenReady").mockImplementation((taskId, text, options) =>
			originalSubmit(taskId, text, {
				...options,
				onDeliveryOutcome: (outcome) => {
					outcomes.push(outcome);
					options?.onDeliveryOutcome?.(outcome);
				},
			}),
		);
		return outcomes;
	}

	it.each(["main", "task_collaborator", "home"] as const)(
		"真人面板以会话 ID 直寻址可发送给未落盘的 ACP %s 会话",
		async (role) => {
			const sessionId = role === "home" ? `__home_agent__:${scope.workspaceId}:omp` : `omp-${role}`;
			const baseSummary = createSession(sessionId, "codex");
			if (!baseSummary.taskConversationSessionMetadata) throw new Error("测试会话缺少任务归属");
			const summary: RuntimeTaskSessionSummary = {
				...baseSummary,
				agentId: "omp",
				sessionTransport: "acp_stdio_subprocess",
				taskConversationSessionMetadata:
					role === "home"
						? undefined
						: {
								...baseSummary.taskConversationSessionMetadata,
								taskConversationSessionRole: role,
							},
			};
			const { api, acpService } = createSendingApi(new TerminalSessionManager(), summary);
			expect(
				await api.sendTaskChatMessage(
					scope,
					{ taskId: sessionId, targetTaskConversationSessionId: sessionId, text: humanPrompt },
					KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
				),
			).toMatchObject({ ok: true });
			expect(acpService.sendTaskSessionInput).toHaveBeenCalledWith(
				sessionId,
				humanPrompt,
				undefined,
				undefined,
				undefined,
			);
		},
	);

	it("CLI 显式即时投递可使用尚未落盘的 legacy 主会话", async () => {
		delete currentCard().mainTaskConversationSessionId;
		delete currentCard().taskMainSessionHandover;
		persistedState.sessions = {};
		const manager = new TerminalSessionManager();
		const summary = { ...createSession("task-1", "codex"), taskConversationSessionMetadata: undefined };
		installTerminalSession(manager, summary);
		const submit = vi.spyOn(manager, "submitTaskChatInputWhenReady");
		expect(
			await createSendingApi(manager).api.sendTaskChatMessage(
				scope,
				{ taskId: "task-1", targetTaskConversationSessionId: "task-1", text: humanPrompt, source: "rvf" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			),
		).toMatchObject({ ok: true });
		expect(submit).toHaveBeenCalledWith("task-1", humanPrompt, expect.any(Object));
	});

	it.each(["foreign-owner", "inconsistent-id"])("当前摘要 %s 不能被旧持久摘要放行", async (scenario) => {
		const manager = new TerminalSessionManager();
		const summary = structuredClone(persistedState.sessions[targetSessionId]);
		if (!summary.taskConversationSessionMetadata) throw new Error("测试会话缺少任务归属");
		if (scenario === "foreign-owner") summary.taskConversationSessionMetadata.workspaceTaskId = "another-task";
		const { entry } = installTerminalSession(manager, summary);
		if (scenario === "inconsistent-id") entry.summary.taskId = "another-session";
		const submit = vi.spyOn(manager, "submitTaskChatInputWhenReady");
		expect(
			await createSendingApi(manager).api.sendTaskChatMessage(
				scope,
				{ taskId: "task-1", targetTaskConversationSessionId: targetSessionId, text: humanPrompt },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			),
		).toMatchObject({ ok: false });
		expect(submit).not.toHaveBeenCalled();
	});

	it.each([
		"unknown-session",
		"deleted-host",
		"foreign-workspace-home",
		"programmatic-home",
		"different-explicit-target",
	])("会话直寻址仍拒绝 %s，不触达 transport", async (scenario) => {
		const sessionId = scenario.includes("home")
			? `__home_agent__:${scenario === "foreign-workspace-home" ? "another-workspace" : scope.workspaceId}:omp`
			: scenario === "unknown-session"
				? "unknown-direct-session"
				: targetSessionId;
		const summary: RuntimeTaskSessionSummary = {
			...createSession(sessionId, "codex"),
			agentId: "omp",
			sessionTransport: "acp_stdio_subprocess",
		};
		if (scenario === "deleted-host") persistedState.board.columns[0].cards = [];
		const manager = new TerminalSessionManager();
		const submit = vi.spyOn(manager, "submitTaskChatInputWhenReady");
		const { api, acpService } = createSendingApi(manager, scenario === "unknown-session" ? null : summary);
		expect(
			await api.sendTaskChatMessage(
				scope,
				{
					taskId: scenario === "different-explicit-target" ? "another-session" : sessionId,
					targetTaskConversationSessionId: sessionId,
					text: humanPrompt,
					...(scenario === "programmatic-home" || scenario === "deleted-host" ? { source: "rvf" } : {}),
				},
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			),
		).toMatchObject({ ok: false });
		expect(acpService.sendTaskSessionInput).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	it.each(["missing-session", "foreign-session", "deleted-card"])(
		"runtime 在 transport 前拒绝显式目标 %s",
		async (scenario) => {
			const manager = new TerminalSessionManager();
			const send = vi.spyOn(manager, "submitTaskChatInputWhenReady");
			const { api } = createSendingApi(manager);
			const requestedSession = scenario === "deleted-card" ? targetSessionId : scenario;
			if (scenario === "foreign-session") {
				const original = persistedState.sessions[targetSessionId];
				if (!original.taskConversationSessionMetadata) throw new Error("测试会话缺少任务归属");
				persistedState.sessions[scenario] = {
					...original,
					taskId: scenario,
					taskConversationSessionMetadata: {
						...original.taskConversationSessionMetadata,
						workspaceTaskId: "another-task",
					},
				};
			}
			if (scenario === "deleted-card") {
				for (const column of persistedState.board.columns) column.cards = [];
			}
			expect(
				await api.sendTaskChatMessage(
					scope,
					{ taskId: "task-1", targetTaskConversationSessionId: requestedSession, text: "精确目标" },
					KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
				),
			).toMatchObject({ ok: false });
			expect(send).not.toHaveBeenCalled();
		},
	);

	it.each(["awaiting_user_message", "failed"] as const)("无活跃终端时保留 %s 与暂停状态", async (status) => {
		currentCard().taskMainSessionHandover = createHandover(status);
		const manager = new TerminalSessionManager();
		const response = await sendHumanMessage(createSendingApi(manager).api);
		expect(response).toMatchObject({
			ok: false,
			terminalDelivery: { status: "delivery_failed", reason: "no_active_terminal_session" },
		});
		expectHandoverHeld(status);
	});

	it("恢复启动失败时保留等待和重试状态", async () => {
		const manager = new TerminalSessionManager();
		const summary = persistedState.sessions[targetSessionId];
		if (summary.taskConversationSessionMetadata)
			summary.taskConversationSessionMetadata.taskConversationSessionLaunchSettings = {
				sessionTransport: "pty_terminal",
				taskAgentPermissionMode: "ask_for_every_tool_use",
			};
		manager.hydrateFromRecord({ [targetSessionId]: summary });
		const { api } = createSendingApi(manager);
		vi.spyOn(api, "startTaskSession").mockResolvedValue({ ok: false, summary: null, error: "启动失败" });
		const response = await sendHumanMessage(api);
		expect(response).toMatchObject({ ok: false, error: "启动失败" });
		expectHandoverHeld("awaiting_user_message");
	});

	it.each([false, true])(
		"真人无 source/key 的真实回执确认后解除 hold，写入时 agent 活跃=%s",
		async (activeAgentTurn) => {
			const manager = new TerminalSessionManager();
			let summary = persistedState.sessions[targetSessionId];
			if (activeAgentTurn)
				summary = mergeSummaryWithFacets(summary, { turnOwner: "agent", liveness: "live", userTurnKind: null });
			const { entry, write } = installTerminalSession(manager, summary);
			const outcomes = observeRealTerminalReceipts(manager);
			const response = await sendHumanMessage(createSendingApi(manager).api);
			expect(response).toMatchObject({
				ok: true,
				terminalDelivery: { status: "accepted_pending_submit_confirmation" },
			});
			expectHandoverHeld("awaiting_user_message");
			await vi.advanceTimersByTimeAsync(1_000);
			expect(write).toHaveBeenCalled();
			expect(outcomes).toEqual([]);
			expectHandoverHeld("awaiting_user_message");
			await vi.advanceTimersByTimeAsync(1_500);
			expect(write).toHaveBeenCalledWith("\r");
			expect(outcomes).toEqual([]);
			expectHandoverHeld("awaiting_user_message");
			if (entry.active?.programmaticDeliveryReceipt)
				entry.active.programmaticDeliveryReceipt.nativeConversationActivityCursorImmediatelyBeforeSubmit = {
					transport: "codex_control",
					predecessorTurnId: "before-submit",
					seenEventIds: [],
				};
			confirmTestNativeUserInputAcceptance({ manager, taskId: targetSessionId, promptText: humanPrompt });
			await vi.advanceTimersByTimeAsync(2_500);
			expect(outcomes).toEqual([
				{
					status: activeAgentTurn ? "delivered_queued_behind_active_agent_turn" : "delivered_and_submit_confirmed",
					reason: null,
				},
			]);
			expect(currentCard().taskMainSessionHandover?.status).toBe("completed");
			expect(savedCompletionCount).toBe(1);
			for (const session of Object.values(persistedState.sessions)) {
				expect(session.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover).toBe(false);
			}
		},
	);

	it.each(["awaiting_user_message", "failed"] as const)("真实确认链最终失败时保留 %s", async (status) => {
		currentCard().taskMainSessionHandover = createHandover(status);
		const manager = new TerminalSessionManager();
		installTerminalSession(manager, persistedState.sessions[targetSessionId]);
		const outcomes = observeRealTerminalReceipts(manager);
		await sendHumanMessage(createSendingApi(manager).api);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" }]);
		expectHandoverHeld(status);
	});

	it("文字仍留在 Codex 输入框时，背景输出不能解除 hold", async () => {
		const manager = new TerminalSessionManager();
		const { setScreenText } = installTerminalSession(manager, persistedState.sessions[targetSessionId]);
		const outcomes = observeRealTerminalReceipts(manager);
		await sendHumanMessage(createSendingApi(manager).api);
		await vi.advanceTimersByTimeAsync(2_500);
		setScreenText(`model: test\n› ${humanPrompt}`);
		manager.recordEffectiveAgentConversationActivity(targetSessionId, {
			observedAtMs: Date.now(),
			evidenceKind: "persisted_agent_transcript",
			activityKind: "tool_activity",
			eventId: "unrelated-background-tool-update",
		});
		await vi.advanceTimersByTimeAsync(2_500);
		expect(outcomes).toEqual([]);
		expectHandoverHeld("awaiting_user_message");
	});

	it("ACP 只在可靠协议接受之后完成交接，重复确认不改写完成时间", async () => {
		const manager = new TerminalSessionManager();
		const summary = {
			...persistedState.sessions[targetSessionId],
			agentId: "omp" as const,
			sessionTransport: "acp_stdio_subprocess" as const,
		};
		const { api, acpService, confirmAcpPromptAcceptance } = createSendingApi(manager, summary);
		const response = await sendHumanMessage(api);
		expect(response).toMatchObject({
			ok: true,
			terminalDelivery: { status: "accepted_pending_submit_confirmation" },
		});
		expectHandoverHeld("awaiting_user_message");
		confirmAcpPromptAcceptance(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(currentCard().taskMainSessionHandover?.status).toBe("completed");
		expect(savedCompletionCount).toBe(1);
		expect(
			acpService.getSummary(targetSessionId)?.taskConversationSessionMetadata
				?.taskAutomationSuspendedForMainSessionHandover,
		).toBe(false);
		const completedAt = currentCard().taskMainSessionHandover?.updatedAt;
		const revision = persistedState.revision;
		confirmAcpPromptAcceptance(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(currentCard().taskMainSessionHandover?.updatedAt).toBe(completedAt);
		expect(persistedState.revision).toBe(revision);
		expect(savedCompletionCount).toBe(1);
	});

	it("ACP 接受未知保持 hold，旧投递的迟到证明不能完成新交接", async () => {
		const summary = {
			...persistedState.sessions[targetSessionId],
			agentId: "omp" as const,
			sessionTransport: "acp_stdio_subprocess" as const,
		};
		const { api, confirmAcpPromptAcceptance } = createSendingApi(new TerminalSessionManager(), summary);
		await sendHumanMessage(api);
		confirmAcpPromptAcceptance(false);
		await vi.advanceTimersByTimeAsync(0);
		expectHandoverHeld("awaiting_user_message");
		currentCard().taskMainSessionHandover = {
			...createHandover("awaiting_user_message"),
			handoverId: "newer-acp-handover",
		};
		confirmAcpPromptAcceptance(true);
		await vi.advanceTimersByTimeAsync(0);
		expectHandoverHeld("awaiting_user_message");
	});

	it("前置提交不完成交接，原生接受后迟到重复证明不重写完成时间或重复通知", async () => {
		const manager = new TerminalSessionManager();
		const { entry } = installTerminalSession(manager, persistedState.sessions[targetSessionId]);
		const appliedMetadata = vi.spyOn(manager, "applyTaskConversationSessionMetadata");
		const outcomes = observeRealTerminalReceipts(manager);
		await sendHumanMessage(createSendingApi(manager).api);
		await vi.advanceTimersByTimeAsync(2_500);
		const hooksApi = createHooksApi({
			getWorkspacePathById: () => scope.workspacePath,
			ensureTerminalManagerForWorkspace: async () => manager,
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});
		expect(
			await hooksApi.ingest({
				workspaceId: scope.workspaceId,
				taskId: targetSessionId,
				event: "to_in_progress",
				submittedPromptText: humanPrompt,
				metadata: { source: "codex", hookEventName: "UserPromptSubmit" },
			}),
		).toMatchObject({ ok: true });
		expect(savedCompletionCount).toBe(0);
		if (entry.active?.programmaticDeliveryReceipt)
			entry.active.programmaticDeliveryReceipt.nativeConversationActivityCursorImmediatelyBeforeSubmit = {
				transport: "codex_control",
				predecessorTurnId: "before-submit",
				seenEventIds: [],
			};
		confirmTestNativeUserInputAcceptance({ manager, taskId: targetSessionId, promptText: humanPrompt });
		await vi.advanceTimersByTimeAsync(0);

		const completedAt = currentCard().taskMainSessionHandover?.updatedAt;
		const revisionAfterHook = persistedState.revision;
		const metadataApplicationsAfterHook = appliedMetadata.mock.calls.length;
		expect(savedCompletionCount).toBe(1);
		if (entry.active?.programmaticDeliveryReceipt)
			entry.active.programmaticDeliveryReceipt.nativeConversationActivityCursorImmediatelyBeforeSubmit = {
				transport: "codex_control",
				predecessorTurnId: "before-submit",
				seenEventIds: [],
			};
		confirmTestNativeUserInputAcceptance({ manager, taskId: targetSessionId, promptText: humanPrompt });
		await vi.advanceTimersByTimeAsync(2_500);
		expect(outcomes).toEqual([{ status: "delivered_and_submit_confirmed", reason: null }]);
		expect(currentCard().taskMainSessionHandover?.updatedAt).toBe(completedAt);
		expect(persistedState.revision).toBe(revisionAfterHook);
		expect(appliedMetadata).toHaveBeenCalledTimes(metadataApplicationsAfterHook);
	});

	it("原生提交与回执并发预读同一状态时只持久完成一次", async () => {
		const changedMetadata = vi.fn();
		const input = {
			...scope,
			taskConversationSessionId: targetSessionId,
			promptText: humanPrompt,
			onTaskConversationSessionMetadataChanged: changedMetadata,
		};
		await Promise.all([
			completeTaskMainSessionHandoverAfterUserMessage(input),
			completeTaskMainSessionHandoverAfterUserMessage({
				...input,
				expectedHandoverId: createHandover("awaiting_user_message").handoverId,
			}),
		]);
		expect(savedCompletionCount).toBe(1);
		expect(persistedState.revision).toBe(2);
		expect(changedMetadata).toHaveBeenCalledTimes(2);
	});

	it("旧投递迟到的确认不能完成同一目标上的新交接", async () => {
		const manager = new TerminalSessionManager();
		const { entry } = installTerminalSession(manager, persistedState.sessions[targetSessionId]);
		await sendHumanMessage(createSendingApi(manager).api);
		await vi.advanceTimersByTimeAsync(2_500);
		currentCard().taskMainSessionHandover = {
			...createHandover("awaiting_user_message"),
			handoverId: "newer-handover",
		};
		if (entry.active?.programmaticDeliveryReceipt)
			entry.active.programmaticDeliveryReceipt.nativeConversationActivityCursorImmediatelyBeforeSubmit = {
				transport: "codex_control",
				predecessorTurnId: "before-submit",
				seenEventIds: [],
			};
		confirmTestNativeUserInputAcceptance({ manager, taskId: targetSessionId, promptText: humanPrompt });
		await vi.advanceTimersByTimeAsync(2_500);
		expectHandoverHeld("awaiting_user_message");
	});
});
