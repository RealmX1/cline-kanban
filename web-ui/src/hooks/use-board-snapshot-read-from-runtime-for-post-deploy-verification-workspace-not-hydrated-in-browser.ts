import { useCallback, useEffect, useRef, useState } from "react";

import { createInitialBoardData } from "@/data/board-data";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { fetchWorkspaceState } from "@/runtime/workspace-state-query";
import { normalizeBoardData } from "@/state/board-state";
import type { BoardData } from "@/types";
import { useDebouncedEffect, useInterval } from "@/utils/react-use";

/** PDV workspace 的 board 不在浏览器里时，面板条目卡体与 controller 判列读的那份 board（以及配套的会话摘要）。 */
export interface RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser {
	workspaceIdOwningRuntimeBoardSnapshot: string;
	boardReadFromRuntime: BoardData;
	taskSessionsReadFromRuntime: Record<string, RuntimeTaskSessionSummary>;
	workspacePathReadFromRuntime: string | null;
}

// 与 PDV 读模型同频：board 快照只供面板显示与「点完成核对」前的本地判列，移列前另有服务端复检。
const RUNTIME_BOARD_SNAPSHOT_OF_POST_DEPLOY_VERIFICATION_WORKSPACE_POLL_INTERVAL_MS = 30_000;
// EXPERIMENT_NODE: 该项目列计数变化后重读 board 快照的去抖间隔（400ms）——agent 连续移列时是否该放宽
const RUNTIME_BOARD_SNAPSHOT_REREAD_AFTER_COLUMN_MEMBERSHIP_CHANGE_HINT_DEBOUNCE_MS = 400;

function buildRuntimeBoardSnapshotFromWorkspaceStateResponse(
	workspaceId: string,
	response: Awaited<ReturnType<typeof fetchWorkspaceState>>,
): RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser {
	return {
		workspaceIdOwningRuntimeBoardSnapshot: workspaceId,
		boardReadFromRuntime: normalizeBoardData(response.board) ?? createInitialBoardData(),
		taskSessionsReadFromRuntime: response.sessions,
		workspacePathReadFromRuntime: response.repoPath,
	};
}

/**
 * 读 PDV workspace 的 board 快照（workspace.getState，只读）。`workspaceIdToReadBoardSnapshotFrom` 为 null（面板读的是
 * 浏览器里当前项目的 board）时不读。
 *
 * - 种子：调用方在当前项目 board 已水合时传入它；之后面板改读快照（例如在 All projects 里打开了别的项目的任务）而
 *   workspace 恰是它时，直接沿用这份，不闪加载态、不发请求。
 * - 刷新：workspace 变化立即读；可见时每 30s；隐藏→可见边沿；调用方给的「该项目列计数」提示变化后去抖重读
 *   （提示只用计数：项目摘要里 in_progress 明细的时间戳每个 PTY chunk 都变，拿整份摘要当提示会把请求打满）；
 *   完成核对移列后调用方显式 refetch。
 * - 防护：请求序号 + workspace 校验丢弃过期响应；读失败保留上一份；内容没变不 setState。
 */
export function useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser(input: {
	workspaceIdToReadBoardSnapshotFrom: string | null;
	runtimeBoardColumnMembershipChangeHintOfWorkspace: string | null;
	currentProjectBoardHydratedInBrowserForSeeding: RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser | null;
}): {
	runtimeBoardSnapshot: RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser | null;
	refetchRuntimeBoardSnapshot: () => void;
} {
	const {
		workspaceIdToReadBoardSnapshotFrom: workspaceId,
		runtimeBoardColumnMembershipChangeHintOfWorkspace: columnMembershipChangeHint,
		currentProjectBoardHydratedInBrowserForSeeding,
	} = input;
	const isDocumentVisible = useDocumentVisibility();
	const [loadedRuntimeBoardSnapshot, setLoadedRuntimeBoardSnapshot] =
		useState<RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser | null>(null);
	// 当前项目 board 最近一次水合后的样子；过渡窗口里调用方传 null，这里保留的仍是上一个已水合项目的。
	const latestCurrentProjectBoardSeedRef = useRef(currentProjectBoardHydratedInBrowserForSeeding);
	if (currentProjectBoardHydratedInBrowserForSeeding) {
		latestCurrentProjectBoardSeedRef.current = currentProjectBoardHydratedInBrowserForSeeding;
	}
	const requestedWorkspaceIdRef = useRef(workspaceId);
	requestedWorkspaceIdRef.current = workspaceId;
	const readRequestSequenceNumberRef = useRef(0);

	const readRuntimeBoardSnapshot = useCallback((targetWorkspaceId: string) => {
		readRequestSequenceNumberRef.current += 1;
		const readRequestSequenceNumber = readRequestSequenceNumberRef.current;
		fetchWorkspaceState(targetWorkspaceId).then(
			(response) => {
				if (
					readRequestSequenceNumber !== readRequestSequenceNumberRef.current ||
					requestedWorkspaceIdRef.current !== targetWorkspaceId
				) {
					return;
				}
				const nextRuntimeBoardSnapshot = buildRuntimeBoardSnapshotFromWorkspaceStateResponse(
					targetWorkspaceId,
					response,
				);
				setLoadedRuntimeBoardSnapshot((previousRuntimeBoardSnapshot) =>
					previousRuntimeBoardSnapshot !== null &&
					JSON.stringify(previousRuntimeBoardSnapshot) === JSON.stringify(nextRuntimeBoardSnapshot)
						? previousRuntimeBoardSnapshot
						: nextRuntimeBoardSnapshot,
				);
			},
			() => {
				// 读失败保留上一份快照：下一次轮询 / 提示变化再读。
			},
		);
	}, []);

	useEffect(() => {
		// 不论走哪条分支都让在途的旧读请求作废：它们的结果比种子旧。
		readRequestSequenceNumberRef.current += 1;
		if (!workspaceId) {
			// 面板改读浏览器里的 board：丢掉旧快照，免得之后切回快照模式时先闪一帧过时数据（那时有更新的种子）。
			setLoadedRuntimeBoardSnapshot(null);
			return;
		}
		const currentProjectBoardSeed = latestCurrentProjectBoardSeedRef.current;
		if (currentProjectBoardSeed?.workspaceIdOwningRuntimeBoardSnapshot === workspaceId) {
			setLoadedRuntimeBoardSnapshot(currentProjectBoardSeed);
			return;
		}
		readRuntimeBoardSnapshot(workspaceId);
	}, [readRuntimeBoardSnapshot, workspaceId]);

	useInterval(
		() => {
			if (workspaceId) {
				readRuntimeBoardSnapshot(workspaceId);
			}
		},
		workspaceId && isDocumentVisible
			? RUNTIME_BOARD_SNAPSHOT_OF_POST_DEPLOY_VERIFICATION_WORKSPACE_POLL_INTERVAL_MS
			: null,
	);

	const wasDocumentVisibleRef = useRef(isDocumentVisible);
	useEffect(() => {
		if (isDocumentVisible && !wasDocumentVisibleRef.current && workspaceId) {
			readRuntimeBoardSnapshot(workspaceId);
		}
		wasDocumentVisibleRef.current = isDocumentVisible;
	}, [isDocumentVisible, readRuntimeBoardSnapshot, workspaceId]);

	// 只在同一 workspace 的提示变化时重读：workspace 切换由上面的 effect 负责。
	const lastSeenColumnMembershipChangeHintRef = useRef({ workspaceId, columnMembershipChangeHint });
	useDebouncedEffect(
		() => {
			const lastSeen = lastSeenColumnMembershipChangeHintRef.current;
			lastSeenColumnMembershipChangeHintRef.current = { workspaceId, columnMembershipChangeHint };
			if (
				!workspaceId ||
				lastSeen.workspaceId !== workspaceId ||
				lastSeen.columnMembershipChangeHint === columnMembershipChangeHint
			) {
				return;
			}
			readRuntimeBoardSnapshot(workspaceId);
		},
		RUNTIME_BOARD_SNAPSHOT_REREAD_AFTER_COLUMN_MEMBERSHIP_CHANGE_HINT_DEBOUNCE_MS,
		[columnMembershipChangeHint, readRuntimeBoardSnapshot, workspaceId],
	);

	const refetchRuntimeBoardSnapshot = useCallback(() => {
		const targetWorkspaceId = requestedWorkspaceIdRef.current;
		if (targetWorkspaceId) {
			readRuntimeBoardSnapshot(targetWorkspaceId);
		}
	}, [readRuntimeBoardSnapshot]);

	let runtimeBoardSnapshot: RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser | null = null;
	if (workspaceId !== null) {
		if (loadedRuntimeBoardSnapshot?.workspaceIdOwningRuntimeBoardSnapshot === workspaceId) {
			runtimeBoardSnapshot = loadedRuntimeBoardSnapshot;
		} else if (latestCurrentProjectBoardSeedRef.current?.workspaceIdOwningRuntimeBoardSnapshot === workspaceId) {
			// 切到快照模式的那一帧（effect 尚未把种子落进 state）。
			runtimeBoardSnapshot = latestCurrentProjectBoardSeedRef.current;
		}
	}
	return { runtimeBoardSnapshot, refetchRuntimeBoardSnapshot };
}
