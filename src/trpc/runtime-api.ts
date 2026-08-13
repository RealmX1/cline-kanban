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
	probePersistedAgentTranscriptLastConversationModelIdentity,
	supportsPersistedAgentTranscriptLastConversationModelProbe,
} from "../agent-session-history/persisted-agent-transcript-last-conversation-model-probe";
import { createClineMcpRuntimeService } from "../cline-sdk/cline-mcp-runtime-service";
import { createClineMcpSettingsService } from "../cline-sdk/cline-mcp-settings-service";
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import { isClineClearSlashCommand } from "../cline-sdk/cline-slash-commands";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import {
	isRuntimeAgentSessionSummaryDrivenByAcpProtocol,
	isRuntimeAgentSessionSummaryRenderedAsConversationPanel,
	resolveRuntimeAgentSessionTransportFromSummary,
} from "../core/agent-catalog";
import {
	canAgentSessionTransportBeSwitched,
	doesAgentSupportSessionTransport,
	resolveAgentSessionTransportForLaunch,
} from "../core/agent-session-transport-selection";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseAgentSessionTransportSwitchRequest,
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
import { isSessionInActiveTurn, resolveSessionFacets } from "../core/session-activity";
import { resolveTaskAgentPermissionModeFromLegacyAutonomousFlag } from "../core/task-agent-permission-mode";
import { applyMostRecentlyLaunchedAgentSessionAgentIdToTask, updateTask } from "../core/task-board-mutations";
import {
	getTaskMessageInjectionLedgerPath,
	recordTaskMessageTerminalDeliveryOutcome,
} from "../core/task-message-injection-ledger";
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
} from "../state/agent-raised-pending-user-decision-store";
import { supersedeAgentSessionRetentionDeadlinesForTask } from "../state/agent-session-reclamation-deadline-store";
import { clearNotificationLog, markTaskNotificationsVisited } from "../state/notification-log-store";
import { getWorkspaceDirectoryPath, loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	getTerminalAgentModelSelectionOptions,
	isClaudeCodeCuratedTerminalAgentModelSelectionOptionId,
	isClaudeCodeLatestTrackingAliasModelSelectionOptionId,
	isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId,
	resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity,
} from "../terminal/terminal-agent-model-selection";
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
	broadcastRuntimeWorkspaceStateUpdated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
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

function findWorkspaceBoardCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const found = column.cards.find((entry) => entry.id === taskId);
		if (found) {
			return found;
		}
	}
	return null;
}

// 恢复既有对话（终端 agent 的「Restart terminal session」与从 trash 拖回，两者都走 `--continue`）时，
// 模型该听谁的。
//
// 答案是**听会话自己的**：`--continue` 重播的是同一段对话，用户在 TUI 里 `/model` 切过的模型才是它的真实状态。
// 卡片上的 model override 退化为「全新启动时的初始值」——它常年是新建任务时由「记住上次选择」自动回填的
// 那个模型，恢复时再施加一次，就会把跑了半天的对话无声拽回去（本模块存在的直接原因）。
// 探针问不出结论时（不支持的 agent / 没有转录 / 会话还没产出过回合）原样退回卡片值，行为与本改动前一致。
//
// 只覆盖 `--continue` 这条路：`taskAgentSessionInitialization` 的 `--resume <id>` 播种与 By the way 的
// fork 都是「基于某段历史开一段新对话」，那里卡片 override 仍是正确的意图表达。
//
// ── 别名档卡片的两条例外 ──────────────────────────────────────────────────────────
// 「跟随会话」的前提是卡片上存的是**一个具体模型**，它与会话实况可能矛盾。若卡片存的是别名档条目，
// 那它表达的是**策略**而非模型，转录读回的具体 id 并不与之矛盾，替换它只会造成单向的信息损失：
//   1. opusplan（按阶段切换 Opus/Sonnet）：连本次启动都不顶替。顶替后恢复出来的会话被钉死在某一阶段的
//      模型上，此后进入计划态也切不回 Opus，用户选的策略被静默销毁。
//   2. opus / sonnet / fable / haiku（跟随最新）：本次启动仍按转录模型走（这才是修 M2 的要点——用户在
//      TUI 里切走后不能再被卡片拽回去），但**不回写卡片**：把 `opus` 改写成 `claude-opus-5[1m]` 会
//      把「永远跟最新」降级成一个钉死的版本，且卡片上看不出发生过降级，还会波及此后的全新启动与
//      By the way fork（两者仍读卡片值）。
async function resolveResumedTerminalAgentSessionModelOverrideSettings(options: {
	agentId: RuntimeAgentId;
	taskId: string;
	taskCwd: string;
	workspaceScope: RuntimeTrpcWorkspaceScope;
	cardTerminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	broadcastRuntimeWorkspaceStateUpdated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}): Promise<RuntimeTaskTerminalAgentModelOverrideSettings | undefined> {
	const cardModelOverrideSettings =
		options.cardTerminalAgentModelOverrideSettings?.agentId === options.agentId
			? options.cardTerminalAgentModelOverrideSettings
			: undefined;
	if (!supportsPersistedAgentTranscriptLastConversationModelProbe(options.agentId)) {
		return cardModelOverrideSettings;
	}
	if (
		cardModelOverrideSettings &&
		isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId(cardModelOverrideSettings.modelId)
	) {
		// 连探针都不必跑：无论转录里是什么，答案都只能是卡片上那条策略。
		return cardModelOverrideSettings;
	}
	let observedModelId: string | null = null;
	try {
		observedModelId = await probePersistedAgentTranscriptLastConversationModelIdentity({
			agentId: options.agentId,
			workspacePath: options.taskCwd,
		});
	} catch {
		// 探针是「锦上添花」，读转录失败绝不能挡住会话恢复。
		return cardModelOverrideSettings;
	}
	if (!observedModelId) {
		return cardModelOverrideSettings;
	}
	const launchModelId = resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity(observedModelId);
	if (!launchModelId) {
		return cardModelOverrideSettings;
	}
	const resolvedModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings = {
		agentId: "claude",
		modelId: launchModelId,
	};
	// 卡片存的是「跟随最新」的别名档时不回写：见函数头「别名档卡片的两条例外」第 2 条。
	// 其余情况一律调用回写——**不**在这里先比一次「和卡片值一样就别写了」：这里手上的卡片值是 await 探针
	// **之前**读到的，另一标签页在这段窗口里改掉卡片、且旧值恰好等于转录模型时，那个提前返回就会让卡片
	// 与本次启动的模型分叉。唯一权威的比较在下面的写入函数里、锁内重做，值相同时它自己会 save:false 早退。
	if (
		!(
			cardModelOverrideSettings &&
			isClaudeCodeLatestTrackingAliasModelSelectionOptionId(cardModelOverrideSettings.modelId)
		)
	) {
		await persistResolvedTerminalAgentSessionModelOverrideSettingsOntoCard({
			workspaceScope: options.workspaceScope,
			taskId: options.taskId,
			resolvedTerminalAgentModelOverrideSettings: resolvedModelOverrideSettings,
			broadcastRuntimeWorkspaceStateUpdated: options.broadcastRuntimeWorkspaceStateUpdated,
		});
	}
	return resolvedModelOverrideSettings;
}

// 把恢复时解析出的真实模型同步回卡片，让 UI 上的模型 chip 与会话实际状态一致。
//
// 守卫：只回写策展表里认得的 id。目录外的 id（上游发了新模型、表还没补）交给本次启动就够了——落盘会让
// 模型选择器显示不出选中态，等于把一个用户无法通过 UI 修改的值钉在卡片上。
// 失败一律吞掉：卡片没同步只是显示滞后，不该连累会话恢复。
async function persistResolvedTerminalAgentSessionModelOverrideSettingsOntoCard(options: {
	workspaceScope: RuntimeTrpcWorkspaceScope;
	taskId: string;
	resolvedTerminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings;
	broadcastRuntimeWorkspaceStateUpdated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}): Promise<void> {
	const { resolvedTerminalAgentModelOverrideSettings } = options;
	if (!isClaudeCodeCuratedTerminalAgentModelSelectionOptionId(resolvedTerminalAgentModelOverrideSettings.modelId)) {
		return;
	}
	try {
		const mutation = await mutateWorkspaceState(options.workspaceScope.workspacePath, (state) => {
			const card = findWorkspaceBoardCard(state.board, options.taskId);
			if (
				!card ||
				(card.terminalAgentModelOverrideSettings?.agentId === resolvedTerminalAgentModelOverrideSettings.agentId &&
					card.terminalAgentModelOverrideSettings.modelId === resolvedTerminalAgentModelOverrideSettings.modelId)
			) {
				return { board: state.board, value: false, save: false };
			}
			// updateTask 里只有 terminalAgentModelOverrideSettings 之外的三态字段会「缺省即保留」；
			// title / prompt / baseRef / startInPlanMode / autoReview* 不是三态，漏传就会被复位，
			// 故这几个必须从卡片原值显式回填。
			const updated = updateTask(state.board, options.taskId, {
				title: card.title,
				prompt: card.prompt,
				baseRef: card.baseRef,
				startInPlanMode: card.startInPlanMode,
				taskAgentPermissionMode: card.taskAgentPermissionMode,
				autoReviewEnabled: card.autoReviewEnabled === true,
				autoReviewMode: card.autoReviewMode ?? "commit",
				terminalAgentModelOverrideSettings: resolvedTerminalAgentModelOverrideSettings,
			});
			if (!updated.updated) {
				return { board: state.board, value: false, save: false };
			}
			return { board: updated.board, value: true };
		});
		if (mutation.value) {
			void options.broadcastRuntimeWorkspaceStateUpdated?.(
				options.workspaceScope.workspaceId,
				options.workspaceScope.workspacePath,
			);
		}
	} catch {
		// 看板状态没同步不影响会话本身，静默放过。
	}
}

// 会话启动成功后，把「这一次用的是哪个 agent」记到卡片上。
//
// 这是「重启后 TUI 全白且无法重启会话」那条 bug 的根因修复点。sessions.json 只在 graceful shutdown 与
// 客户端 saveState 落盘，系统重启 / 本地 redeploy 这类硬中断会让首轮尚未结束的 task 在盘上**没有任何
// session 条目**；而走项目默认档的卡片上又没有 `agentId` 可回填（`addTaskToColumn` 对未显式选 agent 的
// 卡片根本不写该字段），于是新 runtime 起来后这个 task 只剩一条 agentId 为 null 的空壳 summary。
// 卡片是唯一在硬中断中幸存的载体，所以「用的是哪个 agent」必须在**启动那一刻**就写到这里。
//
// 三条 transport（PTY / Cline SDK / ACP）都要写：三者都会遇到同一种中断。
// 失败一律吞掉——卡片没同步只是少一条回填源，绝不该连累会话启动本身。
async function persistMostRecentlyLaunchedAgentSessionAgentIdOntoCard(options: {
	workspaceScope: RuntimeTrpcWorkspaceScope;
	taskId: string;
	agentId: RuntimeAgentId;
	broadcastRuntimeWorkspaceStateUpdated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}): Promise<void> {
	// Home agent 会话不是看板任务，board 上没有对应卡片，跳过省一次无谓的读写。
	if (isHomeAgentSessionId(options.taskId)) {
		return;
	}
	try {
		const mutation = await mutateWorkspaceState(options.workspaceScope.workspacePath, (state) => {
			const applied = applyMostRecentlyLaunchedAgentSessionAgentIdToTask(
				state.board,
				options.taskId,
				options.agentId,
			);
			if (!applied.updated) {
				return { board: state.board, value: false, save: false };
			}
			return { board: applied.board, value: true };
		});
		if (mutation.value) {
			void options.broadcastRuntimeWorkspaceStateUpdated?.(
				options.workspaceScope.workspaceId,
				options.workspaceScope.workspacePath,
			);
		}
	} catch {
		// 看板状态没同步不影响会话本身，静默放过。
	}
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

	const runtimeApi: RuntimeTrpcContext["runtimeApi"] = {
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
				// 本次要走哪条通话通道。omp 有 TUI / ACP 两条，解析优先级是
				// 「请求显式指定（切换 procedure）→ 卡片建卡时固化值 → 全局新任务默认 → catalog 默认」。
				// 只有可切换的 agent 才为此读一次看板（board.json 读盘不该被塞进每一次启动的热路径）。
				startFailurePhase = "resolve_agent_session_transport";
				const cardPinnedOmpAgentSessionTransport = canAgentSessionTransportBeSwitched(effectiveAgentId)
					? (findWorkspaceBoardCard(await loadWorkspaceBoardById(workspaceScope.workspaceId), workspaceTaskId)
							?.ompAgentSessionTransport ?? null)
					: null;
				const resolvedAgentSessionTransport = resolveAgentSessionTransportForLaunch({
					agentId: effectiveAgentId,
					explicitlyRequestedSessionTransport: body.requestedAgentSessionTransport ?? null,
					cardPinnedSessionTransport: cardPinnedOmpAgentSessionTransport,
					globalDefaultSessionTransportForNewTasks: scopedRuntimeConfig.ompAgentSessionTransportForNewTasks,
				});
				// ACP 会话（omp 切到 ACP 时）既不是 PTY 终端 agent 也不是 Cline SDK，走自己的服务。
				if (resolvedAgentSessionTransport.effectiveSessionTransport === "acp_stdio_subprocess") {
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
						resumePriorAgentConversationWithoutResendingPrompt:
							body.resumePriorAgentConversationWithoutResendingPrompt,
					});
					latestStartedSummaryForDiagnostics = acpSummary;
					// ACP 的 startTaskSession **不抛**：session/load、认证、spawn 的异常全被它自己 catch 成一条
					// failed/error 的 summary（recordTaskFailure）之后**正常返回**。所以「这条会话到底起来了没有」
					// 只能从返回的 summary 上读，绝不能靠「没抛异常」推断——否则子进程压根没起来也会被回成 ok:true。
					//
					// 这条谎报在 switchAgentSessionTransport 上最致命：那条路径已经把旧会话停掉了，再收到 ok:true
					// 就既不弹错误也不提示重试，用户对着一张什么都没在跑的卡以为切换成功了。切换的失败口径是
					// 「停在已停止并如实报错」，这里如实回 ok:false 正是它的前提；不重试、不回滚、不降级回旧通道。
					//
					// 判据复用 facet 权威的 isSessionInActiveTurn（与 PTY / Cline 侧同一套双轴口径），不新写一套
					// state 字符串比较：failed（起不来）与 interrupted（刚起就被拆）都不算「起来了」。
					if (!isSessionInActiveTurn(resolveSessionFacets(acpSummary))) {
						const acpStartFailureMessage =
							acpSummary.warningMessage ?? `The ${effectiveAgentId} ACP session could not be started.`;
						recordStartDiagnostic("failed", startFailurePhase, acpStartFailureMessage);
						// 带上那条 failed summary 一起回：它才是这条会话此刻的真相（含 warningMessage），
						// 切换路径会原样透传给前端去写提示。
						return { ok: false, summary: acpSummary, error: acpStartFailureMessage };
					}
					recordStartDiagnostic("runtime_started", startFailurePhase);
					await persistMostRecentlyLaunchedAgentSessionAgentIdOntoCard({
						workspaceScope,
						taskId: body.taskId,
						agentId: effectiveAgentId,
						broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
					});
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
					// 记 summary 的 agentId 而不是 effectiveAgentId：`shouldProbePersistedClineSession` 那条
					// 分支会在 effectiveAgentId 仍是别的 agent 时把 useClinePath 翻成 true，此时真正跑起来的
					// 是 Cline，卡片上必须记下这个事实。
					await persistMostRecentlyLaunchedAgentSessionAgentIdOntoCard({
						workspaceScope,
						taskId: body.taskId,
						agentId: summary.agentId ?? effectiveAgentId,
						broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
					});

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
				// 从 trash 拖回同样走 `--continue`（见 claudeAdapter），故与「Restart terminal session」同规则：
				// 恢复既有对话时听会话自己的模型。全新启动不经这里，卡片 override 在那里仍是唯一意图来源。
				startFailurePhase = "resolve_resumed_terminal_agent_session_model";
				const startTerminalAgentModelOverrideSettings = body.resumeFromTrash
					? await resolveResumedTerminalAgentSessionModelOverrideSettings({
							agentId: resolved.agentId,
							taskId: body.taskId,
							taskCwd,
							workspaceScope,
							cardTerminalAgentModelOverrideSettings: body.terminalAgentModelOverrideSettings,
							broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
						})
					: body.terminalAgentModelOverrideSettings?.agentId === resolved.agentId
						? body.terminalAgentModelOverrideSettings
						: undefined;
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
					resumePriorAgentConversationWithoutResendingPrompt:
						body.resumePriorAgentConversationWithoutResendingPrompt,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
					projectPath: workspaceScope.workspacePath,
					parentSessionId: body.parentSessionId,
					taskAgentSessionInitialization: body.taskAgentSessionInitialization,
					terminalAgentModelOverrideSettings: startTerminalAgentModelOverrideSettings,
				});
				latestStartedSummaryForDiagnostics = summary;
				recordStartDiagnostic("runtime_started", startFailurePhase);
				await persistMostRecentlyLaunchedAgentSessionAgentIdOntoCard({
					workspaceScope,
					taskId: body.taskId,
					agentId: resolved.agentId,
					broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
				});

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
				// 这里刻意**不**在解析卡片之前就以「没有活体 summary」或「summary.agentId 为 null」拒绝。
				//
				// 「重启终端会话」正是给「会话已经不在了」准备的按钮：下游的 terminalManager.refreshTaskTerminal
				// 本身就是 forceStopTaskSession + startTaskSession，不要求存在活体条目。而硬中断后 agentId
				// 恰恰是最容易丢的那个字段——一旦在这里提前拒绝，用户就只剩一个既全白、又点不动的面板，
				// 也就是本 bug 的最终形态。真正该拒绝的只有「这个 agent 根本不用 PTY 终端」，那需要先把
				// 卡片解析出来、把 agentId 兜底求全之后才能判断。
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				const card = findWorkspaceBoardCard(board, body.taskId);
				if (!card) {
					return {
						ok: false,
						summary: null,
						error: "Card not found in the workspace board.",
					};
				}
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				// 兜底顺序与 `backfillMissingSessionAgentIdsFromDurableSources`（src/server/workspace-registry.ts）
				// 严格同序：**运行时观测事实优先于卡片上的用户意图**。两处解析的是同一个问题——「这条**既存**
				// 会话当时到底由谁跑起来」——同问题必须同答案，否则回填与重启会在同一张卡上给出两个身份。
				//
				// 为什么这里同样是「既存会话」的问题：本 procedure 下游是 `resumeFromTrash: true` → `--continue`，
				// 续的就是那条已经存在的会话，不是新开一条。
				//
				// 为什么观测值必须压过 `card.agentId`：`startTaskSession` 的 `shouldProbePersistedClineSession`
				// 分支会在 `card.agentId` 仍是别的 agent 时探测到持久化的 Cline 会话并改走 Cline，此时真正跑起来
				// 的与卡片意图天然不一致（只有 `mostRecentlyLaunchedAgentSessionAgentId` 记下了这个事实）。旧顺序
				// 让 `card.agentId` 胜出，会直接**骗过下面那道「非 PTY agent 一律拒绝刷新」的能力谓词闸门**——
				// 闸门看到的是 PTY agent，于是放行，把一个 Cline 会话用 PTY agent 重启掉。
				//
				// `card.agentId` 表达的是「下次想用谁启动」的意图，可能还没有任何会话兑现过它（用户改了卡片 agent
				// 但尚未重启，既存会话的身份仍是上一次跑起来的那个），故只作为观测值缺席时的兜底。
				const effectiveAgentId =
					currentSummary?.agentId ??
					card.mostRecentlyLaunchedAgentSessionAgentId ??
					card.agentId ??
					scopedRuntimeConfig.selectedAgentId;
				// 用能力谓词而非 agentId 字面量比较：见 CLAUDE.md「分支判定一律用能力谓词」。
				// 新增非 PTY agent 时这里自动跟上，不会像硬编码那样漏改。
				//
				// 但**光看 agentId 已经不够**：omp 有 TUI / ACP 两条通道，catalog 只记得它的默认通道，
				// 于是一条被钉成 ACP 的 omp 会话会被 agentId 版谓词判成「PTY agent」而放行，然后被
				// 当作 PTY 重启掉。判据因此改读通道本身，且优先级与「这条会话到底跑在哪」一致：
				//   有活体 PTY summary ⇒ 读它盖的章（terminalManager 的 summary 理论上恒是 PTY，
				//   仍照读是为了不依赖这个隐含前提——那正是本次改动之前那批硬编码分叉的成因）；
				//   硬中断后没有活体 summary ⇒ 按「下次启动该走哪条通道」解析（卡片固化 → 全局默认 →
				//   catalog 默认），与 card-detail-view 无活会话时的面板分流同一套优先级。
				const effectiveSessionTransport = currentSummary
					? resolveRuntimeAgentSessionTransportFromSummary({
							agentId: effectiveAgentId,
							sessionTransport: currentSummary.sessionTransport,
						})
					: resolveAgentSessionTransportForLaunch({
							agentId: effectiveAgentId,
							cardPinnedSessionTransport: card.ompAgentSessionTransport,
							globalDefaultSessionTransportForNewTasks: scopedRuntimeConfig.ompAgentSessionTransportForNewTasks,
						}).effectiveSessionTransport;
				if (effectiveSessionTransport !== "pty_terminal") {
					return {
						ok: false,
						summary: null,
						error: "Refresh is only available for active TUI terminal agents.",
					};
				}
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
				// 「Restart terminal session」永远走 `--continue`（下面的 resumeFromTrash: true），
				// 故模型一律以转录里读到的会话真实模型为准，卡片值只在探针问不出结论时兜底。
				const resumedTerminalAgentModelOverrideSettings =
					await resolveResumedTerminalAgentSessionModelOverrideSettings({
						agentId: resolved.agentId,
						taskId: body.taskId,
						taskCwd,
						workspaceScope,
						cardTerminalAgentModelOverrideSettings: card.terminalAgentModelOverrideSettings,
						broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
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
					terminalAgentModelOverrideSettings: resumedTerminalAgentModelOverrideSettings,
				});
				// 重启也是一次启动：把 agent 身份重新钉到卡片上，让「靠兜底才救回来的会话」在下一次硬中断时
				// 不必再靠兜底。
				await persistMostRecentlyLaunchedAgentSessionAgentIdOntoCard({
					workspaceScope,
					taskId: body.taskId,
					agentId: resolved.agentId,
					broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
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
		listAgentRaisedPendingUserDecisions: async (workspaceScope) => {
			const decisions = await readAgentRaisedPendingUserDecisions(workspaceScope.workspaceId);
			return {
				decisions: decisions.filter(isOpenAgentRaisedPendingUserDecision).map((decision) => ({
					decisionId: decision.decisionId,
					taskId: decision.taskId,
					agentId: decision.agentId,
					decisionKind: decision.decisionKind,
					questionMarkdown: decision.questionMarkdown,
					options: decision.options,
					allowsFreeformAnswer: decision.allowsFreeformAnswer,
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
						const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
						return await terminalManager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery(taskId);
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
						// 终端 agent：submitTaskChatInputWhenReady 要求 entry.active 存在，故必须在
						// ensureTaskSessionReadyForDelivery 之后调用（见交付顺序注释）。
						const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
						return terminalManager.submitTaskChatInputWhenReady(taskId, text) !== null;
					},
				}).answerPendingUserDecision({
					workspaceId: workspaceScope.workspaceId,
					decisionId: body.decisionId,
					selectedOptionIds: body.selectedOptionIds,
					freeformText: body.freeformText,
				});
			} catch (error) {
				return { ok: false, delivered: false, error: error instanceof Error ? error.message : String(error) };
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
				// 判据必须是「ACP 账本里有这条会话、且它盖的是 ACP 通道章」：omp 的 TUI 与 ACP 两条通道
				// 共用 agentId="omp"，只看账本里有没有 entry 会让一条切回 TUI 的会话继续读 ACP 的旧消息表。
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				if (isRuntimeAgentSessionSummaryDrivenByAcpProtocol(acpTaskSessionService.getSummary(body.taskId))) {
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
				// 同 getTaskChatMessages：按活会话盖的通道章分派，而不是「账本里有没有 entry」。
				if (isRuntimeAgentSessionSummaryDrivenByAcpProtocol(acpTaskSessionService.getSummary(body.taskId))) {
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
							// ACP 通道摄入即确认：sendTaskSessionInput 只在「账本里有该会话且 stdio 连接还活着」时返回
							// summary，返回前用户消息已进会话记录、session/prompt 已派发到那条连接上。没有 PTY 那种
							// 「粘进输入框但 CR 被吞」的中间态可等，因此这里不能留 pending——ACP 分支不存在
							// onDeliveryOutcome 这样的登记点，留下的 pending 没有任何人会来收敛，只会一直挂到下次
							// runtime 启动清扫，违反账本自己的「唯一非终态必然有界收敛」不变量。
							// 不报 queued_behind：那描述的是「写进 TUI 输入框时 agent 正占着回合」，ACP 侧压根没有
							// 排队模型（并发投递就是并发 session/prompt），报「排在后面」等于编造不存在的语义。
							...(body.idempotencyKey
								? {
										terminalDelivery: {
											status: "delivered_and_submit_confirmed" as const,
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
							// 诚实回执登记：带 idempotencyKey 就意味着这条投递被记在账本里、有人在等它的真实结论。
							// runtime 在投递落定（或失败）后就地改写同一条记录——CLI 早已退出，这是唯一能把
							// 「pending → 终态」补上的地方。写账本失败不阻断会话：启动清扫会兜底判失败。
							const injectionIdempotencyKey = body.idempotencyKey ?? null;
							const injectionLedgerPath = injectionIdempotencyKey
								? getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceScope.workspaceId))
								: null;
							const terminalSummary = terminalManager.submitTaskChatInputWhenReady(body.taskId, body.text, {
								deferWhileUserTurn: body.source != null,
								idempotencyKey: injectionIdempotencyKey,
								...(injectionLedgerPath && injectionIdempotencyKey
									? {
											onDeliveryOutcome: (outcome) => {
												void recordTaskMessageTerminalDeliveryOutcome({
													ledgerPath: injectionLedgerPath,
													taskId: body.taskId,
													idempotencyKey: injectionIdempotencyKey,
													status: outcome.status,
													...(outcome.reason ? { failureReason: outcome.reason } : {}),
													nowIso: new Date().toISOString(),
												}).catch(() => {
													// 账本写失败不影响会话本身；仍 pending 的记录由 runtime 启动清扫兜底判失败。
												});
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
					// Cline SDK 会话是进程内摄入：调到这里就说明消息已经进了会话，摄入本身是同步确认的，
					// 不存在 PTY 那种「粘进框但 CR 被吞」的失败形态，故直接给确认终态、无 pending 阶段。
					// 不报 queued_behind：那个区分描述的是「写进 TUI 输入框时 agent 正占着回合」，
					// 是终端通道特有的现象；SDK 侧队列由 runtime 自己持有，摄入即确认。
					...(body.idempotencyKey
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
		},
		// 取消一条在途程序化投递。账本的终态改写不在这里做——取消成功时 session-manager 会经
		// 投递登记的 observer 触发同一条回写路径（delivery_failed{cancelled_before_delivery}），
		// 与「确认落定」共用那一把写一次即定的锁，取消与确认的竞争因此是确定性的。
		cancelTaskChatDelivery: async (workspaceScope, input) => {
			try {
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				return {
					ok: true,
					cancelResult: terminalManager.cancelTaskChatInputDelivery(input.taskId, input.idempotencyKey),
				};
			} catch (error) {
				return {
					ok: false,
					cancelResult: "no_pending_delivery" as const,
					error: error instanceof Error ? error.message : String(error),
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
		// 把一条已存在的 agent 会话从当前通话通道切到另一条，服务端一次做完。
		//
		// 为什么是一条 procedure 而不是前端 stop→save→start 三连：三连的任何中途失败都会留下
		// 半切状态（卡片字段已改、会话仍在旧通道上，或反之），而用户在 UI 上看到的是一个原子动作。
		//
		// 失败口径：**停在已停止并如实报错**。不自动回滚到旧通道、不降级——静默回滚会让用户以为切成功了，
		// 降级会让他在错误的通道上继续干活。卡片的下次启动通道保持用户选的那条，修好后点 Start 即可。
		switchAgentSessionTransport: async (workspaceScope, input) => {
			const body = parseAgentSessionTransportSwitchRequest(input);
			let priorAgentSessionStopped = false;
			try {
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const acpTaskSessionService = await deps.getScopedAcpTaskSessionService(workspaceScope);
				const currentSummary =
					acpTaskSessionService.getSummary(body.taskId) ?? terminalManager.getSummary(body.taskId) ?? null;
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				const card = findWorkspaceBoardCard(board, body.taskId);
				const agentId = currentSummary?.agentId ?? card?.agentId ?? null;
				if (!agentId) {
					return {
						ok: false,
						summary: null,
						priorAgentSessionStopped,
						error: "This task has no agent session to switch.",
					};
				}
				if (!canAgentSessionTransportBeSwitched(agentId)) {
					return {
						ok: false,
						summary: null,
						priorAgentSessionStopped,
						error: `Agent "${agentId}" has only one session transport, so there is nothing to switch to.`,
					};
				}
				if (!doesAgentSupportSessionTransport(agentId, body.targetSessionTransport)) {
					return {
						ok: false,
						summary: null,
						priorAgentSessionStopped,
						error: `Agent "${agentId}" cannot run over ${body.targetSessionTransport}.`,
					};
				}
				if (!card) {
					return {
						ok: false,
						summary: null,
						priorAgentSessionStopped,
						error: "Card not found in the workspace board.",
					};
				}

				// 1) 停当前会话。ACP 侧的 stopTaskSession 自己会回掉 pending 授权（cancelPendingDecisions）；
				//    PTY 侧没有等人拍板的进程内决策，杀进程即终态。两边都对不存在的会话返回 null / no-op，
				//    故「本来就没跑」不算失败——切换的语义只关心「切完之后跑在新通道上」。
				//
				//    PTY 侧刻意走 forceStopTaskSession（等进程真的退出、超时升级到 SIGKILL），而不是只发信号的
				//    stopTaskSession：stopTaskSession 发完信号就返回，且刻意不清 entry.active（清空是 onExit
				//    自己的活），于是旧 PTY 迟到的 onExit 照样会给同一个 taskId 写一条 sessionTransport=
				//    pty_terminal 的终态 summary——session-manager 的 onExit 只检查 entry.active 还在不在，
				//    没有活体身份守卫。而 runtime-state-hub 的广播队列按 taskId 后写覆盖先写，这条迟到 summary
				//    只要落在第 4 步建立的新 ACP summary 之后，就把详情面板翻回终端。等它真的退出即从根上关掉
				//    这个窗口，顺带也不让旧 TUI 与新 omp 进程在重叠期同时写同一份按 cwd 建的 omp 会话存储
				//    ——第 4 步的续跑（ACP 取 session/list 最近一条、TUI 用 --continue 落到该 cwd 最近 session）
				//    正建立在这份存储的单写者假设上。超时仍杀不掉时 forceStopTaskSession 会自己把 entry.active
				//    置空，故既不会无限等，那种极端情况下迟到的 exit 也已无处可写。
				//
				//    ACP 侧不需要对称的等待来防覆盖：它迟到的 exit 走 onConnectionClosed，那里已被
				//    closeIntent === "disposed_by_kanban" 守住（拆连接前先落意图），不会再写第二条 summary；
				//    且 disposeTaskConnection 除 SIGTERM 外还 close 掉 stdio，headless 子进程随即收到 EOF。
				const acpStoppedSummary = await acpTaskSessionService.stopTaskSession(body.taskId);
				// getSummary 与 stopTaskSession 判「有没有这条会话」的口径一致（都只看账本里有无 entry），
				// 故先取一次 summary 再等停，priorAgentSessionStopped 的语义与只发信号那版完全相同。
				const terminalSummaryBeforeStop = acpStoppedSummary ? null : terminalManager.getSummary(body.taskId);
				if (terminalSummaryBeforeStop) {
					await terminalManager.forceStopTaskSession(body.taskId);
				}
				priorAgentSessionStopped = Boolean(acpStoppedSummary ?? terminalSummaryBeforeStop);
				// 切离 ACP 时必须把 ACP 账本条目彻底摘掉。stopTaskSession 只是把 summary 写成 interrupted、
				// 刻意保留条目（UI 还要显示那个终态），但 getTaskChatMessages / sendTaskChatMessage 是按
				// 「ACP 账本里有没有这条会话」分派的——留着条目，切回 TUI 的会话就会继续被 ACP 劫持这两个端点，
				// 聊天面板永远读 ACP 的旧消息表。这一步就是那条既有 bug 的根治点。
				if (body.targetSessionTransport !== "acp_stdio_subprocess") {
					acpTaskSessionService.discardTaskSessionLedgerEntry(body.taskId);
				}

				// 2) 作废两类**已落盘的 transport 快照**。它们记的是「当时那条会话走哪条通道」，
				//    切换后按旧通道投递必然落空（去写一个不存在的 PTY / 去 prompt 一条已拆的 ACP 连接）。
				//    等人拍板的问题在上一步已被 cancelled 回给 agent，这里把账本记录一并收口。
				const supersededAt = Date.now();
				await supersedeAgentSessionRetentionDeadlinesForTask(workspaceScope.workspaceId, body.taskId, supersededAt);
				const pendingDecisions = await readAgentRaisedPendingUserDecisions(workspaceScope.workspaceId);
				for (const decision of pendingDecisions) {
					if (decision.taskId === body.taskId && isOpenAgentRaisedPendingUserDecision(decision)) {
						await dismissAgentRaisedPendingUserDecision(
							workspaceScope.workspaceId,
							decision.decisionId,
							supersededAt,
						);
					}
				}

				// 3) 把新通道固化到卡上，使「下次启动」（含崩溃后自动续跑、从垃圾桶拖回）也走新通道。
				//    updateTask 里非三态的字段漏传会被复位，故必须从卡片原值显式回填——与
				//    persistResolvedTerminalAgentSessionModelOverrideSettingsOntoCard 同一注意事项。
				const cardMutation = await mutateWorkspaceState(workspaceScope.workspacePath, (state) => {
					const currentCard = findWorkspaceBoardCard(state.board, body.taskId);
					if (!currentCard) {
						return { board: state.board, value: false, save: false };
					}
					const updated = updateTask(state.board, body.taskId, {
						title: currentCard.title,
						prompt: currentCard.prompt,
						baseRef: currentCard.baseRef,
						startInPlanMode: currentCard.startInPlanMode,
						taskAgentPermissionMode: currentCard.taskAgentPermissionMode,
						autoReviewEnabled: currentCard.autoReviewEnabled === true,
						autoReviewMode: currentCard.autoReviewMode ?? "commit",
						ompAgentSessionTransport: body.targetSessionTransport,
					});
					if (!updated.updated) {
						return { board: state.board, value: false, save: false };
					}
					return { board: updated.board, value: true };
				});
				if (cardMutation.value) {
					void deps.broadcastRuntimeWorkspaceStateUpdated?.(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}

				// 4) 用新通道以「续跑既有对话、不重投 prompt」形态重开。
				//    不重投 prompt：用户已在对话中途，重投原始 prompt 等于凭空多一轮。
				//    不重放 startInPlanMode：同理，模式该由 agent 自己的会话记录说了算。
				//
				//    这里之所以敢只看 startResponse.ok：startTaskSession 的 ACP 分支已经不再无条件回 ok:true
				//    ——ACP service 把 spawn / 认证 / session/load 的异常吞成一条 failed summary 后正常返回，
				//    那条分支现在按 facet 判活性再决定 ok（见该分支注释）。少了那一步，本判据对「切到 ACP」
				//    恒真，切换就会在旧会话已停的情况下谎报成功。
				const startResponse = await runtimeApi.startTaskSession(workspaceScope, {
					taskId: body.taskId,
					prompt: card.prompt,
					taskTitle: card.title,
					baseRef: card.baseRef,
					agentId,
					taskAgentPermissionMode: card.taskAgentPermissionMode,
					worktreeMode: card.worktreeMode,
					requestedAgentSessionTransport: body.targetSessionTransport,
					resumePriorAgentConversationWithoutResendingPrompt: true,
				});
				if (!startResponse.ok) {
					return {
						ok: false,
						summary: startResponse.summary,
						priorAgentSessionStopped,
						error:
							startResponse.error ??
							`Could not start the ${body.targetSessionTransport} session after stopping the previous one.`,
					};
				}
				return { ok: true, summary: startResponse.summary, priorAgentSessionStopped };
			} catch (error) {
				return {
					ok: false,
					summary: null,
					priorAgentSessionStopped,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
	return runtimeApi;
}
