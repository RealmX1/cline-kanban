import { TRPCError } from "@trpc/server";
import pLimit from "p-limit";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeBoardData,
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorkspaceGitStatus,
	RuntimeTaskWorkspaceGitStatusesResponse,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateResponse,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../core/api-contract";
import {
	parseGitCheckoutRequest,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core/api-validation";
import { isSessionInActiveTurn, resolveSessionFacets } from "../core/session-activity";
import { addTaskToColumn } from "../core/task-board-mutations";
import { resolveTaskCreateBaseRef } from "../core/task-create-base-ref-resolution";
import { recordTaskSessionStartDiagnostic } from "../diagnostics/task-session-start-diagnostics-logger";
import type { KanbanActorResolutionLookups } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { recordFactObservedByActiveKanbanRuntimeWithoutBlocking } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	collectTaskIdsRemovedFromBoard,
	discardTaskEditDraftsForTasksRemovedFromBoard,
} from "../state/discard-task-edit-drafts-for-tasks-removed-from-board";
import { discardQueuedTaskPromptDeliveriesForTasks } from "../state/queued-task-prompt-delivery-store";
import { allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	loadWorkspaceBoardById,
	mutateWorkspaceState,
	saveWorkspaceState,
	WorkspaceStateConflictError,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "../workspace/get-workspace-changes";
import {
	getCommitChangedFileMetadata,
	getCommitDiff,
	getCommitFileDiffPatch,
	getGitLog,
	getGitRefs,
} from "../workspace/git-history";
import { discardGitChanges, getGitSyncSummary, runGitCheckoutAction, runGitSyncAction } from "../workspace/git-sync";
import { runGit } from "../workspace/git-utils";
import { searchWorkspaceFiles } from "../workspace/search-workspace-files";
import { probeAndRefreshTaskCommitIntegrationProvenance } from "../workspace/task-commit-integration-provenance";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo,
	getTaskWorkspacePathInfo,
	resolveTaskCwd,
	TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX,
	TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX,
} from "../workspace/task-worktree";
import { deleteAllTaskTurnCheckpointRefs } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";
import { applyKanbanCliTaskBoardMutation } from "./kanban-cli-task-board-mutation-api";

const TASK_WORKSPACE_GIT_STATUS_BATCH_CONCURRENCY_LIMIT = 4;
const taskWorkspaceGitStatusBatchConcurrencyLimiter = pLimit(TASK_WORKSPACE_GIT_STATUS_BATCH_CONCURRENCY_LIMIT);

function createGitProbeUnavailableTaskWorkspaceStatus(baseRef: string): RuntimeTaskWorkspaceGitStatus {
	return {
		baseRef,
		commitsAheadOfBaseRef: null,
		commitsBehindBaseRef: null,
		taskCommitsIntegratedIntoBaseRef: null,
		taskCommitIntegrationTrackingStatus: "git_probe_unavailable",
		observationSource: "unavailable",
		observedAt: null,
	};
}

// 「写之前的 board」与随后的差集清理是一条**纯兜底**的旁路：它存在的意义是让 CLI / 未来的服务端写入
// 路径也别留下孤儿草稿。所以这两步的任何失败都必须就地咽掉——一次草稿清理绝不该有能力让用户的看板
// 保存失败。（读不到旧 board 时返回 null = 这一次不做差集，而不是把「读不到」当成「一张卡都不剩」，
// 后者会把整个 workspace 的草稿一次清空。）
async function readBoardBeforeSaveForOrphanedDraftCleanup(workspaceId: string): Promise<RuntimeBoardData | null> {
	try {
		return await loadWorkspaceBoardById(workspaceId);
	} catch {
		return null;
	}
}

async function discardTaskEditDraftsForTasksRemovedFromSavedBoard(
	workspaceId: string,
	boardBeforeSave: RuntimeBoardData | null,
	boardAfterSave: RuntimeBoardData,
): Promise<void> {
	if (boardBeforeSave === null) {
		return;
	}
	try {
		await discardTaskEditDraftsForTasksRemovedFromBoard(workspaceId, boardBeforeSave, boardAfterSave);
	} catch {
		// 同上：残留一条看不见的孤儿草稿，比让看板保存整个失败好得多。
	}
}

// 同一条兜底旁路：任务从看板上永久消失时丢弃它的排队 prompt。与草稿相反，队列条目不是用户资产而是
// **待执行的机器动作**——目标任务都不在了还留着它，只会在任务被恢复时突然发射。仅移进 trash 列的任务
// 仍在两份 board 里，差集天然不碰它（trash 列里的会话不在跑，门控 4 兜住，队列只是安静地等）。
async function discardQueuedTaskPromptDeliveriesForTasksRemovedFromSavedBoard(
	workspaceId: string,
	boardBeforeSave: RuntimeBoardData | null,
	boardAfterSave: RuntimeBoardData,
	onQueueRewritten: ((workspaceId: string, snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot) => void) | undefined,
): Promise<void> {
	if (boardBeforeSave === null) {
		return;
	}
	const removedTaskIds = collectTaskIdsRemovedFromBoard(boardBeforeSave, boardAfterSave);
	if (removedTaskIds.length === 0) {
		return;
	}
	try {
		const snapshot = await discardQueuedTaskPromptDeliveriesForTasks({ workspaceId, taskIds: removedTaskIds });
		onQueueRewritten?.(workspaceId, snapshot);
	} catch {
		// 同上：残留的队列会在 24h 保质期后自然过期，比让看板保存整个失败好得多。
	}
}

// 与上面的草稿清理同一条兜底旁路：任务从看板上永久消失（浏览器删卡 / 清空 Done）时，按前缀批删它的
// 全部 turn checkpoint ref（姊妹蓝图 §1.4：存续期全量保留，永久删除时批删）。仅移进 trash 列的任务
// 仍在两份 board 里，差集天然不碰它。失败语义照旧——任何失败就地咽掉，绝不让看板保存因此失败。
async function deleteTurnCheckpointRefsForTasksRemovedFromSavedBoard(
	workspacePath: string,
	boardBeforeSave: RuntimeBoardData | null,
	boardAfterSave: RuntimeBoardData,
): Promise<void> {
	if (boardBeforeSave === null) {
		return;
	}
	for (const taskId of collectTaskIdsRemovedFromBoard(boardBeforeSave, boardAfterSave)) {
		try {
			await deleteAllTaskTurnCheckpointRefs({ cwd: workspacePath, taskId });
		} catch {
			// 同上：残留几个无人认领的 checkpoint ref，比让看板保存整个失败好得多。
		}
	}
}

export interface CreateWorkspaceApiDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: {
		workspaceId: string;
		workspacePath: string;
	}) => Promise<ClineTaskSessionService>;
	loadScopedRuntimeConfig: (scope: { workspaceId: string; workspacePath: string }) => Promise<RuntimeConfigState>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	listProjectRuntimeSessionSummaries: (workspaceId: string) => RuntimeTaskSessionSummary[];
	// 行动者解析 lookups（dd2db 1a）。测试注入用；缺省为读 workspace 索引与 board.json 的生产实现。
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
	// 任务离开看板导致队列被丢弃之后，让出队引擎刷新缓存并重发投影。
	onQueuedTaskPromptDeliveriesRewrittenForTasksRemovedFromBoard?: (
		workspaceId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	) => void;
}

function normalizeOptionalTaskWorkspaceScopeInput(
	input: { taskId: string; baseRef: string; worktreeMode?: RuntimeTaskWorktreeMode } | null,
): { taskId: string; baseRef: string; worktreeMode: RuntimeTaskWorktreeMode | undefined } | null {
	if (!input) {
		return null;
	}
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId || !baseRef) {
		throw new Error("baseRef query parameter requires taskId.");
	}
	return {
		taskId,
		baseRef,
		worktreeMode: input.worktreeMode,
	};
}

function normalizeRequiredTaskWorkspaceScopeInput(input: {
	taskId: string;
	baseRef: string;
	mode?: RuntimeWorkspaceChangesMode;
	worktreeMode?: RuntimeTaskWorktreeMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkspaceChangesMode;
	worktreeMode: RuntimeTaskWorktreeMode | undefined;
} {
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId) {
		throw new Error("Missing taskId query parameter.");
	}
	if (!baseRef) {
		throw new Error("Missing baseRef query parameter.");
	}
	const mode: RuntimeWorkspaceChangesMode = input.mode ?? "working_copy";
	return {
		taskId,
		baseRef,
		mode,
		worktreeMode: input.worktreeMode,
	};
}

// Stage 2：决策型「活跃回合」判据改读 facet（不再读 legacy state）。等价于旧
// `state ∈ {running, awaiting_review}`，但绕开 projectLegacyState 对 live↔exited 的有损投影。
function isActiveTaskSessionState(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary != null && isSessionInActiveTurn(resolveSessionFacets(summary));
}

function selectLastTurnSummary(
	terminalSummary: RuntimeTaskSessionSummary | null,
	clineSummary: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!terminalSummary) {
		return clineSummary;
	}
	if (!clineSummary) {
		return terminalSummary;
	}
	const terminalIsActive = isActiveTaskSessionState(terminalSummary);
	const clineIsActive = isActiveTaskSessionState(clineSummary);
	if (terminalIsActive !== clineIsActive) {
		return clineIsActive ? clineSummary : terminalSummary;
	}
	if (terminalSummary.updatedAt !== clineSummary.updatedAt) {
		return terminalSummary.updatedAt > clineSummary.updatedAt ? terminalSummary : clineSummary;
	}
	if (clineSummary.agentId === "cline" && terminalSummary.agentId !== "cline") {
		return clineSummary;
	}
	return terminalSummary;
}

function createEmptyGitSummaryErrorResponse(error: unknown): RuntimeGitSummaryResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		error: message,
	};
}

function createEmptyGitSyncErrorResponse(action: RuntimeGitSyncAction, error: unknown): RuntimeGitSyncResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		action,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitCheckoutErrorResponse(error: unknown): RuntimeGitCheckoutResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		branch: "",
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitDiscardErrorResponse(error: unknown): RuntimeGitDiscardResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function isTaskWorktreeMissingOrStillSettingUpError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return (
		error.message.startsWith(TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX) ||
		error.message.startsWith(TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX)
	);
}

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	return {
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let summaryCwd = workspaceScope.workspacePath;
				if (taskScope) {
					summaryCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
						...(taskScope.worktreeMode ? { worktreeMode: taskScope.worktreeMode } : {}),
					});
				}
				const summary = await getGitSyncSummary(summaryCwd);
				return {
					ok: true,
					summary,
				} satisfies RuntimeGitSummaryResponse;
			} catch (error) {
				return createEmptyGitSummaryErrorResponse(error);
			}
		},
		runGitSyncAction: async (workspaceScope, input) => {
			try {
				return await runGitSyncAction({
					cwd: workspaceScope.workspacePath,
					action: input.action,
				});
			} catch (error) {
				return createEmptyGitSyncErrorResponse(input.action, error);
			}
		},
		checkoutGitBranch: async (workspaceScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);
				const response = await runGitCheckoutAction({
					cwd: workspaceScope.workspacePath,
					branch: body.branch,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitCheckoutErrorResponse(error);
			}
		},
		discardGitChanges: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let discardCwd = workspaceScope.workspacePath;
				if (taskScope) {
					discardCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
						...(taskScope.worktreeMode ? { worktreeMode: taskScope.worktreeMode } : {}),
					});
				}
				const response = await discardGitChanges({
					cwd: discardCwd,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitDiscardErrorResponse(error);
			}
		},
		loadChanges: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			let taskCwd: string;
			try {
				taskCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
					ensure: false,
					...(normalizedInput.worktreeMode ? { worktreeMode: normalizedInput.worktreeMode } : {}),
				});
			} catch (error) {
				if (!isTaskWorktreeMissingOrStillSettingUpError(error)) {
					throw error;
				}
				return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);
			}
			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = selectLastTurnSummary(
					terminalManager.getSummary(normalizedInput.taskId),
					clineTaskSessionService.getSummary(normalizedInput.taskId),
				);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkspaceChangesResponse(taskCwd);
				}
				// agent 仍在本回合推进（旧 state==="running" ⟺ facet turnOwner==="agent"）→ 用最新
				// checkpoint 单边 diff；否则取上一/最新 checkpoint 之间的 diff。
				const agentTurnInProgress = summary != null && resolveSessionFacets(summary).turnOwner === "agent";
				if (agentTurnInProgress || !fromCheckpoint) {
					return await getWorkspaceChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkspaceChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkspaceChanges(taskCwd);
		},
		ensureWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeEnsureRequest(input);
			const ensureRequestReceivedAt = Date.now();
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
				worktreeMode: body.worktreeMode,
			});
			// 浏览器启动任务是两次独立 RPC：先 ensureWorktree、再 startTaskSession。这一步失败时浏览器只弹一条
			// toast，卡片停在 In Progress 且没有会话，而 startTaskSession 根本没被调用——启动诊断日志里一行
			// 都没有，「新任务起不来」在服务端无从查起（高负载下锁等待超时就是这样消失的）。在这里补记。
			if (!ensured.ok) {
				void recordTaskSessionStartDiagnostic({
					event: "failed",
					workspaceId: workspaceScope.workspaceId,
					taskId: body.taskId,
					requestedAgentId: null,
					effectiveAgentId: null,
					phase: "ensure_task_worktree",
					elapsedMs: Date.now() - ensureRequestReceivedAt,
					error: ensured.error ?? null,
					session: null,
				});
			}
			return ensured;
		},
		deleteWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			// 删除目录前尽力落最后一份 Git 状态快照。Done-stage guard 属独立任务；这里的
			// provenance 采集失败不得把既有 worktree cleanup 变成破坏性行为变化。
			// 拿不到 live 快照的原因留到删除成功后记成族 3 事实（Y-PHASE-3）：1c 的落地判据据此知道「最后一份快照不新鲜」。
			let finalTaskCommitIntegrationProbeFailureReason: string | null = null;
			try {
				const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
				const card = board.columns
					.flatMap((column) => column.cards)
					.find((candidate) => candidate.id === body.taskId);
				if (card) {
					const pathInfo = await getTaskWorkspacePathInfo({
						cwd: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: card.baseRef,
						worktreeMode: body.worktreeMode,
					});
					const finalWorkspaceGitStatus = await probeAndRefreshTaskCommitIntegrationProvenance({
						workspaceId: workspaceScope.workspaceId,
						taskId: body.taskId,
						repoPath: workspaceScope.workspacePath,
						worktreePath: pathInfo.path,
						baseRef: card.baseRef,
						worktreeMode: body.worktreeMode,
						worktreeExists: pathInfo.exists,
					});
					if (finalWorkspaceGitStatus.observationSource !== "live_worktree") {
						finalTaskCommitIntegrationProbeFailureReason = `final_probe_observation_source_was_${finalWorkspaceGitStatus.observationSource}`;
					}
				} else {
					finalTaskCommitIntegrationProbeFailureReason = "task_card_not_found_on_board_at_worktree_deletion";
				}
			} catch (error) {
				// best effort，真正的保护由另一个 Done-stage guard task 实现。
				finalTaskCommitIntegrationProbeFailureReason = `final_probe_threw:${error instanceof Error ? error.message : String(error)}`;
			}
			const deletionResult = await deleteTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
				worktreeMode: body.worktreeMode,
			});
			// 删 worktree 不再连带删除 task commit provenance（落地数据保全，Y-PHASE-3）：1c 的共享落地判据要读这份数据。
			if (deletionResult.removed && finalTaskCommitIntegrationProbeFailureReason !== null) {
				recordFactObservedByActiveKanbanRuntimeWithoutBlocking({
					observedFactKind: "task_commit_integration_final_snapshot_unavailable_at_worktree_deletion",
					observingKanbanRuntimeSystemComponentName: "workspace_api_task_worktree_deletion",
					subjectWorkspaceId: workspaceScope.workspaceId,
					subjectTaskId: body.taskId,
					eventPayload: { finalTaskCommitIntegrationProbeFailureReason },
				});
			}
			return deletionResult;
		},
		loadTaskWorkspaceGitStatuses: async (workspaceScope): Promise<RuntimeTaskWorkspaceGitStatusesResponse> => {
			const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
			const cards = board.columns.flatMap((column) => column.cards);
			const baseRefTipCommitPromises = new Map<string, Promise<string | null>>();
			const resolveBaseRefTipCommit = (baseRef: string): Promise<string | null> => {
				const existing = baseRefTipCommitPromises.get(baseRef);
				if (existing) {
					return existing;
				}
				const pending = runGit(workspaceScope.workspacePath, ["rev-parse", "--verify", `${baseRef}^{commit}`]).then(
					(result) => (result.ok && result.stdout ? result.stdout : null),
				);
				baseRefTipCommitPromises.set(baseRef, pending);
				return pending;
			};
			const statusEntries = await Promise.all(
				cards.map(
					async (card) =>
						await taskWorkspaceGitStatusBatchConcurrencyLimiter(async () => {
							try {
								const knownBaseRefTipCommit = await resolveBaseRefTipCommit(card.baseRef);
								const pathInfo = await getTaskWorkspacePathInfo({
									cwd: workspaceScope.workspacePath,
									taskId: card.id,
									baseRef: card.baseRef,
									...(card.worktreeMode ? { worktreeMode: card.worktreeMode } : {}),
								});
								const status = await probeAndRefreshTaskCommitIntegrationProvenance({
									workspaceId: workspaceScope.workspaceId,
									taskId: card.id,
									repoPath: workspaceScope.workspacePath,
									worktreePath: pathInfo.path,
									baseRef: card.baseRef,
									...(card.worktreeMode ? { worktreeMode: card.worktreeMode } : {}),
									worktreeExists: pathInfo.exists,
									knownBaseRefTipCommit,
								});
								return [card.id, status] as const;
							} catch {
								return [card.id, createGitProbeUnavailableTaskWorkspaceStatus(card.baseRef)] as const;
							}
						}),
				),
			);
			return { taskWorkspaceGitStatuses: Object.fromEntries(statusEntries) };
		},
		loadTaskContext: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			return await getTaskWorkspaceInfo({
				cwd: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
				worktreeMode: normalizedInput.worktreeMode,
			});
		},
		searchFiles: async (workspaceScope, input) => {
			const query = input.query.trim();
			const limit = input.limit;
			const files = await searchWorkspaceFiles(workspaceScope.workspacePath, query, limit);
			return {
				query,
				files,
			} satisfies RuntimeWorkspaceFileSearchResponse;
		},
		loadState: async (workspaceScope) => {
			return await deps.buildWorkspaceStateSnapshot(workspaceScope.workspaceId, workspaceScope.workspacePath);
		},
		notifyStateUpdated: async (workspaceScope) => {
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			return {
				ok: true,
			};
		},
		saveState: async (workspaceScope, requestInput, kanbanRequestOriginActorEvidence) => {
			// 发起方标注只进关系账本，不随 board 落盘。
			const { boardMutationInitiatorAnnotationsForTaskMutationEventCapture, ...input } = requestInput;
			// 在 board 锁之外先解析行动者：带页面 nonce 的请求先解析为「来自页面、缺标注」，漏斗再按标注逐条细化；
			// 带 CLI 声明头的整份 PUT 按声明解析（标注一律不采信）；两者都没有的是裸 tRPC 调用方。
			const taskMutationIntentWithResolvedActor = {
				...(await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
					taskMutationIntentKind: "web_ui_workspace_board_state_save",
					kanbanRequestOriginActorEvidence,
					kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
				})),
				webUiBoardMutationInitiatorAnnotationsForTaskMutationEventCapture:
					boardMutationInitiatorAnnotationsForTaskMutationEventCapture ?? [],
			};
			try {
				for (const summary of deps.listProjectRuntimeSessionSummaries(workspaceScope.workspaceId)) {
					input.sessions[summary.taskId] = summary;
				}
				// 浏览器删除一张卡片不走任何「删除 procedure」——它就是一次整份 board PUT，那张卡只是不在了。
				// 所以「任务被删除」在这条路径上只能由前后两份 board 的差集看出来（见
				// discard-task-edit-drafts-for-tasks-removed-from-board.ts）。
				//
				// 已知残留：这一次读发生在 saveWorkspaceState 的文件锁**之外**，与写之间有一个 TOCTOU 窗口。
				// 缩小它需要把清理搬进 workspace-state 的锁内，而那会形成模块环（同上文件的注释）。代价是
				// 偶发漏清一条孤儿草稿——不丢任何用户内容，而浏览器侧的删除 handler 本来也会各自清一次，
				// 这里是给「不经那个 handler 的写入」兜底。
				const boardBeforeSave = await readBoardBeforeSaveForOrphanedDraftCleanup(workspaceScope.workspaceId);
				const response = await saveWorkspaceState(
					workspaceScope.workspacePath,
					taskMutationIntentWithResolvedActor,
					input,
				);
				await discardTaskEditDraftsForTasksRemovedFromSavedBoard(
					workspaceScope.workspaceId,
					boardBeforeSave,
					response.board,
				);
				await deleteTurnCheckpointRefsForTasksRemovedFromSavedBoard(
					workspaceScope.workspacePath,
					boardBeforeSave,
					response.board,
				);
				await discardQueuedTaskPromptDeliveriesForTasksRemovedFromSavedBoard(
					workspaceScope.workspaceId,
					boardBeforeSave,
					response.board,
					deps.onQueuedTaskPromptDeliveriesRewrittenForTasksRemovedFromBoard,
				);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
				return response;
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: {
							currentRevision: error.currentRevision,
						},
					});
				}
				throw error;
			}
		},
		addBacklogTask: async (workspaceScope, input, kanbanRequestOriginActorEvidence) => {
			const prompt = input.prompt.trim();
			if (!prompt) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Task prompt is required." });
			}
			const runtimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			const taskMutationIntentWithResolvedActor =
				await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
					taskMutationIntentKind: "runtime_trpc_add_backlog_task",
					kanbanRequestOriginActorEvidence,
					kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
				});
			// Reuses the exact `kanban task create` core pipeline: atomic locked
			// load→mutate→save via mutateWorkspaceState + the pure addTaskToColumn. baseRef is
			// resolved server-side from the workspace's git state (same rule as the CLI).
			// 这条入口不给用户挑 base ref，所以「记住的那条」在这里是只读消费：与 UI 建卡对话框、
			// CLI `task create` 共用同一个 resolver，免得同一个项目换条入口建卡就落到不同 base 上。
			// 只读不写——没有可写的用户意图，快速添加不该悄悄改掉人在对话框里表达过的选择。
			const rememberedBaseRefForProject =
				runtimeConfig.userInterfacePreferencesSharedAcrossBrowserOrigins
					.mostRecentlyUsedTaskCreateBaseRefByProjectId[workspaceScope.workspaceId] ?? null;
			// Y-EVENT-12：id 由 runtime 对全局 task 身份登记簿分配；漏斗在锁内再校验一次。
			const allocatedTaskIdForNewBacklogTaskCard =
				await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
					requestingWorkspaceId: workspaceScope.workspaceId,
				});
			const mutationResponse = await mutateWorkspaceState(
				workspaceScope.workspacePath,
				taskMutationIntentWithResolvedActor,
				(state) => {
					const resolvedBaseRef = resolveTaskCreateBaseRef({
						rememberedBaseRefForProject,
						repository: state.git,
					}).baseRef;
					if (!resolvedBaseRef) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Could not determine task base branch for this workspace.",
						});
					}
					const result = addTaskToColumn(
						state.board,
						"backlog",
						{
							title: input.title,
							prompt,
							startInPlanMode: runtimeConfig.newTaskStartInPlanModeByDefault,
							ompAgentSessionTransportForNewTasks: runtimeConfig.ompAgentSessionTransportForNewTasks,
							// 这条入口不让用户挑 agent，卡片 agentId 恒为空 ⇒ 这张卡实际会跑工作区默认 agent。
							// 不把它传下去的话，「工作区默认是 omp」的新卡不会固化通道，之后改全局默认会反向改掉它。
							workspaceDefaultAgentIdForNewTasks: runtimeConfig.selectedAgentId,
							baseRef: resolvedBaseRef,
							images: input.images,
							...(allocatedTaskIdForNewBacklogTaskCard !== null
								? { taskId: allocatedTaskIdForNewBacklogTaskCard }
								: {}),
						},
						() => globalThis.crypto.randomUUID(),
					);
					return {
						board: result.board,
						value: { taskId: result.task.id },
					};
				},
			);
			if (mutationResponse.saved) {
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			}
			return { taskId: mutationResponse.value.taskId };
		},
		applyKanbanCliTaskBoardMutation: async (workspaceScope, input, kanbanRequestOriginActorEvidence) => {
			return await applyKanbanCliTaskBoardMutation(
				{
					broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated,
					broadcastRuntimeProjectsUpdated: deps.broadcastRuntimeProjectsUpdated,
					kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
				},
				workspaceScope,
				input,
				kanbanRequestOriginActorEvidence,
			);
		},
		loadWorkspaceChanges: async (workspaceScope) => {
			return await getWorkspaceChanges(workspaceScope.workspacePath);
		},
		loadGitLog: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let logCwd = workspaceScope.workspacePath;
			if (taskScope) {
				logCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
					...(taskScope.worktreeMode ? { worktreeMode: taskScope.worktreeMode } : {}),
				});
			}
			return await getGitLog({
				cwd: logCwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},
		loadGitRefs: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input ?? null);
			let refsCwd = workspaceScope.workspacePath;
			if (taskScope) {
				refsCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
					...(taskScope.worktreeMode ? { worktreeMode: taskScope.worktreeMode } : {}),
				});
			}
			return await getGitRefs(refsCwd);
		},
		loadCommitDiff: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
					...(taskScope.worktreeMode ? { worktreeMode: taskScope.worktreeMode } : {}),
				});
			}
			return await getCommitDiff({
				cwd: diffCwd,
				commitHash: input.commitHash,
			});
		},
		loadCommitChangedFileMetadata: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let metadataCwd = workspaceScope.workspacePath;
			if (taskScope) {
				metadataCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
					...(taskScope.worktreeMode ? { worktreeMode: taskScope.worktreeMode } : {}),
				});
			}
			return await getCommitChangedFileMetadata({
				cwd: metadataCwd,
				commitHash: input.commitHash,
			});
		},
		loadCommitFileDiffPatch: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
					...(taskScope.worktreeMode ? { worktreeMode: taskScope.worktreeMode } : {}),
				});
			}
			return await getCommitFileDiffPatch({
				cwd: diffCwd,
				commitHash: input.commitHash,
				path: input.path,
				previousPath: input.previousPath,
			});
		},
	};
}
