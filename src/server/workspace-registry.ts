import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeInProgressTaskDetail,
	RuntimeProjectAvailability,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
	RuntimeProjectUnavailableReason,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { deriveProjectDisplayNameFromRepoPath } from "../projects/project-display-name";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	type RuntimeWorkspaceIndexEntry,
} from "../state/workspace-state";
import { TerminalSessionManager } from "../terminal/session-manager";
import { runGit } from "../workspace/git-utils";
import { collectInProgressTaskDetailsFromBoard } from "./in-progress-task-detail-projection";
import { applyLiveSessionStateToProjectTaskCounts } from "./project-task-counts-live-session-overlay";
import { inspectRuntimeProjectAvailability } from "./runtime-project-availability";

export interface WorkspaceRegistryScope {
	workspaceId: string;
	workspacePath: string;
}

export interface CreateWorkspaceRegistryDependencies {
	cwd: string;
	loadGlobalRuntimeConfig: () => Promise<RuntimeConfigState>;
	loadRuntimeConfig: (cwd: string) => Promise<RuntimeConfigState>;
	hasGitRepository: (path: string) => boolean;
	inspectRuntimeProjectAvailability?: typeof inspectRuntimeProjectAvailability;
	onTerminalManagerReady?: (workspaceId: string, manager: TerminalSessionManager) => void;
}

export interface DisposeWorkspaceRegistryOptions {
	stopTerminalSessions?: boolean;
}

/**
 * `sessions.json` 只在 graceful shutdown 落盘。非优雅退出（进程被杀）会
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

export type ResolvedWorkspaceStreamTarget =
	| { status: "available"; projectId: string; workspacePath: string }
	| {
			status: "unavailable";
			projectId: string;
			workspacePath: string;
			reason: RuntimeProjectUnavailableReason;
	  }
	| { status: "no_registered_project"; projectId: null; workspacePath: null };

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
	buildProjectsPayloadUsingCachedRuntimeProjectAvailability: (preferredCurrentProjectId: string | null) => Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
	}>;
	resolveWorkspaceForStream: (requestedWorkspaceId: string | null) => Promise<ResolvedWorkspaceStreamTarget>;
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

function toProjectSummary(project: {
	workspaceId: string;
	repoPath: string;
	taskCounts: RuntimeProjectTaskCounts;
	// board 列归属的原始计数（未套 live-session overlay），供 Stage-First Overview 用。快路径可省略，
	// 下一次 projects_updated/snapshot 广播补齐（见 ADR-0001）。
	rawColumnTaskCounts?: RuntimeProjectTaskCounts;
	// in_progress 列 task 明细，供 Stage-First Overview 展开 In-Progress 阶段。快路径省略时默认空数组。
	inProgressTaskDetails?: RuntimeInProgressTaskDetail[];
	availability?: RuntimeProjectAvailability;
	// Optional so the `projects.add` fast path can omit it — origin is populated for real
	// on the next projects_updated/snapshot broadcast via buildProjectsPayload.
	gitRemoteOriginUrl?: string | null;
}): RuntimeProjectSummary {
	const name = deriveProjectDisplayNameFromRepoPath(project.repoPath);
	return {
		id: project.workspaceId,
		path: project.repoPath,
		name,
		taskCounts: project.taskCounts,
		availability: project.availability ?? { status: "available" },
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
	const runtimeProjectAvailabilityByWorkspaceId = new Map<
		string,
		{ repoPath: string; availability: RuntimeProjectAvailability }
	>();
	const terminalManagersByWorkspaceId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();

	const rememberWorkspace = (workspaceId: string, repoPath: string): void => {
		if (workspacePathsById.get(workspaceId) !== repoPath) {
			runtimeProjectAvailabilityByWorkspaceId.delete(workspaceId);
		}
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
				const existingWorkspace = await loadWorkspaceState(repoPath, { autoCreateIfMissing: false });
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
		runtimeProjectAvailabilityByWorkspaceId.delete(workspaceId);
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
		const response = await loadWorkspaceState(workspacePath, { autoCreateIfMissing: false });
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

	const inspectRuntimeProjectAvailabilityForRegistry =
		deps.inspectRuntimeProjectAvailability ?? inspectRuntimeProjectAvailability;

	const getRuntimeProjectAvailabilityUsingCache = async (
		workspaceId: string,
		repoPath: string,
	): Promise<RuntimeProjectAvailability> => {
		const cached = runtimeProjectAvailabilityByWorkspaceId.get(workspaceId);
		if (cached?.repoPath === repoPath) {
			return cached.availability;
		}
		const availability = await inspectRuntimeProjectAvailabilityForRegistry(repoPath);
		runtimeProjectAvailabilityByWorkspaceId.set(workspaceId, { repoPath, availability });
		return availability;
	};

	const refreshRuntimeProjectAvailabilityForRegisteredProjects = async (
		projects: Awaited<ReturnType<typeof listWorkspaceIndexEntries>>,
	): Promise<void> => {
		await Promise.all(
			projects.map(async (project) => {
				const availability = await inspectRuntimeProjectAvailabilityForRegistry(project.repoPath);
				runtimeProjectAvailabilityByWorkspaceId.set(project.workspaceId, {
					repoPath: project.repoPath,
					availability,
				});
			}),
		);
	};

	const buildProjectsPayloadFromRegisteredProjects = async (
		preferredCurrentProjectId: string | null,
		projects: Awaited<ReturnType<typeof listWorkspaceIndexEntries>>,
	) => {
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
				const availability = await getRuntimeProjectAvailabilityUsingCache(project.workspaceId, project.repoPath);
				const { taskCounts, rawColumnTaskCounts, inProgressTaskDetails } = await summarizeProject(
					project.workspaceId,
				);
				const gitRemoteOriginUrl =
					availability.status === "available"
						? await resolveGitRemoteOriginUrl(project.workspaceId, project.repoPath)
						: null;
				return toProjectSummary({
					workspaceId: project.workspaceId,
					repoPath: project.repoPath,
					taskCounts,
					rawColumnTaskCounts,
					inProgressTaskDetails,
					availability,
					gitRemoteOriginUrl,
				});
			}),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
		};
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		const projects = await listWorkspaceIndexEntries();
		await refreshRuntimeProjectAvailabilityForRegisteredProjects(projects);
		return await buildProjectsPayloadFromRegisteredProjects(preferredCurrentProjectId, projects);
	};

	const buildProjectsPayloadUsingCachedRuntimeProjectAvailability = async (
		preferredCurrentProjectId: string | null,
	) => {
		return await buildProjectsPayloadFromRegisteredProjects(
			preferredCurrentProjectId,
			await listWorkspaceIndexEntries(),
		);
	};

	const resolveWorkspaceForStream = async (
		requestedWorkspaceId: string | null,
	): Promise<ResolvedWorkspaceStreamTarget> => {
		const allProjects = await listWorkspaceIndexEntries();
		const requestedWorkspace = requestedWorkspaceId
			? allProjects.find((project) => project.workspaceId === requestedWorkspaceId)
			: null;
		const targetWorkspace =
			requestedWorkspace ??
			allProjects.find((project) => project.workspaceId === activeWorkspaceId) ??
			allProjects[0] ??
			null;
		if (!targetWorkspace) {
			return { status: "no_registered_project", projectId: null, workspacePath: null };
		}

		await refreshRuntimeProjectAvailabilityForRegisteredProjects(allProjects);
		const availability = await getRuntimeProjectAvailabilityUsingCache(
			targetWorkspace.workspaceId,
			targetWorkspace.repoPath,
		);
		if (availability.status === "unavailable") {
			return {
				status: "unavailable",
				projectId: targetWorkspace.workspaceId,
				workspacePath: targetWorkspace.repoPath,
				reason: availability.reason,
			};
		}

		if (activeWorkspaceId !== targetWorkspace.workspaceId || activeWorkspacePath !== targetWorkspace.repoPath) {
			await setActiveWorkspace(targetWorkspace.workspaceId, targetWorkspace.repoPath);
		}
		return {
			status: "available",
			projectId: targetWorkspace.workspaceId,
			workspacePath: targetWorkspace.repoPath,
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
		buildProjectsPayloadUsingCachedRuntimeProjectAvailability,
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
