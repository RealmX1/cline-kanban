import { stat } from "node:fs/promises";
import { createParsedPersistedJsonFileReadCache } from "../state/parsed-persisted-json-file-read-cache";
import {
	getPersistedWorkspaceSessionsFilePathById,
	loadPersistedWorkspaceSessionsById,
} from "../state/workspace-state";
import { reconstructTaskSessionSummaryFromPersistedRecordWithoutLiveAgentProcess } from "../terminal/session-manager";
import {
	extractTaskSessionFactsForCrossProjectTaskViews,
	type TaskSessionFactsForCrossProjectTaskViews,
} from "./in-progress-task-detail-projection";

// 本次 runtime 启动后还没被打开过的项目（没有 TerminalSessionManager）的会话事实，读自 sessions.json。
//
// 为什么要缓存：projects_updated 在任何 agent 输出期间每 150ms 广播一次、每次覆盖全部项目；而 sessions.json
// 本机合计约 31 MB、单个最大 2.8 MB。未加载项目的这个文件几乎不变（只在 graceful shutdown 与浏览器
// saveState 时写），宽松 UI 路径保留 (mtimeMs, size) 缓存；严格查询改用含文件身份和 ctime 的指纹。
// 缓存里只留 TaskSessionFactsForCrossProjectTaskViews 的几个字段，不留整条 summary。
//
// 状态口径与「项目被打开时 TerminalSessionManager.hydrateFromRecord 重建出来的样子」一致（共用
// reconstructTaskSessionSummaryFromPersistedRecordWithoutLiveAgentProcess）。额外一条：没有 terminal manager 的项目
// 在本 runtime 里不可能有活的 PTY 进程，而 Cline SDK / ACP 的活会话会由调用方从会话服务叠加上去，所以盘上
// 残留的「agent 正持有回合」一律不当真——否则 Running 区会出现一个重启前就已经死掉的任务。

export interface PersistedTaskSessionFactsCacheForUnloadedProjects {
	loadTaskSessionFactsByTaskId: (
		workspaceId: string,
		options?: { requireCompleteRead?: boolean },
	) => Promise<ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>>;
	forgetWorkspace: (workspaceId: string) => void;
}

const EMPTY_TASK_SESSION_FACTS_BY_TASK_ID: ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews> = new Map();

function demoteUnclaimableAgentTurnForProjectWithoutLiveRuntime(
	sessionFacts: TaskSessionFactsForCrossProjectTaskViews,
): TaskSessionFactsForCrossProjectTaskViews {
	if (sessionFacts.turnOwner !== "agent") {
		return sessionFacts;
	}
	return { ...sessionFacts, turnOwner: null, liveness: "none", userTurnKind: null };
}

export function createPersistedTaskSessionFactsCacheForUnloadedProjects(): PersistedTaskSessionFactsCacheForUnloadedProjects {
	// 完整性读取使用包含 inode/ctime 的文件指纹，并与宽松 UI 的旧缓存和回退隔离。
	const completeTaskSessionFactsReadCache =
		createParsedPersistedJsonFileReadCache<ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>>();
	const cachedByWorkspaceId = new Map<
		string,
		{ sessionsFileStamp: string; factsByTaskId: ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews> }
	>();
	const pendingLoadsByWorkspaceIdAndStamp = new Map<
		string,
		Promise<ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>>
	>();

	const readCurrentTaskSessionFactsByTaskId = async (
		workspaceId: string,
		requireCompleteRead = false,
	): Promise<ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>> => {
		const sessions = await loadPersistedWorkspaceSessionsById(workspaceId, { requireCompleteRead });
		const factsByTaskId = new Map<string, TaskSessionFactsForCrossProjectTaskViews>();
		for (const summary of Object.values(sessions)) {
			factsByTaskId.set(
				summary.taskId,
				demoteUnclaimableAgentTurnForProjectWithoutLiveRuntime(
					extractTaskSessionFactsForCrossProjectTaskViews(
						reconstructTaskSessionSummaryFromPersistedRecordWithoutLiveAgentProcess(summary, {
							logsReconciliation: false,
						}),
					),
				),
			);
		}
		return factsByTaskId;
	};

	const loadTaskSessionFactsByTaskId = async (
		workspaceId: string,
		options: { requireCompleteRead?: boolean } = {},
	): Promise<ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>> => {
		if (options.requireCompleteRead) {
			return await completeTaskSessionFactsReadCache.read(
				getPersistedWorkspaceSessionsFilePathById(workspaceId),
				() => readCurrentTaskSessionFactsByTaskId(workspaceId, true),
			);
		}
		let sessionsFileStamp: string;
		try {
			const sessionsFileStat = await stat(getPersistedWorkspaceSessionsFilePathById(workspaceId));
			sessionsFileStamp = `${sessionsFileStat.mtimeMs}:${sessionsFileStat.size}`;
		} catch {
			// 从未建立会话的项目可以没有 sessions.json，沿用持久层的有效空集合语义。
			return EMPTY_TASK_SESSION_FACTS_BY_TASK_ID;
		}
		const cached = cachedByWorkspaceId.get(workspaceId);
		if (cached?.sessionsFileStamp === sessionsFileStamp) {
			return cached.factsByTaskId;
		}
		const pendingKey = `${workspaceId}\u0000${sessionsFileStamp}`;
		const pending = pendingLoadsByWorkspaceIdAndStamp.get(pendingKey);
		if (pending) {
			return await pending;
		}
		const loading = (async () => {
			const factsByTaskId = await readCurrentTaskSessionFactsByTaskId(workspaceId);
			cachedByWorkspaceId.set(workspaceId, { sessionsFileStamp, factsByTaskId });
			return factsByTaskId;
		})().finally(() => {
			pendingLoadsByWorkspaceIdAndStamp.delete(pendingKey);
		});
		pendingLoadsByWorkspaceIdAndStamp.set(pendingKey, loading);
		try {
			return await loading;
		} catch {
			return cached?.factsByTaskId ?? EMPTY_TASK_SESSION_FACTS_BY_TASK_ID;
		}
	};

	return {
		loadTaskSessionFactsByTaskId,
		forgetWorkspace: (workspaceId) => {
			cachedByWorkspaceId.delete(workspaceId);
			completeTaskSessionFactsReadCache.forget(getPersistedWorkspaceSessionsFilePathById(workspaceId));
		},
	};
}
