import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type { GetDirectlyRelatedTaskPreviewPageResponse } from "@runtime-work-unit-relation-read-api-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	buildQualifiedTaskPreviewIdentityKey,
	fetchDirectlyRelatedTaskPreviewPage,
} from "@/runtime/directly-related-task-preview-query";

interface RelatedTaskPagesLoadState {
	identityKey: string;
	page: GetDirectlyRelatedTaskPreviewPageResponse | null;
	isLoading: boolean;
	error: string | null;
}

export function useDirectlyRelatedTaskPreviewPages(task: KanbanBoardCardWorkUnitQualifiedReference, isOpen: boolean) {
	const identityKey = buildQualifiedTaskPreviewIdentityKey(task);
	const [state, setState] = useState<RelatedTaskPagesLoadState>({
		identityKey,
		page: null,
		isLoading: false,
		error: null,
	});
	const requestSequence = useRef(0);
	const latestTask = useRef(task);
	latestTask.current = task;
	const pendingRequest = useRef(false);
	const read = useCallback(async (cursor?: string, forceReload = false) => {
		const requestedTask = latestTask.current;
		const requestedIdentityKey = buildQualifiedTaskPreviewIdentityKey(requestedTask);
		const sequence = ++requestSequence.current;
		pendingRequest.current = true;
		setState((previous) => ({
			identityKey: requestedIdentityKey,
			page: previous.identityKey === requestedIdentityKey ? previous.page : null,
			isLoading: true,
			error: null,
		}));
		try {
			let page: GetDirectlyRelatedTaskPreviewPageResponse;
			let replacesPreviousPage = !cursor;
			try {
				page = await fetchDirectlyRelatedTaskPreviewPage(requestedTask, cursor, forceReload);
			} catch (error) {
				if (!cursor || !(error instanceof Error) || !error.message.includes("RELATED_TASK_PREVIEW_PAGE_EXPIRED"))
					throw error;
				// 邻域变动时只自动重读一次首页，绝不无限重试或混合两个版本的分页。
				page = await fetchDirectlyRelatedTaskPreviewPage(requestedTask, undefined, true);
				replacesPreviousPage = true;
			}
			if (sequence !== requestSequence.current) return;
			setState((previous) => ({
				identityKey: requestedIdentityKey,
				page: {
					...page,
					entries:
						replacesPreviousPage || previous.identityKey !== requestedIdentityKey
							? page.entries
							: [...(previous.page?.entries ?? []), ...page.entries],
				},
				isLoading: false,
				error: null,
			}));
		} catch (error) {
			if (sequence !== requestSequence.current) return;
			setState((previous) => ({
				...previous,
				isLoading: false,
				error:
					error instanceof Error && error.message.includes("RELATED_TASK_PREVIEW_PAGE_EXPIRED")
						? "关联仍在变化，请稍后刷新。"
						: `关联读取失败：${error instanceof Error ? error.message : "请重试。"}`,
			}));
		} finally {
			if (sequence === requestSequence.current) pendingRequest.current = false;
		}
	}, []);
	useEffect(() => {
		if (isOpen) void read();
		return () => {
			requestSequence.current++;
			pendingRequest.current = false;
		};
	}, [identityKey, isOpen, read]);
	const visibleState =
		state.identityKey === identityKey ? state : { identityKey, page: null, isLoading: isOpen, error: null };
	return {
		...visibleState,
		retry: () => {
			if (!pendingRequest.current) void read(undefined, true);
		},
		loadMore: () => {
			if (!pendingRequest.current && visibleState.page?.nextCursor) void read(visibleState.page.nextCursor);
		},
	};
}
