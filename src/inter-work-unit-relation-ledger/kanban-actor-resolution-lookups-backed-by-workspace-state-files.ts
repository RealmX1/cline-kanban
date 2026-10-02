import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "../state/workspace-state";
import {
	buildTaskMutationIntentFromResolvedKanbanActor,
	type KanbanActorResolutionLookups,
	type KanbanRequestOriginActorEvidence,
	resolveKanbanActorFromRequestOriginEvidence,
} from "./kanban-actor-resolution-from-request-origin-evidence";

// 行动者解析 lookups 的生产实现（dd2db §R3 Y-EVENT-7）：只读 workspace 索引与 board.json。
//
// 仓库路径取自 workspace 索引而不是 loadWorkspaceContextById：后者会顺带跑 detectGitRepositoryInfo
// （多个同步 git 子进程，阻塞 runtime 事件循环），而行动者解析只需要索引里已规范化的 repoPath。
//
// 查不到 / 读失败一律返回 null（解析结果随之落为 unresolved_actor），绝不抛错：行动者解析只决定
// 事件记在谁名下，不该有能力让一次 board 写入失败。
export function createKanbanActorResolutionLookupsBackedByWorkspaceStateFiles(): KanbanActorResolutionLookups {
	return {
		findKanbanBoardCardIncarnationForActorResolution: async (workspaceId, taskId) => {
			try {
				const workspaceIndexEntry = (await listWorkspaceIndexEntries()).find(
					(entry) => entry.workspaceId === workspaceId,
				);
				if (!workspaceIndexEntry) {
					return null;
				}
				const board = await loadWorkspaceBoardById(workspaceId);
				const actingTaskCard = board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
				if (!actingTaskCard) {
					return null;
				}
				return {
					// 卡片 incarnation 戳 = 建卡时刻；同一个 5 位 hex id 被删后复用时靠它区分。
					taskIncarnationCreatedAtEpochMs: actingTaskCard.createdAt,
					workspaceRepositoryPath: workspaceIndexEntry.repoPath,
				};
			} catch {
				return null;
			}
		},
		findWorkspaceIdByRepositoryPathForActorResolution: async (repositoryPath) => {
			try {
				const workspaceIndexEntries = await listWorkspaceIndexEntries();
				const exactlyMatchedEntry = workspaceIndexEntries.find((entry) => entry.repoPath === repositoryPath);
				if (exactlyMatchedEntry) {
					return exactlyMatchedEntry.workspaceId;
				}
				// 索引里存的是 realpath 规范化后的仓库根；声明值可能带符号链接（例如 macOS 的 /tmp → /private/tmp）。
				const canonicalRepositoryPath = await realpath(resolve(repositoryPath)).catch(() => null);
				if (!canonicalRepositoryPath) {
					return null;
				}
				return (
					workspaceIndexEntries.find((entry) => entry.repoPath === canonicalRepositoryPath)?.workspaceId ?? null
				);
			} catch {
				return null;
			}
		},
	};
}

// runtime 内经 tRPC 进入的 board 写入统一走这里：按请求发起方证据解析行动者，再组装漏斗必填的意图。
// 必须在 board 锁**之外**调用（lookups 会读 board.json，而漏斗的 mutate 回调是同步的）。
export async function resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence(input: {
	taskMutationIntentKind: string;
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
}): Promise<TaskMutationIntentWithResolvedActor> {
	const resolvedKanbanActorWithEventEnvelopeContext = await resolveKanbanActorFromRequestOriginEvidence(
		input.kanbanRequestOriginActorEvidence,
		input.kanbanActorResolutionLookups ?? createKanbanActorResolutionLookupsBackedByWorkspaceStateFiles(),
	);
	return buildTaskMutationIntentFromResolvedKanbanActor(
		input.taskMutationIntentKind,
		resolvedKanbanActorWithEventEnvelopeContext,
	);
}
