// 通知 feed 派生层：把「最小持久化条目」补齐成前端可直接渲染的 RuntimeNotificationFeedEntry。
// taskTitle/repoName/isDone 都在这里派生——跨 repo 聚合下客户端只加载活跃 repo 的 board，
// 拿不到其它 repo 的 board 自行解析，故这三项必须后端在发送时算好。
import { basename } from "node:path";
import type { RuntimeNotificationFeedEntry } from "../core/api-contract";
import type { PersistedNotificationEntry } from "./notification-log-store";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "./workspace-state";

interface TaskDisplayInfo {
	title: string;
	isDone: boolean;
}

// ponytail: 每次读一遍 index（小文件）解析 repoName；仅在 WS 连接快照 / 通知边沿时调用，非热路径。
async function resolveWorkspaceRepoName(workspaceId: string): Promise<string> {
	try {
		const entries = await listWorkspaceIndexEntries();
		const entry = entries.find((candidate) => candidate.workspaceId === workspaceId);
		if (entry) {
			return basename(entry.repoPath) || workspaceId;
		}
	} catch {
		// 索引读失败时回退到 workspaceId（仍可识别），不让通知构建崩溃。
	}
	return workspaceId;
}

// 单次读 board，铺平成 taskId → {title, isDone} 映射。board 读失败时返回空 Map（条目走兜底）。
async function buildTaskDisplayInfoMap(workspaceId: string): Promise<Map<string, TaskDisplayInfo>> {
	const infoByTaskId = new Map<string, TaskDisplayInfo>();
	try {
		const board = await loadWorkspaceBoardById(workspaceId);
		for (const column of board.columns) {
			const isDone = column.id === "trash";
			for (const card of column.cards) {
				infoByTaskId.set(card.id, { title: card.title, isDone });
			}
		}
	} catch {
		// board 读失败（工作区被删 / 瞬时错误）：留空 Map，taskTitle 走 `Task {id}` 兜底、isDone=false。
	}
	return infoByTaskId;
}

export async function buildNotificationFeedEntries(
	workspaceId: string,
	entries: PersistedNotificationEntry[],
): Promise<RuntimeNotificationFeedEntry[]> {
	if (entries.length === 0) {
		return [];
	}
	const [repoName, taskInfoById] = await Promise.all([
		resolveWorkspaceRepoName(workspaceId),
		buildTaskDisplayInfoMap(workspaceId),
	]);
	return entries.map((entry) => {
		const info = taskInfoById.get(entry.taskId);
		return {
			id: entry.id,
			workspaceId,
			taskId: entry.taskId,
			repoName,
			taskTitle: info?.title ?? `Task ${entry.taskId}`,
			userTurnKind: entry.userTurnKind,
			triggeredAt: entry.triggeredAt,
			visitedAt: entry.visitedAt,
			isDone: info?.isDone ?? false,
		};
	});
}
