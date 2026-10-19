import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeCrossProjectTaskSwitcherEntry,
	RuntimeInProgressTaskDetail,
	RuntimeProjectAvailability,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
	RuntimeProjectUnavailableReason,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS } from "../core/cross-project-recently-active-task-switcher-section-assignment";
import { getDefaultProjectVisualIdentity, type ProjectVisualIdentity } from "../core/project-visual-identity";
import { isNeverStartedPlaceholderTaskSessionSummary } from "../core/session-activity";
import { recordUserTerminalInputSubmissionObservedForSessionWithoutBlocking } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { deriveProjectDisplayNameFromRepoPath } from "../projects/project-display-name";
import {
	type PersistedAgentSessionReclamationDeadlineRecord,
	readAgentSessionReclamationDeadlineRecords,
} from "../state/agent-session-reclamation-deadline-store";
import { projectVisualIdentityStore } from "../state/project-visual-identity-store";
import { readTaskLastOpenedByUserAtByTaskId } from "../state/task-last-opened-by-user-record-store";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId,
	type RuntimeWorkspaceIndexEntry,
} from "../state/workspace-state";
import { createClaudeCodeBackgroundSessionDaemonCliClient } from "../terminal/claude-code-background-session-ownership-preflight-before-resume";
import { backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate } from "../terminal/cursor-agent-chat-identity-backfill-before-hydrate";
import { TerminalSessionManager } from "../terminal/session-manager";
import type {
	HostedTerminalPtyProcessSpawner,
	HostedTerminalPtySessionAdoptionCandidate,
} from "../terminal/terminal-pty-process-handle";
import { runGit } from "../workspace/git-utils";
import { collectCrossProjectTaskSwitcherEntriesFromBoard } from "./cross-project-task-switcher-entry-projection";
import {
	collectInProgressTaskDetailsFromBoardUsingTaskSessionFacts,
	extractTaskSessionFactsByTaskIdForCrossProjectTaskViews,
	extractTaskSessionFactsForCrossProjectTaskViews,
	type TaskSessionFactsForCrossProjectTaskViews,
} from "./in-progress-task-detail-projection";
import { createPersistedTaskSessionFactsCacheForUnloadedProjects } from "./persisted-task-session-facts-cache-for-unloaded-projects";
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
	// Cline SDK / ACP 会话不在 TerminalSessionManager 里，由 runtime-state-hub 订阅持有。跨项目视图
	// （in_progress 明细、跨项目切换面板）要覆盖全部三种 transport，故后绑定一个读口（hub 晚于 registry 创建）。
	listConversationTaskSessionSummariesForWorkspace?: (workspaceId: string) => RuntimeTaskSessionSummary[];
	// agent session PTY host 模式启用时提供：每个 workspace 的 TerminalSessionManager 经它把 PTY 交给 host 进程持有。
	createHostedTerminalPtyProcessSpawnerForWorkspace?: (
		workspaceId: string,
		workspaceRepositoryPath: string,
	) => HostedTerminalPtyProcessSpawner;
	// 热重启接管：该 workspace 在 PTY host 里仍有的会话（取走即消费）。在 terminal manager 首次加载时、
	// hydrate 之后立刻接管，保证接管先于任何浏览器连接（runtime 在接管全部完成后才 listen）。
	takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace?: (
		workspaceId: string,
	) => HostedTerminalPtySessionAdoptionCandidate[];
	// 测试注入用；缺省 Date.now。
	now?: () => number;
}

export interface DisposeWorkspaceRegistryOptions {
	stopTerminalSessions?: boolean;
}

/**
 * `sessions.json` 只在 graceful shutdown 与客户端 saveState 落盘。非优雅退出（系统重启 / 本地
 * redeploy / 进程被杀）会让 summary.agentId 丢成 null——要么盘上留着 agent 完全启动之前的默认快照，
 * 要么该 task 在盘上根本没有条目、由 `ensureEntry` 就地补一条全 null 的占位。
 *
 * summary.agentId===null 会同时击穿三条恢复路径：canRefresh（「重启终端会话」按钮禁用）、
 * refreshTaskTerminal 的 agentId gate、以及聚焦时的自动续跑判据，令任务彻底无法恢复（TUI 全白）。
 * 所以 hydrate 之前必须尽最大努力把它找回来。
 *
 * **曾经的错误假设**：这里原先写着「board card 才是该 task 用哪个 agent 的 durable 真相源」。
 * 对**没有显式选过 agent、走项目默认档**的卡片这句话不成立——`addTaskToColumn` 对这类卡片根本不写
 * `agentId` 字段（`...(input.agentId ? { agentId } : {})`），于是整个回填对它们是 no-op。这正是本 bug
 * 在 2026-07 那次修复之后仍然复发的原因。故本函数按可信度依次尝试三个 durable 源，缺一不可。
 *
 * **排序原则**：回填复原的是「一个已经存在过的会话是谁跑的」，不是「下一次该用谁启动」，所以对该会话的
 * **运行时观测事实**一律排在卡片上的**用户意图**之前（见下方各源注释）。
 *
 * 只回填、不覆盖已有 agentId；三个源都问不出结论时（无 card 的 shell / home / synthetic 会话）
 * 正确保留 null。
 */
export function backfillMissingSessionAgentIdsFromDurableSources(
	sources: {
		board: RuntimeBoardData;
		/** 该 workspace 的全部回收期限记录；读不到时传空数组即可，本函数不因此报错。 */
		agentSessionReclamationDeadlineRecords: readonly PersistedAgentSessionReclamationDeadlineRecord[];
	},
	sessions: RuntimeWorkspaceStateResponse["sessions"],
): void {
	const cardByTaskId = new Map<string, RuntimeBoardCard>();
	for (const column of sources.board.columns) {
		for (const card of column.cards) {
			cardByTaskId.set(card.id, card);
		}
	}
	for (const summary of Object.values(sessions)) {
		if (summary.agentId !== null) {
			continue;
		}
		const card = cardByTaskId.get(summary.taskId);
		summary.agentId =
			// 源 3（最优先）：runtime 在上一次会话**启动成功那一刻**记下的观测值，说的正是「这条丢了 agentId
			// 的 summary 所指的会话当时真的由谁跑起来」——与本字段要复原的东西同指一个会话。走项目默认档的
			// 卡片也只有这一条。
			card?.mostRecentlyLaunchedAgentSessionAgentId ??
			// 源 2：用户为这张卡做的 per-task 覆盖。它表达的是「下一次启动想用谁」的意图，可能还没有任何会话
			// 兑现过它，故只在观测值缺席（本字段上线前的存量卡片）时兜底。
			//
			// **为什么观测值必须压过用户意图**：`startTaskSession` 的 `shouldProbePersistedClineSession` 分支会在
			// `card.agentId` 仍是别的 agent 时探测到持久化的 Cline 会话并改走 Cline，真正跑起来的与卡片意图天然
			// 不一致（卡片上只有 `mostRecentlyLaunchedAgentSessionAgentId` 记下了这个事实）。此时若让 card.agentId
			// 胜出，重启后会把一个 Cline 会话标成 PTY agent：详情页分流、canRefresh、自动续跑判据全部走错分支；
			// 更糟的是 `previousTerminalAgentId` 不再是 null，会连那条 Cline 探针分支一起跳过——**填错比留 null
			// 更坏**。同理，用户改了卡片 agent 但尚未重启时，既存会话的身份也仍是上一次跑起来的那个。
			card?.agentId ??
			// 源 4：回收期限记录。它是本修复上线**之前**就已损坏的存量任务唯一的回血通道——源 3 是新写的，
			// 老卡片上不会有，而这些任务的回收记录里完好保存着 agentId。
			resolveMostRecentAgentSessionReclamationDeadlineRecordAgentId(
				sources.agentSessionReclamationDeadlineRecords,
				summary.taskId,
			);
	}
}

/**
 * 取该 task 最近一条回收期限记录里的 agentId。
 *
 * 刻意**不**用 `findLiveAgentSessionReclamationDeadlineRecord`（只认 live 状态）：`agentId` 是记录的必备
 * 字段，在 `reclaimed` / `superseded` 这些终态里同样保留，它是历史事实、不随状态失效。用「不限状态」还
 * 让本回填与「把超期 live 记录推进到终态」的对账彻底解耦——否则对账一跑，回血源就被掐死了。
 */
function resolveMostRecentAgentSessionReclamationDeadlineRecordAgentId(
	records: readonly PersistedAgentSessionReclamationDeadlineRecord[],
	taskId: string,
): RuntimeAgentId | null {
	let mostRecentRecord: PersistedAgentSessionReclamationDeadlineRecord | null = null;
	for (const record of records) {
		if (record.taskId !== taskId || record.agentId === null) {
			continue;
		}
		// `updatedAt` 相等时必须取**数组中更靠后**的那条（故意用 `>=` 而非 `>`）。
		// 理由在写入侧：`recordAgentSessionRetentionDeadline` 追加新记录时，会用同一个 `recordedAt`
		// 同时把该 task 既有 live 记录置为 `superseded`、并把新记录 push 到数组末尾——于是「旧记录被作废」
		// 与「新记录诞生」共享一个时间戳，`updatedAt` 无法区分先后，只剩数组次序还保留着因果顺序。
		// 此时更靠后的那条才是刚落地的当前记录，它的 agentId 才是该 task 最新在用的 harness；
		// 取更靠前的那条会回填成换 agent 之前的旧 harness，把存量损坏任务恢复错。
		if (!mostRecentRecord || record.updatedAt >= mostRecentRecord.updatedAt) {
			mostRecentRecord = record;
		}
	}
	return mostRecentRecord?.agentId ?? null;
}

async function backfillSessionAgentIdsBeforeHydrate(
	workspaceId: string,
	sessions: RuntimeWorkspaceStateResponse["sessions"],
): Promise<void> {
	let board: RuntimeBoardData;
	try {
		board = await loadWorkspaceBoardById(workspaceId);
	} catch {
		return;
	}
	// 回收记录读不出来只损失第四个源，不该连累前两个源的回填。
	const agentSessionReclamationDeadlineRecords = await readAgentSessionReclamationDeadlineRecords(workspaceId).catch(
		() => [] as PersistedAgentSessionReclamationDeadlineRecord[],
	);
	backfillMissingSessionAgentIdsFromDurableSources({ board, agentSessionReclamationDeadlineRecords }, sessions);
}

// 存量 Cursor 会话的身份回填 / 「从未建立对话」校正（规则与政策例外见被调模块的文件头）。看板读不出来就整体跳过：
// 「只动看板上确有其卡的会话」是这道回填不碰幽灵副本的唯一凭据，没有它宁可不做。
async function backfillCursorAgentChatIdentityBeforeHydrate(
	workspaceId: string,
	sessions: RuntimeWorkspaceStateResponse["sessions"],
): Promise<void> {
	let board: RuntimeBoardData;
	try {
		board = await loadWorkspaceBoardById(workspaceId);
	} catch {
		return;
	}
	// 回填是锦上添花，绝不能连累 hydrate：调用方的 catch 会把任何异常当成「workspace 状态不存在」，整批会话都不水合。
	try {
		await backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate({
			sessions,
			taskIdsOnWorkspaceBoard: new Set(board.columns.flatMap((column) => column.cards.map((card) => card.id))),
			currentTimeEpochMs: Date.now(),
		});
	} catch {
		// 回填失败 ⇒ 会话维持原样，下次续跑时的预检仍会按同一套规则判定。
	}
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
	// 跨项目切换面板「显示更早」：按给定时间窗现算全部项目的条目，不进广播。
	listCrossProjectTaskSwitcherEntriesForAllProjectsWithinActivityHorizon: (
		activityHorizonMs: number,
	) => Promise<
		Array<{ workspaceId: string; crossProjectTaskSwitcherEntries: RuntimeCrossProjectTaskSwitcherEntry[] }>
	>;
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
	visualIdentity?: ProjectVisualIdentity;
	taskCounts: RuntimeProjectTaskCounts;
	// board 列归属的原始计数（未套 live-session overlay）。原供已退役的 Stage-First Overview，现无前端消费者，
	// 为兼容旧 bundle 暂留（ADR-0001，已 Superseded）。快路径可省略，下一次 projects_updated/snapshot 广播补齐。
	rawColumnTaskCounts?: RuntimeProjectTaskCounts;
	// in_progress 列 task 明细，供顶栏项目切换器数 live agent。快路径省略时默认空数组。
	inProgressTaskDetails?: RuntimeInProgressTaskDetail[];
	// 跨项目切换面板条目。快路径省略时默认空数组，下一次广播补齐。
	crossProjectTaskSwitcherEntries?: RuntimeCrossProjectTaskSwitcherEntry[];
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
		visualIdentity: project.visualIdentity ?? getDefaultProjectVisualIdentity(project.workspaceId, name),
		taskCounts: project.taskCounts,
		availability: project.availability ?? { status: "available" },
		...(project.rawColumnTaskCounts ? { rawColumnTaskCounts: project.rawColumnTaskCounts } : {}),
		inProgressTaskDetails: project.inProgressTaskDetails ?? [],
		crossProjectTaskSwitcherEntries: project.crossProjectTaskSwitcherEntries ?? [],
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
	const persistedTaskSessionFactsCacheForUnloadedProjects = createPersistedTaskSessionFactsCacheForUnloadedProjects();
	const now = deps.now ?? Date.now;
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
			const manager = new TerminalSessionManager({
				hostedTerminalPtyProcessSpawner: deps.createHostedTerminalPtyProcessSpawnerForWorkspace?.(
					workspaceId,
					repoPath,
				),
				onUserTerminalInputSubmissionObservedForSession: (kanbanTaskConversationSessionId) =>
					recordUserTerminalInputSubmissionObservedForSessionWithoutBlocking({
						workspaceId,
						kanbanTaskConversationSessionId,
					}),
				persistAgentNativeConversationSessionIdentityImmediately: async (
					kanbanTaskConversationSessionId,
					readCurrentSessionSummary,
				) => {
					await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
						workspaceId,
						kanbanTaskConversationSessionId,
						readCurrentSessionSummary,
					);
				},
				claudeCodeBackgroundSessionDaemonClient: createClaudeCodeBackgroundSessionDaemonCliClient(),
			});
			const hostedTerminalPtySessionAdoptionCandidates =
				deps.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace?.(workspaceId) ?? [];
			try {
				const existingWorkspace = await loadWorkspaceState(repoPath, { autoCreateIfMissing: false });
				await backfillSessionAgentIdsBeforeHydrate(workspaceId, existingWorkspace.sessions);
				// 排在 agentId 回填之后：它只处理 agentId 已是 cursor 的会话，agentId 被修好的存量会话也该被覆盖到。
				await backfillCursorAgentChatIdentityBeforeHydrate(workspaceId, existingWorkspace.sessions);
				manager.hydrateFromRecord(
					existingWorkspace.sessions,
					new Set(hostedTerminalPtySessionAdoptionCandidates.map((candidate) => candidate.taskId)),
				);
			} catch {
				// Workspace state will be created on demand.
			}
			if (hostedTerminalPtySessionAdoptionCandidates.length > 0) {
				await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart(hostedTerminalPtySessionAdoptionCandidates);
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
		persistedTaskSessionFactsCacheForUnloadedProjects.forgetWorkspace(workspaceId);
		const workspacePath = workspacePathsById.get(workspaceId) ?? null;
		workspacePathsById.delete(workspaceId);
		return {
			terminalManager,
			workspacePath,
		};
	};

	// 单个 project 的 board + 全部三种 transport 的会话事实 + 「我最后打开」。in_progress 明细、跨项目切换面板
	// 条目、「显示更早」查询共用这一份读取，不各自拼一遍会话来源。
	//   - 已加载项目：TerminalSessionManager（已 hydrate 盘上记录）+ Cline SDK / ACP 会话叠加（后写覆盖先写，
	//     与 runtime-server 的 listProjectRuntimeSessionSummaries 同序）。
	//   - 未加载项目：sessions.json 的 mtime 缓存（见 persisted-task-session-facts-cache-for-unloaded-projects.ts）+
	//     同样的会话叠加。
	const loadProjectBoardAndTaskSessionFacts = async (
		workspaceId: string,
	): Promise<{
		board: RuntimeBoardData;
		terminalManagerSessionsByTaskId: RuntimeWorkspaceStateResponse["sessions"] | null;
		sessionFactsByTaskId: Map<string, TaskSessionFactsForCrossProjectTaskViews>;
		lastOpenedByUserAtByTaskId: ReadonlyMap<string, number>;
	}> => {
		const board = await loadWorkspaceBoardById(workspaceId);
		const terminalManager = getTerminalManagerForWorkspace(workspaceId);
		let terminalManagerSessionsByTaskId: RuntimeWorkspaceStateResponse["sessions"] | null = null;
		let sessionFactsByTaskId: Map<string, TaskSessionFactsForCrossProjectTaskViews>;
		if (terminalManager) {
			terminalManagerSessionsByTaskId = {};
			for (const summary of terminalManager.listSummaries()) {
				terminalManagerSessionsByTaskId[summary.taskId] = summary;
			}
			sessionFactsByTaskId = extractTaskSessionFactsByTaskIdForCrossProjectTaskViews(
				Object.values(terminalManagerSessionsByTaskId),
			);
		} else {
			sessionFactsByTaskId = new Map(
				await persistedTaskSessionFactsCacheForUnloadedProjects.loadTaskSessionFactsByTaskId(workspaceId),
			);
		}
		for (const summary of deps.listConversationTaskSessionSummariesForWorkspace?.(workspaceId) ?? []) {
			sessionFactsByTaskId.set(summary.taskId, extractTaskSessionFactsForCrossProjectTaskViews(summary));
		}
		const lastOpenedByUserAtByTaskId = await readTaskLastOpenedByUserAtByTaskId(workspaceId).catch(
			() => new Map<string, number>(),
		);
		return { board, terminalManagerSessionsByTaskId, sessionFactsByTaskId, lastOpenedByUserAtByTaskId };
	};

	// 一次性汇总单个 project 的四样数据（共用一次 loadProjectBoardAndTaskSessionFacts，零重复 I/O）：
	//   - taskCounts：套 live-session overlay 的计数（主看板/项目列表用）。
	//   - rawColumnTaskCounts：board 列归属的原始计数（已无前端消费者，为兼容旧 bundle 暂留，见 ADR-0001 的 Superseded 说明）。
	//   - inProgressTaskDetails：in_progress 列 task 明细（顶栏项目切换器的 live 计数用）。
	//   - crossProjectTaskSwitcherEntries：跨项目切换面板条目（同一个 per-card 构造函数，取景不同）。
	const summarizeProject = async (
		workspaceId: string,
	): Promise<{
		taskCounts: RuntimeProjectTaskCounts;
		rawColumnTaskCounts: RuntimeProjectTaskCounts;
		inProgressTaskDetails: RuntimeInProgressTaskDetail[];
		crossProjectTaskSwitcherEntries: RuntimeCrossProjectTaskSwitcherEntry[];
	}> => {
		try {
			const { board, terminalManagerSessionsByTaskId, sessionFactsByTaskId, lastOpenedByUserAtByTaskId } =
				await loadProjectBoardAndTaskSessionFacts(workspaceId);
			const persistedCounts = countTasksByColumn(board);
			// 计数 overlay 仍只看 terminal manager 的 summary（未加载项目退化为原始列计数），与改动前一致。
			const taskCounts = terminalManagerSessionsByTaskId
				? applyLiveSessionStateToProjectTaskCounts(persistedCounts, board, terminalManagerSessionsByTaskId)
				: persistedCounts;
			projectTaskCountsByWorkspaceId.set(workspaceId, taskCounts);
			return {
				taskCounts,
				rawColumnTaskCounts: persistedCounts,
				inProgressTaskDetails: collectInProgressTaskDetailsFromBoardUsingTaskSessionFacts(
					board,
					sessionFactsByTaskId,
				),
				crossProjectTaskSwitcherEntries: collectCrossProjectTaskSwitcherEntriesFromBoard({
					board,
					sessionFactsByTaskId,
					lastOpenedByUserAtByTaskId,
					nowMs: now(),
					activityHorizonMs: CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
				}),
			};
		} catch {
			const cached = projectTaskCountsByWorkspaceId.get(workspaceId) ?? createEmptyProjectTaskCounts();
			return {
				taskCounts: cached,
				rawColumnTaskCounts: cached,
				inProgressTaskDetails: [],
				crossProjectTaskSwitcherEntries: [],
			};
		}
	};

	const listCrossProjectTaskSwitcherEntriesForAllProjectsWithinActivityHorizon = async (
		activityHorizonMs: number,
	): Promise<
		Array<{ workspaceId: string; crossProjectTaskSwitcherEntries: RuntimeCrossProjectTaskSwitcherEntry[] }>
	> => {
		const projects = await listWorkspaceIndexEntries();
		const nowMs = now();
		return await Promise.all(
			projects.map(async (project) => {
				try {
					const { board, sessionFactsByTaskId, lastOpenedByUserAtByTaskId } =
						await loadProjectBoardAndTaskSessionFacts(project.workspaceId);
					return {
						workspaceId: project.workspaceId,
						crossProjectTaskSwitcherEntries: collectCrossProjectTaskSwitcherEntriesFromBoard({
							board,
							sessionFactsByTaskId,
							lastOpenedByUserAtByTaskId,
							nowMs,
							activityHorizonMs,
						}),
					};
				} catch {
					return { workspaceId: project.workspaceId, crossProjectTaskSwitcherEntries: [] };
				}
			}),
		);
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
			// 活体 summary 通常比盘上那条新，但有一种例外必须挡住：前端一聚焦某张卡，`ensureEntry` 就会
			// 就地造出一条全 null 的占位 summary。让它盖掉盘上记着 agentId / startedAt 的记录，等于把
			// 「重启就能自愈」的中断变成永久损坏（TUI 全白 + 「重启终端会话」灰掉）。
			if (
				isNeverStartedPlaceholderTaskSessionSummary(summary) &&
				response.sessions[summary.taskId] &&
				!isNeverStartedPlaceholderTaskSessionSummary(response.sessions[summary.taskId])
			) {
				continue;
			}
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
				const { taskCounts, rawColumnTaskCounts, inProgressTaskDetails, crossProjectTaskSwitcherEntries } =
					await summarizeProject(project.workspaceId);
				const gitRemoteOriginUrl =
					availability.status === "available"
						? await resolveGitRemoteOriginUrl(project.workspaceId, project.repoPath)
						: null;
				return toProjectSummary({
					workspaceId: project.workspaceId,
					repoPath: project.repoPath,
					visualIdentity: await projectVisualIdentityStore.read(
						project.workspaceId,
						deriveProjectDisplayNameFromRepoPath(project.repoPath),
					),
					taskCounts,
					rawColumnTaskCounts,
					inProgressTaskDetails,
					crossProjectTaskSwitcherEntries,
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
		listCrossProjectTaskSwitcherEntriesForAllProjectsWithinActivityHorizon,
		listManagedWorkspaces: () => {
			return Array.from(terminalManagersByWorkspaceId.entries()).map(([workspaceId, terminalManager]) => ({
				workspaceId,
				workspacePath: workspacePathsById.get(workspaceId) ?? null,
				terminalManager,
			}));
		},
	};
}
