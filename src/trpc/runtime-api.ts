// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed Cline, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import type { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import { listAvailableAgentSessions } from "../agent-session-history/available-agent-session-index";
import {
	salvageLatestUnansweredClaudeUserQuestionForTask,
	salvageLatestUnansweredCodexUserQuestionForKnownSession,
} from "../agent-session-history/pending-user-decision-transcript-salvage";
import { createClineMcpRuntimeService } from "../cline-sdk/cline-mcp-runtime-service";
import { createClineMcpSettingsService } from "../cline-sdk/cline-mcp-settings-service";
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import { isClineClearSlashCommand } from "../cline-sdk/cline-slash-commands";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import { getRuntimeAgentSessionTransport, isRuntimeAgentSessionDrivenByAcpProtocol } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorktreeMode,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseAnswerAgentRaisedPendingUserDecisionRequest,
	parseClineAccountSwitchRequest,
	parseClineAddProviderRequest,
	parseClineDeviceAuthCompleteRequest,
	parseClineMcpOAuthRequest,
	parseClineMcpSettingsSaveRequest,
	parseClineOauthLoginRequest,
	parseClineProviderModelsRequest,
	parseClineProviderSettingsSaveRequest,
	parseClineUpdateProviderRequest,
	parseCommandRunRequest,
	parseContinueConnectionRetrySessionsRequest,
	parseDismissConnectionRetrySessionsRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskAgentUserDecisionResolveRequest,
	parseTaskChatAbortRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatReloadRequest,
	parseTaskChatSendRequest,
	parseTaskIsParkedAwaitingDispatchedBackgroundWorkRequest,
	parseTaskParkAwaitingDispatchedBackgroundWorkRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
	parseTaskSessionTransitionToReviewRequest,
	parseTaskTerminalRefreshRequest,
	parseTaskUnparkAwaitingDispatchedBackgroundWorkRequest,
	parseTerminalAgentModelSelectionOptionsRequest,
} from "../core/api-validation";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { resolveSessionFacets } from "../core/session-activity";
import { resolveTaskAgentPermissionModeFromLegacyAutonomousFlag } from "../core/task-agent-permission-mode";
import { resolveTaskTitle } from "../core/task-title.js";
import {
	recordTaskSessionStartDiagnostic,
	type TaskSessionStartDiagnosticEvent,
} from "../diagnostics/task-session-start-diagnostics-logger";
import { createAgentRaisedPendingUserDecisionAnswerDelivery } from "../server/agent-raised-pending-user-decision-answer-delivery";
import { openInBrowser } from "../server/browser";
import {
	dismissAgentRaisedPendingUserDecision,
	isOpenAgentRaisedPendingUserDecision,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
	resolveAgentRaisedPendingUserDecisionOrderedQuestions,
} from "../state/agent-raised-pending-user-decision-store";
import { clearNotificationLog, markTaskNotificationsVisited } from "../state/notification-log-store";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { getTerminalAgentModelSelectionOptions } from "../terminal/terminal-agent-model-selection";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

// 老看板卡片没有 taskAgentPermissionMode。缺失时按「当时的全局 agentAutonomousModeEnabled」
// 推出等价档位，使升级前后行为不变——schema 层看不到 runtime config，兼容只能落在这里。
function resolveEffectiveTaskAgentPermissionMode(
	requestedTaskAgentPermissionMode: RuntimeTaskAgentPermissionMode | undefined,
	agentAutonomousModeEnabled: boolean,
): RuntimeTaskAgentPermissionMode {
	return (
		requestedTaskAgentPermissionMode ??
		resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(agentAutonomousModeEnabled)
	);
}

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	getScopedAcpTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<AcpTaskSessionService>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	broadcastClineMcpAuthStatusesUpdated?: (
		statuses: Awaited<ReturnType<ReturnType<typeof createClineMcpRuntimeService>["getAuthStatuses"]>>,
	) => void;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	broadcastNotificationLogUpdated?: (workspaceId: string) => Promise<void> | void;
	bumpClineSessionContextVersion?: () => void;
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
			worktreeMode: options.worktreeMode,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
			worktreeMode: options.worktreeMode,
		});
	}
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

const byTheWaySessionSupportedAgentIds: ReadonlySet<RuntimeAgentId> = new Set(["cline", "claude", "codex"]);

function isByTheWaySessionForWorkspaceTask(summary: RuntimeTaskSessionSummary, workspaceTaskId: string): boolean {
	const metadata = summary.taskConversationSessionMetadata;
	return metadata?.workspaceTaskId === workspaceTaskId && metadata.taskConversationSessionRole === "by_the_way";
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const clineProviderService = createClineProviderService();
	const clineMcpSettingsService = createClineMcpSettingsService();
	const clineMcpRuntimeService = createClineMcpRuntimeService({
		onAuthStatusesChanged: (statuses) => {
			deps.broadcastClineMcpAuthStatusesUpdated?.(statuses);
		},
	});
	const debugResetTargetPaths = [
		join(homedir(), ".cline", "data"),
		join(homedir(), ".cline", "kanban"),
		join(homedir(), ".cline", "worktrees"),
	] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) =>
		buildRuntimeConfigResponse(runtimeConfig, clineProviderService.getProviderSettingsSummary());

	const resumeTerminalTaskSessionForPendingUserDecisionAnswerDelivery = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<boolean> => {
		const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
		const resumedFromInMemoryRestartRequest =
			typeof terminalManager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery === "function"
				? await terminalManager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery(taskId)
				: false;
		if (resumedFromInMemoryRestartRequest) {
			return true;
		}
		// Kanban 完整重启后 entry.restartRequest 是纯内存态、必然丢失；从 durable board + runtime config
		// 重建与 refreshTaskTerminal 相同的续跑请求，使“已保存答案”不会永久卡在 delivery_failed。
		const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
		const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
		if (!card) {
			return false;
		}
		const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
		const effectiveAgentId =
			terminalManager.getSummary(taskId)?.agentId ?? card.agentId ?? scopedRuntimeConfig.selectedAgentId;
		if (effectiveAgentId === "cline" || isRuntimeAgentSessionDrivenByAcpProtocol(effectiveAgentId)) {
			return false;
		}
		const resolvedConfig =
			effectiveAgentId === scopedRuntimeConfig.selectedAgentId
				? scopedRuntimeConfig
				: { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId };
		const resolved = resolveAgentCommand(resolvedConfig);
		if (!resolved) {
			return false;
		}
		const taskCwd = isHomeAgentSessionId(taskId)
			? workspaceScope.workspacePath
			: await resolveExistingTaskCwdOrEnsure({
					cwd: workspaceScope.workspacePath,
					taskId,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
				});
		const startedSummary = await terminalManager.startTaskSession({
			taskId,
			agentId: resolved.agentId,
			binary: resolved.binary,
			args: resolved.args,
			taskAgentPermissionMode: resolveEffectiveTaskAgentPermissionMode(
				card.taskAgentPermissionMode,
				scopedRuntimeConfig.agentAutonomousModeEnabled,
			),
			autoContinueOnConnectionDropEnabled: scopedRuntimeConfig.autoContinueOnConnectionDropEnabled,
			cwd: taskCwd,
			prompt: "",
			images: undefined,
			startInPlanMode: undefined,
			resumeFromTrash: true,
			workspaceId: workspaceScope.workspaceId,
			projectPath: workspaceScope.workspacePath,
			parentSessionId: undefined,
			taskAgentSessionInitialization: undefined,
			terminalAgentModelOverrideSettings:
				card.terminalAgentModelOverrideSettings?.agentId === resolved.agentId
					? card.terminalAgentModelOverrideSettings
					: undefined,
		});
		return startedSummary.pid != null;
	};

	return {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return buildConfigResponse(nextRuntimeConfig);
		},
		saveClineProviderSettings: async (_workspaceScope, input) => {
			const body = parseClineProviderSettingsSaveRequest(input);
			const response = clineProviderService.saveProviderSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		addClineProvider: async (_workspaceScope, input) => {
			const body = parseClineAddProviderRequest(input);
			const response = await clineProviderService.addCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		updateClineProvider: async (_workspaceScope, input) => {
			const body = parseClineUpdateProviderRequest(input);
			const response = await clineProviderService.updateCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		startTaskSession: async (workspaceScope, input) => {
			const startRequestReceivedAt = Date.now();
			let diagnosticTaskId = "(unparsed)";
			let requestedAgentIdForDiagnostics: RuntimeAgentId | null = null;
			let effectiveAgentIdForDiagnostics: RuntimeAgentId | null = null;
			let startFailurePhase = "parse_request";
			let latestStartedSummaryForDiagnostics: RuntimeTaskSessionSummary | null = null;
			const recordStartDiagnostic = (
				event: TaskSessionStartDiagnosticEvent,
				phase: string,
				error: string | null = null,
			): void => {
				const summary = latestStartedSummaryForDiagnostics;
				const facets = summary ? resolveSessionFacets(summary) : null;
				void recordTaskSessionStartDiagnostic({
					event,
					workspaceId: workspaceScope.workspaceId,
					taskId: diagnosticTaskId,
					requestedAgentId: requestedAgentIdForDiagnostics,
					effectiveAgentId: effectiveAgentIdForDiagnostics,
					phase,
					elapsedMs: Date.now() - startRequestReceivedAt,
					error,
					session:
						summary && facets
							? {
									state: summary.state,
									turnOwner: facets.turnOwner,
									liveness: facets.liveness,
									pid: summary.pid,
									startedAt: summary.startedAt,
									updatedAt: summary.updatedAt,
								}
							: null,
				});
			};
			try {
				const body = parseTaskSessionStartRequest(input);
				diagnosticTaskId = body.taskId;
				requestedAgentIdForDiagnostics = body.agentId ?? null;
				if (body.resumeFromTrash) {
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
				}
				startFailurePhase = "load_scoped_runtime_config";
				const requestedClineTaskMode = body.mode ?? "act";
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const workspaceTaskId = body.workspaceTaskId ?? body.taskId;
				startFailurePhase = "resolve_or_ensure_task_working_directory";
				const taskCwd = isHomeAgentSessionId(body.taskId)
					? workspaceScope.workspacePath
					: await resolveExistingTaskCwdOrEnsure({
							cwd: workspaceScope.workspacePath,
							taskId: workspaceTaskId,
							baseRef: body.baseRef,
							worktreeMode: body.worktreeMode,
						});
				const shouldCaptureTurnCheckpoint =
					!body.resumeFromTrash &&
					!isHomeAgentSessionId(body.taskId) &&
					body.taskConversationSessionMetadata?.taskConversationSessionRole !== "by_the_way";

				// Per-task config source-of-truth precedence:
				//
				// agentId resolution (which agent runtime to use):
				//   1. previousTerminalAgentId — persisted in the terminal session summary from
				//      the last run; ensures trash-restore resumes with the same agent runtime.
				//   2. body.agentId — the card's current per-task agent override.
				//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
				//
				// clineSettings (which LLM model and reasoning profile the Cline agent uses):
				//   Always taken from the card's current override object. There is no
				//   session-level persistence for these;
				//   if the user changes the model on the card, the next session launch
				//   (including trash-restore) uses the updated values.
				startFailurePhase = "resolve_terminal_session_manager";
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const previousTerminalAgentId = body.resumeFromTrash
					? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
					: null;
				const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
				effectiveAgentIdForDiagnostics = effectiveAgentId;
				startFailurePhase = "validate_task_conversation_session_request";
				const taskConversationSessionMetadata = body.taskConversationSessionMetadata;
				const isByTheWaySession = taskConversationSessionMetadata?.taskConversationSessionRole === "by_the_way";
				if (
					taskConversationSessionMetadata &&
					(taskConversationSessionMetadata.taskConversationSessionRole === "main") !==
						(taskConversationSessionMetadata.taskConversationSessionContextSource === "main")
				) {
					throw new Error("Task conversation session role and context source are inconsistent.");
				}
				if (
					isByTheWaySession &&
					(!body.workspaceTaskId ||
						taskConversationSessionMetadata.workspaceTaskId !== workspaceTaskId ||
						body.taskId === workspaceTaskId)
				) {
					throw new Error("By the way sessions require a distinct taskId and a matching workspaceTaskId.");
				}
				if (isByTheWaySession && !byTheWaySessionSupportedAgentIds.has(effectiveAgentId)) {
					throw new Error(`Agent "${effectiveAgentId}" does not support By the way sessions.`);
				}
				if (
					isByTheWaySession &&
					taskConversationSessionMetadata.taskConversationSessionContextSource === "forked_from_main_current_turn"
				) {
					startFailurePhase = "inspect_existing_task_conversation_sessions";
					const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const existingTaskConversationSessionSummaries = [
						...(typeof terminalManager.listSummaries === "function" ? terminalManager.listSummaries() : []),
						...(typeof clineTaskSessionService.listSummaries === "function"
							? clineTaskSessionService.listSummaries()
							: []),
					];
					if (
						existingTaskConversationSessionSummaries.some((summary) =>
							isByTheWaySessionForWorkspaceTask(summary, workspaceTaskId),
						)
					) {
						throw new Error(
							"Forking the current main session is unavailable after a By the way session already exists. Start from scratch instead.",
						);
					}
				}
				// ACP 会话（omp 等）既不是 PTY 终端 agent 也不是 Cline SDK，走自己的服务。
				if (isRuntimeAgentSessionDrivenByAcpProtocol(effectiveAgentId)) {
					startFailurePhase = "start_acp_runtime_session";
					const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
					const acpSummary = await acpTaskSessionService.startTaskSession({
						taskId: body.taskId,
						agentId: effectiveAgentId,
						cwd: taskCwd,
						prompt: body.prompt,
						taskTitle: body.taskTitle,
						images: body.images,
						permissionMode: resolveEffectiveTaskAgentPermissionMode(
							body.taskAgentPermissionMode,
							scopedRuntimeConfig.agentAutonomousModeEnabled,
						),
						startInPlanMode: body.startInPlanMode,
					});
					latestStartedSummaryForDiagnostics = acpSummary;
					recordStartDiagnostic("runtime_started", startFailurePhase);
					let nextAcpSummary = acpSummary;
					startFailurePhase = "capture_initial_turn_checkpoint";
					if (shouldCaptureTurnCheckpoint) {
						try {
							const nextTurn = (acpSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
							const checkpoint = await captureTaskTurnCheckpoint({
								cwd: taskCwd,
								taskId: body.taskId,
								turn: nextTurn,
							});
							nextAcpSummary = acpTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? acpSummary;
						} catch {
							// Best effort checkpointing only.
						}
					}
					latestStartedSummaryForDiagnostics = nextAcpSummary;
					recordStartDiagnostic("response_ready", "response_ready");
					return { ok: true, summary: nextAcpSummary };
				}

				let useClinePath = effectiveAgentId === "cline";
				const shouldProbePersistedClineSession =
					body.resumeFromTrash && !useClinePath && previousTerminalAgentId === null;
				if (shouldProbePersistedClineSession) {
					// If the terminal summary already has a concrete non-Cline agentId,
					// skip Cline persisted-session probing. That probe can cold-start the
					// Cline session host and adds multi-second latency to Codex restores.
					startFailurePhase = "probe_persisted_cline_session";
					const clineSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const persistedSession = await clineSessionService
						.rebindPersistedTaskSession(body.taskId)
						.catch(() => null);
					if (persistedSession) {
						useClinePath = true;
					}
				}

				if (useClinePath) {
					startFailurePhase = "resolve_cline_launch_config";
					const hasTaskLevelClineSettingsOverride = body.clineSettings !== undefined;
					const clineLaunchConfig = await clineProviderService.resolveLaunchConfig({
						providerIdOverride: body.clineSettings?.providerId ?? undefined,
						modelIdOverride: body.clineSettings?.modelId ?? undefined,
						...(hasTaskLevelClineSettingsOverride
							? {
									reasoningEffortOverride: body.clineSettings?.reasoningEffort ?? null,
								}
							: {}),
					});
					const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const resolvedClineTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
					const clineForkInitialMessages =
						body.taskConversationSessionMetadata?.taskConversationSessionContextSource ===
						"forked_from_main_current_turn"
							? await clineTaskSessionService.loadPersistedTaskSessionMessages(workspaceTaskId)
							: undefined;
					startFailurePhase = "start_in_process_cline_runtime_session";
					const summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						taskConversationSessionMetadata: body.taskConversationSessionMetadata,
						cwd: taskCwd,
						prompt: body.prompt,
						taskTitle: resolvedClineTitle.length > 0 ? resolvedClineTitle : undefined,
						initialMessages: clineForkInitialMessages,
						images: body.images,
						resumeFromTrash: body.resumeFromTrash,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						mode:
							body.taskConversationSessionMetadata?.taskConversationSessionRole === "by_the_way"
								? "plan"
								: requestedClineTaskMode,
						startInPlanMode: body.startInPlanMode,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
						reasoningEffort: clineLaunchConfig.reasoningEffort,
					});
					latestStartedSummaryForDiagnostics = summary;
					recordStartDiagnostic("runtime_started", startFailurePhase);

					let nextSummary = summary;
					startFailurePhase = "capture_initial_turn_checkpoint";
					if (shouldCaptureTurnCheckpoint) {
						try {
							const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
							const checkpoint = await captureTaskTurnCheckpoint({
								cwd: taskCwd,
								taskId: body.taskId,
								turn: nextTurn,
							});
							nextSummary = clineTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
						} catch {
							// Best effort checkpointing only.
						}
					}
					latestStartedSummaryForDiagnostics = nextSummary;
					recordStartDiagnostic("response_ready", "response_ready");

					return {
						ok: true,
						summary: nextSummary,
					};
				}

				const resolvedConfig =
					effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
						? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
						: scopedRuntimeConfig;
				const resolved = resolveAgentCommand(resolvedConfig);
				if (!resolved) {
					recordStartDiagnostic("failed", "resolve_agent_command", "No runnable agent command is configured.");
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				startFailurePhase = "start_pty_terminal_runtime_session";
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					workspaceTaskId,
					taskConversationSessionMetadata: body.taskConversationSessionMetadata,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					taskAgentPermissionMode: resolveEffectiveTaskAgentPermissionMode(
						body.taskAgentPermissionMode,
						scopedRuntimeConfig.agentAutonomousModeEnabled,
					),
					autoContinueOnConnectionDropEnabled: scopedRuntimeConfig.autoContinueOnConnectionDropEnabled,
					cwd: taskCwd,
					prompt: body.prompt,
					images: body.images,
					startInPlanMode: body.startInPlanMode,
					resumeFromTrash: body.resumeFromTrash,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
					projectPath: workspaceScope.workspacePath,
					parentSessionId: body.parentSessionId,
					taskAgentSessionInitialization: body.taskAgentSessionInitialization,
					terminalAgentModelOverrideSettings:
						body.terminalAgentModelOverrideSettings?.agentId === resolved.agentId
							? body.terminalAgentModelOverrideSettings
							: undefined,
				});
				latestStartedSummaryForDiagnostics = summary;
				recordStartDiagnostic("runtime_started", startFailurePhase);

				let nextSummary = summary;
				startFailurePhase = "capture_initial_turn_checkpoint";
				if (shouldCaptureTurnCheckpoint) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}
				latestStartedSummaryForDiagnostics = nextSummary;
				recordStartDiagnostic("response_ready", "response_ready");
				return {
					ok: true,
					summary: nextSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				recordStartDiagnostic("failed", startFailurePhase, message);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		refreshTaskTerminal: async (workspaceScope, input) => {
			try {
				const body = parseTaskTerminalRefreshRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const currentSummary = terminalManager.getSummary(body.taskId);
				if (!currentSummary) {
					return {
						ok: false,
						summary: null,
						error: "No terminal session to refresh.",
					};
				}
				if (currentSummary.agentId === null || currentSummary.agentId === "cline") {
					return {
						ok: false,
						summary: null,
						error: "Refresh is only available for active TUI terminal agents.",
					};
				}
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				let card: (typeof board.columns)[number]["cards"][number] | null = null;
				for (const column of board.columns) {
					const found = column.cards.find((entry) => entry.id === body.taskId);
					if (found) {
						card = found;
						break;
					}
				}
				if (!card) {
					return {
						ok: false,
						summary: null,
						error: "Card not found in the workspace board.",
					};
				}
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const effectiveAgentId = currentSummary.agentId ?? card.agentId ?? scopedRuntimeConfig.selectedAgentId;
				const resolvedConfig =
					effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
						? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
						: scopedRuntimeConfig;
				const resolved = resolveAgentCommand(resolvedConfig);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured.",
					};
				}
				const taskCwd = isHomeAgentSessionId(body.taskId)
					? workspaceScope.workspacePath
					: await resolveExistingTaskCwdOrEnsure({
							cwd: workspaceScope.workspacePath,
							taskId: body.taskId,
							baseRef: card.baseRef,
							worktreeMode: card.worktreeMode,
						});
				const summary = await terminalManager.refreshTaskTerminal({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					taskAgentPermissionMode: resolveEffectiveTaskAgentPermissionMode(
						card.taskAgentPermissionMode,
						scopedRuntimeConfig.agentAutonomousModeEnabled,
					),
					autoContinueOnConnectionDropEnabled: scopedRuntimeConfig.autoContinueOnConnectionDropEnabled,
					cwd: taskCwd,
					prompt: "",
					images: undefined,
					startInPlanMode: undefined,
					resumeFromTrash: true,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
					projectPath: workspaceScope.workspacePath,
					parentSessionId: undefined,
					taskAgentSessionInitialization: undefined,
					terminalAgentModelOverrideSettings:
						card.terminalAgentModelOverrideSettings?.agentId === resolved.agentId
							? card.terminalAgentModelOverrideSettings
							: undefined,
				});
				return {
					ok: true,
					summary,
					mode: "resume",
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				const acpStoppedSummary = await acpTaskSessionService.stopTaskSession(body.taskId);
				if (acpStoppedSummary) {
					return { ok: true, summary: acpStoppedSummary };
				}
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const relatedTaskConversationSessionIds = new Set<string>([body.taskId]);
				const clineTaskSessionSummaries =
					typeof clineTaskSessionService.listSummaries === "function"
						? clineTaskSessionService.listSummaries()
						: [];
				const terminalTaskSessionSummaries =
					typeof terminalManager.listSummaries === "function" ? terminalManager.listSummaries() : [];
				for (const summary of [...clineTaskSessionSummaries, ...terminalTaskSessionSummaries]) {
					if (summary.taskConversationSessionMetadata?.workspaceTaskId === body.taskId) {
						relatedTaskConversationSessionIds.add(summary.taskId);
					}
				}
				let summary: RuntimeTaskSessionSummary | null = null;
				for (const taskConversationSessionId of relatedTaskConversationSessionIds) {
					const clineSummary = await clineTaskSessionService.stopTaskSession(taskConversationSessionId);
					const terminalSummary = clineSummary ? null : terminalManager.stopTaskSession(taskConversationSessionId);
					if (taskConversationSessionId === body.taskId) {
						summary = clineSummary ?? terminalSummary ?? summary;
					}
				}
				return {
					ok: relatedTaskConversationSessionIds.size > 1 || Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		// 「agent 问了你一个问题」的 durable 账本读侧。刻意**不**读会话内存：提问它的那个进程可能
		// 早已被回收，UI 要呈现的正是「独立于会话存活」的那份记录。
		listAgentRaisedPendingUserDecisions: async (workspaceScope, input) => {
			let decisions = await readAgentRaisedPendingUserDecisions(workspaceScope.workspaceId);
			const taskId = input.taskId?.trim();
			const alreadyHasOpenDecisionForTask =
				taskId !== undefined &&
				decisions.some((decision) => decision.taskId === taskId && isOpenAgentRaisedPendingUserDecision(decision));
			if (taskId && !alreadyHasOpenDecisionForTask) {
				// 历史补录只在用户打开一个具体任务时触发。Claude 只查该 worktree 可直接寻址的目录；
				// Codex 只接受卡片已知的精确 session id，绝不为此跑全盘 rollout 内容扫描。
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
				if (card) {
					const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
					const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
					const agentId =
						terminalManager.getSummary(taskId)?.agentId ?? card.agentId ?? scopedRuntimeConfig.selectedAgentId;
					let taskCwd: string | null = null;
					try {
						taskCwd = isHomeAgentSessionId(taskId)
							? workspaceScope.workspacePath
							: await resolveTaskCwd({
									cwd: workspaceScope.workspacePath,
									taskId,
									baseRef: card.baseRef,
									ensure: false,
									worktreeMode: card.worktreeMode,
								});
					} catch {
						// Worktree 已不存在时不为了 salvage 重建它；这是只读、按需的保守恢复。
					}
					const knownSessionInitialization = card.taskAgentSessionInitialization;
					const salvaged =
						agentId === "claude" && taskCwd
							? await salvageLatestUnansweredClaudeUserQuestionForTask({
									workspacePath: taskCwd,
									...(knownSessionInitialization?.sourceAgentId === "claude"
										? { knownSessionId: knownSessionInitialization.sourceSessionId }
										: {}),
								})
							: agentId === "codex" && knownSessionInitialization?.sourceAgentId === "codex"
								? await salvageLatestUnansweredCodexUserQuestionForKnownSession({
										sessionId: knownSessionInitialization.sourceSessionId,
									})
								: null;
					if (salvaged) {
						const summary = terminalManager.getSummary(taskId);
						await recordAgentRaisedPendingUserDecision(workspaceScope.workspaceId, {
							decisionId: `${taskId}:${salvaged.payload.decisionSourceId}`,
							taskId,
							workspaceId: workspaceScope.workspaceId,
							agentId,
							sessionTransport: getRuntimeAgentSessionTransport(agentId),
							decisionKind: "ordinary_user_question",
							questionMarkdown: salvaged.payload.questionMarkdown,
							options: salvaged.payload.options,
							allowsFreeformAnswer: salvaged.payload.allowsFreeformAnswer,
							orderedQuestions: salvaged.payload.orderedQuestions,
							askedAt: salvaged.askedAt,
							graceDeadlineAt: summary?.agentSessionRuntimeReclamationEligibleAt ?? null,
							originRuntimeSessionIncarnationId: summary?.runtimeSessionIncarnationId ?? null,
							originTurnSequence: summary?.agentResponseGenerationTurnSequence ?? 0,
							sourceHarnessSignal: salvaged.sourceHarnessSignal,
						});
						decisions = await readAgentRaisedPendingUserDecisions(workspaceScope.workspaceId);
					}
				}
			}
			return {
				decisions: decisions
					.filter(
						(decision) =>
							isOpenAgentRaisedPendingUserDecision(decision) && (!taskId || decision.taskId === taskId),
					)
					.map((decision) => ({
						decisionId: decision.decisionId,
						taskId: decision.taskId,
						agentId: decision.agentId,
						decisionKind: decision.decisionKind,
						questionMarkdown: decision.questionMarkdown,
						options: decision.options,
						allowsFreeformAnswer: decision.allowsFreeformAnswer,
						orderedQuestions: resolveAgentRaisedPendingUserDecisionOrderedQuestions(decision),
						askedAt: decision.askedAt,
						reclaimedAt: decision.reclaimedAt,
						answerDeliveryState: decision.answerDeliveryState,
						lastAnswerDeliveryFailureReason: decision.lastAnswerDeliveryFailureReason,
					})),
			};
		},
		answerAgentRaisedPendingUserDecision: async (workspaceScope, input) => {
			try {
				const body = parseAnswerAgentRaisedPendingUserDecisionRequest(input);
				return await createAgentRaisedPendingUserDecisionAnswerDelivery({
					ensureTaskSessionReadyForDelivery: async ({ taskId, sessionTransport }) => {
						// 三种 transport 的「让会话回到可投递状态」手法不同；返回 false 表示恢复不了、
						// 这次投不出去（不是「答案丢了」——答案已经 durable 落库）。
						// 关键：**不能只看 summary 是否存在**。会话被回收后账本条目与 summary 原样保留
						// （回收只终止运行时），光看 summary 会得出「已就绪」的假结论，随后投递必然落空：
						// ACP 的 connection 已被摘除、终端的 entry.active 已置空、Cline 会话已 stop 且
						// 活体被写成 interrupted（sendTaskSessionInput 恰恰拒绝 interrupted）。
						// 故这里必须真的把运行时拉回来——这正是计划 §7.4 第 2 步。
						if (sessionTransport === "acp_stdio_subprocess") {
							const acpService = await deps.getScopedAcpTaskSessionService(workspaceScope);
							return await acpService.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery(taskId);
						}
						if (sessionTransport === "in_process_cline_sdk") {
							const clineService = await deps.getScopedClineTaskSessionService(workspaceScope);
							const reboundSummary = await clineService.rebindPersistedTaskSession(taskId);
							if (!reboundSummary) {
								return false;
							}
							if (resolveSessionFacets(reboundSummary).liveness !== "interrupted") {
								return true;
							}
							// 被回收 / 被中断的 Cline 会话：reloadTaskSession 是既有的「停掉残留会话并用空
							// prompt 重新起一个」路径（reloadTaskChatSession 用的同一条），跑完活体不再是
							// interrupted，sendTaskSessionInput 才会受理。
							const reloadedSummary = await clineService.reloadTaskSession(taskId);
							return (
								reloadedSummary !== null && resolveSessionFacets(reloadedSummary).liveness !== "interrupted"
							);
						}
						return await resumeTerminalTaskSessionForPendingUserDecisionAnswerDelivery(workspaceScope, taskId);
					},
					deliverTaskSessionInput: async ({ taskId, sessionTransport, text }) => {
						if (sessionTransport === "acp_stdio_subprocess") {
							const acpService = await deps.getScopedAcpTaskSessionService(workspaceScope);
							return (await acpService.sendTaskSessionInput(taskId, text)) !== null;
						}
						if (sessionTransport === "in_process_cline_sdk") {
							const clineService = await deps.getScopedClineTaskSessionService(workspaceScope);
							return (await clineService.sendTaskSessionInput(taskId, text)) !== null;
						}
						// 终端 agent：必须在 ensureTaskSessionReadyForDelivery 之后排队，并等待明确的 PTY
						// write completion；同步 synthetic summary 只表示「已受理」，不能据此把 durable
						// 答案标成 delivered。退出/停止/被更晚投递取代时 completion=false，现有重试链会接管。
						const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
						const queuedDelivery = terminalManager.submitTaskChatInputWhenReadyWithPtyWriteCompletion(
							taskId,
							text,
						);
						return queuedDelivery ? await queuedDelivery.writtenToPty : false;
					},
				}).answerPendingUserDecision({
					workspaceId: workspaceScope.workspaceId,
					decisionId: body.decisionId,
					selectedOptionIds: body.selectedOptionIds,
					freeformText: body.freeformText,
					...(body.orderedQuestionAnswers ? { orderedQuestionAnswers: body.orderedQuestionAnswers } : {}),
				});
			} catch (error) {
				return { ok: false, delivered: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		dismissAgentRaisedPendingUserDecision: async (workspaceScope, input) => {
			try {
				const decisionId = input.decisionId.trim();
				if (!decisionId) {
					return { ok: false, error: "decisionId is required" };
				}
				const dismissed = await dismissAgentRaisedPendingUserDecision(
					workspaceScope.workspaceId,
					decisionId,
					Date.now(),
				);
				return dismissed
					? { ok: true }
					: { ok: false, error: `Pending decision "${decisionId}" cannot be dismissed` };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		transitionTaskToReview: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionTransitionToReviewRequest(input);
				// 仅终端 agent（claude/codex）会卡在 agent 回合 / 拖 Review 被打回；Cline SDK 在进程内自报完成、
				// 不经此入口。故只路由到 scoped terminal manager；非终端任务 → null summary → ok:false。
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.transitionToReview(body.taskId, "manual_review");
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		continueConnectionRetrySessions: async (workspaceScope, input) => {
			try {
				const body = parseContinueConnectionRetrySessionsRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const triggeredTaskIds = terminalManager.continueConnectionRetrySessions(body.taskIds);
				return {
					ok: true,
					triggeredTaskIds,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					triggeredTaskIds: [],
					error: message,
				};
			}
		},
		dismissConnectionRetrySessions: async (workspaceScope, input) => {
			try {
				const body = parseDismissConnectionRetrySessionsRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const dismissedTaskIds = terminalManager.dismissConnectionRetrySessions(body.taskIds);
				return {
					ok: true,
					dismissedTaskIds,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					dismissedTaskIds: [],
					error: message,
				};
			}
		},
		parkTaskAwaitingDispatchedBackgroundWork: async (workspaceScope, input) => {
			try {
				const body = parseTaskParkAwaitingDispatchedBackgroundWorkRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const result = terminalManager.parkTaskSessionAwaitingDispatchedBackgroundWork(body.taskId, {
					label: body.label,
				});
				if (!result.ok) {
					return { ok: false, summary: null, error: result.error };
				}
				return { ok: true, summary: result.summary };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, summary: null, error: message };
			}
		},
		unparkTaskAwaitingDispatchedBackgroundWork: async (workspaceScope, input) => {
			try {
				const body = parseTaskUnparkAwaitingDispatchedBackgroundWorkRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.unparkTaskSession(body.taskId);
				return { ok: Boolean(summary), summary };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, summary: null, error: message };
			}
		},
		isTaskParkedAwaitingDispatchedBackgroundWork: async (workspaceScope, input) => {
			try {
				const body = parseTaskIsParkedAwaitingDispatchedBackgroundWorkRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const state = terminalManager.getAwaitingDispatchedBackgroundWork(body.taskId);
				return { ok: true, parked: state.parked, label: state.label, sinceMs: state.sinceMs };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, parked: false, label: null, sinceMs: null, error: message };
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.sendTaskSessionInput(body.taskId, payloadText);
				if (clineSummary) {
					return {
						ok: true,
						summary: clineSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getTaskChatMessages: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatMessagesRequest(input);
				// ACP 会话与 Cline 会话共用同一条聊天通道；先问 ACP（它对非 ACP 任务返回空），再回落 Cline。
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				if (acpTaskSessionService.getSummary(body.taskId)) {
					return { ok: true, messages: acpTaskSessionService.listMessages(body.taskId) };
				}
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = clineTaskSessionService.getSummary(body.taskId);
				const messages = await clineTaskSessionService.loadTaskSessionMessages(body.taskId);
				if (!summary && messages.length === 0) {
					return {
						ok: false,
						messages: [],
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					messages,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					messages: [],
					error: message,
				};
			}
		},
		getClineSlashCommands: async (workspaceScope) => {
			if (!workspaceScope) {
				return {
					commands: [],
				};
			}
			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			return {
				commands: await clineTaskSessionService.listSlashCommands(workspaceScope.workspacePath),
			};
		},
		reloadTaskChatSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatReloadRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				let summary = await clineTaskSessionService.reloadTaskSession(body.taskId);
				if (!summary && isHomeAgentSessionId(body.taskId)) {
					const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
					summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: workspaceScope.workspacePath,
						prompt: "",
						resumeFromPersistence: true,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
						reasoningEffort: clineLaunchConfig.reasoningEffort,
					});
				}
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		abortTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatAbortRequest(input);
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				const acpSummary = await acpTaskSessionService.abortTaskSession(body.taskId);
				if (acpSummary) {
					return { ok: true, summary: acpSummary };
				}
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.abortTaskSession(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		resolveTaskAgentUserDecision: async (workspaceScope, input) => {
			try {
				const body = parseTaskAgentUserDecisionResolveRequest(input);
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				const resolved = acpTaskSessionService.resolveUserDecision(body.taskId, body.decisionId, {
					outcome: body.outcome,
					optionId: body.optionId ?? null,
				});
				if (!resolved) {
					return { ok: false, error: "This request is no longer waiting for a decision." };
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		cancelTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatCancelRequest(input);
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				const acpSummary = await acpTaskSessionService.cancelTaskTurn(body.taskId);
				if (acpSummary) {
					return { ok: true, summary: acpSummary };
				}
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.cancelTaskTurn(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session turn is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getClineProviderCatalog: async (_workspaceScope) => {
			return await clineProviderService.getProviderCatalog();
		},
		getClineAccountProfile: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountProfile();
		},
		getClineKanbanAccess: async (_workspaceScope) => {
			return await clineProviderService.getClineKanbanAccess();
		},
		getFeaturebaseToken: async (_workspaceScope) => {
			return await clineProviderService.getFeaturebaseToken();
		},
		getClineAccountBalance: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountBalance();
		},
		getClineAccountOrganizations: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountOrganizations();
		},
		switchClineAccount: async (_workspaceScope, input) => {
			const body = parseClineAccountSwitchRequest(input);
			return await clineProviderService.switchClineAccount(body.organizationId);
		},
		getClineProviderModels: async (_workspaceScope, input) => {
			const body = parseClineProviderModelsRequest(input);
			return await clineProviderService.getProviderModels(body.providerId);
		},
		getTerminalAgentModelSelectionOptions: async (_workspaceScope, input) => {
			const body = parseTerminalAgentModelSelectionOptionsRequest(input);
			return await getTerminalAgentModelSelectionOptions(body.agentId);
		},
		getAvailableAgentSessions: async (workspaceScope, input) => {
			if (!workspaceScope) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Select a workspace before searching agent sessions.",
				});
			}
			return await listAvailableAgentSessions(workspaceScope.workspacePath, input);
		},
		getClineMcpAuthStatuses: async (_workspaceScope) => {
			const statuses = await clineMcpRuntimeService.getAuthStatuses();
			return {
				statuses,
			};
		},
		runClineMcpServerOAuth: async (_workspaceScope, input) => {
			const body = parseClineMcpOAuthRequest(input);
			const response = await clineMcpRuntimeService.authorizeServer({
				serverName: body.serverName,
				onAuthorizationUrl: (url: string) => {
					openInBrowser(url);
				},
			});
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		getClineMcpSettings: async (_workspaceScope) => {
			return clineMcpSettingsService.loadSettings();
		},
		saveClineMcpSettings: async (_workspaceScope, input) => {
			const body = parseClineMcpSettingsSaveRequest(input);
			const response = await clineMcpSettingsService.saveSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		runClineProviderOAuthLogin: async (_workspaceScope, input) => {
			const body = parseClineOauthLoginRequest(input);
			const response = await clineProviderService.runOauthLogin({
				providerId: body.provider,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		startClineDeviceAuth: async () => {
			return await clineProviderService.startDeviceAuth();
		},
		completeClineDeviceAuth: async (_workspaceScope, input) => {
			const body = parseClineDeviceAuthCompleteRequest(input);
			const response = await clineProviderService.completeDeviceAuth({
				deviceCode: body.deviceCode,
				expiresInSeconds: body.expiresInSeconds,
				pollIntervalSeconds: body.pollIntervalSeconds,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		sendTaskChatMessage: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatSendRequest(input);
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				if (acpTaskSessionService.getSummary(body.taskId)) {
					if (isClineClearSlashCommand(body.text)) {
						const clearedSummary = await acpTaskSessionService.clearTaskSession(body.taskId);
						deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
						return { ok: true, summary: clearedSummary, message: null };
					}
					const acpSummary = await acpTaskSessionService.sendTaskSessionInput(body.taskId, body.text, body.images);
					if (acpSummary) {
						return {
							ok: true,
							summary: acpSummary,
							message: acpTaskSessionService.listMessages(body.taskId).at(-1) ?? null,
						};
					}
					return { ok: false, summary: null, error: "The ACP agent session is not connected." };
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
					return await clineTaskSessionService.sendTaskSessionInput(
						body.taskId,
						body.text,
						requestedMode,
						body.images,
					);
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
							const terminalSummary = terminalManager.submitTaskChatInputWhenReady(body.taskId, body.text, {
								deferWhileUserTurn: body.source != null,
							});
							if (terminalSummary) {
								return {
									ok: true,
									summary: terminalSummary,
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
							};
						}
					} else {
						const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
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
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
							...(body.worktreeMode ? { worktreeMode: body.worktreeMode } : {}),
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		getUpdateStatus: async () => {
			return deps.getUpdateStatus();
		},
		runUpdateNow: async () => {
			return await deps.runUpdateNow();
		},
		// 通知中心 mutation：跨 repo，用 input.workspaceId（非连接 scope）。落库后重建 feed 全局广播。
		markTaskNotificationsVisited: async (_workspaceScope, input) => {
			await markTaskNotificationsVisited(input.workspaceId, input.taskId, Date.now());
			await deps.broadcastNotificationLogUpdated?.(input.workspaceId);
			return { ok: true };
		},
		clearNotificationLog: async (_workspaceScope, input) => {
			await clearNotificationLog(input.workspaceId);
			await deps.broadcastNotificationLogUpdated?.(input.workspaceId);
			return { ok: true };
		},
	};
}
