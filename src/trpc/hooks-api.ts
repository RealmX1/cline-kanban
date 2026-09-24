import { resolveRuntimeAgentSessionTransportFromSummary } from "../core/agent-catalog";
import type {
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import {
	formatDeferredHarnessGeneratedPromptsAsAdditionalContext,
	isClaudeHarnessGeneratedTaskNotificationPrompt,
	isTaskNotificationOrphanedByPreviousAgentSessionIncarnation,
} from "../core/harness-generated-restoration-prompt";
import { classifyHookUserTurnKind } from "../core/harness-user-turn-kind-collection";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "../core/session-activity";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import { logUserTurnKindCapture } from "../diagnostics/user-turn-kind-logger";
import type { NotificationAssessmentInput } from "../notifications/notification-assessment-service";
import { getNotificationLifecycleArchive } from "../notifications/notification-lifecycle-archive";
import {
	captureNotificationSignal,
	recordNotificationSignalDecision,
} from "../notifications/notification-signal-capture";
import { recordAgentRaisedPendingUserDecision } from "../state/agent-raised-pending-user-decision-store";
import {
	consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
	deferHarnessGeneratedPromptDuringAgentSessionRestoration,
} from "../state/restoration-deferred-harness-generated-prompt-store";
import {
	loadWorkspaceContextById,
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";
import { canTransitionTaskForHookEvent } from "./hook-event-task-transition-gate";

export interface CreateHooksApiDependencies {
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId?: typeof persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId;
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (
		workspaceId: string,
		taskId: string,
		userTurnKind: RuntimeTaskSessionUserTurnKind,
		evidence?: Pick<NotificationAssessmentInput, "candidateId" | "summary" | "finalMessage">,
	) => void;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	// exploration thread graph 维护的 Stop 边沿出口（B.2）。可选：未接线时整条链路静默缺席，
	// hook 行为零差异。绝不返回 Promise——判图会 fork 一个分身，不能压进 hook 的响应关键路径。
	notifyExplorationThreadGraphAgentTurnStopped?: (input: { workspaceId: string; explorationId: string }) => void;
	recordAgentRaisedPendingUserDecision?: typeof recordAgentRaisedPendingUserDecision;
	deferHarnessGeneratedPromptDuringAgentSessionRestoration?: typeof deferHarnessGeneratedPromptDuringAgentSessionRestoration;
	consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration?: typeof consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration;
}

// 把 hook 携带的白名单决策 payload 投影成 durable 记录。二者互斥，且**没有 plan_review**——
// 计划审批不做 carry-forward，它在 store 的 decisionKind 枚举里根本不存在（类型层面杜绝冒充）。
async function recordAgentRaisedPendingUserDecisionFromHookIngest(input: {
	workspaceId: string;
	taskId: string;
	summary: RuntimeTaskSessionSummary;
	body: RuntimeHookIngestRequest;
	recordDecision: typeof recordAgentRaisedPendingUserDecision;
}): Promise<void> {
	const { workspaceId, taskId, summary, body, recordDecision } = input;
	const agentId = summary.agentId;
	if (agentId === null) {
		return;
	}
	const shared = {
		taskId,
		workspaceId,
		agentId,
		// 快照的是**这条会话当刻在用的通道**，不是该 agent 的默认通道：omp 可在 TUI ⇄ ACP 之间切换，
		// 按 agentId 派生会把决策按错误的通道投递回去。
		sessionTransport: resolveRuntimeAgentSessionTransportFromSummary(summary),
		askedAt: Date.now(),
		graceDeadlineAt: summary.agentSessionRuntimeReclamationEligibleAt ?? null,
		originRuntimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
		originTurnSequence: summary.agentResponseGenerationTurnSequence ?? 0,
	};
	const question = body.agentRaisedUserQuestion;
	if (question) {
		await recordDecision(workspaceId, {
			...shared,
			decisionId: `${taskId}:${question.decisionSourceId}`,
			decisionKind: "ordinary_user_question",
			questionMarkdown: question.questionMarkdown,
			options: question.options,
			allowsFreeformAnswer: question.allowsFreeformAnswer,
			orderedQuestions: question.orderedQuestions,
			sourceHarnessSignal: `${body.metadata?.source ?? "unknown"}:AskUserQuestion`,
		});
		return;
	}
	const permission = body.agentRaisedToolPermission;
	if (permission) {
		await recordDecision(workspaceId, {
			...shared,
			decisionId: `${taskId}:${permission.decisionSourceId}`,
			decisionKind: "tool_permission_request",
			// 只渲染工具名与参数摘要——参数正文可能含命令行 / 路径 / 密钥，绝不落盘。
			questionMarkdown: permission.toolInputSummary
				? `agent 请求使用工具 \`${permission.toolName}\`\n\n${permission.toolInputSummary}`
				: `agent 请求使用工具 \`${permission.toolName}\``,
			options: [
				{ optionId: "allow", label: "允许" },
				{ optionId: "deny", label: "拒绝" },
			],
			allowsFreeformAnswer: true,
			orderedQuestions: [
				{
					decisionQuestionId: "question-0",
					headerMarkdown: "工具授权",
					questionMarkdown: permission.toolInputSummary
						? `agent 请求使用工具 \`${permission.toolName}\`\n\n${permission.toolInputSummary}`
						: `agent 请求使用工具 \`${permission.toolName}\``,
					selectionMode: "single",
					options: [
						{ optionId: "allow", label: "允许" },
						{ optionId: "deny", label: "拒绝" },
					],
					allowsFreeformAnswer: true,
				},
			],
			sourceHarnessSignal: `${body.metadata?.source ?? "unknown"}:PermissionRequest`,
		});
	}
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const persistNativeConversationIdentity =
		deps.persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId ??
		persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId;
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const pendingUserDecisionRecord = deps.recordAgentRaisedPendingUserDecision ?? recordAgentRaisedPendingUserDecision;
	const restorationHarnessPromptDefer =
		deps.deferHarnessGeneratedPromptDuringAgentSessionRestoration ??
		deferHarnessGeneratedPromptDuringAgentSessionRestoration;
	const restorationHarnessPromptsConsume =
		deps.consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration ??
		consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration;

	return {
		ingest: async (input) => {
			let notificationCandidateId: string | null = null;
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				if (event === "to_review" || body.notificationCandidateId)
					notificationCandidateId = await captureNotificationSignal({
						candidateId: body.notificationCandidateId,
						workspaceId,
						taskId,
						sourceKind: "hook_runtime_received",
						rawPayload: body,
					});
				await recordNotificationSignalDecision(notificationCandidateId, "hook_ingest_received", { event });
				let hookNotificationAlreadyProcessed = false;
				if (notificationCandidateId) {
					const lifecycle = await getNotificationLifecycleArchive().get(notificationCandidateId);
					if (
						lifecycle &&
						["eligible", "evaluating", "deferred", "published", "superseded"].includes(
							lifecycle.candidate.notificationProcessingStatus,
						)
					) {
						hookNotificationAlreadyProcessed = true;
						if (!body.agentNativeConversationSessionIdentity) {
							await recordNotificationSignalDecision(notificationCandidateId, "hook_retry_deduplicated", {});
							return { ok: true } satisfies RuntimeHookIngestResponse;
						}
					}
				}
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					await recordNotificationSignalDecision(notificationCandidateId, "workspace_not_found", {}, true);
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					await recordNotificationSignalDecision(notificationCandidateId, "session_not_found", {}, true);
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				// 身份先落盘再确认 hook；内存已更新但保存失败时，下次仍须比较磁盘并重试。
				let nativeIdentityPersistenceError: Error | null = null;
				if (body.agentNativeConversationSessionIdentity) {
					try {
						if (body.agentNativeConversationSessionIdentity.sourceAgentId !== summary.agentId) {
							throw new Error(`Native conversation identity does not match session "${taskId}".`);
						}
						manager.applyAgentNativeConversationSessionIdentity(
							taskId,
							body.agentNativeConversationSessionIdentity,
						);
						const saved = await persistNativeConversationIdentity(workspaceId, taskId, () =>
							manager.getSummary(taskId),
						);
						if (saved) {
							void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
						}
					} catch (error) {
						nativeIdentityPersistenceError = error instanceof Error ? error : new Error(String(error));
						logAgentSessionRetentionWarning(
							`native-conversation-identity-persist-failed workspaceId=${workspaceId} taskId=${taskId} reason=${nativeIdentityPersistenceError.message}`,
						);
					}
				}
				// 持久化失败也不能绕过恢复通知的 block；失败响应必须保留原有的 harness 指令。
				const identityPersistenceResponse = nativeIdentityPersistenceError
					? { ok: false, error: nativeIdentityPersistenceError.message }
					: { ok: true };

				const normalizedHookEventName = body.metadata?.hookEventName?.trim().toLowerCase() ?? "";
				const isClaudeUserPromptSubmit =
					event === "to_in_progress" &&
					body.metadata?.source?.trim().toLowerCase() === "claude" &&
					normalizedHookEventName === "userpromptsubmit";
				// 两档判定，别混为一谈：
				//   - isClaudeHarnessGeneratedTaskNotification：任何 <task-notification> 包裹都**不是真人提交**，
				//     故它既不解除恢复守卫、也不消费暂存账本（否则 harness 自己的通知就能把守卫顶开）。
				//   - isRestorationOrphanTaskNotification：其中只有「上一活体遗留的孤儿」才真的拦下来暂存。
				//     本活体自己 dispatch 的子 agent / 后台命令完成通知照常放行——那是 agent 在等的唤醒信号。
				const isClaudeHarnessGeneratedTaskNotification =
					isClaudeUserPromptSubmit && isClaudeHarnessGeneratedTaskNotificationPrompt(body.submittedPromptText);
				const isRestorationOrphanTaskNotification =
					isClaudeUserPromptSubmit &&
					isTaskNotificationOrphanedByPreviousAgentSessionIncarnation(body.submittedPromptText);
				let deferredHarnessNotificationsAdditionalContext: string | undefined;
				const isRestorationHarnessGeneratedTaskNotificationInterceptionActive =
					isClaudeUserPromptSubmit &&
					(manager.isRestorationHarnessGeneratedTaskNotificationInterceptionActive?.(taskId) ??
						manager.isRestorationContinuationGuardArmed?.(taskId)) === true;
				if (
					isRestorationHarnessGeneratedTaskNotificationInterceptionActive &&
					isRestorationOrphanTaskNotification
				) {
					try {
						// 同步 durable 写成功之后才准许 hook 返回 block；先回响应再 fire-and-forget 会在 daemon
						// 随即退出/重启时永久丢通知。正文只进专用账本，不进 summary/activity/诊断日志。
						await restorationHarnessPromptDefer({
							workspaceId,
							taskId,
							sourceHarness: "claude:UserPromptSubmit:task-notification",
							promptText: body.submittedPromptText ?? "",
							receivedAt: Date.now(),
						});
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						logAgentSessionRetentionWarning(
							`restoration-harness-prompt-persist-failed workspaceId=${workspaceId} taskId=${taskId} reason=${reason}`,
						);
						// Claude 对普通非 2 退出码会 fail-open。身份落盘失败时可返回 ok:false，但仍携带 block；
						// CLI 保留指令并退出 0，拦截已确认的 harness 通知；只牺牲这条无法安全持久化的通知，
						// 绝不把它放进模型并意外启动新回合。
						return {
							...identityPersistenceResponse,
							harnessUserPromptProcessingDirective: {
								processingDecision: "block_and_defer_until_explicit_user_input",
								userVisibleReason:
									"Kanban 正在恢复旧会话；系统任务通知暂存失败，已安全拦截，未启动新的 agent 回合。",
							},
						} satisfies RuntimeHookIngestResponse;
					}
					return {
						...identityPersistenceResponse,
						harnessUserPromptProcessingDirective: {
							processingDecision: "block_and_defer_until_explicit_user_input",
							userVisibleReason: "Kanban 正在恢复旧会话；这条系统任务通知已暂存，不会自动启动新的 agent 回合。",
						},
					} satisfies RuntimeHookIngestResponse;
				}
				if (
					isRestorationHarnessGeneratedTaskNotificationInterceptionActive &&
					(body.submittedPromptText === undefined || body.submittedPromptText.trim().length === 0)
				) {
					// Claude 官方 UserPromptSubmit 输入必带 prompt。恢复窗口里若字段缺失，就无法证明它是
					// 真人输入；只拦这条畸形事件并保留守卫，普通非空真人 prompt 继续走下方 allow 路径。
					return {
						...identityPersistenceResponse,
						harnessUserPromptProcessingDirective: {
							processingDecision: "block_and_defer_until_explicit_user_input",
							userVisibleReason: "Kanban 正在恢复旧会话；无法确认这条空输入是否来自用户，已保留恢复守卫。",
						},
					} satisfies RuntimeHookIngestResponse;
				}
				if (nativeIdentityPersistenceError) {
					throw nativeIdentityPersistenceError;
				}
				if (hookNotificationAlreadyProcessed) {
					await recordNotificationSignalDecision(notificationCandidateId, "hook_retry_deduplicated", {});
					return { ok: true } satisfies RuntimeHookIngestResponse;
				}
				// 恢复守卫的解除**必须**在 canTransitionTaskForHookEvent 之前完成。历史上它只挂在下方
				// transitionToRunning(userInitiatedResume) 上，而那一步位于转移闸之后：会话一旦被任意一次
				// PostToolUse 推进 running（Claude 以 --continue 接回后自己继续干活就会发），后续真人
				// UserPromptSubmit 的 to_in_progress 便再也过不了闸（闸要求 awaiting_review + reviewReason
				// 落在放行集），守卫从此永久武装。B 档拦截随之一起卡死——completeRestoration…() 见主守卫仍
				// 武装就 no-op。实测 2026-08 有 79/185 条会话记录停在武装态、其中 38 条已无任何解除路径，
				// agent 自己 dispatch 的后台工作唤醒信号被无限期吞掉。闸后解除是这个死锁的唯一成因。
				const isExplicitUserTurnStartHookEvent =
					event === "to_in_progress" &&
					(normalizedHookEventName === "userpromptsubmit" || normalizedHookEventName === "beforeagent");
				if (isExplicitUserTurnStartHookEvent && !isClaudeHarnessGeneratedTaskNotification) {
					manager.disarmRestorationContinuationGuard?.(taskId);
				}
				if (isClaudeUserPromptSubmit && !isClaudeHarnessGeneratedTaskNotification) {
					try {
						// 迟到通知可能在真人恢复首轮进行期间才被拦截；因此每个真人 Claude prompt 都尝试
						// 原子取出 durable 通知，而不只限于广义恢复守卫仍武装的那一瞬间。
						const deferredHarnessNotifications = await restorationHarnessPromptsConsume({ workspaceId, taskId });
						deferredHarnessNotificationsAdditionalContext =
							formatDeferredHarnessGeneratedPromptsAsAdditionalContext(deferredHarnessNotifications);
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						logAgentSessionRetentionWarning(
							`restoration-harness-prompts-consume-failed workspaceId=${workspaceId} taskId=${taskId} reason=${reason}`,
						);
						// 读取暂存上下文失败不能阻塞真人输入；账本未消费，下一次真人 prompt 会重试。
					}
				}

				// Claude（终端 agent）采集增强：必须在 parked gate **之前**完成分类。parked 只抑制裸
				// Stop；AskUserQuestion / ExitPlanMode / PermissionRequest 都是明确的人轴边界，不能随裸 Stop
				// 一起被吞掉，否则重启后既没有 userTurnKind，也没有 durable decision 可以阻止误续跑。
				let userTurnKindOverride: RuntimeTaskSessionUserTurnKind | null = null;
				if (event === "to_review") {
					userTurnKindOverride = classifyHookUserTurnKind(body.metadata);
					if (userTurnKindOverride !== null) {
						logUserTurnKindCapture({
							taskId,
							agentId: summary.agentId,
							source: body.metadata?.source ?? null,
							rawSignal:
								body.metadata?.toolName ??
								body.metadata?.hookEventName ??
								body.metadata?.notificationType ??
								null,
							resolvedKind: userTurnKindOverride,
						});
					}
				}

				// 决策记录同样先于 gate 且同步完成；hook 进程只有在 durable 写成功后才收到成功响应。
				// 失败返回可重试错误，避免 daemon 在 fire-and-forget 写入前退出造成永久丢题。
				if (body.agentRaisedUserQuestion || body.agentRaisedToolPermission) {
					try {
						await recordAgentRaisedPendingUserDecisionFromHookIngest({
							workspaceId,
							taskId,
							summary,
							body,
							recordDecision: pendingUserDecisionRecord,
						});
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						logAgentSessionRetentionWarning(
							`pending-user-decision-persist-failed workspaceId=${workspaceId} taskId=${taskId} reason=${reason}`,
						);
						return { ok: false, error: reason } satisfies RuntimeHookIngestResponse;
					}
				}

				// parked 会话收到「用户重新提交了一个 prompt」（UserPromptSubmit → to_in_progress）即视为恢复：清 park。
				// 仅认 UserPromptSubmit（真·新一轮提交），不认 PostToolUse / PostToolUseFailure 等同样映射到 to_in_progress
				// 的中途活动——否则 parked 父在结束本轮前的任意工具调用会把 park 误清、随后的裸 Stop 又误报。
				// submitTaskChatInputWhenReady 已覆盖 RVF 程序化 resume；本路径额外覆盖人工在终端手敲 followup 的恢复
				// （hookEventName 由 `kanban hooks` CLI 从 hook stdin 的 hook_event_name 抽出，见 normalizeHookMetadata）。
				if (
					event === "to_in_progress" &&
					isParkedAwaitingDispatchedBackgroundWork(summary) &&
					body.metadata?.hookEventName?.trim().toLowerCase() === "userpromptsubmit"
				) {
					manager.unparkTaskSession(taskId);
				}
				if (
					event === "to_review" &&
					userTurnKindOverride !== null &&
					isParkedAwaitingDispatchedBackgroundWork(summary)
				) {
					manager.unparkTaskSession(taskId);
				}

				// 「对话上次推进」的低延迟前进信号。**只认 agent 侧事件**：
				//   - activity（PostToolUse 等中途活动）与 to_review（Stop / 回合结束）⇒ agent 确实又往前走了一步。
				//   - to_in_progress（UserPromptSubmit / BeforeAgent）⇒ 说话的是**用户**，绝不推进；把它算进来
				//     就等于让用户自己的输入刷新「agent 上次回复」，正是本次要根治的那类错误。
				// 放在转移门之前：activity 事件通常过不了 canTransitionTaskForHookEvent（它不改变列状态），
				// 但它同样是货真价实的 agent 推进证据，不能因为「没换列」就丢掉。
				const isAgentSideConversationProgressHookEvent = event === "activity" || event === "to_review";
				if (isAgentSideConversationProgressHookEvent) {
					manager.recordAgentLifecycleHookConversationProgress(taskId);
				}
				if (
					event === "to_review" &&
					body.metadata?.source?.trim().toLowerCase() === "claude" &&
					normalizedHookEventName === "stop"
				) {
					// 仅自然 Stop 证明真人恢复后的首轮已经结束；PermissionRequest / AskUserQuestion 等
					// 中途人轴事件不能提前放掉迟到通知拦截。主守卫（A 档）仍武装即「显式用户回合尚未开始」，
					// 这条 Stop 只可能来自恢复过程自身，方法会保持 no-op——否则真人 prompt 随后在转移闸前
					// 解除 A 时两档全空，「真人首轮已开始、尚未 Stop」那段窗口的迟到孤儿会直接穿透。
					manager.completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn?.(taskId);
				}

				if (!canTransitionTaskForHookEvent(summary, event, userTurnKindOverride)) {
					await recordNotificationSignalDecision(
						notificationCandidateId,
						"hook_transition_gate_excluded",
						{ summary, event, userTurnKindOverride },
						true,
					);
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return {
						ok: true,
						...(deferredHarnessNotificationsAdditionalContext
							? {
									harnessUserPromptProcessingDirective: {
										processingDecision: "allow" as const,
										additionalContextMarkdown: deferredHarnessNotificationsAdditionalContext,
									},
								}
							: {}),
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review" && userTurnKindOverride === null) {
					// expected-but-absent：识别到 claude 的更细人轴信号（permission 字样，或带 toolName 的工具驱动
					// to_review——如 Claude 改名后的 plan/question 工具仍被未锚定的 matcher 部分命中）却未精确匹配
					// 已知模式 → 记 unclassified，让线上数据暴露 harness 信号漂移。不刷普适四种（Stop 等无
					// toolName、无 permission 字样的常规 to_review 不触发）。
					const sourceLc = body.metadata?.source?.trim().toLowerCase() ?? null;
					const rawHook = body.metadata?.hookEventName?.trim().toLowerCase() ?? null;
					const rawNotif = body.metadata?.notificationType?.trim().toLowerCase() ?? null;
					const rawTool = body.metadata?.toolName?.trim() ?? "";
					if (
						sourceLc === "claude" &&
						(rawHook?.includes("permission") || rawNotif?.includes("permission") || rawTool.length > 0)
					) {
						logUserTurnKindCapture({
							taskId,
							agentId: summary.agentId,
							source: body.metadata?.source ?? null,
							rawSignal:
								body.metadata?.toolName ??
								body.metadata?.hookEventName ??
								body.metadata?.notificationType ??
								null,
							resolvedKind: "unclassified",
						});
					}
				}

				// resume substantive guard 只认「一轮用户提交」驱动的 to_in_progress 作为解除信号：
				// Claude/Codex/Droid 的 UserPromptSubmit + Gemini 的 BeforeAgent（二者在 hooks.ts inferActivityText
				// 与 mapGeminiHookEvent 里等价视为「用户提交、agent 开始新一轮」）。不认 PostToolUse / PostToolUseFailure
				// 等自动续跑中途活动（与上方 park 解除同一区分）。Gemini 经 task-chat 恢复走 paste 路径不过 writeInput，
				// 故必须靠本 hook 信号解除 guard，否则全 TUI 武装后 Gemini 的 lastSubstantiveOutputAt 会永久冻结。
				const resumeContinueHookEventName = normalizedHookEventName;
				const userInitiatedResume =
					event === "to_in_progress" &&
					(resumeContinueHookEventName === "userpromptsubmit" || resumeContinueHookEventName === "beforeagent");
				const transitionedSummary =
					event === "to_review"
						? manager.transitionToReview(taskId, "hook", userTurnKindOverride ?? undefined)
						: manager.transitionToRunning(taskId, { userInitiatedResume });
				if (!transitionedSummary) {
					await recordNotificationSignalDecision(notificationCandidateId, "hook_transition_failed", {}, true);
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);

				if (
					event === "to_review" &&
					body.metadata?.source?.trim().toLowerCase() === "claude" &&
					normalizedHookEventName === "stop"
				) {
					// exploration thread graph 维护的 Stop 边沿（B.2）。判据与上面「迟到通知拦截解除」同源
					// （source=claude + hookEventName=stop），**只认自然 Stop**：`to_review` 同样承载
					// PermissionRequest / AskUserQuestion / ExitPlanMode 这类「agent 停下来等人拍板」的中途
					// 人轴信号，那一刻这一轮根本还没结束。用户在权限框/提问框上想得比防抖窗口（45s）久，
					// 光判 event 就会让触发器拿 treatFinalTurnAsCompleted:true 的 turn 源去 fork：既白烧一次
					// 判定（≈$4.5，成因见 docs/exploratory-mode-host-integration.md §3b），又把半截 turn 当作
					// 已完成轮次归位进图。图只对 Claude 终端会话建模（turn 源与分身执行器都是 Claude Code
					// 专用），故 source 闸不是额外收紧，而是本来的适用域。
					// **by-the-way 会话同样要触发**——它的 turn 一样要归位，只是 explorationId 要解析回主任务
					// 卡片（图挂在卡片上，不挂在单条会话上）。所以这一块刻意放在下面那道 by_the_way 守卫
					// **之外**：那道守卫是给「转审通知 + checkpoint」用的，与图无关。
					// 触发器自带四道闸（模式 / 防抖 / 单飞 / 节流），这里只负责把「刚有一个 turn 结束了」
					// 这个事实交出去，不判断、不等待。
					const explorationId = transitionedSummary.taskConversationSessionMetadata?.workspaceTaskId ?? taskId;
					deps.notifyExplorationThreadGraphAgentTurnStopped?.({ workspaceId, explorationId });
				}

				if (transitionedSummary.taskConversationSessionMetadata?.taskConversationSessionRole === "by_the_way")
					await recordNotificationSignalDecision(
						notificationCandidateId,
						"by_the_way_notification_excluded",
						{},
						true,
					);
				if (
					event === "to_review" &&
					transitionedSummary.taskConversationSessionMetadata?.taskConversationSessionRole !== "by_the_way"
				) {
					// hook 终端路径恒广播。userTurnKind 取自刚落定的 transitionedSummary facet（经漏斗自洽，
					// hook 转审 reviewReason="hook" → review），随事件 payload 内联下发给前端通知标题（③(b)）。
					deps.broadcastTaskReadyForReview(
						workspaceId,
						taskId,
						resolveSessionFacets(transitionedSummary).userTurnKind,
						{
							candidateId: notificationCandidateId ?? undefined,
							summary: manager.getSummary(taskId) ?? transitionedSummary,
							finalMessage: body.metadata?.finalMessage ?? undefined,
						},
					);

					// F1：把 turn-checkpoint 的 git 工作移出 hook 客户端的响应关键路径。
					// 看板列状态在 transitionToReview 时即已落定、并随上面两条广播即时下发；checkpoint 仅为
					// UI 的 base-commit（fork-point）服务，对列状态毫无必要。旧版同步 await 它，会把 7 个 git
					// 子进程的耗时（大仓 / 慢盘 / 与 agent 抢 .git/index.lock 时轻松破 3s）整段压进 hook 客户端
					// 的硬超时窗口，触发误判超时 → fail-open 静默丢投。改为不 await 的后台任务：完成后
					// applyTurnCheckpoint 再补发一次 workspace-state 广播把 base-commit 推给 UI。沿用既有
					// best-effort try/catch——checkpoint 失败绝不回滚已落定的转审。
					// turn ref 保留策略（姊妹蓝图 §1.4）：任务存续期全量保留，这里只做捕获、不再轮换删旧
					// ref；批删挂在任务删除 / trash 清空路径（deleteAllTaskTurnCheckpointRefs）。
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					void (async () => {
						try {
							const checkpoint = await checkpointCapture({
								cwd: checkpointCwd,
								taskId,
								turn: nextTurn,
							});
							manager.applyTurnCheckpoint(taskId, checkpoint);
							await deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
						} catch {
							// Best effort checkpointing only.
						}
					})();
				}

				return {
					ok: true,
					...(deferredHarnessNotificationsAdditionalContext
						? {
								harnessUserPromptProcessingDirective: {
									processingDecision: "allow" as const,
									additionalContextMarkdown: deferredHarnessNotificationsAdditionalContext,
								},
							}
						: {}),
				} satisfies RuntimeHookIngestResponse;
			} catch (error) {
				await recordNotificationSignalDecision(notificationCandidateId, "hook_runtime_processing_failed", {}, true);
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
