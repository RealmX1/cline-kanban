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
} from "../core/api-contract";
import {
	parseGitCheckoutRequest,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core/api-validation";
import { isSessionInActiveTurn, resolveSessionFacets } from "../core/session-activity";
import { addTaskToColumn } from "../core/task-board-mutations";
import { discardTaskEditDraftsForTasksRemovedFromBoard } from "../state/discard-task-edit-drafts-for-tasks-removed-from-board";
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
import {
	probeAndRefreshTaskCommitIntegrationProvenance,
	removeTaskCommitIntegrationProvenance,
} from "../workspace/task-commit-integration-provenance";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo,
	getTaskWorkspacePathInfo,
	resolveTaskCwd,
	TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX,
	TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX,
} from "../workspace/task-worktree";
import type { RuntimeTrpcContext } from "./app-router";

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
			return await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
				worktreeMode: body.worktreeMode,
			});
		},
		deleteWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			// 删除目录前尽力落最后一份 Git 状态快照。Done-stage guard 属独立任务；这里的
			// provenance 采集失败不得把既有 worktree cleanup 变成破坏性行为变化。
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
					await probeAndRefreshTaskCommitIntegrationProvenance({
						workspaceId: workspaceScope.workspaceId,
						taskId: body.taskId,
						repoPath: workspaceScope.workspacePath,
						worktreePath: pathInfo.path,
						baseRef: card.baseRef,
						worktreeMode: body.worktreeMode,
						worktreeExists: pathInfo.exists,
					});
				}
			} catch {
				// best effort，真正的保护由另一个 Done-stage guard task 实现。
			}
			const deletionResult = await deleteTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
				worktreeMode: body.worktreeMode,
			});
			if (deletionResult.ok && body.removeTaskCommitIntegrationProvenanceAfterWorktreeDeletion === true) {
				await removeTaskCommitIntegrationProvenance(workspaceScope.workspaceId, body.taskId);
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
		saveState: async (workspaceScope, input) => {
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
				const response = await saveWorkspaceState(workspaceScope.workspacePath, input);
				await discardTaskEditDraftsForTasksRemovedFromSavedBoard(
					workspaceScope.workspaceId,
					boardBeforeSave,
					response.board,
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
		addBacklogTask: async (workspaceScope, input) => {
			const prompt = input.prompt.trim();
			if (!prompt) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Task prompt is required." });
			}
			const runtimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			// Reuses the exact `kanban task create` core pipeline: atomic locked
			// load→mutate→save via mutateWorkspaceState + the pure addTaskToColumn. baseRef is
			// resolved server-side from the workspace's git state (same rule as the CLI).
			const mutationResponse = await mutateWorkspaceState(workspaceScope.workspacePath, (state) => {
				const resolvedBaseRef =
					state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0]?.name ?? "";
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
					},
					() => globalThis.crypto.randomUUID(),
				);
				return {
					board: result.board,
					value: { taskId: result.task.id },
				};
			});
			if (mutationResponse.saved) {
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			}
			return { taskId: mutationResponse.value.taskId };
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
