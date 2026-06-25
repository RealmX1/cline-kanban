import type {
	RuntimeHookIngestResponse,
	RuntimeTaskSessionUserTurnKind,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { classifyHookUserTurnKind } from "../core/harness-user-turn-kind-collection";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "../core/session-activity";
import { logUserTurnKindCapture } from "../diagnostics/user-turn-kind-logger";
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

				const transitionedSummary =
					event === "to_review"
						? manager.transitionToReview(taskId, "hook", userTurnKindOverride ?? undefined)
						: manager.transitionToRunning(taskId);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					try {
						const checkpoint = await checkpointCapture({
							cwd: checkpointCwd,
							taskId,
							turn: nextTurn,
						});
						manager.applyTurnCheckpoint(taskId, checkpoint);
						if (staleRef) {
							void checkpointRefDelete({
								cwd: checkpointCwd,
								ref: staleRef,
							}).catch(() => {
								// Best effort cleanup only.
							});
						}
					} catch {
						// Best effort checkpointing only.
					}
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				if (event === "to_review") {
					// hook 终端路径恒广播。userTurnKind 取自刚落定的 transitionedSummary facet（经漏斗自洽，
					// hook 转审 reviewReason="hook" → review），随事件 payload 内联下发给前端通知标题（③(b)）。
					deps.broadcastTaskReadyForReview(
						workspaceId,
						taskId,
						resolveSessionFacets(transitionedSummary).userTurnKind,
					);
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
