import isDeepEqual from "fast-deep-equal";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { createInitialBoardData } from "@/data/board-data";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import type {
	RuntimeGitRepositoryInfo,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";
import {
	mergeTaskSessionSummaries as mergeStreamedTaskSessionSummaries,
	type StreamedTaskSessionSummariesApplier,
	type StreamedTaskSessionSummariesApplierRef,
} from "@/runtime/use-runtime-state-stream";
import { fetchWorkspaceState } from "@/runtime/workspace-state-query";
import { normalizeBoardData } from "@/state/board-state";
import { reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance } from "@/state/local-board-reconciliation-after-remote-workspace-revision-advance";
import { subscribeToWorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntime } from "@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start";
import type { BoardData } from "@/types";

// 一次整板保存成功的回报。runtime 会纠正 incoming board（例如把已启动任务从 backlog 移回原列），
// 所以除了发出的那份，还要带上响应里 runtime 实际落盘的那份。
export interface WorkspaceBoardSavedByRuntime {
	workspaceId: string;
	savedBoard: BoardData;
	savedRevision: number;
	boardPersistedByRuntimeInSaveResponse?: RuntimeWorkspaceStateResponse["board"];
}

// 一次「board 被 runtime 那份替换」的水合。持久化 hook 按它决定水合后的下一次保存：通常跳过（本地就是 runtime
// 那份），但若水合时把本客户端尚未落盘的新卡并了回去，就必须照常保存，且以 runtime 那份为差分基线。
export interface WorkspaceBoardHydrationFromRuntime {
	workspaceHydrationNonce: number;
	boardAcknowledgedByRuntime: BoardData;
	hydratedBoardContainsLocalChangesNotYetPersistedByRuntime: boolean;
}

interface UseWorkspaceSyncInput {
	currentProjectId: string | null;
	// 本地 board 的最新值：远端 revision 前进时与 runtime 确认的基线、远端 board 做三方判定。
	board: BoardData;
	streamedWorkspaceState: RuntimeWorkspaceStateResponse | null;
	// task_sessions_updated 旁路出口（见 use-runtime-state-stream）：本 hook 挂载时往里注册 applier，
	// stream hook 收到该批消息后不经 reducer、直接调它做一次 setSessions。
	streamedTaskSessionSummariesApplierRef: StreamedTaskSessionSummariesApplierRef;
	hasNoProjects: boolean;
	hasReceivedSnapshot: boolean;
	isDocumentVisible: boolean;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	setCanPersistWorkspaceState: Dispatch<SetStateAction<boolean>>;
	// 本地未保存的改动与远端改了同一张卡的同一个面（所在列 / 字段值）而被以远端为准丢弃时调用；能合并的不算丢弃。
	onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange?: () => void;
}

interface UseWorkspaceSyncResult {
	workspacePath: string | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	workspaceRevision: number | null;
	setWorkspaceRevision: Dispatch<SetStateAction<number | null>>;
	workspaceHydrationNonce: number;
	latestWorkspaceBoardHydrationFromRuntime: WorkspaceBoardHydrationFromRuntime | null;
	// 持久化 hook 整板保存成功后回报：发出去的那份 board 成为新基线，revision 只进不退。
	recordWorkspaceBoardSavedByRuntime: (input: WorkspaceBoardSavedByRuntime) => void;
	isWorkspaceStateRefreshing: boolean;
	isWorkspaceMetadataPending: boolean;
	refreshWorkspaceState: () => Promise<void>;
	resetWorkspaceSyncState: () => void;
}

function mergeTaskSessionSummaries(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	nextSessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	// 引用纪律同 stream 侧的数组合并：没有 key 被实际替换时返回入参原引用（惰性拷贝），
	// 让 setSessions 的 Object.is bailout 生效——revision 每涨一次这里都会跑，而绝大多数 key 本就没动。
	let mergedSessions: Record<string, RuntimeTaskSessionSummary> | null = null;
	for (const [taskId, summary] of Object.entries(nextSessions)) {
		const existing = (mergedSessions ?? currentSessions)[taskId] ?? null;
		const newestSummary = selectNewestTaskSessionSummary(existing, summary);
		if (!newestSummary || newestSummary === existing) {
			continue;
		}
		if (mergedSessions === null) {
			mergedSessions = { ...currentSessions };
		}
		mergedSessions[taskId] = newestSummary;
	}
	return mergedSessions ?? currentSessions;
}

// 头一份快照（首屏、或切项目后 reset 过）的 sessions 吸收：本地 sessions 里快照没有的 key 只可能是别的项目留下的，
// 一律丢掉——否则它们会随下一次整板保存写进这个项目的 sessions.json（cf427 的跨项目串写）。但 reset 之后、
// 头一份快照被吸收之前，task_sessions_updated 旁路 applier 可能已并入本项目更新的 summary：快照里出现的 taskId
// 仍按与后续快照相同的 updatedAt 单调规则取较新者，不能被头一份快照里较旧的 summary 整份替换掉。
function restrictTaskSessionSummariesToFirstWorkspaceSnapshotKeepingNewerSummaryPerTask(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	firstWorkspaceSnapshotSessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	const currentSessionsWhoseTaskIdIsInFirstWorkspaceSnapshot: Record<string, RuntimeTaskSessionSummary> = {};
	for (const taskId of Object.keys(firstWorkspaceSnapshotSessions)) {
		const currentSummary = currentSessions[taskId];
		if (currentSummary) {
			currentSessionsWhoseTaskIdIsInFirstWorkspaceSnapshot[taskId] = currentSummary;
		}
	}
	return mergeTaskSessionSummaries(
		currentSessionsWhoseTaskIdIsInFirstWorkspaceSnapshot,
		firstWorkspaceSnapshotSessions,
	);
}

export function useWorkspaceSync({
	currentProjectId,
	board,
	streamedWorkspaceState,
	streamedTaskSessionSummariesApplierRef,
	hasNoProjects,
	hasReceivedSnapshot,
	isDocumentVisible,
	setBoard,
	setSessions,
	setCanPersistWorkspaceState,
	onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange,
}: UseWorkspaceSyncInput): UseWorkspaceSyncResult {
	const [workspacePath, setWorkspacePath] = useState<string | null>(null);
	const [workspaceGit, setWorkspaceGit] = useState<RuntimeGitRepositoryInfo | null>(null);
	const [appliedWorkspaceProjectId, setAppliedWorkspaceProjectId] = useState<string | null>(null);
	const [workspaceRevision, setWorkspaceRevision] = useState<number | null>(null);
	const [workspaceHydrationNonce, setWorkspaceHydrationNonce] = useState(0);
	const [latestWorkspaceBoardHydrationFromRuntime, setLatestWorkspaceBoardHydrationFromRuntime] =
		useState<WorkspaceBoardHydrationFromRuntime | null>(null);
	const workspaceHydrationNonceRef = useRef(0);
	// 事件入口读最新本地 board（applyWorkspaceState 在 effect / 异步回调里跑）。
	const latestLocalBoardRef = useRef(board);
	latestLocalBoardRef.current = board;
	// runtime 最近一次确认持久化的 board：水合采纳的远端 board、整板保存成功时发出的 board、建卡落盘确认返回的 board。
	const boardLastAcknowledgedByRuntimeRef = useRef<{ projectId: string | null; board: BoardData } | null>(null);
	const onLocalUnsavedBoardChangesDiscardedByRemoteBoardChangeRef = useRef(
		onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange,
	);
	onLocalUnsavedBoardChangesDiscardedByRemoteBoardChangeRef.current =
		onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange;
	const [isWorkspaceStateRefreshing, setIsWorkspaceStateRefreshing] = useState(false);
	const workspaceVersionRef = useRef<{ projectId: string | null; revision: number | null }>({
		projectId: null,
		revision: null,
	});
	const workspaceRefreshRequestIdRef = useRef(0);

	const isWorkspaceMetadataPending = currentProjectId !== null && appliedWorkspaceProjectId !== currentProjectId;

	useEffect(() => {
		if (workspaceVersionRef.current.projectId !== currentProjectId) {
			return;
		}
		workspaceVersionRef.current = {
			projectId: currentProjectId,
			revision: workspaceRevision,
		};
	}, [currentProjectId, workspaceRevision]);

	const hydrateBoardFromRuntime = useCallback(
		(input: {
			hydratedBoard: BoardData;
			boardAcknowledgedByRuntime: BoardData;
			hydratedBoardContainsLocalChangesNotYetPersistedByRuntime: boolean;
		}) => {
			const nextWorkspaceHydrationNonce = workspaceHydrationNonceRef.current + 1;
			workspaceHydrationNonceRef.current = nextWorkspaceHydrationNonce;
			// 同一 tick 里紧接着到达的下一份快照（建卡确认与广播常前后脚）要拿水合后的 board 做判定，不等重渲染。
			latestLocalBoardRef.current = input.hydratedBoard;
			setBoard(input.hydratedBoard);
			setLatestWorkspaceBoardHydrationFromRuntime({
				workspaceHydrationNonce: nextWorkspaceHydrationNonce,
				boardAcknowledgedByRuntime: input.boardAcknowledgedByRuntime,
				hydratedBoardContainsLocalChangesNotYetPersistedByRuntime:
					input.hydratedBoardContainsLocalChangesNotYetPersistedByRuntime,
			});
			setWorkspaceHydrationNonce(nextWorkspaceHydrationNonce);
		},
		[setBoard],
	);

	// 远端 board 按三方规则吸收进本地 board，并把它记为 runtime 最近确认的基线。基线为 null（头一份快照、
	// 或尚无基线）时直接采纳远端。
	const absorbRemoteBoardThroughThreeWayReconciliation = useCallback(
		(input: { boardLastAcknowledgedByRuntime: BoardData | null; remoteBoard: BoardData }) => {
			const { remoteBoard } = input;
			const reconciliation =
				input.boardLastAcknowledgedByRuntime === null
					? ({ reconciliationKind: "adopt_remote_board_because_local_board_has_no_unsaved_changes" } as const)
					: reconcileLocalBoardAfterRemoteWorkspaceRevisionAdvance({
							boardLastAcknowledgedByRuntime: input.boardLastAcknowledgedByRuntime,
							localBoard: latestLocalBoardRef.current,
							remoteBoard,
						});
			switch (reconciliation.reconciliationKind) {
				case "local_board_already_equals_remote_board":
					// 保留本地引用（不触发重渲染），但仍记为一次水合：持久化据此把本地视为已落盘，不再重发。
					hydrateBoardFromRuntime({
						hydratedBoard: latestLocalBoardRef.current,
						boardAcknowledgedByRuntime: remoteBoard,
						hydratedBoardContainsLocalChangesNotYetPersistedByRuntime: false,
					});
					break;
				case "adopt_remote_board_because_local_board_has_no_unsaved_changes":
					hydrateBoardFromRuntime({
						hydratedBoard: remoteBoard,
						boardAcknowledgedByRuntime: remoteBoard,
						hydratedBoardContainsLocalChangesNotYetPersistedByRuntime: false,
					});
					break;
				case "keep_local_board_because_remote_board_changes_are_already_in_local_board":
					// 只前进 revision 与基线：持久化 effect 随 revision 变化以新 revision 重发本地改动。
					break;
				case "adopt_remote_board_merged_with_local_unsaved_changes":
					hydrateBoardFromRuntime({
						hydratedBoard: reconciliation.reconciledBoard,
						boardAcknowledgedByRuntime: remoteBoard,
						hydratedBoardContainsLocalChangesNotYetPersistedByRuntime:
							reconciliation.reconciledBoardContainsLocalChangesNotYetPersistedByRuntime,
					});
					if (reconciliation.conflictingLocalUnsavedChangesWereDiscarded) {
						onLocalUnsavedBoardChangesDiscardedByRemoteBoardChangeRef.current?.();
					}
					break;
			}
			boardLastAcknowledgedByRuntimeRef.current = { projectId: currentProjectId, board: remoteBoard };
		},
		[currentProjectId, hydrateBoardFromRuntime],
	);

	const applyWorkspaceState = useCallback(
		(nextWorkspaceState: RuntimeWorkspaceStateResponse | null) => {
			if (!nextWorkspaceState) {
				setCanPersistWorkspaceState(false);
				setWorkspacePath(null);
				setWorkspaceGit(null);
				setAppliedWorkspaceProjectId(null);
				setBoard(createInitialBoardData());
				setSessions({});
				setWorkspaceRevision(null);
				boardLastAcknowledgedByRuntimeRef.current = null;
				workspaceVersionRef.current = {
					projectId: currentProjectId,
					revision: null,
				};
				return;
			}
			const currentVersion = workspaceVersionRef.current;
			const isSameProject = currentVersion.projectId === currentProjectId;
			const currentRevision = isSameProject ? currentVersion.revision : null;
			if (isSameProject && currentRevision !== null && nextWorkspaceState.revision < currentRevision) {
				return;
			}
			// 头一份快照（首屏、或切项目后 reset 过）：丢掉快照里没有的 key（别的项目留下的），快照里有的 key
			// 仍按 updatedAt 取较新者（保住 reset 后经旁路 applier 先到的本项目更新），见上方函数注释。
			const isFirstWorkspaceSnapshotForThisProject = !isSameProject || currentRevision === null;
			setWorkspacePath(nextWorkspaceState.repoPath);
			setWorkspaceGit(nextWorkspaceState.git);
			setSessions((currentSessions) => {
				const incomingSessions = nextWorkspaceState.sessions ?? {};
				return isFirstWorkspaceSnapshotForThisProject
					? restrictTaskSessionSummariesToFirstWorkspaceSnapshotKeepingNewerSummaryPerTask(
							currentSessions,
							incomingSessions,
						)
					: mergeTaskSessionSummaries(currentSessions, incomingSessions);
			});
			if (isFirstWorkspaceSnapshotForThisProject || currentRevision !== nextWorkspaceState.revision) {
				const remoteBoard = normalizeBoardData(nextWorkspaceState.board) ?? createInitialBoardData();
				const boardLastAcknowledgedByRuntime =
					boardLastAcknowledgedByRuntimeRef.current?.projectId === currentProjectId
						? boardLastAcknowledgedByRuntimeRef.current.board
						: null;
				absorbRemoteBoardThroughThreeWayReconciliation({
					boardLastAcknowledgedByRuntime: isFirstWorkspaceSnapshotForThisProject
						? null
						: boardLastAcknowledgedByRuntime,
					remoteBoard,
				});
			}
			setWorkspaceRevision(nextWorkspaceState.revision);
			workspaceVersionRef.current = {
				projectId: currentProjectId,
				revision: nextWorkspaceState.revision,
			};
			setAppliedWorkspaceProjectId(currentProjectId);
			setCanPersistWorkspaceState(true);
		},
		[
			absorbRemoteBoardThroughThreeWayReconciliation,
			currentProjectId,
			setBoard,
			setCanPersistWorkspaceState,
			setSessions,
		],
	);

	const recordWorkspaceBoardSavedByRuntime = useCallback(
		(input: WorkspaceBoardSavedByRuntime) => {
			const currentVersion = workspaceVersionRef.current;
			if (input.workspaceId !== currentProjectId || currentVersion.projectId !== currentProjectId) {
				return;
			}
			// 保存响应可能晚于更新 revision 的推送到达：那时已经吸收过更新的远端状态，不能让基线与 revision 倒退。
			if (currentVersion.revision !== null && input.savedRevision < currentVersion.revision) {
				return;
			}
			const boardPersistedByRuntime =
				normalizeBoardData(input.boardPersistedByRuntimeInSaveResponse) ?? input.savedBoard;
			if (isDeepEqual(boardPersistedByRuntime, input.savedBoard)) {
				boardLastAcknowledgedByRuntimeRef.current = { projectId: currentProjectId, board: input.savedBoard };
			} else {
				// runtime 纠正了发出的 board：同 revision 的广播不会再进水合分支，所以这里就按三方规则吸收
				// （基线 = 发出的 board、远端 = runtime 实际落盘的 board），保存之后的本地新改动照常保留。
				absorbRemoteBoardThroughThreeWayReconciliation({
					boardLastAcknowledgedByRuntime: input.savedBoard,
					remoteBoard: boardPersistedByRuntime,
				});
			}
			workspaceVersionRef.current = { projectId: currentProjectId, revision: input.savedRevision };
			setWorkspaceRevision(input.savedRevision);
		},
		[absorbRemoteBoardThroughThreeWayReconciliation, currentProjectId],
	);

	// 建卡落盘确认返回的快照按同一套三方判定吸收：远端只多了自己建的卡时不覆盖本地，只前进 revision 与基线。
	useEffect(() => {
		return subscribeToWorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntime(
			({ workspaceId, workspaceStateAfterNewBacklogTaskCardsPersisted }) => {
				if (workspaceId !== currentProjectId || workspaceVersionRef.current.projectId !== currentProjectId) {
					return;
				}
				applyWorkspaceState(workspaceStateAfterNewBacklogTaskCardsPersisted);
			},
		);
	}, [applyWorkspaceState, currentProjectId]);

	// task_sessions_updated 旁路出口：summaries 不再经 stream reducer 新建 workspaceState（那条路会让
	// App 每批渲染两次），而是经这里注册的 applier 一次 setSessions 并入。与 reducer 时代共用同一条
	// 数组合并规则（含空壳守卫与 updatedAt 单调）。setSessions 身份稳定，整个挂载期注册一次即可；
	// 切项目时的清场在 resetWorkspaceSyncState（清空）与新项目头一份快照（丢掉快照里没有的 key）两处，与通道无关。
	useEffect(() => {
		const applier: StreamedTaskSessionSummariesApplier = (summaries) => {
			setSessions((currentSessions) => mergeStreamedTaskSessionSummaries(currentSessions, summaries));
		};
		streamedTaskSessionSummariesApplierRef.current = applier;
		return () => {
			if (streamedTaskSessionSummariesApplierRef.current === applier) {
				streamedTaskSessionSummariesApplierRef.current = null;
			}
		};
	}, [setSessions, streamedTaskSessionSummariesApplierRef]);

	const refreshWorkspaceState = useCallback(async () => {
		if (!currentProjectId) {
			return;
		}
		const requestId = workspaceRefreshRequestIdRef.current + 1;
		workspaceRefreshRequestIdRef.current = requestId;
		const requestedProjectId = currentProjectId;
		setIsWorkspaceStateRefreshing(true);
		try {
			const refreshed = await fetchWorkspaceState(requestedProjectId);
			if (
				workspaceRefreshRequestIdRef.current !== requestId ||
				workspaceVersionRef.current.projectId !== requestedProjectId
			) {
				return;
			}
			applyWorkspaceState(refreshed);
		} catch (error) {
			if (
				workspaceRefreshRequestIdRef.current !== requestId ||
				workspaceVersionRef.current.projectId !== requestedProjectId
			) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			notifyError(message);
		} finally {
			if (workspaceRefreshRequestIdRef.current === requestId) {
				setIsWorkspaceStateRefreshing(false);
			}
		}
	}, [applyWorkspaceState, currentProjectId]);

	const resetWorkspaceSyncState = useCallback(() => {
		workspaceRefreshRequestIdRef.current += 1;
		setCanPersistWorkspaceState(false);
		// 上一个项目的会话摘要不能带进下一个项目：整板保存会把整份 sessions 发给 runtime（cf427 的跨项目串写）。
		setSessions({});
		boardLastAcknowledgedByRuntimeRef.current = null;
		setWorkspaceRevision(null);
		setIsWorkspaceStateRefreshing(false);
		setAppliedWorkspaceProjectId(null);
		workspaceVersionRef.current = {
			projectId: currentProjectId,
			revision: null,
		};
	}, [currentProjectId, setCanPersistWorkspaceState, setSessions]);

	useEffect(() => {
		if (hasNoProjects) {
			applyWorkspaceState(null);
			return;
		}
		if (!streamedWorkspaceState) {
			return;
		}
		applyWorkspaceState(streamedWorkspaceState);
	}, [applyWorkspaceState, hasNoProjects, streamedWorkspaceState]);

	useEffect(() => {
		if (!hasReceivedSnapshot || !isDocumentVisible) {
			return;
		}
		void refreshWorkspaceState();
	}, [hasReceivedSnapshot, isDocumentVisible, refreshWorkspaceState]);

	return {
		workspacePath,
		workspaceGit,
		workspaceRevision,
		setWorkspaceRevision,
		workspaceHydrationNonce,
		latestWorkspaceBoardHydrationFromRuntime,
		recordWorkspaceBoardSavedByRuntime,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	};
}
