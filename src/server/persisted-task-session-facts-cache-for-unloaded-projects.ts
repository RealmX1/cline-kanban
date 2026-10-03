import { stat } from "node:fs/promises";
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
// saveState 时写），按 (mtimeMs, size) 判失效即可；缓存里只留 TaskSessionFactsForCrossProjectTaskViews 的几个字段，
// 不留整条 summary。
//
// 状态口径与「项目被打开时 TerminalSessionManager.hydrateFromRecord 重建出来的样子」一致（共用
// reconstructTaskSessionSummaryFromPersistedRecordWithoutLiveAgentProcess）。额外一条：没有 terminal manager 的项目
// 在本 runtime 里不可能有活的 PTY 进程，而 Cline SDK / ACP 的活会话会由调用方从会话服务叠加上去，所以盘上
// 残留的「agent 正持有回合」一律不当真——否则 Running 区会出现一个重启前就已经死掉的任务。

export interface PersistedTaskSessionFactsCacheForUnloadedProjects {
	loadTaskSessionFactsByTaskId: (
		workspaceId: string,
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
	const cachedByWorkspaceId = new Map<
		string,
		{ sessionsFileStamp: string; factsByTaskId: ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews> }
	>();
	const pendingLoadsByWorkspaceIdAndStamp = new Map<
		string,
		Promise<ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>>
	>();

	const loadTaskSessionFactsByTaskId = async (
		workspaceId: string,
	): Promise<ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>> => {
		let sessionsFileStamp: string;
		try {
			const sessionsFileStat = await stat(getPersistedWorkspaceSessionsFilePathById(workspaceId));
			sessionsFileStamp = `${sessionsFileStat.mtimeMs}:${sessionsFileStat.size}`;
		} catch {
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
			const sessions = await loadPersistedWorkspaceSessionsById(workspaceId);
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
		},
	};
}
