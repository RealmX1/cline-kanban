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
import type { BoardData } from "@/types";

interface UseWorkspaceSyncInput {
	currentProjectId: string | null;
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
	streamedWorkspaceState,
	streamedTaskSessionSummariesApplierRef,
	hasNoProjects,
	hasReceivedSnapshot,
	isDocumentVisible,
	setBoard,
	setSessions,
	setCanPersistWorkspaceState,
}: UseWorkspaceSyncInput): UseWorkspaceSyncResult {
	const [workspacePath, setWorkspacePath] = useState<string | null>(null);
	const [workspaceGit, setWorkspaceGit] = useState<RuntimeGitRepositoryInfo | null>(null);
	const [appliedWorkspaceProjectId, setAppliedWorkspaceProjectId] = useState<string | null>(null);
	const [projectIdOwningHydratedBoard, setProjectIdOwningHydratedBoard] = useState<string | null>(null);
	const [workspaceRevision, setWorkspaceRevision] = useState<number | null>(null);
	const [workspaceHydrationNonce, setWorkspaceHydrationNonce] = useState(0);
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
			setWorkspacePath(nextWorkspaceState.repoPath);
			setWorkspaceGit(nextWorkspaceState.git);
			const incomingSessions = nextWorkspaceState.sessions ?? {};
			if (isSameProject) {
				setSessions((currentSessions) => mergeTaskSessionSummaries(currentSessions, incomingSessions));
			} else {
				// 换了项目就以快照为底整体替换，绝不与上一个项目的 sessions 合并：taskId 只在一个项目内唯一，
				// 合并会让上一个项目的同号任务摘要按 updatedAt 胜出、残留下来（sessionStartedAt 随之变化 →
				// 终端被当成会话重启清屏）。本项目推流已经送来的摘要单独带回：推流批次与这次替换在 sessions
				// 更新队列里谁先谁后不确定，先到的那批若被替换掉，比快照更新的摘要就丢了；而且必须取推流原件，
				// 不能从当前 sessions 里按 taskId 捞——那里的同号条目可能正是上一个项目的。
				const streamedSessionsOfThisProject =
					latestStreamedSummariesByWorkspaceRef.current.workspaceId === currentProjectId
						? Object.fromEntries(latestStreamedSummariesByWorkspaceRef.current.summaryByTaskId)
						: {};
				setSessions(() => mergeTaskSessionSummaries(incomingSessions, streamedSessionsOfThisProject));
			}
			const shouldHydrateBoard = !isSameProject || currentRevision !== nextWorkspaceState.revision;
			if (shouldHydrateBoard) {
				const normalized = normalizeBoardData(nextWorkspaceState.board) ?? createInitialBoardData();
				setBoard(normalized);
				setProjectIdOwningHydratedBoard(currentProjectId);
				setWorkspaceHydrationNonce((current) => current + 1);
			}
			setWorkspaceRevision(nextWorkspaceState.revision);
			workspaceVersionRef.current = {
				projectId: currentProjectId,
				revision: nextWorkspaceState.revision,
			};
			setAppliedWorkspaceProjectId(currentProjectId);
			setCanPersistWorkspaceState(true);
		},
		[currentProjectId, setBoard, setCanPersistWorkspaceState, setSessions],
	);

	// task_sessions_updated 旁路出口：summaries 不再经 stream reducer 新建 workspaceState（那条路会让
	// App 每批渲染两次），而是经这里注册的 applier 一次 setSessions 并入。与 reducer 时代共用同一条
	// 数组合并规则（含空壳守卫与 updatedAt 单调）。setSessions 身份稳定，整个挂载期注册一次即可；
	// 切项目时的清场由 applyWorkspaceState(null) 走原有路径，与通道无关。
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
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	};
}
