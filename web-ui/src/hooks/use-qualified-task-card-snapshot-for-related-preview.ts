import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import { useEffect, useRef, useState } from "react";
import {
	buildQualifiedTaskPreviewIdentityKey,
	fetchQualifiedTaskCardSnapshotForRelatedPreview,
} from "@/runtime/directly-related-task-preview-query";
import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "@/runtime/types";

export function useQualifiedTaskCardSnapshotForRelatedPreview(
	task: KanbanBoardCardWorkUnitQualifiedReference,
	refreshKey: string,
) {
	const identityKey = buildQualifiedTaskPreviewIdentityKey(task);
	const latestTask = useRef(task);
	latestTask.current = task;
	const lastRefreshKey = useRef(refreshKey);
	const [retrySequence, setRetrySequence] = useState(0);
	const [state, setState] = useState<{
		identityKey: string;
		snapshot: RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries | null;
		isLoading: boolean;
		error: string | null;
	}>({ identityKey, snapshot: null, isLoading: true, error: null });
	useEffect(() => {
		let obsolete = false;
		const forceReload = lastRefreshKey.current !== refreshKey || retrySequence > 0;
		lastRefreshKey.current = refreshKey;
		setState((previous) => ({
			identityKey,
			snapshot: previous.identityKey === identityKey ? previous.snapshot : null,
			isLoading: true,
			error: null,
		}));
		void fetchQualifiedTaskCardSnapshotForRelatedPreview(
			latestTask.current,
			forceReload,
			JSON.stringify([refreshKey, retrySequence]),
		).then(
			(response) => {
				if (obsolete) return;
				if (response.taskCardLookupOutcome !== "task_card_found_on_workspace_board") {
					setState({
						identityKey,
						snapshot: null,
						isLoading: false,
						error: "任务已不在所属项目看板上，无法操作。",
					});
					return;
				}
				// 同时守住浏览器侧，旧运行时或代理返回错误的一世时也不能挂载可操作卡片。
				if (response.taskCardSnapshot.taskCard.createdAt !== latestTask.current.taskIncarnationCreatedAtEpochMs) {
					setState({
						identityKey,
						snapshot: null,
						isLoading: false,
						error: "原任务已删除并重建，不能预览同 ID 的新任务。",
					});
					return;
				}
				setState({ identityKey, snapshot: response.taskCardSnapshot, isLoading: false, error: null });
			},
			(error: unknown) => {
				if (obsolete) return;
				const message = error instanceof Error ? error.message : "完整卡片读取失败。";
				// 身份冲突不能继续显示可操作的旧快照；网络失败保留已有内容并禁用操作。
				setState((previous) => ({
					identityKey,
					snapshot: message.includes("重建")
						? null
						: previous.identityKey === identityKey
							? previous.snapshot
							: null,
					isLoading: false,
					error: message,
				}));
			},
		);
		return () => {
			obsolete = true;
		};
	}, [identityKey, refreshKey, retrySequence]);
	return {
		...(state.identityKey === identityKey ? state : { identityKey, snapshot: null, isLoading: true, error: null }),
		retry: () => setRetrySequence((value) => value + 1),
	};
}
