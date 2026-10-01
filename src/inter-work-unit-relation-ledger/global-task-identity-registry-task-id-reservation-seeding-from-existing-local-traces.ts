import { readdir } from "node:fs/promises";

import { isCompleteShortTaskIdShapedText } from "../core/task-id";
import { listWorkspaceIndexEntries, loadPersistedWorkspaceStateById } from "../state/workspace-state";
import type { TaskIdReservationSeedEntryFromExistingLocalTrace } from "./inter-work-unit-relation-ledger-database-worker-client";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";

// Y-EVENT-12 的 id 保留播种：本机痕迹里出现过的 id 一律占住，删掉的卡留下的 id 也不能再分给新卡。
// 只占 id、不主张身份内容（标题、创建者等）；已删除卡的完整身份重建在 2b。
export type ExistingLocalTraceSourceKindForTaskIdReservation =
	| "kanban_workspace_board_task_card_including_trash_column"
	| "kanban_workspace_sessions_file_task_conversation_session_key_or_workspace_task_id"
	| "kanban_task_worktree_directory_name"
	| "claude_code_projects_directory_name_of_kanban_task_worktree_session";

// 索引里某个 workspace 的持久化状态文件（board.json / sessions.json / meta.json，由 loadPersistedWorkspaceStateById
// 一并读取）读不出或 schema 不合法：该 workspace 的卡 id 这次没能占住，留待后续阶段补齐。
export interface WorkspaceSkippedBecauseBoardSessionsOrMetaFileUnreadableAtTaskIdReservationSeeding {
	workspaceId: string;
	repoPath: string;
	boardSessionsOrMetaFileReadFailureMessage: string;
}

export interface TaskIdReservationSeedingCollectionResultFromExistingLocalTraces {
	seededTaskIdEntries: TaskIdReservationSeedEntryFromExistingLocalTrace[];
	workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding: WorkspaceSkippedBecauseBoardSessionsOrMetaFileUnreadableAtTaskIdReservationSeeding[];
}

// `~/.claude/projects` 下的目录名是 cwd 把 `/` 和 `.` 换成 `-` 的结果：`…-cline-worktrees-<taskId>-<repo>`。
const CLAUDE_CODE_PROJECTS_DIRECTORY_NAME_OF_KANBAN_TASK_WORKTREE_PATTERN = /-cline-worktrees-([0-9a-z]+)-/u;

// 只有「目录本身不存在」才等于「这里没有痕迹」；权限、句柄耗尽等其它读失败必须抛出，
// 否则播种会把读不到的 id 当成不存在，分配随后就可能把它们分给新卡（fail-open）。
function isMissingDirectoryReadError(error: unknown): boolean {
	const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	return errorCode === "ENOENT" || errorCode === "ENOTDIR";
}

async function listDirectoryEntryNamesOrEmptyWhenMissing(directoryPath: string): Promise<string[]> {
	try {
		return (await readdir(directoryPath, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if (isMissingDirectoryReadError(error)) {
			return [];
		}
		throw error;
	}
}

// fail-closed 的边界按「失败影响面」划：
// - workspace 索引读不出、两个痕迹目录非 ENOENT/ENOTDIR 的读失败（EACCES 等）→ 抛出，调用方让 id 分配保持 fail-closed，
//   直到某次播种完整成功。这些失败让「全部 workspace / 全部已启动过的卡」的 id 都可能漏占。
// - 索引里**单个** workspace 的 board / sessions / meta 读不出或 schema 不合法 → 跳过该 workspace、记告警、带进结果。
//   runtime 读盘时本来就对这种文件抛「Fix or remove the file」，该 workspace 已不可用；若让它阻断全局分配，
//   所有其它项目的建卡都会被一个坏文件拖死。代价只是这一个 board 里的卡 id 这次没占住：新分配撞上的概率约为
//   该 board 卡数 / 约 105 万，且启动过的卡通常还在 worktree 目录名、`~/.claude/projects` 目录名里被占住。
// workspace 索引 / board / sessions 文件不存在时由 workspace-state 的读取按默认值返回，不算失败。
// 告警在这里（收集阶段、worker 调用之外）记，每个被跳过的 workspace 一条。
export async function collectTaskIdReservationSeedingResultFromExistingLocalTraces(input: {
	taskWorktreesHomePath: string;
	claudeCodeProjectsDirectoryPath: string;
}): Promise<TaskIdReservationSeedingCollectionResultFromExistingLocalTraces> {
	const sourceKindsByTaskId = new Map<string, Set<ExistingLocalTraceSourceKindForTaskIdReservation>>();
	const noteTaskIdTrace = (candidateText: string, sourceKind: ExistingLocalTraceSourceKindForTaskIdReservation) => {
		// 自定义 id（经 explicitTaskId 建的任意长度 id）不在分配空间内，占了也不会和分配撞，略过。
		if (!isCompleteShortTaskIdShapedText(candidateText)) {
			return;
		}
		const sourceKinds = sourceKindsByTaskId.get(candidateText) ?? new Set();
		sourceKinds.add(sourceKind);
		sourceKindsByTaskId.set(candidateText, sourceKinds);
	};
	const workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding: WorkspaceSkippedBecauseBoardSessionsOrMetaFileUnreadableAtTaskIdReservationSeeding[] =
		[];

	for (const indexedWorkspace of await listWorkspaceIndexEntries()) {
		let persisted: Awaited<ReturnType<typeof loadPersistedWorkspaceStateById>>;
		try {
			persisted = await loadPersistedWorkspaceStateById(indexedWorkspace.workspaceId);
		} catch (error) {
			const boardSessionsOrMetaFileReadFailureMessage = error instanceof Error ? error.message : String(error);
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`skipped workspace ${indexedWorkspace.workspaceId} (${indexedWorkspace.repoPath}) while seeding task id reservations because its board/sessions/meta file could not be read; task ids on that board are not reserved by this seeding: ${boardSessionsOrMetaFileReadFailureMessage}`,
			);
			workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding.push({
				workspaceId: indexedWorkspace.workspaceId,
				repoPath: indexedWorkspace.repoPath,
				boardSessionsOrMetaFileReadFailureMessage,
			});
			continue;
		}
		for (const column of persisted.board.columns) {
			for (const card of column.cards) {
				noteTaskIdTrace(card.id, "kanban_workspace_board_task_card_including_trash_column");
			}
		}
		for (const [taskConversationSessionId, sessionSummary] of Object.entries(persisted.sessions)) {
			noteTaskIdTrace(
				taskConversationSessionId,
				"kanban_workspace_sessions_file_task_conversation_session_key_or_workspace_task_id",
			);
			const workspaceTaskId = sessionSummary.taskConversationSessionMetadata?.workspaceTaskId;
			if (workspaceTaskId) {
				noteTaskIdTrace(
					workspaceTaskId,
					"kanban_workspace_sessions_file_task_conversation_session_key_or_workspace_task_id",
				);
			}
		}
	}
	for (const directoryName of await listDirectoryEntryNamesOrEmptyWhenMissing(input.taskWorktreesHomePath)) {
		noteTaskIdTrace(directoryName, "kanban_task_worktree_directory_name");
	}
	for (const directoryName of await listDirectoryEntryNamesOrEmptyWhenMissing(input.claudeCodeProjectsDirectoryPath)) {
		const matchedTaskId =
			CLAUDE_CODE_PROJECTS_DIRECTORY_NAME_OF_KANBAN_TASK_WORKTREE_PATTERN.exec(directoryName)?.[1];
		if (matchedTaskId) {
			noteTaskIdTrace(matchedTaskId, "claude_code_projects_directory_name_of_kanban_task_worktree_session");
		}
	}

	return {
		seededTaskIdEntries: [...sourceKindsByTaskId.entries()]
			.sort(([leftTaskId], [rightTaskId]) => leftTaskId.localeCompare(rightTaskId))
			.map(([taskId, sourceKinds]) => ({
				taskId,
				observedInExistingLocalTraceSourceKinds: [...sourceKinds].sort(),
			})),
		workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding,
	};
}

// 只要播种条目的入口（测试用）。激活模块用 collectTaskIdReservationSeedingResultFromExistingLocalTraces，把跳过名单带进播种事件。
export async function collectTaskIdReservationSeedEntriesFromExistingLocalTraces(input: {
	taskWorktreesHomePath: string;
	claudeCodeProjectsDirectoryPath: string;
}): Promise<TaskIdReservationSeedEntryFromExistingLocalTrace[]> {
	return (await collectTaskIdReservationSeedingResultFromExistingLocalTraces(input)).seededTaskIdEntries;
}
