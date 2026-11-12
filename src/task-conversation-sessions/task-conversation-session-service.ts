import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { assertRuntimeAgentIsNotRetired, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import { doesAgentSupportSessionTransport } from "../core/agent-session-transport-selection";
import type {
	QueuedTaskPromptDeliveryEntry,
	RuntimeAgentId,
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse,
	RuntimeAgentSessionTransport,
	RuntimeBoardData,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
	RuntimeTaskConversationSessionCreateRequest,
	RuntimeTaskConversationSessionCreateResponse,
	RuntimeTaskConversationSessionGetRequest,
	RuntimeTaskConversationSessionGetResponse,
	RuntimeTaskConversationSessionListResponse,
	RuntimeTaskConversationSessionPreviewResponse,
	RuntimeTaskConversationSessionRenameRequest,
	RuntimeTaskConversationSessionReportRequest,
	RuntimeTaskConversationSessionReportResponse,
	RuntimeTaskConversationSessionResumeRequest,
	RuntimeTaskConversationSessionResumeResponse,
	RuntimeTaskNameSuggestionResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import {
	assertCreationPlanModeWasExplicitlySelected,
	resolveCreationStartupSettings,
} from "../core/creation-startup-settings";
import {
	isAgentAwaitingModalUserDecision,
	resolveSessionFacets,
	resolveTaskConversationSessionMainContextForkSelection,
} from "../core/session-activity";
import {
	isForkedTaskConversationSessionContext,
	resolveRecordedTaskConversationSessionContextSource,
} from "../core/task-conversation-session-context-source";
import {
	doesConversationSessionBelongToTask,
	resolveMainTaskConversationSessionId,
} from "../core/task-main-conversation-session-binding";
import { isTaskCardShelved } from "../core/task-shelving-state";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	getThisRuntimeProcessInstanceId,
	readRuntimeProcessInstanceLiveness,
} from "../state/runtime-process-instance-heartbeat-registry";
import {
	computeAssistantMessageProvenanceSha256,
	parseExplicitTaskConversationSessionReport,
} from "./explicit-session-report";
import {
	claimTaskConversationSessionEvidenceProbe,
	createTaskConversationSessionOperationStore,
	emptyTaskConversationSessionRecoveryEvidence,
	type TaskConversationSessionCreationRecord,
	type TaskConversationSessionOperationStore,
	type TaskConversationSessionReportRecord,
	type TaskConversationSessionWorkspaceScope,
} from "./task-conversation-session-operation-store";

export interface TaskConversationSessionServiceDependencies {
	storageRootDirectoryPath?: string;
	suggestNames?(basisText: string, operationId: string): Promise<RuntimeTaskNameSuggestionResponse>;
	readRecordedNameSuggestionResult?(
		basisText: string,
		operationId: string,
	): Promise<RuntimeTaskNameSuggestionResponse | null>;
	compareAndSetSessionName?(
		scope: TaskConversationSessionWorkspaceScope,
		input: RuntimeTaskConversationSessionRenameRequest,
		source: "explicit" | "automatic",
	): Promise<boolean>;
	readCreationDefaults?(
		scope: TaskConversationSessionWorkspaceScope,
		agentId: RuntimeAgentId,
		codexConfigurationProfileId?: string,
		explicitModelId?: string,
	): Promise<{
		modelId: string | null;
		sessionTransport?: RuntimeAgentSessionTransport;
		codexConfigurationProfileId?: string;
	}>;
	readDefaultTaskAgentPermissionMode?(
		scope: TaskConversationSessionWorkspaceScope,
	): Promise<RuntimeTaskAgentPermissionMode>;
	readStartupEnvironmentFingerprint?(
		scope: TaskConversationSessionWorkspaceScope,
		request: RuntimeTaskSessionStartRequest,
	): Promise<string>;
	now?: () => number;
	readState(
		scope: TaskConversationSessionWorkspaceScope,
	): Promise<{ board: RuntimeBoardData; sessions: Record<string, RuntimeTaskSessionSummary> }>;
	startSession(
		scope: TaskConversationSessionWorkspaceScope,
		request: RuntimeTaskSessionStartRequest,
		beforeLaunch: () => Promise<void>,
	): Promise<RuntimeTaskSessionStartResponse>;
	resumeSession(
		scope: TaskConversationSessionWorkspaceScope,
		summary: RuntimeTaskSessionSummary,
		beforeLaunch: (launchingSummary: RuntimeTaskSessionSummary) => Promise<void>,
	): Promise<RuntimeTaskSessionStartResponse>;
	stopResumedSession(
		scope: TaskConversationSessionWorkspaceScope,
		ownedSummary: RuntimeTaskSessionSummary,
	): Promise<{ cancellationRequested: boolean; processExitConfirmed: boolean }>;
	verifyAssistantReportOrigin(
		scope: TaskConversationSessionWorkspaceScope,
		source: RuntimeTaskSessionSummary,
		nativeMessageIdentity: string,
		cursor: string | null,
		assistantMessageProvenanceSha256?: string,
	): Promise<{ status: "verified" | "inherited" | "pending"; nextCursor: string | null; notice?: string }>;
	readHistory(
		scope: TaskConversationSessionWorkspaceScope,
		request: RuntimeTaskConversationHistoryPageRequest,
	): Promise<RuntimeTaskConversationHistoryPageResponse>;
	enqueueReport(
		scope: TaskConversationSessionWorkspaceScope,
		request: RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
	): Promise<RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse>;
	cancelReport(scope: TaskConversationSessionWorkspaceScope, taskId: string, idempotencyKey: string): Promise<void>;
	readReportAcceptance(
		scope: TaskConversationSessionWorkspaceScope,
		taskId: string,
		idempotencyKey: string,
	): Promise<"pending" | "accepted" | "failed" | null>;
}

class TaskConversationSessionExecutionProhibitedError extends Error {}
class TaskConversationSessionContextSourceChangedError extends Error {}
class TaskConversationSessionBoundResumeError extends Error {
	constructor(
		readonly status: "identity_unknown" | "identity_mismatch" | "unsupported",
		message: string,
	) {
		super(message);
	}
}
class TaskConversationSessionIdempotencyConflictError extends Error {
	constructor(readonly creation: RuntimeTaskConversationSessionCreateResponse["creation"]) {
		super("相同幂等键已用于不同的会话创建内容。");
	}
}

function creationRequestFingerprint(input: RuntimeTaskConversationSessionCreateRequest, creatorId: string) {
	return createHash("sha256")
		.update(
			JSON.stringify({ ...input, creatorTaskConversationSessionId: creatorId, cols: undefined, rows: undefined }),
		)
		.digest("hex");
}

function resolveCreationContextSource(
	input: RuntimeTaskConversationSessionCreateRequest,
	card: NonNullable<ReturnType<typeof findCard>>,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	agentId: RuntimeAgentId,
	creatorId: string,
) {
	const sourceId =
		input.contextSource === "fresh"
			? null
			: input.contextSource === "current_main"
				? (input.contextSourceTaskConversationSessionId ?? resolveMainTaskConversationSessionId(card))
				: creatorId;
	const source = sourceId ? requireSession(sessions, sourceId, input.taskId) : null;
	if (source) {
		const selection = resolveTaskConversationSessionMainContextForkSelection({
			sessionRole: "task_collaborator",
			workspaceTaskId: input.taskId,
			launchAgentId: agentId,
			mainSessionSummary: source,
			mainSessionWorkingDirectoryPath: source.workspacePath,
			existingTaskConversationSessionSummaries: Object.values(sessions),
		});
		if (selection.forkRejectionReason)
			throw new Error(selection.forkRejectionReason.replaceAll("主会话", "来源会话"));
	}
	return { sourceId, source };
}

function sessionStartupFailed(
	summary: RuntimeTaskSessionSummary | undefined,
	requestId: string,
): summary is RuntimeTaskSessionSummary {
	return (
		summary !== undefined &&
		summary.taskConversationSessionMetadata?.creationRequestId === requestId &&
		resolveSessionFacets(summary).liveness === "failed"
	);
}

function sessionStartupConfirmed(summary: RuntimeTaskSessionSummary | undefined, requestId: string): boolean {
	return (
		summary !== undefined &&
		summary.taskConversationSessionMetadata?.creationRequestId === requestId &&
		summary.startedAt !== null &&
		resolveSessionFacets(summary).liveness !== "failed"
	);
}

function findCard(board: RuntimeBoardData, taskId: string) {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
}

function assertTaskAllowsExecution(board: RuntimeBoardData, taskId: string, incarnation?: number) {
	const column = board.columns.find((column) => column.cards.some((card) => card.id === taskId));
	const card = column?.cards.find((card) => card.id === taskId);
	if (!card || (incarnation !== undefined && card.createdAt !== incarnation))
		throw new TaskConversationSessionExecutionProhibitedError("任务不存在或已换代。");
	if (column?.id === "trash" || isTaskCardShelved(card))
		throw new TaskConversationSessionExecutionProhibitedError("任务已停止执行、已结案或已搁置。");
	return card;
}

function requireSession(sessions: Record<string, RuntimeTaskSessionSummary>, sessionId: string, taskId: string) {
	const summary = sessions[sessionId];
	if (!summary || !doesConversationSessionBelongToTask(summary, taskId) || !summary.agentId)
		throw new Error("目标会话不存在、不属于同一任务或不是可用的 Agent 会话。");
	assertRuntimeAgentIsNotRetired(summary.agentId);
	if (!isRuntimeAgentLaunchSupported(summary.agentId))
		throw new Error("目标会话不存在、不属于同一任务或不是可用的 Agent 会话。");
	return summary;
}

// CLI 身份由运行时核对宿主、会话与可用的原生声明。不能让正文里的来源 ID 覆盖调用环境。
function resolveCreatorSessionId(
	input: { taskId: string; creatorTaskConversationSessionId?: string },
	evidence: KanbanRequestOriginActorEvidence,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	mainSessionId: string,
	workspaceId: string,
) {
	const decoded = evidence.decodedCliActorClaimsRequestHeader;
	if (decoded.cliActorClaimsRequestHeaderStatus === "present_but_malformed")
		throw new Error("调用会话身份声明不可读。");
	if (decoded.cliActorClaimsRequestHeaderStatus === "present") {
		const claimed = decoded.claims.claimedEnvironmentVariableValuesByName;
		const sessionId = claimed.KANBAN_TASK_CONVERSATION_SESSION_ID ?? claimed.KANBAN_TASK_ID;
		if (
			claimed.KANBAN_TASK_ID !== input.taskId ||
			(claimed.KANBAN_HOOK_WORKSPACE_ID && claimed.KANBAN_HOOK_WORKSPACE_ID !== workspaceId) ||
			!sessionId ||
			(input.creatorTaskConversationSessionId && input.creatorTaskConversationSessionId !== sessionId)
		)
			throw new Error("创建者必须是当前任务的实际调用会话。");
		const summary = requireSession(sessions, sessionId, input.taskId);
		const claimedNativeId =
			summary.agentId === "codex"
				? claimed.CODEX_THREAD_ID
				: summary.agentId === "claude"
					? claimed.CLAUDE_CODE_SESSION_ID
					: summary.agentId === "cursor"
						? claimed.CURSOR_CONVERSATION_ID
						: undefined;
		if (claimedNativeId && claimedNativeId !== summary.agentNativeConversationSessionIdentity?.nativeSessionId)
			throw new Error("调用会话原生身份已变化。");
		return sessionId;
	}
	return input.creatorTaskConversationSessionId ?? mainSessionId;
}

async function evidenceFingerprint(summary: RuntimeTaskSessionSummary | undefined): Promise<string> {
	const identity = summary?.agentNativeConversationSessionIdentity;
	const transcript = identity?.transcriptPath ? await stat(identity.transcriptPath).catch(() => null) : null;
	const endpoint = summary?.codexNativeSessionControlEndpoint;
	const socket = endpoint ? await stat(endpoint.socketPath).catch(() => null) : null;
	return JSON.stringify([
		identity,
		summary?.runtimeSessionIncarnationId,
		summary?.lastHookAt,
		summary?.agentSessionRuntimeReclamationOutcome,
		endpoint,
		transcript && [transcript.ino, transcript.size, transcript.mtimeMs],
		socket && [socket.ino, socket.mtimeMs],
	]);
}

export function createTaskConversationSessionService(deps: TaskConversationSessionServiceDependencies) {
	const operations = createTaskConversationSessionOperationStore(deps.storageRootDirectoryPath);
	const now = deps.now ?? Date.now;
	const launchesInFlight = new Set<string>();
	const namingInFlight = new Set<string>();
	const reconciliationsInFlight = new Map<string, Promise<void>>();
	const boundResumesInFlight = new Map<
		string,
		{ fingerprint: string; result: Promise<RuntimeTaskConversationSessionResumeResponse> }
	>();
	let closed = false;
	const resolveStartupSettings = async (
		scope: TaskConversationSessionWorkspaceScope,
		input: RuntimeTaskConversationSessionCreateRequest,
		agentId: RuntimeAgentId,
	) => {
		assertCreationPlanModeWasExplicitlySelected(input.startInPlanMode);
		if (
			input.modelId &&
			input.terminalAgentModelOverrideSettings &&
			input.modelId !== input.terminalAgentModelOverrideSettings.modelId
		)
			throw new Error("两项模型覆盖相互冲突，未预留或创建会话。");
		if (
			(input.modelId || input.terminalAgentModelOverrideSettings) &&
			!["claude", "codex", "cursor", "kimi", "omp"].includes(agentId)
		)
			throw new Error("所选 Agent 暂不支持单次模型覆盖。");
		if (input.terminalAgentModelOverrideSettings && input.terminalAgentModelOverrideSettings.agentId !== agentId)
			throw new Error("模型选择的 Agent 与本次会话不一致。");
		const defaults = await deps.readCreationDefaults?.(
			scope,
			agentId,
			input.codexConfigurationProfileId,
			input.modelId ?? input.terminalAgentModelOverrideSettings?.modelId,
		);
		const settings = resolveCreationStartupSettings({
			...input,
			codexConfigurationPermissionSelectionSource:
				input.codexConfigurationPermissionSelectionSource ??
				(input.codexConfigurationProfileId && input.taskAgentPermissionMode === undefined
					? "profile"
					: "task_local"),
			agentId,
			agentSelectionSource: input.agentId ? "explicit_request" : "creator_session_agent",
			modelId: input.modelId ?? input.terminalAgentModelOverrideSettings?.modelId,
			defaultModelId: defaults?.modelId,
			defaultSessionTransport: defaults?.sessionTransport,
			codexConfigurationProfileId: input.codexConfigurationProfileId,
			defaultCodexConfigurationProfileId: defaults?.codexConfigurationProfileId,
		});
		if (!doesAgentSupportSessionTransport(agentId, settings.sessionTransport.value))
			throw new Error("所选 Agent 不支持该会话通道。");
		return settings;
	};
	const reconcileName = async (
		scope: TaskConversationSessionWorkspaceScope,
		record: TaskConversationSessionCreationRecord,
	) => {
		if (
			closed ||
			!deps.suggestNames ||
			!deps.compareAndSetSessionName ||
			namingInFlight.has(record.progress.requestId)
		)
			return;
		const naming = record.nameSuggestion;
		if (!naming || ["completed", "unavailable"].includes(naming.status)) return;
		namingInFlight.add(record.progress.requestId);
		try {
			const stopped = (await operations.read(scope)).explicitlyStoppedSessionIds;
			if (
				stopped.includes(record.progress.taskConversationSessionId) ||
				stopped.includes(record.progress.creatorTaskConversationSessionId) ||
				stopped.includes(record.progress.taskId)
			)
				return;
			if (naming.status === "request_may_have_started") {
				const original = naming.basisText
					? await deps.readRecordedNameSuggestionResult?.(naming.basisText, naming.operationId)
					: null;
				if (!original) return;
				const name = original.status === "suggested" ? original.suggestedTaskNames[0] : undefined;
				await operations.update(scope, (store) => {
					const current = store.creations.find(
						(entry) => entry.progress.requestId === record.progress.requestId,
					)?.nameSuggestion;
					if (current) {
						current.status = name ? "result_available" : "unavailable";
						current.suggestedName = name;
						current.notice = undefined;
					}
				});
				naming.status = name ? "result_available" : "unavailable";
				naming.suggestedName = name;
				if (!name) return;
			}
			const state = await deps.readState(scope);
			const card = findCard(state.board, record.progress.taskId);
			const session = state.sessions[record.progress.taskConversationSessionId];
			if (
				!card ||
				card.createdAt !== record.progress.taskIncarnationCreatedAt ||
				!session ||
				session.taskConversationSessionMetadata?.creationRequestId !== record.progress.requestId
			)
				return;
			const metadata = session.taskConversationSessionMetadata;
			if (
				(metadata.conversationSessionNameVersion ?? 0) !== naming.expectedNameVersion ||
				metadata.conversationSessionNameSource === "explicit"
			) {
				await operations.update(scope, (store) => {
					const current = store.creations.find(
						(entry) => entry.progress.requestId === record.progress.requestId,
					)?.nameSuggestion;
					if (current) current.status = "completed";
				});
				return;
			}
			if (naming.status === "waiting_for_real_input") {
				const acceptance = session.agentConversationPromptSubmissionAcceptance;
				const text = metadata.latestUserMessagePreview?.trim();
				if (!text || acceptance?.status !== "accepted" || acceptance.attemptedAtMs < record.progress.createdAt)
					return;
				await operations.update(scope, (store) => {
					const current = store.creations.find(
						(entry) => entry.progress.requestId === record.progress.requestId,
					)?.nameSuggestion;
					if (current?.status === "waiting_for_real_input") {
						current.basisText = text;
						current.status = "ready";
					}
				});
				naming.basisText = text;
				naming.status = "ready";
			}
			if (naming.status === "ready" && naming.basisText) {
				const claimed = await operations.update(scope, (store) => {
					const current = store.creations.find(
						(entry) => entry.progress.requestId === record.progress.requestId,
					)?.nameSuggestion;
					if (current?.status !== "ready" || current.basisText !== naming.basisText) return false;
					current.status = "request_may_have_started";
					current.notice = "命名调用结果未知时只等待原结果，不自动重复付费。";
					return true;
				});
				if (!claimed) return;
				const response = await deps.suggestNames(naming.basisText, naming.operationId);
				const suggestedName = response.status === "suggested" ? response.suggestedTaskNames[0] : undefined;
				await operations.update(scope, (store) => {
					const current = store.creations.find(
						(entry) => entry.progress.requestId === record.progress.requestId,
					)?.nameSuggestion;
					if (current) {
						current.status = suggestedName ? "result_available" : "unavailable";
						current.suggestedName = suggestedName;
						current.notice = undefined;
					}
				});
				naming.suggestedName = suggestedName;
				if (!suggestedName) return;
			}
			if (naming.suggestedName) {
				const stoppedNow = (await operations.read(scope)).explicitlyStoppedSessionIds;
				if (
					closed ||
					[
						record.progress.taskConversationSessionId,
						record.progress.creatorTaskConversationSessionId,
						record.progress.taskId,
					].some((id) => stoppedNow.includes(id))
				)
					return;
				await deps.compareAndSetSessionName(
					scope,
					{
						taskId: record.progress.taskId,
						expectedTaskIncarnationCreatedAtEpochMs: record.progress.taskIncarnationCreatedAt,
						taskConversationSessionId: record.progress.taskConversationSessionId,
						expectedNameVersion: naming.expectedNameVersion,
						conversationSessionName: naming.suggestedName,
					},
					"automatic",
				);
				await operations.update(scope, (store) => {
					const current = store.creations.find(
						(entry) => entry.progress.requestId === record.progress.requestId,
					)?.nameSuggestion;
					if (current) current.status = "completed";
				});
			}
		} finally {
			namingInFlight.delete(record.progress.requestId);
		}
	};
	const assertNotStopped = (store: TaskConversationSessionOperationStore, sessionId: string) => {
		if (store.explicitlyStoppedSessionIds.includes(sessionId))
			throw new TaskConversationSessionExecutionProhibitedError("显式 Stop 仍禁止自动执行。");
	};
	const assertBoundResumeEligible = async (
		scope: TaskConversationSessionWorkspaceScope,
		input: RuntimeTaskConversationSessionResumeRequest,
		evidence: KanbanRequestOriginActorEvidence,
		expectedWorkingDirectory?: string | null,
		expectedRequesterSessionId?: string,
	) => {
		if (closed) throw new TaskConversationSessionExecutionProhibitedError("运行时正在关闭，保留原执行。");
		const state = await deps.readState(scope);
		const card = findCard(state.board, input.taskId);
		if (!card || card.createdAt !== input.expectedTaskIncarnationCreatedAtEpochMs)
			throw new TaskConversationSessionBoundResumeError("identity_mismatch", "宿主任务不存在或已换代。");
		assertTaskAllowsExecution(state.board, input.taskId, input.expectedTaskIncarnationCreatedAtEpochMs);
		const requesterSessionId = resolveCreatorSessionId(
			{ taskId: input.taskId, creatorTaskConversationSessionId: expectedRequesterSessionId },
			evidence,
			state.sessions,
			resolveMainTaskConversationSessionId(card),
			scope.workspaceId,
		);
		if (
			requireSession(state.sessions, requesterSessionId, input.taskId).taskConversationSessionMetadata
				?.taskConversationSessionRole === "by_the_way"
		)
			throw new TaskConversationSessionExecutionProhibitedError("只读旁支会话不能控制其他执行。");
		if (
			input.taskConversationSessionId === card.id ||
			resolveMainTaskConversationSessionId(card) === input.taskConversationSessionId
		)
			throw new TaskConversationSessionBoundResumeError(
				"unsupported",
				"受限接续只处理精确侧会话，不接续宿主主会话。",
			);
		const store = await operations.read(scope);
		assertNotStopped(store, input.taskId);
		assertNotStopped(store, requesterSessionId);
		assertNotStopped(store, input.taskConversationSessionId);
		const creation = store.creations.find(
			(record) => record.progress.taskConversationSessionId === input.taskConversationSessionId,
		);
		if (!creation) throw new TaskConversationSessionBoundResumeError("identity_unknown", "缺少原会话创建记录。");
		if (
			creation.progress.taskId !== input.taskId ||
			creation.progress.taskIncarnationCreatedAt !== input.expectedTaskIncarnationCreatedAtEpochMs
		)
			throw new TaskConversationSessionBoundResumeError("identity_mismatch", "原会话创建归属已变化。");
		assertNotStopped(store, creation.progress.creatorTaskConversationSessionId);
		const summary = state.sessions[input.taskConversationSessionId];
		if (!summary?.agentNativeConversationSessionIdentity)
			throw new TaskConversationSessionBoundResumeError(
				"identity_unknown",
				"原生会话身份缺证，不能以新建执行代替接续。",
			);
		if (!summary.workspacePath)
			throw new TaskConversationSessionBoundResumeError(
				"identity_unknown",
				"缺少原执行工作目录，不能在重新解析的目录启动。",
			);
		if (
			!doesConversationSessionBelongToTask(summary, input.taskId) ||
			summary.agentNativeConversationSessionIdentity.nativeSessionId !== input.expectedNativeConversationSessionId ||
			(expectedWorkingDirectory !== undefined && summary.workspacePath !== expectedWorkingDirectory)
		)
			throw new TaskConversationSessionBoundResumeError("identity_mismatch", "原生身份或原工作目录已变化。");
		if (summary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover)
			throw new TaskConversationSessionExecutionProhibitedError("主会话交接暂停仍禁止自动接续。");
		if (!summary.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings)
			throw new TaskConversationSessionBoundResumeError("unsupported", "缺少该侧会话自己的持久启动设置。");
		return { summary, requesterSessionId };
	};
	const assertCreationEligible = async (
		scope: TaskConversationSessionWorkspaceScope,
		record: TaskConversationSessionCreationRecord,
	) => {
		if (closed) throw new Error("运行时正在关闭，保留待恢复请求。");
		const state = await deps.readState(scope);
		const card = assertTaskAllowsExecution(
			state.board,
			record.progress.taskId,
			record.progress.taskIncarnationCreatedAt,
		);
		const store = await operations.read(scope);
		assertNotStopped(store, record.progress.creatorTaskConversationSessionId);
		assertNotStopped(store, record.progress.taskConversationSessionId);
		const creator = requireSession(
			state.sessions,
			record.progress.creatorTaskConversationSessionId,
			record.progress.taskId,
		);
		const metadata = record.launchRequest.taskConversationSessionMetadata;
		const expectedSource = metadata?.contextSourceNativeSessionIdentity;
		const source = metadata?.contextSourceTaskConversationSessionId
			? state.sessions[metadata.contextSourceTaskConversationSessionId]
			: null;
		if (
			(expectedSource &&
				(source?.agentNativeConversationSessionIdentity?.nativeSessionId !== expectedSource.nativeSessionId ||
					source?.agentNativeConversationSessionIdentity?.sourceAgentId !== expectedSource.sourceAgentId)) ||
			(metadata?.contextSourceSelectionAtCreation === "current_main" &&
				resolveMainTaskConversationSessionId(card) !== metadata.contextSourceTaskConversationSessionId)
		)
			throw new TaskConversationSessionContextSourceChangedError(
				"上下文来源身份或当前主绑定已变化，原请求未复刻；请为新的来源使用新请求键。",
			);
		if (creator.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover)
			throw new TaskConversationSessionExecutionProhibitedError("创建者正在交接并等待真人输入。");
	};
	const launch = async (
		scope: TaskConversationSessionWorkspaceScope,
		record: TaskConversationSessionCreationRecord,
	) => {
		if (closed) return;
		try {
			await assertCreationEligible(scope, record);
		} catch (error) {
			await operations.update(scope, (store) => {
				const current = store.creations.find((entry) => entry.progress.requestId === record.progress.requestId);
				if (current) {
					current.progress.notice = String(error);
					if (error instanceof TaskConversationSessionExecutionProhibitedError)
						current.progress.status = "execution_prohibited";
					if (error instanceof TaskConversationSessionContextSourceChangedError)
						current.progress.status = "failed";
				}
			});
			return;
		}
		const state = await deps.readState(scope);
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify([
					await evidenceFingerprint(
						state.sessions[
							record.progress.contextSourceTaskConversationSessionId ??
								record.progress.creatorTaskConversationSessionId
						],
					),
					await deps.readStartupEnvironmentFingerprint?.(scope, record.launchRequest),
				]),
			)
			.digest("hex");
		const claimed = await operations.update(scope, (store) => {
			const current = store.creations.find((entry) => entry.progress.requestId === record.progress.requestId);
			if (
				!current ||
				current.progress.status !== "reserved" ||
				!claimTaskConversationSessionEvidenceProbe(current.recoveryEvidence, fingerprint, now())
			)
				return false;
			current.progress.unchangedEvidenceProbeCount = current.recoveryEvidence.unchangedProbeCount;
			current.progress.nextEvidenceProbeAt = current.recoveryEvidence.nextProbeAt;
			current.progress.status = "launch_requested";
			current.processLaunchMayHaveStarted = false;
			current.launchOwnerRuntimeProcessInstanceId = getThisRuntimeProcessInstanceId();
			return true;
		});
		if (!claimed) return;
		launchesInFlight.add(record.progress.requestId);
		let result: RuntimeTaskSessionStartResponse;
		try {
			await assertCreationEligible(scope, record);
			result = await deps.startSession(scope, record.launchRequest, async () => {
				await assertCreationEligible(scope, record);
				// 这条标记先于原生启动持久化：标记存在后只补证，绝不把未知启动再做一次。
				await operations.update(scope, (store) => {
					const current = store.creations.find((entry) => entry.progress.requestId === record.progress.requestId);
					if (current) current.processLaunchMayHaveStarted = true;
				});
			});
		} catch (error) {
			result = { ok: false, summary: null, error: String(error) };
		} finally {
			launchesInFlight.delete(record.progress.requestId);
		}
		await operations.update(scope, (store) => {
			const current = store.creations.find((entry) => entry.progress.requestId === record.progress.requestId);
			if (!current) return;
			const launchedSummary = result.ok ? result.summary : null;
			if (launchedSummary && resolveSessionFacets(launchedSummary).liveness === "failed") {
				current.progress.status = "failed";
				current.progress.notice = launchedSummary.warningMessage ?? result.error ?? "会话启动失败。";
			} else {
				current.progress.status =
					result.ok && launchedSummary
						? "started"
						: current.processLaunchMayHaveStarted
							? "awaiting_startup_evidence"
							: "reserved";
				current.progress.notice = result.error ?? null;
			}
			if (
				store.explicitlyStoppedSessionIds.includes(current.progress.creatorTaskConversationSessionId) ||
				store.explicitlyStoppedSessionIds.includes(current.progress.taskConversationSessionId)
			)
				current.progress.status = "execution_prohibited";
		});
	};

	const registerReport = async (
		scope: TaskConversationSessionWorkspaceScope,
		sourceSessionId: string,
		input: RuntimeTaskConversationSessionReportRequest,
		expectedSourceNativeSessionId?: string,
		nativeAssistantMessageIdentity?: string,
		assistantMessageProvenanceSha256?: string,
	): Promise<RuntimeTaskConversationSessionReportResponse> => {
		const state = await deps.readState(scope);
		const card = findCard(state.board, input.taskId);
		if (!card) throw new Error("任务不存在。");
		const source = requireSession(state.sessions, sourceSessionId, input.taskId);
		if (
			expectedSourceNativeSessionId &&
			source.agentNativeConversationSessionIdentity?.nativeSessionId !== expectedSourceNativeSessionId
		)
			throw new Error("回报扫描期间来源原生身份已变化。");
		const requestFingerprint = createHash("sha256")
			.update(JSON.stringify([sourceSessionId, input.text, input.targetTaskConversationSessionId ?? null]))
			.digest("hex");
		const requestedTarget = input.targetTaskConversationSessionId;
		const targetId =
			requestedTarget === "current_main"
				? resolveMainTaskConversationSessionId(card)
				: (requestedTarget ??
					source.taskConversationSessionMetadata?.defaultReportTargetTaskConversationSessionId ??
					source.taskConversationSessionMetadata?.creatorTaskConversationSessionId ??
					source.taskConversationSessionMetadata?.parentTaskConversationSessionId ??
					resolveMainTaskConversationSessionId(card));
		requireSession(state.sessions, targetId, input.taskId);
		return operations.update(scope, (store) => {
			const existing = store.reports.find(
				(entry) =>
					entry.taskId === card.id &&
					entry.taskIncarnationCreatedAt === card.createdAt &&
					(entry.idempotencyKey === input.idempotencyKey ||
						(assistantMessageProvenanceSha256 &&
							entry.assistantMessageProvenanceSha256 === assistantMessageProvenanceSha256 &&
							entry.receipt.sourceTaskConversationSessionId === sourceSessionId &&
							entry.sourceNativeSessionId !== source.agentNativeConversationSessionIdentity?.nativeSessionId)),
			);
			if (existing) {
				if (
					existing.requestFingerprint
						? existing.requestFingerprint !== requestFingerprint
						: existing.text !== input.text ||
							existing.receipt.sourceTaskConversationSessionId !== sourceSessionId ||
							existing.receipt.targetTaskConversationSessionId !== targetId
				)
					throw new Error("回报幂等键已用于其他正文、来源或目标。");
				return existing.receipt;
			}
			const receipt: RuntimeTaskConversationSessionReportResponse = {
				ok: true,
				reportId: randomUUID(),
				sourceTaskConversationSessionId: sourceSessionId,
				targetTaskConversationSessionId: targetId,
				status: "pending",
			};
			store.reports.push({
				receipt,
				taskId: card.id,
				taskIncarnationCreatedAt: card.createdAt,
				idempotencyKey: input.idempotencyKey,
				text: input.text,
				createdAt: now(),
				sourceNativeSessionId: source.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
				assistantMessageProvenanceSha256,
				resumeMayHaveStarted: false,
				assistantOriginVerification:
					nativeAssistantMessageIdentity &&
					isForkedTaskConversationSessionContext(source.taskConversationSessionMetadata)
						? {
								nativeMessageIdentity: nativeAssistantMessageIdentity,
								status: "pending",
								contextHistoryCursor: null,
								recoveryEvidence: emptyTaskConversationSessionRecoveryEvidence(),
							}
						: undefined,
				requestFingerprint,
				recoveryEvidence: emptyTaskConversationSessionRecoveryEvidence(),
			});
			return receipt;
		});
	};

	const reconcileReport = async (
		scope: TaskConversationSessionWorkspaceScope,
		report: TaskConversationSessionReportRecord,
	) => {
		if (
			!report.receipt.reportId ||
			!report.receipt.targetTaskConversationSessionId ||
			report.receipt.status === "accepted"
		)
			return;
		const originVerification = report.assistantOriginVerification;
		if (originVerification?.status === "inherited") return;
		if (originVerification?.status === "pending") {
			const state = await deps.readState(scope);
			const source = state.sessions[report.receipt.sourceTaskConversationSessionId ?? ""];
			if (!source || source.agentNativeConversationSessionIdentity?.nativeSessionId !== report.sourceNativeSessionId)
				return;
			const recordedContextSource = resolveRecordedTaskConversationSessionContextSource(
				source.taskConversationSessionMetadata,
			);
			const originIdentity = recordedContextSource.nativeIdentity;
			const fingerprint = JSON.stringify([
				await evidenceFingerprint(source),
				originIdentity?.transcriptPath
					? await stat(originIdentity.transcriptPath)
							.then((file) => [file.ino, file.size, file.mtimeMs])
							.catch(() => null)
					: null,
				await evidenceFingerprint(
					state.sessions[source.taskConversationSessionMetadata?.contextSourceTaskConversationSessionId ?? ""],
				),
				originVerification.contextHistoryCursor,
			]);
			const claimed = await operations.update(scope, (store) => {
				const current = store.reports.find(
					(entry) => entry.receipt.reportId === report.receipt.reportId,
				)?.assistantOriginVerification;
				return current
					? claimTaskConversationSessionEvidenceProbe(current.recoveryEvidence, fingerprint, now())
					: false;
			});
			if (!claimed) return;
			const checked = await deps.verifyAssistantReportOrigin(
				scope,
				source,
				originVerification.nativeMessageIdentity,
				originVerification.contextHistoryCursor,
				report.assistantMessageProvenanceSha256,
			);
			await operations.update(scope, (store) => {
				const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
				if (!current?.assistantOriginVerification) return;
				current.assistantOriginVerification.status = checked.status;
				current.assistantOriginVerification.contextHistoryCursor = checked.nextCursor;
				current.receipt.error = checked.notice;
				if (checked.status === "inherited") {
					current.receipt.status = "failed";
					current.receipt.error = "该声明属于继承的来源历史，未投递。";
				}
			});
			if (checked.status !== "verified") return;
		}
		const queueIdempotencyKey = `session-report:${report.receipt.reportId}`;
		const accepted = await deps.readReportAcceptance(scope, report.taskId, queueIdempotencyKey);
		if (accepted === "accepted" || accepted === "failed") {
			await operations.update(scope, (store) => {
				const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
				if (current) current.receipt.status = accepted;
			});
			return;
		}
		if (report.receipt.status === "failed") return;
		const state = await deps.readState(scope);
		const store = await operations.read(scope);
		let target: RuntimeTaskSessionSummary;
		try {
			assertTaskAllowsExecution(state.board, report.taskId, report.taskIncarnationCreatedAt);
			assertNotStopped(store, report.receipt.targetTaskConversationSessionId);
			target = requireSession(state.sessions, report.receipt.targetTaskConversationSessionId, report.taskId);
			if (target.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover)
				throw new Error("接收会话正在等待真人确认交接。");
		} catch (error) {
			await operations.update(scope, (store) => {
				const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
				if (current) {
					current.receipt.status = "execution_prohibited";
					current.receipt.error = String(error);
				}
			});
			return;
		}
		if (resolveSessionFacets(target).liveness !== "live") {
			// 只有系统回收证据能授权自动恢复；历史退出或显式 Stop 不等于被回收。
			if (
				!target.agentSessionRuntimeReclamationOutcome?.rootProcessExitConfirmed ||
				target.agentSessionRuntimeReclamationOutcome.runtimeSessionIncarnationId !==
					target.runtimeSessionIncarnationId ||
				isAgentAwaitingModalUserDecision(resolveSessionFacets(target))
			)
				return;
			const fingerprint = await evidenceFingerprint(target);
			const probe = await operations.update(scope, (store) => {
				const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
				return current
					? claimTaskConversationSessionEvidenceProbe(current.recoveryEvidence, fingerprint, now())
					: false;
			});
			if (
				!probe ||
				!target.agentNativeConversationSessionIdentity ||
				!target.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings
			)
				return;
			if (report.resumeMayHaveStarted) {
				await operations.update(scope, (store) => {
					const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
					if (current) current.receipt.error = "接收方恢复启动的结果尚未证实，只补查绑定与控制端点，不重复启动。";
				});
				return;
			}
			const expectedNativeId = target.agentNativeConversationSessionIdentity.nativeSessionId;
			const beforeLaunch = async () => {
				const latest = await deps.readState(scope);
				assertTaskAllowsExecution(latest.board, report.taskId, report.taskIncarnationCreatedAt);
				assertNotStopped(await operations.read(scope), target.taskId);
				if (
					latest.sessions[target.taskId]?.agentNativeConversationSessionIdentity?.nativeSessionId !==
					expectedNativeId
				)
					throw new Error("接收方原生身份已变化，等待重新核验。");
			};
			await beforeLaunch();
			const resumed = await deps.resumeSession(scope, target, async () => {
				await beforeLaunch();
				await operations.update(scope, (store) => {
					const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
					if (!current || current.resumeMayHaveStarted)
						throw new Error("该目标已有待补证的恢复启动，未重复启动。");
					current.resumeMayHaveStarted = true;
				});
			});
			if (!resumed.ok) return;
			await operations.update(scope, (store) => {
				const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
				if (current) current.resumeMayHaveStarted = false;
			});
		}
		if (report.receipt.status === "queued" && accepted !== null) return;
		if (closed) return;
		// 固定 report ID 作为持久队列幂等键；崩溃重试只补读真实接受，不生成第二条消息。
		const text = `来自会话 ${report.receipt.sourceTaskConversationSessionId} 的 Agent 回报（程序化消息，不代表真人批准）：\n\n${report.text}`;
		await operations.update(scope, async (store) => {
			assertNotStopped(store, target.taskId);
			assertTaskAllowsExecution((await deps.readState(scope)).board, report.taskId, report.taskIncarnationCreatedAt);
			const response = await deps.enqueueReport(scope, {
				taskId: report.taskId,
				attemptId: target.taskId,
				text,
				source: "task_conversation_session_report",
				idempotencyKey: queueIdempotencyKey,
				promptSha256: createHash("sha256").update(text).digest("hex"),
				maxWaitForAgentIdleMs: 86_400_000,
				taskConversationSessionReportOrigin: {
					workspaceTaskId: report.taskId,
					taskIncarnationCreatedAt: report.taskIncarnationCreatedAt,
					sourceTaskConversationSessionId: report.receipt.sourceTaskConversationSessionId ?? "",
					targetTaskConversationSessionId: target.taskId,
				},
			});
			const current = store.reports.find((entry) => entry.receipt.reportId === report.receipt.reportId);
			if (current) {
				current.receipt.status = response.ok ? "queued" : "pending";
				current.receipt.error = response.error;
			}
		});
	};

	const reconcile = (scope: TaskConversationSessionWorkspaceScope): Promise<void> => {
		if (closed) return Promise.resolve();
		const existing = reconciliationsInFlight.get(scope.workspaceId);
		if (existing) return existing;
		const work = (async () => {
			let store = await operations.read(scope);
			for (const creation of store.creations) await reconcileName(scope, creation).catch(() => undefined);
			for (const creation of store.creations) {
				try {
					if (closed) return;
					if (creation.progress.status === "execution_prohibited" && !creation.processLaunchMayHaveStarted) {
						await assertCreationEligible(scope, creation);
						await operations.update(scope, (store) => {
							const current = store.creations.find(
								(entry) => entry.progress.requestId === creation.progress.requestId,
							);
							if (current) {
								current.progress.status = "reserved";
								current.recoveryEvidence = emptyTaskConversationSessionRecoveryEvidence();
							}
						});
						continue;
					}
					if (creation.progress.status === "reserved") {
						await launch(scope, creation);
						continue;
					}
					if (
						!["launch_requested", "awaiting_startup_evidence"].includes(creation.progress.status) ||
						launchesInFlight.has(creation.progress.requestId)
					)
						continue;
					if (
						creation.launchOwnerRuntimeProcessInstanceId &&
						creation.launchOwnerRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId() &&
						(await readRuntimeProcessInstanceLiveness(creation.launchOwnerRuntimeProcessInstanceId)) !== "dead"
					)
						continue;
					if (!creation.processLaunchMayHaveStarted) {
						await operations.update(scope, (store) => {
							const current = store.creations.find(
								(entry) => entry.progress.requestId === creation.progress.requestId,
							);
							if (current) current.progress.status = "reserved";
						});
						continue;
					}
					const state = await deps.readState(scope);
					const summary = state.sessions[creation.progress.taskConversationSessionId];
					const fingerprint = await evidenceFingerprint(summary);
					await operations.update(scope, (store) => {
						const current = store.creations.find(
							(entry) => entry.progress.requestId === creation.progress.requestId,
						);
						if (
							!current ||
							!claimTaskConversationSessionEvidenceProbe(current.recoveryEvidence, fingerprint, now())
						)
							return;
						current.progress.unchangedEvidenceProbeCount = current.recoveryEvidence.unchangedProbeCount;
						current.progress.nextEvidenceProbeAt = current.recoveryEvidence.nextProbeAt;
						if (sessionStartupFailed(summary, current.progress.requestId)) {
							current.progress.status = "failed";
							current.progress.notice = summary.warningMessage ?? "会话启动失败。";
						} else if (sessionStartupConfirmed(summary, current.progress.requestId)) {
							current.progress.status = "started";
							current.progress.notice = null;
						} else {
							current.progress.status = "awaiting_startup_evidence";
							current.progress.notice =
								"启动结果未知；等待绑定摘要、原生身份或独享控制端点补证，未再次 fork 或重投首条消息。";
						}
					});
				} catch {
					/* 单个请求暂时缺证不影响其他会话。 */
				}
			}
			const state = await deps.readState(scope);
			for (const source of Object.values(state.sessions)) {
				const metadata = source.taskConversationSessionMetadata;
				const createdAt = metadata?.sideSessionCreatedAt;
				if (closed) return;
				if (
					metadata?.taskConversationSessionRole !== "by_the_way" ||
					!createdAt ||
					!source.agentNativeConversationSessionIdentity ||
					resolveSessionFacets(source).turnOwner === "agent"
				)
					continue;
				// 只读历史入口绑定当前子身份；继承记录在创建边界之前，不视为本侧会话的新回报。
				const nativeSessionId = source.agentNativeConversationSessionIdentity.nativeSessionId;
				const fingerprint = await evidenceFingerprint(source);
				const scan = await operations.update(scope, (store) => {
					let scan = store.assistantReportHistoryScans.find(
						(entry) =>
							entry.taskConversationSessionId === source.taskId && entry.nativeSessionId === nativeSessionId,
					);
					if (!scan) {
						scan = {
							taskConversationSessionId: source.taskId,
							nativeSessionId,
							evidenceFingerprint: fingerprint,
							nextCursor: null,
							completed: false,
						};
						store.assistantReportHistoryScans.push(scan);
					}
					if (scan.evidenceFingerprint !== fingerprint) {
						scan.completed = false;
						scan.nextCursor = null;
						scan.evidenceFingerprint = fingerprint;
					}
					return scan;
				});
				if (scan.completed) continue;
				let cursor: string | null = scan.nextCursor;
				for (let page = 0; page < 3; page++) {
					const history = await deps
						.readHistory(scope, {
							workspaceTaskId: metadata.workspaceTaskId,
							taskConversationSessionId: source.taskId,
							cursor,
						})
						.catch(() => null);
					if (!history || history.availability === "unavailable") {
						await operations.update(scope, (store) => {
							const current = store.assistantReportHistoryScans.find(
								(entry) =>
									entry.taskConversationSessionId === source.taskId &&
									entry.nativeSessionId === nativeSessionId,
							);
							if (current && !current.completed) current.nextCursor = null;
						});
						break;
					}
					for (const message of history.messages) {
						if (
							message.role !== "assistant" ||
							message.createdAt <= createdAt ||
							(message.meta?.nativeMessagePhase &&
								!["final_answer", "final"].includes(message.meta.nativeMessagePhase))
						)
							continue;
						const report = parseExplicitTaskConversationSessionReport(message.content);
						if (report)
							await registerReport(
								scope,
								source.taskId,
								{
									taskId: metadata.workspaceTaskId,
									idempotencyKey: `native-report:${createHash("sha256")
										.update(`${source.taskId}:${message.meta?.nativeMessageIdentity ?? message.id}`)
										.digest("hex")}`,
									...report,
								},
								nativeSessionId,
								message.meta?.nativeMessageIdentity ?? message.id,
								computeAssistantMessageProvenanceSha256(message),
							).catch(() => undefined);
					}
					const complete =
						!history.nextCursor ||
						history.messages.some((message) => message.createdAt > 0 && message.createdAt <= createdAt);
					await operations.update(scope, (store) => {
						const current = store.assistantReportHistoryScans.find(
							(entry) =>
								entry.taskConversationSessionId === source.taskId && entry.nativeSessionId === nativeSessionId,
						);
						if (current) {
							current.nextCursor = history.nextCursor;
							current.completed = complete;
						}
					});
					if (complete) break;
					cursor = history.nextCursor;
				}
			}
			store = await operations.read(scope);
			for (const report of store.reports) {
				if (closed) return;
				await reconcileReport(scope, report).catch(() => undefined);
			}
		})().finally(() => reconciliationsInFlight.delete(scope.workspaceId));
		reconciliationsInFlight.set(scope.workspaceId, work);
		return work;
	};

	return {
		reconcile,
		async resume(
			scope: TaskConversationSessionWorkspaceScope,
			input: RuntimeTaskConversationSessionResumeRequest,
			evidence: KanbanRequestOriginActorEvidence,
		): Promise<RuntimeTaskConversationSessionResumeResponse> {
			const key = JSON.stringify([scope.workspaceId, input.taskConversationSessionId]);
			const fingerprint = JSON.stringify([input, evidence.decodedCliActorClaimsRequestHeader]);
			const existing = boundResumesInFlight.get(key);
			if (existing)
				return existing.fingerprint === fingerprint
					? existing.result
					: { ok: false, status: "identity_mismatch", summary: null, error: "该侧会话已有不同绑定的恢复操作。" };
			const result = (async (): Promise<RuntimeTaskConversationSessionResumeResponse> => {
				let executionMayHaveOccurred = false;
				let ownedSummary: RuntimeTaskSessionSummary | null = null;
				let requestedByTaskConversationSessionId: string | undefined;
				try {
					const original = await assertBoundResumeEligible(scope, input, evidence);
					const originalWorkingDirectory = original.summary.workspacePath;
					requestedByTaskConversationSessionId = original.requesterSessionId;
					const resumed = await deps.resumeSession(scope, original.summary, async (launchingSummary) => {
						await assertBoundResumeEligible(
							scope,
							input,
							evidence,
							originalWorkingDirectory,
							requestedByTaskConversationSessionId,
						);
						if (!launchingSummary.runtimeSessionIncarnationId)
							throw new TaskConversationSessionBoundResumeError("identity_unknown", "缺少本次实际启动代际。");
						if (
							launchingSummary.taskId !== input.taskConversationSessionId ||
							launchingSummary.workspacePath !== originalWorkingDirectory ||
							launchingSummary.agentNativeConversationSessionIdentity?.nativeSessionId !==
								input.expectedNativeConversationSessionId
						)
							throw new TaskConversationSessionBoundResumeError(
								"identity_mismatch",
								"实际启动与原会话身份或工作目录不匹配。",
							);
						ownedSummary = structuredClone(launchingSummary);
						executionMayHaveOccurred = true;
					});
					const current = await assertBoundResumeEligible(
						scope,
						input,
						evidence,
						originalWorkingDirectory,
						requestedByTaskConversationSessionId,
					);
					return {
						ok: resumed.ok,
						status: resumed.ok ? "resumed" : "execution_failed",
						summary: current.summary,
						requestedByTaskConversationSessionId,
						...(resumed.error ? { error: resumed.error } : {}),
					};
				} catch (error) {
					const postLaunchCancellation = ownedSummary
						? await deps
								.stopResumedSession(scope, ownedSummary)
								.catch(() => ({ cancellationRequested: false, processExitConfirmed: false }))
						: undefined;
					return {
						ok: false,
						status:
							error instanceof TaskConversationSessionExecutionProhibitedError
								? "execution_prohibited"
								: error instanceof TaskConversationSessionBoundResumeError
									? error.status
									: "identity_unknown",
						summary: null,
						executionMayHaveOccurred,
						requestedByTaskConversationSessionId,
						...(postLaunchCancellation ? { postLaunchCancellation } : {}),
						error: error instanceof Error ? error.message : String(error),
					};
				}
			})();
			boundResumesInFlight.set(key, { fingerprint, result });
			try {
				return await result;
			} finally {
				if (boundResumesInFlight.get(key)?.result === result) boundResumesInFlight.delete(key);
			}
		},
		async lookupCreation(
			scope: TaskConversationSessionWorkspaceScope,
			input: RuntimeTaskConversationSessionCreateRequest,
		): Promise<RuntimeTaskConversationSessionCreateResponse | null> {
			const state = await deps.readState(scope);
			const card = findCard(state.board, input.taskId);
			if (!card || card.createdAt !== input.expectedTaskIncarnationCreatedAtEpochMs)
				throw new Error("宿主任务不存在或已换代。");
			const record = (await operations.read(scope)).creations.find(
				(entry) =>
					entry.progress.taskId === card.id &&
					entry.progress.taskIncarnationCreatedAt === card.createdAt &&
					entry.idempotencyKey === input.idempotencyKey,
			);
			if (
				record &&
				((input.creatorTaskConversationSessionId &&
					input.creatorTaskConversationSessionId !== record.progress.creatorTaskConversationSessionId) ||
					creationRequestFingerprint(input, record.progress.creatorTaskConversationSessionId) !==
						record.requestFingerprint)
			)
				return {
					ok: false,
					idempotencyConflict: true,
					creation: record.progress,
					summary: null,
					error: "相同幂等键已用于不同的会话创建内容。",
				};
			return record
				? {
						ok: true,
						creation: record.progress,
						summary: state.sessions[record.progress.taskConversationSessionId] ?? null,
						resolvedSettings:
							record.launchRequest.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings
								?.resolvedSettings,
					}
				: null;
		},
		async rename(scope: TaskConversationSessionWorkspaceScope, input: RuntimeTaskConversationSessionRenameRequest) {
			try {
				const renamed = await deps.compareAndSetSessionName?.(scope, input, "explicit");
				return {
					ok: renamed === true,
					summary: null,
					...(renamed ? {} : { error: "会话归属或名称版本已变化，请刷新后重试。" }),
				};
			} catch (error) {
				return { ok: false, summary: null, error: String(error) };
			}
		},
		async preview(
			scope: TaskConversationSessionWorkspaceScope,
			input: RuntimeTaskConversationSessionCreateRequest,
			evidence: KanbanRequestOriginActorEvidence,
		): Promise<RuntimeTaskConversationSessionPreviewResponse> {
			try {
				const state = await deps.readState(scope);
				const card = assertTaskAllowsExecution(
					state.board,
					input.taskId,
					input.expectedTaskIncarnationCreatedAtEpochMs,
				);
				const creatorId = resolveCreatorSessionId(
					input,
					evidence,
					state.sessions,
					resolveMainTaskConversationSessionId(card),
					scope.workspaceId,
				);
				const creator = requireSession(state.sessions, creatorId, input.taskId);
				if (creator.taskConversationSessionMetadata?.taskConversationSessionRole === "by_the_way")
					throw new Error("By the way 保持只读，不能创建可执行会话。");
				const agentId = input.agentId ?? creator.agentId;
				assertRuntimeAgentIsNotRetired(agentId);
				if (!agentId || !isRuntimeAgentLaunchSupported(agentId)) throw new Error("所选 Agent 不支持启动。");
				if (input.sessionRole === "by_the_way" && !["claude", "codex"].includes(agentId))
					throw new Error("所选 Agent 不支持只读 By the way。");
				resolveCreationContextSource(input, card, state.sessions, agentId, creatorId);
				return { ok: true, resolvedSettings: await resolveStartupSettings(scope, input, agentId) };
			} catch (error) {
				return { ok: false, resolvedSettings: null, error: error instanceof Error ? error.message : String(error) };
			}
		},
		async isReportExecutionAllowed(
			scope: TaskConversationSessionWorkspaceScope,
			origin: NonNullable<QueuedTaskPromptDeliveryEntry["taskConversationSessionReportOrigin"]>,
		): Promise<boolean> {
			try {
				const state = await deps.readState(scope);
				assertTaskAllowsExecution(state.board, origin.workspaceTaskId, origin.taskIncarnationCreatedAt);
				assertNotStopped(await operations.read(scope), origin.targetTaskConversationSessionId);
				const target = requireSession(
					state.sessions,
					origin.targetTaskConversationSessionId,
					origin.workspaceTaskId,
				);
				return (
					!target.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover &&
					!isAgentAwaitingModalUserDecision(resolveSessionFacets(target))
				);
			} catch {
				return false;
			}
		},
		async reconcileAll() {
			for (const scope of await operations.listScopes()) {
				if (closed) return;
				await reconcile(scope).catch(() => undefined);
			}
		},
		async close() {
			closed = true;
			await Promise.allSettled(reconciliationsInFlight.values());
		},
		async assertAutomaticSessionResumeNotExplicitlyStopped(
			scope: TaskConversationSessionWorkspaceScope,
			sessionId: string,
		) {
			assertNotStopped(await operations.read(scope), sessionId);
		},
		async recordExplicitStop(
			scope: TaskConversationSessionWorkspaceScope,
			sessionId: string,
			knownRelatedSessionIds: readonly string[] = [],
		) {
			const state = await deps.readState(scope).catch(() => null);
			const stopsWholeTask = Boolean(state && findCard(state.board, sessionId));
			const affectedIds = new Set([sessionId, ...knownRelatedSessionIds]);
			if (stopsWholeTask && state)
				for (const summary of Object.values(state.sessions))
					if (doesConversationSessionBelongToTask(summary, sessionId)) affectedIds.add(summary.taskId);
			await operations.recordExplicitStopMarkers(scope, [...affectedIds]);
			const reports = await operations.update(scope, async (store) => {
				if (stopsWholeTask) {
					for (const creation of store.creations)
						if (creation.progress.taskId === sessionId)
							affectedIds.add(creation.progress.taskConversationSessionId);
				}
				await operations.recordExplicitStopMarkers(scope, [...affectedIds]);
				for (const id of affectedIds)
					if (!store.explicitlyStoppedSessionIds.includes(id)) store.explicitlyStoppedSessionIds.push(id);
				const reports = store.reports.filter(
					(entry) => entry.taskId === sessionId || entry.receipt.targetTaskConversationSessionId === sessionId,
				);
				for (const report of reports)
					if (report.receipt.status !== "accepted" && report.receipt.status !== "failed")
						report.receipt.status = "execution_prohibited";
				return reports;
			});
			for (const report of reports)
				if (report.receipt.reportId)
					await deps.cancelReport(scope, report.taskId, `session-report:${report.receipt.reportId}`);
		},
		async recordExplicitSessionStart(scope: TaskConversationSessionWorkspaceScope, sessionId: string) {
			await operations.clearExplicitStopMarker(scope, sessionId);
			await operations.update(scope, (store) => {
				store.explicitlyStoppedSessionIds = store.explicitlyStoppedSessionIds.filter((id) => id !== sessionId);
			});
		},
		async create(
			scope: TaskConversationSessionWorkspaceScope,
			input: RuntimeTaskConversationSessionCreateRequest,
			evidence: KanbanRequestOriginActorEvidence,
		): Promise<RuntimeTaskConversationSessionCreateResponse> {
			try {
				assertCreationPlanModeWasExplicitlySelected(input.startInPlanMode);
				if (closed) throw new Error("运行时正在关闭，暂不创建会话。");
				const state = await deps.readState(scope);
				const card = findCard(state.board, input.taskId);
				if (!card) throw new Error("任务不存在。");
				if (
					input.expectedTaskIncarnationCreatedAtEpochMs !== undefined &&
					card.createdAt !== input.expectedTaskIncarnationCreatedAtEpochMs
				)
					throw new Error("宿主任务已换代，原草稿不能创建到新任务。");
				const creatorId = resolveCreatorSessionId(
					input,
					evidence,
					state.sessions,
					resolveMainTaskConversationSessionId(card),
					scope.workspaceId,
				);
				const creator = requireSession(state.sessions, creatorId, input.taskId);
				if (creator.taskConversationSessionMetadata?.taskConversationSessionRole === "by_the_way")
					throw new Error("By the way 保持只读，不能创建可执行会话。");
				const fingerprint = creationRequestFingerprint(input, creatorId);
				const existing = (await operations.read(scope)).creations.find(
					(entry) =>
						entry.progress.taskId === input.taskId &&
						entry.progress.taskIncarnationCreatedAt === card.createdAt &&
						entry.idempotencyKey === input.idempotencyKey,
				);
				if (existing) {
					if (existing.requestFingerprint !== fingerprint)
						return {
							ok: false,
							idempotencyConflict: true,
							creation: existing.progress,
							summary: null,
							error: "相同幂等键已用于不同的会话创建内容。",
						};
					return {
						ok: true,
						creation: existing.progress,
						summary: state.sessions[existing.progress.taskConversationSessionId] ?? null,
						resolvedSettings:
							existing.launchRequest.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings
								?.resolvedSettings,
					};
				}
				assertTaskAllowsExecution(state.board, input.taskId);
				const agentId = input.agentId ?? creator.agentId;
				assertRuntimeAgentIsNotRetired(agentId);
				if (!agentId || !isRuntimeAgentLaunchSupported(agentId)) throw new Error("所选 Agent 不支持启动。");
				if (input.sessionRole === "by_the_way" && !["claude", "codex"].includes(agentId))
					throw new Error("所选 Agent 不支持只读 By the way。");
				const { sourceId, source } = resolveCreationContextSource(input, card, state.sessions, agentId, creatorId);
				const createdAt = now();
				const requestId = randomUUID();
				const sessionId = `task-conversation-session-${randomUUID()}`;
				const resolvedSettings = await resolveStartupSettings(scope, input, agentId);
				const taskAgentPermissionMode = resolvedSettings.effectiveTaskAgentPermissionMode.value;
				const codexConfigurationProfileId = resolvedSettings.codexConfigurationProfileId.value ?? undefined;
				const codexConfigurationPermissionSelectionSource =
					input.codexConfigurationPermissionSelectionSource ??
					(input.codexConfigurationProfileId && input.taskAgentPermissionMode === undefined
						? "profile"
						: "task_local");
				const terminalAgentModelOverrideSettings =
					resolvedSettings.modelId.value && ["claude", "codex", "cursor", "kimi", "omp"].includes(agentId)
						? {
								agentId: agentId as "claude" | "codex" | "cursor" | "kimi" | "omp",
								modelId: resolvedSettings.modelId.value,
							}
						: undefined;
				const mainSessionId = resolveMainTaskConversationSessionId(card);
				const launchRequest: RuntimeTaskSessionStartRequest = {
					taskId: sessionId,
					workspaceTaskId: card.id,
					agentId,
					prompt: input.initialMessage,
					images: input.images,
					terminalAgentModelOverrideSettings,
					taskTitle:
						input.conversationSessionName ||
						input.initialMessage.slice(0, 80) ||
						(input.sessionRole === "by_the_way" ? "By the way" : "协作会话"),
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
					cols: input.cols ?? 100,
					rows: input.rows ?? 30,
					taskAgentPermissionMode,
					startInPlanMode: input.startInPlanMode,
					codexConfigurationProfileId,
					codexConfigurationPermissionSelectionSource,
					requestedAgentSessionTransport: resolvedSettings.sessionTransport.value,
					taskConversationSessionMetadata: {
						conversationSessionName: input.conversationSessionName || undefined,
						conversationSessionNameVersion: input.conversationSessionName ? 1 : 0,
						conversationSessionNameSource: input.conversationSessionName ? "explicit" : undefined,
						workspaceTaskId: card.id,
						sideSessionCreatedAt: createdAt,
						taskConversationSessionRole: input.sessionRole,
						taskConversationSessionRoleAtCreation: input.sessionRole,
						taskConversationSessionContextSource: source
							? "forked_from_conversation_session"
							: "started_from_scratch",
						parentTaskConversationSessionId: sourceId,
						mainSessionOriginTurnNumber:
							sourceId !== null && sourceId === mainSessionId
								? (source?.latestTurnCheckpoint?.turn ?? (source?.startedAt == null ? 0 : 1))
								: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: input.initialMessage.trim() || null,
						creatorTaskConversationSessionId: creatorId,
						creatorNativeConversationSessionIdentity: creator.agentNativeConversationSessionIdentity
							? {
									sourceAgentId: creator.agentNativeConversationSessionIdentity.sourceAgentId,
									nativeSessionId: creator.agentNativeConversationSessionIdentity.nativeSessionId,
									transcriptPath: creator.agentNativeConversationSessionIdentity.transcriptPath,
								}
							: undefined,
						contextSourceTaskConversationSessionId: sourceId ?? undefined,
						contextSourceSelectionAtCreation: input.contextSource,
						contextSourceNativeSessionIdentity: source?.agentNativeConversationSessionIdentity
							? {
									sourceAgentId: source.agentNativeConversationSessionIdentity.sourceAgentId,
									nativeSessionId: source.agentNativeConversationSessionIdentity.nativeSessionId,
									transcriptPath: source.agentNativeConversationSessionIdentity.transcriptPath,
								}
							: undefined,
						defaultReportTargetTaskConversationSessionId: creatorId,
						creationReason: input.creationReason,
						creationRequestId: requestId,
						taskConversationSessionLaunchSettings: {
							codexConfigurationProfileId,
							codexConfigurationPermissionSelectionSource,
							taskAgentPermissionMode,
							startInPlanMode: input.startInPlanMode,
							sessionTransport: resolvedSettings.sessionTransport.value,
							terminalAgentModelOverrideSettings,
							resolvedSettings,
						},
					},
				};
				const record = await operations.update(scope, (store) => {
					const previous = store.creations.find(
						(entry) =>
							entry.progress.taskId === input.taskId &&
							entry.progress.taskIncarnationCreatedAt === card.createdAt &&
							entry.idempotencyKey === input.idempotencyKey,
					);
					if (previous) {
						if (previous.requestFingerprint !== fingerprint)
							throw new TaskConversationSessionIdempotencyConflictError(previous.progress);
						return previous;
					}
					assertNotStopped(store, creatorId);
					const record: TaskConversationSessionCreationRecord = {
						progress: {
							requestId,
							taskId: card.id,
							taskIncarnationCreatedAt: card.createdAt,
							taskConversationSessionId: sessionId,
							creatorTaskConversationSessionId: creatorId,
							contextSourceTaskConversationSessionId: sourceId,
							createdAt,
							status: "reserved",
							notice: null,
							unchangedEvidenceProbeCount: 0,
							nextEvidenceProbeAt: null,
						},
						requestFingerprint: fingerprint,
						idempotencyKey: input.idempotencyKey,
						launchRequest,
						launchOwnerRuntimeProcessInstanceId: null,
						processLaunchMayHaveStarted: false,
						nameSuggestion: input.conversationSessionName
							? undefined
							: {
									operationId: randomUUID(),
									basisText: input.initialMessage.trim() || null,
									expectedNameVersion: 0,
									status: input.initialMessage.trim() ? "ready" : "waiting_for_real_input",
								},
						recoveryEvidence: emptyTaskConversationSessionRecoveryEvidence(),
					};
					store.creations.push(record);
					return record;
				});
				await launch(scope, record);
				void reconcileName(scope, record).catch(() => undefined);
				const progress =
					(await operations.read(scope)).creations.find(
						(entry) => entry.progress.requestId === record.progress.requestId,
					)?.progress ?? record.progress;
				return {
					ok: true,
					creation: progress,
					summary: (await deps.readState(scope)).sessions[progress.taskConversationSessionId] ?? null,
					resolvedSettings:
						record.launchRequest.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings
							?.resolvedSettings,
				};
			} catch (error) {
				if (error instanceof TaskConversationSessionIdempotencyConflictError)
					return {
						ok: false,
						idempotencyConflict: true,
						creation: error.creation,
						summary: null,
						error: error.message,
					};
				return {
					ok: false,
					creation: null,
					summary: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		async list(
			scope: TaskConversationSessionWorkspaceScope,
			taskId: string,
		): Promise<RuntimeTaskConversationSessionListResponse> {
			const state = await deps.readState(scope);
			const card = findCard(state.board, taskId);
			if (!card) throw new Error("任务不存在。");
			return {
				sessions: Object.values(state.sessions).filter((summary) =>
					doesConversationSessionBelongToTask(summary, taskId),
				),
				creations: (await operations.read(scope)).creations
					.filter(
						(entry) =>
							entry.progress.taskId === taskId && entry.progress.taskIncarnationCreatedAt === card.createdAt,
					)
					.map((entry) => entry.progress),
			};
		},
		async get(
			scope: TaskConversationSessionWorkspaceScope,
			input: RuntimeTaskConversationSessionGetRequest,
		): Promise<RuntimeTaskConversationSessionGetResponse> {
			const listed = await this.list(scope, input.taskId);
			const summary = listed.sessions.find((entry) => entry.taskId === input.taskConversationSessionId) ?? null;
			const creation =
				listed.creations.find((entry) => entry.taskConversationSessionId === input.taskConversationSessionId) ??
				null;
			if (!summary && !creation) throw new Error("会话不存在或不属于同一任务。");
			const sessionOperations = await operations.read(scope);
			const reports = sessionOperations.reports
				.filter(
					(entry) =>
						entry.taskId === input.taskId &&
						(entry.receipt.sourceTaskConversationSessionId === input.taskConversationSessionId ||
							entry.receipt.targetTaskConversationSessionId === input.taskConversationSessionId),
				)
				.map((entry) => entry.receipt);
			return {
				summary,
				taskConversationSessionExplicitlyStopped: sessionOperations.explicitlyStoppedSessionIds.includes(
					input.taskConversationSessionId,
				),
				creation,
				reports,
				history: await deps.readHistory(scope, {
					workspaceTaskId: input.taskId,
					taskConversationSessionId: input.taskConversationSessionId,
					cursor: input.cursor,
				}),
			};
		},
		async report(
			scope: TaskConversationSessionWorkspaceScope,
			input: RuntimeTaskConversationSessionReportRequest,
			evidence: KanbanRequestOriginActorEvidence,
		): Promise<RuntimeTaskConversationSessionReportResponse> {
			try {
				const state = await deps.readState(scope);
				const card = findCard(state.board, input.taskId);
				if (!card) throw new Error("任务不存在。");
				const sourceId = resolveCreatorSessionId(
					input,
					evidence,
					state.sessions,
					resolveMainTaskConversationSessionId(card),
					scope.workspaceId,
				);
				if (
					requireSession(state.sessions, sourceId, input.taskId).taskConversationSessionMetadata
						?.taskConversationSessionRole === "by_the_way"
				)
					throw new Error("只读侧会话须在回答末尾声明 kanban-session-report，不能调用写工具。");
				const receipt = await registerReport(scope, sourceId, input);
				await reconcile(scope);
				return (
					(await operations.read(scope)).reports.find((entry) => entry.receipt.reportId === receipt.reportId)
						?.receipt ?? receipt
				);
			} catch (error) {
				return {
					ok: false,
					reportId: null,
					sourceTaskConversationSessionId: null,
					targetTaskConversationSessionId: null,
					status: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
