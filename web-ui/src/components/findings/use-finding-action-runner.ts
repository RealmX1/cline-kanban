// finding 操作（confirm/reject/archive）的执行编排：per-finding pending 态 + 失败 toast。
// 状态更新不经本地乐观改——mutation 落盘后服务端广播 exploratory_findings_updated，
// 调用方经推送收敛；这里只管「哪个条目的按钮在转圈」与错误露出。

import { useCallback, useState } from "react";
import { notifyError } from "@/components/app-toaster";

export interface FindingActionRunner {
	isFindingActionPending: (findingId: string) => boolean;
	runFindingAction: (findingId: string, action: () => Promise<unknown>) => void;
}

export function useFindingActionRunner(): FindingActionRunner {
	const [pendingActionByFindingId, setPendingActionByFindingId] = useState<Record<string, true>>({});
	const isFindingActionPending = useCallback(
		(findingId: string) => pendingActionByFindingId[findingId] === true,
		[pendingActionByFindingId],
	);
	const runFindingAction = useCallback((findingId: string, action: () => Promise<unknown>) => {
		setPendingActionByFindingId((current) => ({ ...current, [findingId]: true }));
		void (async () => {
			try {
				await action();
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			} finally {
				setPendingActionByFindingId((current) => {
					const next = { ...current };
					delete next[findingId];
					return next;
				});
			}
		})();
	}, []);
	return { isFindingActionPending, runFindingAction };
}
