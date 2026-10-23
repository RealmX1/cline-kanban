import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TRPCError } from "@trpc/server";
import { collectClaudeMainSessionHandoverMaterial } from "../agent-session-history/claude-main-session-handover-material";
import type { RuntimeConfigState } from "../config/runtime-config";
import { resolveRuntimeAgentSessionTransportFromSummary } from "../core/agent-catalog";
import {
	type RuntimeBoardCard,
	type RuntimeBoardData,
	type RuntimeCommandRunResponse,
	type RuntimeTaskSessionSummary,
	runtimeTaskSessionSummarySchema,
} from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { resolveTaskAgentPermissionModeFromLegacyAutonomousFlag } from "../core/task-agent-permission-mode";
import {
	doesConversationSessionBelongToTask,
	projectTaskConversationSessionsForMainSessionBinding,
	resolveMainTaskConversationSessionId,
} from "../core/task-main-conversation-session-binding";
import type {
	TaskMainSessionHandoverMaterial,
	TaskMainSessionHandoverPrepareResponse,
	TaskMainSessionHandoverRecord,
	TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
	TaskMainSessionHandoverRequest,
	TaskMainSessionHandoverStatusResponse,
} from "../core/task-main-session-handover-contract";
import {
	taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema,
	taskMainSessionHandoverRecoveryReceiptReferenceSchema,
	taskMainSessionHandoverRecoveryReceiptSchema,
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
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceStateById,
	mutateWorkspaceState,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import type { TaskCardActionPerTaskCommandSerializer } from "../trpc/task-card-action-per-task-command-serializer";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

export const MAIN_SESSION_HANDOVER_REPORT_SOURCE = "task_main_session_handover";
export const MAIN_SESSION_HANDOVER_REPORT_MARKER = "KANBAN_MAIN_SESSION_HANDOVER_REPORT:";

interface HandoverCoordinatorDependencies {
	getTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	loadScopedRuntimeConfig: (
		scope: RuntimeTrpcWorkspaceScope,
	) => Promise<Pick<RuntimeConfigState, "agentAutonomousModeEnabled">>;
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

const systemIntent = () =>
	buildTaskMutationIntentForKanbanRuntimeSystemComponent(
		"runtime_task_main_session_handover",
		"task_main_session_handover_coordinator",
	);
const reportDeliveryKey = (record: TaskMainSessionHandoverRecord) =>
	`${record.handoverId}:report:${record.reportDeliveryAttempt}`;

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

export function renderTaskMainSessionHandoverReportPrompt(record: TaskMainSessionHandoverRecord): string {
	return `/plan ${MAIN_SESSION_HANDOVER_REPORT_MARKER}${record.handoverId}
你现在接任本任务的 Main Session。此前作为协作会话的职责限制已被本次明确交接取代。
先读取持久交接材料：${join(record.materialDirectoryPath ?? "", "HANDOVER.md")}。
读取其中的任务需求、用户约束、计划引用、前任最后一条消息；需要补充证据时按需读取 transcript 与当前工作区。
此次只做只读梳理，不编辑文件、不提交、不部署、不自动运行 RVF，也不自行继续实施。
用简体中文汇报三部分：计划总览、已经实现、有待进行。区分有证据的事实、未完成事项与未知项，不把前任声称完成当作已验证。
汇报之后等待用户下一条消息。交接不是重新授权旧计划的实施，也不表示用户批准了任何未确认的计划。`;
}

function resolveClaudeSourceSummary(
	card: RuntimeBoardCard,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	const sessionId = resolveMainTaskConversationSessionId(card);
	const existing = sessions[sessionId];
	if (existing?.agentId === "claude") return existing;
	const declaredAgentId = existing?.agentId ?? card.mostRecentlyLaunchedAgentSessionAgentId ?? card.agentId;
	if (declaredAgentId !== "claude")
		throw new TRPCError({ code: "BAD_REQUEST", message: "当前仅支持可确认的 Claude 主会话交接给 Codex。" });
	if (existing) return { ...existing, agentId: "claude" };
	// 旧任务可能只剩启动设置；保留确切 session ID，缺失身份与历史由材料层明确列出。
	return runtimeTaskSessionSummarySchema.parse({
		taskId: sessionId,
		workspacePath: null,
		agentId: "claude",
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

function validateExistingCodexTarget(card: RuntimeBoardCard, target: RuntimeTaskSessionSummary | undefined): void {
	if (
		!target ||
		target.agentId !== "codex" ||
		!doesConversationSessionBelongToTask(target, card.id) ||
		target.taskConversationSessionMetadata?.taskConversationSessionRole !== "task_collaborator" ||
		target.agentNativeConversationSessionIdentity?.sourceAgentId !== "codex"
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "所选 Codex 协作会话已不存在、归属不符或缺少可靠的原生身份。",
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
	for (const [index, plan] of material.planReferences.entries()) {
		const path = join(directory, `source-plan-reference-${index + 1}.md`);
		await copyFile(plan.absolutePath, path);
		snapshots.push(`- 计划快照：${path}（原位置：${plan.absolutePath}；批准状态：${plan.approvalStatus}）`);
	}
	for (const [index, transcriptPath] of material.transcriptReferences.entries()) {
		const path = join(directory, `source-agent-transcript-${index + 1}.jsonl`);
		await copyFile(transcriptPath, path);
		snapshots.push(`- transcript 快照：${path}（原位置：${transcriptPath}）`);
	}
	await writeFile(join(directory, "handover-material.json"), `${JSON.stringify(material, null, 2)}\n`, "utf8");
	await writeFile(
		join(directory, "HANDOVER.md"),
		[
			`# 主会话交接：${material.taskTitle}`,
			"",
			`交接 ID：${record.handoverId}`,
			`来源：${record.sourceTaskConversationSessionId}（Claude ${material.sourceNativeConversationSessionId ?? "原生身份未知"}）`,
			`接收方：${record.targetTaskConversationSessionId}（Codex）`,
			"",
			"## 原任务需求与用户约束",
			material.taskPrompt,
			"",
			"## 当前阶段目标",
			material.currentWorkPhaseGoal ?? "未知",
			"",
			"## 计划与 transcript 引用",
			...snapshots,
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
			"",
		].join("\n"),
		"utf8",
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

	async function loadState(scope: RuntimeTrpcWorkspaceScope) {
		const state = await loadPersistedWorkspaceStateById(scope.workspaceId);
		const manager = await deps.getTerminalManager(scope);
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
			return {
				board: replaceCard(state.board, taskId, (current) => ({
					...current,
					taskMainSessionHandover: change(card.taskMainSessionHandover as TaskMainSessionHandoverRecord),
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
		return await collectClaudeMainSessionHandoverMaterial({
			card,
			sourceSummary: source,
			workspacePath: cwd,
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
		const source = resolveClaudeSourceSummary(card, state.sessions);
		return {
			material: await collect(scope, card, source),
			mainTaskConversationSessionId: sourceId,
			codexPeerTaskConversationSessionIds: Object.values(state.sessions)
				.filter(
					(summary) =>
						summary.agentId === "codex" &&
						doesConversationSessionBelongToTask(summary, card.id) &&
						summary.taskConversationSessionMetadata?.taskConversationSessionRole === "task_collaborator" &&
						summary.agentNativeConversationSessionIdentity?.sourceAgentId === "codex",
				)
				.map((summary) => summary.taskId),
			busyTaskConversationSessionIds: Object.values(state.sessions)
				.filter(
					(summary) =>
						doesConversationSessionBelongToTask(summary, card.id) &&
						isConversationSessionStillGenerating(summary),
				)
				.map((summary) => summary.taskId),
		};
	}

	async function progress(scope: RuntimeTrpcWorkspaceScope, taskId: string) {
		await deps.serializer.runTaskCardActionCommandSeriallyForTaskCards(scope.workspaceId, [taskId], async () => {
			const state = await loadState(scope);
			const card = findCard(state.board, taskId);
			let record = card.taskMainSessionHandover;
			if (!record || !["waiting_for_sessions_to_stop", "report_delivery_pending"].includes(record.status)) return;
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
				const source = resolveClaudeSourceSummary(card, state.sessions);
				const target = state.sessions[record.targetTaskConversationSessionId];
				if (record.destination.kind === "existing_codex_session") validateExistingCodexTarget(card, target);
				if (isConversationSessionStillGenerating(source) || isConversationSessionStillGenerating(target)) return;
				const material = await collect(scope, card, source, record);
				const directory = await persistHandoverMaterial(scope.workspaceId, taskId, record, material);
				// 材料读取期间可能又开始一轮；在改绑定前重新核对，保持原主责任直到真正空闲。
				if (
					isConversationSessionStillGenerating(state.manager.getSummary(source.taskId)) ||
					isConversationSessionStillGenerating(state.manager.getSummary(record.targetTaskConversationSessionId))
				)
					return;
				const selectedRecord = record;
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(scope);
				const switched = await mutateWorkspaceState(scope.workspacePath, systemIntent(), (latest) => {
					const current = findCard(latest.board, taskId);
					if (
						isConversationSessionStillGenerating(state.manager.getSummary(source.taskId)) ||
						isConversationSessionStillGenerating(
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
					};
					const nextBoard = replaceCard(latest.board, taskId, (entry) => ({
						...entry,
						agentId: "codex",
						mainTaskConversationSessionId: selectedRecord.targetTaskConversationSessionId,
						taskMainSessionHandover: nextRecord,
					}));
					const taskAgentPermissionMode =
						current.taskAgentPermissionMode ??
						resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(
							scopedRuntimeConfig.agentAutonomousModeEnabled,
						);
					const targetSummary =
						state.sessions[selectedRecord.targetTaskConversationSessionId] ??
						runtimeTaskSessionSummarySchema.parse({
							taskId: selectedRecord.targetTaskConversationSessionId,
							state: "idle",
							agentId: "codex",
							workspacePath: material.workspacePath,
							pid: null,
							startedAt: null,
							updatedAt: Date.now(),
							lastOutputAt: null,
							reviewReason: null,
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
							turnOwner: null,
							liveness: "none",
							userTurnKind: null,
							taskConversationSessionMetadata: {
								workspaceTaskId: taskId,
								taskConversationSessionRole: "main",
								taskConversationSessionRoleAtCreation: "task_collaborator",
								taskConversationSessionContextSource: "started_from_scratch",
								parentTaskConversationSessionId: null,
								mainSessionOriginTurnNumber: null,
								mainSessionOriginUserMessagePreview: null,
								latestUserMessagePreview: "读取交接材料并汇报现状",
								// 与主绑定一起落盘，冷恢复不依赖首次 start 已经写入快照。
								taskConversationSessionLaunchSettings: {
									taskAgentPermissionMode,
									sessionTransport: "pty_terminal",
								},
							},
						});
					const sourceSummary =
						state.manager.getSummary(source.taskId) ?? latest.sessions[source.taskId] ?? source;
					const sourceMetadata = sourceSummary.taskConversationSessionMetadata;
					// 旧 main 的配置原本只存在卡片上；切主后卡片属于 Codex，先留下 Claude 的独立快照。
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
							taskConversationSessionLaunchSettings: sourceMetadata?.taskConversationSessionLaunchSettings ??
								latest.sessions[source.taskId]?.taskConversationSessionMetadata
									?.taskConversationSessionLaunchSettings ?? {
									taskAgentPermissionMode,
									sessionTransport: resolveRuntimeAgentSessionTransportFromSummary(sourceSummary),
									terminalAgentModelOverrideSettings:
										current.terminalAgentModelOverrideSettings?.agentId === "claude"
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
				if (
					delivery?.terminal_delivery_status === "delivered_and_submit_confirmed" ||
					delivery?.terminal_delivery_status === "delivered_queued_behind_active_agent_turn"
				) {
					await setRecord(scope, taskId, record.handoverId, (current) => ({
						...current,
						status: "awaiting_user_message",
						updatedAt: Date.now(),
					}));
				} else if (
					delivery?.terminal_delivery_status === "delivery_failed" ||
					!liveDeliveryKeys.has(reportDeliveryKey(record))
				) {
					throw new Error("交接汇报投递失败或跨重启后无法确认；未自动重放，请检查 Codex 会话后重试。");
				}
				return;
			}
			const target = (await loadState(scope)).sessions[record.targetTaskConversationSessionId];
			if (isConversationSessionStillGenerating(target)) return;
			if (target?.startedAt != null) state.manager.stopTaskSession(target.taskId);
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
			const startup = await deps.startTaskSession(scope, {
				taskId: record.targetTaskConversationSessionId,
				workspaceTaskId: taskId,
				taskConversationSessionMetadata: {
					...metadata,
					taskConversationSessionRole: "main",
					taskAutomationSuspendedForMainSessionHandover: true,
				},
				agentId: "codex",
				prompt: "",
				baseRef: card.baseRef,
				worktreeMode: card.worktreeMode,
				taskAgentPermissionMode:
					metadata.taskConversationSessionLaunchSettings?.taskAgentPermissionMode ?? card.taskAgentPermissionMode,
				terminalAgentModelOverrideSettings:
					metadata.taskConversationSessionLaunchSettings?.terminalAgentModelOverrideSettings,
				resumePriorAgentConversationWithoutResendingPrompt:
					target?.agentNativeConversationSessionIdentity?.sourceAgentId === "codex",
			});
			if (!startup.ok) throw new Error(startup.error ?? "Codex 启动失败。");
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
			await setRecord(scope, taskId, record.handoverId, (current) => ({
				...current,
				reportDeliveryStartedAt: Date.now(),
				updatedAt: Date.now(),
			}));
			liveDeliveryKeys.add(reportDeliveryKey(record));
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
		});
	}

	async function sweep() {
		if (sweeping) return await sweeping;
		sweeping = (async () => {
			for (const [workspaceId, scope] of pendingScopes) {
				const state = await loadPersistedWorkspaceStateById(workspaceId);
				const cards = state.board.columns
					.flatMap((column) => column.cards)
					.filter(
						(card) =>
							card.taskMainSessionHandover &&
							["waiting_for_sessions_to_stop", "report_delivery_pending"].includes(
								card.taskMainSessionHandover.status,
							),
					);
				if (cards.length === 0) {
					pendingScopes.delete(workspaceId);
					continue;
				}
				for (const card of cards) {
					try {
						await progress(scope, card.id);
					} catch (error) {
						await setRecord(
							scope,
							card.id,
							card.taskMainSessionHandover?.handoverId ?? "",
							(record) => ({
								...record,
								status: "failed",
								updatedAt: Date.now(),
								errorMessage: error instanceof Error ? error.message : String(error),
							}),
							card.taskMainSessionHandover?.reportDeliveryAttempt,
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
				: resolveMainTaskConversationSessionId(card) !== record.targetTaskConversationSessionId
					? "主会话绑定已经改变。"
					: isConversationSessionStillGenerating(target)
						? "原 Codex 会话仍在生成，请等它停下后重试。"
						: state.manager.hasPendingProgrammaticTaskChatInputDelivery?.(record.targetTaskConversationSessionId)
							? "原交接投递仍在处理中，请等待回执。"
							: !record.materialDirectoryPath
								? "原交接材料缺失，无法重新交接。"
								: null;
		return {
			record,
			recoveryAvailability: {
				canRetryUndeliveredReport: record?.status === "failed" && isReportDefinitelyUndelivered(record, delivery),
				canRecreateCodexSession: blockReason === null,
				terminalDeliveryFailureReason: delivery?.terminal_delivery_failure_reason ?? null,
				blockReason,
			},
		};
	}

	async function recoverWithNewCodexSession(
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
				if (!availability?.canRecreateCodexSession) {
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
				if (!existingReceipt)
					await writeFile(receiptFilePath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
				const previousTarget = state.sessions[record.targetTaskConversationSessionId];
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
						agentId: "codex",
						workspacePath: latestPreviousTarget?.workspacePath ?? null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						turnOwner: null,
						liveness: "none",
						userTurnKind: null,
						taskConversationSessionMetadata: {
							workspaceTaskId: input.taskId,
							taskConversationSessionRole: "main",
							taskConversationSessionRoleAtCreation: "task_collaborator",
							taskConversationSessionContextSource: "started_from_scratch",
							taskAutomationSuspendedForMainSessionHandover: true,
							parentTaskConversationSessionId: null,
							mainSessionOriginTurnNumber: null,
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
							agentId: "codex",
							mainTaskConversationSessionId: targetId,
							taskMainSessionHandover: {
								...record,
								targetTaskConversationSessionId: targetId,
								destination: { kind: "new_codex_session" },
								status: "report_delivery_pending",
								reportDeliveryStartedAt: null,
								reportDeliveryAttempt: record.reportDeliveryAttempt + 1,
								errorMessage: null,
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
		recoverWithNewCodexSession,
		request: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: TaskMainSessionHandoverRequest,
			evidence?: KanbanRequestOriginActorEvidence,
		) => {
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
					resolveClaudeSourceSummary(card, current.sessions);
					if (input.destination.kind === "existing_codex_session")
						validateExistingCodexTarget(card, current.sessions[input.destination.taskConversationSessionId]);
					if (
						card.taskMainSessionHandover &&
						["waiting_for_sessions_to_stop", "report_delivery_pending"].includes(
							card.taskMainSessionHandover.status,
						)
					)
						throw new TRPCError({ code: "CONFLICT", message: "该任务已有进行中的交接。" });
					const targetId =
						input.destination.kind === "new_codex_session"
							? `task-conversation-session-${randomUUID()}`
							: input.destination.taskConversationSessionId;
					const record: TaskMainSessionHandoverRecord = {
						handoverId: input.requestId,
						sourceTaskConversationSessionId: input.expectedMainTaskConversationSessionId,
						targetTaskConversationSessionId: targetId,
						destination: input.destination,
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
					const previous = findTaskMessageInjectionRecord(
						await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath)),
						record.targetTaskConversationSessionId,
						reportDeliveryKey(record),
					);
					if (!isReportDefinitelyUndelivered(record, previous)) {
						throw new TRPCError({
							code: "CONFLICT",
							message: "上次投递可能已经发生，未重复发送。请打开 Codex 检查并直接发消息继续。",
						});
					}
					await setRecord(scope, input.taskId, record.handoverId, (current) => ({
						...current,
						status:
							resolveMainTaskConversationSessionId(card) === record.sourceTaskConversationSessionId
								? "waiting_for_sessions_to_stop"
								: "report_delivery_pending",
						errorMessage: null,
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
							column.cards.some(
								(card) =>
									card.taskMainSessionHandover &&
									["waiting_for_sessions_to_stop", "report_delivery_pending"].includes(
										card.taskMainSessionHandover.status,
									),
							),
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
