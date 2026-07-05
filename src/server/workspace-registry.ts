import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeInProgressTaskDetail,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	type RuntimeWorkspaceIndexEntry,
	removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles,
} from "../state/workspace-state";
import { TerminalSessionManager } from "../terminal/session-manager";
import { runGit } from "../workspace/git-utils";
import { collectInProgressTaskDetailsFromBoard } from "./in-progress-task-detail-projection";
import { applyLiveSessionStateToProjectTaskCounts } from "./project-task-counts-live-session-overlay";

export interface WorkspaceRegistryScope {
	workspaceId: string;
	workspacePath: string;
}

export interface CreateWorkspaceRegistryDependencies {
	cwd: string;
	loadGlobalRuntimeConfig: () => Promise<RuntimeConfigState>;
	loadRuntimeConfig: (cwd: string) => Promise<RuntimeConfigState>;
	hasGitRepository: (path: string) => boolean;
	pathIsDirectory: (path: string) => Promise<boolean>;
	onTerminalManagerReady?: (workspaceId: string, manager: TerminalSessionManager) => void;
}

export interface DisposeWorkspaceRegistryOptions {
	stopTerminalSessions?: boolean;
}

/**
 * `sessions.json` 只在 graceful shutdown 落盘。非优雅退出（进程被杀 / --skip-shutdown-cleanup）会
 * 留下 agent 完全启动之前的默认快照——`startTaskSession` 的 `agentId: request.agentId` 尚未写入，
 * 于是 summary.agentId 恒为 null。board card 才是「该 task 用哪个 agent」的 durable 真相源，故在
 * hydrate 之前用它回填丢失的 agentId。否则 summary.agentId===null 会同时击穿三条恢复路径：
 * canRefresh（Refresh 按钮禁用）、refreshTaskTerminal 的 agentId gate、以及聚焦时的自动续跑判据，
 * 令「进程随运行时重启而死」的任务彻底无法恢复。只回填、不覆盖已有 agentId；无 card 的 shell /
 * home / synthetic 会话正确保留 null。
 */
export function applyBoardCardAgentIdsToSessions(
	board: RuntimeBoardData,
	sessions: RuntimeWorkspaceStateResponse["sessions"],
): void {
	const cardAgentIdByTaskId = new Map<string, NonNullable<RuntimeBoardCard["agentId"]>>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.agentId) {
				cardAgentIdByTaskId.set(card.id, card.agentId);
			}
		}
	}
	for (const summary of Object.values(sessions)) {
		if (summary.agentId === null) {
			const cardAgentId = cardAgentIdByTaskId.get(summary.taskId);
			if (cardAgentId) {
				summary.agentId = cardAgentId;
			}
		}
	}
}

async function backfillSessionAgentIdsFromBoard(
	workspaceId: string,
	sessions: RuntimeWorkspaceStateResponse["sessions"],
): Promise<void> {
	let board: RuntimeBoardData;
	try {
		board = await loadWorkspaceBoardById(workspaceId);
	} catch {
		return;
	}
	applyBoardCardAgentIdsToSessions(board, sessions);
}

export interface ResolvedWorkspaceStreamTarget {
	workspaceId: string | null;
	workspacePath: string | null;
	removedRequestedWorkspacePath: string | null;
	didPruneProjects: boolean;
}

export interface RemovedWorkspaceNotice {
	workspaceId: string;
	repoPath: string;
	message: string;
}

export interface WorkspaceRegistry {
	getActiveWorkspaceId: () => string | null;
	getActiveWorkspacePath: () => string | null;
	getWorkspacePathById: (workspaceId: string) => string | null;
	rememberWorkspace: (workspaceId: string, repoPath: string) => void;
	getActiveRuntimeConfig: () => RuntimeConfigState;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	loadScopedRuntimeConfig: (scope: WorkspaceRegistryScope) => Promise<RuntimeConfigState>;
	getTerminalManagerForWorkspace: (workspaceId: string) => TerminalSessionManager | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	setActiveWorkspace: (workspaceId: string, repoPath: string) => Promise<void>;
	clearActiveWorkspace: () => void;
	disposeWorkspace: (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	) => {
		terminalManager: TerminalSessionManager | null;
		workspacePath: string | null;
	};
	summarizeProjectTaskCounts: (workspaceId: string, repoPath: string) => Promise<RuntimeProjectTaskCounts>;
	createProjectSummary: (input: {
		workspaceId: string;
		repoPath: string;
		taskCounts: RuntimeProjectTaskCounts;
	}) => RuntimeProjectSummary;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	buildProjectsPayload: (preferredCurrentProjectId: string | null) => Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
	}>;
	resolveWorkspaceForStream: (
		requestedWorkspaceId: string | null,
		options?: {
			onRemovedWorkspace?: (workspace: RemovedWorkspaceNotice) => void;
		},
	) => Promise<ResolvedWorkspaceStreamTarget>;
	listManagedWorkspaces: () => Array<{
		workspaceId: string;
		workspacePath: string | null;
		terminalManager: TerminalSessionManager;
	}>;
}

function createEmptyProjectTaskCounts(): RuntimeProjectTaskCounts {
	return {
		backlog: 0,
		in_progress: 0,
		review: 0,
		validation: 0,
		trash: 0,
	};
}

function countTasksByColumn(board: RuntimeBoardData): RuntimeProjectTaskCounts {
	const counts = createEmptyProjectTaskCounts();
	for (const column of board.columns) {
		const count = column.cards.length;
		switch (column.id) {
			case "backlog":
				counts.backlog += count;
				break;
			case "in_progress":
				counts.in_progress += count;
				break;
			case "review":
				counts.review += count;
				break;
			case "validation":
				counts.validation += count;
				break;
			case "trash":
				counts.trash += count;
				break;
		}
	}
	return counts;
}

export interface ProjectWorktreeTaskCleanupTarget {
	taskId: string;
	worktreeMode: RuntimeTaskWorktreeMode | undefined;
}

export function collectProjectWorktreeTaskIdsForRemoval(board: RuntimeBoardData): ProjectWorktreeTaskCleanupTarget[] {
	const targets: ProjectWorktreeTaskCleanupTarget[] = [];
	const seen = new Set<string>();
	for (const column of board.columns) {
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			if (seen.has(card.id)) {
				continue;
			}
			seen.add(card.id);
			targets.push({ taskId: card.id, worktreeMode: card.worktreeMode });
		}
	}
	return targets;
}

function toProjectSummary(project: {
	workspaceId: string;
	repoPath: string;
	taskCounts: RuntimeProjectTaskCounts;
	// board 列归属的原始计数（未套 live-session overlay），供 Stage-First Overview 用。快路径可省略，
	// 下一次 projects_updated/snapshot 广播补齐（见 ADR-0001）。
	rawColumnTaskCounts?: RuntimeProjectTaskCounts;
	// in_progress 列 task 明细，供 Stage-First Overview 展开 In-Progress 阶段。快路径省略时默认空数组。
	inProgressTaskDetails?: RuntimeInProgressTaskDetail[];
	// Optional so the `projects.add` fast path can omit it — origin is populated for real
	// on the next projects_updated/snapshot broadcast via buildProjectsPayload.
	gitRemoteOriginUrl?: string | null;
}): RuntimeProjectSummary {
	const normalized = project.repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	const name = segments[segments.length - 1] ?? normalized;
	return {
		id: project.workspaceId,
		path: project.repoPath,
		name,
		taskCounts: project.taskCounts,
		...(project.rawColumnTaskCounts ? { rawColumnTaskCounts: project.rawColumnTaskCounts } : {}),
		inProgressTaskDetails: project.inProgressTaskDetails ?? [],
		gitRemoteOriginUrl: project.gitRemoteOriginUrl ?? null,
	};
}

export async function createWorkspaceRegistry(deps: CreateWorkspaceRegistryDependencies): Promise<WorkspaceRegistry> {
	const launchedFromGitRepo = deps.hasGitRepository(deps.cwd);
	const initialWorkspace = launchedFromGitRepo ? await loadWorkspaceContext(deps.cwd) : null;
	let indexedWorkspace: RuntimeWorkspaceIndexEntry | null = null;
	if (!initialWorkspace) {
		const indexedWorkspaces = await listWorkspaceIndexEntries();
		indexedWorkspace = indexedWorkspaces[0] ?? null;
	}

	let activeWorkspaceId: string | null = initialWorkspace?.workspaceId ?? indexedWorkspace?.workspaceId ?? null;
	let activeWorkspacePath: string | null = initialWorkspace?.repoPath ?? indexedWorkspace?.repoPath ?? null;
	let globalRuntimeConfig = await deps.loadGlobalRuntimeConfig();
	let activeRuntimeConfig = activeWorkspacePath
		? await deps.loadRuntimeConfig(activeWorkspacePath)
		: globalRuntimeConfig;
	const workspacePathsById = new Map<string, string>(
		activeWorkspaceId && activeWorkspacePath ? [[activeWorkspaceId, activeWorkspacePath]] : [],
	);
	const projectTaskCountsByWorkspaceId = new Map<string, RuntimeProjectTaskCounts>();
	// ponytail: cache git origin per workspace — origin rarely changes and this runs on
	// every projects_updated broadcast, so we avoid spawning a git process each time.
	// Ceiling: a user re-pointing origin won't reflect until restart; add invalidation if
	// that ever matters.
	const gitRemoteOriginUrlByWorkspaceId = new Map<string, string | null>();
	const terminalManagersByWorkspaceId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();

	const rememberWorkspace = (workspaceId: string, repoPath: string): void => {
		workspacePathsById.set(workspaceId, repoPath);
	};

	const notifyTerminalManagerReady = (workspaceId: string, manager: TerminalSessionManager): void => {
		deps.onTerminalManagerReady?.(workspaceId, manager);
	};

	const getTerminalManagerForWorkspace = (workspaceId: string): TerminalSessionManager | null => {
		return terminalManagersByWorkspaceId.get(workspaceId) ?? null;
	};

	const ensureTerminalManagerForWorkspace = async (
		workspaceId: string,
		repoPath: string,
	): Promise<TerminalSessionManager> => {
		rememberWorkspace(workspaceId, repoPath);
		const existing = terminalManagersByWorkspaceId.get(workspaceId);
		if (existing) {
			notifyTerminalManagerReady(workspaceId, existing);
			return existing;
		}
		const pending = terminalManagerLoadPromises.get(workspaceId);
		if (pending) {
			const loaded = await pending;
			notifyTerminalManagerReady(workspaceId, loaded);
			return loaded;
		}
		const loading = (async () => {
			const manager = new TerminalSessionManager();
			try {
				const existingWorkspace = await loadWorkspaceState(repoPath);
				await backfillSessionAgentIdsFromBoard(workspaceId, existingWorkspace.sessions);
				manager.hydrateFromRecord(existingWorkspace.sessions);
			} catch {
				// Workspace state will be created on demand.
			}
			terminalManagersByWorkspaceId.set(workspaceId, manager);
			return manager;
		})().finally(() => {
			terminalManagerLoadPromises.delete(workspaceId);
		});
		terminalManagerLoadPromises.set(workspaceId, loading);
		const loaded = await loading;
		notifyTerminalManagerReady(workspaceId, loaded);
		return loaded;
	};

	const setActiveWorkspace = async (workspaceId: string, repoPath: string): Promise<void> => {
		activeWorkspaceId = workspaceId;
		activeWorkspacePath = repoPath;
		rememberWorkspace(workspaceId, repoPath);
		await ensureTerminalManagerForWorkspace(workspaceId, repoPath);
		activeRuntimeConfig = await deps.loadRuntimeConfig(repoPath);
		globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
	};

	const clearActiveWorkspace = (): void => {
		activeWorkspaceId = null;
		activeWorkspacePath = null;
		activeRuntimeConfig = globalRuntimeConfig;
	};

	const disposeWorkspace = (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const terminalManager = getTerminalManagerForWorkspace(workspaceId);
		if (terminalManager) {
			if (options?.stopTerminalSessions !== false) {
				terminalManager.markInterruptedAndStopAll();
			}
			terminalManagersByWorkspaceId.delete(workspaceId);
			terminalManagerLoadPromises.delete(workspaceId);
		}
		projectTaskCountsByWorkspaceId.delete(workspaceId);
		const workspacePath = workspacePathsById.get(workspaceId) ?? null;
		workspacePathsById.delete(workspaceId);
		return {
			terminalManager,
			workspacePath,
		};
	};

	// 一次性汇总单个 project 的三样数据（共用一次 board 加载 + listSummaries，零重复 I/O）：
	//   - taskCounts：套 live-session overlay 的计数（主看板/项目列表用）。
	//   - rawColumnTaskCounts：board 列归属的原始计数（Stage-First Overview 的 stage 计数用，见 ADR-0001）。
	//   - inProgressTaskDetails：in_progress 列 task 明细（Stage-First Overview 展开 In-Progress 用）。
	const summarizeProject = async (
		workspaceId: string,
	): Promise<{
		taskCounts: RuntimeProjectTaskCounts;
		rawColumnTaskCounts: RuntimeProjectTaskCounts;
		inProgressTaskDetails: RuntimeInProgressTaskDetail[];
	}> => {
		try {
			const board = await loadWorkspaceBoardById(workspaceId);
			const persistedCounts = countTasksByColumn(board);
			const terminalManager = getTerminalManagerForWorkspace(workspaceId);
			if (!terminalManager) {
				projectTaskCountsByWorkspaceId.set(workspaceId, persistedCounts);
				return {
					taskCounts: persistedCounts,
					rawColumnTaskCounts: persistedCounts,
					inProgressTaskDetails: collectInProgressTaskDetailsFromBoard(board, {}),
				};
			}
			const liveSessionsByTaskId: RuntimeWorkspaceStateResponse["sessions"] = {};
			for (const summary of terminalManager.listSummaries()) {
				liveSessionsByTaskId[summary.taskId] = summary;
			}
			const nextCounts = applyLiveSessionStateToProjectTaskCounts(persistedCounts, board, liveSessionsByTaskId);
			projectTaskCountsByWorkspaceId.set(workspaceId, nextCounts);
			return {
				taskCounts: nextCounts,
				rawColumnTaskCounts: persistedCounts,
				inProgressTaskDetails: collectInProgressTaskDetailsFromBoard(board, liveSessionsByTaskId),
			};
		} catch {
			const cached = projectTaskCountsByWorkspaceId.get(workspaceId) ?? createEmptyProjectTaskCounts();
			return { taskCounts: cached, rawColumnTaskCounts: cached, inProgressTaskDetails: [] };
		}
	};

	// 接口保留的薄封装（projects.add 快路径经此只取 overlay 计数；repoPath 参数留作签名兼容）。
	const summarizeProjectTaskCounts = async (
		workspaceId: string,
		_repoPath: string,
	): Promise<RuntimeProjectTaskCounts> => {
		return (await summarizeProject(workspaceId)).taskCounts;
	};

	const buildWorkspaceStateSnapshot = async (
		workspaceId: string,
		workspacePath: string,
	): Promise<RuntimeWorkspaceStateResponse> => {
		const response = await loadWorkspaceState(workspacePath);
		const terminalManager = await ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
		for (const summary of terminalManager.listSummaries()) {
			response.sessions[summary.taskId] = summary;
		}
		return response;
	};

	const resolveGitRemoteOriginUrl = async (workspaceId: string, repoPath: string): Promise<string | null> => {
		const cached = gitRemoteOriginUrlByWorkspaceId.get(workspaceId);
		if (cached !== undefined) {
			return cached;
		}
		const result = await runGit(repoPath, ["config", "--get", "remote.origin.url"]);
		const originUrl = result.ok && result.stdout ? result.stdout : null;
		gitRemoteOriginUrlByWorkspaceId.set(workspaceId, originUrl);
		return originUrl;
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		const projects = await listWorkspaceIndexEntries();
		const fallbackProjectId =
			projects.find((project) => project.workspaceId === activeWorkspaceId)?.workspaceId ??
			projects[0]?.workspaceId ??
			null;
		const resolvedCurrentProjectId =
			(preferredCurrentProjectId &&
				projects.some((project) => project.workspaceId === preferredCurrentProjectId) &&
				preferredCurrentProjectId) ||
			fallbackProjectId;
		const projectSummaries = await Promise.all(
			projects.map(async (project) => {
				const { taskCounts, rawColumnTaskCounts, inProgressTaskDetails } = await summarizeProject(
					project.workspaceId,
				);
				const gitRemoteOriginUrl = await resolveGitRemoteOriginUrl(project.workspaceId, project.repoPath);
				return toProjectSummary({
					workspaceId: project.workspaceId,
					repoPath: project.repoPath,
					taskCounts,
					rawColumnTaskCounts,
					inProgressTaskDetails,
					gitRemoteOriginUrl,
				});
			}),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
		};
	};

	const resolveWorkspaceForStream = async (
		requestedWorkspaceId: string | null,
		options?: {
			onRemovedWorkspace?: (workspace: RemovedWorkspaceNotice) => void;
		},
	): Promise<ResolvedWorkspaceStreamTarget> => {
		const allProjects = await listWorkspaceIndexEntries();
		const existingProjects: RuntimeWorkspaceIndexEntry[] = [];
		const removedProjects: RuntimeWorkspaceIndexEntry[] = [];

		for (const project of allProjects) {
			let removalMessage: string | null = null;
			if (!(await deps.pathIsDirectory(project.repoPath))) {
				removalMessage = `Project no longer exists on disk and was removed: ${project.repoPath}`;
			} else if (!deps.hasGitRepository(project.repoPath)) {
				removalMessage = `Project is not a git repository and was removed: ${project.repoPath}`;
			}

			if (!removalMessage) {
				existingProjects.push(project);
				continue;
			}

			removedProjects.push(project);
			await removeWorkspaceIndexEntry(project.workspaceId);
			await removeWorkspaceStateFiles(project.workspaceId);
			disposeWorkspace(project.workspaceId);
			options?.onRemovedWorkspace?.({
				workspaceId: project.workspaceId,
				repoPath: project.repoPath,
				message: removalMessage,
			});
		}

		const removedRequestedWorkspacePath = requestedWorkspaceId
			? (removedProjects.find((project) => project.workspaceId === requestedWorkspaceId)?.repoPath ?? null)
			: null;

		const activeWorkspaceMissing = !existingProjects.some((project) => project.workspaceId === activeWorkspaceId);
		if (activeWorkspaceMissing) {
			if (existingProjects[0]) {
				await setActiveWorkspace(existingProjects[0].workspaceId, existingProjects[0].repoPath);
			} else {
				clearActiveWorkspace();
			}
		}

		if (requestedWorkspaceId) {
			const requestedWorkspace = existingProjects.find((project) => project.workspaceId === requestedWorkspaceId);
			if (requestedWorkspace) {
				if (
					activeWorkspaceId !== requestedWorkspace.workspaceId ||
					activeWorkspacePath !== requestedWorkspace.repoPath
				) {
					await setActiveWorkspace(requestedWorkspace.workspaceId, requestedWorkspace.repoPath);
				}
				return {
					workspaceId: requestedWorkspace.workspaceId,
					workspacePath: requestedWorkspace.repoPath,
					removedRequestedWorkspacePath,
					didPruneProjects: removedProjects.length > 0,
				};
			}
		}

		const fallbackWorkspace =
			existingProjects.find((project) => project.workspaceId === activeWorkspaceId) ?? existingProjects[0] ?? null;
		if (!fallbackWorkspace) {
			return {
				workspaceId: null,
				workspacePath: null,
				removedRequestedWorkspacePath,
				didPruneProjects: removedProjects.length > 0,
			};
		}
		return {
			workspaceId: fallbackWorkspace.workspaceId,
			workspacePath: fallbackWorkspace.repoPath,
			removedRequestedWorkspacePath,
			didPruneProjects: removedProjects.length > 0,
		};
	};

	if (initialWorkspace) {
		await ensureTerminalManagerForWorkspace(initialWorkspace.workspaceId, initialWorkspace.repoPath);
	}

	return {
		getActiveWorkspaceId: () => activeWorkspaceId,
		getActiveWorkspacePath: () => activeWorkspacePath,
		getWorkspacePathById: (workspaceId: string) => workspacePathsById.get(workspaceId) ?? null,
		rememberWorkspace,
		getActiveRuntimeConfig: () => activeRuntimeConfig,
		setActiveRuntimeConfig: (config: RuntimeConfigState) => {
			globalRuntimeConfig = toGlobalRuntimeConfigState(config);
			activeRuntimeConfig = activeWorkspaceId ? config : globalRuntimeConfig;
		},
		loadScopedRuntimeConfig: async (scope: WorkspaceRegistryScope) => {
			if (scope.workspaceId === activeWorkspaceId) {
				return activeRuntimeConfig;
			}
			return await deps.loadRuntimeConfig(scope.workspacePath);
		},
		getTerminalManagerForWorkspace,
		ensureTerminalManagerForWorkspace,
		setActiveWorkspace,
		clearActiveWorkspace,
		disposeWorkspace,
		summarizeProjectTaskCounts,
		createProjectSummary: toProjectSummary,
		buildWorkspaceStateSnapshot,
		buildProjectsPayload,
		resolveWorkspaceForStream,
		listManagedWorkspaces: () => {
			return Array.from(terminalManagersByWorkspaceId.entries()).map(([workspaceId, terminalManager]) => ({
				workspaceId,
				workspacePath: workspacePathsById.get(workspaceId) ?? null,
				terminalManager,
			}));
		},
	};
}
