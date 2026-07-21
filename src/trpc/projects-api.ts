import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import pLimit from "p-limit";
import type {
	RuntimeAllProjectsTaskSearchIndexResponse,
	RuntimeDirectoryListResponse,
	RuntimeProjectAddResponse,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import {
	parseDirectoryListRequest,
	parseProjectAddRequest,
	parseProjectPermanentDeletionPreviewRequest,
	parseProjectPermanentDeletionRequest,
} from "../core/api-validation";
import { deriveProjectDisplayNameFromRepoPath } from "../projects/project-display-name";
import type { ActiveRuntimeSessionShutdownResult } from "../server/active-runtime-session-shutdown";
import {
	type AllProjectsTaskSearchIndexProjectInput,
	projectAllProjectsTaskSearchIndex,
} from "../server/all-projects-task-search-index-projection";
import { createConfirmedProjectPermanentDeletionService } from "../server/confirmed-project-permanent-deletion";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceContextById,
} from "../state/workspace-state";
import { cloneGitRepository } from "../workspace/git-clone";
import { ensureInitialCommit, initializeGitRepository } from "../workspace/initialize-repo";
import { isPathWithinRoot } from "../workspace/path-sandbox";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateProjectsApiDependencies {
	getActiveWorkspacePath: () => string | null;
	getActiveWorkspaceId: () => string | null;
	rememberWorkspace: (workspaceId: string, repoPath: string) => void;
	setActiveWorkspace: (workspaceId: string, repoPath: string) => Promise<void>;
	clearActiveWorkspace: () => void;
	resolveProjectInputPath: (inputPath: string, cwd: string) => string;
	assertPathIsDirectory: (path: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	summarizeProjectTaskCounts: (workspaceId: string, repoPath: string) => Promise<RuntimeProjectTaskCounts>;
	createProjectSummary: (project: {
		workspaceId: string;
		repoPath: string;
		taskCounts: RuntimeProjectTaskCounts;
	}) => RuntimeProjectSummary;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	listProjectRuntimeSessionSummaries: (workspaceId: string) => RuntimeTaskSessionSummary[];
	stopAndCollectProjectRuntimeSessionsForSafePersistence: (
		workspaceId: string,
	) => Promise<ActiveRuntimeSessionShutdownResult>;
	disposeProjectRuntime: (workspaceId: string) => Promise<void>;
	warn: (message: string) => void;
	buildProjectsPayload: (preferredCurrentProjectId: string | null) => Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
	}>;
	pickDirectoryPathFromSystemDialog: () => string | null;
	serverCwd: string;
}

/**
 * 跨项目任务搜索索引构建时，逐项目加载 board 的**并发上限**（保守小常数，可调）。
 *
 * 动机：`getAllProjectsTaskSearchIndex` 对 `listWorkspaceIndexEntries()` 返回的**全部**注册项目直接
 * `Promise.all(entries.map(loadWorkspaceBoardById))`。每个 `loadWorkspaceBoardById` 会读盘（sessions/meta
 * 的 `readFile`）并在主线程 `JSON.parse`。项目/board 数增长时，这个 fan-out 的并发会**随项目数线性增长**，
 * 在同一 tick 里同步触发 N 次 fs 读 + N 次大块 JSON.parse，短时占满 Node 单事件循环主线程。
 *
 * 参照 `src/workspace/git-concurrency.ts` / `src/server/workspace-metadata-monitor.ts` 的既有模式：把逐项目
 * board 加载钳进一个**跨所有请求共享的模块级 p-limit 单例**，使任意负载下的并发 board 读取恒为常数、不再随
 * 项目数增长。共享是关键——即便多个 tRPC 请求同时各自 fan-out，总并发也被钳成 WORKSPACE_BOARD_LOAD_CONCURRENCY_LIMIT。
 */
const WORKSPACE_BOARD_LOAD_CONCURRENCY_LIMIT = 8;

const workspaceBoardLoadConcurrencyLimiter = pLimit(WORKSPACE_BOARD_LOAD_CONCURRENCY_LIMIT);

export function createProjectsApi(deps: CreateProjectsApiDependencies): RuntimeTrpcContext["projectsApi"] {
	const filesystemRoot = resolve(deps.serverCwd, "/");
	const confirmedProjectPermanentDeletionService = createConfirmedProjectPermanentDeletionService({
		getActiveWorkspaceId: deps.getActiveWorkspaceId,
		setActiveWorkspace: deps.setActiveWorkspace,
		clearActiveWorkspace: deps.clearActiveWorkspace,
		listProjectRuntimeSessionSummaries: deps.listProjectRuntimeSessionSummaries,
		stopAndCollectProjectRuntimeSessionsForSafePersistence:
			deps.stopAndCollectProjectRuntimeSessionsForSafePersistence,
		disposeProjectRuntime: deps.disposeProjectRuntime,
		broadcastRuntimeProjectsUpdated: deps.broadcastRuntimeProjectsUpdated,
		warn: deps.warn,
	});

	return {
		listProjects: async (preferredWorkspaceId) => {
			const payload = await deps.buildProjectsPayload(preferredWorkspaceId);
			return {
				currentProjectId: payload.currentProjectId,
				projects: payload.projects,
			};
		},
		addProject: async (preferredWorkspaceId, input) => {
			const body = parseProjectAddRequest(input);
			const preferredWorkspaceContext = preferredWorkspaceId
				? await loadWorkspaceContextById(preferredWorkspaceId)
				: null;
			const resolveBasePath = preferredWorkspaceContext?.repoPath ?? deps.getActiveWorkspacePath() ?? process.cwd();
			try {
				let projectPath: string;
				if (body.gitUrl) {
					// Clone from Git URL. If a custom path is provided alongside
					// gitUrl, use it as the clone destination. Otherwise derive
					// a destination from the URL.
					// Resolve relative to serverCwd (the default clone base), not the
					// active project — the clone target belongs under the kanban
					// working directory, not inside another project.
					const customDest = body.path ? deps.resolveProjectInputPath(body.path, deps.serverCwd) : undefined;
					const cloneResult = await cloneGitRepository(body.gitUrl, deps.serverCwd, customDest, filesystemRoot);
					if (!cloneResult.ok) {
						return {
							ok: false,
							project: null,
							error: cloneResult.error ?? "Git clone failed.",
						} satisfies RuntimeProjectAddResponse;
					}
					projectPath = cloneResult.clonedPath;
				} else {
					// path is guaranteed to exist here by the schema refine and the gitUrl branch above.
					projectPath = deps.resolveProjectInputPath(body.path as string, resolveBasePath);
				}
				await deps.assertPathIsDirectory(projectPath);
				if (!deps.hasGitRepository(projectPath)) {
					if (!body.initializeGit) {
						return {
							ok: false,
							project: null,
							requiresGitInitialization: true,
							error: "This folder is not a git repository. Cline requires git to manage worktrees. Initialize git to continue.",
						} satisfies RuntimeProjectAddResponse;
					}
					const initResult = await initializeGitRepository(projectPath);
					if (!initResult.ok) {
						return {
							ok: false,
							project: null,
							error: initResult.error ?? "Failed to initialize git repository.",
						} satisfies RuntimeProjectAddResponse;
					}
				} else {
					const commitResult = await ensureInitialCommit(projectPath);
					if (!commitResult.ok) {
						return {
							ok: false,
							project: null,
							error: commitResult.error ?? "Failed to ensure initial commit.",
						} satisfies RuntimeProjectAddResponse;
					}
				}
				const context = await loadWorkspaceContext(projectPath);
				deps.rememberWorkspace(context.workspaceId, context.repoPath);
				const projectsAfterAdd = await listWorkspaceIndexEntries();
				const activeWorkspaceId = deps.getActiveWorkspaceId();
				const hasActiveWorkspace = activeWorkspaceId
					? projectsAfterAdd.some((project) => project.workspaceId === activeWorkspaceId)
					: false;
				if (!hasActiveWorkspace) {
					await deps.setActiveWorkspace(context.workspaceId, context.repoPath);
				}
				const taskCounts = await deps.summarizeProjectTaskCounts(context.workspaceId, context.repoPath);
				void deps.broadcastRuntimeProjectsUpdated(context.workspaceId);
				return {
					ok: true,
					project: deps.createProjectSummary({
						workspaceId: context.workspaceId,
						repoPath: context.repoPath,
						taskCounts,
					}),
				} satisfies RuntimeProjectAddResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					project: null,
					error: message,
				} satisfies RuntimeProjectAddResponse;
			}
		},
		getPermanentDeletionPreview: async (_preferredWorkspaceId, input) => {
			const body = parseProjectPermanentDeletionPreviewRequest(input);
			return await confirmedProjectPermanentDeletionService.getPermanentDeletionPreview(body);
		},
		permanentlyDeleteProjectData: async (_preferredWorkspaceId, input) => {
			const body = parseProjectPermanentDeletionRequest(input);
			return await confirmedProjectPermanentDeletionService.permanentlyDeleteProjectData(body);
		},
		pickProjectDirectory: async () => {
			try {
				const selectedPath = deps.pickDirectoryPathFromSystemDialog();
				if (!selectedPath) {
					return {
						ok: false,
						path: null,
						error: "No directory was selected.",
					};
				}
				return {
					ok: true,
					path: selectedPath,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					path: null,
					error: message,
				};
			}
		},
		listDirectoryContents: async (_preferredWorkspaceId, input) => {
			const body = parseDirectoryListRequest(input);
			const rootPath = filesystemRoot;
			const requestedPath = body.path?.trim() || "";
			// Reject absolute paths that fall outside the sandbox
			if (requestedPath && isAbsolute(requestedPath)) {
				if (!isPathWithinRoot(rootPath, requestedPath)) {
					return {
						ok: false,
						currentPath: rootPath,
						parentPath: null,
						rootPath,
						entries: [],
						error: "Access denied: absolute path is outside the server root directory.",
					} satisfies RuntimeDirectoryListResponse;
				}
				// Absolute path is within sandbox — fall through to existing stat/readdir logic
			}
			const resolvedPath = resolve(rootPath, requestedPath) || rootPath;

			if (!isPathWithinRoot(rootPath, resolvedPath)) {
				return {
					ok: false,
					currentPath: rootPath,
					parentPath: null,
					rootPath,
					entries: [],
					error: "Access denied: path is outside the server root directory.",
				} satisfies RuntimeDirectoryListResponse;
			}

			try {
				const dirStat = await stat(resolvedPath);
				if (!dirStat.isDirectory()) {
					return {
						ok: false,
						currentPath: resolvedPath,
						parentPath: null,
						rootPath,
						entries: [],
						error: "The specified path is not a directory.",
					} satisfies RuntimeDirectoryListResponse;
				}

				const dirEntries = await readdir(resolvedPath, { withFileTypes: true });
				const directoryEntries = dirEntries.filter((entry) => {
					if (!entry.isDirectory()) {
						return false;
					}
					if (entry.name.startsWith(".")) {
						return false;
					}
					return true;
				});

				directoryEntries.sort((a, b) => a.name.localeCompare(b.name));

				const entries = await Promise.all(
					directoryEntries.map(async (entry) => {
						const entryPath = resolve(resolvedPath, entry.name);
						let isGitRepository = false;
						try {
							const gitDirStat = await stat(resolve(entryPath, ".git"));
							isGitRepository = gitDirStat.isDirectory() || gitDirStat.isFile();
						} catch {
							// .git does not exist or is not accessible
						}
						return {
							name: entry.name,
							path: entryPath,
							isGitRepository,
						};
					}),
				);

				const isAtRoot = resolvedPath === rootPath;
				const rawParent = dirname(resolvedPath);
				const parentIsWithinRoot = isPathWithinRoot(rootPath, rawParent);
				const parentPath = isAtRoot ? null : parentIsWithinRoot ? rawParent : null;

				return {
					ok: true,
					currentPath: resolvedPath,
					parentPath,
					rootPath,
					entries,
				} satisfies RuntimeDirectoryListResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const isPermissionError =
					error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EACCES";
				const isNotFoundError =
					error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
				return {
					ok: false,
					currentPath: resolvedPath,
					parentPath: null,
					rootPath,
					entries: [],
					error: isPermissionError
						? "Permission denied: cannot read this directory."
						: isNotFoundError
							? "Directory not found."
							: message,
				} satisfies RuntimeDirectoryListResponse;
			}
		},
		getAllProjectsTaskSearchIndex: async (): Promise<RuntimeAllProjectsTaskSearchIndexResponse> => {
			const entries = await listWorkspaceIndexEntries();
			const projectInputs = await Promise.all(
				entries.map(
					(entry): Promise<AllProjectsTaskSearchIndexProjectInput> =>
						// 逐项目 board 加载经共享的模块级 p-limit 单例钳流，避免项目数增长时无界并发读盘 + 主线程 JSON.parse
						// 停摆事件循环（参见 WORKSPACE_BOARD_LOAD_CONCURRENCY_LIMIT 的动机说明）。
						workspaceBoardLoadConcurrencyLimiter(async () => {
							const projectName = deriveProjectDisplayNameFromRepoPath(entry.repoPath);
							try {
								const board = await loadWorkspaceBoardById(entry.workspaceId);
								return { projectId: entry.workspaceId, projectName, board };
							} catch (error) {
								// 单个项目读盘失败（盘损坏 / 迁移中等）不阻断整体索引：跳过该项目。
								deps.warn(
									`Failed to load board for cross-project task search index (workspace ${entry.workspaceId}): ${
										error instanceof Error ? error.message : String(error)
									}`,
								);
								return { projectId: entry.workspaceId, projectName, board: null };
							}
						}),
				),
			);
			return projectAllProjectsTaskSearchIndex(projectInputs);
		},
	};
}
