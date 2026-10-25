import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TRPCError } from "@trpc/server";
import type { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import {
	collectTaskMainSessionHandoverMaterial,
	type TaskMainSessionHandoverUserIntentContextProvider,
} from "../agent-session-history/task-main-session-handover-material-provider";
import { resolveRecordedCodexConversationHome } from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeConfigState } from "../config/runtime-config";
import { getRuntimeAgentCatalogEntry, resolveRuntimeAgentSessionTransportFromSummary } from "../core/agent-catalog";
import {
	type RuntimeBoardCard,
	type RuntimeBoardData,
	type RuntimeCommandRunResponse,
	type RuntimeTaskSessionSummary,
	runtimeTaskSessionSummarySchema,
} from "../core/api-contract";
import { MODAL_USER_DECISION_TURN_KINDS, resolveSessionFacets } from "../core/session-activity";
import { resolveTaskAgentPermissionModeFromLegacyAutonomousFlag } from "../core/task-agent-permission-mode";
import {
	doesConversationSessionBelongToTask,
	projectTaskConversationSessionsForMainSessionBinding,
	resolveMainTaskConversationSessionId,
} from "../core/task-main-conversation-session-binding";
import {
	getTaskMainSessionHandoverNativeForkAvailability,
	isTaskMainSessionHandoverAgentSupported,
	listTaskMainSessionHandoverTargetCapabilities,
} from "../core/task-main-session-handover-agent-capabilities";
import type {
	TaskMainSessionHandoverMaterial,
	TaskMainSessionHandoverPrepareResponse,
	TaskMainSessionHandoverRecord,
	TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
	TaskMainSessionHandoverRequest,
	TaskMainSessionHandoverStatusResponse,
} from "../core/task-main-session-handover-contract";
import {
	isTaskMainSessionHandoverExistingTarget,
	isTaskMainSessionHandoverNativeForkRequested,
	resolveTaskMainSessionHandoverTargetAgentId,
	taskMainSessionHandoverExistingPeerAgentIdSchema,
	taskMainSessionHandoverMaterialSchema,
	taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema,
	taskMainSessionHandoverRecoveryReceiptReferenceSchema,
	taskMainSessionHandoverRecoveryReceiptSchema,
	taskMainSessionHandoverRequestSchema,
} from "../core/task-main-session-handover-contract";
import {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	type TaskMessageInjectionRecord,
	withTaskMessageInjectionLedgerLock,
} from "../core/task-message-injection-ledger";
import { lockedFileSystem } from "../fs/locked-file-system";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { completeTaskMainSessionHandoverAfterUserMessage } from "../state/complete-task-main-session-handover-after-user-message";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceStateById,
	mutateWorkspaceState,
} from "../state/workspace-state";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import type { TaskCardActionPerTaskCommandSerializer } from "../trpc/task-card-action-per-task-command-serializer";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import {
	type PreparedCodexMainSessionHandoverNativeFork,
	prepareCodexMainSessionHandoverNativeFork,
	prepareCodexMainSessionHandoverRecoveryNativeFork,
	TaskMainSessionHandoverExecutionProhibitedError,
} from "./codex-main-session-handover-native-fork";
import {
	beginTaskMainSessionHandoverMachineEvidenceAttempt,
	canRetryTaskMainSessionHandoverMachineEvidence,
	fingerprintTaskMainSessionHandoverRecoveryEvidence,
	recordTaskMainSessionHandoverReportAcceptanceScanProgress,
} from "./task-main-session-handover-automatic-recovery";
import {
	assertTaskMainSessionHandoverExistingTargetBinding,
	captureTaskMainSessionHandoverExistingTargetBinding,
	getTaskMainSessionHandoverExistingPeerUnavailableReason,
} from "./task-main-session-handover-existing-target";
import { prepareTaskMainSessionHandoverTranscriptNativeFork } from "./task-main-session-handover-native-fork";
import {
	queryCursorMainSessionHandoverAcceptedHumanFollowup,
	queryTaskMainSessionHandoverReportAcceptance,
} from "./task-main-session-handover-report-acceptance";

export const MAIN_SESSION_HANDOVER_REPORT_SOURCE = "task_main_session_handover";
export const MAIN_SESSION_HANDOVER_REPORT_MARKER = "KANBAN_MAIN_SESSION_HANDOVER_REPORT:";

interface HandoverCoordinatorDependencies {
	getAcpTaskSessionService?: (scope: RuntimeTrpcWorkspaceScope) => Promise<AcpTaskSessionService>;
	userIntentContextProvider?: TaskMainSessionHandoverUserIntentContextProvider;
	prepareNativeFork?: typeof prepareCodexMainSessionHandoverNativeFork;
	prepareRecoveryNativeFork?: typeof prepareCodexMainSessionHandoverRecoveryNativeFork;
	prepareTranscriptNativeFork?: typeof prepareTaskMainSessionHandoverTranscriptNativeFork;
	queryReportAcceptance?: typeof queryTaskMainSessionHandoverReportAcceptance;
	now?: () => number;
	getTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	loadScopedRuntimeConfig: (
		scope: RuntimeTrpcWorkspaceScope,
	) => Promise<
		Pick<RuntimeConfigState, "agentAutonomousModeEnabled"> &
			Partial<Pick<RuntimeConfigState, "ompAgentSessionTransportForNewTasks">>
	>;
	startTaskSession: RuntimeTrpcContext["runtimeApi"]["startTaskSession"];
	sendTaskChatMessage: RuntimeTrpcContext["runtimeApi"]["sendTaskChatMessage"];
	serializer: TaskCardActionPerTaskCommandSerializer;
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	broadcastState: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	warn: (message: string) => void;
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard {
	const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
	if (!card) throw new TRPCError({ code: "NOT_FOUND", message: "任务已不存在。" });
	return card;
}

function replaceCard(board: RuntimeBoardData, taskId: string, change: (card: RuntimeBoardCard) => RuntimeBoardCard) {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => (card.id === taskId ? change(card) : card)),
		})),
	};
}

export function isConversationSessionStillGenerating(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	if (!summary) return false;
	const facets = resolveSessionFacets(summary);
	return (
		facets.turnOwner === "agent" &&
		(facets.liveness === "live" || facets.liveness === "starting" || facets.liveness === "retrying")
	);
}

function isConversationSessionWaitingBeforeHandover(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	if (!summary) return false;
	const facets = resolveSessionFacets(summary);
	return (
		isConversationSessionStillGenerating(summary) ||
		(facets.userTurnKind !== null && MODAL_USER_DECISION_TURN_KINDS.has(facets.userTurnKind)) ||
		facets.liveness === "starting" ||
		facets.liveness === "retrying"
	);
}

const systemIntent = () =>
	buildTaskMutationIntentForKanbanRuntimeSystemComponent(
		"runtime_task_main_session_handover",
		"task_main_session_handover_coordinator",
	);
const reportDeliveryKey = (record: TaskMainSessionHandoverRecord) =>
	`${record.handoverId}:report:${record.reportDeliveryAttempt}`;

function isHandoverPendingProgress(record: TaskMainSessionHandoverRecord | undefined): boolean {
	return Boolean(
		record &&
			(["waiting_for_sessions_to_stop", "report_delivery_pending"].includes(record.status) ||
				(record.status === "awaiting_user_message" &&
					resolveTaskMainSessionHandoverTargetAgentId(record.destination) === "cursor" &&
					record.automaticRecovery?.classification !== "execution_prohibited") ||
				(record.status === "failed" &&
					record.automaticRecovery?.classification === "waiting_for_machine_evidence")),
	);
}

function isReportDefinitelyUndelivered(
	record: TaskMainSessionHandoverRecord,
	delivery: TaskMessageInjectionRecord | null | undefined,
): boolean {
	if (!delivery) return record.reportDeliveryStartedAt === null;
	return (
		delivery.terminal_delivery_status === "delivery_failed" &&
		[
			"no_active_terminal_session",
			"terminal_prompt_readiness_timeout",
			"human_terminal_contention_timeout",
			"terminal_input_box_contended_but_unstashable",
			"agent_awaiting_user_decision_timeout",
			"cancelled_before_delivery",
		].includes(delivery.terminal_delivery_failure_reason ?? "")
	);
}

function assertHandoverReportTargetExecutionEligibility(input: {
	workspaceId: string;
	card: RuntimeBoardCard;
	record: TaskMainSessionHandoverRecord;
	summary: RuntimeTaskSessionSummary | undefined;
}) {
	const { card, record, summary } = input;
	if (record.existingTargetSessionBinding)
		assertTaskMainSessionHandoverExistingTargetBinding({
			workspaceId: input.workspaceId,
			card,
			binding: record.existingTargetSessionBinding,
			target: summary,
		});
	const expectedWorkingDirectoryPath =
		record.reportAcceptanceProbe?.workingDirectoryPath ??
		record.reportNativeIdentityCaptureBinding?.workingDirectoryPath;
	if (
		resolveMainTaskConversationSessionId(card) !== record.targetTaskConversationSessionId ||
		!summary ||
		summary.agentId !== resolveTaskMainSessionHandoverTargetAgentId(record.destination) ||
		!doesConversationSessionBelongToTask(summary, card.id) ||
		(record.reportAcceptanceProbe?.targetAgentId && record.reportAcceptanceProbe.targetAgentId !== summary.agentId) ||
		(!summary.agentNativeConversationSessionIdentity &&
			record.reportNativeIdentityCaptureBinding &&
			record.reportNativeIdentityCaptureBinding.runtimeSessionIncarnationId !==
				summary.runtimeSessionIncarnationId) ||
		(expectedWorkingDirectoryPath &&
			(!summary.workspacePath || resolve(summary.workspacePath) !== resolve(expectedWorkingDirectoryPath))) ||
		(record.reportAcceptanceProbe &&
			(summary.agentNativeConversationSessionIdentity?.sourceAgentId !==
				resolveTaskMainSessionHandoverTargetAgentId(record.destination) ||
				summary.agentNativeConversationSessionIdentity.nativeSessionId !==
					record.reportAcceptanceProbe.nativeSessionId))
	)
		throw new TaskMainSessionHandoverExecutionProhibitedError(
			"报告接受事实与当前执行资格分开核验：当前主绑定、原生身份或工作目录归属已经变化，未继续执行。",
		);
}

export function renderTaskMainSessionHandoverReportPrompt(record: TaskMainSessionHandoverRecord): string {
	return `${resolveTaskMainSessionHandoverTargetAgentId(record.destination) === "codex" ? "/plan " : ""}${MAIN_SESSION_HANDOVER_REPORT_MARKER}${record.handoverId}:report:${record.reportDeliveryAttempt}
你现在接任本任务的 Main Session。此前作为协作会话的职责限制已被本次明确交接取代。
先读取持久交接材料：${join(record.materialDirectoryPath ?? "", "HANDOVER.md")}。
读取其中的任务需求、用户约束、计划引用、前任最后一条消息；需要补充证据时按需读取 transcript 与当前工作区。
此次只做只读梳理，不编辑文件、不提交、不部署、不自动运行 RVF，也不自行继续实施。
用简体中文汇报三部分：计划总览、已经实现、有待进行。区分有证据的事实、未完成事项与未知项，不把前任声称完成当作已验证。
汇报之后等待用户下一条消息。交接不是重新授权旧计划的实施，也不表示用户批准了任何未确认的计划。`;
}

function resolveHandoverSourceSummary(
	card: RuntimeBoardCard,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	const sessionId = resolveMainTaskConversationSessionId(card);
	const existing = sessions[sessionId];
	if (existing && isTaskMainSessionHandoverAgentSupported(existing.agentId)) {
		if (!doesConversationSessionBelongToTask(existing, card.id))
			throw new TRPCError({ code: "BAD_REQUEST", message: "来源会话不属于当前任务。" });
		return existing;
	}
	const declaredAgentId = existing?.agentId ?? card.mostRecentlyLaunchedAgentSessionAgentId ?? card.agentId;
	if (!isTaskMainSessionHandoverAgentSupported(declaredAgentId))
		throw new TRPCError({ code: "BAD_REQUEST", message: "当前 Agent 不在维护中的可启动交接能力范围内。" });
	if (existing) return { ...existing, agentId: declaredAgentId };
	// 旧任务可能只剩启动设置；保留确切 session ID，缺失身份与历史由材料层明确列出。
	return runtimeTaskSessionSummarySchema.parse({
		taskId: sessionId,
		workspacePath: null,
		agentId: declaredAgentId,
		state: "idle",
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	});
}

function validateExistingAgentTarget(
	card: RuntimeBoardCard,
	target: RuntimeTaskSessionSummary | undefined,
	expectedAgentId: string,
): asserts target is RuntimeTaskSessionSummary {
	const reason = target ? getTaskMainSessionHandoverExistingPeerUnavailableReason(card, target) : "所选会话已不存在。";
	if (!target || target.agentId !== expectedAgentId || reason) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: reason ?? "所选会话的 Agent 与请求不符。",
		});
	}
}

async function persistHandoverMaterial(
	workspaceId: string,
	taskId: string,
	record: TaskMainSessionHandoverRecord,
	material: TaskMainSessionHandoverMaterial,
): Promise<string> {
	const directory = join(
		getRuntimeHomePath(),
		"cross-task-handoff-artifacts",
		workspaceId,
		`task-${taskId}-main-session-handover`,
		record.handoverId,
	);
	await mkdir(directory, { recursive: true });
	const snapshots: string[] = [];
	const copyDurableSnapshot = async (source: string, destination: string) => {
		await copyFile(source, destination);
		const handle = await open(destination, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	};
	for (const [index, plan] of material.planReferences.entries()) {
		const path = join(directory, `source-plan-reference-${index + 1}.md`);
		await copyDurableSnapshot(plan.absolutePath, path);
		snapshots.push(`- 计划快照：${path}（原位置：${plan.absolutePath}；批准状态：${plan.approvalStatus}）`);
	}
	for (const [index, transcriptPath] of material.transcriptReferences.entries()) {
		const path = join(directory, `source-agent-transcript-${index + 1}.jsonl`);
		await copyDurableSnapshot(transcriptPath, path);
		snapshots.push(`- transcript 快照：${path}（原位置：${transcriptPath}）`);
	}
	await lockedFileSystem.writeJsonFileAtomic(join(directory, "handover-material.json"), material, { durable: true });
	await lockedFileSystem.writeTextFileAtomic(
		join(directory, "HANDOVER.md"),
		[
			`# 主会话交接：${material.taskTitle}`,
			"",
			`交接 ID：${record.handoverId}`,
			`来源：${record.sourceTaskConversationSessionId}（${material.sourceAgentId} ${material.sourceNativeConversationSessionId ?? "原生身份未知"}）`,
			`接收方：${record.targetTaskConversationSessionId}（${resolveTaskMainSessionHandoverTargetAgentId(record.destination)}）`,
			"",
			"## 原任务需求与用户约束",
			material.taskPrompt,
			"",
			"## 当前阶段目标",
			material.currentWorkPhaseGoal ?? "未知",
			"",
			"## 计划与 transcript 引用",
			...snapshots,
			...(material.embeddedPlanReferences ?? []).flatMap((plan) => [
				"",
				`内嵌计划（批准状态待确认；来源：${plan.sourceReference}）：`,
				plan.text,
			]),
			"",
			"## 意图材料来源",
			`提供方：${material.userIntentContext?.providerName ?? "原始材料（旧版本）"}；材料时间：${material.userIntentContext?.asOf ?? "未知"}`,
			material.userIntentContext?.userIntentContextText ?? "工作单元意图卷宗不可用，以上是未分类原始材料。",
			...(material.userIntentContext?.sourceReferences ?? []).map((reference) => `- 来源：${reference}`),
			"",
			"## 最后一条可确认的 agent 正文",
			material.lastAgentMessage?.text ?? "缺失",
			`来源：${material.lastAgentMessage?.sourceReference ?? "未知"}`,
			"",
			"## 工作区当前状态",
			`目录：${material.workspacePath}`,
			`HEAD：${material.workspaceHeadCommit ?? "未知"}`,
			material.workspaceGitStatus ?? "读取失败",
			"",
			"## 用户补充",
			material.userContextNotes || "无",
			"",
			"## 材料缺失与证据限制",
			...material.missingMaterialDescriptions.map((description) => `- ${description}`),
			"",
			"## 接任要求",
			"只读核对后汇报「计划总览、已经实现、有待进行」，然后等待用户消息。",
			"历史编辑归属与已有 RVF 证据保持原样；需要承接的既有改动应显式纳入后续审阅范围，不冒称为本会话的新编辑。",
			"Agent 叙述、投递角色和未知批准状态不等于人类逐字要求或新的实施授权；须结合原始来源核对。",
			"",
		].join("\n"),
		{ durable: true },
	);
	return directory;
}

export function createTaskMainSessionHandoverCoordinator(deps: HandoverCoordinatorDependencies) {
	const pendingScopes = new Map<string, RuntimeTrpcWorkspaceScope>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let sweeping: Promise<void> | null = null;
	let recovering: Promise<void> | null = null;
	let closed = false;
	const liveDeliveryKeys = new Set<string>();
	const cursorFollowupEvidenceFingerprintByTask = new Map<string, string>();

	async function loadState(scope: RuntimeTrpcWorkspaceScope) {
		const state = await loadPersistedWorkspaceStateById(scope.workspaceId);
		const terminalManager = await deps.getTerminalManager(scope);
		const acp = await deps.getAcpTaskSessionService?.(scope);
		const manager = {
			hasLiveTaskSession: (id: string) =>
				acp?.getSummary(id)
					? (acp.hasLiveTaskSession?.(id) ?? false)
					: (terminalManager.hasLiveTaskSession?.(id) ?? false),
			getSummary: (id: string) => acp?.getSummary(id) ?? terminalManager.getSummary(id),
			listSummaries: () => [...terminalManager.listSummaries(), ...(acp?.listSummaries() ?? [])],
			applyTaskConversationSessionMetadata: (
				id: string,
				metadata: RuntimeTaskSessionSummary["taskConversationSessionMetadata"],
			) =>
				acp?.getSummary(id)
					? acp.applyTaskConversationSessionMetadata(id, metadata)
					: terminalManager.applyTaskConversationSessionMetadata(id, metadata),
			hydrateFromRecord: (summaries: Record<string, RuntimeTaskSessionSummary>) =>
				terminalManager.hydrateFromRecord(
					Object.fromEntries(
						Object.entries(summaries).filter(
							([, summary]) => summary.sessionTransport !== "acp_stdio_subprocess",
						),
					),
				),
			stopTaskSession: async (id: string) =>
				acp?.getSummary(id) ? await acp.stopTaskSession(id) : terminalManager.stopTaskSession(id),
			hasPendingProgrammaticTaskChatInputDelivery: (id: string) =>
				terminalManager.hasPendingProgrammaticTaskChatInputDelivery?.(id) ?? false,
		};
		const live = Object.fromEntries(manager.listSummaries().map((summary) => [summary.taskId, summary]));
		return {
			...state,
			sessions: projectTaskConversationSessionsForMainSessionBinding(state.board, { ...state.sessions, ...live }),
			manager,
		};
	}
	async function syncManager(scope: RuntimeTrpcWorkspaceScope) {
		const state = await loadState(scope);
		for (const summary of Object.values(state.sessions)) {
			const existing = state.manager.getSummary(summary.taskId);
			if (existing)
				state.manager.applyTaskConversationSessionMetadata(summary.taskId, summary.taskConversationSessionMetadata);
		}
		await deps.broadcastState(scope.workspaceId, scope.workspacePath);
	}
	async function setRecord(
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		handoverId: string,
		change: (record: TaskMainSessionHandoverRecord) => TaskMainSessionHandoverRecord,
		expectedReportDeliveryAttempt?: number,
	) {
		await mutateWorkspaceState(scope.workspacePath, systemIntent(), (state) => {
			const card = state.board.columns
				.flatMap((column) => column.cards)
				.find((candidate) => candidate.id === taskId);
			if (card?.taskMainSessionHandover?.handoverId !== handoverId)
				return { board: state.board, value: null, save: false };
			if (
				expectedReportDeliveryAttempt !== undefined &&
				card.taskMainSessionHandover.reportDeliveryAttempt !== expectedReportDeliveryAttempt
			)
				return { board: state.board, value: null, save: false };
			if (
				card.taskMainSessionHandover.status === "completed" ||
				card.taskMainSessionHandover.status === "cancelled"
			) {
				return { board: state.board, value: null, save: false };
			}
			const nextRecord = change(card.taskMainSessionHandover);
			if (
				card.taskMainSessionHandover.automaticRecovery?.classification === "execution_prohibited" &&
				!["failed", "cancelled"].includes(nextRecord.status)
			)
				return { board: state.board, value: null, save: false };
			return {
				board: replaceCard(state.board, taskId, (current) => ({
					...current,
					taskMainSessionHandover: nextRecord,
				})),
				value: null,
			};
		});
		await syncManager(scope);
	}
	async function collect(
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
		source: RuntimeTaskSessionSummary,
		record?: TaskMainSessionHandoverRecord,
	) {
		const cwd =
			source.workspacePath ??
			(
				await getTaskWorkspacePathInfo({
					cwd: scope.workspacePath,
					taskId: card.id,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
				})
			).path;
		const [status, head] = await Promise.all([
			deps.runCommand("git status --short", cwd).catch(() => null),
			deps.runCommand("git rev-parse HEAD", cwd).catch(() => null),
		]);
		const sessions = Object.values((await loadState(scope)).sessions).filter((summary) =>
			doesConversationSessionBelongToTask(summary, card.id),
		);
		const acp = await deps.getAcpTaskSessionService?.(scope);
		return await collectTaskMainSessionHandoverMaterial({
			workspaceId: scope.workspaceId,
			card,
			sourceSummary: source,
			workspacePath: cwd,
			conversationSessions: sessions,
			userIntentContextProvider: deps.userIntentContextProvider,
			retainedMessages: acp?.listMessages(source.taskId),
			userContextNotes: record?.userContextNotes,
			additionalPlanReferencePaths: record?.additionalPlanReferencePaths,
			workspaceGitStatus: status?.exitCode === 0 ? status.stdout.trim() : null,
			workspaceHeadCommit: head?.exitCode === 0 ? head.stdout.trim() : null,
		});
	}
	async function prepare(
		scope: RuntimeTrpcWorkspaceScope,
		input: { taskId: string },
	): Promise<TaskMainSessionHandoverPrepareResponse> {
		const state = await loadState(scope);
		const card = findCard(state.board, input.taskId);
		const sourceId = resolveMainTaskConversationSessionId(card);
		const source = resolveHandoverSourceSummary(card, state.sessions);
		return {
			material: await collect(scope, card, source),
			targetAgentCapabilities: listTaskMainSessionHandoverTargetCapabilities(source).map((capability) => ({
				...capability,
				installationStatus: isBinaryAvailableOnPath(
					getRuntimeAgentCatalogEntry(capability.agentId)?.binary ?? capability.agentId,
				)
					? "installed"
					: "not_installed",
			})),
			completeNativeConversationForkAvailability: getTaskMainSessionHandoverNativeForkAvailability(source, "codex"),
			mainTaskConversationSessionId: sourceId,
			codexPeerTaskConversationSessionIds: Object.values(state.sessions)
				.filter(
					(summary) =>
						summary.agentId === "codex" &&
						doesConversationSessionBelongToTask(summary, card.id) &&
						summary.taskConversationSessionMetadata?.taskConversationSessionRole === "task_collaborator" &&
						summary.agentNativeConversationSessionIdentity?.sourceAgentId === "codex" &&
						getTaskMainSessionHandoverExistingPeerUnavailableReason(card, summary) === null,
				)
				.map((summary) => summary.taskId),
			existingPeerCandidates: Object.values(state.sessions).flatMap((summary) => {
				const parsed = taskMainSessionHandoverExistingPeerAgentIdSchema.safeParse(summary.agentId);
				if (
					!parsed.success ||
					!doesConversationSessionBelongToTask(summary, card.id) ||
					summary.taskId === sourceId ||
					summary.taskConversationSessionMetadata?.taskConversationSessionRole !== "task_collaborator" ||
					summary.taskConversationSessionMetadata.taskConversationSessionRoleAtCreation === "by_the_way"
				)
					return [];
				const unavailableReason = getTaskMainSessionHandoverExistingPeerUnavailableReason(card, summary);
				return [
					{
						taskConversationSessionId: summary.taskId,
						agentId: parsed.data,
						displayName: summary.taskConversationSessionMetadata.latestUserMessagePreview ?? summary.taskId,
						available: unavailableReason === null,
						unavailableReason,
					},
				];
			}),
			busyTaskConversationSessionIds: Object.values(state.sessions)
				.filter(
					(summary) =>
						doesConversationSessionBelongToTask(summary, card.id) &&
						isConversationSessionWaitingBeforeHandover(summary),
				)
				.map((summary) => summary.taskId),
		};
	}

	async function progress(scope: RuntimeTrpcWorkspaceScope, taskId: string) {
		await deps.serializer.runTaskCardActionCommandSeriallyForTaskCards(scope.workspaceId, [taskId], async () => {
			const state = await loadState(scope);
			const card = findCard(state.board, taskId);
			let record = card.taskMainSessionHandover;
			if (
				record?.status === "awaiting_user_message" &&
				resolveTaskMainSessionHandoverTargetAgentId(record.destination) === "cursor" &&
				record.automaticRecovery?.classification !== "execution_prohibited"
			) {
				const target = state.sessions[record.targetTaskConversationSessionId];
				assertHandoverReportTargetExecutionEligibility({
					workspaceId: scope.workspaceId,
					card,
					record,
					summary: target,
				});
				if (!target) return;
				const fingerprint = await fingerprintTaskMainSessionHandoverRecoveryEvidence({ record, target });
				const key = `${scope.workspaceId}:${taskId}`;
				if (cursorFollowupEvidenceFingerprintByTask.get(key) === fingerprint) return;
				const promptText = await queryCursorMainSessionHandoverAcceptedHumanFollowup({ card, summary: target });
				cursorFollowupEvidenceFingerprintByTask.set(key, fingerprint);
				if (cursorFollowupEvidenceFingerprintByTask.size > 1_000) {
					const oldestKey = cursorFollowupEvidenceFingerprintByTask.keys().next().value;
					if (oldestKey !== undefined) cursorFollowupEvidenceFingerprintByTask.delete(oldestKey);
				}
				if (promptText)
					await completeTaskMainSessionHandoverAfterUserMessage({
						...scope,
						taskConversationSessionId: target.taskId,
						expectedHandoverId: record.handoverId,
						promptText,
						isAcceptedConversationIdentityStillCurrent: () => {
							const current = state.manager.getSummary(target.taskId);
							return (
								current?.runtimeSessionIncarnationId === target.runtimeSessionIncarnationId &&
								current?.agentNativeConversationSessionIdentity?.nativeSessionId ===
									target.agentNativeConversationSessionIdentity?.nativeSessionId
							);
						},
						onTaskConversationSessionMetadataChanged: (id, metadata) =>
							state.manager.applyTaskConversationSessionMetadata(id, metadata),
					});
				return;
			}
			if (!record || !["waiting_for_sessions_to_stop", "report_delivery_pending", "failed"].includes(record.status))
				return;
			const resumingFailedRecord = record.status === "failed";
			if (resumingFailedRecord) {
				if (!record.automaticRecovery) return;
				const fingerprint = await fingerprintTaskMainSessionHandoverRecoveryEvidence({
					record,
					source: state.sessions[record.sourceTaskConversationSessionId],
					target: state.sessions[record.targetTaskConversationSessionId],
				});
				if (
					!canRetryTaskMainSessionHandoverMachineEvidence({
						previous: record.automaticRecovery,
						evidenceFingerprint: fingerprint,
						now: (deps.now ?? Date.now)(),
					})
				)
					return;
				const status =
					resolveMainTaskConversationSessionId(card) === record.sourceTaskConversationSessionId
						? ("waiting_for_sessions_to_stop" as const)
						: ("report_delivery_pending" as const);
				const automaticRecovery = beginTaskMainSessionHandoverMachineEvidenceAttempt({
					previous: record.automaticRecovery,
					evidenceFingerprint: fingerprint,
					stage: record.automaticRecovery.stage,
					now: (deps.now ?? Date.now)(),
					reason: "正在自动补查原交接证据。",
				});
				await setRecord(scope, taskId, record.handoverId, (current) => ({ ...current, status, automaticRecovery }));
				record = { ...record, status, automaticRecovery };
				const previousDelivery = findTaskMessageInjectionRecord(
					await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath)),
					record.targetTaskConversationSessionId,
					reportDeliveryKey(record),
				);
				if (status === "report_delivery_pending" && isReportDefinitelyUndelivered(record, previousDelivery)) {
					record = {
						...record,
						reportDeliveryStartedAt: null,
						reportDeliveryAttempt: record.reportDeliveryAttempt + 1,
						reportNativeIdentityCaptureBinding: undefined,
						reportAcceptanceProbe: undefined,
						inputAwaitingCorrelatedProcessingHook: undefined,
						reportCorrelatedProcessingAcceptanceEvidence: undefined,
					};
					const retried = record;
					await setRecord(scope, taskId, record.handoverId, () => retried);
				}
			}
			if (
				state.board.columns.some(
					(column) => column.id === "trash" && column.cards.some((entry) => entry.id === taskId),
				)
			) {
				await setRecord(scope, taskId, record.handoverId, (current) => ({
					...current,
					status: "cancelled",
					updatedAt: Date.now(),
					errorMessage: "任务已经结案，交接已取消。",
				}));
				return;
			}
			if (record.status === "waiting_for_sessions_to_stop") {
				if (resolveMainTaskConversationSessionId(card) !== record.sourceTaskConversationSessionId) {
					await setRecord(scope, taskId, record.handoverId, (current) => ({
						...current,
						status: "cancelled",
						updatedAt: Date.now(),
						errorMessage: "主会话绑定已改变，交接已取消。",
					}));
					return;
				}
				const source = resolveHandoverSourceSummary(card, state.sessions);
				const target = state.sessions[record.targetTaskConversationSessionId];
				if (isTaskMainSessionHandoverExistingTarget(record.destination)) {
					if (!record.existingTargetSessionBinding) {
						validateExistingAgentTarget(
							card,
							target,
							resolveTaskMainSessionHandoverTargetAgentId(record.destination),
						);
						const binding = captureTaskMainSessionHandoverExistingTargetBinding(scope.workspaceId, card, target);
						await setRecord(scope, taskId, record.handoverId, (current) => ({
							...current,
							existingTargetSessionBinding: binding,
						}));
						record = { ...record, existingTargetSessionBinding: binding };
					}
					assertTaskMainSessionHandoverExistingTargetBinding({
						workspaceId: scope.workspaceId,
						card,
						target,
						binding: record.existingTargetSessionBinding as NonNullable<
							TaskMainSessionHandoverRecord["existingTargetSessionBinding"]
						>,
					});
				}
				if (
					isConversationSessionWaitingBeforeHandover(source) ||
					isConversationSessionWaitingBeforeHandover(target)
				)
					return;
				const material =
					record.nativeForkPreparationReceiptPath && record.materialDirectoryPath
						? taskMainSessionHandoverMaterialSchema.parse(
								JSON.parse(
									await readFile(join(record.materialDirectoryPath, "handover-material.json"), "utf8"),
								),
							)
						: await collect(scope, card, source, record);
				if (
					record.nativeForkPreparationReceiptPath &&
					material.sourceNativeConversationSessionId !==
						source.agentNativeConversationSessionIdentity?.nativeSessionId
				)
					throw new TaskMainSessionHandoverExecutionProhibitedError(
						"原生来源已改变，保留原交接材料，未覆盖固定快照。",
					);
				const directory =
					record.nativeForkPreparationReceiptPath && record.materialDirectoryPath
						? record.materialDirectoryPath
						: await persistHandoverMaterial(scope.workspaceId, taskId, record, material);
				let nativeFork:
					| PreparedCodexMainSessionHandoverNativeFork
					| Awaited<ReturnType<typeof prepareTaskMainSessionHandoverTranscriptNativeFork>>
					| undefined;
				if (isTaskMainSessionHandoverNativeForkRequested(record.destination)) {
					const receiptFilePath =
						record.nativeForkPreparationReceiptPath ?? join(directory, "native-fork-preparation.json");
					await setRecord(scope, taskId, record.handoverId, (current) => ({
						...current,
						materialDirectoryPath: directory,
						nativeForkPreparationReceiptPath: receiptFilePath,
					}));
					const beforeFork = findCard((await loadState(scope)).board, taskId);
					if (
						beforeFork.taskMainSessionHandover?.handoverId !== record.handoverId ||
						beforeFork.taskMainSessionHandover.status !== "waiting_for_sessions_to_stop" ||
						resolveMainTaskConversationSessionId(beforeFork) !== source.taskId
					)
						throw new TaskMainSessionHandoverExecutionProhibitedError(
							"交接已停止或来源主绑定改变，未继续原生准备。",
						);
					if (source.agentId === "codex") {
						nativeFork = await (deps.prepareNativeFork ?? prepareCodexMainSessionHandoverNativeFork)({
							handoverId: record.handoverId,
							sourceSummary: source,
							receiptFilePath,
						});
					} else {
						const identity = source.agentNativeConversationSessionIdentity;
						if (
							(source.agentId !== "claude" && source.agentId !== "omp") ||
							!identity?.transcriptPath ||
							!source.workspacePath
						)
							throw new TaskMainSessionHandoverExecutionProhibitedError(
								"等待同 harness 的可靠原生身份与固定历史。",
							);
						nativeFork = await (
							deps.prepareTranscriptNativeFork ?? prepareTaskMainSessionHandoverTranscriptNativeFork
						)({
							handoverId: record.handoverId,
							sourceAgentId: source.agentId,
							sourceTaskConversationSessionId: source.taskId,
							sourceNativeSessionId: identity.nativeSessionId,
							sourceTranscriptPath: identity.transcriptPath,
							sourceTranscriptSnapshotPath: material.transcriptReferences.includes(identity.transcriptPath)
								? join(
										directory,
										`source-agent-transcript-${material.transcriptReferences.indexOf(identity.transcriptPath) + 1}.jsonl`,
									)
								: undefined,
							workingDirectoryPath: source.workspacePath,
							receiptFilePath,
						});
					}
					record = { ...record, nativeForkPreparationReceiptPath: receiptFilePath };
					const latestSource = (await loadState(scope)).sessions[source.taskId];
					if (
						latestSource?.agentNativeConversationSessionIdentity?.nativeSessionId !==
						source.agentNativeConversationSessionIdentity?.nativeSessionId
					)
						throw new TaskMainSessionHandoverExecutionProhibitedError("来源原生身份已改变，未切换主会话。");
				}
				// 材料读取期间可能又开始一轮；在改绑定前重新核对，保持原主责任直到真正空闲。
				if (
					isConversationSessionWaitingBeforeHandover(state.manager.getSummary(source.taskId)) ||
					isConversationSessionWaitingBeforeHandover(
						state.manager.getSummary(record.targetTaskConversationSessionId),
					)
				)
					return;
				const selectedRecord = record;
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(scope);
				const switched = await mutateWorkspaceState(scope.workspacePath, systemIntent(), (latest) => {
					const current = findCard(latest.board, taskId);
					if (
						latest.board.columns.some(
							(column) => column.id === "trash" && column.cards.some((entry) => entry.id === taskId),
						) ||
						isConversationSessionWaitingBeforeHandover(state.manager.getSummary(source.taskId)) ||
						isConversationSessionWaitingBeforeHandover(
							state.manager.getSummary(selectedRecord.targetTaskConversationSessionId),
						) ||
						resolveMainTaskConversationSessionId(current) !== selectedRecord.sourceTaskConversationSessionId ||
						current.taskMainSessionHandover?.handoverId !== selectedRecord.handoverId ||
						current.taskMainSessionHandover.status !== "waiting_for_sessions_to_stop"
					) {
						return { board: latest.board, value: false, save: false };
					}
					const nextRecord = {
						...selectedRecord,
						status: "report_delivery_pending" as const,
						materialDirectoryPath: directory,
						updatedAt: Date.now(),
						automaticRecovery: undefined,
					};
					const nextBoard = replaceCard(latest.board, taskId, (entry) => ({
						...entry,
						agentId: resolveTaskMainSessionHandoverTargetAgentId(selectedRecord.destination),
						mainTaskConversationSessionId: selectedRecord.targetTaskConversationSessionId,
						taskMainSessionHandover: nextRecord,
					}));
					const taskAgentPermissionMode =
						current.taskAgentPermissionMode ??
						resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(
							scopedRuntimeConfig.agentAutonomousModeEnabled,
						);
					const latestExistingTarget =
						state.manager.getSummary(selectedRecord.targetTaskConversationSessionId) ??
						latest.sessions[selectedRecord.targetTaskConversationSessionId];
					if (selectedRecord.existingTargetSessionBinding)
						assertTaskMainSessionHandoverExistingTargetBinding({
							workspaceId: scope.workspaceId,
							card: current,
							target: latestExistingTarget,
							binding: selectedRecord.existingTargetSessionBinding,
						});
					const targetSummary =
						latestExistingTarget ??
						runtimeTaskSessionSummarySchema.parse({
							taskId: selectedRecord.targetTaskConversationSessionId,
							state: "idle",
							agentId: resolveTaskMainSessionHandoverTargetAgentId(selectedRecord.destination),
							workspacePath: material.workspacePath,
							pid: null,
							startedAt: null,
							updatedAt: Date.now(),
							lastOutputAt: null,
							reviewReason: null,
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
							...(nativeFork
								? {
										agentNativeConversationSessionIdentity: {
											sourceAgentId: resolveTaskMainSessionHandoverTargetAgentId(selectedRecord.destination),
											nativeSessionId: nativeFork.nativeSessionId,
											transcriptPath: nativeFork.transcriptPath,
											observedAt: Date.now(),
										},
										codexConversationStorageHomeDirectoryPath:
											nativeFork.codexConversationStorageHomeDirectoryPath,
									}
								: {}),
							turnOwner: null,
							liveness: "none",
							userTurnKind: null,
							taskConversationSessionMetadata: {
								workspaceTaskId: taskId,
								taskConversationSessionRole: "main",
								taskConversationSessionRoleAtCreation: "task_collaborator",
								taskConversationSessionHasHeldMainResponsibility: true,
								taskConversationSessionContextSource: nativeFork
									? "forked_from_main_current_turn"
									: "started_from_scratch",
								parentTaskConversationSessionId: nativeFork ? source.taskId : null,
								mainSessionOriginTurnNumber: nativeFork?.sourceCompletedTurnCount ?? null,
								mainSessionOriginUserMessagePreview: null,
								latestUserMessagePreview: "读取交接材料并汇报现状",
								// 与主绑定一起落盘，冷恢复不依赖首次 start 已经写入快照。
								taskConversationSessionLaunchSettings: {
									taskAgentPermissionMode,
									...(selectedRecord.destination.kind === "new_agent_session"
										? { startInPlanMode: true }
										: {}),
									sessionTransport: nativeFork
										? resolveRuntimeAgentSessionTransportFromSummary(source)
										: resolveTaskMainSessionHandoverTargetAgentId(selectedRecord.destination) === "omp"
											? (scopedRuntimeConfig.ompAgentSessionTransportForNewTasks ?? "pty_terminal")
											: "pty_terminal",
								},
							},
						});
					const sourceSummary =
						state.manager.getSummary(source.taskId) ?? latest.sessions[source.taskId] ?? source;
					const sourceMetadata = sourceSummary.taskConversationSessionMetadata;
					// 原主会话的配置可能只存在卡片上；切主前留下其独立启动快照。
					const durableSourceSummary = {
						...sourceSummary,
						taskConversationSessionMetadata: {
							workspaceTaskId: taskId,
							taskConversationSessionRole: "main" as const,
							taskConversationSessionRoleAtCreation: "main" as const,
							taskConversationSessionContextSource: "main" as const,
							parentTaskConversationSessionId: null,
							mainSessionOriginTurnNumber: null,
							mainSessionOriginUserMessagePreview: null,
							latestUserMessagePreview: null,
							...sourceMetadata,
							taskConversationSessionHasHeldMainResponsibility: true,
							taskConversationSessionLaunchSettings: sourceMetadata?.taskConversationSessionLaunchSettings ??
								latest.sessions[source.taskId]?.taskConversationSessionMetadata
									?.taskConversationSessionLaunchSettings ?? {
									taskAgentPermissionMode,
									...(selectedRecord.destination.kind === "new_agent_session"
										? { startInPlanMode: true }
										: {}),
									sessionTransport: resolveRuntimeAgentSessionTransportFromSummary(sourceSummary),
									terminalAgentModelOverrideSettings:
										current.terminalAgentModelOverrideSettings?.agentId === sourceSummary.agentId
											? current.terminalAgentModelOverrideSettings
											: undefined,
								},
						},
					};
					return {
						board: nextBoard,
						sessions: {
							...latest.sessions,
							[source.taskId]: durableSourceSummary,
							[selectedRecord.targetTaskConversationSessionId]: targetSummary,
						},
						value: true,
					};
				});
				if (!switched.value) return;
				state.manager.applyTaskConversationSessionMetadata(
					source.taskId,
					switched.state.sessions[source.taskId]?.taskConversationSessionMetadata,
				);
				await syncManager(scope);
				record = findCard(switched.state.board, taskId).taskMainSessionHandover;
			}
			if (!record || record.status !== "report_delivery_pending") return;
			if (
				resolveMainTaskConversationSessionId(findCard((await loadState(scope)).board, taskId)) !==
				record.targetTaskConversationSessionId
			)
				throw new TaskMainSessionHandoverExecutionProhibitedError("当前主会话绑定已经改变，停止后续投递。");
			const existingReportDelivery = findTaskMessageInjectionRecord(
				await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath)),
				record.targetTaskConversationSessionId,
				reportDeliveryKey(record),
			);
			if (record.reportDeliveryStartedAt !== null || existingReportDelivery) {
				const ledger = await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath));
				const delivery = findTaskMessageInjectionRecord(
					ledger,
					record.targetTaskConversationSessionId,
					reportDeliveryKey(record),
				);
				if (delivery?.terminal_delivery_status === "delivered_and_submit_confirmed") {
					const current = await loadState(scope);
					assertHandoverReportTargetExecutionEligibility({
						workspaceId: scope.workspaceId,
						card: findCard(current.board, taskId),
						record,
						summary: current.sessions[record.targetTaskConversationSessionId],
					});
					await setRecord(scope, taskId, record.handoverId, (current) => ({
						...current,
						status: "awaiting_user_message",
						errorMessage: null,
						automaticRecovery: undefined,
						updatedAt: Date.now(),
					}));
				} else if (
					delivery?.terminal_delivery_status === "delivery_failed" ||
					!liveDeliveryKeys.has(reportDeliveryKey(record)) ||
					record.reportAcceptanceProbe !== undefined
				) {
					const target = (await loadState(scope)).sessions[record.targetTaskConversationSessionId];
					if (record.reportAcceptanceProbe && target) {
						if (!resumingFailedRecord) {
							const fingerprint = await fingerprintTaskMainSessionHandoverRecoveryEvidence({
								record,
								target,
								source: state.sessions[record.sourceTaskConversationSessionId],
							});
							if (
								record.automaticRecovery &&
								!canRetryTaskMainSessionHandoverMachineEvidence({
									previous: record.automaticRecovery,
									evidenceFingerprint: fingerprint,
									now: (deps.now ?? Date.now)(),
								})
							) {
								if (delivery?.terminal_delivery_status === "delivery_failed")
									throw new Error("报告接受仍待机器补证；等待有界重验条件，不自动重发。");
								return;
							}
							await setRecord(scope, taskId, record.handoverId, (current) => ({
								...current,
								automaticRecovery: beginTaskMainSessionHandoverMachineEvidenceAttempt({
									previous: current.automaticRecovery,
									evidenceFingerprint: fingerprint,
									stage: "confirming_report_acceptance",
									now: (deps.now ?? Date.now)(),
									reason: "正在只读补查报告的原生接受证据。",
								}),
							}));
						}
						const probe = await (deps.queryReportAcceptance ?? queryTaskMainSessionHandoverReportAcceptance)({
							workspaceId: scope.workspaceId,
							card,
							summary: target,
							probe: record.reportAcceptanceProbe,
							prompt: renderTaskMainSessionHandoverReportPrompt(record),
							expectedReportDeliveryKey: reportDeliveryKey(record),
						});
						await setRecord(scope, taskId, record.handoverId, (current) => ({
							...current,
							reportAcceptanceProbe: probe,
							automaticRecovery:
								current.automaticRecovery && current.reportAcceptanceProbe
									? recordTaskMainSessionHandoverReportAcceptanceScanProgress({
											previous: current.automaticRecovery,
											before: current.reportAcceptanceProbe,
											after: probe,
										})
									: current.automaticRecovery,
						}));
						if (probe.historicalAcceptanceEvidence) {
							const latest = await loadState(scope);
							assertHandoverReportTargetExecutionEligibility({
								workspaceId: scope.workspaceId,
								card: findCard(latest.board, taskId),
								record: { ...record, reportAcceptanceProbe: probe },
								summary: latest.sessions[record.targetTaskConversationSessionId],
							});
							await setRecord(scope, taskId, record.handoverId, (current) => ({
								...current,
								status: "awaiting_user_message",
								errorMessage: null,
								automaticRecovery: undefined,
								updatedAt: Date.now(),
							}));
							return;
						}
					}
					if (
						delivery?.terminal_delivery_status === "delivered_queued_behind_active_agent_turn" ||
						(delivery?.terminal_delivery_status === "accepted_pending_submit_confirmation" &&
							liveDeliveryKeys.has(reportDeliveryKey(record)))
					)
						return;
					throw new Error("交接汇报接受结果尚未确认；系统继续沿原投递身份只读补证，不自动重发。");
				}
				return;
			}
			const target = (await loadState(scope)).sessions[record.targetTaskConversationSessionId];
			if (target?.agentNativeConversationSessionIdentity && !state.manager.getSummary(target.taskId))
				state.manager.hydrateFromRecord({ [target.taskId]: target });
			const canReuseStartedTarget =
				target &&
				state.manager.hasLiveTaskSession(target.taskId) &&
				(record.targetSessionStartupCompletedAt !== undefined ||
					isTaskMainSessionHandoverExistingTarget(record.destination));
			if (
				isConversationSessionWaitingBeforeHandover(target) &&
				(!canReuseStartedTarget || isTaskMainSessionHandoverExistingTarget(record.destination))
			)
				return;
			if (
				!isTaskMainSessionHandoverExistingTarget(record.destination) &&
				!canReuseStartedTarget &&
				target?.startedAt != null
			)
				await state.manager.stopTaskSession(target.taskId);
			const metadata = target?.taskConversationSessionMetadata ?? {
				workspaceTaskId: taskId,
				taskConversationSessionRole: "main" as const,
				taskConversationSessionRoleAtCreation: "task_collaborator" as const,
				taskConversationSessionContextSource: "started_from_scratch" as const,
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: null,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: "读取交接材料并汇报现状",
			};
			const latestBeforeStart = findCard((await loadState(scope)).board, taskId);
			if (
				latestBeforeStart.taskMainSessionHandover?.status !== "report_delivery_pending" ||
				latestBeforeStart.taskMainSessionHandover.handoverId !== record.handoverId
			)
				throw new TaskMainSessionHandoverExecutionProhibitedError("交接已经停止或改变，未启动接任会话。");
			if (record.existingTargetSessionBinding)
				assertTaskMainSessionHandoverExistingTargetBinding({
					workspaceId: scope.workspaceId,
					card: latestBeforeStart,
					target,
					binding: record.existingTargetSessionBinding,
				});
			const startup = canReuseStartedTarget
				? { ok: true, summary: target }
				: await deps.startTaskSession(scope, {
						taskId: record.targetTaskConversationSessionId,
						workspaceTaskId: taskId,
						taskConversationSessionMetadata: {
							...metadata,
							taskConversationSessionRole: "main",
							taskAutomationSuspendedForMainSessionHandover: true,
						},
						agentId: resolveTaskMainSessionHandoverTargetAgentId(record.destination),
						prompt: "",
						baseRef: card.baseRef,
						worktreeMode: card.worktreeMode,
						taskConversationMode: isTaskMainSessionHandoverExistingTarget(record.destination)
							? (record.existingTargetSessionBinding?.taskConversationMode ??
								target?.taskConversationMode ??
								"operational")
							: undefined,
						taskAgentPermissionMode:
							metadata.taskConversationSessionLaunchSettings?.taskAgentPermissionMode ??
							card.taskAgentPermissionMode,
						terminalAgentModelOverrideSettings:
							metadata.taskConversationSessionLaunchSettings?.terminalAgentModelOverrideSettings,
						resumePriorAgentConversationWithoutResendingPrompt:
							target?.agentNativeConversationSessionIdentity?.sourceAgentId ===
							resolveTaskMainSessionHandoverTargetAgentId(record.destination),
						startInPlanMode: isTaskMainSessionHandoverExistingTarget(record.destination)
							? metadata.taskConversationSessionLaunchSettings?.startInPlanMode
							: resolveTaskMainSessionHandoverTargetAgentId(record.destination) !== "codex",
						expectedExistingMainSessionHandoverTargetBinding: record.existingTargetSessionBinding,
						requestedAgentSessionTransport: metadata.taskConversationSessionLaunchSettings?.sessionTransport,
					});
			if (!startup.ok) throw new Error(startup.error ?? "接任 Agent 启动失败。");
			await setRecord(scope, taskId, record.handoverId, (current) => ({
				...current,
				targetSessionStartupCompletedAt: current.targetSessionStartupCompletedAt ?? Date.now(),
			}));
			const deliveryTarget =
				(await loadState(scope)).sessions[record.targetTaskConversationSessionId] ?? startup.summary;
			if (record.existingTargetSessionBinding)
				assertTaskMainSessionHandoverExistingTargetBinding({
					workspaceId: scope.workspaceId,
					card: latestBeforeStart,
					target: deliveryTarget,
					binding: record.existingTargetSessionBinding,
				});
			const nativeIdentity = deliveryTarget?.agentNativeConversationSessionIdentity;
			const reportRuntimeSessionIncarnationId = deliveryTarget?.runtimeSessionIncarnationId;
			const reportWorkingDirectoryPath = deliveryTarget?.workspacePath;
			if (reportRuntimeSessionIncarnationId && reportWorkingDirectoryPath)
				await setRecord(scope, taskId, record.handoverId, (current) => ({
					...current,
					reportNativeIdentityCaptureBinding: {
						targetAgentId: resolveTaskMainSessionHandoverTargetAgentId(current.destination),
						runtimeSessionIncarnationId: reportRuntimeSessionIncarnationId,
						workingDirectoryPath: reportWorkingDirectoryPath,
						codexConversationStorageHomeDirectoryPath:
							deliveryTarget?.agentId === "codex"
								? resolveRecordedCodexConversationHome({
										...deliveryTarget,
										transcriptPath: nativeIdentity?.transcriptPath,
									})
								: undefined,
						preparedAt: Date.now(),
					},
				}));
			if (
				nativeIdentity?.sourceAgentId !== resolveTaskMainSessionHandoverTargetAgentId(record.destination) &&
				!deliveryTarget?.runtimeSessionIncarnationId
			)
				throw new Error("接任会话尚无可靠原生身份或进程代际，等待机器证据后再提交汇报。");
			if (
				nativeIdentity?.sourceAgentId === resolveTaskMainSessionHandoverTargetAgentId(record.destination) &&
				deliveryTarget?.workspacePath
			) {
				const probe = {
					targetAgentId: resolveTaskMainSessionHandoverTargetAgentId(record.destination),
					nativeSessionId: nativeIdentity.nativeSessionId,
					workingDirectoryPath: deliveryTarget.workspacePath,
					transcriptPath: nativeIdentity.transcriptPath,
					codexConversationStorageHomeDirectoryPath:
						deliveryTarget.agentId === "codex"
							? resolveRecordedCodexConversationHome({
									...deliveryTarget,
									transcriptPath: nativeIdentity.transcriptPath,
								})
							: undefined,
					nativeHistoryCursor: null,
					transcriptHistoryCursor: null,
					seenNativeHistoryCursors: [],
					historicalAcceptanceEvidence: null,
				};
				await setRecord(scope, taskId, record.handoverId, (current) => ({
					...current,
					reportAcceptanceProbe: probe,
				}));
			}
			if (
				isConversationSessionWaitingBeforeHandover(deliveryTarget) &&
				isTaskMainSessionHandoverExistingTarget(record.destination)
			)
				return;
			const prompt = renderTaskMainSessionHandoverReportPrompt(record);
			const hash = createHash("sha256").update(prompt).digest("hex");
			const ledgerPath = getTaskMessageInjectionLedgerPath(state.statePath);
			const claimed = await withTaskMessageInjectionLedgerLock(ledgerPath, async (records) => {
				if (
					findTaskMessageInjectionRecord(
						records,
						record.targetTaskConversationSessionId,
						reportDeliveryKey(record),
					)
				)
					return { result: false };
				return {
					records: [
						...records,
						createPendingTaskMessageInjectionRecord({
							taskId: record.targetTaskConversationSessionId,
							source: MAIN_SESSION_HANDOVER_REPORT_SOURCE,
							idempotencyKey: reportDeliveryKey(record),
							promptSha256: hash,
							nowIso: new Date().toISOString(),
						}),
					],
					result: true,
				};
			});
			if (!claimed) throw new Error("本次交接已有投递记录，未重复投递。请检查原回执。");
			let reportDefinitelyNotSubmitted = true;
			try {
				const beforeReportState = await loadState(scope);
				const beforeReport = findCard(beforeReportState.board, taskId);
				assertHandoverReportTargetExecutionEligibility({
					workspaceId: scope.workspaceId,
					card: beforeReport,
					record,
					summary: beforeReportState.sessions[record.targetTaskConversationSessionId],
				});
				if (
					beforeReport.taskMainSessionHandover?.status !== "report_delivery_pending" ||
					beforeReport.taskMainSessionHandover.handoverId !== record.handoverId ||
					resolveMainTaskConversationSessionId(beforeReport) !== record.targetTaskConversationSessionId
				)
					throw new TaskMainSessionHandoverExecutionProhibitedError("交接已经停止或主绑定改变，未提交汇报。");
				if (
					isConversationSessionWaitingBeforeHandover(
						beforeReportState.sessions[record.targetTaskConversationSessionId],
					) &&
					isTaskMainSessionHandoverExistingTarget(record.destination)
				)
					throw new Error("接任会话正在生成或等待未决交互，汇报未提交，稍后自动重验。");
				await setRecord(scope, taskId, record.handoverId, (current) => ({
					...current,
					reportDeliveryStartedAt: Date.now(),
					updatedAt: Date.now(),
				}));
				liveDeliveryKeys.add(reportDeliveryKey(record));
				// 进入发送调用后，异常与缺失回执都可能已有副作用，只允许沿原身份只读补证。
				reportDefinitelyNotSubmitted = false;
				const sent = await deps.sendTaskChatMessage(
					scope,
					{
						taskId: record.targetTaskConversationSessionId,
						text: prompt,
						source: MAIN_SESSION_HANDOVER_REPORT_SOURCE,
						idempotencyKey: reportDeliveryKey(record),
						promptSha256: hash,
					},
					{ decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" } },
				);
				if (sent.terminalDelivery)
					await recordTaskMessageTerminalDeliveryOutcome({
						ledgerPath,
						taskId: record.targetTaskConversationSessionId,
						idempotencyKey: reportDeliveryKey(record),
						status: sent.terminalDelivery.status,
						failureReason: sent.terminalDelivery.reason ?? undefined,
						nowIso: new Date().toISOString(),
					});
				if (!sent.ok) throw new Error(sent.error ?? "交接汇报投递失败。");
			} catch (error) {
				if (reportDefinitelyNotSubmitted)
					await recordTaskMessageTerminalDeliveryOutcome({
						ledgerPath,
						taskId: record.targetTaskConversationSessionId,
						idempotencyKey: reportDeliveryKey(record),
						status: "delivery_failed",
						failureReason: "cancelled_before_delivery",
						failureDetail: error instanceof Error ? error.message : String(error),
						nowIso: new Date().toISOString(),
					});
				throw error;
			} finally {
				liveDeliveryKeys.delete(reportDeliveryKey(record));
			}
		});
	}

	async function sweep() {
		if (sweeping) return await sweeping;
		sweeping = (async () => {
			for (const [workspaceId, scope] of pendingScopes) {
				const state = await loadPersistedWorkspaceStateById(workspaceId);
				const cards = state.board.columns
					.flatMap((column) => column.cards)
					.filter((card) => isHandoverPendingProgress(card.taskMainSessionHandover));
				if (cards.length === 0) {
					pendingScopes.delete(workspaceId);
					continue;
				}
				for (const card of cards) {
					try {
						await progress(scope, card.id);
					} catch (error) {
						const latest = await loadState(scope);
						const current = findCard(latest.board, card.id).taskMainSessionHandover;
						if (
							!current ||
							current.handoverId !== card.taskMainSessionHandover?.handoverId ||
							current.status === "cancelled" ||
							current.status === "completed" ||
							current.automaticRecovery?.classification === "execution_prohibited"
						)
							continue;
						const message = error instanceof Error ? error.message : String(error);
						const fingerprint = await fingerprintTaskMainSessionHandoverRecoveryEvidence({
							record: current,
							source: latest.sessions[current.sourceTaskConversationSessionId],
							target: latest.sessions[current.targetTaskConversationSessionId],
						});
						const recovery =
							(current.automaticRecovery?.evidenceFingerprint === fingerprint
								? current.automaticRecovery
								: undefined) ??
							beginTaskMainSessionHandoverMachineEvidenceAttempt({
								evidenceFingerprint: fingerprint,
								now: (deps.now ?? Date.now)(),
								reason: message,
								stage:
									current.reportDeliveryStartedAt === null
										? "preparing_target_session"
										: "confirming_report_acceptance",
							});
						const prohibited = error instanceof TaskMainSessionHandoverExecutionProhibitedError;
						await setRecord(
							scope,
							card.id,
							card.taskMainSessionHandover?.handoverId ?? "",
							(record) => ({
								...record,
								status: "failed",
								updatedAt: Date.now(),
								errorMessage: message,
								failureHistory: [...(record.failureHistory ?? []), { occurredAt: Date.now(), message }],
								automaticRecovery: {
									...recovery,
									reason: message,
									evidenceFingerprint: fingerprint,
									classification: prohibited ? "execution_prohibited" : "waiting_for_machine_evidence",
									nextAttemptAt: prohibited ? null : recovery.nextAttemptAt,
								},
							}),
							current.reportDeliveryAttempt,
						);
					}
				}
			}
		})().finally(() => {
			sweeping = null;
		});
		await sweeping;
	}

	async function getStatus(
		scope: RuntimeTrpcWorkspaceScope,
		input: { taskId: string },
	): Promise<TaskMainSessionHandoverStatusResponse> {
		const state = await loadState(scope);
		const card = findCard(state.board, input.taskId);
		const record = card.taskMainSessionHandover ?? null;
		const delivery = record
			? findTaskMessageInjectionRecord(
					await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath)),
					record.targetTaskConversationSessionId,
					reportDeliveryKey(record),
				)
			: undefined;
		const target = record ? state.sessions[record.targetTaskConversationSessionId] : undefined;
		const blockReason =
			!record || record.status !== "failed"
				? "当前没有失败的交接。"
				: record.automaticRecovery?.classification === "execution_prohibited"
					? record.automaticRecovery.reason
					: resolveMainTaskConversationSessionId(card) !== record.targetTaskConversationSessionId
						? "主会话绑定已经改变。"
						: isConversationSessionStillGenerating(target)
							? "原接任会话仍在生成，请等它停下后重试。"
							: state.manager.hasPendingProgrammaticTaskChatInputDelivery?.(
										record.targetTaskConversationSessionId,
									)
								? "原交接投递仍在处理中，请等待回执。"
								: !record.materialDirectoryPath
									? "原交接材料缺失，无法重新交接。"
									: null;
		return {
			record,
			recoveryAvailability: {
				canRetryUndeliveredReport:
					record?.status === "failed" &&
					record.automaticRecovery?.classification !== "execution_prohibited" &&
					isReportDefinitelyUndelivered(record, delivery),
				canRecreateCodexSession:
					blockReason === null &&
					(!record || resolveTaskMainSessionHandoverTargetAgentId(record.destination) === "codex"),
				canRecreateAgentSession: blockReason === null,
				terminalDeliveryFailureReason: delivery?.terminal_delivery_failure_reason ?? null,
				blockReason,
			},
		};
	}

	async function recoverWithNewAgentSession(
		scope: RuntimeTrpcWorkspaceScope,
		input: TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
		evidence?: KanbanRequestOriginActorEvidence,
	) {
		// 协调器也是内部调用入口；在拼持久路径之前再次校验 UUID 与显式确认。
		taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema.parse(input);
		const intent = evidence
			? await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
					taskMutationIntentKind: "runtime_recover_task_main_session_handover",
					kanbanRequestOriginActorEvidence: evidence,
				})
			: systemIntent();
		await deps.serializer.runTaskCardActionCommandSeriallyForTaskCards(
			scope.workspaceId,
			[input.taskId],
			async () => {
				const state = await loadState(scope);
				const card = findCard(state.board, input.taskId);
				const record = card.taskMainSessionHandover;
				if (
					record?.handoverId === input.expectedHandoverId &&
					record.recoveryReceipts?.some(
						(receipt) =>
							receipt.requestId === input.requestId &&
							receipt.previousReportDeliveryAttempt === input.expectedReportDeliveryAttempt,
					)
				)
					return;
				if (
					!record ||
					record.handoverId !== input.expectedHandoverId ||
					record.reportDeliveryAttempt !== input.expectedReportDeliveryAttempt ||
					record.status !== "failed"
				) {
					throw new TRPCError({ code: "CONFLICT", message: "交接状态已经变化，请重新检查后确认恢复。" });
				}
				const availability = (await getStatus(scope, input)).recoveryAvailability;
				if (!availability?.canRecreateAgentSession) {
					throw new TRPCError({ code: "CONFLICT", message: availability?.blockReason ?? "当前不能重新交接。" });
				}
				const directory = join(record.materialDirectoryPath as string, "recovery-attempts");
				await readFile(join(record.materialDirectoryPath as string, "HANDOVER.md"), "utf8");
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const receiptFilePath = join(directory, `${input.requestId}.json`);
				const existingReceipt = await readFile(receiptFilePath, "utf8").catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return null;
				});
				const receipt = taskMainSessionHandoverRecoveryReceiptSchema.parse(
					existingReceipt
						? JSON.parse(existingReceipt)
						: {
								taskId: input.taskId,
								requestId: input.requestId,
								replacedTargetTaskConversationSessionId: record.targetTaskConversationSessionId,
								replacementTargetTaskConversationSessionId: `task-conversation-session-${randomUUID()}`,
								previousReportDeliveryAttempt: record.reportDeliveryAttempt,
								receiptFilePath,
								createdAt: Date.now(),
								previousHandoverRecord: record,
							},
				);
				if (
					receipt.taskId !== input.taskId ||
					receipt.requestId !== input.requestId ||
					receipt.receiptFilePath !== receiptFilePath ||
					!isDeepStrictEqual(receipt.previousHandoverRecord, record)
				) {
					throw new TRPCError({ code: "CONFLICT", message: "恢复凭据与当前交接不符，保留现场并停止。" });
				}
				// 先固定失败现场和预留目标。此后崩溃可按同一 requestId 继续，不另选会话。
				if (!existingReceipt) {
					const receiptHandle = await open(receiptFilePath, "wx", 0o600);
					try {
						await receiptHandle.writeFile(JSON.stringify(receipt));
						await receiptHandle.sync();
					} finally {
						await receiptHandle.close();
					}
				}
				const previousTarget = state.sessions[record.targetTaskConversationSessionId];
				let recoveryNativeFork:
					| PreparedCodexMainSessionHandoverNativeFork
					| Awaited<ReturnType<typeof prepareTaskMainSessionHandoverTranscriptNativeFork>>
					| undefined;
				if (isTaskMainSessionHandoverNativeForkRequested(record.destination)) {
					if (!previousTarget || !record.nativeForkPreparationReceiptPath)
						throw new TRPCError({
							code: "CONFLICT",
							message: "等待原接任身份与固定历史凭据，未改成全新上下文。",
						});
					const targetAgentId = resolveTaskMainSessionHandoverTargetAgentId(record.destination);
					if (targetAgentId === "codex") {
						recoveryNativeFork = await (
							deps.prepareRecoveryNativeFork ?? prepareCodexMainSessionHandoverRecoveryNativeFork
						)({
							handoverId: record.handoverId,
							sourceSummary: previousTarget,
							frozenReceiptFilePath: record.nativeForkPreparationReceiptPath,
							receiptFilePath: join(directory, `${input.requestId}-native-fork-preparation.json`),
						});
					} else {
						const identity = previousTarget.agentNativeConversationSessionIdentity;
						if (
							(targetAgentId !== "claude" && targetAgentId !== "omp") ||
							!identity?.transcriptPath ||
							!previousTarget.workspacePath
						)
							throw new TaskMainSessionHandoverExecutionProhibitedError(
								"等待原生固定历史，未降级为空白上下文。",
							);
						recoveryNativeFork = await (
							deps.prepareTranscriptNativeFork ?? prepareTaskMainSessionHandoverTranscriptNativeFork
						)({
							handoverId: record.handoverId,
							sourceAgentId: targetAgentId,
							sourceTaskConversationSessionId: previousTarget.taskId,
							sourceNativeSessionId: identity.nativeSessionId,
							sourceTranscriptPath: identity.transcriptPath,
							workingDirectoryPath: previousTarget.workspacePath,
							frozenReceiptFilePath: record.nativeForkPreparationReceiptPath,
							receiptFilePath: join(directory, `${input.requestId}-native-fork-preparation.json`),
						});
					}
				}
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(scope);
				await mutateWorkspaceState(scope.workspacePath, intent, (latest) => {
					const current = findCard(latest.board, input.taskId);
					if (
						current.taskMainSessionHandover?.handoverId !== record.handoverId ||
						current.taskMainSessionHandover.status !== "failed" ||
						current.taskMainSessionHandover.reportDeliveryAttempt !== record.reportDeliveryAttempt ||
						resolveMainTaskConversationSessionId(current) !== record.targetTaskConversationSessionId ||
						isConversationSessionStillGenerating(
							state.manager.getSummary(record.targetTaskConversationSessionId),
						) ||
						state.manager.hasPendingProgrammaticTaskChatInputDelivery?.(record.targetTaskConversationSessionId)
					) {
						throw new TRPCError({ code: "CONFLICT", message: "交接状态已经变化，未创建新的接任会话。" });
					}
					const targetId = receipt.replacementTargetTaskConversationSessionId;
					// 材料和配置读取期间仍可能收到旧会话的身份 hook；切主只改角色，不能回写早先快照。
					const latestPreviousTarget =
						state.manager.getSummary(record.targetTaskConversationSessionId) ??
						latest.sessions[record.targetTaskConversationSessionId] ??
						previousTarget;
					if (latest.sessions[targetId] || state.manager.getSummary(targetId)) {
						throw new TRPCError({ code: "CONFLICT", message: "预留接任会话 ID 已被占用，未覆盖任何会话。" });
					}
					const replacement = runtimeTaskSessionSummarySchema.parse({
						taskId: targetId,
						agentId: resolveTaskMainSessionHandoverTargetAgentId(record.destination),
						workspacePath: latestPreviousTarget?.workspacePath ?? null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						...(recoveryNativeFork
							? {
									agentNativeConversationSessionIdentity: {
										sourceAgentId: resolveTaskMainSessionHandoverTargetAgentId(record.destination),
										nativeSessionId: recoveryNativeFork.nativeSessionId,
										transcriptPath: recoveryNativeFork.transcriptPath,
										observedAt: Date.now(),
									},
									codexConversationStorageHomeDirectoryPath:
										recoveryNativeFork.codexConversationStorageHomeDirectoryPath,
								}
							: {}),
						turnOwner: null,
						liveness: "none",
						userTurnKind: null,
						taskConversationSessionMetadata: {
							workspaceTaskId: input.taskId,
							taskConversationSessionRole: "main",
							taskConversationSessionRoleAtCreation: "task_collaborator",
							taskConversationSessionContextSource: recoveryNativeFork
								? "forked_from_main_current_turn"
								: "started_from_scratch",
							taskConversationSessionHasHeldMainResponsibility: true,
							taskAutomationSuspendedForMainSessionHandover: true,
							parentTaskConversationSessionId: recoveryNativeFork ? (previousTarget?.taskId ?? null) : null,
							mainSessionOriginTurnNumber: recoveryNativeFork?.sourceCompletedTurnCount ?? null,
							mainSessionOriginUserMessagePreview: null,
							latestUserMessagePreview: "重新读取交接材料并汇报现状",
							taskConversationSessionLaunchSettings: latestPreviousTarget?.taskConversationSessionMetadata
								?.taskConversationSessionLaunchSettings ?? {
								taskAgentPermissionMode:
									current.taskAgentPermissionMode ??
									resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(
										scopedRuntimeConfig.agentAutonomousModeEnabled,
									),
								sessionTransport: "pty_terminal",
							},
						},
					});
					return {
						board: replaceCard(latest.board, input.taskId, (entry) => ({
							...entry,
							agentId: resolveTaskMainSessionHandoverTargetAgentId(record.destination),
							mainTaskConversationSessionId: targetId,
							taskMainSessionHandover: {
								...record,
								targetTaskConversationSessionId: targetId,
								destination: !isTaskMainSessionHandoverExistingTarget(record.destination)
									? record.destination
									: {
											kind: "new_agent_session",
											agentId: resolveTaskMainSessionHandoverTargetAgentId(record.destination),
										},
								existingTargetSessionBinding: undefined,
								status: "report_delivery_pending",
								reportDeliveryStartedAt: null,
								reportDeliveryAttempt: record.reportDeliveryAttempt + 1,
								errorMessage: null,
								automaticRecovery: undefined,
								reportNativeIdentityCaptureBinding: undefined,
								reportAcceptanceProbe: undefined,
								inputAwaitingCorrelatedProcessingHook: undefined,
								reportCorrelatedProcessingAcceptanceEvidence: undefined,
								targetSessionStartupCompletedAt: undefined,
								updatedAt: Date.now(),
								recoveryReceipts: [
									...(record.recoveryReceipts ?? []),
									taskMainSessionHandoverRecoveryReceiptReferenceSchema.parse(receipt),
								],
							},
						})),
						sessions: {
							...latest.sessions,
							...(latestPreviousTarget ? { [latestPreviousTarget.taskId]: latestPreviousTarget } : {}),
							[targetId]: replacement,
						},
						value: null,
					};
				});
				await syncManager(scope);
			},
		);
		pendingScopes.set(scope.workspaceId, scope);
		void sweep().catch((error) => deps.warn(`主会话恢复调度失败：${String(error)}`));
		return await getStatus(scope, input);
	}

	return {
		prepare,
		getStatus,
		recoverWithNewAgentSession,
		recoverWithNewCodexSession: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
			evidence?: KanbanRequestOriginActorEvidence,
		) => {
			const record = findCard((await loadState(scope)).board, input.taskId).taskMainSessionHandover;
			if (record && resolveTaskMainSessionHandoverTargetAgentId(record.destination) !== "codex")
				throw new TRPCError({ code: "BAD_REQUEST", message: "旧 Codex 恢复入口不能改变目标 Agent。" });
			return await recoverWithNewAgentSession(scope, input, evidence);
		},
		pauseForExplicitStop: async (workspaceId: string, conversationSessionId: string) => {
			const entry = (await listWorkspaceIndexEntries()).find((candidate) => candidate.workspaceId === workspaceId);
			if (!entry) return;
			const scope = { workspaceId, workspacePath: entry.repoPath };
			await mutateWorkspaceState(entry.repoPath, systemIntent(), (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((card) => {
							const record = card.taskMainSessionHandover;
							if (
								!record ||
								["cancelled", "completed"].includes(record.status) ||
								![
									card.id,
									record.sourceTaskConversationSessionId,
									record.targetTaskConversationSessionId,
								].includes(conversationSessionId)
							)
								return card;
							return {
								...card,
								taskMainSessionHandover: {
									...record,
									status: "failed" as const,
									errorMessage: "用户已 Stop，自动交接已停止。",
									updatedAt: Date.now(),
									automaticRecovery: {
										classification: "execution_prohibited" as const,
										stage: "preparing_target_session" as const,
										reason: "用户已 Stop；只有后续明确操作才能重新交接。",
										evidenceFingerprint: "explicit-user-stop",
										attemptCount: record.automaticRecovery?.attemptCount ?? 0,
										lastAttemptAt: (deps.now ?? Date.now)(),
										nextAttemptAt: null,
										recheckCondition: "等待用户明确发起新的交接或直接继续当前主会话。",
									},
								},
							};
						}),
					})),
				},
				value: null,
			}));
			await syncManager(scope);
		},
		request: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: TaskMainSessionHandoverRequest,
			evidence?: KanbanRequestOriginActorEvidence,
		) => {
			input = taskMainSessionHandoverRequestSchema.parse(input);
			const intent = evidence
				? await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
						taskMutationIntentKind: "runtime_request_task_main_session_handover",
						kanbanRequestOriginActorEvidence: evidence,
					})
				: systemIntent();
			await deps.serializer.runTaskCardActionCommandSeriallyForTaskCards(
				scope.workspaceId,
				[input.taskId],
				async () => {
					const current = await loadState(scope);
					const card = findCard(current.board, input.taskId);
					if (card.taskMainSessionHandover?.handoverId === input.requestId) return;
					if (resolveMainTaskConversationSessionId(card) !== input.expectedMainTaskConversationSessionId)
						throw new TRPCError({ code: "CONFLICT", message: "主会话已经变化，请重新打开交接预览。" });
					const source = resolveHandoverSourceSummary(card, current.sessions);
					if (
						current.board.columns.some(
							(column) => column.id === "trash" && column.cards.some((entry) => entry.id === card.id),
						)
					)
						throw new TRPCError({ code: "CONFLICT", message: "Done 任务只允许阅读历史，不能发起主会话交接。" });
					if (
						isTaskMainSessionHandoverNativeForkRequested(input.destination) &&
						!getTaskMainSessionHandoverNativeForkAvailability(
							source,
							resolveTaskMainSessionHandoverTargetAgentId(input.destination),
						).available
					)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "完整原生复刻需要同一 Agent 的原生能力和可靠身份。",
						});
					if (isTaskMainSessionHandoverExistingTarget(input.destination))
						validateExistingAgentTarget(
							card,
							current.sessions[input.destination.taskConversationSessionId],
							resolveTaskMainSessionHandoverTargetAgentId(input.destination),
						);
					if (
						card.taskMainSessionHandover &&
						["waiting_for_sessions_to_stop", "report_delivery_pending"].includes(
							card.taskMainSessionHandover.status,
						)
					)
						throw new TRPCError({ code: "CONFLICT", message: "该任务已有进行中的交接。" });
					const targetId = !isTaskMainSessionHandoverExistingTarget(input.destination)
						? `task-conversation-session-${randomUUID()}`
						: input.destination.taskConversationSessionId;
					if (card.taskMainSessionHandover?.materialDirectoryPath)
						await lockedFileSystem.writeJsonFileAtomic(
							join(
								card.taskMainSessionHandover.materialDirectoryPath,
								"superseded-handover-control-record.json",
							),
							card.taskMainSessionHandover,
							{ durable: true },
						);
					const record: TaskMainSessionHandoverRecord = {
						handoverId: input.requestId,
						sourceTaskConversationSessionId: input.expectedMainTaskConversationSessionId,
						targetTaskConversationSessionId: targetId,
						destination: input.destination,
						existingTargetSessionBinding: isTaskMainSessionHandoverExistingTarget(input.destination)
							? captureTaskMainSessionHandoverExistingTargetBinding(
									scope.workspaceId,
									card,
									current.sessions[targetId],
								)
							: undefined,
						status: "waiting_for_sessions_to_stop",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						userContextNotes: input.userContextNotes,
						additionalPlanReferencePaths: input.additionalPlanReferencePaths,
						materialDirectoryPath: null,
						errorMessage: null,
						reportDeliveryStartedAt: null,
						reportDeliveryAttempt: 0,
					};
					await mutateWorkspaceState(scope.workspacePath, intent, (state) => ({
						board: replaceCard(state.board, input.taskId, (entry) => ({
							...entry,
							taskMainSessionHandover: record,
						})),
						sessions: isTaskMainSessionHandoverExistingTarget(input.destination)
							? { ...state.sessions, [targetId]: current.sessions[targetId] }
							: state.sessions,
						value: null,
					}));
					await syncManager(scope);
				},
			);
			pendingScopes.set(scope.workspaceId, scope);
			void sweep().catch((error) => deps.warn(`主会话交接调度失败：${String(error)}`));
			return {
				record:
					findCard((await loadPersistedWorkspaceStateById(scope.workspaceId)).board, input.taskId)
						.taskMainSessionHandover ?? null,
			};
		},
		retry: async (scope: RuntimeTrpcWorkspaceScope, input: { taskId: string }) => {
			await deps.serializer.runTaskCardActionCommandSeriallyForTaskCards(
				scope.workspaceId,
				[input.taskId],
				async () => {
					const state = await loadPersistedWorkspaceStateById(scope.workspaceId);
					const card = findCard(state.board, input.taskId);
					const record = card.taskMainSessionHandover;
					if (!record || record.status !== "failed")
						throw new TRPCError({ code: "CONFLICT", message: "当前没有可重试的失败交接。" });
					if (record.automaticRecovery?.classification === "execution_prohibited")
						throw new TRPCError({ code: "CONFLICT", message: record.automaticRecovery.reason });
					const previous = findTaskMessageInjectionRecord(
						await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath)),
						record.targetTaskConversationSessionId,
						reportDeliveryKey(record),
					);
					if (!isReportDefinitelyUndelivered(record, previous)) {
						throw new TRPCError({
							code: "CONFLICT",
							message: "上次投递可能已经发生，未重复发送。请打开接任会话检查并直接发消息继续。",
						});
					}
					await setRecord(scope, input.taskId, record.handoverId, (current) => ({
						...current,
						status:
							resolveMainTaskConversationSessionId(card) === record.sourceTaskConversationSessionId
								? "waiting_for_sessions_to_stop"
								: "report_delivery_pending",
						errorMessage: null,
						automaticRecovery: undefined,
						reportNativeIdentityCaptureBinding: undefined,
						reportAcceptanceProbe: undefined,
						inputAwaitingCorrelatedProcessingHook: undefined,
						reportCorrelatedProcessingAcceptanceEvidence: undefined,
						reportDeliveryStartedAt: null,
						reportDeliveryAttempt: current.reportDeliveryAttempt + 1,
						updatedAt: Date.now(),
					}));
				},
			);
			pendingScopes.set(scope.workspaceId, scope);
			void sweep().catch((error) => deps.warn(`主会话交接重试失败：${String(error)}`));
			return {
				record:
					findCard((await loadPersistedWorkspaceStateById(scope.workspaceId)).board, input.taskId)
						.taskMainSessionHandover ?? null,
			};
		},
		cancel: async (scope: RuntimeTrpcWorkspaceScope, input: { taskId: string }) => {
			await deps.serializer.runTaskCardActionCommandSeriallyForTaskCards(
				scope.workspaceId,
				[input.taskId],
				async () => {
					const card = findCard((await loadPersistedWorkspaceStateById(scope.workspaceId)).board, input.taskId);
					if (
						card.taskMainSessionHandover &&
						(card.taskMainSessionHandover.status === "waiting_for_sessions_to_stop" ||
							(card.taskMainSessionHandover.status === "failed" &&
								resolveMainTaskConversationSessionId(card) ===
									card.taskMainSessionHandover.sourceTaskConversationSessionId))
					)
						await setRecord(scope, input.taskId, card.taskMainSessionHandover.handoverId, (record) => ({
							...record,
							status: "cancelled",
							updatedAt: Date.now(),
						}));
				},
			);
			return {
				record:
					findCard((await loadPersistedWorkspaceStateById(scope.workspaceId)).board, input.taskId)
						.taskMainSessionHandover ?? null,
			};
		},
		sweep,
		start: () => {
			if (timer) return;
			closed = false;
			timer = setInterval(() => {
				void sweep().catch((error) => deps.warn(`主会话交接调度失败：${String(error)}`));
			}, 1000);
			timer.unref();
			recovering = (async () => {
				for (const entry of await listWorkspaceIndexEntries()) {
					if (closed) return;
					const state = await loadPersistedWorkspaceStateById(entry.workspaceId);
					if (
						state.board.columns.some((column) =>
							column.cards.some((card) => isHandoverPendingProgress(card.taskMainSessionHandover)),
						)
					) {
						pendingScopes.set(entry.workspaceId, {
							workspaceId: entry.workspaceId,
							workspacePath: entry.repoPath,
						});
					}
				}
				if (!closed) await sweep();
			})().catch((error) => deps.warn(`主会话交接恢复失败：${String(error)}`));
		},
		close: async () => {
			closed = true;
			if (timer) clearInterval(timer);
			timer = null;
			await recovering;
			await sweeping;
		},
	};
}

export type TaskMainSessionHandoverCoordinator = ReturnType<typeof createTaskMainSessionHandoverCoordinator>;
