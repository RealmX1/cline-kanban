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
	// 本地 board / sessions 此刻装的是哪个项目的数据。与 currentProjectId 不同步的窗口真实存在：切项目时
	// currentProjectId 先于 board 换成目标项目（快照到达那一帧 board 仍是上一个项目的，applyWorkspaceState
	// 要到其后的 effect 里才 setBoard）。凡是「拿 board 里的卡 + currentProjectId 去做有副作用的事」的地方
	// （详情页挂终端），都必须先确认二者一致——taskId 跨项目会撞号，错配一帧就会在目标项目里给别人的卡建终端。
	// 与 isWorkspaceMetadataPending 不同：切项目开始时它不清空（board 里确实还是上一个项目的数据）。
	projectIdOwningHydratedBoard: string | null;
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
	const [projectIdOwningHydratedBoard, setProjectIdOwningHydratedBoard] = useState<string | null>(null);
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
	// 推流（task_sessions_updated）送来的每个任务的最新摘要，按所属项目记。换项目时快照整体替换 sessions，
	// 靠它把新项目已经推来的摘要带回去（见 applyWorkspaceState）。只记最近一个项目：推流一次只连一个项目，
	// 换项目即整份丢弃，所以条数以单个项目的任务数为上界。
	const latestStreamedSummariesByWorkspaceRef = useRef<{
		workspaceId: string | null;
		summaryByTaskId: Map<string, RuntimeTaskSessionSummary>;
	}>({ workspaceId: null, summaryByTaskId: new Map() });

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
			setProjectIdOwningHydratedBoard(currentProjectId);
			setLatestWorkspaceBoardHydrationFromRuntime({
				workspaceHydrationNonce: nextWorkspaceHydrationNonce,
				boardAcknowledgedByRuntime: input.boardAcknowledgedByRuntime,
				hydratedBoardContainsLocalChangesNotYetPersistedByRuntime:
					input.hydratedBoardContainsLocalChangesNotYetPersistedByRuntime,
			});
			setWorkspaceHydrationNonce(nextWorkspaceHydrationNonce);
		},
		[currentProjectId, setBoard],
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
				setProjectIdOwningHydratedBoard(null);
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
			// 头一份快照：换了项目，或切项目 reset 后（reset 时 currentProjectId 可能已是目标项目，只看 projectId 会漏判）。
			const isFirstWorkspaceSnapshotForThisProject = !isSameProject || currentRevision === null;
			setWorkspacePath(nextWorkspaceState.repoPath);
			setWorkspaceGit(nextWorkspaceState.git);
			const incomingSessions = nextWorkspaceState.sessions ?? {};
			if (!isFirstWorkspaceSnapshotForThisProject) {
				setSessions((currentSessions) => mergeTaskSessionSummaries(currentSessions, incomingSessions));
			} else {
				// 换了项目（或切项目 reset 后的头一份快照）就以快照为底整体替换，绝不与上一个项目的 sessions 合并：
				// taskId 只在一个项目内唯一，合并会让上一个项目的同号任务摘要按 updatedAt 胜出、残留下来（sessionStartedAt
				// 随之变化 → 终端被当成会话重启清屏），还会随下一次整板保存写进这个项目的 sessions.json（cf427 的跨项目串写）。
				// 本项目推流已经送来的摘要单独带回：推流批次与这次替换在 sessions 更新队列里谁先谁后不确定，先到的那批若被
				// 替换掉，比快照更新的摘要就丢了；而且必须取推流原件，不能从当前 sessions 里按 taskId 捞——那里的同号条目
				// 可能正是上一个项目的。
				const streamedSessionsOfThisProject =
					latestStreamedSummariesByWorkspaceRef.current.workspaceId === currentProjectId
						? Object.fromEntries(latestStreamedSummariesByWorkspaceRef.current.summaryByTaskId)
						: {};
				setSessions(() => mergeTaskSessionSummaries(incomingSessions, streamedSessionsOfThisProject));
			}
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
	// 切项目时的清场在新项目头一份快照（以快照为底整体替换，见 applyWorkspaceState）一处，与通道无关。
	useEffect(() => {
		const applier: StreamedTaskSessionSummariesApplier = (summaries, workspaceId) => {
			if (latestStreamedSummariesByWorkspaceRef.current.workspaceId !== workspaceId) {
				latestStreamedSummariesByWorkspaceRef.current = { workspaceId, summaryByTaskId: new Map() };
			}
			const { summaryByTaskId } = latestStreamedSummariesByWorkspaceRef.current;
			for (const summary of summaries) {
				const newestSummary = selectNewestTaskSessionSummary(summaryByTaskId.get(summary.taskId) ?? null, summary);
				if (newestSummary) {
					summaryByTaskId.set(summary.taskId, newestSummary);
				}
			}
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
		// sessions 不在这里清空：在途期间仍是上一个项目的（只渲染过渡外壳、也不保存），由新项目头一份快照整体替换。
		boardLastAcknowledgedByRuntimeRef.current = null;
		setWorkspaceRevision(null);
		setIsWorkspaceStateRefreshing(false);
		setAppliedWorkspaceProjectId(null);
		workspaceVersionRef.current = {
			projectId: currentProjectId,
			revision: null,
		};
	}, [currentProjectId, setCanPersistWorkspaceState]);

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
		projectIdOwningHydratedBoard,
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
