// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed Cline, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import type { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import {
	buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts,
	buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger,
	collectToolUseIdsAlreadyRecordedInDecisionLedger,
	listClaudeTranscriptFilesForTaskUserDecisionHistory,
	mergeAgentRaisedUserDecisionHistoryEntries,
} from "../agent-session-history/agent-raised-user-decision-history-builder";
import { listAvailableAgentSessions } from "../agent-session-history/available-agent-session-index";
import { encodeClaudeProjectDirectoryName } from "../agent-session-history/bounded-agent-transcript-reader";
import {
	salvageLatestUnansweredClaudeUserQuestionForTask,
	salvageLatestUnansweredCodexUserQuestionForKnownSession,
} from "../agent-session-history/pending-user-decision-transcript-salvage";
import {
	probePersistedAgentTranscriptLastConversationModelIdentity,
	probePersistedAgentTranscriptModelIdentityForAgentNativeConversationSession,
	supportsPersistedAgentTranscriptLastConversationModelProbe,
} from "../agent-session-history/persisted-agent-transcript-last-conversation-model-probe";
import { createClineMcpRuntimeService } from "../cline-sdk/cline-mcp-runtime-service";
import { createClineMcpSettingsService } from "../cline-sdk/cline-mcp-settings-service";
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import {
	getRuntimeAgentSessionTransport,
	isRuntimeAgentSessionDrivenByAcpProtocol,
	isRuntimeAgentSessionSummaryDrivenByAcpProtocol,
	resolveRuntimeAgentSessionTransportFromSummary,
} from "../core/agent-catalog";
import {
	canAgentSessionTransportBeSwitched,
	doesAgentSupportSessionTransport,
	resolveAgentSessionTransportForLaunch,
} from "../core/agent-session-transport-selection";
import type {
	PromptLibraryScope,
	RuntimeAgentId,
	RuntimeAgentNativeConversationSessionIdentity,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskChatSendResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
	RuntimeTerminalInputBoxStashResponse,
	RuntimeUpdateStatusResponse,
	TerminalDeliveryStatus,
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
import { formatDeferredHarnessGeneratedPromptsAsExplicitUserReleasedPrompt } from "../core/harness-generated-restoration-prompt";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { buildQueuedProgrammaticInjectionQueueEntryId } from "../core/queued-programmatic-injection-ledger-receipt-mirroring";
import { isSessionInActiveTurn, resolveSessionFacets } from "../core/session-activity";
import { resolveTaskAgentPermissionModeFromLegacyAutonomousFlag } from "../core/task-agent-permission-mode";
import { applyMostRecentlyLaunchedAgentSessionAgentIdToTask, updateTask } from "../core/task-board-mutations";
import { resolveTaskTitle } from "../core/task-title.js";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import {
	recordTaskSessionStartDiagnostic,
	type TaskSessionStartDiagnosticEvent,
} from "../diagnostics/task-session-start-diagnostics-logger";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import {
	recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking,
	recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking,
	recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking,
} from "../inter-work-unit-relation-ledger/task-message-delivery-request-event-recording";
import { createAgentRaisedPendingUserDecisionAnswerDelivery } from "../server/agent-raised-pending-user-decision-answer-delivery";
import { openInBrowser } from "../server/browser";
import type { QueuedTaskPromptDeliveryDispatcher } from "../server/queued-task-prompt-delivery-dispatcher";
import {
	dismissAgentRaisedPendingUserDecision,
	isOpenAgentRaisedPendingUserDecision,
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
	resolveAgentRaisedPendingUserDecisionOrderedQuestions,
	resolveAgentRaisedPendingUserDecisionThroughDuplicateSupersession,
} from "../state/agent-raised-pending-user-decision-store";
import { supersedeAgentSessionRetentionDeadlinesForTask } from "../state/agent-session-reclamation-deadline-store";
import { withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped } from "../state/discard-task-edit-drafts-for-tasks-removed-from-board";
import { clearNotificationLog, markTaskNotificationsVisited } from "../state/notification-log-store";
import { mutateWorkspacePromptLibrary, readWorkspacePromptLibrarySnapshot } from "../state/prompt-library-store";
import {
	isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask,
	isQueuedTaskPromptDeliveryWorkspaceQueueFull,
	mutateWorkspaceQueuedTaskPromptDeliveriesAndReportNewlyCreatedQueueEntries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../state/queued-task-prompt-delivery-store";
import {
	consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
	listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
	type RestorationDeferredHarnessGeneratedPrompt,
	restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
} from "../state/restoration-deferred-harness-generated-prompt-store";
import { mutateWorkspaceTaskEditDrafts, readWorkspaceTaskEditDraftsSnapshot } from "../state/task-edit-draft-store";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state";
import { suggestTaskNamesFromTaskDescription } from "../task-name-suggestion/suggest-task-names-from-task-description";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import { isAgentUserQuestionSelectorDismissedAndTerminalInputBoxVisible } from "../terminal/agent-user-question-selector-dismissal-before-programmatic-answer-delivery";
import type { TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../terminal/session-manager";
import {
	stashTaskTerminalInputBoxIntoPromptLibrary,
	type TerminalInputBoxStashInitiator,
} from "../terminal/stash-task-terminal-input-box-into-prompt-library";
import {
	getTerminalAgentModelSelectionOptions,
	isClaudeCodeCuratedTerminalAgentModelSelectionOptionId,
	isClaudeCodeLatestTrackingAliasModelSelectionOptionId,
	isClaudeCodePhaseSwitchingCompositeModelSelectionOptionId,
	resolveClaudeLaunchModelIdentityForObservedTranscriptModelIdentity,
} from "../terminal/terminal-agent-model-selection";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import {
	cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle,
	enqueueAgentIdleGatedProgrammaticTaskChatMessage,
} from "./agent-idle-gated-programmatic-task-chat-message-enqueue";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";
import { sendTaskChatMessageAcrossSessionTransports } from "./task-chat-message-send-across-session-transports";

// 列表接口只回预览：单条通知正文可以很长（子 agent 的完整 result 会整段塞在里面），把它整份搬进
// 浏览器既无必要也拖慢详情视图。放行走的是账本里的完整正文，与这份预览无关。
const DEFERRED_RESTORATION_NOTIFICATION_PREVIEW_LENGTH = 400;

// 放行只认这两个终态为「真的送到 agent 手上了」：文本已写进 PTY 且提交已确认（第二个只是写入时
// agent 正占着回合，消息排在其后，同样已被收下）。accepted_pending_submit_confirmation 是唯一的
// 非终态、delivery_failed 是失败，两者都不能当成功——那正是 2026-08-08 事故的成因。
const TERMINAL_DELIVERY_STATUSES_MEANING_RELEASED_PROMPT_REACHED_AGENT: ReadonlySet<TerminalDeliveryStatus> = new Set([
	"delivered_and_submit_confirmed",
	"delivered_queued_behind_active_agent_turn",
]);

// consume 是破坏性的：一旦取出就从账本里消失了。投递没能成功时必须原样写回，否则用户点一次放行
// 就把 agent 在等的唤醒信号永久弄丢。写回失败只记日志、不再抛——此刻已在失败路径上，二次抛出只会
// 把「投递失败」这个真正有用的原因盖掉。
// 走 store 的整批回滚入口而不是逐条 defer：defer 是「新增一条」的语义，逐条写回会占 N 次写队列操作、
// 按追加顺序裁剪，从而挤掉 consume 之后新到达的通知并打乱顺序。回滚要的是「当作没取过」。
async function restoreConsumedDeferredRestorationNotifications(
	workspaceId: string,
	consumedRecords: readonly RestorationDeferredHarnessGeneratedPrompt[],
): Promise<void> {
	if (consumedRecords.length === 0) {
		return;
	}
	try {
		await restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId,
			restoredRecords: consumedRecords,
		});
	} catch (error) {
		logAgentSessionRetentionWarning(
			`restoration-deferred-notification-restore-failed workspaceId=${workspaceId} restoredNotificationCount=${
				consumedRecords.length
			} reason=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

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
	// 排队 prompt 的出队引擎（runtime 级单例，见 src/server/queued-task-prompt-delivery-dispatcher.ts）。
	// 缺席时（单测）队列照样可读写，只是改动后不会立刻尝试出队、投影不带阻塞原因、在途条目无法取消。
	queuedTaskPromptDeliveryDispatcher?: Pick<
		QueuedTaskPromptDeliveryDispatcher,
		"notifyQueueMutated" | "cancelInFlightQueuedPromptDelivery" | "buildProjectedEntriesByTaskId"
	>;
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
	// 这条会话自己的 harness 原生会话身份（summary sidecar）。有它就按 id 取模型，没有才退回
	// 「工作目录里最近那段对话」——后者在主会话与 By the way 侧问、或多个 inplace 任务共用 cwd 时
	// 会把**别人**的模型套过来，还会顺手写回卡片固化下来。
	agentNativeConversationSessionIdentity?: RuntimeAgentNativeConversationSessionIdentity | null;
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
	const agentNativeConversationSessionIdentity =
		options.agentNativeConversationSessionIdentity?.sourceAgentId === options.agentId
			? options.agentNativeConversationSessionIdentity
			: null;
	try {
		observedModelId = agentNativeConversationSessionIdentity
			? await probePersistedAgentTranscriptModelIdentityForAgentNativeConversationSession({
					agentId: options.agentId,
					workspacePath: options.taskCwd,
					agentNativeConversationSessionId: agentNativeConversationSessionIdentity.nativeSessionId,
				})
			: await probePersistedAgentTranscriptLastConversationModelIdentity({
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
		const mutation = await mutateWorkspaceState(
			options.workspaceScope.workspacePath,
			buildTaskMutationIntentForKanbanRuntimeSystemComponent(
				"runtime_persist_resolved_terminal_agent_model_override_settings_onto_card",
				"task_session_start_terminal_agent_model_override_persistence",
			),
			(state) => {
				const card = findWorkspaceBoardCard(state.board, options.taskId);
				if (
					!card ||
					(card.terminalAgentModelOverrideSettings?.agentId ===
						resolvedTerminalAgentModelOverrideSettings.agentId &&
						card.terminalAgentModelOverrideSettings.modelId ===
							resolvedTerminalAgentModelOverrideSettings.modelId)
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
			},
		);
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
		const mutation = await mutateWorkspaceState(
			options.workspaceScope.workspacePath,
			buildTaskMutationIntentForKanbanRuntimeSystemComponent(
				"runtime_record_most_recently_launched_agent_session_agent_id_onto_card",
				"task_session_start_launched_agent_id_persistence",
			),
			(state) => {
				const applied = applyMostRecentlyLaunchedAgentSessionAgentIdToTask(
					state.board,
					options.taskId,
					options.agentId,
				);
				if (!applied.updated) {
					return { board: state.board, value: false, save: false };
				}
				return { board: applied.board, value: true };
			},
		);
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
		const startedSummary = await terminalManager.startTaskSession(
			{
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
				// 会话模式的语义是「下次启动生效」——本条路径就是一次启动，从卡片原值显式回填，
				// 与通道切换后重建 startResponse 的范式一致（漏传 = 静默掉回 operational 缺省）。
				taskConversationMode: card.taskConversationMode,
				workspaceId: workspaceScope.workspaceId,
				projectPath: workspaceScope.workspacePath,
				parentSessionId: undefined,
				taskAgentSessionInitialization: undefined,
				terminalAgentModelOverrideSettings:
					card.terminalAgentModelOverrideSettings?.agentId === resolved.agentId
						? card.terminalAgentModelOverrideSettings
						: undefined,
			},
			// 刻意不复用 resume_reclaimed_…：那条走的是内存里还在的 restartRequest，本条是内存态已随进程
			// 重启丢光、从 durable board 重新拼出来的。两者的成因与修法都不同，混记就白设这个枚举了。
			"durable_record_rebuilt_resume",
		);
		return startedSummary.pid != null;
	};

	// workspace 作用域的薄包装：真正的暂存链路已抽到 terminal/stash-task-terminal-input-box-into-prompt-library.ts
	// （排队投递 dispatcher 没有 TRPC 请求、拿不到这个每请求闭包，故必须共用那一份而不是复制一份）。
	const stashTaskTerminalInputBoxIntoPromptLibraryForWorkspaceScope = async (args: {
		workspaceScope: RuntimeTrpcWorkspaceScope;
		taskId: string;
		scope: PromptLibraryScope;
		initiatedBy: TerminalInputBoxStashInitiator;
	}): Promise<RuntimeTerminalInputBoxStashResponse> =>
		await stashTaskTerminalInputBoxIntoPromptLibrary(
			{
				getTerminalSessionManagerForWorkspace: async () => await deps.getScopedTerminalManager(args.workspaceScope),
			},
			{
				workspaceId: args.workspaceScope.workspaceId,
				taskId: args.taskId,
				scope: args.scope,
				initiatedBy: args.initiatedBy,
			},
		);

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
		// 起名不需要任何运行时状态（无工作区、无会话），所以这里就是一层薄转发：协调者不沉淀逻辑。
		suggestTaskNamesFromTaskDescription: async (_workspaceScope, input) => {
			return await suggestTaskNamesFromTaskDescription(input);
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
					const previousNativeIdentity =
						acpTaskSessionService.getSummary(body.taskId)?.agentNativeConversationSessionIdentity ??
						terminalManager.getSummary(body.taskId)?.agentNativeConversationSessionIdentity;
					const sharedDirectorySessions = [
						...terminalManager.listSummaries(),
						...acpTaskSessionService.listSummaries(),
					]
						.filter(
							(summary) =>
								summary.taskId !== body.taskId &&
								summary.workspacePath &&
								resolve(summary.workspacePath) === resolve(taskCwd),
						)
						.map((summary) => ({
							taskConversationSessionId: summary.taskId,
							agentId: summary.agentId,
							taskConversationSessionRole:
								summary.taskConversationSessionMetadata?.taskConversationSessionRole ?? null,
						}));
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
						resumePriorAgentConversationWithoutResendingPrompt: Boolean(
							body.resumeFromTrash || body.resumePriorAgentConversationWithoutResendingPrompt,
						),
						observedAgentNativeConversationSessionIdentity: previousNativeIdentity,
						taskConversationSessionsSharingExecutionWorkingDirectory: sharedDirectorySessions,
						taskConversationMode: body.taskConversationMode,
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
					// 协议返回的原生 ID 必须在启动响应前落盘，关浏览器不应影响下次寻址。
					await mutateWorkspaceState(
						workspaceScope.workspacePath,
						buildTaskMutationIntentForKanbanRuntimeSystemComponent(
							"runtime_persist_acp_protocol_native_session_identity_into_sessions",
							"acp_task_session_start_native_identity_persistence",
						),
						(state) => ({
							board: state.board,
							sessions: { ...state.sessions, [body.taskId]: nextAcpSummary },
							value: true,
						}),
					);
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
						taskConversationMode: body.taskConversationMode,
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
							// 与 refreshTaskTerminal 同源：这条路同样可能因寻址轴而按 `--resume <本会话 id>` 续跑，
							// 模型就必须也按同一个 id 取。少了它，主会话从垃圾桶恢复时会读到「工作目录里最近那段
							// 对话」——共用 worktree 下那多半是侧问会话——并经回写把侧问的模型固化进主卡。
							agentNativeConversationSessionIdentity: terminalManager.getSummary(body.taskId)
								?.agentNativeConversationSessionIdentity,
							workspaceScope,
							cardTerminalAgentModelOverrideSettings: body.terminalAgentModelOverrideSettings,
							broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
						})
					: body.terminalAgentModelOverrideSettings?.agentId === resolved.agentId
						? body.terminalAgentModelOverrideSettings
						: undefined;
				startFailurePhase = "start_pty_terminal_runtime_session";
				const summary = await terminalManager.startTaskSession(
					{
						taskId: body.taskId,
						workspaceTaskId,
						taskConversationSessionMetadata: body.taskConversationSessionMetadata,
						taskConversationMode: body.taskConversationMode,
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
					},
					// 客户端未声明即按「外部入口」记账，与本字段引入前的行为一致。
					body.taskSessionStartOriginDeclaredByClient ?? "external_entry_point",
				);
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
				// **会话 ≠ 卡片**。By the way 侧问会话的 taskId 是 `task-conversation-session-<uuid>`，看板上
				// 根本没有这张卡；它的启动参数（baseRef / worktreeMode / 权限档 / 模型）全在**宿主任务**的卡片上，
				// 工作目录也与宿主共用。此前这里拿会话 id 去找卡片，于是侧问会话的重启按钮恒定返回
				// 「Card not found in the workspace board.」——按钮点了等于没点。
				//
				// 口径与 startTaskSession 的同名变量严格一致（那边是 `body.workspaceTaskId ?? body.taskId`），
				// 两处一眼可对齐；这里的刷新请求不带 workspaceTaskId，故从会话自己的 summary 里取。
				//
				// 划界（下面每个用点都按这条规则）：`workspaceTaskId` **只**用于「读卡片取启动参数」与
				// 「解析工作目录」；任何**写回**一律以会话自身的 body.taskId 为键，否则侧问会话会把 agent 身份
				// 与模型污染到主卡上。
				const workspaceTaskId = currentSummary?.taskConversationSessionMetadata?.workspaceTaskId ?? body.taskId;
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				const card = findWorkspaceBoardCard(board, workspaceTaskId);
				if (!card) {
					return {
						ok: false,
						summary: null,
						error:
							workspaceTaskId === body.taskId
								? "Card not found in the workspace board."
								: "The board card hosting this conversation session no longer exists.",
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
				// 用 workspaceTaskId 解析工作目录：侧问会话与宿主任务共用同一个 worktree。用会话 id 解析会
				// 让 resolveExistingTaskCwdOrEnsure 的 ensure 以 session id 另造一个空 worktree，
				// 那才是「重启后什么上下文都没有」的实伤。
				//
				// 这里不再判 isHomeAgentSessionId：home agent 会话（`__home_agent__:<workspace>:<agent>`）
				// 在看板上没有卡片，上面那道守卫已经先把它拒了，该分支按构造走不到。前端也对应地藏起了它的
				// 重启按钮（agent-terminal-panel.tsx 的 `taskId.startsWith("__home_")`）。要让 home 会话真的
				// 可重启，需要为 card===null 补一整套启动参数来源（baseRef / worktreeMode / 权限档 / 模型全在
				// 卡片上），那是加功能，不在本路径的职责里。
				const taskCwd = await resolveExistingTaskCwdOrEnsure({
					cwd: workspaceScope.workspacePath,
					taskId: workspaceTaskId,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
				});
				// 「Restart terminal session」续的是这条会话自己的上一段对话，故模型一律以转录里读到的
				// 真实模型为准，卡片值只在探针问不出结论时兜底。带上会话的原生会话身份，让探针按 id 取，
				// 而不是按「工作目录里最近那段对话」——共用 cwd 时后者会把别人的模型套过来。
				const resumedTerminalAgentModelOverrideSettings =
					await resolveResumedTerminalAgentSessionModelOverrideSettings({
						agentId: resolved.agentId,
						// 写回以会话自身为键：侧问会话在看板上没有卡片，这次回写天然 no-op，绝不污染主卡。
						taskId: body.taskId,
						taskCwd,
						agentNativeConversationSessionIdentity: currentSummary?.agentNativeConversationSessionIdentity,
						workspaceScope,
						cardTerminalAgentModelOverrideSettings: card.terminalAgentModelOverrideSettings,
						broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
					});
				const refreshTaskTerminalRequest = {
					taskId: body.taskId,
					// 补回这两个字段（此前重建请求把它们丢了）：
					//   workspaceTaskId 决定 hook env 里的 KANBAN_TASK_ID 归属；
					//   taskConversationSessionMetadata 驱动侧问会话的只读约束（session-manager 的
					//   readOnlyQuestionSession），丢了就等于重启一次侧问会话它就能写文件了。
					// 且这份重建请求会覆盖 entry.restartRequest，残缺一次就会被此后的崩溃自动重启永久继承。
					workspaceTaskId,
					...(currentSummary?.taskConversationSessionMetadata
						? { taskConversationSessionMetadata: currentSummary.taskConversationSessionMetadata }
						: {}),
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
				};
				// 客户端未声明即按「人点的刷新」记账。前端的陈旧会话自动续跑打的是同一个入口，
				// 靠它显式声明 stale_session_client_auto_resume 才分得开。
				const refreshTaskSessionStartOrigin =
					body.taskSessionStartOriginDeclaredByClient ?? "refresh_task_terminal";
				// 「从既有对话迁入」（只有人在终端面板上选定后才会带）：先迁入、钉身份，再按 id 续跑。
				const summary = body.adoptExistingAgentConversationAsTaskSessionIdentity
					? await terminalManager.refreshTaskTerminal(refreshTaskTerminalRequest, refreshTaskSessionStartOrigin, {
							adoptExistingAgentConversationAsTaskSessionIdentity:
								body.adoptExistingAgentConversationAsTaskSessionIdentity,
						})
					: await terminalManager.refreshTaskTerminal(refreshTaskTerminalRequest, refreshTaskSessionStartOrigin);
				// 重启也是一次启动：把 agent 身份重新钉到卡片上，让「靠兜底才救回来的会话」在下一次硬中断时
				// 不必再靠兜底。
				//
				// 键**必须**是 body.taskId 而不是 workspaceTaskId（见上面的划界）：侧问会话在看板上没有卡片，
				// 这次写回对它天然 no-op；换成 workspaceTaskId 就会把侧问会话跑的 agent 写进主卡，
				// 主会话下一次硬中断后会被兜底解析成侧问用的那个 agent。
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
							// 补录来的问题出自某个**先前**的会话活体（转录里记着它、账本却没有），绝不能标成当前活体：
							// 那会让 UI 以为 agent 此刻正停在终端选择器上而默认折叠、投递也会去发 Esc。
							originRuntimeSessionIncarnationId: null,
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
						originRuntimeSessionIncarnationId: decision.originRuntimeSessionIncarnationId,
						recordedAnswerQuestionAnswers:
							decision.answer === null
								? null
								: (decision.answer.orderedQuestionAnswers ?? [
										{
											decisionQuestionId: "question-0",
											selectedOptionIds: decision.answer.selectedOptionIds,
											freeformText: decision.answer.freeformText,
										},
									]),
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
					deliverTaskSessionInput: async ({
						taskId,
						sessionTransport,
						text,
						originRuntimeSessionIncarnationId,
					}) => {
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
						// 与 RVF followup 那条路径一样交出争用能力：这条投递同样绝不能插进人类打了一半的那一行，
						// 而人不在场时把那半句无损暂存进 Prompt Library 再放行，对用户严格更好。
						// durable 待答答案只有在 base 的诚实回执确认提交后才标 delivered；同步 summary 只代表
						// 「已受理」。任何就绪超时、会话退出、被取代或提交确认失败都会结算 false，保留重试资格。
						const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
						// 提问它的那个活体还在、且仍停在提问回合：终端里此刻显示的是交互式选择器，不是输入框。
						// 直接粘贴会被选择器吞掉、回车会替用户选中高亮项——必须先关掉选择器并读屏确认输入框出现。
						// 会话已被回收 / resume 过（活体不同）则选择器早已不在，不发任何按键。
						const liveTerminalSummary = terminalManager.getSummary(taskId);
						const liveTerminalFacets = liveTerminalSummary ? resolveSessionFacets(liveTerminalSummary) : null;
						const agentIsStoppedOnThisQuestionSelectorInLiveTerminal =
							originRuntimeSessionIncarnationId !== null &&
							liveTerminalSummary?.runtimeSessionIncarnationId === originRuntimeSessionIncarnationId &&
							liveTerminalFacets?.turnOwner === "user" &&
							liveTerminalFacets.userTurnKind === "question";
						if (agentIsStoppedOnThisQuestionSelectorInLiveTerminal) {
							const selectorDismissalOutcome =
								await terminalManager.dismissAgentUserQuestionSelectorBeforeProgrammaticAnswerDelivery(taskId);
							if (!isAgentUserQuestionSelectorDismissedAndTerminalInputBoxVisible(selectorDismissalOutcome)) {
								// 抛出而不是返回 false：失败原因要原样进账本，让面板如实告诉用户卡在哪。
								throw new Error(`无法关闭终端里的提问选择器，答案未投递（${selectorDismissalOutcome}）`);
							}
						}
						const contentionPolicyConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
						let resolveConfirmedDelivery: (delivered: boolean) => void = () => undefined;
						const confirmedDelivery = new Promise<boolean>((resolve) => {
							resolveConfirmedDelivery = resolve;
						});
						const acceptedSummary = terminalManager.submitTaskChatInputWhenReady(taskId, text, {
							onDeliveryOutcome: (outcome) => {
								resolveConfirmedDelivery(outcome.status !== "delivery_failed");
							},
							mayAutoStashAbsentHumanInputBox:
								contentionPolicyConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
							preemptivelyStashHumanInputBox: async (contendedTaskId) => {
								const stash = await stashTaskTerminalInputBoxIntoPromptLibraryForWorkspaceScope({
									workspaceScope,
									taskId: contendedTaskId,
									scope: "task",
									initiatedBy: "programmatic_delivery_contention_preemption",
								});
								// 原样把 outcome 交回 manager：它要靠这个区分「瞬态失败，值得再等一拍」与
								// 「确定性失败，再等也是同一句话」，并把真实判据写进日志。折成布尔就把这两件事
								// 一起弄丢了（2026-08-20 事故的排查代价全压在这上面）。
								return stash.outcome;
							},
						});
						return acceptedSummary ? await confirmedDelivery : false;
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
		// 问答记录：已了结的 agent 提问与用户答案（含终端作答时写下的备注）。按需读取——只在用户展开
		// 问答记录时调用，故允许流式扫描该 task 的 Claude 转录做回填。
		listAgentRaisedUserDecisionHistoryForTask: async (workspaceScope, input) => {
			const taskId = input.taskId.trim();
			const records = await readAgentRaisedPendingUserDecisions(workspaceScope.workspaceId);
			const ledgerEntries = buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(records, taskId);
			const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
			const summary = terminalManager.getSummary(taskId);
			const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
			const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
			const agentId = summary?.agentId ?? card?.agentId ?? null;
			let transcriptEntries: Awaited<
				ReturnType<typeof buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts>
			> = [];
			if (agentId === "claude") {
				let taskCwd: string | null = null;
				try {
					taskCwd = isHomeAgentSessionId(taskId)
						? workspaceScope.workspacePath
						: card
							? await resolveTaskCwd({
									cwd: workspaceScope.workspacePath,
									taskId,
									baseRef: card.baseRef,
									ensure: false,
									worktreeMode: card.worktreeMode,
								})
							: null;
				} catch {
					// worktree 已不存在：只剩显式转录可回填。
				}
				const taskOwnsItsClaudeProjectDirectory =
					taskCwd !== null &&
					!isHomeAgentSessionId(taskId) &&
					resolve(taskCwd) !== resolve(workspaceScope.workspacePath);
				const currentNativeTranscriptPath =
					summary?.agentNativeConversationSessionIdentity?.sourceAgentId === "claude"
						? summary.agentNativeConversationSessionIdentity.transcriptPath
						: null;
				const transcriptFilePaths = await listClaudeTranscriptFilesForTaskUserDecisionHistory({
					explicitTranscriptFilePaths: currentNativeTranscriptPath ? [currentNativeTranscriptPath] : [],
					claudeProjectDirectoryOwnedExclusivelyByTask:
						taskOwnsItsClaudeProjectDirectory && taskCwd !== null
							? join(homedir(), ".claude", "projects", encodeClaudeProjectDirectoryName(taskCwd))
							: null,
				});
				transcriptEntries = await buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts({
					taskId,
					transcriptFilePaths,
				});
			}
			const taskRecords = records.filter((record) => record.taskId === taskId);
			return {
				historyEntries: mergeAgentRaisedUserDecisionHistoryEntries({
					ledgerEntries,
					transcriptEntries,
					toolUseIdsAlreadyRecordedInDecisionLedger: collectToolUseIdsAlreadyRecordedInDecisionLedger(
						records,
						taskId,
					),
					ledgerQuestionMarkdownsForTask: new Set(
						taskRecords.map((record) =>
							resolveAgentRaisedPendingUserDecisionOrderedQuestions(record)
								.map((question) => question.questionMarkdown)
								.join("\n"),
						),
					),
				}),
			};
		},
		dismissAgentRaisedPendingUserDecision: async (workspaceScope, input) => {
			try {
				const decisionId = input.decisionId.trim();
				if (!decisionId) {
					return { ok: false, error: "decisionId is required" };
				}
				// UI 可能还拿着同一次提问的重复记录的 id（旧版本一问两记），沿重复链找到真正在等答的那条。
				const dismissTarget = resolveAgentRaisedPendingUserDecisionThroughDuplicateSupersession(
					await readAgentRaisedPendingUserDecisions(workspaceScope.workspaceId),
					decisionId,
				);
				const dismissed = await dismissAgentRaisedPendingUserDecision(
					workspaceScope.workspaceId,
					dismissTarget?.decisionId ?? decisionId,
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
		// 三 transport 分派的实现体在 task-chat-message-send-across-session-transports.ts。
		// 搬出去是因为排队投递 dispatcher 也要用同一条出口，而它由 turn 结束边沿驱动、手上没有请求，
		// 拿不到这个每请求新建的 runtimeApi 闭包。
		sendTaskChatMessage: async (workspaceScope, input, kanbanRequestOriginActorEvidence) => {
			let taskChatSendResponse: RuntimeTaskChatSendResponse | null = null;
			try {
				taskChatSendResponse = await sendTaskChatMessageAcrossSessionTransports(
					{
						getScopedTerminalManager: deps.getScopedTerminalManager,
						getScopedClineTaskSessionService: deps.getScopedClineTaskSessionService,
						getScopedAcpTaskSessionService: deps.getScopedAcpTaskSessionService,
						loadScopedRuntimeConfig: deps.loadScopedRuntimeConfig,
						resolveClineTaskSessionLaunchConfig: async () => await clineProviderService.resolveLaunchConfig(),
						...(deps.broadcastTaskChatCleared ? { broadcastTaskChatCleared: deps.broadcastTaskChatCleared } : {}),
					},
					workspaceScope,
					input,
				);
				return taskChatSendResponse;
			} finally {
				recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking({
					workspaceId: workspaceScope.workspaceId,
					taskChatSendRequest: input,
					taskChatSendResponse,
					kanbanRequestOriginActorEvidence,
				});
			}
		},
		// 恢复期被暂存的 harness 通知：只读列出。UI 据此决定要不要渲染一键放行入口。
		getDeferredRestorationHarnessNotifications: async (workspaceScope, input) => {
			try {
				const deferredRecords = await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
					workspaceId: workspaceScope.workspaceId,
					taskId: input.taskId,
				});
				return {
					ok: true,
					notifications: deferredRecords.map((record) => ({
						sourceHarness: record.sourceHarness,
						receivedAt: record.receivedAt,
						promptTextPreview: record.promptText.slice(0, DEFERRED_RESTORATION_NOTIFICATION_PREVIEW_LENGTH),
					})),
				};
			} catch (error) {
				return {
					ok: false,
					notifications: [],
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		// 一键放行：消费账本 → 组装成一条 prompt → 经既有 sendTaskChatMessage 出口投递 → 解除恢复守卫。
		// 解除守卫是必须的：用户点放行就是最明确不过的「显式用户输入」，不解除的话下一条通知照样被拦回去，
		// 用户得一条一条点，等于没修。
		releaseDeferredRestorationHarnessNotificationsIntoTaskSession: async (workspaceScope, input) => {
			let consumedRecords: RestorationDeferredHarnessGeneratedPrompt[] = [];
			try {
				consumedRecords = await consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
					workspaceId: workspaceScope.workspaceId,
					taskId: input.taskId,
				});
				const releasedPromptText =
					formatDeferredHarnessGeneratedPromptsAsExplicitUserReleasedPrompt(consumedRecords);
				if (releasedPromptText === undefined) {
					return { ok: true, releasedNotificationCount: 0 };
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				terminalManager.disarmRestorationContinuationGuard?.(input.taskId);
				terminalManager.completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn?.(
					input.taskId,
				);
				// 终端通道是「先受理、后落定」：同步返回最多到 accepted_pending_submit_confirmation，
				// 而那**不表示成功**（见 task-message-injection-ledger.ts）。账本此刻已经被 consume 掉，
				// 拿「受理了」当成功，等于在投递其实失败时把 agent 在等的唤醒信号永久弄丢。
				// 因此这里登记回执并等它落定，据实回报——放行要么真送达，要么如实失败且通知回到账本可重试。
				let settleTerminalDeliveryOutcome: (outcome: TaskChatInputDeliveryOutcome) => void = () => {};
				const terminalDeliveryOutcome = new Promise<TaskChatInputDeliveryOutcome>((resolve) => {
					settleTerminalDeliveryOutcome = resolve;
				});
				const sendResponse = await sendTaskChatMessageAcrossSessionTransports(
					{
						getScopedTerminalManager: deps.getScopedTerminalManager,
						getScopedClineTaskSessionService: deps.getScopedClineTaskSessionService,
						getScopedAcpTaskSessionService: deps.getScopedAcpTaskSessionService,
						loadScopedRuntimeConfig: deps.loadScopedRuntimeConfig,
						resolveClineTaskSessionLaunchConfig: async () => await clineProviderService.resolveLaunchConfig(),
						...(deps.broadcastTaskChatCleared ? { broadcastTaskChatCleared: deps.broadcastTaskChatCleared } : {}),
						onProgrammaticTerminalDeliverySettled: (outcome) => {
							settleTerminalDeliveryOutcome(outcome);
						},
					},
					workspaceScope,
					{
						taskId: input.taskId,
						text: releasedPromptText,
						// 刻意**不带** source：统一发送出口把「带 source」判成后台自动注入
						// （deferWhileUserTurn=true），于是遇上恢复出来那种正等用户拍板的会话就一路让位到
						// 预算耗尽、终态 agent_awaiting_user_decision_timeout，放行永远送不出去。
						// 而放行是用户显式点的按钮，按真人输入投递才是实情。
					},
				);
				if (!sendResponse.ok) {
					// consume 是破坏性的。投递没成功就必须把通知原样放回账本，否则用户点一次按钮就把
					// 唤醒信号永久弄丢了——那比一开始被拦住还糟。
					await restoreConsumedDeferredRestorationNotifications(workspaceScope.workspaceId, consumedRecords);
					return {
						ok: false,
						releasedNotificationCount: 0,
						error: sendResponse.error ?? "投递失败，已把通知放回暂存账本",
					};
				}
				if (sendResponse.terminalDelivery?.status === "accepted_pending_submit_confirmation") {
					const settledDeliveryOutcome = await terminalDeliveryOutcome;
					if (
						!TERMINAL_DELIVERY_STATUSES_MEANING_RELEASED_PROMPT_REACHED_AGENT.has(settledDeliveryOutcome.status)
					) {
						await restoreConsumedDeferredRestorationNotifications(workspaceScope.workspaceId, consumedRecords);
						return {
							ok: false,
							releasedNotificationCount: 0,
							error: `终端投递未送达（${settledDeliveryOutcome.status}${
								settledDeliveryOutcome.reason === null ? "" : `:${settledDeliveryOutcome.reason}`
							}），已把通知放回暂存账本`,
						};
					}
				}
				return { ok: true, releasedNotificationCount: consumedRecords.length };
			} catch (error) {
				await restoreConsumedDeferredRestorationNotifications(workspaceScope.workspaceId, consumedRecords);
				return {
					ok: false,
					releasedNotificationCount: 0,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		// 取消一条在途程序化投递。账本的终态改写不在这里做——取消成功时 session-manager 会经
		// 投递登记的 observer 触发同一条回写路径（delivery_failed{cancelled_before_delivery}），
		// 与「确认落定」共用那一把写一次即定的锁，取消与确认的竞争因此是确定性的。
		cancelTaskChatDelivery: async (workspaceScope, input) => {
			try {
				// 还在等 agent 空闲的程序化排队投递不在 PTY 单飞槽里，PTY 取消对它无效——先在队列里撤下它。
				const cancelledWhileAwaitingAgentIdle = await cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle(
					{ notifyQueueMutated: deps.queuedTaskPromptDeliveryDispatcher?.notifyQueueMutated },
					workspaceScope.workspaceId,
					input.taskId,
					input.idempotencyKey,
				);
				if (cancelledWhileAwaitingAgentIdle !== null) {
					return { ok: true, cancelResult: cancelledWhileAwaitingAgentIdle };
				}
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
		getWorkspacePromptLibrary: async (workspaceScope) => {
			try {
				return { ok: true, library: await readWorkspacePromptLibrarySnapshot(workspaceScope.workspaceId) };
			} catch (error) {
				return {
					ok: false,
					library: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		mutateWorkspacePromptLibrary: async (workspaceScope, input) => {
			try {
				return {
					ok: true,
					library: await mutateWorkspacePromptLibrary(workspaceScope.workspaceId, input.mutation),
				};
			} catch (error) {
				// library 返回 null 而不是「变更前的快照」：写失败时前端必须知道自己手上的那份不再可信，
				// 拿一份看起来正常的旧快照回去会让用户以为改动生效了。
				return {
					ok: false,
					library: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		getTaskPromptDeliveryQueue: async (workspaceScope) => {
			try {
				const queue = await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceScope.workspaceId);
				return {
					ok: true,
					queue,
					projectedEntriesByTaskId:
						(await deps.queuedTaskPromptDeliveryDispatcher?.buildProjectedEntriesByTaskId(
							workspaceScope.workspaceId,
							queue,
						)) ?? null,
				};
			} catch (error) {
				return {
					ok: false,
					queue: null,
					projectedEntriesByTaskId: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		mutateTaskPromptDeliveryQueue: async (workspaceScope, input, kanbanRequestOriginActorEvidence) => {
			const { mutation } = input;
			const workspaceId = workspaceScope.workspaceId;
			try {
				if (
					mutation.kind === "enqueue_prompt_for_delivery_after_current_turn" &&
					mutation.text.trim().length === 0
				) {
					return {
						ok: false,
						queue: null,
						projectedEntriesByTaskId: null,
						error: "A queued prompt cannot be empty.",
					};
				}
				// 已经交给 transport 的条目 store 的 cancel 意图动不了它（那是「可能已经发出去了」的状态），
				// 得先走既有 cancelTaskChatDelivery；拦下之后由投递那条路径把它结算成 cancelled。
				// 其余状态（queued / claimed_for_dispatch）由下面的 store 意图就地取消。
				const inFlightDeliveryCancelResult =
					mutation.kind === "cancel_queued_prompt_delivery"
						? ((await deps.queuedTaskPromptDeliveryDispatcher?.cancelInFlightQueuedPromptDelivery(
								workspaceId,
								mutation.taskId,
								mutation.queueEntryId,
							)) ?? null)
						: null;
				const { snapshot: queue, newlyCreatedQueueEntries } =
					await mutateWorkspaceQueuedTaskPromptDeliveriesAndReportNewlyCreatedQueueEntries(workspaceId, mutation);
				const taskEntries = queue.entriesByTaskId[mutation.taskId] ?? [];
				// 入队 / 重排被拒与幂等重发在快照上长得一样（都是原样返回），只能事后按「那条在不在」+「满没满」分辨。
				const expectedNewQueueEntryId =
					mutation.kind === "enqueue_prompt_for_delivery_after_current_turn"
						? mutation.queueEntryId
						: mutation.kind === "retry_settled_failed_queued_prompt_delivery"
							? mutation.replacementQueueEntryId
							: null;
				const enqueueRefusedBecauseQueueCapacityIsExhausted =
					expectedNewQueueEntryId !== null &&
					!taskEntries.some((entry) => entry.queueEntryId === expectedNewQueueEntryId) &&
					isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask(queue, mutation.taskId);
				// dd2db T2：人排条目也是一次投递请求。只有锁内真的新建了条目才是新意图（同 id 重发、满额被拒都不算）。
				for (const newlyCreatedQueueEntry of newlyCreatedQueueEntries) {
					recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking({
						workspaceId,
						newlyCreatedQueueEntry,
						retriedFromSettledFailedQueueEntryId:
							mutation.kind === "retry_settled_failed_queued_prompt_delivery" ? mutation.queueEntryId : null,
						kanbanRequestOriginActorEvidence,
					});
				}
				await deps.queuedTaskPromptDeliveryDispatcher?.notifyQueueMutated(workspaceId, mutation.taskId, queue);
				return {
					ok: !enqueueRefusedBecauseQueueCapacityIsExhausted,
					queue,
					projectedEntriesByTaskId:
						(await deps.queuedTaskPromptDeliveryDispatcher?.buildProjectedEntriesByTaskId(workspaceId, queue)) ??
						null,
					...(enqueueRefusedBecauseQueueCapacityIsExhausted
						? {
								enqueueRefusedBecauseQueueCapacityIsExhausted: true,
								error: isQueuedTaskPromptDeliveryWorkspaceQueueFull(queue)
									? "This project already has the maximum number of queued prompts across all tasks."
									: "This task already has the maximum number of queued prompts.",
							}
						: {}),
					inFlightDeliveryCancelResult,
				};
			} catch (error) {
				// 与 prompt library 同理：写失败时 queue 返回 null 而不是「变更前的快照」，前端必须知道手上那份不再可信。
				return {
					ok: false,
					queue: null,
					projectedEntriesByTaskId: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		enqueueAgentIdleGatedProgrammaticTaskChatMessage: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) => {
			try {
				const enqueueResponse = await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
					{ notifyQueueMutated: deps.queuedTaskPromptDeliveryDispatcher?.notifyQueueMutated },
					workspaceScope.workspaceId,
					input,
				);
				if (enqueueResponse.ok && enqueueResponse.injectionLedgerRecordDisposition === "created") {
					recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking({
						workspaceId: workspaceScope.workspaceId,
						taskId: input.taskId.trim(),
						messageBodyText: input.text,
						taskMessageDeliveryIdempotencyKey: input.idempotencyKey.trim(),
						declaredMessageSourceLabel: input.source.trim(),
						queuedPromptDeliveryQueueEntryId: buildQueuedProgrammaticInjectionQueueEntryId(
							input.idempotencyKey.trim(),
						),
						maxWaitForAgentIdleMs: input.maxWaitForAgentIdleMs,
						kanbanRequestOriginActorEvidence,
					});
				}
				return enqueueResponse;
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		getWorkspaceTaskEditDrafts: async (workspaceScope) => {
			try {
				return { ok: true, drafts: await readWorkspaceTaskEditDraftsSnapshot(workspaceScope.workspaceId) };
			} catch (error) {
				return {
					ok: false,
					drafts: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		mutateWorkspaceTaskEditDrafts: async (workspaceScope, input) => {
			try {
				// 浏览器镜像是迁移的种子且刻意不删，于是每次页面加载都会整份重发；任务被删掉之后镜像里那条仍在。
				// 不在入口拦掉，saveState 的差集清理刚清掉的草稿下一次加载就被原样迁回来（见
				// discard-task-edit-drafts-for-tasks-removed-from-board.ts）。
				const mutation = await withMigratedTaskEditDraftsForTasksNoLongerOnBoardDropped(
					workspaceScope.workspaceId,
					input.mutation,
				);
				return {
					ok: true,
					drafts: await mutateWorkspaceTaskEditDrafts(workspaceScope.workspaceId, mutation),
				};
			} catch (error) {
				// 同 prompt library：写失败时回 null 而不是变更前的快照。拿一份看起来正常的旧快照回去，
				// 会让用户以为草稿已经存下了。
				return {
					ok: false,
					drafts: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		// W2 Ctrl+S 暂存：读框 → 回填折叠粘贴 → 写库 → 转发 Ctrl+S 清框。
		//
		// 顺序不可交换：**先写库、后清框**。反过来一旦写库失败，用户打了一半的字既不在库里、又已被清出框，
		// 只剩 agent 自己的暂存区里一份用户未必知道存在的副本。按现在的顺序，任何一步失败都保证「库里没有
		// ⇒ 框里还在」。
		//
		// 整条链路跑在 manager 的 per-task 独占闸门里（串行化的真实落点在那边：manager 是 per-workspace
		// 长驻单例，这个 handler 是每次请求新建的无状态闭包，把在途集合放这里既会随作用域丢失、也拦不住
		// 多标签页）。清框那一步回传取文时的 incarnation 令牌，并且**必须看它的返回值**——写库跨文件锁与
		// 落盘期间用户可能已经 refresh 了终端。
		stashTerminalInputBoxToPromptLibrary: async (workspaceScope, input) =>
			await stashTaskTerminalInputBoxIntoPromptLibraryForWorkspaceScope({
				workspaceScope,
				taskId: input.taskId,
				scope: input.scope ?? "task",
				initiatedBy: "human_pressed_stash_key_in_terminal",
			}),
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
		broadcastNotificationArchiveChanged: async () => {
			for (const workspace of await listWorkspaceIndexEntries())
				await deps.broadcastNotificationLogUpdated?.(workspace.workspaceId);
		},
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
		switchAgentSessionTransport: async (workspaceScope, input, kanbanRequestOriginActorEvidence) => {
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
					// 先移交身份再摘除 ACP 账本；PTY 的恢复解析器只读自己的 summary。
					if (acpStoppedSummary?.agentNativeConversationSessionIdentity) {
						if (!terminalManager.getSummary(body.taskId))
							terminalManager.hydrateFromRecord({ [body.taskId]: acpStoppedSummary });
						terminalManager.applyAgentNativeConversationSessionIdentity(
							body.taskId,
							acpStoppedSummary.agentNativeConversationSessionIdentity,
						);
					}
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
							"agent_session_transport_switch",
						);
					}
				}

				// 3) 把新通道固化到卡上，使「下次启动」（含崩溃后自动续跑、从垃圾桶拖回）也走新通道。
				//    updateTask 里非三态的字段漏传会被复位，故必须从卡片原值显式回填——与
				//    persistResolvedTerminalAgentSessionModelOverrideSettingsOntoCard 同一注意事项。
				//    行动者按请求发起方证据解析（Web UI 目前无 nonce → direct_runtime_trpc_caller，1a.3 接 nonce）；
				//    必须在 board 锁之外解析，lookups 会读 board.json。
				const cardMutation = await mutateWorkspaceState(
					workspaceScope.workspacePath,
					await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
						taskMutationIntentKind: "runtime_trpc_switch_agent_session_transport_persist_onto_card",
						kanbanRequestOriginActorEvidence,
					}),
					(state) => {
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
					},
				);
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
					// 会话模式同样是「下次启动生效」的卡字段（与上方「不重放 startInPlanMode」无关——
					// 那条说的是会话内 plan/act 模式），本次重开就是下次启动，从卡片原值显式回填。
					taskConversationMode: card.taskConversationMode,
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
