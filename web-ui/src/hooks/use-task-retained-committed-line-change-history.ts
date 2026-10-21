import { useEffect, useState } from "react";
import { fetchTaskRetainedCommittedLineChangeHistory } from "@/runtime/task-retained-committed-line-change-history-query";
import type { RuntimeTaskRetainedCommittedLineChangeHistory } from "@/runtime/types";

const historyPromisesByWorkspaceTaskAndVersion = new Map<
	string,
	Promise<RuntimeTaskRetainedCommittedLineChangeHistory>
>();

export function useTaskRetainedCommittedLineChangeHistory(input: {
	workspaceId: string | null;
	taskId: string;
	baseRef: string;
	historyVersion: string;
	isOpen: boolean;
}) {
	const { workspaceId, taskId, baseRef, historyVersion, isOpen } = input;
	const [retryCount, setRetryCount] = useState(0);
	const requestKey = JSON.stringify([workspaceId, taskId, baseRef, historyVersion, retryCount]);
	const [result, setResult] = useState<{
		requestKey: string;
		history: RuntimeTaskRetainedCommittedLineChangeHistory | null;
		error: boolean;
	} | null>(null);
	useEffect(() => {
		if (!isOpen || workspaceId === null) return;
		let cancelled = false;
		let pending = historyPromisesByWorkspaceTaskAndVersion.get(requestKey);
		if (!pending) {
			pending = fetchTaskRetainedCommittedLineChangeHistory(workspaceId, { taskId, baseRef });
			historyPromisesByWorkspaceTaskAndVersion.set(requestKey, pending);
			const requested = pending;
			void pending.then(
				(history) => {
					if (
						history.summary.historyVersion !== historyVersion &&
						historyPromisesByWorkspaceTaskAndVersion.get(requestKey) === requested
					) {
						historyPromisesByWorkspaceTaskAndVersion.delete(requestKey);
					}
				},
				() => historyPromisesByWorkspaceTaskAndVersion.delete(requestKey),
			);
			while (historyPromisesByWorkspaceTaskAndVersion.size > 128) {
				const oldest = historyPromisesByWorkspaceTaskAndVersion.keys().next().value;
				if (oldest !== undefined) historyPromisesByWorkspaceTaskAndVersion.delete(oldest);
			}
		}
		void pending.then(
			(history) => {
				if (!cancelled) setResult({ requestKey, history, error: false });
			},
			() => {
				if (!cancelled) setResult({ requestKey, history: null, error: true });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [workspaceId, taskId, baseRef, historyVersion, isOpen, requestKey]);
	return {
		history: result?.requestKey === requestKey ? result.history : null,
		hasError: result?.requestKey === requestKey && result.error,
		retry: () => setRetryCount((count) => count + 1),
	};
}
