// 资源占用归因的「根」：此刻所有带活体 pid 的会话，以及每个 task 的工作目录。纯函数 + getter 注入，
// 数据源由 runtime-server 在同一闭包里提供（三种 transport 的服务持有者都在那里）。
//
// 刻意不复用的两条现成枚举：
//   - listProjectRuntimeSessionSummaries：按 taskId 跨 transport 合并、后写覆盖先写，会把 PTY 的 pid 吞掉；
//   - 回收调度器的期限账本：只记录「已停止、处于宽限期」的会话，正在跑的会话根本不在里面。
// 因此这里按 transport 分别遍历，并且只保留 pid 非空的条目（listSummaries 里有数百条已水合的历史会话）。

import { resolveRuntimeAgentSessionTransportFromSummary } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeTaskConversationSessionMetadata,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import {
	isWorkspaceHomeUserShellTerminalSessionTaskId,
	parseTaskCardIdFromTaskCardDetailUserShellTerminalSessionTaskId,
} from "../core/user-shell-terminal-session-task-id";
import type { TaskResourceUsageAttributionRootProcessRole } from "../diagnostics/task-attributed-process-classification-rules";

export type TaskResourceUsageAttributionSessionCategory =
	| "task_card_main_agent_session"
	| "task_card_side_conversation_agent_session"
	| "workspace_home_sidebar_agent_session"
	| "task_card_detail_user_shell_terminal_session"
	| "workspace_home_user_shell_terminal_session";

export interface TaskResourceUsageAttributionSessionSource {
	workspaceId: string;
	workspacePath: string | null;
	listSummaries: () => RuntimeTaskSessionSummary[];
}

export interface TaskResourceUsageAttributionRoot {
	workspaceId: string;
	workspacePath: string | null;
	// summary.taskId 原样：可能是卡片 id、by-the-way 会话 id、home agent / shell 的合成 id。
	sessionTaskId: string;
	// 这个会话的资源记到哪张卡上；workspace 级会话（home agent、首页终端）为 null。
	attributedTaskCardId: string | null;
	sessionCategory: TaskResourceUsageAttributionSessionCategory;
	sessionTransport: RuntimeAgentSessionTransport;
	agentId: RuntimeAgentId | null;
	rootProcessId: number;
	rootProcessRole: TaskResourceUsageAttributionRootProcessRole;
	runtimeSessionIncarnationId: string | null;
	// 采样器用它核对 pid 没被系统复用给一个无关进程（根进程的 lstart 应与会话启动时刻吻合）。
	rootSessionStartedAtEpochMs: number | null;
}

export interface TaskWorkingDirectoryAttribution {
	workspaceId: string;
	workingDirectoryPath: string;
	// 多个 inplace task 共用同一个目录时无法判定归属，为 null（只能记到 workspace 上）。
	attributedTaskCardId: string | null;
	// 在这个目录里跑过的会话里，最近一次 summary 更新的时刻（磁盘测量据此跳过久未活动的 worktree）。
	latestSessionUpdatedAtEpochMs: number;
}

export interface TaskResourceUsageAttributionRootEnumeration {
	roots: TaskResourceUsageAttributionRoot[];
	taskWorkingDirectoryAttributions: TaskWorkingDirectoryAttribution[];
	// 孤儿进程 env 里只有 KANBAN_PROJECT_PATH，靠它找回 workspaceId。
	workspaceIdByWorkspacePath: Map<string, string>;
}

export interface TaskResourceUsageAttributionSessionSourceGetters {
	listTerminalSessionSources: () => TaskResourceUsageAttributionSessionSource[];
	listClineSessionSources: () => TaskResourceUsageAttributionSessionSource[];
	listAcpSessionSources: () => TaskResourceUsageAttributionSessionSource[];
}

// 会话 → 资源记到哪张卡上。hook ingest 的 journal 记录、采样器的会话根、以及按 env 找回的孤儿共用这一个判定。
// 入参只要求判定真正读到的字段：env 找回的孤儿只知道「会话 id + 宿主卡片 id」，拼不出完整 summary。
export function resolveSessionCategoryAndAttributedTaskCardId(summary: {
	taskId: RuntimeTaskSessionSummary["taskId"];
	taskConversationSessionMetadata?: Pick<
		RuntimeTaskConversationSessionMetadata,
		"workspaceTaskId" | "taskConversationSessionRole"
	>;
}): {
	sessionCategory: TaskResourceUsageAttributionSessionCategory;
	attributedTaskCardId: string | null;
} {
	if (isHomeAgentSessionId(summary.taskId)) {
		return { sessionCategory: "workspace_home_sidebar_agent_session", attributedTaskCardId: null };
	}
	if (isWorkspaceHomeUserShellTerminalSessionTaskId(summary.taskId)) {
		return { sessionCategory: "workspace_home_user_shell_terminal_session", attributedTaskCardId: null };
	}
	const detailTerminalTaskCardId = parseTaskCardIdFromTaskCardDetailUserShellTerminalSessionTaskId(summary.taskId);
	if (detailTerminalTaskCardId !== null) {
		return {
			sessionCategory: "task_card_detail_user_shell_terminal_session",
			attributedTaskCardId: detailTerminalTaskCardId,
		};
	}
	const conversationSessionMetadata = summary.taskConversationSessionMetadata;
	if (conversationSessionMetadata && conversationSessionMetadata.taskConversationSessionRole !== "main") {
		return {
			sessionCategory: "task_card_side_conversation_agent_session",
			attributedTaskCardId: conversationSessionMetadata.workspaceTaskId,
		};
	}
	return {
		sessionCategory: "task_card_main_agent_session",
		attributedTaskCardId: conversationSessionMetadata?.workspaceTaskId ?? summary.taskId,
	};
}

function isUserShellTerminalSessionCategory(sessionCategory: TaskResourceUsageAttributionSessionCategory): boolean {
	return (
		sessionCategory === "task_card_detail_user_shell_terminal_session" ||
		sessionCategory === "workspace_home_user_shell_terminal_session"
	);
}

export function enumerateTaskResourceUsageAttributionRoots(
	getters: TaskResourceUsageAttributionSessionSourceGetters,
): TaskResourceUsageAttributionRootEnumeration {
	const roots: TaskResourceUsageAttributionRoot[] = [];
	// workspaceId + 目录 → 在该目录里出现过的卡片集合。
	const taskCardIdsByWorkspaceAndWorkingDirectory = new Map<
		string,
		{
			workspaceId: string;
			workingDirectoryPath: string;
			taskCardIds: Set<string>;
			latestSessionUpdatedAtEpochMs: number;
		}
	>();

	const allSources = [
		...getters.listTerminalSessionSources(),
		...getters.listClineSessionSources(),
		...getters.listAcpSessionSources(),
	];
	const workspaceIdByWorkspacePath = new Map<string, string>();
	for (const sessionSource of allSources) {
		if (sessionSource.workspacePath) {
			workspaceIdByWorkspacePath.set(sessionSource.workspacePath, sessionSource.workspaceId);
		}
		for (const summary of sessionSource.listSummaries()) {
			const { sessionCategory, attributedTaskCardId } = resolveSessionCategoryAndAttributedTaskCardId(summary);
			if (summary.workspacePath && attributedTaskCardId !== null) {
				const workingDirectoryKey = `${sessionSource.workspaceId}\u0000${summary.workspacePath}`;
				const existing = taskCardIdsByWorkspaceAndWorkingDirectory.get(workingDirectoryKey);
				if (existing) {
					existing.taskCardIds.add(attributedTaskCardId);
					existing.latestSessionUpdatedAtEpochMs = Math.max(
						existing.latestSessionUpdatedAtEpochMs,
						summary.updatedAt,
					);
				} else {
					taskCardIdsByWorkspaceAndWorkingDirectory.set(workingDirectoryKey, {
						workspaceId: sessionSource.workspaceId,
						workingDirectoryPath: summary.workspacePath,
						taskCardIds: new Set([attributedTaskCardId]),
						latestSessionUpdatedAtEpochMs: summary.updatedAt,
					});
				}
			}
			if (summary.pid === null || !Number.isInteger(summary.pid) || summary.pid <= 0) {
				continue;
			}
			roots.push({
				workspaceId: sessionSource.workspaceId,
				workspacePath: sessionSource.workspacePath,
				sessionTaskId: summary.taskId,
				attributedTaskCardId,
				sessionCategory,
				sessionTransport: resolveRuntimeAgentSessionTransportFromSummary(summary),
				agentId: summary.agentId,
				rootProcessId: summary.pid,
				rootProcessRole: isUserShellTerminalSessionCategory(sessionCategory)
					? "user_shell_terminal_root"
					: "agent_harness_root",
				runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
				rootSessionStartedAtEpochMs: summary.startedAt,
			});
		}
	}

	const taskWorkingDirectoryAttributions: TaskWorkingDirectoryAttribution[] = [];
	for (const {
		workspaceId,
		workingDirectoryPath,
		taskCardIds,
		latestSessionUpdatedAtEpochMs,
	} of taskCardIdsByWorkspaceAndWorkingDirectory.values()) {
		taskWorkingDirectoryAttributions.push({
			workspaceId,
			workingDirectoryPath,
			attributedTaskCardId: taskCardIds.size === 1 ? (Array.from(taskCardIds)[0] ?? null) : null,
			latestSessionUpdatedAtEpochMs,
		});
	}
	return { roots, taskWorkingDirectoryAttributions, workspaceIdByWorkspacePath };
}
