import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AcpTaskSessionService } from "../../src/acp-client-session/acp-task-session-service";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../../src/core/task-message-injection-ledger";
import {
	type AgentRaisedPendingUserDecisionAnswerDeliveryDependencies,
	createAgentRaisedPendingUserDecisionAnswerDelivery,
} from "../../src/server/agent-raised-pending-user-decision-answer-delivery";
import { reconcilePendingUserDecisionAnswerDeliveriesForWorkspace } from "../../src/server/agent-raised-pending-user-decision-answer-delivery-reconciliation";
import { buildAgentRaisedPendingUserDecisionAnswerMessage } from "../../src/server/agent-raised-pending-user-decision-answer-message";
import {
	type PersistedAgentRaisedPendingUserDecision,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
} from "../../src/state/agent-raised-pending-user-decision-store";
import { beginManagedTaskPromptDelivery } from "../../src/state/managed-task-prompt-delivery-coordinator";
import { getWorkspaceDirectoryPath } from "../../src/state/workspace-state";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../src/trpc/runtime-api";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const decisionId = "task:question-first";
const answer = (workspaceId: string) => ({
	workspaceId,
	decisionId,
	selectedOptionIds: [],
	freeformText: "采用现有实现",
});
const unconfirmedReceipt = { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" } as const;

function createAcpSummary() {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "omp",
		sessionTransport: "acp_stdio_subprocess",
		workspacePath: "/isolated",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		lastHookAt: null,
		latestHookActivity: null,
		reviewReason: null,
		exitCode: null,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "omp",
			nativeSessionId: "native",
			transcriptPath: null,
			observedAt: 1,
		},
	});
}

async function editRecord(workspaceId: string, edit: (record: PersistedAgentRaisedPendingUserDecision) => void) {
	const path = join(getWorkspaceDirectoryPath(workspaceId), "agent-raised-pending-user-decisions.json");
	const records: PersistedAgentRaisedPendingUserDecision[] = JSON.parse(await readFile(path, "utf8"));
	edit(records[0]);
	await writeFile(path, JSON.stringify(records));
}

async function scenario(run: (workspaceId: string) => Promise<void>) {
	await withIsolatedWorkspaceHome(async (register) => {
		const { workspaceId } = await register("answer-review-regressions");
		await recordAgentRaisedPendingUserDecision(workspaceId, {
			decisionId,
			taskId: "task",
			workspaceId,
			agentId: "claude",
			sessionTransport: "pty_terminal",
			decisionKind: "ordinary_user_question",
			questionMarkdown: "选择方案",
			options: [],
			allowsFreeformAnswer: true,
			askedAt: Date.now(),
			graceDeadlineAt: null,
			originRuntimeSessionIncarnationId: null,
			originTurnSequence: 0,
			sourceHarnessSignal: "claude:AskUserQuestion",
		});
		await run(workspaceId);
	});
}

describe.sequential("RVF 问答边界回归", () => {
	it("同文的新问题答案不能关闭先前未确认的独立问题", async () => {
		await scenario(async (workspaceId) => {
			const path = join(getWorkspaceDirectoryPath(workspaceId), "native.jsonl");
			await writeFile(path, "");
			const submittedTexts: string[] = [];
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async (input) => {
					submittedTexts.push(input.text);
					const metadata = await stat(path);
					await input.persistSubmissionContext({
						targetNativeSessionId: "native",
						targetRuntimeSessionIncarnationId: "incarnation",
						transcriptPath: path,
						workingDirectoryPath: "/isolated",
						preSubmissionTranscriptByteOffset: metadata.size,
						preSubmissionTranscriptFileIdentity: `${metadata.dev}:${metadata.ino}`,
					});
					return unconfirmedReceipt;
				},
			});
			await delivery.answerPendingUserDecision(answer(workspaceId));
			const [first] = await readAgentRaisedPendingUserDecisions(workspaceId);
			await recordAgentRaisedPendingUserDecision(workspaceId, {
				...first,
				decisionId: "task:question-second",
				askedAt: Date.now(),
			});
			await delivery.answerPendingUserDecision({ ...answer(workspaceId), decisionId: "task:question-second" });
			await appendFile(
				path,
				`${JSON.stringify({ type: "user", promptSource: "typed", sessionId: "native", cwd: "/isolated", uuid: "second-question-input", timestamp: new Date().toISOString(), message: { role: "user", content: submittedTexts[1] } })}\n`,
			);
			expect(
				(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
					?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
			expect(submittedTexts[0]).not.toBe(submittedTexts[1]);
		});
	});

	it("Codex 同 inode 截短不能重置游标并认领提交前的同文记录", async () => {
		await scenario(async (workspaceId) => {
			await editRecord(workspaceId, (record) => {
				record.agentId = "codex";
			});
			const path = join(getWorkspaceDirectoryPath(workspaceId), "codex.jsonl");
			await writeFile(
				path,
				`${JSON.stringify({ type: "session_meta", payload: { id: "native", cwd: "/isolated", source: "cli" } })}\n`,
			);
			let submissionPosition = 0;
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				getSummary: () =>
					runtimeTaskSessionSummarySchema.parse({
						taskId: "task",
						agentId: "codex",
						workspacePath: "/isolated",
						pid: null,
						startedAt: 1,
						updatedAt: 1,
						lastOutputAt: null,
						lastHookAt: null,
						latestHookActivity: null,
						reviewReason: null,
						exitCode: null,
						turnOwner: "user",
						liveness: "interrupted",
						userTurnKind: "review",
					}),
				deliverTaskSessionInput: async (input) => {
					await appendFile(
						path,
						`${JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "item_completed", thread_id: "native", turn_id: "old-turn", item: { type: "UserMessage", id: "old-input", content: [{ type: "text", text: input.text }] } } })}\n`,
					);
					const metadata = await stat(path);
					submissionPosition = metadata.size;
					await input.persistSubmissionContext({
						targetNativeSessionId: "native",
						targetRuntimeSessionIncarnationId: "incarnation",
						transcriptPath: path,
						workingDirectoryPath: "/isolated",
						preSubmissionTranscriptByteOffset: metadata.size,
						preSubmissionTranscriptFileIdentity: `${metadata.dev}:${metadata.ino}`,
					});
					await appendFile(path, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`);
					return unconfirmedReceipt;
				},
			});
			await delivery.answerPendingUserDecision(answer(workspaceId));
			expect(
				(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
					?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
			await truncate(path, submissionPosition);
			expect(
				(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
					?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
		});
	});

	it("没有尝试标识的旧正文不能仅凭后来出现的同文消息认领送达", async () => {
		await scenario(async (workspaceId) => {
			const path = join(getWorkspaceDirectoryPath(workspaceId), "legacy-native.jsonl");
			await writeFile(path, "");
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async (input) => {
					const metadata = await stat(path);
					await input.persistSubmissionContext({
						targetNativeSessionId: "native",
						targetRuntimeSessionIncarnationId: "incarnation",
						transcriptPath: path,
						workingDirectoryPath: "/isolated",
						preSubmissionTranscriptByteOffset: 0,
						preSubmissionTranscriptFileIdentity: `${metadata.dev}:${metadata.ino}`,
					});
					return unconfirmedReceipt;
				},
			});
			await delivery.answerPendingUserDecision(answer(workspaceId));
			const [record] = await readAgentRaisedPendingUserDecisions(workspaceId);
			if (!record.answer) throw new Error("缺少答案");
			const legacyText = buildAgentRaisedPendingUserDecisionAnswerMessage(
				{ ...record, answerDeliveryAttempts: undefined },
				record.answer,
			);
			await editRecord(workspaceId, (current) => {
				const attempt = current.answerDeliveryAttempts?.[0];
				if (!attempt) throw new Error("缺少尝试");
				attempt.answerMessageFormatVersion = undefined;
				attempt.promptSha256 = createHash("sha256").update(legacyText).digest("hex");
			});
			await appendFile(
				path,
				`${JSON.stringify({ type: "user", promptSource: "typed", sessionId: "native", cwd: "/isolated", uuid: "another-question-input", timestamp: new Date().toISOString(), message: { role: "user", content: legacyText } })}\n`,
			);
			expect(
				(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
					?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
		});
	});

	it("旧投递没有 Queue 及执行归属时保留未知，仍可由用户确认处理", async () => {
		await scenario(async (workspaceId) => {
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async () => unconfirmedReceipt,
			});
			await delivery.answerPendingUserDecision(answer(workspaceId));
			await editRecord(workspaceId, (record) => {
				record.answerDeliveryAttempts = undefined;
				record.answerDeliveryState = "delivery_in_progress";
			});
			expect(
				(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
					?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
			expect(
				await delivery.confirmAgentRaisedPendingUserDecisionAnswerHandled({ workspaceId, decisionId }),
			).toMatchObject({ ok: true });
		});
	});

	it("旧 Codex 唯一成功回执中的原生证据沿决策会话匹配", async () => {
		await scenario(async (workspaceId) => {
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
				ensureTaskSessionReadyForDelivery: async () => true,
				deliverTaskSessionInput: async () => unconfirmedReceipt,
			});
			await delivery.answerPendingUserDecision(answer(workspaceId));
			await editRecord(workspaceId, (record) => {
				record.agentId = "codex";
				record.nativeConversationSessionId = "native";
				record.answerDeliveryAttempts = undefined;
			});
			const [legacy] = await readAgentRaisedPendingUserDecisions(workspaceId);
			if (!legacy.answer) throw new Error("缺少答案");
			const { handle } = await beginManagedTaskPromptDelivery({
				workspaceId,
				taskId: "task",
				text: buildAgentRaisedPendingUserDecisionAnswerMessage(legacy, legacy.answer),
				origin: { messageType: "user_decision_answer", sourceLabel: decisionId },
				summary: runtimeTaskSessionSummarySchema.parse({
					taskId: "task",
					agentId: "codex",
					workspacePath: "/isolated",
					pid: null,
					startedAt: 1,
					updatedAt: 1,
					lastOutputAt: null,
					lastHookAt: null,
					latestHookActivity: null,
					reviewReason: null,
					exitCode: null,
					turnOwner: "user",
					liveness: "interrupted",
					userTurnKind: "review",
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: "native",
						transcriptPath: null,
						observedAt: 1,
					},
				}),
			});
			await handle.settle({
				status: "delivered_and_submit_confirmed",
				reason: null,
				codexNativePromptDeliveryEvidence: {
					nativeSessionId: "native",
					clientUserMessageId: "client",
					nativeTurnId: "turn",
					nativeUserMessageId: "message",
				},
			});
			expect(
				(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
					?.answerDeliveryState,
			).toBe("delivered");
		});
	});

	it.each([
		{ reason: "no_active_terminal_session", submissionMayHaveStarted: undefined, expectedState: "delivery_failed" },
		{
			reason: "terminal_prompt_readiness_timeout",
			submissionMayHaveStarted: false,
			expectedState: "delivery_failed",
		},
		{
			reason: "terminal_prompt_readiness_timeout",
			submissionMayHaveStarted: true,
			expectedState: "delivery_unconfirmed",
		},
	] as const)(
		"原执行退出后按持久回执恢复，不用原因码覆盖写入阶段：$submissionMayHaveStarted",
		async ({ reason, submissionMayHaveStarted, expectedState }) => {
			await scenario(async (workspaceId) => {
				const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery({
					ensureTaskSessionReadyForDelivery: async () => true,
					deliverTaskSessionInput: async () => unconfirmedReceipt,
				});
				await delivery.answerPendingUserDecision(answer(workspaceId));
				const [record] = await readAgentRaisedPendingUserDecisions(workspaceId);
				const attempt = record.answerDeliveryAttempts?.[0];
				if (!attempt) throw new Error("缺少尝试");
				const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId));
				await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({
					records: [
						createPendingTaskMessageInjectionRecord({
							taskId: "task",
							attemptId: "task",
							source: "user_decision_answer",
							idempotencyKey: attempt.dispatchIdempotencyKey,
							promptSha256: attempt.promptSha256,
							nowIso: new Date().toISOString(),
						}),
					],
					result: null,
				}));
				await recordTaskMessageTerminalDeliveryOutcome({
					ledgerPath,
					taskId: "task",
					idempotencyKey: attempt.dispatchIdempotencyKey,
					status: "delivery_failed",
					failureReason: reason,
					submissionMayHaveStarted,
					nowIso: new Date().toISOString(),
				});
				await editRecord(workspaceId, (current) => {
					const latest = current.answerDeliveryAttempts?.[0];
					if (!latest) throw new Error("缺少尝试");
					latest.ownerRuntimeProcessInstanceId = randomUUID();
					latest.state = "delivery_in_progress";
					current.answerDeliveryState = "delivery_in_progress";
				});
				expect(
					(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
						?.answerDeliveryState,
				).toBe(expectedState);
			});
		},
	);

	it.each(["connection_unavailable", "request_busy"] as const)(
		"ACP API 的提交前拒绝保留 %s 原因和可重投资格",
		async (reason) => {
			await scenario(async (workspaceId) => {
				await editRecord(workspaceId, (record) => {
					record.agentId = "omp";
					record.sessionTransport = "acp_stdio_subprocess";
				});
				const summary = createAcpSummary();
				const acpService = {
					getSummary: () => summary,
					resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery: async () => true,
					sendTaskSessionInput: vi.fn(
						async (...parameters: Parameters<AcpTaskSessionService["sendTaskSessionInput"]>) => {
							parameters[5]?.(reason);
							if (reason === "request_busy") throw new Error("当前请求仍在处理");
							return null;
						},
					),
				};
				const runtime = createRuntimeApi({
					recordManagedTaskPromptDeliveries: true,
					getScopedTerminalManager: async () => ({ getSummary: () => null }),
					getScopedAcpTaskSessionService: async () => acpService,
				} as unknown as CreateRuntimeApiDependencies);
				const scope = { workspaceId, workspacePath: "/isolated" };
				expect(await runtime.answerAgentRaisedPendingUserDecision(scope, answer(workspaceId))).toMatchObject({
					ok: true,
					delivered: false,
				});
				const [record] = await readAgentRaisedPendingUserDecisions(workspaceId);
				expect(record.answerDeliveryState).toBe("delivery_failed");
				expect(record.answerDeliveryAttempts?.[0]).toMatchObject({
					targetNativeSessionId: "native",
					targetRuntimeSessionIncarnationId: "incarnation",
					originalReceipt: { submissionMayHaveStarted: false, failureNote: expect.stringContaining(reason) },
				});
				const [injection] = await readTaskMessageInjectionLedger(
					getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId)),
				);
				expect(injection.submission_may_have_started).toBe(false);
				expect(acpService.sendTaskSessionInput).toHaveBeenCalledOnce();
			});
		},
	);

	it.each(["manual", "task_open"] as const)("ACP API 超时后从所属服务补证迟到接受：%s", async (entryPoint) => {
		await scenario(async (workspaceId) => {
			await editRecord(workspaceId, (record) => {
				record.agentId = "omp";
				record.sessionTransport = "acp_stdio_subprocess";
			});
			const summary = createAcpSummary();
			const acpService = {
				getSummary: () => summary,
				resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery: async () => true,
				sendTaskSessionInput: vi.fn(
					async (...parameters: Parameters<AcpTaskSessionService["sendTaskSessionInput"]>) => {
						summary.agentConversationPromptSubmissionAcceptance = {
							status: "unconfirmed",
							attemptedAtMs: Date.now(),
							eventId: parameters[4],
							nativeSessionId: "native",
							runtimeSessionIncarnationId: "incarnation",
						};
						parameters[3]?.(false);
						return summary;
					},
				),
			};
			const runtime = createRuntimeApi({
				recordManagedTaskPromptDeliveries: true,
				getScopedTerminalManager: async () => ({ getSummary: () => null }),
				getScopedAcpTaskSessionService: async () => acpService,
			} as unknown as CreateRuntimeApiDependencies);
			const scope = { workspaceId, workspacePath: "/isolated" };
			await runtime.answerAgentRaisedPendingUserDecision(scope, answer(workspaceId));
			expect((await readAgentRaisedPendingUserDecisions(workspaceId))[0].answerDeliveryState).toBe(
				"delivery_unconfirmed",
			);
			if (!summary.agentConversationPromptSubmissionAcceptance) throw new Error("缺少接受身份");
			summary.agentConversationPromptSubmissionAcceptance.status = "accepted";
			if (entryPoint === "manual")
				await runtime.reconcileAgentRaisedPendingUserDecisionAnswerDelivery(scope, { decisionId });
			else await runtime.listAgentRaisedPendingUserDecisions(scope, { taskId: "task" });
			expect((await readAgentRaisedPendingUserDecisions(workspaceId))[0].answerDeliveryState).toBe("delivered");
			expect(acpService.sendTaskSessionInput).toHaveBeenCalledOnce();
		});
	});

	it("ACP 接受必须关联原尝试，迟到的同键成功可收敛", async () => {
		await scenario(async (workspaceId) => {
			await editRecord(workspaceId, (record) => {
				record.agentId = "omp";
				record.sessionTransport = "acp_stdio_subprocess";
			});
			let dispatchKey = "";
			const summary = createAcpSummary();
			const dependencies: AgentRaisedPendingUserDecisionAnswerDeliveryDependencies = {
				ensureTaskSessionReadyForDelivery: async () => true,
				getSummary: () => summary,
				deliverTaskSessionInput: async (input) => {
					dispatchKey = input.dispatchIdempotencyKey;
					await input.persistSubmissionContext({
						targetNativeSessionId: "native",
						targetRuntimeSessionIncarnationId: "incarnation",
					});
					return unconfirmedReceipt;
				},
			};
			const delivery = createAgentRaisedPendingUserDecisionAnswerDelivery(dependencies);
			await delivery.answerPendingUserDecision(answer(workspaceId));
			summary.agentConversationPromptSubmissionAcceptance = {
				status: "accepted",
				attemptedAtMs: Date.now(),
				runtimeSessionIncarnationId: "incarnation",
				nativeSessionId: "native",
				eventId: "other-request",
			};
			expect(
				(await delivery.reconcileAgentRaisedPendingUserDecisionAnswerDelivery({ workspaceId, decisionId }))
					?.answerDeliveryState,
			).toBe("delivery_unconfirmed");
			summary.agentConversationPromptSubmissionAcceptance.eventId = dispatchKey;
			await reconcilePendingUserDecisionAnswerDeliveriesForWorkspace({ workspaceId, getSummary: () => summary });
			expect((await readAgentRaisedPendingUserDecisions(workspaceId))[0].answerDeliveryState).toBe("delivered");
		});
	});
});
