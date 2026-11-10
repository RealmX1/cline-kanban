import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeReadTaskCardsForPostDeployVerificationResponse } from "@/runtime/types";

export async function fetchTaskCardsForPostDeployVerification(
	workspaceId: string,
	taskIds: readonly string[],
	signal?: AbortSignal,
): Promise<RuntimeReadTaskCardsForPostDeployVerificationResponse> {
	const ids = [...new Set(taskIds)];
	const client = getRuntimeTrpcClient(workspaceId);
	let result: RuntimeReadTaskCardsForPostDeployVerificationResponse = {
		repoPath: "",
		board: { columns: [] },
		sessions: {},
	};
	for (let offset = 0; offset < ids.length; offset += 100) {
		const response = await client.workspace.readTaskCardsForPostDeployVerification.query(
			{ taskIds: ids.slice(offset, offset + 100) },
			{ signal },
		);
		if (signal?.aborted) throw new DOMException("读取已取消", "AbortError");
		const columns = new Map(result.board.columns.map((column) => [column.id, column]));
		for (const column of response.board.columns) {
			const previous = columns.get(column.id);
			columns.set(column.id, { ...column, cards: [...(previous?.cards ?? []), ...column.cards] });
		}
		result = {
			repoPath: response.repoPath,
			board: { columns: [...columns.values()] },
			sessions: { ...result.sessions, ...response.sessions },
		};
	}
	return result;
}
