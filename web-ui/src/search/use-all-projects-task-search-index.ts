import { useCallback, useMemo } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAllProjectsTaskSearchIndexProjectEntry } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { buildTaskBoardSearchDocument, type TaskBoardSearchDocument } from "@/search/task-board-search";

export type AllProjectsTaskSearchIndexStatus = "idle" | "loading" | "ready" | "error";

function buildDocumentsFromProjectEntry(
	entry: RuntimeAllProjectsTaskSearchIndexProjectEntry,
): TaskBoardSearchDocument[] {
	return entry.tasks.map((task) =>
		buildTaskBoardSearchDocument({
			projectId: entry.projectId,
			projectName: entry.projectName,
			taskId: task.taskId,
			columnId: task.columnId,
			title: task.title,
			prompt: task.prompt,
		}),
	);
}

export interface UseAllProjectsTaskSearchIndexResult {
	documents: TaskBoardSearchDocument[];
	status: AllProjectsTaskSearchIndexStatus;
	refetch: () => void;
}

/**
 * 按需拉取「跨全部注册项目」的任务搜索文档（Spotlight「包含其它项目」开关驱动）。
 *
 * - `enabled` 门控（弹层开 && 开关开）：关闭时不发请求，但保留上次结果（stale-while-revalidate，即时可搜）；
 * - 丢弃 `excludeProjectIds` 内的项目（当前项目——实时 board 流更新鲜；以及不可用项目）；
 * - 结果扁平化为 TaskBoardSearchDocument[]，交由 controller 与当前项目文档拼接后统一搜索。
 */
export function useAllProjectsTaskSearchIndex({
	enabled,
	workspaceId,
	excludeProjectIds,
}: {
	enabled: boolean;
	workspaceId: string | null;
	excludeProjectIds: ReadonlySet<string>;
}): UseAllProjectsTaskSearchIndexResult {
	const queryFn = useCallback(async () => {
		// 端点是非 workspace-scoped 的 t.procedure（忽略连接 scope），用任一现有连接即可。
		return await getRuntimeTrpcClient(workspaceId).projects.getAllProjectsTaskSearchIndex.query();
	}, [workspaceId]);

	const { data, isLoading, isError, refetch } = useTrpcQuery({
		enabled,
		queryFn,
		// 保留旧数据即时可搜：刷新期间不清空、出错也不清空。
		retainDataOnError: true,
		retainErrorDuringRefetch: true,
	});

	const documents = useMemo(() => {
		if (!data) {
			return [] satisfies TaskBoardSearchDocument[];
		}
		return data.projects
			.filter((entry) => !excludeProjectIds.has(entry.projectId))
			.flatMap((entry) => buildDocumentsFromProjectEntry(entry));
	}, [data, excludeProjectIds]);

	const status: AllProjectsTaskSearchIndexStatus = isError ? "error" : isLoading ? "loading" : data ? "ready" : "idle";

	const triggerRefetch = useCallback(() => {
		void refetch();
	}, [refetch]);

	return { documents, status, refetch: triggerRefetch };
}
