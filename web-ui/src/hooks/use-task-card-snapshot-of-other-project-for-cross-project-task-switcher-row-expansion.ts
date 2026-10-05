import { useEffect, useRef, useState } from "react";

import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "@/runtime/types";

export type OtherProjectTaskCardSnapshotLoadState =
	| { otherProjectTaskCardSnapshotLoadStatus: "loading" }
	| {
			otherProjectTaskCardSnapshotLoadStatus: "loaded";
			taskCardSnapshot: RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries;
	  }
	| { otherProjectTaskCardSnapshotLoadStatus: "task_card_not_found" }
	| { otherProjectTaskCardSnapshotLoadStatus: "failed"; failureMessage: string };

// 条目随 projects_updated 广播变化（agent 在跑时几秒一次）后重读的去抖间隔：只有展开的行会读，量很小。
// EXPERIMENT_NODE: 展开行跟随条目变化重读的去抖间隔（500ms）是否需要按「agent 回合中」放宽
const OTHER_PROJECT_TASK_CARD_SNAPSHOT_REFRESH_DEBOUNCE_MS = 500;

/**
 * All projects 面板里**其他项目**的行展开成完整卡片时的取数：别的项目的 board 不在浏览器内存里，按需调
 * `taskCardAction.readTaskCardWithBoardColumn`（只读）。条目变了（`entryRefreshKey`）就去抖重读；重读期间与重读
 * 失败时保留上一份快照，展开的卡不会闪成加载态。当前项目的行不走这里，直接读浏览器里的 board（带 overlay）。
 */
export function useTaskCardSnapshotOfOtherProjectForCrossProjectTaskSwitcherRowExpansion({
	workspaceId,
	taskId,
	isRowExpanded,
	entryRefreshKey,
}: {
	workspaceId: string;
	taskId: string;
	isRowExpanded: boolean;
	entryRefreshKey: string;
}): OtherProjectTaskCardSnapshotLoadState {
	const [loadState, setLoadState] = useState<OtherProjectTaskCardSnapshotLoadState>({
		otherProjectTaskCardSnapshotLoadStatus: "loading",
	});
	const hasLoadedOnceRef = useRef(false);

	useEffect(() => {
		if (!isRowExpanded) {
			return;
		}
		// entryRefreshKey 只用来触发重读。
		void entryRefreshKey;
		let isSuperseded = false;
		const readTaskCardSnapshot = (): void => {
			readTaskCardWithBoardColumnInWorkspace(workspaceId, taskId).then(
				(response) => {
					if (isSuperseded) {
						return;
					}
					hasLoadedOnceRef.current = true;
					setLoadState(
						response.taskCardLookupOutcome === "task_card_found_on_workspace_board"
							? {
									otherProjectTaskCardSnapshotLoadStatus: "loaded",
									taskCardSnapshot: response.taskCardSnapshot,
								}
							: { otherProjectTaskCardSnapshotLoadStatus: "task_card_not_found" },
					);
				},
				(error: unknown) => {
					if (isSuperseded) {
						return;
					}
					setLoadState((previousLoadState) =>
						previousLoadState.otherProjectTaskCardSnapshotLoadStatus === "loaded"
							? previousLoadState
							: {
									otherProjectTaskCardSnapshotLoadStatus: "failed",
									failureMessage: error instanceof Error ? error.message : String(error),
								},
					);
				},
			);
		};
		// 首次展开立刻读；之后条目变化去抖重读。
		if (!hasLoadedOnceRef.current) {
			readTaskCardSnapshot();
			return () => {
				isSuperseded = true;
			};
		}
		const timeoutId = window.setTimeout(readTaskCardSnapshot, OTHER_PROJECT_TASK_CARD_SNAPSHOT_REFRESH_DEBOUNCE_MS);
		return () => {
			isSuperseded = true;
			window.clearTimeout(timeoutId);
		};
	}, [entryRefreshKey, isRowExpanded, taskId, workspaceId]);

	return loadState;
}
