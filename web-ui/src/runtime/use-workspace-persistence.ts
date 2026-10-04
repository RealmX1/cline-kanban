import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceBoardHydrationFromRuntime, WorkspaceBoardSavedByRuntime } from "@/hooks/use-workspace-sync";
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
	// 与 hydrationNonce 同时更新；缺省时每次水合都视为「本地就是 runtime 那份」。
	latestWorkspaceBoardHydrationFromRuntime?: WorkspaceBoardHydrationFromRuntime | null;
	persistWorkspaceState: (input: {
		workspaceId: string;
		payload: RuntimeWorkspaceStateSaveRequest;
	}) => Promise<RuntimeWorkspaceStateResponse>;
	refetchWorkspaceState: () => Promise<unknown>;
	// 整板保存成功：发出去的那份 board、runtime 实际落盘的那份与新 revision（useWorkspaceSync 据此更新三方判定的
	// 基线；runtime 纠正过 board 时按三方规则吸收进本地）。
	onWorkspaceBoardSavedByRuntime: (input: WorkspaceBoardSavedByRuntime) => void;
}

export interface UseWorkspacePersistenceResult {
	// 切项目前调用：防抖窗口里还没发出的整板保存立刻发出（发往旧项目），而不是随定时器一起被清掉。
	flushPendingWorkspaceStatePersistImmediately: () => void;
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
	latestWorkspaceBoardHydrationFromRuntime = null,
	persistWorkspaceState,
	refetchWorkspaceState,
	onWorkspaceBoardSavedByRuntime,
}: UseWorkspacePersistenceParams): UseWorkspacePersistenceResult {
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
	const pendingDebouncedPersistRef = useRef<{ timeoutId: number; runPersist: () => void } | null>(null);

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
		lastPersistedWorkspaceIdRef.current = currentProjectId;
		if (
			latestWorkspaceBoardHydrationFromRuntime?.workspaceHydrationNonce === hydrationNonce &&
			latestWorkspaceBoardHydrationFromRuntime.hydratedBoardContainsLocalChangesNotYetPersistedByRuntime
		) {
			// 水合时把本客户端尚未落盘的新卡并回了 runtime 那份 board：照常保存，差分基线是 runtime 那份，
			// 这些新卡的发起方登记仍然有效，保留。
			lastPersistedBoardRef.current = latestWorkspaceBoardHydrationFromRuntime.boardAcknowledgedByRuntime;
			return;
		}
		skipNextPersistRef.current = true;
		lastPersistedBoardRef.current = board;
		// 水合 = 本地 board 被 runtime 那份整板替换，本地尚未保存的变更（连同它们的发起方登记）都已不在。
		discardAllPendingWebUiBoardMutationInitiatorRecords();
	}, [board, currentProjectId, hydrationNonce, latestWorkspaceBoardHydrationFromRuntime]);

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
		const runPersist = () => {
			pendingDebouncedPersistRef.current = null;
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
					onWorkspaceBoardSavedByRuntime({
						workspaceId: persistWorkspaceId,
						savedBoard: board,
						savedRevision: saved.revision,
						boardPersistedByRuntimeInSaveResponse: saved.board,
					});
				} catch (error) {
					if (error instanceof WorkspaceStateConflictError) {
						if (currentProjectIdRef.current !== persistWorkspaceId) {
							return;
						}
						// 不直接采纳冲突里的 currentRevision、也不提示：取回最新状态交给 useWorkspaceSync 的三方判定——
						// 远端 board 没变（只是 revision 被 sessions 写入推走）就保留本地改动、以新 revision 自动重发；
						// 远端真有变化才以远端为准并提示（cf427：过去这里一冲突就提示，并让随后的整板水合抹掉新卡）。
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
		};
		const timeoutId = window.setTimeout(runPersist, WORKSPACE_STATE_PERSIST_DEBOUNCE_MS);
		pendingDebouncedPersistRef.current = { timeoutId, runPersist };
		return () => {
			window.clearTimeout(timeoutId);
			if (pendingDebouncedPersistRef.current?.timeoutId === timeoutId) {
				pendingDebouncedPersistRef.current = null;
			}
		};
	}, [
		board,
		canPersistWorkspaceState,
		currentProjectId,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		onWorkspaceBoardSavedByRuntime,
		persistCycle,
		persistWorkspaceState,
		refetchWorkspaceState,
		workspaceRevision,
	]);

	const flushPendingWorkspaceStatePersistImmediately = useCallback(() => {
		const pendingDebouncedPersist = pendingDebouncedPersistRef.current;
		if (!pendingDebouncedPersist) {
			return;
		}
		window.clearTimeout(pendingDebouncedPersist.timeoutId);
		pendingDebouncedPersist.runPersist();
	}, []);

	return { flushPendingWorkspaceStatePersistImmediately };
}
