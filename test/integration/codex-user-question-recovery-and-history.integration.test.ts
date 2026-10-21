import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger,
	collectToolUseIdsAlreadyRecordedInDecisionLedger,
	mergeAgentRaisedUserDecisionHistoryEntries,
} from "../../src/agent-session-history/agent-raised-user-decision-history-builder";
import {
	extractCodexUserQuestionPayload,
	extractCodexUserQuestionResolution,
	resolveCodexUserQuestionHookEvent,
} from "../../src/commands/codex-user-question-payload-extraction";
import { buildAgentRaisedDecisionPayloads } from "../../src/commands/hooks";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { createAgentRaisedPendingUserDecisionAnswerDelivery } from "../../src/server/agent-raised-pending-user-decision-answer-delivery";
import { reconcileCodexUserQuestionTranscriptForTask } from "../../src/server/codex-user-question-transcript-reconciliation";
import {
	type AgentRaisedPendingUserDecisionAnswerDeliveryState,
	markAgentRaisedPendingUserDecisionsReclaimed,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
	recordAgentRaisedPendingUserDecisionAnswer,
	resolveAgentRaisedUserQuestionFromAgentTerminal,
	updateAgentRaisedPendingUserDecisionAnswerDeliveryState,
} from "../../src/state/agent-raised-pending-user-decision-store";
import { mutateWorkspaceState } from "../../src/state/workspace-state";
import type { TaskChatInputDeliveryOutcomeObserver, TerminalSessionManager } from "../../src/terminal/session-manager";
import { createHooksApi } from "../../src/trpc/hooks-api";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../src/trpc/runtime-api";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const nativeSessionId = "01a147e5-2f4c-77c2-834d-a1f23008f27e";
const toolInput = {
	questions: [
		{
			id: "reclaimed_session_recovery_gesture",
			question: "恢复原对话采用什么动作？",
			options: [{ label: "保留打开、聚焦和重启按钮" }, { label: "鼠标停留自动恢复" }],
		},
	],
};
const callLine = (callId: string, timestamp: number) =>
	JSON.stringify({
		type: "response_item",
		timestamp: new Date(timestamp).toISOString(),
		payload: {
			type: "function_call",
			name: "request_user_input",
			call_id: callId,
			arguments: JSON.stringify(toolInput),
		},
	});
const resultLine = (callId: string, value: string) =>
	JSON.stringify({
		type: "response_item",
		timestamp: new Date(5000).toISOString(),
		payload: { type: "function_call_output", call_id: callId, output: value },
	});

async function recordCodexQuestionWithRecordedPanelAnswer(input: {
	workspaceId: string;
	answerDeliveryState: Exclude<AgentRaisedPendingUserDecisionAnswerDeliveryState, "not_answered">;
	agentId?: "codex" | "claude";
	omitRecordedNativeSessionIdentity?: boolean;
}) {
	const payload = extractCodexUserQuestionPayload({
		callId: "call-panel-answer",
		toolInput,
		nativeConversationSessionId: nativeSessionId,
	});
	if (!payload) throw new Error("问答夹具无效");
	const decisionId = `task:${payload.decisionSourceId}`;
	await recordAgentRaisedPendingUserDecision(input.workspaceId, {
		workspaceId: input.workspaceId,
		taskId: "task",
		agentId: input.agentId ?? "codex",
		sessionTransport: "pty_terminal",
		decisionId,
		...(input.omitRecordedNativeSessionIdentity ? {} : { nativeConversationSessionId: nativeSessionId }),
		decisionKind: "ordinary_user_question",
		questionMarkdown: payload.questionMarkdown,
		options: payload.options,
		orderedQuestions: payload.orderedQuestions,
		allowsFreeformAnswer: payload.allowsFreeformAnswer,
		askedAt: 2000,
		graceDeadlineAt: null,
		originRuntimeSessionIncarnationId: "live-incarnation",
		originTurnSequence: 1,
		sourceHarnessSignal: "codex:request_user_input",
	});
	await recordAgentRaisedPendingUserDecisionAnswer(input.workspaceId, decisionId, {
		selectedOptionIds: ["option-1"],
		freeformText: null,
		orderedQuestionAnswers: [
			{
				decisionQuestionId: "reclaimed_session_recovery_gesture",
				selectedOptionIds: ["question-0-option-1"],
				freeformText: null,
			},
		],
		answeredAt: 3000,
		answerSource: "kanban_panel",
	});
	if (input.answerDeliveryState !== "answer_recorded")
		await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(input.workspaceId, decisionId, {
			answerDeliveryState: "delivery_in_progress",
			updatedAt: 3500,
		});
	if (input.answerDeliveryState === "delivery_failed" || input.answerDeliveryState === "delivered")
		await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(input.workspaceId, decisionId, {
			answerDeliveryState: input.answerDeliveryState,
			updatedAt: 4000,
			lastAnswerDeliveryFailureReason:
				input.answerDeliveryState === "delivery_failed" ? "隔离测试模拟投递失败" : null,
		});
	return { payload, decisionId };
}

describe.sequential("Codex 问答跨回收、恢复及历史查询的隔离闭环", () => {
	it.each(["answer_recorded", "delivery_in_progress", "delivery_failed"] as const)(
		"同调用终端真实答案替代尚未确认送达的面板答案，历史只保留真实答案且重试不发送（$0）",
		async (answerDeliveryState) => {
			await withIsolatedWorkspaceHome(async (register) => {
				const { workspaceId } = await register("codex-native-terminal-answer-after-panel-delivery-failure");
				const previousCodexHome = process.env.CODEX_HOME;
				process.env.CODEX_HOME = join(homedir(), ".codex");
				try {
					const { decisionId } = await recordCodexQuestionWithRecordedPanelAnswer({
						workspaceId,
						answerDeliveryState,
					});
					const directory = join(process.env.CODEX_HOME, "sessions", "2026", "10", "17");
					await mkdir(directory, { recursive: true });
					const transcriptPath = join(directory, `rollout-${nativeSessionId}.jsonl`);
					await writeFile(
						transcriptPath,
						[
							JSON.stringify({
								type: "session_meta",
								timestamp: new Date(1000).toISOString(),
								payload: { id: nativeSessionId, timestamp: new Date(1000).toISOString() },
							}),
							callLine("call-panel-answer", 2000),
							resultLine(
								"call-panel-answer",
								JSON.stringify({
									answers: { reclaimed_session_recovery_gesture: { answers: ["保留打开、聚焦和重启按钮"] } },
								}),
							),
							"",
						].join("\n"),
					);
					const recovered = await reconcileCodexUserQuestionTranscriptForTask({
						workspaceId,
						taskId: "task",
						sessionId: nativeSessionId,
						transcriptPath,
						summary: null,
					});
					const records = await readAgentRaisedPendingUserDecisions(workspaceId);
					expect(records).toHaveLength(1);
					expect(records[0]).toMatchObject({
						status: "answered",
						answerDeliveryState: "delivered",
						lastAnswerDeliveryFailureReason: null,
						answer: {
							answerSource: "agent_terminal",
							agentTerminalAnswersForQuestions: [{ answerText: "保留打开、聚焦和重启按钮" }],
						},
					});
					const history = mergeAgentRaisedUserDecisionHistoryEntries({
						ledgerEntries: buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(records, "task"),
						transcriptEntries: recovered.historyEntries,
						toolUseIdsAlreadyRecordedInDecisionLedger: collectToolUseIdsAlreadyRecordedInDecisionLedger(
							records,
							"task",
						),
					});
					expect(history).toHaveLength(1);
					expect(history[0]).toMatchObject({
						historyEntryId: `ledger:${decisionId}`,
						resolution: "answered_in_agent_terminal",
						questionAnswers: [{ selectedOptionLabels: ["保留打开、聚焦和重启按钮"] }],
					});
					const ensureTaskSessionReadyForDelivery = vi.fn(async () => true);
					const deliverTaskSessionInput = vi.fn(async () => true);
					const answerDelivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
						ensureTaskSessionReadyForDelivery,
						deliverTaskSessionInput,
					});
					expect(await answerDelivery.retryUndeliveredAnswers(workspaceId)).toBe(0);
					expect(
						await answerDelivery.answerPendingUserDecision({
							workspaceId,
							decisionId,
							selectedOptionIds: ["option-1"],
							freeformText: null,
						}),
					).toEqual({ ok: true, delivered: true });
					expect(ensureTaskSessionReadyForDelivery).not.toHaveBeenCalled();
					expect(deliverTaskSessionInput).not.toHaveBeenCalled();
					expect(await readAgentRaisedPendingUserDecisions(workspaceId)).toEqual(records);
				} finally {
					if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
					else process.env.CODEX_HOME = previousCodexHome;
				}
			});
		},
	);
	it.each([
		{ description: "面板答案已确认送达", boundary: "confirmed_delivery" },
		{ description: "不同 call", boundary: "different_call" },
		{ description: "不同原生会话", boundary: "different_native_session" },
		{ description: "答案缺少原生会话身份", boundary: "missing_resolution_native_session" },
		{ description: "账本缺少原生会话身份", boundary: "missing_recorded_native_session" },
		{ description: "工具无答案中断", boundary: "aborted_without_answer" },
		{ description: "工具无答案失败", boundary: "failed_without_answer" },
		{ description: "完整答案标记缺少逐问答案", boundary: "incomplete_question_answers" },
		{ description: "答案来自其他 harness", boundary: "different_resolution_harness" },
		{ description: "账本属于其他 harness", boundary: "different_recorded_harness" },
	])("终端答案对账保留面板答案的边界：$description", async ({ boundary }) => {
		await withIsolatedWorkspaceHome(async (register) => {
			const { workspaceId } = await register("codex-panel-answer-native-identity-protection");
			const { payload } = await recordCodexQuestionWithRecordedPanelAnswer({
				workspaceId,
				answerDeliveryState: boundary === "confirmed_delivery" ? "delivered" : "delivery_failed",
				agentId: boundary === "different_recorded_harness" ? "claude" : "codex",
				omitRecordedNativeSessionIdentity: boundary === "missing_recorded_native_session",
			});
			const beforeResolution = await readAgentRaisedPendingUserDecisions(workspaceId);
			let resolution = extractCodexUserQuestionResolution({
				callId: "call-panel-answer",
				payload,
				toolResponse:
					boundary === "aborted_without_answer"
						? "aborted"
						: boundary === "failed_without_answer"
							? "tool failed"
							: { answers: { reclaimed_session_recovery_gesture: { answers: ["保留打开、聚焦和重启按钮"] } } },
			});
			if (boundary === "different_call")
				resolution = { ...resolution, decisionSourceId: `${nativeSessionId}:different-call` };
			if (boundary === "different_native_session")
				resolution = { ...resolution, nativeConversationSessionId: "different-native-session" };
			if (boundary === "missing_resolution_native_session")
				resolution = { ...resolution, nativeConversationSessionId: undefined };
			if (boundary === "incomplete_question_answers") resolution = { ...resolution, answersForQuestions: [] };
			if (boundary === "different_resolution_harness") resolution = { ...resolution, sourceAgentId: undefined };
			expect(
				await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
					taskId: "task",
					resolution,
					resolvedAt: 5000,
					allowSupersededCodexAnswerRecoveryFromTranscript: true,
				}),
			).toBeNull();
			expect(await readAgentRaisedPendingUserDecisions(workspaceId)).toEqual(beforeResolution);
		});
	});
	it.each([
		{ successorAlreadyRecorded: false, useLegacyCallSourceId: false },
		{ successorAlreadyRecorded: false, useLegacyCallSourceId: true },
		{ successorAlreadyRecorded: true, useLegacyCallSourceId: false },
		{ successorAlreadyRecorded: true, useLegacyCallSourceId: true },
	])(
		"完整转录先回填旧调用真实答案，再保留同文后继待答且重复恢复幂等（后继已入库=$successorAlreadyRecorded，旧版 ID=$useLegacyCallSourceId）",
		async ({ successorAlreadyRecorded, useLegacyCallSourceId }) => {
			await withIsolatedWorkspaceHome(async (register) => {
				const { workspaceId, path } = await register("codex-prior-terminal-answer-reconciliation");
				const previousCodexHome = process.env.CODEX_HOME;
				process.env.CODEX_HOME = join(homedir(), ".codex");
				try {
					const recordQuestion = async (callId: string, askedAt: number) => {
						const payload = extractCodexUserQuestionPayload({
							callId,
							toolInput,
							nativeConversationSessionId: nativeSessionId,
						});
						if (!payload) throw new Error("问答夹具无效");
						return await recordAgentRaisedPendingUserDecision(workspaceId, {
							workspaceId,
							taskId: "task",
							agentId: "codex",
							sessionTransport: "pty_terminal",
							decisionId: `task:${useLegacyCallSourceId ? callId : payload.decisionSourceId}`,
							nativeConversationSessionId: nativeSessionId,
							decisionKind: "ordinary_user_question",
							questionMarkdown: payload.questionMarkdown,
							options: payload.options,
							orderedQuestions: payload.orderedQuestions,
							allowsFreeformAnswer: payload.allowsFreeformAnswer,
							askedAt,
							graceDeadlineAt: null,
							originRuntimeSessionIncarnationId: "live-incarnation",
							originTurnSequence: 1,
							sourceHarnessSignal: "codex:request_user_input",
						});
					};
					const oldQuestion = await recordQuestion("call-old", 2000);
					if (successorAlreadyRecorded) await recordQuestion("call-new", 6000);
					const directory = join(process.env.CODEX_HOME, "sessions", "2026", "10", "17");
					await mkdir(directory, { recursive: true });
					const transcriptPath = join(directory, `rollout-${nativeSessionId}.jsonl`);
					await writeFile(
						transcriptPath,
						[
							JSON.stringify({
								type: "session_meta",
								timestamp: new Date(1000).toISOString(),
								payload: { id: nativeSessionId, timestamp: new Date(1000).toISOString() },
							}),
							callLine("call-old", 2000),
							resultLine(
								"call-old",
								JSON.stringify({
									answers: { reclaimed_session_recovery_gesture: { answers: ["保留打开、聚焦和重启按钮"] } },
								}),
							),
							callLine("call-new", 6000),
							"",
						].join("\n"),
					);
					const summary: RuntimeTaskSessionSummary = {
						taskId: "task",
						state: "awaiting_review",
						agentId: "codex",
						workspacePath: path,
						lastHookAt: null,
						latestHookActivity: null,
						pid: 123,
						startedAt: 1000,
						updatedAt: 6000,
						lastOutputAt: 6000,
						reviewReason: null,
						exitCode: null,
						turnOwner: "user",
						liveness: "live",
						userTurnKind: "question",
						runtimeSessionIncarnationId: "live-incarnation",
					};
					const reconcile = () =>
						reconcileCodexUserQuestionTranscriptForTask({
							workspaceId,
							taskId: "task",
							sessionId: nativeSessionId,
							transcriptPath,
							summary,
						});
					const recovered = await reconcile();
					const records = await readAgentRaisedPendingUserDecisions(workspaceId);
					expect(records).toHaveLength(2);
					expect(records[0]).toMatchObject({
						decisionId: oldQuestion.decisionId,
						status: "answered",
						answerDeliveryState: "delivered",
						answer: {
							answerSource: "agent_terminal",
							agentTerminalAnswersForQuestions: [{ answerText: "保留打开、聚焦和重启按钮" }],
						},
					});
					expect(records[1]).toMatchObject({ status: "pending", answer: null });
					const history = mergeAgentRaisedUserDecisionHistoryEntries({
						ledgerEntries: buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(records, "task"),
						transcriptEntries: recovered.historyEntries,
						toolUseIdsAlreadyRecordedInDecisionLedger: collectToolUseIdsAlreadyRecordedInDecisionLedger(
							records,
							"task",
						),
					});
					expect(history).toHaveLength(1);
					expect(history[0]).toMatchObject({
						historyEntryId: `ledger:${oldQuestion.decisionId}`,
						resolution: "answered_in_agent_terminal",
						questionAnswers: [{ selectedOptionLabels: ["保留打开、聚焦和重启按钮"] }],
					});
					await reconcile();
					expect(await readAgentRaisedPendingUserDecisions(workspaceId)).toEqual(records);
				} finally {
					if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
					else process.env.CODEX_HOME = previousCodexHome;
				}
			});
		},
	);
	it("实时 hook 落库 → 回收标记 → 新 incarnation → 面板答案投递一次；拒答与重提的真实答案分别记录", async () => {
		await withIsolatedWorkspaceHome(async (register) => {
			const { workspaceId, path } = await register("codex-question-recovery");
			const previousCodexHome = process.env.CODEX_HOME;
			process.env.CODEX_HOME = join(homedir(), ".codex");
			try {
				await mutateWorkspaceState(path, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: addTaskToColumn(
						state.board,
						"review",
						{
							taskId: "36156",
							prompt: "隔离 Codex 问答",
							baseRef: "main",
							agentId: "codex",
							worktreeMode: "inplace",
						},
						() => "36156",
					).board,
					value: null,
				}));
				const directory = join(process.env.CODEX_HOME, "sessions", "2026", "10", "17");
				await mkdir(directory, { recursive: true });
				const transcriptPath = join(directory, `rollout-${nativeSessionId}.jsonl`);
				const prefix = `${JSON.stringify({ type: "session_meta", timestamp: new Date(1000).toISOString(), payload: { id: nativeSessionId, timestamp: new Date(1000).toISOString() } })}\n${callLine("call-old", 2000)}\n`;
				await writeFile(transcriptPath, prefix);
				let summary: RuntimeTaskSessionSummary = {
					taskId: "36156",
					state: "running",
					agentId: "codex",
					workspacePath: path,
					lastHookAt: null,
					latestHookActivity: null,
					pid: 123,
					startedAt: 1000,
					updatedAt: 2000,
					lastOutputAt: 2000,
					reviewReason: null,
					exitCode: null,
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
					runtimeSessionIncarnationId: "old-incarnation",
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId,
						transcriptPath,
						observedAt: 1000,
					},
				};
				const submit = vi.fn(
					(
						_taskId: string,
						_text: string,
						options: { onDeliveryOutcome: TaskChatInputDeliveryOutcomeObserver },
					) => {
						options.onDeliveryOutcome({ status: "delivered_and_submit_confirmed", reason: null });
						return summary;
					},
				);
				const manager = {
					getSummary: () => summary,
					applyTurnCheckpoint: vi.fn(),
					applyHookActivity: vi.fn(),
					recordAgentLifecycleHookConversationProgress: vi.fn(),
					recordMainAgentConversationModelRequestDispatch: vi.fn(),
					transitionToReview: (_taskId: string, _reason: string, kind: "question") => {
						summary = {
							...summary,
							state: "awaiting_review",
							turnOwner: "user",
							liveness: "live",
							userTurnKind: kind,
						};
						return summary;
					},
					transitionToRunning: () => {
						summary = { ...summary, state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null };
						return summary;
					},
					resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery: vi.fn(async () => true),
					submitTaskChatInputWhenReady: submit,
				} as unknown as TerminalSessionManager;
				const hooks = createHooksApi({
					getWorkspacePathById: () => path,
					ensureTerminalManagerForWorkspace: async () => manager,
					broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
					broadcastTaskReadyForReview: vi.fn(),
					captureTaskTurnCheckpoint: async () => ({
						turn: 1,
						ref: "refs/kanban/checkpoints/isolated/turn/1",
						commit: "0000000000000000000000000000000000000000",
						createdAt: 2100,
					}),
				});
				const metadata = { source: "codex", toolName: "request_user_input", hookEventName: "PreToolUse" };
				const captured = buildAgentRaisedDecisionPayloads(
					{ tool_use_id: "call-old", tool_input: toolInput, session_id: nativeSessionId },
					metadata,
				);
				expect(
					(
						await hooks.ingest({
							taskId: "36156",
							workspaceId,
							hookEventCapturedAtEpochMs: 2100,
							event: resolveCodexUserQuestionHookEvent("activity", metadata),
							metadata,
							...captured,
						})
					).ok,
				).toBe(true);
				const [original] = await readAgentRaisedPendingUserDecisions(workspaceId);
				expect(original?.status).toBe("pending");
				expect(original?.originRuntimeSessionIncarnationId).toBe("old-incarnation");
				await markAgentRaisedPendingUserDecisionsReclaimed(workspaceId, "36156", 2500);
				const summaryPath = join(homedir(), "restored-codex-summary.json");
				await writeFile(
					summaryPath,
					JSON.stringify({
						...summary,
						state: "idle",
						turnOwner: "user",
						userTurnKind: "review",
						startedAt: 3000,
						runtimeSessionIncarnationId: "new-incarnation",
					}),
				);
				summary = JSON.parse(await readFile(summaryPath, "utf8")) as RuntimeTaskSessionSummary;
				const makeApi = () =>
					createRuntimeApi({
						getScopedTerminalManager: async () => manager,
						loadScopedRuntimeConfig: async () => ({ selectedAgentId: "codex" }),
					} as unknown as CreateRuntimeApiDependencies);
				const scope = { workspaceId, workspacePath: path };
				let runtime = makeApi();
				const pending = await runtime.listAgentRaisedPendingUserDecisions(scope, { taskId: "36156" });
				expect(pending.decisions).toHaveLength(1);
				expect(pending.decisions[0]?.reclaimedAt).toBe(2500);
				const decisionId = pending.decisions[0]?.decisionId ?? "missing";
				const answerRequest = {
					decisionId,
					selectedOptionIds: ["option-0"],
					freeformText: null,
					orderedQuestionAnswers: [
						{
							decisionQuestionId: "reclaimed_session_recovery_gesture",
							selectedOptionIds: ["question-0-option-0"],
							freeformText: null,
						},
					],
				};
				expect((await runtime.answerAgentRaisedPendingUserDecision(scope, answerRequest)).delivered).toBe(true);
				runtime = makeApi();
				expect((await runtime.answerAgentRaisedPendingUserDecision(scope, answerRequest)).delivered).toBe(true);
				expect(submit).toHaveBeenCalledTimes(1);
				expect(submit.mock.calls[0]?.[1]).toContain("保留打开、聚焦和重启按钮");
				expect(
					(await runtime.listAgentRaisedPendingUserDecisions(scope, { taskId: "36156" })).decisions,
				).toHaveLength(0);

				// 同问题 id 的后继调用确有真实答案；旧调用的工具中断不能获得后继答案。
				await writeFile(
					transcriptPath,
					`${prefix}${resultLine("call-old", "aborted")}\n${callLine("call-new", 4000)}\n${resultLine("call-new", JSON.stringify({ answers: { reclaimed_session_recovery_gesture: { answers: ["保留打开、聚焦和重启按钮"] } } }))}\n`,
				);
				const history = await runtime.listAgentRaisedUserDecisionHistoryForTask(scope, { taskId: "36156" });
				expect(history.historyEntries).toHaveLength(2);
				expect(
					history.historyEntries.filter((entry) => entry.resolution === "answered_in_agent_terminal"),
				).toHaveLength(1);
				expect(
					history.historyEntries.find((entry) => entry.historyEntryId.endsWith("call-new"))?.questionAnswers[0]
						?.selectedOptionLabels,
				).toEqual(["保留打开、聚焦和重启按钮"]);
				expect(
					(await runtime.listAgentRaisedPendingUserDecisions(scope, { taskId: "36156" })).decisions,
				).toHaveLength(0);
			} finally {
				if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
				else process.env.CODEX_HOME = previousCodexHome;
			}
		});
	});
	it("旧调用的迟到答案不会按相同正文清掉后继待答问题", async () => {
		await withIsolatedWorkspaceHome(async (register) => {
			const { workspaceId } = await register("codex-late-answer");
			const oldQuestion = extractCodexUserQuestionPayload({
				callId: "old",
				toolInput,
				nativeConversationSessionId: nativeSessionId,
			});
			const newQuestion = extractCodexUserQuestionPayload({
				callId: "new",
				toolInput,
				nativeConversationSessionId: nativeSessionId,
			});
			if (!oldQuestion || !newQuestion) throw new Error("问答夹具无效");
			for (const [index, payload] of [oldQuestion, newQuestion].entries())
				await recordAgentRaisedPendingUserDecision(workspaceId, {
					decisionId: `task:${payload.decisionSourceId}`,
					taskId: "task",
					workspaceId,
					agentId: "codex",
					sessionTransport: "pty_terminal",
					decisionKind: "ordinary_user_question",
					questionMarkdown: payload.questionMarkdown,
					options: payload.options,
					orderedQuestions: payload.orderedQuestions,
					allowsFreeformAnswer: true,
					nativeConversationSessionId: nativeSessionId,
					askedAt: 1000 + index,
					graceDeadlineAt: null,
					originRuntimeSessionIncarnationId: "live",
					originTurnSequence: 1,
					sourceHarnessSignal: "codex:request_user_input",
				});
			expect(
				await resolveAgentRaisedUserQuestionFromAgentTerminal(workspaceId, {
					taskId: "task",
					resolvedAt: 2000,
					resolution: extractCodexUserQuestionResolution({
						callId: "old",
						payload: oldQuestion,
						toolResponse: {
							answers: { reclaimed_session_recovery_gesture: { answers: ["保留打开、聚焦和重启按钮"] } },
						},
					}),
				}),
			).toBeNull();
			const records = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(records.map((record) => record.status)).toEqual(["superseded", "pending"]);
			expect(records.every((record) => record.answer === null)).toBe(true);
		});
	});
});
