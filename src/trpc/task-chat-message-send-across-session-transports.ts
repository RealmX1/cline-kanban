import type { TaskChatDeliveryWriteValidator } from "../core/task-chat-delivery-write-validation";
// 三条 session transport 的统一发送出口：ACP（stdio 子进程）/ Cline SDK（进程内）/ 终端 PTY。
//
// 从 `runtime-api.ts` 的 handler 里原样提出来，**不改任何行为**。抽取的唯一理由是调用方多了一类：
// 排队投递 dispatcher 由「agent 这一轮结束」的边沿驱动，手上没有 TRPC 请求，而 `createRuntimeApi`
// 是**每请求**新建的（`src/server/runtime-server.ts` 的 `createTrpcContext`）。要让 dispatcher 与
// 人类聊天、RVF followup 共用同一条投递语义，出口必须先从请求作用域里拿出来。

import type { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import type { ResolvedClineLaunchConfig } from "../cline-sdk/cline-provider-service";
import { isClineClearSlashCommand } from "../cline-sdk/cline-slash-commands";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { isRuntimeAgentSessionSummaryDrivenByAcpProtocol } from "../core/agent-catalog";
import type {
	RuntimeTaskChatMessage,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
} from "../core/api-contract";
import { terminalDeliveryReceiptSchema } from "../core/api-contract";
import { parseTaskChatSendRequest } from "../core/api-validation";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import {
	getTaskMessageInjectionLedgerPath,
	recordTaskMessageTerminalDeliveryOutcome,
} from "../core/task-message-injection-ledger";
import {
	NativeIndependentUserTurnDeliveryError,
	NativeIndependentUserTurnMessageAlreadyAccepted,
	NativeIndependentUserTurnSubmissionRecoverySuspended,
} from "../rvf-automatic-closeout/native-independent-user-turn-delivery-gate";
import { resolveRvfCloseoutCompactionConfirmationPersistence } from "../rvf-automatic-closeout/rvf-closeout-compaction-confirmation-persistence";
import {
	beginManagedTaskPromptDelivery,
	buildManagedTaskPromptDeliveryOrigin,
	settleManagedTaskPromptDeliveryWithoutBlocking,
} from "../state/managed-task-prompt-delivery-coordinator";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import type { TaskChatInputDeliveryOutcomeObserver, TerminalSessionManager } from "../terminal/session-manager";
import { stashTaskTerminalInputBoxIntoPromptLibrary } from "../terminal/stash-task-terminal-input-box-into-prompt-library";
import type { RuntimeTrpcWorkspaceScope } from "./app-router";

export interface SendTaskChatMessageAcrossSessionTransportsDependencies {
	// 真实 runtime 启用；裸 transport 单测不读写用户的持久工作区。
	recordManagedTaskPromptDeliveries?: boolean;
	managedTerminalDeliveryCancellationKey?: string;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	getScopedAcpTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<AcpTaskSessionService>;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	resolveClineTaskSessionLaunchConfig: () => Promise<ResolvedClineLaunchConfig>;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	// 进程内回执：PTY 分支同步只返回
	// accepted_pending_submit_confirmation，真实终态只经这个 observer 回来。排队投递 dispatcher 靠它
	// 把一条队列条目从 handed_to_transport 结算掉。它是函数级依赖，**不进**请求 schema——
	// 跨进程调用方（CLI）没有也不该有这个能力。
	onProgrammaticTerminalDeliverySettled?: TaskChatInputDeliveryOutcomeObserver;
	// 即时投递默认由出口回写账本；排队投递必须先在队列锁内核验当前尝试，再由存储层镜像有效终态。
	// 不能用锁外查询托管者代替此归属：查完后旧 transport 仍可能失去托管权。
	programmaticTerminalDeliveryReceiptPersistenceOwner?: "task_chat_transport" | "queued_task_prompt_delivery_store";
	// 任务级 CLI 回执仍按宿主卡寻址；实际投递可以是交接后的独立主会话。
	programmaticInjectionLedgerTaskId?: string;
	// 领域级投递授权在受理前与每次实际终端写入前重读，覆盖持久队列已交给 transport 的停止竞争。
	validateBeforeTerminalWrite?: TaskChatDeliveryWriteValidator;
}

function buildTerminalTaskChatDeliveryMessage(input: {
	taskId: string;
	text: string;
	source?: string;
	idempotencyKey?: string;
	promptSha256?: string;
}): RuntimeTaskChatMessage {
	const messageId = input.idempotencyKey
		? `terminal:${input.taskId}:${input.idempotencyKey}`
		: `terminal:${input.taskId}:${Date.now()}`;
	return {
		id: messageId,
		role: "user",
		content: input.text,
		createdAt: Date.now(),
		meta: {
			messageKind: "terminal-input",
			source: input.source ?? null,
			idempotencyKey: input.idempotencyKey ?? null,
			promptSha256: input.promptSha256 ?? null,
		},
	};
}

export async function sendTaskChatMessageAcrossSessionTransports(
	deps: SendTaskChatMessageAcrossSessionTransportsDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: RuntimeTaskChatSendRequest,
): Promise<RuntimeTaskChatSendResponse> {
	if (!deps.recordManagedTaskPromptDeliveries || isClineClearSlashCommand(input.text))
		return sendTaskChatMessageThroughSelectedTransport(deps, workspaceScope, input);
	try {
		parseTaskChatSendRequest(input);
		const acp = await deps.getScopedAcpTaskSessionService(workspaceScope);
		const terminal = await deps.getScopedTerminalManager(workspaceScope);
		const summary = acp.getSummary(input.taskId) ?? terminal.getSummary(input.taskId);
		const registration = await beginManagedTaskPromptDelivery({
			workspaceId: workspaceScope.workspaceId,
			taskId: input.taskId,
			workspaceTaskId: summary?.taskConversationSessionMetadata?.workspaceTaskId,
			text: input.text,
			origin: buildManagedTaskPromptDeliveryOrigin(input),
			deliveryRequestId: input.deliveryRequestId,
			idempotencyKey: input.idempotencyKey,
			injectionLedgerTaskId: deps.programmaticInjectionLedgerTaskId,
			imageAttachments: input.images,
			summary,
			cancellationSupported:
				summary != null &&
				!isRuntimeAgentSessionSummaryDrivenByAcpProtocol(summary) &&
				summary.sessionTransport !== "in_process_cline_sdk",
		});
		const { handle, entry } = registration;
		if (!registration.newlyRegistered)
			return {
				ok: entry.deliveryState !== "settled_failed" && entry.deliveryState !== "cancelled",
				deliveryId: handle.deliveryId,
				summary: summary ?? null,
				message: buildTerminalTaskChatDeliveryMessage(input),
				terminalDelivery: terminalDeliveryReceiptSchema.parse(
					entry.managedDelivery?.terminalDeliveryReceipt ?? {
						status: "accepted_pending_submit_confirmation",
						reason: null,
					},
				),
			};
		const response = await sendTaskChatMessageThroughSelectedTransport(
			{
				...deps,
				managedTerminalDeliveryCancellationKey: input.idempotencyKey ?? handle.deliveryId,
				onProgrammaticTerminalDeliverySettled: (outcome) => {
					try {
						deps.onProgrammaticTerminalDeliverySettled?.(outcome);
					} finally {
						settleManagedTaskPromptDeliveryWithoutBlocking(handle, outcome);
					}
				},
			},
			workspaceScope,
			input,
		);
		if (response.terminalDelivery && response.terminalDelivery.status !== "accepted_pending_submit_confirmation")
			await handle.settle(response.terminalDelivery).catch(() => undefined);
		else if (!response.ok)
			await handle
				.settle({ status: "delivery_failed", reason: "no_active_terminal_session" }, response.error)
				.catch(() => undefined);
		return { ...response, deliveryId: handle.deliveryId };
	} catch (error) {
		return { ok: false, summary: null, error: error instanceof Error ? error.message : String(error) };
	}
}

async function sendTaskChatMessageThroughSelectedTransport(
	deps: SendTaskChatMessageAcrossSessionTransportsDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: RuntimeTaskChatSendRequest,
): Promise<RuntimeTaskChatSendResponse> {
	try {
		const body = parseTaskChatSendRequest(input);
		const transportPersistsProgrammaticTerminalDeliveryReceipt =
			deps.programmaticTerminalDeliveryReceiptPersistenceOwner !== "queued_task_prompt_delivery_store";
		const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
		// 同 getTaskChatMessages：按活会话盖的通道章分派，而不是「账本里有没有 entry」。
		if (isRuntimeAgentSessionSummaryDrivenByAcpProtocol(acpTaskSessionService.getSummary(body.taskId))) {
			if (isClineClearSlashCommand(body.text)) {
				const clearedSummary = await acpTaskSessionService.clearTaskSession(body.taskId);
				deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
				return { ok: true, summary: clearedSummary, message: null };
			}
			await deps.validateBeforeTerminalWrite?.();
			const injectionIdempotencyKey = body.idempotencyKey ?? null;
			const injectionLedgerPath =
				injectionIdempotencyKey && transportPersistsProgrammaticTerminalDeliveryReceipt
					? getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceScope.workspaceId))
					: null;
			const observesAcceptance =
				injectionIdempotencyKey != null || deps.onProgrammaticTerminalDeliverySettled != null;
			const acpSummary = await acpTaskSessionService.sendTaskSessionInput(
				body.taskId,
				body.text,
				body.images,
				observesAcceptance
					? (accepted) => {
							const outcome = accepted
								? { status: "delivered_and_submit_confirmed" as const, reason: null }
								: {
										status: "delivery_failed" as const,
										reason: "submit_confirmation_budget_exhausted" as const,
									};
							if (injectionLedgerPath && injectionIdempotencyKey) {
								void recordTaskMessageTerminalDeliveryOutcome({
									ledgerPath: injectionLedgerPath,
									taskId: deps.programmaticInjectionLedgerTaskId ?? body.taskId,
									idempotencyKey: injectionIdempotencyKey,
									status: outcome.status,
									...(outcome.reason ? { failureReason: outcome.reason } : {}),
									nowIso: new Date().toISOString(),
								}).catch(() => {});
							}
							deps.onProgrammaticTerminalDeliverySettled?.(outcome);
						}
					: undefined,
				injectionIdempotencyKey ?? undefined,
			);
			if (acpSummary) {
				return {
					ok: true,
					summary: acpSummary,
					message: acpTaskSessionService.listMessages(body.taskId).at(-1) ?? null,
					...(observesAcceptance
						? {
								terminalDelivery: {
									status:
										acpSummary.agentConversationPromptSubmissionAcceptance?.status === "accepted"
											? ("delivered_and_submit_confirmed" as const)
											: ("accepted_pending_submit_confirmation" as const),
									reason: null,
								},
							}
						: {}),
				};
			}
			// 有会话账本但连接已经没了（会话被回收 / 子进程已退）：此刻确实没有活着的会话可投，
			// 如实落终态，别让调用方空等一个不会到来的确认。
			return {
				ok: false,
				summary: null,
				error: "The ACP agent session is not connected.",
				terminalDelivery: {
					status: "delivery_failed" as const,
					reason: "no_active_terminal_session" as const,
				},
			};
		}
		const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
		if (isClineClearSlashCommand(body.text)) {
			const summary = await clineTaskSessionService.clearTaskSession(body.taskId);
			deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
			return {
				ok: true,
				summary,
				message: null,
			};
		}
		const requestedMode = body.mode;
		const messageMeta = {
			source: body.source ?? null,
			idempotencyKey: body.idempotencyKey ?? null,
			promptSha256: body.promptSha256 ?? null,
		};
		const hasMessageMeta = Object.values(messageMeta).some((value) => value !== null);
		const sendClineTaskSessionInput = async () => {
			if (hasMessageMeta) {
				return await clineTaskSessionService.sendTaskSessionInput(
					body.taskId,
					body.text,
					requestedMode,
					body.images,
					messageMeta,
				);
			}
			return await clineTaskSessionService.sendTaskSessionInput(body.taskId, body.text, requestedMode, body.images);
		};
		let summary = await sendClineTaskSessionInput();
		if (!summary) {
			if (!isHomeAgentSessionId(body.taskId)) {
				const reboundSummary = await clineTaskSessionService.rebindPersistedTaskSession(body.taskId);
				if (reboundSummary) {
					summary = await sendClineTaskSessionInput();
				}
				if (!summary) {
					if (body.images && body.images.length > 0) {
						return {
							ok: false,
							summary: null,
							error: "Task chat images require an active Cline chat session.",
						};
					}
					const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
					// RVF followup 等程序化 chat 注入：经就绪门控投递（沉降 + 提示符就绪轮询 + deadline 兜底），
					// 避免 Stop 后 TUI 重绘态下「粘贴进输入框但 CR 被吞、不发送」的间歇竞态。详见 submitTaskChatInputWhenReady。
					// deferWhileUserTurn=（带 source 即后台自动注入）：后台注入遇会话处于非 agent 回合（agent 正等用户
					// 回答 AskUserQuestion / 计划评审 / 权限确认）时让位挂起、待 agent 回合恢复再投递，绝不把正等用户的
					// 会话经 UserPromptSubmit 翻回 agent 回合。用户发起的发送（人类聊天 / commit·openPR，无 source）不受影响。
					// 诚实回执登记：带 idempotencyKey 就意味着这条投递被记在账本里、有人在等它的真实结论。
					// runtime 在投递落定（或失败）后就地改写同一条记录——CLI 早已退出，这是唯一能把
					// 「pending → 终态」补上的地方。写账本失败不阻断会话：启动清扫会兜底判失败。
					const injectionIdempotencyKey = body.idempotencyKey ?? null;
					const injectionLedgerPath =
						injectionIdempotencyKey && transportPersistsProgrammaticTerminalDeliveryReceipt
							? getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceScope.workspaceId))
							: null;
					const observesProgrammaticDeliveryOutcome =
						(injectionLedgerPath != null && injectionIdempotencyKey != null) ||
						deps.onProgrammaticTerminalDeliverySettled != null;
					// 争用策略在受理这一刻读一次（一条投递最多活 ~196s，全程用同一份策略）。
					// 抢占执行者就是 Ctrl+S 那条链路本身，只是 origin 标成「被程序化投递抢占」，
					// 于是面板里能一眼看出这条是机器替人存的、并可一键恢复。
					// 只有 stashed_into_prompt_library（入库**且**框已清）才算抢占成功：
					// 「入库了但框没清」框里内容一个字没少，照写就会把 paste 接在人类那半句后面。
					const contentionPolicyConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
					try {
						await deps.validateBeforeTerminalWrite?.();
					} catch (error) {
						if (error instanceof NativeIndependentUserTurnSubmissionRecoverySuspended)
							return {
								ok: true,
								summary: null,
								terminalDelivery: { status: "accepted_pending_submit_confirmation", reason: null },
							};
						if (error instanceof NativeIndependentUserTurnMessageAlreadyAccepted)
							return {
								ok: true,
								summary: terminalManager.getSummary(body.taskId),
								message: buildTerminalTaskChatDeliveryMessage(body),
								terminalDelivery: { status: "delivered_and_submit_confirmed", reason: null },
							};
						const failureNote = error instanceof Error ? error.message : String(error);
						return {
							ok: false,
							summary: null,
							error: failureNote,
							terminalDelivery: {
								status: "delivery_failed",
								reason:
									error instanceof NativeIndependentUserTurnDeliveryError
										? error.reason
										: "cancelled_before_delivery",
								failureNote,
							},
						};
					}
					const targetTerminalSummary =
						body.source === "rvf_automatic_closeout" ? terminalManager.getSummary(body.taskId) : null;
					const rvfCloseoutCompactionConfirmationPersistence =
						body.source === "rvf_automatic_closeout" && injectionIdempotencyKey && targetTerminalSummary
							? await resolveRvfCloseoutCompactionConfirmationPersistence({
									workspaceId: workspaceScope.workspaceId,
									summary: targetTerminalSummary,
									idempotencyKey: injectionIdempotencyKey,
									promptText: body.text,
								})
							: null;
					const terminalSummary = terminalManager.submitTaskChatInputWhenReady(body.taskId, body.text, {
						...(rvfCloseoutCompactionConfirmationPersistence
							? { rvfCloseoutCompactionConfirmationPersistence }
							: {}),
						deferWhileUserTurn: body.source != null && body.source !== "task_main_session_handover",
						...(body.source === "task_main_session_handover" ? { requiresCodexStartupPromptReady: true } : {}),
						validateBeforeTerminalWrite: deps.validateBeforeTerminalWrite,
						idempotencyKey: injectionIdempotencyKey ?? deps.managedTerminalDeliveryCancellationKey,
						mayAutoStashAbsentHumanInputBox:
							contentionPolicyConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
						preemptivelyStashHumanInputBox: async (taskId) => {
							const stash = await stashTaskTerminalInputBoxIntoPromptLibrary(
								{
									getTerminalSessionManagerForWorkspace: async () =>
										await deps.getScopedTerminalManager(workspaceScope),
								},
								{
									workspaceId: workspaceScope.workspaceId,
									taskId,
									scope: "task",
									initiatedBy: "programmatic_delivery_contention_preemption",
								},
							);
							// 同 answerPendingUserDecision 那条抢占路径：outcome 原样回传，判「成没成」由 manager 做
							// （只有 stashed_into_prompt_library 算成功）。折成布尔会同时弄丢「瞬态失败值得再等一拍」
							// 与「确定性失败再等也是同一句话」的区分，以及日志里的真实判据。
							return stash.outcome;
						},
						// 即时投递并联回写账本与进程内回执；排队投递只通知 dispatcher，由它在队列锁内核验当前
						// 托管尝试后落定，再镜像账本。旧 transport 迟到回执不能抢先写入不可覆盖的账本终态。
						...(observesProgrammaticDeliveryOutcome
							? {
									onDeliveryOutcome: (outcome) => {
										if (injectionLedgerPath && injectionIdempotencyKey) {
											void recordTaskMessageTerminalDeliveryOutcome({
												ledgerPath: injectionLedgerPath,
												taskId: deps.programmaticInjectionLedgerTaskId ?? body.taskId,
												idempotencyKey: injectionIdempotencyKey,
												status: outcome.status,
												...(outcome.reason ? { failureReason: outcome.reason } : {}),
												...(outcome.failureNote ? { failureDetail: outcome.failureNote } : {}),
												...(outcome.codexNativePromptDeliveryEvidence
													? {
															codexNativePromptDeliveryEvidence:
																outcome.codexNativePromptDeliveryEvidence,
														}
													: {}),
												nowIso: new Date().toISOString(),
											}).catch(() => {
												// 账本写失败不影响会话本身；仍 pending 的记录由 runtime 启动清扫兜底判失败。
											});
										}
										deps.onProgrammaticTerminalDeliverySettled?.(outcome);
									},
								}
							: {}),
					});
					if (terminalSummary) {
						return {
							ok: true,
							summary: terminalSummary,
							terminalDelivery: {
								status: "accepted_pending_submit_confirmation" as const,
								reason: null,
							},
							message: buildTerminalTaskChatDeliveryMessage({
								taskId: body.taskId,
								text: body.text,
								source: body.source,
								idempotencyKey: body.idempotencyKey,
								promptSha256: body.promptSha256,
							}),
						};
					}
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
						terminalDelivery: {
							status: "delivery_failed" as const,
							reason: "no_active_terminal_session" as const,
						},
					};
				}
			} else {
				const clineLaunchConfig = await deps.resolveClineTaskSessionLaunchConfig();
				summary = await clineTaskSessionService.startTaskSession({
					taskId: body.taskId,
					cwd: workspaceScope.workspacePath,
					prompt: body.text,
					images: body.images,
					resumeFromPersistence: true,
					providerId: clineLaunchConfig.providerId,
					modelId: clineLaunchConfig.modelId,
					mode: requestedMode,
					apiKey: clineLaunchConfig.apiKey,
					baseUrl: clineLaunchConfig.baseUrl,
					reasoningEffort: clineLaunchConfig.reasoningEffort,
				});
			}
		}
		const latestMessage = clineTaskSessionService.listMessages(body.taskId).at(-1) ?? null;
		return {
			ok: true,
			summary,
			message: latestMessage,
			// Cline SDK 会话是进程内摄入：调到这里就说明消息已经进了会话，摄入本身是同步确认的，
			// 不存在 PTY 那种「粘进框但 CR 被吞」的失败形态，故直接给确认终态、无 pending 阶段。
			// 不报 queued_behind：那个区分描述的是「写进 TUI 输入框时 agent 正占着回合」，
			// 是终端通道特有的现象；SDK 侧队列由 runtime 自己持有，摄入即确认。
			...(body.idempotencyKey || deps.onProgrammaticTerminalDeliverySettled
				? {
						terminalDelivery: {
							status: "delivered_and_submit_confirmed" as const,
							reason: null,
						},
					}
				: {}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}
