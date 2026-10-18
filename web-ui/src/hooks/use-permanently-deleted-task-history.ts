import { useCallback, useEffect, useRef, useState } from "react";
import { readPermanentlyDeletedTaskCards } from "@/runtime/permanently-deleted-task-history-query";
import type { ListPermanentlyDeletedTaskCardsResponse } from "@/runtime/types";

const EMPTY_HISTORY_PAGE: ListPermanentlyDeletedTaskCardsResponse = {
	entries: [],
	nextCursor: null,
	knownWorkspaces: [],
};

export function usePermanentlyDeletedTaskHistory(defaultWorkspaceId: string | null) {
	const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(EMPTY_HISTORY_PAGE);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [refreshSequence, setRefreshSequence] = useState(0);
	const requestGeneration = useRef(0);
	const activeRequest = useRef(false);
	const requestPage = useCallback(
		async (cursor: string | null, generation: number) => {
			activeRequest.current = true;
			setIsLoading(true);
			setError(null);
			try {
				const response = await readPermanentlyDeletedTaskCards({
					workspaceId: workspaceId ?? undefined,
					query,
					cursor,
				});
				if (generation !== requestGeneration.current) return;
				setPage((previous) => ({
					...response,
					entries: cursor
						? [
								...previous.entries,
								...response.entries.filter(
									(entry) =>
										!previous.entries.some(
											(prior) =>
												JSON.stringify(prior.kanbanBoardCard) === JSON.stringify(entry.kanbanBoardCard),
										),
								),
							]
						: response.entries,
				}));
			} catch (failure) {
				if (generation === requestGeneration.current)
					setError(failure instanceof Error ? failure.message : String(failure));
			} finally {
				if (generation === requestGeneration.current) {
					setIsLoading(false);
					activeRequest.current = false;
				}
			}
		},
		[query, workspaceId],
	);
	useEffect(() => {
		const generation = ++requestGeneration.current;
		setPage(EMPTY_HISTORY_PAGE);
		void requestPage(null, generation);
		return () => {
			requestGeneration.current++;
		};
	}, [requestPage, refreshSequence]);
	const loadMore = () => {
		if (!activeRequest.current && page.nextCursor) void requestPage(page.nextCursor, requestGeneration.current);
	};
	return {
		workspaceId,
		setWorkspaceId,
		query,
		setQuery,
		page,
		isLoading,
		error,
		loadMore,
		refresh: () => setRefreshSequence((previous) => previous + 1),
	};
}
