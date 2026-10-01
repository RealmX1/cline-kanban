import { useEffect, useRef, useState } from "react";
import type {
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
} from "@/runtime/types";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import {
	buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload,
	discardAllPendingWebUiBoardMutationInitiatorRecords,
	discardWebUiBoardMutationInitiatorRecordsCoveredBySuccessfulSaveState,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import type { BoardData } from "@/types";

const WORKSPACE_STATE_PERSIST_DEBOUNCE_MS = 120;

export interface UseWorkspacePersistenceParams {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectId: string | null;
	workspaceRevision: number | null;
	hydrationNonce: number;
	canPersistWorkspaceState: boolean;
	isDocumentVisible: boolean;
	isWorkspaceStateRefreshing: boolean;
	persistWorkspaceState: (input: {
		workspaceId: string;
		payload: RuntimeWorkspaceStateSaveRequest;
	}) => Promise<RuntimeWorkspaceStateResponse>;
	refetchWorkspaceState: () => Promise<unknown>;
	onWorkspaceRevisionChange: (revision: number) => void;
	onWorkspaceStateConflict?: (input: { workspaceId: string; currentRevision: number }) => void;
}

export function useWorkspacePersistence({
	board,
	sessions,
	currentProjectId,
	workspaceRevision,
	hydrationNonce,
	canPersistWorkspaceState,
	isDocumentVisible,
	isWorkspaceStateRefreshing,
	persistWorkspaceState,
	refetchWorkspaceState,
	onWorkspaceRevisionChange,
	onWorkspaceStateConflict,
}: UseWorkspacePersistenceParams): void {
	const [persistCycle, setPersistCycle] = useState(0);
	const skipNextPersistRef = useRef(false);
	const latestHydrationNonceRef = useRef(hydrationNonce);
	const latestPersistRequestIdRef = useRef(0);
	const persistInFlightRef = useRef(false);
	const persistQueuedRef = useRef(false);
	const currentProjectIdRef = useRef<string | null>(currentProjectId);
	const sessionsRef = useRef(sessions);
	const lastPersistedBoardRef = useRef<BoardData | null>(null);
	const lastPersistedWorkspaceIdRef = useRef<string | null>(null);

	useEffect(() => {
		currentProjectIdRef.current = currentProjectId;
		if (lastPersistedWorkspaceIdRef.current !== currentProjectId) {
			lastPersistedWorkspaceIdRef.current = currentProjectId;
			lastPersistedBoardRef.current = null;
			// 换了项目：上一个项目里未保存的发起方登记已无处可配。
			discardAllPendingWebUiBoardMutationInitiatorRecords();
		}
	}, [currentProjectId]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	useEffect(() => {
		if (latestHydrationNonceRef.current === hydrationNonce) {
			return;
		}
		latestHydrationNonceRef.current = hydrationNonce;
		skipNextPersistRef.current = true;
		lastPersistedWorkspaceIdRef.current = currentProjectId;
		lastPersistedBoardRef.current = board;
		// 水合 = 本地 board 被 runtime 那份整板替换，本地尚未保存的变更（连同它们的发起方登记）都已不在。
		discardAllPendingWebUiBoardMutationInitiatorRecords();
	}, [board, currentProjectId, hydrationNonce]);

	useEffect(() => {
		if (!canPersistWorkspaceState || !isDocumentVisible || isWorkspaceStateRefreshing || workspaceRevision == null) {
			return;
		}
		if (persistInFlightRef.current) {
			persistQueuedRef.current = true;
			return;
		}
		if (skipNextPersistRef.current) {
			skipNextPersistRef.current = false;
			return;
		}
		if (
			currentProjectId != null &&
			lastPersistedWorkspaceIdRef.current === currentProjectId &&
			lastPersistedBoardRef.current === board
		) {
			return;
		}
		const timeoutId = window.setTimeout(() => {
			const requestId = latestPersistRequestIdRef.current + 1;
			latestPersistRequestIdRef.current = requestId;
			const persistWorkspaceId = currentProjectId;
			if (!persistWorkspaceId) {
				return;
			}
			// dd2db Y-EVENT-8：自上次成功保存以来登记的发起方，按「runtime 最近确认持久化的 board → 本次 board」的差
			// 出逐卡逐变更的标注。只进关系账本，不落 board；没有可出的标注时不带这个键。
			const boardMutationInitiatorAnnotationsBuiltForThisSave =
				buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload({
					boardLastConfirmedPersistedByRuntime:
						lastPersistedWorkspaceIdRef.current === persistWorkspaceId ? lastPersistedBoardRef.current : null,
					boardAboutToBeSaved: board,
				});
			const payload: RuntimeWorkspaceStateSaveRequest = {
				board,
				sessions: sessionsRef.current,
				expectedRevision: workspaceRevision,
				...(boardMutationInitiatorAnnotationsBuiltForThisSave
					.boardMutationInitiatorAnnotationsForTaskMutationEventCapture.length > 0
					? {
							boardMutationInitiatorAnnotationsForTaskMutationEventCapture:
								boardMutationInitiatorAnnotationsBuiltForThisSave.boardMutationInitiatorAnnotationsForTaskMutationEventCapture,
						}
					: {}),
			};
			void (async () => {
				persistInFlightRef.current = true;
				try {
					const saved = await persistWorkspaceState({
						workspaceId: persistWorkspaceId,
						payload,
					});
					// 成功：组载荷时已存在的登记都已随这次保存交给 runtime（或已确认无差可配），丢弃；
					// 失败（冲突、网络、nonce 重试仍失败等）走 catch，登记原样保留到下一次保存。
					discardWebUiBoardMutationInitiatorRecordsCoveredBySuccessfulSaveState(
						boardMutationInitiatorAnnotationsBuiltForThisSave.pendingInitiatorRecordSequenceCoveredBySaveStatePayload,
					);
					if (
						requestId !== latestPersistRequestIdRef.current ||
						currentProjectIdRef.current !== persistWorkspaceId
					) {
						return;
					}
					lastPersistedWorkspaceIdRef.current = persistWorkspaceId;
					lastPersistedBoardRef.current = board;
					onWorkspaceRevisionChange(saved.revision);
				} catch (error) {
					if (error instanceof WorkspaceStateConflictError) {
						if (
							requestId === latestPersistRequestIdRef.current &&
							currentProjectIdRef.current === persistWorkspaceId
						) {
							onWorkspaceRevisionChange(error.currentRevision);
							onWorkspaceStateConflict?.({
								workspaceId: persistWorkspaceId,
								currentRevision: error.currentRevision,
							});
						}
						if (currentProjectIdRef.current !== persistWorkspaceId) {
							return;
						}
						await refetchWorkspaceState();
						return;
					}
					// Keep the UI usable even if persistence is temporarily unavailable.
				} finally {
					persistInFlightRef.current = false;
					if (persistQueuedRef.current) {
						persistQueuedRef.current = false;
						setPersistCycle((current) => current + 1);
					}
				}
			})();
		}, WORKSPACE_STATE_PERSIST_DEBOUNCE_MS);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [
		board,
		canPersistWorkspaceState,
		currentProjectId,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		onWorkspaceRevisionChange,
		persistCycle,
		persistWorkspaceState,
		refetchWorkspaceState,
		onWorkspaceStateConflict,
		workspaceRevision,
	]);
}
