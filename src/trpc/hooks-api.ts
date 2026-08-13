import { resolveRuntimeAgentSessionTransportFromSummary } from "../core/agent-catalog";
import type {
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { classifyHookUserTurnKind } from "../core/harness-user-turn-kind-collection";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "../core/session-activity";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import { logUserTurnKindCapture } from "../diagnostics/user-turn-kind-logger";
import { recordAgentRaisedPendingUserDecision } from "../state/agent-raised-pending-user-decision-store";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";
import { canTransitionTaskForHookEvent } from "./hook-event-task-transition-gate";

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (
		workspaceId: string,
		taskId: string,
		userTurnKind: RuntimeTaskSessionUserTurnKind,
	) => void;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
}

// 把 hook 携带的白名单决策 payload 投影成 durable 记录。二者互斥，且**没有 plan_review**——
// 计划审批不做 carry-forward，它在 store 的 decisionKind 枚举里根本不存在（类型层面杜绝冒充）。
async function recordAgentRaisedPendingUserDecisionFromHookIngest(input: {
	workspaceId: string;
	taskId: string;
	summary: RuntimeTaskSessionSummary;
	body: RuntimeHookIngestRequest;
}): Promise<void> {
	const { workspaceId, taskId, summary, body } = input;
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
		await recordAgentRaisedPendingUserDecision(workspaceId, {
			...shared,
			decisionId: `${taskId}:${question.decisionSourceId}`,
			decisionKind: "ordinary_user_question",
			questionMarkdown: question.questionMarkdown,
			options: question.options,
			allowsFreeformAnswer: question.allowsFreeformAnswer,
			sourceHarnessSignal: `${body.metadata?.source ?? "unknown"}:AskUserQuestion`,
		});
		return;
	}
	const permission = body.agentRaisedToolPermission;
	if (permission) {
		await recordAgentRaisedPendingUserDecision(workspaceId, {
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
			sourceHarnessSignal: `${body.metadata?.source ?? "unknown"}:PermissionRequest`,
		});
	}
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
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

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				// Claude（终端 agent）采集增强：to_review 时从 hook metadata 分类更细人轴（仅 source==="claude"）
				// ——permission（PermissionRequest / permission_prompt，B3）+ plan_review / question（ExitPlanMode /
				// AskUserQuestion 工具名，Stage 5），随 hook.to_review 经 reducer 完整 facet 三元组覆写人轴。
				let userTurnKindOverride: RuntimeTaskSessionUserTurnKind | null = null;
				if (event === "to_review") {
					userTurnKindOverride = classifyHookUserTurnKind(body.metadata);
					if (userTurnKindOverride !== null) {
						logUserTurnKindCapture({
							taskId,
							agentId: summary.agentId,
							source: body.metadata?.source ?? null,
							// 工具驱动的人轴（question/plan_review）以 toolName 为触发信号，permission 以
							// hookEventName/notificationType——优先 toolName 便于线上回溯触发因。
							rawSignal:
								body.metadata?.toolName ??
								body.metadata?.hookEventName ??
								body.metadata?.notificationType ??
								null,
							resolvedKind: userTurnKindOverride,
						});
					} else {
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
				}

				// resume substantive guard 只认「一轮用户提交」驱动的 to_in_progress 作为解除信号：
				// Claude/Codex/Droid 的 UserPromptSubmit + Gemini 的 BeforeAgent（二者在 hooks.ts inferActivityText
				// 与 mapGeminiHookEvent 里等价视为「用户提交、agent 开始新一轮」）。不认 PostToolUse / PostToolUseFailure
				// 等自动续跑中途活动（与上方 park 解除同一区分）。Gemini 经 task-chat 恢复走 paste 路径不过 writeInput，
				// 故必须靠本 hook 信号解除 guard，否则全 TUI 武装后 Gemini 的 lastSubstantiveOutputAt 会永久冻结。
				const resumeContinueHookEventName = body.metadata?.hookEventName?.trim().toLowerCase() ?? "";
				const userInitiatedResume =
					event === "to_in_progress" &&
					(resumeContinueHookEventName === "userpromptsubmit" || resumeContinueHookEventName === "beforeagent");
				const transitionedSummary =
					event === "to_review"
						? manager.transitionToReview(taskId, "hook", userTurnKindOverride ?? undefined)
						: manager.transitionToRunning(taskId, { userInitiatedResume });
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				// agent 停下来等人拍板 → 立刻把问题与结构化选项落 durable 账本（**在提问的那一刻**，
				// 不是等宽限期到期才落）。这样 crash / kill -9 / 断电、以及后续的会话回收，都不会让
				// 「agent 问了你什么」丢失；用户下次进入任务时由 UI 独立于会话进程重现。
				// 落库失败绝不回滚已落定的转审——carry-forward 是增强，不是 hook 投递的前置条件。
				void recordAgentRaisedPendingUserDecisionFromHookIngest({
					workspaceId,
					taskId,
					summary: transitionedSummary,
					body,
				}).catch((error: unknown) => {
					logAgentSessionRetentionWarning(
						`pending-user-decision-persist-failed workspaceId=${workspaceId} taskId=${taskId} reason=${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
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
					);

					// F1：把 turn-checkpoint 的 git 工作移出 hook 客户端的响应关键路径。
					// 看板列状态在 transitionToReview 时即已落定、并随上面两条广播即时下发；checkpoint 仅为
					// UI 的 base-commit（fork-point）服务，对列状态毫无必要。旧版同步 await 它，会把 7 个 git
					// 子进程的耗时（大仓 / 慢盘 / 与 agent 抢 .git/index.lock 时轻松破 3s）整段压进 hook 客户端
					// 的硬超时窗口，触发误判超时 → fail-open 静默丢投。改为不 await 的后台任务：完成后
					// applyTurnCheckpoint 再补发一次 workspace-state 广播把 base-commit 推给 UI，staleRef 清理
					// 挂在其后。沿用既有 best-effort try/catch——checkpoint 失败绝不回滚已落定的转审。
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					void (async () => {
						try {
							const checkpoint = await checkpointCapture({
								cwd: checkpointCwd,
								taskId,
								turn: nextTurn,
							});
							manager.applyTurnCheckpoint(taskId, checkpoint);
							await deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
							if (staleRef) {
								await checkpointRefDelete({
									cwd: checkpointCwd,
									ref: staleRef,
								}).catch(() => {
									// Best effort cleanup only.
								});
							}
						} catch {
							// Best effort checkpointing only.
						}
					})();
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
