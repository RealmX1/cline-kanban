import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractCodexUserQuestionPayload } from "../../src/commands/codex-user-question-payload-extraction";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import * as codexNativePromptDeliveryJournal from "../../src/core/codex-native-prompt-delivery-journal";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../../src/core/task-message-injection-ledger";
import { readCodexReplacedQuestionSelectorEvidence } from "../../src/server/codex-user-question-transcript-reconciliation";
import * as pendingUserDecisionStore from "../../src/state/agent-raised-pending-user-decision-store";
import {
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
} from "../../src/state/agent-raised-pending-user-decision-store";
import { persistCodexNativeDirectInputReadinessReconciliation } from "../../src/state/persist-codex-native-direct-input-readiness-reconciliation";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../../src/state/queued-task-prompt-delivery-store";
import { getWorkspaceDirectoryPath, loadPersistedWorkspaceStateById } from "../../src/state/workspace-state";
import { type TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../../src/terminal/session-manager";
import { createTerminalInputBoxOccupancyTrackerState } from "../../src/terminal/terminal-input-box-occupancy";
import type { PendingProgrammaticDeliveryReceipt } from "../../src/terminal/terminal-session-active-process-state";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../src/trpc/runtime-api";
import { confirmTestNativeUserInputAcceptance } from "../utilities/confirm-test-native-user-input-acceptance";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const nativeSessionId = "01a147e5-2f4c-77c2-834d-a1f23008f27e";
// 当前 Codex 投递要求明确的空框证据；null 只代表不可读，不能再用它模拟空框。
const inputBoxClearReading = {
	verdict: "input_box_clear_for_programmatic_delivery",
	unrecoverablePasteCount: 0,
} as const;
const toolInput = {
	questions: [{ id: "storage", question: "采用哪种存储方案？", options: [{ label: "SQLite" }, { label: "文件" }] }],
};
const callLine = (callId: string) =>
	JSON.stringify({
		type: "response_item",
		timestamp: new Date(2000).toISOString(),
		payload: {
			type: "function_call",
			name: "request_user_input",
			call_id: callId,
			arguments: JSON.stringify(toolInput),
		},
	});
const resultLine = (output: string) =>
	JSON.stringify({
		type: "response_item",
		timestamp: new Date(2500).toISOString(),
		payload: { type: "function_call_output", call_id: "old-call", output },
	});

async function withSyntheticCodexConversation(
	run: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>,
	recordManagedTaskPromptDeliveries = false,
) {
	await withIsolatedWorkspaceHome(async (register) => {
		const { workspaceId, path } = await register("codex-prewrite-validation");
		const previousCodexHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = join(homedir(), ".codex");
		try {
			await run(await createHarness(workspaceId, path, recordManagedTaskPromptDeliveries));
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = previousCodexHome;
		}
	});
}

async function createHarness(workspaceId: string, workspacePath: string, recordManagedTaskPromptDeliveries: boolean) {
	const transcriptDirectory = join(homedir(), ".codex", "sessions", "2026", "10", "17");
	await mkdir(transcriptDirectory, { recursive: true });
	const transcriptPath = join(transcriptDirectory, `rollout-${nativeSessionId}.jsonl`);
	const transcript = `${JSON.stringify({ type: "session_meta", timestamp: new Date(1000).toISOString(), payload: { id: nativeSessionId } })}\n${callLine("old-call")}\n${resultLine("aborted")}\n`;
	await writeFile(transcriptPath, transcript);
	const question = extractCodexUserQuestionPayload({
		callId: "old-call",
		toolInput,
		nativeConversationSessionId: nativeSessionId,
	});
	if (!question) throw new Error("合成问题无效");
	const decisionId = `guarded-answer:${question.decisionSourceId}`;
	await recordAgentRaisedPendingUserDecision(workspaceId, {
		workspaceId,
		taskId: "guarded-answer",
		agentId: "codex",
		sessionTransport: "pty_terminal",
		decisionId,
		nativeConversationSessionId: nativeSessionId,
		decisionKind: "ordinary_user_question",
		questionMarkdown: question.questionMarkdown,
		options: question.options,
		allowsFreeformAnswer: true,
		orderedQuestions: question.orderedQuestions,
		askedAt: 2000,
		graceDeadlineAt: null,
		originRuntimeSessionIncarnationId: "old-incarnation",
		originTurnSequence: 1,
		sourceHarnessSignal: "codex:request_user_input",
	});
	const manager = new TerminalSessionManager();
	const write = vi.fn();
	const summary: RuntimeTaskSessionSummary = {
		taskId: "guarded-answer",
		agentId: "codex",
		workspacePath,
		state: "idle",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: "resumed-incarnation",
		startedAt: 3000,
		updatedAt: 3000,
		lastOutputAt: null,
		lastHookAt: null,
		latestHookActivity: null,
		pid: 123,
		reviewReason: "hook",
		exitCode: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath,
			observedAt: 3000,
		},
	};
	const entry = {
		summary,
		listeners: new Map(),
		active: {
			session: { write },
			deferredStartupPromptText: null,
			taskChatInputDeliveryTimer: null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			programmaticDeliveryReceipt: null as PendingProgrammaticDeliveryReceipt | null,
			lastUserInputAt: null,
			outputReactionScanBuffer: null,
			inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			ptyOutputChunkArrivalSequenceNumber: 0,
		},
		terminalStateMirror: null,
	};
	const internals = manager as unknown as {
		entries: Map<string, typeof entry>;
		resolveInteractivePromptReadiness: () => Promise<"prompt">;
		resolveProgrammaticDeliveryInputBoxContentionForTask: () => Promise<typeof inputBoxClearReading>;
	};
	internals.entries.set("guarded-answer", entry);
	const readiness = vi.spyOn(internals, "resolveInteractivePromptReadiness").mockResolvedValue("prompt");
	const contention = vi
		.spyOn(internals, "resolveProgrammaticDeliveryInputBoxContentionForTask")
		.mockResolvedValue(inputBoxClearReading);
	vi.spyOn(manager, "resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery").mockResolvedValue(true);
	const submit = vi.spyOn(manager, "submitTaskChatInputWhenReady");
	const runtime = createRuntimeApi({
		recordManagedTaskPromptDeliveries,
		getScopedTerminalManager: async () => manager,
		loadScopedRuntimeConfig: async () => ({ selectedAgentId: "codex" }),
	} as unknown as CreateRuntimeApiDependencies);
	const answer = () =>
		runtime.answerAgentRaisedPendingUserDecision(
			{ workspaceId, workspacePath },
			{
				decisionId,
				selectedOptionIds: ["option-0"],
				freeformText: "保留已保存的答案",
				orderedQuestionAnswers: [
					{
						decisionQuestionId: "storage",
						selectedOptionIds: ["question-0-option-0"],
						freeformText: "保留已保存的答案",
					},
				],
			},
		);
	return { workspaceId, transcriptPath, transcript, manager, entry, write, readiness, contention, submit, answer };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe.sequential("Codex 面板答题在实际 PTY 写入前重新读取原生转录", () => {
	for (const stage of ["queued", "readiness_wait", "contention_wait", "after_paste", "before_resend"] as const) {
		for (const change of ["real_answer", "successor_call"] as const) {
			it(`${stage} 期间追加 ${change}，拦截旧答案或旧 Enter 并保留 durable 答案`, async () => {
				await withSyntheticCodexConversation(async (harness) => {
					vi.useFakeTimers();
					let releaseGate: () => void = () => undefined;
					if (stage === "readiness_wait")
						harness.readiness.mockImplementation(
							() =>
								new Promise<"prompt">((resolve) => {
									releaseGate = () => resolve("prompt");
								}),
						);
					if (stage === "contention_wait")
						harness.contention.mockImplementation(
							() =>
								new Promise<typeof inputBoxClearReading>((resolve) => {
									releaseGate = () => resolve(inputBoxClearReading);
								}),
						);
					const pendingAnswer = harness.answer();
					await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
					if (stage !== "queued") await vi.advanceTimersByTimeAsync(1000);
					if (stage === "after_paste" || stage === "before_resend") {
						await vi.waitFor(() => expect(harness.write).toHaveBeenCalledOnce());
						harness.entry.active.ptyOutputChunkArrivalSequenceNumber++;
						if (stage === "before_resend") {
							await vi.advanceTimersByTimeAsync(60);
							await vi.waitFor(() => expect(harness.write).toHaveBeenCalledTimes(2));
						}
					}
					await appendFile(
						harness.transcriptPath,
						`${change === "real_answer" ? resultLine(JSON.stringify({ answers: { storage: { answers: ["文件"] } } })) : callLine("successor-call")}\n`,
					);
					releaseGate();
					await vi.advanceTimersByTimeAsync(stage === "before_resend" ? 2500 : stage === "queued" ? 1000 : 60);
					const result = await pendingAnswer;
					expect(result.delivered).toBe(false);
					expect(harness.write).toHaveBeenCalledTimes(
						stage === "before_resend" ? 2 : stage === "after_paste" ? 1 : 0,
					);
					const saved = (await readAgentRaisedPendingUserDecisions(harness.workspaceId)).find(
						(decision) =>
							decision.taskId === "guarded-answer" && decision.answer?.answerSource === "kanban_panel",
					);
					expect(saved?.answer?.freeformText).toBe("保留已保存的答案");
					expect(saved?.answerDeliveryState).toBe(
						stage === "after_paste" || stage === "before_resend" ? "delivery_unconfirmed" : "delivery_failed",
					);
					expect(saved?.lastAnswerDeliveryFailureReason).toContain(
						change === "real_answer" ? "终端作答" : "新提问取代",
					);
				});
			});
		}
	}

	it.each(["native_conversation", "incarnation", "selector"])(
		"入队后 %s 改变，实际 PTY 不接收旧答案",
		async (change) => {
			await withSyntheticCodexConversation(async (harness) => {
				vi.useFakeTimers();
				const pendingAnswer = harness.answer();
				await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
				if (change === "native_conversation")
					harness.entry.summary.agentNativeConversationSessionIdentity = {
						sourceAgentId: "codex",
						nativeSessionId: "different-conversation",
						transcriptPath: null,
						observedAt: Date.now(),
					};
				if (change === "incarnation") harness.entry.summary.runtimeSessionIncarnationId = "different-incarnation";
				if (change === "selector") harness.entry.summary.userTurnKind = "question";
				await vi.advanceTimersByTimeAsync(1000);
				expect((await pendingAnswer).delivered).toBe(false);
				expect(harness.write).not.toHaveBeenCalled();
			});
		},
	);

	it.each(["real_answer", "successor_call"])("首个 Enter 前读问答账本时追加 %s，禁止写入 Enter", async (change) => {
		await withSyntheticCodexConversation(async (harness) => {
			vi.useFakeTimers();
			const pendingAnswer = harness.answer();
			await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(harness.write).toHaveBeenCalledOnce());
			const readDecisionLedger = pendingUserDecisionStore.readAgentRaisedPendingUserDecisions;
			const appendDuringLedgerRead = vi
				.spyOn(pendingUserDecisionStore, "readAgentRaisedPendingUserDecisions")
				.mockImplementationOnce(async (workspaceId) => {
					await appendFile(
						harness.transcriptPath,
						`${change === "real_answer" ? resultLine(JSON.stringify({ answers: { storage: { answers: ["文件"] } } })) : callLine("successor-call")}\n`,
					);
					return await readDecisionLedger(workspaceId);
				});
			harness.entry.active.ptyOutputChunkArrivalSequenceNumber++;
			await vi.advanceTimersByTimeAsync(60);
			await vi.waitFor(() => expect(appendDuringLedgerRead).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(2500);
			expect((await pendingAnswer).delivered).toBe(false);
			expect(harness.write).toHaveBeenCalledOnce();
			const [saved] = await readAgentRaisedPendingUserDecisions(harness.workspaceId);
			expect(saved).toMatchObject({ answerDeliveryState: "delivery_unconfirmed" });
			expect(saved?.lastAnswerDeliveryFailureReason).toContain(change === "real_answer" ? "终端作答" : "新提问取代");
		});
	});

	it.each(["different_agent", "successor_call_before_paste"])(
		"%s 使答案确定未写入，三个持久回执一致",
		async (change) => {
			await withSyntheticCodexConversation(async (harness) => {
				vi.useFakeTimers();
				if (change === "different_agent") {
					harness.entry.summary.agentId = "claude";
					harness.entry.summary.agentNativeConversationSessionIdentity = {
						sourceAgentId: "claude",
						nativeSessionId: "different-claude-conversation",
						transcriptPath: null,
						observedAt: Date.now(),
					};
				} else {
					const createJournal = codexNativePromptDeliveryJournal.createCodexNativePromptDeliveryJournal;
					vi.spyOn(
						codexNativePromptDeliveryJournal,
						"createCodexNativePromptDeliveryJournal",
					).mockImplementationOnce((binding) => {
						const journal = createJournal(binding);
						return {
							...journal,
							recordTerminalPtyWriteIntent: async () => {
								await journal.recordTerminalPtyWriteIntent();
								await appendFile(harness.transcriptPath, `${callLine("successor-call")}\n`);
							},
						};
					});
				}
				const pendingAnswer = harness.answer();
				let answerFinished = false;
				void pendingAnswer.then(() => {
					answerFinished = true;
				});
				await vi.waitFor(() => expect(answerFinished || harness.write.mock.calls.length > 0).toBe(true), {
					timeout: 5000,
				});
				expect(harness.write).not.toHaveBeenCalled();
				expect((await pendingAnswer).delivered).toBe(false);
				const [saved] = await readAgentRaisedPendingUserDecisions(harness.workspaceId);
				const failureNote = saved?.lastAnswerDeliveryFailureReason;
				expect(failureNote).toContain(change === "different_agent" ? "Codex 对话" : "新提问取代");
				expect(saved).toMatchObject({
					answer: { freeformText: "保留已保存的答案" },
					answerDeliveryState: "delivery_failed",
				});
				expect(saved?.answerDeliveryAttempts?.at(-1)).toMatchObject({ submissionMayHaveStarted: false });
				const queue = await readWorkspaceQueuedTaskPromptDeliverySnapshot(harness.workspaceId);
				expect(queue.entriesByTaskId[harness.entry.summary.taskId]?.[0]).toMatchObject({
					deliveryState: "cancelled",
					lastDeliveryFailureNote: failureNote,
					managedDelivery: {
						terminalDeliveryReceipt: { reason: "cancelled_before_delivery", submissionMayHaveStarted: false },
					},
				});
				const ledger = await readTaskMessageInjectionLedger(
					getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(harness.workspaceId)),
				);
				expect(ledger[0]).toMatchObject({
					submission_may_have_started: false,
					terminal_delivery_failure_detail: failureNote,
				});
			}, true);
		},
	);

	it.each([false, true])("恢复后只粘贴和提交一次，旧摘要仍写 question=%s", async (hasStaleQuestionSummary) => {
		await withSyntheticCodexConversation(async (harness) => {
			if (hasStaleQuestionSummary) {
				const before = harness.entry.summary;
				before.userTurnKind = "question";
				before.runtimeSessionIncarnationId = "3c67bb51-7969-4681-becc-9028d82423f1";
				before.codexNativeSessionControlEndpoint = {
					workspaceId: harness.workspaceId,
					conversationSessionId: before.taskId,
					runtimeSessionIncarnationId: before.runtimeSessionIncarnationId,
					socketPath: "/isolated/codex-control",
				};
				expect((await harness.answer()).delivered).toBe(false);
				expect(harness.submit).not.toHaveBeenCalled();
				expect(harness.write).not.toHaveBeenCalled();
				const [saved] = await readAgentRaisedPendingUserDecisions(harness.workspaceId);
				const failureNote = saved?.lastAnswerDeliveryFailureReason;
				expect(failureNote).toContain("正在核实");
				expect(saved).toMatchObject({
					answerDeliveryState: "delivery_failed",
				});
				expect(saved?.answerDeliveryAttempts?.at(-1)).toMatchObject({ submissionMayHaveStarted: false });
				const queue = await readWorkspaceQueuedTaskPromptDeliverySnapshot(harness.workspaceId);
				expect(queue.entriesByTaskId[before.taskId]?.[0]).toMatchObject({
					deliveryState: "cancelled",
					lastDeliveryFailureNote: failureNote,
					managedDelivery: {
						terminalDeliveryReceipt: { reason: "cancelled_before_delivery", submissionMayHaveStarted: false },
					},
				});
				const ledger = await readTaskMessageInjectionLedger(
					getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(harness.workspaceId)),
				);
				expect(ledger[0]).toMatchObject({
					submission_may_have_started: false,
					terminal_delivery_failure_detail: failureNote,
				});

				const nativeReadiness = { nativeSessionId, observedAtMs: 3500 };
				const persistReadiness = (observation: typeof nativeReadiness) =>
					persistCodexNativeDirectInputReadinessReconciliation({
						workspaceId: harness.workspaceId,
						summaryBeforeRead: before,
						getCurrentSummary: () => harness.manager.getSummary(before.taskId),
						change: { observation },
					});
				expect(await persistReadiness(nativeReadiness)).toBe(false);
				await appendFile(harness.transcriptPath, "\n{未写完的原生记录");
				expect(await readCodexReplacedQuestionSelectorEvidence(harness.workspaceId, before)).toBeNull();
				await writeFile(harness.transcriptPath, harness.transcript);
				const replacedQuestionSelector = await readCodexReplacedQuestionSelectorEvidence(
					harness.workspaceId,
					before,
				);
				expect(replacedQuestionSelector).toEqual({
					originRuntimeSessionIncarnationId: "old-incarnation",
					nativeQuestionAskedAtMs: 2000,
				});
				if (!replacedQuestionSelector) throw new Error("缺少已退出进程的选择题证据");
				const observation = { ...nativeReadiness, replacedQuestionSelector };
				expect(await persistReadiness(observation)).toBe(true);
				const persisted = await loadPersistedWorkspaceStateById(harness.workspaceId);
				expect(persisted?.sessions[before.taskId]).toMatchObject({ userTurnKind: "review" });
				harness.manager.reconcileCodexAwaitingInputWithNativeDirectInputReadiness(
					before.taskId,
					before,
					observation,
				);
				expect(harness.write).not.toHaveBeenCalled();
				expect(harness.manager.getSummary(before.taskId)?.userTurnKind).toBe("review");
			}
			vi.useFakeTimers();
			const pendingAnswer = harness.answer();
			await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(harness.write).toHaveBeenCalledOnce());
			harness.entry.active.ptyOutputChunkArrivalSequenceNumber++;
			await vi.advanceTimersByTimeAsync(60);
			await vi.waitFor(() => expect(harness.write).toHaveBeenCalledTimes(2));
			const receipt = harness.entry.active.programmaticDeliveryReceipt;
			if (!receipt) throw new Error("缺少待确认的问题答复回执");
			receipt.nativeConversationActivityCursorImmediatelyBeforeSubmit = {
				transport: "codex_control",
				predecessorTurnId: "question-answer-before-submit",
				seenEventIds: [],
			};
			confirmTestNativeUserInputAcceptance({
				manager: harness.manager,
				taskId: "guarded-answer",
				promptText: receipt.promptText,
			});
			await vi.advanceTimersByTimeAsync(2500);
			expect((await pendingAnswer).delivered).toBe(true);
			expect((await harness.answer()).delivered).toBe(true);
			expect(harness.write).toHaveBeenCalledTimes(2);
		}, hasStaleQuestionSummary);
	});

	it("问题答复先登记并等待真实回执，保留 agent 内排队的结果且重复答题不新增消息", async () => {
		await withSyntheticCodexConversation(async (harness) => {
			let confirmDelivery: ((outcome: TaskChatInputDeliveryOutcome) => void) | undefined;
			harness.submit.mockImplementation((_taskId, _text, options) => {
				confirmDelivery = options?.onDeliveryOutcome;
				return harness.entry.summary;
			});
			const pendingAnswer = harness.answer();
			await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
			const pending = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(harness.workspaceId)).entriesByTaskId[
				"guarded-answer"
			];
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({
				deliveryState: "handed_to_transport",
				managedDelivery: {
					messageType: "user_decision_answer",
					deliveryStrategy: "immediate",
					terminalDeliveryReceipt: null,
				},
			});
			expect(pending[0].text).toContain("保留已保存的答案");
			confirmDelivery?.({ status: "delivered_queued_behind_active_agent_turn", reason: null });
			expect((await pendingAnswer).delivered).toBe(true);
			expect((await harness.answer()).delivered).toBe(true);
			expect(harness.submit).toHaveBeenCalledOnce();
			const confirmed = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(harness.workspaceId)).entriesByTaskId[
				"guarded-answer"
			];
			expect(confirmed).toHaveLength(1);
			expect(confirmed[0]).toMatchObject({
				deliveryState: "settled_delivered",
				managedDelivery: { terminalDeliveryReceipt: { status: "delivered_queued_behind_active_agent_turn" } },
			});
		}, true);
	});
});
