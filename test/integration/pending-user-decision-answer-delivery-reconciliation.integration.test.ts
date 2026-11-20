import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentRaisedPendingUserDecisionAnswerDelivery } from "../../src/server/agent-raised-pending-user-decision-answer-delivery";
import { reconcileAgentRaisedPendingUserDecisionAnswerDelivery } from "../../src/server/agent-raised-pending-user-decision-answer-delivery-reconciliation";
import { buildAgentRaisedPendingUserDecisionAnswerMessage } from "../../src/server/agent-raised-pending-user-decision-answer-message";
import {
	type PersistedAgentRaisedPendingUserDecision,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
	updateAgentRaisedPendingUserDecisionAnswerDeliveryState,
} from "../../src/state/agent-raised-pending-user-decision-store";
import { beginManagedTaskPromptDelivery } from "../../src/state/managed-task-prompt-delivery-coordinator";
import { getRuntimeProcessInstanceHeartbeatsDirectoryPath } from "../../src/state/runtime-process-instance-heartbeat-registry";
import { getWorkspaceDirectoryPath } from "../../src/state/workspace-state";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

async function withAnsweredQuestionScenario(run: (workspaceId: string) => Promise<void>) {
	await withIsolatedWorkspaceHome(async (register) => {
		const { workspaceId } = await register("answer-reconciliation-project");
		await recordAgentRaisedPendingUserDecision(workspaceId, {
			decisionId: "task:question-call",
			taskId: "task",
			workspaceId,
			agentId: "claude",
			sessionTransport: "pty_terminal",
			decisionKind: "ordinary_user_question",
			questionMarkdown: "选择实现方案",
			options: [],
			allowsFreeformAnswer: true,
			askedAt: 1000,
			graceDeadlineAt: null,
			originRuntimeSessionIncarnationId: "original-process",
			originTurnSequence: 1,
			sourceHarnessSignal: "claude:AskUserQuestion",
		});
		await run(workspaceId);
	});
}

async function editPersistedRecord(
	workspaceId: string,
	edit: (record: PersistedAgentRaisedPendingUserDecision) => void,
) {
	const path = join(getWorkspaceDirectoryPath(workspaceId), "agent-raised-pending-user-decisions.json");
	const records = JSON.parse(await readFile(path, "utf8"));
	edit(records[0]);
	await writeFile(path, JSON.stringify(records));
}

const answerRequest = (workspaceId: string) => ({
	workspaceId,
	decisionId: "task:question-call",
	selectedOptionIds: [],
	freeformText: "采用现有实现",
});

describe.sequential("问答答案的送达补证与人工关闭", () => {
	it("确认超时保留未知和原始回执，重复提交只补证，迟到接受后关闭", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const send = vi.fn(async () => ({
				status: "delivery_failed" as const,
				reason: "submit_confirmation_budget_exhausted" as const,
			}));
			let accepted = false;
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: send,
				reconcileDeliveryEvidence: async () =>
					accepted ? { state: "delivered" as const } : { state: "delivery_unconfirmed" as const },
			});
			expect(await delivery.answerPendingUserDecision(answerRequest(workspaceId))).toMatchObject({
				delivered: false,
			});
			let [record] = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(record.answerDeliveryState).toBe("delivery_unconfirmed");
			expect(record.answerDeliveryAttempts?.[0].originalReceipt?.reason).toBe(
				"submit_confirmation_budget_exhausted",
			);
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			expect(send).toHaveBeenCalledTimes(1);
			accepted = true;
			await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
				workspaceId,
				decisionId: record.decisionId,
			});
			[record] = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(record.answerDeliveryState).toBe("delivered");
			expect(record.answerDeliveryAttempts?.[0].originalReceipt?.reason).toBe(
				"submit_confirmation_budget_exhausted",
			);
			expect(send).toHaveBeenCalledTimes(1);
		});
	});

	it("明确写入前失败可重投，逻辑键稳定、尝试身份独立", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const send = vi
				.fn()
				.mockResolvedValueOnce({ status: "delivery_failed", reason: "no_active_terminal_session" })
				.mockResolvedValueOnce(true);
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: send,
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			const [record] = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(record.answerDeliveryState).toBe("delivered");
			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.calls[0][0].idempotencyKey).toBe(send.mock.calls[1][0].idempotencyKey);
			expect(send.mock.calls[0][0].attemptId).not.toBe(send.mock.calls[1][0].attemptId);
		});
	});

	it("人工确认独立于送达事实，重新创建服务后仍阻止重投", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const send = vi.fn(async () => ({
				status: "delivery_failed" as const,
				reason: "codex_native_prompt_delivery_unconfirmed" as const,
			}));
			const dependencies = { ensureTaskSessionReadyForDelivery: async () => true, deliverTaskSessionInput: send };
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery(dependencies);
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			expect(
				await delivery.confirmAgentRaisedPendingUserDecisionAnswerHandled({
					workspaceId,
					decisionId: "task:question-call",
				}),
			).toMatchObject({ ok: true });
			await createAgentRaisedPendingUserDecisionAnswerDelivery(dependencies).answerPendingUserDecision(
				answerRequest(workspaceId),
			);
			const [record] = await readAgentRaisedPendingUserDecisions(workspaceId);
			expect(record.answerHandledConfirmation?.source).toBe("kanban_panel_terminal_confirmation");
			expect(record.answerDeliveryState).toBe("delivery_unconfirmed");
			expect(send).toHaveBeenCalledTimes(1);
		});
	});
	it("并发重投和人工确认等待同一在途发送，异常结果不能授权再次发送", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			let finishSend: () => void = () => undefined;
			let started: () => void = () => undefined;
			const sendStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			const send = vi.fn(async () => {
				started();
				await new Promise<void>((resolve) => {
					finishSend = resolve;
				});
				throw new Error("连接中断，写入结果未知");
			});
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: send,
			});
			const pending = delivery.answerPendingUserDecision(answerRequest(workspaceId));
			await sendStarted;
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			expect(
				await delivery.confirmAgentRaisedPendingUserDecisionAnswerHandled({
					workspaceId,
					decisionId: "task:question-call",
				}),
			).toMatchObject({ ok: false });
			finishSend();
			await pending;
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			expect(send).toHaveBeenCalledTimes(1);
			expect((await readAgentRaisedPendingUserDecisions(workspaceId))[0].answerDeliveryState).toBe(
				"delivery_unconfirmed",
			);
		});
	});

	it.each(["dead", "live", "unknown"] as const)("重启遗留投递先核验原执行归属：%s", async (liveness) => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const send = vi.fn(async () => ({
				status: "delivery_failed" as const,
				reason: "submit_confirmation_budget_exhausted" as const,
			}));
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: send,
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			const owner = liveness === "unknown" ? "unreadable-owner" : randomUUID();
			if (liveness === "live") {
				const directory = getRuntimeProcessInstanceHeartbeatsDirectoryPath();
				await mkdir(directory, { recursive: true });
				await writeFile(
					join(directory, `${owner}.json`),
					JSON.stringify({
						runtimeProcessInstanceId: owner,
						pid: 123,
						startedAtEpochMs: Date.now(),
						lastHeartbeatAtEpochMs: Date.now(),
					}),
				);
			}
			await editPersistedRecord(workspaceId, (record) => {
				record.answerDeliveryState = "delivery_in_progress";
				const attempt = record.answerDeliveryAttempts?.[0];
				if (!attempt) throw new Error("缺少投递尝试");
				attempt.state = "delivery_in_progress";
				attempt.submissionPhase = "submission_may_have_started";
				attempt.ownerRuntimeProcessInstanceId = owner;
			});
			const restored = await reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
				workspaceId,
				decisionId: "task:question-call",
				force: true,
			});
			expect(restored?.answerDeliveryState).toBe(
				liveness === "dead" ? "delivery_unconfirmed" : "delivery_in_progress",
			);
			expect(send).toHaveBeenCalledTimes(1);
		});
	});

	it("无新证据按 15、30、60 秒退避并暂停，新证据唤醒", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async () => ({
					status: "delivery_failed",
					reason: "submit_confirmation_budget_exhausted",
				}),
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			const readEvidence = vi.fn(async () => ({ state: "delivery_unconfirmed" as const }));
			let now = Date.now() + 20_000;
			for (const delay of [15_000, 30_000, 60_000, null]) {
				const record = await reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
					workspaceId,
					decisionId: "task:question-call",
					now,
					readEvidence,
				});
				expect(record?.answerDeliveryReconciliation?.nextReconciliationAt).toBe(
					delay === null ? null : now + delay,
				);
				now += delay ?? 100_000;
			}
			await reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
				workspaceId,
				decisionId: "task:question-call",
				now,
				readEvidence,
			});
			expect(readEvidence).toHaveBeenCalledTimes(4);
			await reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
				workspaceId,
				decisionId: "task:question-call",
				now,
				readEvidence,
				getSummary: () =>
					({
						agentConversationPromptSubmissionAcceptance: { status: "accepted", eventId: "new-evidence" },
					}) as never,
			});
			expect(readEvidence).toHaveBeenCalledTimes(5);
		});
	});

	it("只采用同一 attempt、正文与目标的持久回执，拒绝错误会话和同文不同调用", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			let deliveredInput:
				| Parameters<
						Parameters<typeof createAgentRaisedPendingUserDecisionAnswerDelivery>[0]["deliverTaskSessionInput"]
				  >[0]
				| undefined;
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async (input) => {
					deliveredInput = input;
					await input.persistSubmissionContext({
						targetNativeSessionId: "native-a",
						targetRuntimeSessionIncarnationId: "process-a",
					});
					return { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" };
				},
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			if (!deliveredInput) throw new Error("未捕获投递");
			const capturedInput = deliveredInput;
			for (const [key, native, call] of [
				[capturedInput.dispatchIdempotencyKey, "wrong-native", "task:question-call"],
				["another-attempt", "native-a", "task:question-call"],
				[capturedInput.dispatchIdempotencyKey, "native-a", "another-call"],
			]) {
				const { handle } = await beginManagedTaskPromptDelivery({
					workspaceId,
					taskId: "task",
					text: capturedInput.text,
					deliveryRequestId: randomUUID(),
					idempotencyKey: key,
					origin: { messageType: "user_decision_answer", sourceLabel: call },
					summary: {
						runtimeSessionIncarnationId: "process-a",
						agentNativeConversationSessionIdentity: { nativeSessionId: native },
					} as never,
				});
				await handle.settle({ status: "delivered_and_submit_confirmed", reason: null });
			}
			expect(
				(
					await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
						workspaceId,
						decisionId: "task:question-call",
					})
				)?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
			const { handle } = await beginManagedTaskPromptDelivery({
				workspaceId,
				taskId: "task",
				text: capturedInput.text,
				deliveryRequestId: randomUUID(),
				idempotencyKey: capturedInput.dispatchIdempotencyKey,
				origin: { messageType: "user_decision_answer", sourceLabel: "task:question-call" },
				summary: {
					runtimeSessionIncarnationId: "process-a",
					agentNativeConversationSessionIdentity: { nativeSessionId: "native-a" },
				} as never,
			});
			await handle.settle({ status: "delivered_and_submit_confirmed", reason: null });
			expect(
				(
					await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
						workspaceId,
						decisionId: "task:question-call",
					})
				)?.answerDeliveryState,
			).toBe("delivered");
		});
	});

	it.each([
		{ agentId: "claude", ambiguous: false },
		{ agentId: "codex", ambiguous: false },
		{ agentId: "claude", ambiguous: true },
		{ agentId: "codex", ambiguous: true },
	] as const)("$agentId 转录校验会话、正文及提交前位置；同文新消息歧义=$ambiguous", async ({ agentId, ambiguous }) => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			await editPersistedRecord(workspaceId, (record) => {
				record.agentId = agentId;
			});
			const transcriptPath = join(getWorkspaceDirectoryPath(workspaceId), "answer-native-transcript.jsonl");
			const userRecord = (nativeSessionId: string, text: string, id: string) =>
				agentId === "codex"
					? {
							type: "event_msg",
							timestamp: new Date().toISOString(),
							payload: {
								type: "item_completed",
								thread_id: nativeSessionId,
								turn_id: "turn-a",
								item: { type: "UserMessage", id, content: [{ type: "text", text }] },
							},
						}
					: {
							type: "user",
							promptSource: "typed",
							sessionId: nativeSessionId,
							cwd: "/session-workspace",
							uuid: id,
							timestamp: new Date().toISOString(),
							message: { role: "user", content: text },
						};
			await writeFile(
				transcriptPath,
				`${JSON.stringify({
					type: "session_meta",
					payload: { id: "native-a", cwd: "/session-workspace", source: "cli" },
				})}\n`,
			);
			let answerText = "";
			const send = vi.fn(async (input) => {
				answerText = input.text;
				// 同文旧调用位于提交前位置之前，永远不能据此确认本次答案。
				await appendFile(
					transcriptPath,
					`${JSON.stringify(userRecord("native-a", input.text, "old-user-message"))}\n`,
				);
				const metadata = await stat(transcriptPath);
				await input.persistSubmissionContext({
					targetNativeSessionId: "native-a",
					targetRuntimeSessionIncarnationId: "process-a",
					workingDirectoryPath: "/session-workspace",
					transcriptPath,
					preSubmissionTranscriptByteOffset: metadata.size,
					preSubmissionTranscriptFileIdentity: `${metadata.dev}:${metadata.ino}`,
				});
				return { status: "delivery_failed" as const, reason: "submit_confirmation_budget_exhausted" as const };
			});
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: send,
				getSummary: () =>
					({
						taskId: "task",
						agentId,
						runtimeSessionIncarnationId: "current-process",
						workspacePath: "/session-workspace",
					}) as never,
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			await appendFile(
				transcriptPath,
				`${JSON.stringify(userRecord("wrong-native", answerText, "wrong-user-message"))}\n`,
			);
			expect(
				(
					await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
						workspaceId,
						decisionId: "task:question-call",
					})
				)?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
			await appendFile(
				transcriptPath,
				`${JSON.stringify(userRecord("native-a", answerText, "correct-user-message"))}\n`,
			);

			if (ambiguous)
				await appendFile(
					transcriptPath,
					`${JSON.stringify(userRecord("native-a", answerText, "another-user-message"))}\n`,
				);
			expect(
				(
					await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
						workspaceId,
						decisionId: "task:question-call",
					})
				)?.answerDeliveryState,
			).toBe(ambiguous ? "delivery_unconfirmed" : "delivered");
			expect(send).toHaveBeenCalledOnce();
		});
	});

	it("旧 attempt 的回执与人工确认后的迟到结果均不能覆盖当前记录", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const send = vi
				.fn()
				.mockResolvedValueOnce({ status: "delivery_failed", reason: "no_active_terminal_session" })
				.mockResolvedValue({ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" });
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: send,
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			const oldAttemptId = (await readAgentRaisedPendingUserDecisions(workspaceId))[0].answerDeliveryAttempts?.[0]
				.attemptId;
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			expect(
				await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(workspaceId, "task:question-call", {
					answerDeliveryState: "delivered",
					expectedAttemptId: oldAttemptId,
					updatedAt: Date.now(),
				}),
			).toBeNull();
			await delivery.confirmAgentRaisedPendingUserDecisionAnswerHandled({
				workspaceId,
				decisionId: "task:question-call",
			});
			const readEvidence = vi.fn(async () => ({ state: "delivered" as const }));
			await reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
				workspaceId,
				decisionId: "task:question-call",
				force: true,
				readEvidence,
			});
			expect(readEvidence).not.toHaveBeenCalled();
			expect((await readAgentRaisedPendingUserDecisions(workspaceId))[0].answerDeliveryState).toBe(
				"delivery_unconfirmed",
			);
		});
	});
	it("遗留投递中记录以唯一 Queue 的已收敛回执核验执行归属，缺送达证据仍可人工关闭", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async () => ({
					status: "delivery_failed",
					reason: "submit_confirmation_budget_exhausted",
				}),
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			await editPersistedRecord(workspaceId, (record) => {
				record.answerDeliveryAttempts = undefined;
				record.answerDeliveryState = "delivery_in_progress";
			});
			const [legacy] = await readAgentRaisedPendingUserDecisions(workspaceId);
			if (!legacy.answer) throw new Error("缺少旧答案");
			const { handle } = await beginManagedTaskPromptDelivery({
				workspaceId,
				taskId: "task",
				text: buildAgentRaisedPendingUserDecisionAnswerMessage(legacy, legacy.answer),
				origin: { messageType: "user_decision_answer", sourceLabel: "task:question-call" },
			});
			await handle.settle({ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" });
			expect(
				(
					await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
						workspaceId,
						decisionId: "task:question-call",
					})
				)?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
			expect(
				await delivery.confirmAgentRaisedPendingUserDecisionAnswerHandled({
					workspaceId,
					decisionId: "task:question-call",
				}),
			).toMatchObject({ ok: true });
		});
	});

	it("原执行在提交阶段之前退出时恢复明确未发送，而不是授予未知提交重发资格", async () => {
		await withAnsweredQuestionScenario(async (workspaceId) => {
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async () => ({
					status: "delivery_failed",
					reason: "submit_confirmation_budget_exhausted",
				}),
			});
			await delivery.answerPendingUserDecision(answerRequest(workspaceId));
			await editPersistedRecord(workspaceId, (record) => {
				const attempt = record.answerDeliveryAttempts?.[0];
				if (!attempt) throw new Error("缺少尝试");
				record.answerDeliveryState = "delivery_in_progress";
				attempt.state = "delivery_in_progress";
				attempt.submissionPhase = "preparing_session";
				attempt.ownerRuntimeProcessInstanceId = randomUUID();
			});
			expect(
				(
					await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
						workspaceId,
						decisionId: "task:question-call",
					})
				)?.answerDeliveryState,
			).toBe("delivery_failed");
		});
	});
});
