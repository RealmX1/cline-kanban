import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { loadRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeBoardColumnId,
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimePostDeployVerificationPendingConfirmation,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
	RuntimeUpdateVerificationChecklistRequest,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { runtimePostDeployVerificationAcknowledgementSchema } from "../core/api-contract";
import { parsePostDeployVerificationState } from "../core/api-validation";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import { getTaskColumnId } from "../core/task-board-mutations";
import { resolveMainTaskConversationSessionSummaryForTaskId } from "../core/task-main-conversation-session-binding";
import {
	isChecklistOfPostDeployVerificationTaskFullyChecked,
	resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask,
} from "../deployment/post-deploy-verification-closure-application";
import { listPostDeployVerificationDeferredNaturalUsageObservationRecords } from "../deployment/post-deploy-verification-deferred-natural-usage-observation-records";
import {
	isPostDeployVerificationTaskAwaitingVerification,
	isPostDeployVerificationTaskClosed,
} from "../deployment/post-deploy-verification-deployment-group-task-assembly";
import {
	computeRequiredAcknowledgementsForColumn,
	getActiveGroup,
	getPostDeployVerificationStatePath,
	migrateLegacyPostDeployVerificationStateFileIfNeeded,
	setPendingConfirmation,
	updateTaskChecklist,
} from "../deployment/post-deploy-verification-state";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceBoardById, loadWorkspaceContext, loadWorkspaceContextById } from "../state/workspace-state";
import { recordDeploymentWithTaskDeploymentAttribution } from "./deployment-record-with-task-deployment-attribution";
import {
	acknowledgementSetsEqual,
	buildKanbanCliCompletionAuthorizedBeforeMoveIntoDone,
	decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded,
	formatKanbanCliPostDeployVerificationCompletionRetryCommand,
	type KanbanCliPostDeployVerificationCompletionEntryPoint,
	type KanbanCliRetryDecisionForTaskMovedToDoneButVerifiedAtUnrecorded,
} from "./post-deploy-verification-moved-to-done-but-verified-at-unrecorded-cli-retry";
import {
	addPostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
	type PostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
	parsePostDeployVerificationDoneEntryClosureFromCliOptions,
} from "./post-deploy-verification-unchecked-item-closure-reason-cli-options";
import { createRuntimeTrpcClient, printJson } from "./task";

type JsonRecord = Record<string, unknown>;

// pendingConfirmation token 短期过期窗口（plan Grilling #8：一次性 + 短期，如 15min）。
const CONFIRMATION_TOKEN_TTL_MS = 15 * 60 * 1000;
// agent response 预览统一截断上限（plan Grilling #5）。
const AGENT_RESPONSE_PREVIEW_MAX_CHARS = 800;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function runDeploymentCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Deployment command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

/**
 * 只读加载 post-deploy-verification-state（供 verification-state 输出与 complete/confirm 定位组用）。
 * 读前复用状态模块的一次性 legacy 文件名迁移（issue CI4a）：升级后用户首个动作若是这些只读 CLI，
 * 也能立即看到 legacy guided-verification-state.json 数据，而非误报空组 / not found。迁移是幂等原子 rename，
 * 是设计内的读时迁移路径，不属于损坏隔离/重建——后者仍是写路径（post-deploy-verification-state 模块）的职责，
 * 本 helper 除该迁移外不改盘。ENOENT → 空组；解析失败 → 降级为空组并 warn。
 */
async function readPostDeployVerificationStateReadOnly(): Promise<RuntimePostDeployVerificationState> {
	await migrateLegacyPostDeployVerificationStateFileIfNeeded();
	const path = getPostDeployVerificationStatePath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return { deploymentGroups: [] };
		}
		throw error;
	}
	try {
		return parsePostDeployVerificationState(JSON.parse(raw));
	} catch (error) {
		logDeploymentDiagnosticWarning(
			`[deployment] post-deploy-verification-state 读取失败，按空状态处理（隔离/重建由写路径负责）：${toErrorMessage(error)}`,
		);
		return { deploymentGroups: [] };
	}
}

function findGroupInState(
	state: RuntimePostDeployVerificationState,
	deploymentId: string,
): RuntimePostDeployVerificationDeploymentGroup | null {
	return state.deploymentGroups.find((group) => group.deploymentId === deploymentId) ?? null;
}

function findTaskInGroup(
	group: RuntimePostDeployVerificationDeploymentGroup,
	taskId: string,
): RuntimePostDeployVerificationTask | null {
	return group.tasks.find((task) => task.taskId === taskId) ?? null;
}

// 完成核对的放行条件：全勾，或随命令给出的原因覆盖全部未勾项（真正的裁决在 runtime 门禁；这里提前给出可读的拒绝）。
function describeUncheckedChecklistItemsLackingClosureReason(
	task: RuntimePostDeployVerificationTask,
	closure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined,
): string | null {
	if (isChecklistOfPostDeployVerificationTaskFullyChecked(task)) {
		return null;
	}
	const resolution = resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask(task, closure);
	if (resolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems) {
		return null;
	}
	return `Checklist is not fully checked. Give a closure reason for each unchecked item (--closure-reason-for-all-unchecked-items <code> [--closure-reason-text <text>] or --closure-reasons-file <path>): ${resolution.uncheckedChecklistItemsMissingClosureReason
		.map((item) => `${item.id} (${item.label})`)
		.join("; ")}`;
}

function acknowledgementMismatchMessage(required: RuntimePostDeployVerificationAcknowledgement[]): string {
	return required.length === 0
		? "This task requires no acknowledgements; pass --ack with an empty list."
		: `--ack must exactly match the required acknowledgements for the current column: ${required.join(", ")}.`;
}

function parseAcknowledgementList(value: string | undefined): RuntimePostDeployVerificationAcknowledgement[] {
	if (value === undefined) {
		return [];
	}
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return parts.map((part) => {
		const result = runtimePostDeployVerificationAcknowledgementSchema.safeParse(part);
		if (!result.success) {
			throw new Error(`Invalid --ack value "${part}". Expected one of: skip_validation, in_progress_active.`);
		}
		return result.data;
	});
}

function parseRequiredBoolean(value: string, flagName: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

function isExpiredIso(expiresAtIso: string, nowIso: string): boolean {
	const expiresMs = Date.parse(expiresAtIso);
	const nowMs = Date.parse(nowIso);
	return Number.isFinite(expiresMs) && Number.isFinite(nowMs) && expiresMs <= nowMs;
}

function truncateAgentResponsePreview(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= AGENT_RESPONSE_PREVIEW_MAX_CHARS) {
		return trimmed;
	}
	return `${trimmed.slice(0, AGENT_RESPONSE_PREVIEW_MAX_CHARS)}…`;
}

// 确认框 agent response 预览：CLI 路径统一取 latestHookActivity.finalMessage（经 live runtime 读会话摘要）。
// server 不在或无可用文本 → 返回 undefined（propose 路径仍返回 token，不因预览缺失而失败）。
// 限制（刻意）：Cline（agentId==="cline"）的「最后一条 assistant message」需 getTaskChatMessages，只在 server/tRPC
// 路径按 agent 类型分源接通（web 面板确认框，见 runtime-server.ts loadTaskAgentResponsePreview）；CLI offline 走
// workspace.getState 只能拿到 session 摘要、无从取 chat message，故此处对 Cline 也只回 finalMessage（缺省即 undefined），
// 不为此在 CLI 强行拉起 Cline SDK。
async function tryLoadAgentResponsePreview(workspaceId: string, taskId: string): Promise<string | undefined> {
	try {
		const client = createRuntimeTrpcClient(workspaceId);
		const state = await client.workspace.getState.query();
		const session = resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, taskId);
		const finalMessage = session?.latestHookActivity?.finalMessage ?? null;
		if (!finalMessage || finalMessage.trim().length === 0) {
			return undefined;
		}
		return truncateAgentResponsePreview(finalMessage);
	} catch {
		return undefined;
	}
}

interface LiveWorkspaceRuntime {
	client: ReturnType<typeof createRuntimeTrpcClient>;
	repoPath: string;
	board: RuntimeWorkspaceStateResponse["board"];
}

// 凡触发移列的路径都须 live runtime（plan server 依赖边界）：server 不在则明确报错、不静默降级
// （移入 Done 的停会话 / 删 worktree 收尾对失败是吞掉不抛的，故必须在移列前显式探活）。
async function requireLiveWorkspaceRuntime(workspaceId: string): Promise<LiveWorkspaceRuntime> {
	const context = await loadWorkspaceContextById(workspaceId);
	if (!context) {
		throw new Error(`Workspace ${workspaceId} is not registered; cannot move its task to done.`);
	}
	const client = createRuntimeTrpcClient(workspaceId);
	try {
		const state = await client.workspace.getState.query();
		return { client, repoPath: context.repoPath, board: state.board };
	} catch (error) {
		throw new Error(
			`Post-Deploy Verification requires a running Kanban server at ${getKanbanRuntimeOrigin()} to move a task to done: ${toErrorMessage(error)}`,
		);
	}
}

function confirmedAcknowledgementsOfEntryPoint(
	entryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint,
): RuntimePostDeployVerificationAcknowledgement[] {
	// validation 列直接完成（verification-complete）不需要任何确认项。
	return entryPoint.kind === "verification_complete_without_confirmation_token"
		? []
		: entryPoint.presentedAcknowledgements;
}

// 结案由 runtime 写：「PDV 通过」与「带原因结案」事件只能由 runtime 记进关系账本（dd2db Y-EVENT-14），CLI 进程直接写状态文件会漏记。
// 2026-10-11 起移入 Done 时 taskCardAction 门禁已在 runtime 结案，这一步通常是幂等命中；只在门禁结案没写成时真正结案。
async function markTaskVerifiedThroughRuntimeAfterItWasMovedToDone(input: {
	deploymentId: string;
	taskId: string;
	live: LiveWorkspaceRuntime;
	confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: boolean;
	confirmedAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
	uncheckedChecklistItemClosureReasons: NonNullable<
		RuntimePostDeployVerificationDoneEntryClosureRequest["uncheckedChecklistItemClosureReasons"]
	>;
}): Promise<{ ok: boolean; task: RuntimePostDeployVerificationTask | null; error?: string }> {
	return await input.live.client.deployment.markPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDone
		.mutate({
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			// 过渡期两个字段同值双写：旧 runtime（刚构建完、还没重启）把历史字段定为必填，缺了会拒收补记请求。
			forcedCompletionWithoutAllVerificationsPassed:
				input.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
				input.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
			confirmedAcknowledgements: input.confirmedAcknowledgements,
			uncheckedChecklistItemClosureReasons: input.uncheckedChecklistItemClosureReasons,
		})
		.catch((error: unknown) => ({ ok: false, task: null, error: toErrorMessage(error) }));
}

function describeVerifiedAtUnrecordedAfterMoveToDone(input: {
	markError: string | undefined;
	movedToDoneByThisCommand: boolean;
	inFlightCompletionRecordExpiresAtIso: string;
	kanbanCliCommandToRetry: string;
}): JsonRecord {
	return {
		ok: false,
		moved: input.movedToDoneByThisCommand,
		verifiedAt: null,
		error: `${input.markError ?? "Failed to mark task verified after moving it to done."} The task is already in done but its verification was not recorded; re-run the same command before ${input.inFlightCompletionRecordExpiresAtIso} to record it.`,
		retryCommand: input.kanbanCliCommandToRetry,
		retryBeforeIso: input.inFlightCompletionRecordExpiresAtIso,
	};
}

async function moveTaskToDoneAndMarkVerified(input: {
	deploymentId: string;
	task: RuntimePostDeployVerificationTask;
	currentColumnId: RuntimeBoardColumnId;
	live: LiveWorkspaceRuntime;
	nowIso: string;
	entryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint;
	closure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined;
}): Promise<JsonRecord> {
	const taskId = input.task.taskId;
	const forced = input.entryPoint.kind === "verification_confirm_with_force_break_glass";
	const confirmedAcknowledgements = confirmedAcknowledgementsOfEntryPoint(input.entryPoint);
	const resolution = resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask(
		input.task,
		input.closure,
	);
	const uncheckedChecklistItemClosureReasons = resolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems
		? resolution.resolvedReasons
		: [];
	// 移列前先落「在途完成记录」（pendingConfirmation 形状；token 路径沿用用户手里那枚 token、只刷新过期）：
	// 移列成功而 runtime 结案失败时，它让 reconcile 不把任务误标 moved_out_manually，
	// 并作为原样重跑本命令时「只补记结案」的授权证据（判定见 decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded）；
	// 没人重跑时，runtime 下次为该项目加载 PDV 状态（如 Web UI 面板轮询）时凭它自行补写，不受 15 分钟过期限制，
	// 所属部署组已被新部署折叠也一样；CLI 的 verification-state 只读文件，不触发补写。
	const inFlightCompletionRecord: RuntimePostDeployVerificationPendingConfirmation = {
		token:
			input.entryPoint.kind === "verification_confirm_with_confirmation_token"
				? input.entryPoint.presentedConfirmationToken
				: randomUUID(),
		expiresAtIso: new Date(Date.parse(input.nowIso) + CONFIRMATION_TOKEN_TTL_MS).toISOString(),
		requiredAcknowledgements: confirmedAcknowledgements,
		columnIdAtIssuance: input.currentColumnId,
		// 走到这里时授权已核对完毕；runtime 据此在结案失败、又没人重跑命令时自行补写，门禁也据此认出这次移列来自 CLI 完成动词。
		kanbanCliCompletionAuthorizedBeforeMoveIntoDone: buildKanbanCliCompletionAuthorizedBeforeMoveIntoDone({
			authorizedAtIso: input.nowIso,
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: forced,
			uncheckedChecklistItemClosureReasons,
		}),
	};
	const recorded = await setPendingConfirmation(input.deploymentId, taskId, inFlightCompletionRecord, input.nowIso);
	if (!recorded.ok) {
		return { ok: false, error: recorded.error ?? "Failed to record the in-flight completion before moving to done." };
	}
	// 移入 Done 的整条副作用链（门禁结案 → 移列 → 停 agent 会话与详情 shell 终端 → 删 worktree）由 runtime 的
	// taskCardAction 执行，与浏览器 PDV 面板走的是同一个实现。原因随请求带上，门禁据此结案。
	const movedIntoDone =
		await input.live.client.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate({
			taskId,
			postDeployVerificationDoneEntryClosure: {
				uncheckedChecklistItemClosureReasons,
				confirmedAcknowledgements,
			},
		});
	const taskWorktreeDeletionResult = movedIntoDone.taskWorktreeDeletionResult;
	// 移列成功后确认结案（门禁已结案则幂等命中；顺带清 pendingConfirmation token）。
	const marked = await markTaskVerifiedThroughRuntimeAfterItWasMovedToDone({
		deploymentId: input.deploymentId,
		taskId,
		live: input.live,
		confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: forced,
		confirmedAcknowledgements,
		uncheckedChecklistItemClosureReasons,
	});
	if (!marked.ok) {
		return describeVerifiedAtUnrecordedAfterMoveToDone({
			markError: marked.error,
			movedToDoneByThisCommand: true,
			inFlightCompletionRecordExpiresAtIso: inFlightCompletionRecord.expiresAtIso,
			kanbanCliCommandToRetry: formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				deploymentId: input.deploymentId,
				taskId,
				entryPoint: input.entryPoint,
			}),
		});
	}
	return {
		ok: true,
		moved: true,
		forced,
		previousColumn: input.currentColumnId,
		postDeployVerificationClosureOutcome:
			marked.task?.postDeployVerificationClosure?.postDeployVerificationClosureOutcome ??
			movedIntoDone.postDeployVerificationClosureOutcome ??
			null,
		verifiedAt: marked.task?.verifiedAt ?? null,
		worktreeDeleted: taskWorktreeDeletionResult?.taskWorktreeWasRemoved ?? false,
		...(taskWorktreeDeletionResult?.taskWorktreeDeletionErrorMessage
			? { worktreeDeleteError: taskWorktreeDeletionResult.taskWorktreeDeletionErrorMessage }
			: {}),
		task: marked.task,
	};
}

// 「移入 Done 成功、verifiedAt 未记」滞留态的重试：任务已在 trash，只经 runtime 补记 verifiedAt，不再移列。
async function recordVerifiedAtForTaskAlreadyMovedToDone(input: {
	deploymentId: string;
	taskId: string;
	live: LiveWorkspaceRuntime;
	nowIso: string;
	entryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint;
	retryDecision: Extract<KanbanCliRetryDecisionForTaskMovedToDoneButVerifiedAtUnrecorded, { retryAllowed: true }>;
}): Promise<JsonRecord> {
	const marked = await markTaskVerifiedThroughRuntimeAfterItWasMovedToDone({
		deploymentId: input.deploymentId,
		taskId: input.taskId,
		live: input.live,
		confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
			input.retryDecision.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
		confirmedAcknowledgements: input.retryDecision.confirmedAcknowledgements,
		uncheckedChecklistItemClosureReasons: input.retryDecision.uncheckedChecklistItemClosureReasons,
	});
	if (!marked.ok) {
		return describeVerifiedAtUnrecordedAfterMoveToDone({
			markError: marked.error,
			movedToDoneByThisCommand: false,
			inFlightCompletionRecordExpiresAtIso: input.retryDecision.inFlightCompletionRecordExpiresAtIso,
			kanbanCliCommandToRetry: formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				deploymentId: input.deploymentId,
				taskId: input.taskId,
				entryPoint: input.entryPoint,
			}),
		});
	}
	return {
		ok: true,
		moved: false,
		recordedVerificationForTaskAlreadyMovedToDone: true,
		forced: input.retryDecision.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
		previousColumn: input.retryDecision.sourceColumnIdBeforeMoveToDone,
		postDeployVerificationClosureOutcome:
			marked.task?.postDeployVerificationClosure?.postDeployVerificationClosureOutcome ?? null,
		verifiedAt: marked.task?.verifiedAt ?? null,
		task: marked.task,
	};
}

async function proposeVerificationConfirmation(input: {
	deploymentId: string;
	taskId: string;
	workspaceId: string;
	currentColumnId: RuntimeBoardColumnId;
	nowIso: string;
}): Promise<JsonRecord> {
	const requiredAcknowledgements = computeRequiredAcknowledgementsForColumn(input.currentColumnId);
	if (requiredAcknowledgements === null) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task's current column "${input.currentColumnId}" is not a valid completion source (only validation, review, in_progress).`,
		};
	}
	const token = randomUUID();
	const expiresAtIso = new Date(Date.parse(input.nowIso) + CONFIRMATION_TOKEN_TTL_MS).toISOString();
	const pendingConfirmation: RuntimePostDeployVerificationPendingConfirmation = {
		token,
		expiresAtIso,
		requiredAcknowledgements,
		columnIdAtIssuance: input.currentColumnId,
	};
	const stored = await setPendingConfirmation(input.deploymentId, input.taskId, pendingConfirmation, input.nowIso);
	if (!stored.ok) {
		return { ok: false, needsConfirmation: false, error: stored.error };
	}
	const agentResponsePreview = await tryLoadAgentResponsePreview(input.workspaceId, input.taskId);
	return {
		ok: true,
		needsConfirmation: true,
		confirmationToken: token,
		expiresAtIso,
		columnIdAtIssuance: input.currentColumnId,
		requiredAcknowledgements,
		...(agentResponsePreview ? { agentResponsePreview } : {}),
	};
}

// ---- record ----（实现见 deployment-record-with-task-deployment-attribution.ts）

// ---- verification-summary ----

async function verificationSummary(input: { cwd: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await loadWorkspaceContext(
		input.projectPath ? resolveProjectInputPath(input.projectPath, input.cwd) : input.cwd,
		{ autoCreateIfMissing: false },
	);
	const nowIso = new Date().toISOString();
	const activeGroup = await getActiveGroup(workspace.workspaceId, nowIso);
	// 没有活跃组时按空任务列表计数：输出形状与有组时完全一致（部署字段为 null、计数为 0），不另起一套字段名。
	const activeGroupTasks = activeGroup?.tasks ?? [];
	const tasksAwaitingVerification = activeGroupTasks.filter(isPostDeployVerificationTaskAwaitingVerification);
	const countAwaitingInZone = (zone: string): number =>
		tasksAwaitingVerification.filter(
			(task) =>
				(task.taskDeploymentAttribution?.taskDeploymentAttributionZone ??
					"task_commits_not_yet_deployed_or_task_unattributable") === zone,
		).length;
	const closedTasks = activeGroupTasks.filter(isPostDeployVerificationTaskClosed);
	const droppedCount = activeGroupTasks.filter((task) => task.droppedReason !== null).length;
	// 与 `kanban deployment record` 的 tasksShippedInThisDeploymentCount 同口径：建组时已在 Done 的只读条目不算
	// （面板同样把它们单列为「本次部署还包含（已在 Done）」）。
	const tasksShippedInThisDeploymentCount = activeGroupTasks.filter(
		(task) =>
			!task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded &&
			task.taskDeploymentAttribution?.taskDeploymentAttributionZone ===
				"task_commits_included_in_this_deployment_delta",
	).length;
	return {
		ok: true,
		workspaceId: workspace.workspaceId,
		activeDeploymentId: activeGroup?.deploymentId ?? null,
		deployedSourceCommit: activeGroup?.deployedSourceCommit ?? null,
		previousDeployedSourceCommit: activeGroup?.previousDeployedSourceCommit ?? null,
		deployedAtIso: activeGroup?.deployedAtIso ?? null,
		pendingCount: tasksAwaitingVerification.length,
		pendingTasksShippedInThisDeploymentCount: countAwaitingInZone("task_commits_included_in_this_deployment_delta"),
		pendingTasksDeployedOnlyInEarlierDeploymentsCount: countAwaitingInZone(
			"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
		),
		pendingTasksNotYetDeployedOrUnattributableCount: countAwaitingInZone(
			"task_commits_not_yet_deployed_or_task_unattributable",
		),
		// 结案（全勾通过 + 带原因结案）计数；passed 单列，带原因的不算「通过」。
		doneCount: closedTasks.length,
		passedCount: closedTasks.filter((task) => task.verifiedAt !== null).length,
		closedWithUncheckedItemsReasonedCount: closedTasks.filter((task) => task.verifiedAt === null).length,
		droppedCount,
		tasksShippedInThisDeploymentCount,
		noTasksShippedInThisDeployment: tasksShippedInThisDeploymentCount === 0,
	};
}

// ---- verification-state ----

function latestActiveDeploymentId(groups: RuntimePostDeployVerificationDeploymentGroup[]): string | null {
	const active = groups
		.filter((group) => group.foldedAtIso === null)
		.sort((left, right) => Date.parse(right.deployedAtIso) - Date.parse(left.deployedAtIso));
	return active[0]?.deploymentId ?? null;
}

async function verificationState(input: {
	cwd: string;
	projectPath?: string;
	activeOnly?: boolean;
}): Promise<JsonRecord> {
	const state = await readPostDeployVerificationStateReadOnly();
	let groups = state.deploymentGroups;
	if (input.projectPath !== undefined) {
		const workspace = await loadWorkspaceContext(resolveProjectInputPath(input.projectPath, input.cwd), {
			autoCreateIfMissing: false,
		});
		groups = groups.filter((group) => group.workspaceId === workspace.workspaceId);
	}
	// 无 --project-path 时 groups 是跨全部 workspace 的全集，单一标量 activeDeploymentId 在该模式下无良定义
	// （latestActiveDeploymentId 只会挑「谁最后部署」，可能属于调用方没在看的另一个 workspace）；仅在限定了
	// project 时才返回标量。deploymentGroups 各自带 workspaceId，全 dump 模式下由调用方自行按 workspace 消歧。
	const activeDeploymentId = input.projectPath !== undefined ? latestActiveDeploymentId(groups) : null;
	if (input.activeOnly) {
		groups = groups.filter((group) => group.foldedAtIso === null);
	}
	return { ok: true, activeDeploymentId, deploymentGroups: groups };
}

// ---- verification-update ----

function buildChecklistUpdateRequest(input: {
	deploymentId: string;
	taskId: string;
	itemId?: string;
	checked?: boolean;
	addCustomItem?: string;
	removeCustomItem?: string;
}): RuntimeUpdateVerificationChecklistRequest {
	const hasToggle = input.itemId !== undefined || input.checked !== undefined;
	const hasAdd = input.addCustomItem !== undefined;
	const hasRemove = input.removeCustomItem !== undefined;
	const selectedOperationCount = [hasToggle, hasAdd, hasRemove].filter(Boolean).length;
	if (selectedOperationCount !== 1) {
		throw new Error(
			"verification-update requires exactly one operation: (--item-id + --checked) | --add-custom-item | --remove-custom-item.",
		);
	}
	if (hasToggle) {
		if (input.itemId === undefined || input.checked === undefined) {
			throw new Error("Toggling a checklist item requires both --item-id and --checked.");
		}
		return {
			operation: "toggle_checklist_item",
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			itemId: input.itemId,
			checked: input.checked,
		};
	}
	if (hasAdd) {
		return {
			operation: "add_custom_checklist_item",
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			label: input.addCustomItem as string,
		};
	}
	return {
		operation: "remove_custom_checklist_item",
		deploymentId: input.deploymentId,
		taskId: input.taskId,
		itemId: input.removeCustomItem as string,
	};
}

async function verificationUpdate(input: {
	deploymentId: string;
	taskId: string;
	itemId?: string;
	checked?: boolean;
	addCustomItem?: string;
	removeCustomItem?: string;
}): Promise<JsonRecord> {
	const request = buildChecklistUpdateRequest(input);
	const result = await updateTaskChecklist(request, new Date().toISOString());
	return { ok: result.ok, task: result.task, ...(result.error ? { error: result.error } : {}) };
}

// ---- verification-run ----

// 运行一个自动脚本型验证项（plan Stage 3）。经 tRPC 委托 server（单一执行路径，running 并发状态集中在 server），
// 需 live runtime：spawn 脚本 + 观察运行实例都发生在 server 进程内。workspaceId 由 deploymentId 定位组得到。
async function verificationRun(input: { deploymentId: string; taskId: string; itemId: string }): Promise<JsonRecord> {
	const state = await readPostDeployVerificationStateReadOnly();
	const group = findGroupInState(state, input.deploymentId);
	if (!group) {
		return { ok: false, error: `Deployment group not found: ${input.deploymentId}` };
	}
	const client = createRuntimeTrpcClient(group.workspaceId);
	try {
		const result = await client.deployment.runPostDeployVerificationItem.mutate({
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			itemId: input.itemId,
		});
		return { ok: result.ok, task: result.task, ...(result.error ? { error: result.error } : {}) };
	} catch (error) {
		return {
			ok: false,
			error: `Running an automated verification requires a live Kanban server at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		};
	}
}

// ---- verification-complete ----

async function verificationComplete(input: {
	deploymentId: string;
	taskId: string;
	closure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined;
}): Promise<JsonRecord> {
	const nowIso = new Date().toISOString();
	const state = await readPostDeployVerificationStateReadOnly();
	const group = findGroupInState(state, input.deploymentId);
	if (!group) {
		return { ok: false, needsConfirmation: false, error: `Deployment group not found: ${input.deploymentId}` };
	}
	const task = findTaskInGroup(group, input.taskId);
	if (!task) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task ${input.taskId} not found in deployment group ${input.deploymentId}.`,
		};
	}
	if (task.droppedReason !== null) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task was dropped from verification (${task.droppedReason}).`,
		};
	}
	if (isPostDeployVerificationTaskClosed(task)) {
		return { ok: true, needsConfirmation: false, alreadyClosed: true, task };
	}

	// 离线定当前列，使 review/in_progress 的 propose 路径无需 server。
	const board = await loadWorkspaceBoardById(group.workspaceId);
	const offlineColumnId = getTaskColumnId(board, input.taskId);
	if (!offlineColumnId) {
		return { ok: false, needsConfirmation: false, error: "Task is no longer on the board (deleted or moved out)." };
	}
	if (offlineColumnId === "trash") {
		// 「移入 Done 成功、runtime 补记 verifiedAt 失败」后原样重跑 verification-complete：在途记录授权时只补记 verifiedAt。
		// 这条路径先于命令行原因校验：原因取自在途记录（由重试判定校验覆盖），重跑命令本就不带 --closure-reason-*。
		const entryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint = {
			kind: "verification_complete_without_confirmation_token",
		};
		const retryDecision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({ task, entryPoint, nowIso });
		if (!retryDecision.retryAllowed) {
			return {
				ok: false,
				needsConfirmation: false,
				error: retryDecision.error,
				...(retryDecision.requiredAcknowledgements
					? { requiredAcknowledgements: retryDecision.requiredAcknowledgements }
					: {}),
			};
		}
		const live = await requireLiveWorkspaceRuntime(group.workspaceId);
		if (getTaskColumnId(live.board, input.taskId) !== "trash") {
			return {
				ok: false,
				needsConfirmation: false,
				error: "Task left done while its verification was being recorded; re-run verification-complete.",
			};
		}
		return await recordVerifiedAtForTaskAlreadyMovedToDone({
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			live,
			nowIso,
			entryPoint,
			retryDecision,
		});
	}
	const uncheckedItemsLackingClosureReason = describeUncheckedChecklistItemsLackingClosureReason(task, input.closure);
	if (uncheckedItemsLackingClosureReason !== null) {
		return { ok: false, needsConfirmation: false, error: uncheckedItemsLackingClosureReason };
	}
	// 列门控与 Web 对齐（issue C）：仅 validation/review/in_progress 是合法完成来源；backlog 等非法列直接拒绝，
	// 否则后续 propose → verification-confirm/--force 可把手动移回 backlog、尚未 reconcile-dropped 的任务直接推入 Done。
	if (computeRequiredAcknowledgementsForColumn(offlineColumnId) === null) {
		return {
			ok: false,
			needsConfirmation: false,
			error: `Task's current column "${offlineColumnId}" is not a valid completion source (only validation, review, in_progress).`,
		};
	}

	if (offlineColumnId === "validation") {
		// validation 列直接完成（无确认）；移列需 live runtime。
		const live = await requireLiveWorkspaceRuntime(group.workspaceId);
		const liveColumnId = getTaskColumnId(live.board, input.taskId) ?? offlineColumnId;
		if (liveColumnId === "validation") {
			return await moveTaskToDoneAndMarkVerified({
				deploymentId: input.deploymentId,
				task,
				currentColumnId: liveColumnId,
				live,
				nowIso,
				entryPoint: { kind: "verification_complete_without_confirmation_token" },
				closure: input.closure,
			});
		}
		// 竞态：live 已流转出 validation → 回落 propose（按 live 列重算）。
		return await proposeVerificationConfirmation({
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			workspaceId: group.workspaceId,
			currentColumnId: liveColumnId,
			nowIso,
		});
	}

	return await proposeVerificationConfirmation({
		deploymentId: input.deploymentId,
		taskId: input.taskId,
		workspaceId: group.workspaceId,
		currentColumnId: offlineColumnId,
		nowIso,
	});
}

// ---- verification-confirm ----

async function isForceCompleteEnabled(repoPath: string): Promise<boolean> {
	const config = await loadRuntimeConfig(repoPath);
	return config.postDeployVerificationForceCompleteEnabled === true;
}

async function verificationConfirm(input: {
	deploymentId: string;
	taskId: string;
	token?: string;
	acks: RuntimePostDeployVerificationAcknowledgement[];
	force: boolean;
	closure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined;
}): Promise<JsonRecord> {
	const nowIso = new Date().toISOString();
	if (input.force && input.token !== undefined) {
		return { ok: false, error: "--force and --token are mutually exclusive." };
	}
	if (!input.force && input.token === undefined) {
		return {
			ok: false,
			error: "verification-confirm requires --token (or --force with the runtime toggle enabled).",
		};
	}

	const state = await readPostDeployVerificationStateReadOnly();
	const group = findGroupInState(state, input.deploymentId);
	if (!group) {
		return { ok: false, error: `Deployment group not found: ${input.deploymentId}` };
	}
	const task = findTaskInGroup(group, input.taskId);
	if (!task) {
		return { ok: false, error: `Task ${input.taskId} not found in deployment group ${input.deploymentId}.` };
	}
	if (task.droppedReason !== null) {
		return { ok: false, error: `Task was dropped from verification (${task.droppedReason}); cannot confirm.` };
	}
	if (isPostDeployVerificationTaskClosed(task)) {
		return { ok: true, alreadyClosed: true, task };
	}

	// confirm 会移列 → 需 live runtime；同时用 live 板确定当前列（全量重校验，不信任发放时快照）。
	const live = await requireLiveWorkspaceRuntime(group.workspaceId);
	const currentColumnId = getTaskColumnId(live.board, input.taskId);
	if (!currentColumnId) {
		return { ok: false, error: "Task is no longer on the board (deleted); cannot confirm." };
	}
	if (currentColumnId === "trash") {
		// 「移入 Done 成功、runtime 补记 verifiedAt 失败」后原样重跑本命令：在途记录 + 同 token / --force 与同 --ack 授权时只补记 verifiedAt。
		// 这条路径先于命令行原因校验：原因取自在途记录（由重试判定校验覆盖），重跑命令本就不带 --closure-reason-*。
		const entryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint = input.force
			? { kind: "verification_confirm_with_force_break_glass", presentedAcknowledgements: input.acks }
			: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: input.token ?? "",
					presentedAcknowledgements: input.acks,
				};
		const retryDecision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({ task, entryPoint, nowIso });
		if (!retryDecision.retryAllowed) {
			return {
				ok: false,
				error: retryDecision.error,
				...(retryDecision.requiredAcknowledgements
					? { requiredAcknowledgements: retryDecision.requiredAcknowledgements }
					: {}),
			};
		}
		if (input.force && !(await isForceCompleteEnabled(live.repoPath))) {
			return {
				ok: false,
				error: "--force requires postDeployVerificationForceCompleteEnabled to be enabled in the runtime config.",
			};
		}
		return await recordVerifiedAtForTaskAlreadyMovedToDone({
			deploymentId: input.deploymentId,
			taskId: input.taskId,
			live,
			nowIso,
			entryPoint,
			retryDecision,
		});
	}
	const uncheckedItemsLackingClosureReason = describeUncheckedChecklistItemsLackingClosureReason(task, input.closure);
	if (uncheckedItemsLackingClosureReason !== null) {
		return { ok: false, error: uncheckedItemsLackingClosureReason };
	}
	// 列门控与 Web 对齐（issue C）：--force break-glass 与 token 两条路径都在此之后，故统一在此拒绝非法列（backlog 等），
	// 避免把手动移回 backlog、尚未 reconcile-dropped 的任务经 --force 或重发 token 直接推入 Done。
	const requiredAcknowledgements = computeRequiredAcknowledgementsForColumn(currentColumnId);
	if (requiredAcknowledgements === null) {
		return {
			ok: false,
			error: `Task's current column "${currentColumnId}" is not a valid completion source (only validation, review, in_progress); cannot confirm.`,
		};
	}

	if (input.force) {
		if (!(await isForceCompleteEnabled(live.repoPath))) {
			return {
				ok: false,
				error: "--force requires postDeployVerificationForceCompleteEnabled to be enabled in the runtime config.",
			};
		}
		if (!acknowledgementSetsEqual(input.acks, requiredAcknowledgements)) {
			return {
				ok: false,
				error: acknowledgementMismatchMessage(requiredAcknowledgements),
				requiredAcknowledgements,
			};
		}
		return await moveTaskToDoneAndMarkVerified({
			deploymentId: input.deploymentId,
			task,
			currentColumnId,
			live,
			nowIso,
			entryPoint: { kind: "verification_confirm_with_force_break_glass", presentedAcknowledgements: input.acks },
			closure: input.closure,
		});
	}

	// token 两步路径：手动校验 token（不提前消费），移列成功后 markTaskVerified 才清 token
	// （移列失败则 token 保留供重试，避免「标记完成但实际未移列」）。
	const pending = task.pendingConfirmation;
	if (!pending) {
		return { ok: false, error: "No pending confirmation; run verification-complete first." };
	}
	if (pending.token !== input.token) {
		return { ok: false, error: "Confirmation token mismatch." };
	}
	if (isExpiredIso(pending.expiresAtIso, nowIso)) {
		return { ok: false, error: "Confirmation token expired; re-run verification-complete." };
	}
	if (pending.columnIdAtIssuance !== currentColumnId) {
		// 列已变（如自动流转）→ token 失效，按当前列重发新 token。
		const reissuedToken = randomUUID();
		const expiresAtIso = new Date(Date.parse(nowIso) + CONFIRMATION_TOKEN_TTL_MS).toISOString();
		await setPendingConfirmation(
			input.deploymentId,
			input.taskId,
			{ token: reissuedToken, expiresAtIso, requiredAcknowledgements, columnIdAtIssuance: currentColumnId },
			nowIso,
		);
		return {
			ok: false,
			error: "Task column changed since token issuance; re-confirm with the reissued token.",
			reissuedConfirmationToken: reissuedToken,
			requiredAcknowledgements,
		};
	}
	if (!acknowledgementSetsEqual(input.acks, requiredAcknowledgements)) {
		return { ok: false, error: acknowledgementMismatchMessage(requiredAcknowledgements), requiredAcknowledgements };
	}

	return await moveTaskToDoneAndMarkVerified({
		deploymentId: input.deploymentId,
		task,
		currentColumnId,
		live,
		nowIso,
		entryPoint: {
			kind: "verification_confirm_with_confirmation_token",
			presentedConfirmationToken: pending.token,
			presentedAcknowledgements: input.acks,
		},
		closure: input.closure,
	});
}

export function registerDeploymentCommand(program: Command): void {
	const deployment = program
		.command("deployment")
		.description("Record deployments and drive Post-Deploy Verification from the CLI.");

	deployment
		.command("record")
		.description("Record a deployment: write the deploy marker and create a new Post-Deploy Verification group.")
		.option(
			"--source-checkout-path <path>",
			"Kanban source checkout where the deploy delta is computed. Defaults to cwd.",
		)
		.option("--new-commit <ref>", "The newly deployed source commit/ref. Defaults to HEAD.")
		.option(
			"--project-path <path>",
			"Registered project whose tasks to correlate. Defaults to matching the source checkout path.",
		)
		.action(async (options: { sourceCheckoutPath?: string; newCommit?: string; projectPath?: string }) => {
			await runDeploymentCommand(
				async () =>
					await recordDeploymentWithTaskDeploymentAttribution({
						cwd: process.cwd(),
						sourceCheckoutPath: options.sourceCheckoutPath,
						newCommit: options.newCommit,
						projectPath: options.projectPath,
						readPostDeployVerificationStateReadOnly,
					}),
			);
		});

	deployment
		.command("verification-summary")
		.description("Summarize the active Post-Deploy Verification group for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { projectPath?: string }) => {
			await runDeploymentCommand(
				async () => await verificationSummary({ cwd: process.cwd(), projectPath: options.projectPath }),
			);
		});

	deployment
		.command("verification-state")
		.description("Print the full Post-Deploy Verification state (all deployment groups, including folded history).")
		.option("--project-path <path>", "Filter to a single workspace. Defaults to all workspaces.")
		.option("--active-only", "Only include active (not-yet-folded) deployment groups.")
		.action(async (options: { projectPath?: string; activeOnly?: boolean }) => {
			await runDeploymentCommand(
				async () =>
					await verificationState({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						activeOnly: options.activeOnly === true,
					}),
			);
		});

	deployment
		.command("verification-update")
		.description("Toggle a checklist item, or add/remove a custom checklist item, for a verification task.")
		.requiredOption("--deployment-id <id>", "Deployment group id.")
		.requiredOption("--task-id <id>", "Task id within the deployment group.")
		.option("--item-id <id>", "Checklist item id to toggle (requires --checked).")
		.option("--checked <value>", "New checked state for --item-id (true|false).")
		.option("--add-custom-item <label>", "Add a new custom checklist item with this label.")
		.option("--remove-custom-item <id>", "Remove a custom checklist item by id.")
		.action(
			async (options: {
				deploymentId: string;
				taskId: string;
				itemId?: string;
				checked?: string;
				addCustomItem?: string;
				removeCustomItem?: string;
			}) => {
				await runDeploymentCommand(
					async () =>
						await verificationUpdate({
							deploymentId: options.deploymentId,
							taskId: options.taskId,
							itemId: options.itemId,
							checked:
								options.checked === undefined ? undefined : parseRequiredBoolean(options.checked, "--checked"),
							addCustomItem: options.addCustomItem,
							removeCustomItem: options.removeCustomItem,
						}),
				);
			},
		);

	deployment
		.command("verification-run")
		.description(
			"Run an automated-script verification item (delegates to the live server; passes auto-check the item).",
		)
		.requiredOption("--deployment-id <id>", "Deployment group id.")
		.requiredOption("--task-id <id>", "Task id within the deployment group.")
		.requiredOption("--item-id <id>", "Checklist item id (must be an automated_script verification).")
		.action(async (options: { deploymentId: string; taskId: string; itemId: string }) => {
			await runDeploymentCommand(
				async () =>
					await verificationRun({
						deploymentId: options.deploymentId,
						taskId: options.taskId,
						itemId: options.itemId,
					}),
			);
		});

	addPostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions(
		deployment
			.command("verification-complete")
			.description(
				"Propose moving a verification task to done (validation column completes directly). Unchecked items need a closure reason each.",
			)
			.requiredOption("--deployment-id <id>", "Deployment group id.")
			.requiredOption("--task-id <id>", "Task id within the deployment group."),
	).action(
		async (
			options: {
				deploymentId: string;
				taskId: string;
			} & PostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
		) => {
			await runDeploymentCommand(
				async () =>
					await verificationComplete({
						deploymentId: options.deploymentId,
						taskId: options.taskId,
						closure: await parsePostDeployVerificationDoneEntryClosureFromCliOptions(options, process.cwd()),
					}),
			);
		},
	);

	addPostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions(
		deployment
			.command("verification-confirm")
			.description("Confirm moving a verification task to done using a confirmation token (or --force break-glass).")
			.requiredOption("--deployment-id <id>", "Deployment group id.")
			.requiredOption("--task-id <id>", "Task id within the deployment group.")
			.option("--token <token>", "Confirmation token from verification-complete. Mutually exclusive with --force.")
			.option(
				"--ack <list>",
				"Comma-separated acknowledgements (skip_validation,in_progress_active) required by the current column.",
			)
			.option(
				"--force",
				"Break-glass: skip the token handshake (never the checklist). Requires postDeployVerificationForceCompleteEnabled.",
			),
	).action(
		async (
			options: {
				deploymentId: string;
				taskId: string;
				token?: string;
				ack?: string;
				force?: boolean;
			} & PostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
		) => {
			await runDeploymentCommand(
				async () =>
					await verificationConfirm({
						deploymentId: options.deploymentId,
						taskId: options.taskId,
						token: options.token,
						acks: parseAcknowledgementList(options.ack),
						force: options.force === true,
						closure: await parsePostDeployVerificationDoneEntryClosureFromCliOptions(options, process.cwd()),
					}),
			);
		},
	);

	deployment
		.command("deferred-observations")
		.description(
			"List Post-Deploy Verification items closed as 'deferred to natural-usage observation' (read-only; input for the future natural-usage observation pipeline).",
		)
		.option("--project-path <path>", "Filter to a single workspace. Defaults to all workspaces.")
		.action(async (options: { projectPath?: string }) => {
			await runDeploymentCommand(async () => {
				const workspaceId =
					options.projectPath !== undefined
						? (
								await loadWorkspaceContext(resolveProjectInputPath(options.projectPath, process.cwd()), {
									autoCreateIfMissing: false,
								})
							).workspaceId
						: undefined;
				return {
					ok: true,
					deferredNaturalUsageObservationRecords:
						await listPostDeployVerificationDeferredNaturalUsageObservationRecords(
							{ ...(workspaceId !== undefined ? { workspaceId } : {}) },
							new Date().toISOString(),
						),
				};
			});
		});
}
