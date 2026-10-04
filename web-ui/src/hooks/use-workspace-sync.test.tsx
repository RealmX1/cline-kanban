import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import {
	useWorkspaceSync,
	type WorkspaceBoardHydrationFromRuntime,
	type WorkspaceBoardSavedByRuntime,
} from "@/hooks/use-workspace-sync";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "@/runtime/types";
import type { StreamedTaskSessionSummariesApplierRef } from "@/runtime/use-runtime-state-stream";
import type { BoardData } from "@/types";

const fetchWorkspaceStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/workspace-state-query", () => ({
	fetchWorkspaceState: fetchWorkspaceStateMock,
}));

function createBoard(taskId: string): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: taskId,
						title: `Prompt ${taskId}`,
						prompt: `Prompt ${taskId}`,
						startInPlanMode: false,
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function createWorkspaceState(taskId: string, revision: number): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/tmp/project-a",
		statePath: "/tmp/project-a/.cline/kanban",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: [{ name: "main" }],
		},
		board: createBoard(taskId),
		sessions: {},
		revision,
	};
}

function createSessionSummary(
	taskId: string,
	updatedAt: number,
	finalMessage: string | null,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: finalMessage ? "awaiting_review" : "running",
		agentId: "cline",
		workspacePath: "/tmp/project-a",
		pid: null,
		startedAt: updatedAt - 100,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: finalMessage ? "hook" : null,
		exitCode: null,
		lastHookAt: updatedAt,
		latestHookActivity: finalMessage
			? {
					activityText: `Final: ${finalMessage}`,
					toolName: null,
					toolInputSummary: null,
					finalMessage,
					hookEventName: "agent_end",
					notificationType: null,
					source: "cline-sdk",
				}
			: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function createWorkspaceStateWithSessions(
	taskId: string,
	revision: number,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeWorkspaceStateResponse {
	return {
		...createWorkspaceState(taskId, revision),
		sessions,
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

interface HookSnapshot {
	projectIdOwningHydratedBoard: string | null;
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	canPersistWorkspaceState: boolean;
	workspaceRevision: number | null;
	workspaceHydrationNonce: number;
	latestWorkspaceBoardHydrationFromRuntime: WorkspaceBoardHydrationFromRuntime | null;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	recordWorkspaceBoardSavedByRuntime: (input: WorkspaceBoardSavedByRuntime) => void;
	refreshWorkspaceState: () => Promise<void>;
	resetWorkspaceSyncState: () => void;
}

function HookHarness({
	currentProjectId = "project-a",
	streamedWorkspaceState,
	streamedTaskSessionSummariesApplierRef,
	hasReceivedSnapshot = true,
	isDocumentVisible = false,
	onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange,
	onSnapshot,
}: {
	currentProjectId?: string;
	streamedWorkspaceState: RuntimeWorkspaceStateResponse | null;
	streamedTaskSessionSummariesApplierRef: StreamedTaskSessionSummariesApplierRef;
	hasReceivedSnapshot?: boolean;
	isDocumentVisible?: boolean;
	onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange?: () => void;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const {
		projectIdOwningHydratedBoard,
		workspaceRevision,
		workspaceHydrationNonce,
		latestWorkspaceBoardHydrationFromRuntime,
		recordWorkspaceBoardSavedByRuntime,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	} = useWorkspaceSync({
		currentProjectId,
		board,
		streamedWorkspaceState,
		streamedTaskSessionSummariesApplierRef,
		hasNoProjects: false,
		hasReceivedSnapshot,
		isDocumentVisible,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
		onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange,
	});

	useEffect(() => {
		onSnapshot({
			projectIdOwningHydratedBoard,
			board,
			sessions,
			canPersistWorkspaceState,
			workspaceRevision,
			workspaceHydrationNonce,
			latestWorkspaceBoardHydrationFromRuntime,
			setBoard,
			recordWorkspaceBoardSavedByRuntime,
			refreshWorkspaceState,
			resetWorkspaceSyncState,
		});
	}, [
		board,
		canPersistWorkspaceState,
		latestWorkspaceBoardHydrationFromRuntime,
		onSnapshot,
		projectIdOwningHydratedBoard,
		recordWorkspaceBoardSavedByRuntime,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
		sessions,
		workspaceHydrationNonce,
		workspaceRevision,
	]);

	return null;
}

describe("useWorkspaceSync", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchWorkspaceStateMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("ignores a stale refresh response after the sync state is reset during a project transition", async () => {
		const deferred = createDeferred<RuntimeWorkspaceStateResponse>();
		fetchWorkspaceStateMock.mockReturnValue(deferred.promise);

		let latestSnapshot: HookSnapshot | null = null;
		let refreshPromise: Promise<void> | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceState("persisted-task", 1)}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an initial hook snapshot.");
		}
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.board.columns[0]?.cards[0]?.id).toBe("persisted-task");
		expect(initialSnapshot.canPersistWorkspaceState).toBe(true);

		await act(async () => {
			refreshPromise = initialSnapshot.refreshWorkspaceState();
		});

		await act(async () => {
			initialSnapshot.resetWorkspaceSyncState();
		});

		await act(async () => {
			deferred.resolve(createWorkspaceState("stale-task", 1));
			await refreshPromise;
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const snapshot: HookSnapshot = latestSnapshot;
		expect(snapshot.board.columns[0]?.cards[0]?.id).toBe("persisted-task");
		expect(snapshot.board.columns[0]?.cards[0]?.id).not.toBe("stale-task");
	});

	it("preserves newer in-memory task session summaries when refreshed workspace state lacks them", async () => {
		const existingSummary = createSessionSummary("task-1", 1000, "All done");
		fetchWorkspaceStateMock.mockResolvedValue(createWorkspaceState("persisted-task", 2));

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceStateWithSessions("persisted-task", 1, {
						"task-1": existingSummary,
					})}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an initial hook snapshot.");
		}
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.sessions["task-1"]?.latestHookActivity?.finalMessage).toBe("All done");

		await act(async () => {
			await initialSnapshot.refreshWorkspaceState();
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot after refresh.");
		}
		const refreshedSnapshot: HookSnapshot = latestSnapshot;
		expect(refreshedSnapshot.sessions["task-1"]?.latestHookActivity?.finalMessage).toBe("All done");
	});

	it("does not let an older streamed session summary overwrite a newer in-memory one", async () => {
		const newerRunningSummary = createSessionSummary("task-1", 2000, null);
		const staleInterruptedSummary = createSessionSummary("task-1", 1000, "Stale output");

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceStateWithSessions("persisted-task", 1, {
						"task-1": newerRunningSummary,
					})}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an initial hook snapshot.");
		}
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
		expect(initialSnapshot.sessions["task-1"]?.state).toBe("running");

		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceStateWithSessions("persisted-task", 2, {
						"task-1": staleInterruptedSummary,
					})}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot after rerender.");
		}
		const rerenderedSnapshot: HookSnapshot = latestSnapshot;
		expect(rerenderedSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
		expect(rerenderedSnapshot.sessions["task-1"]?.state).toBe("running");
		// 没有 key 被实际替换时合并返回入参原引用：sessions 对象引用不变。
		expect(rerenderedSnapshot.sessions).toBe(initialSnapshot.sessions);
	});

	it("does not refresh workspace state before the initial runtime snapshot resolves", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={null}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					hasReceivedSnapshot={false}
					isDocumentVisible={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		expect(fetchWorkspaceStateMock).not.toHaveBeenCalled();
		expect(latestSnapshot).not.toBeNull();
	});

	it("applies streamed task_sessions_updated summaries via the registered applier, stale batches keep the same reference", async () => {
		const applierRef: StreamedTaskSessionSummariesApplierRef = { current: null };
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceStateWithSessions("persisted-task", 1, {
						"task-1": createSessionSummary("task-1", 1000, null),
					})}
					streamedTaskSessionSummariesApplierRef={applierRef}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an initial hook snapshot.");
		}
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.sessions["task-1"]?.updatedAt).toBe(1000);
		if (!applierRef.current) {
			throw new Error("Expected the streamed task session summaries applier to be registered on mount.");
		}
		const applier = applierRef.current;

		// 旁路批次：一次 setSessions 并入——已有 key 按 updatedAt 单调更新，新 key 直接收录。
		await act(async () => {
			applier(
				[createSessionSummary("task-1", 2000, "All done"), createSessionSummary("task-2", 1500, null)],
				"project-a",
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot after applying streamed summaries.");
		}
		const afterUpdateSnapshot: HookSnapshot = latestSnapshot;
		expect(afterUpdateSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
		expect(afterUpdateSnapshot.sessions["task-1"]?.latestHookActivity?.finalMessage).toBe("All done");
		expect(afterUpdateSnapshot.sessions["task-2"]?.updatedAt).toBe(1500);

		// stale 批次（updatedAt 更旧）：没有 key 被替换，sessions 引用不变、不多渲染。
		const sessionsBeforeStaleBatch = afterUpdateSnapshot.sessions;
		await act(async () => {
			applier([createSessionSummary("task-1", 1500, "Stale output")], "project-a");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected the hook snapshot to survive a stale batch.");
		}
		const afterStaleSnapshot: HookSnapshot = latestSnapshot;
		expect(afterStaleSnapshot.sessions).toBe(sessionsBeforeStaleBatch);
		expect(afterStaleSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
	});

	describe("远端 revision 前进时本地 board 的三方判定（cf427）", () => {
		function withLocallyCreatedBacklogCard(board: BoardData, taskId: string): BoardData {
			return {
				...board,
				columns: board.columns.map((column) =>
					column.id === "backlog"
						? {
								...column,
								cards: [
									{
										id: taskId,
										title: `Created locally ${taskId}`,
										prompt: `Created locally ${taskId}`,
										startInPlanMode: false,
										baseRef: "main",
										createdAt: 50,
										updatedAt: 50,
									},
									...column.cards,
								],
							}
						: column,
				),
			};
		}

		function withRetitledCard(board: BoardData, taskId: string, title: string): BoardData {
			return {
				...board,
				columns: board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => (card.id === taskId ? { ...card, title } : card)),
				})),
			};
		}

		function listBacklogTaskCardIds(board: BoardData): string[] {
			return board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
		}

		async function renderWithStreamedState(input: {
			streamedWorkspaceState: RuntimeWorkspaceStateResponse;
			onDiscarded?: () => void;
			onSnapshot: (snapshot: HookSnapshot) => void;
		}): Promise<void> {
			await act(async () => {
				root.render(
					<HookHarness
						streamedWorkspaceState={input.streamedWorkspaceState}
						streamedTaskSessionSummariesApplierRef={{ current: null }}
						onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange={input.onDiscarded}
						onSnapshot={input.onSnapshot}
					/>,
				);
			});
		}

		it("revision 前进而远端 board 未变（只有 sessions 写入推了它）：保留本地新卡，只前进 revision，不提示", async () => {
			const onDiscarded = vi.fn();
			let latestSnapshot: HookSnapshot | null = null;
			const onSnapshot = (snapshot: HookSnapshot) => {
				latestSnapshot = snapshot;
			};
			await renderWithStreamedState({
				streamedWorkspaceState: createWorkspaceState("persisted-task", 1),
				onDiscarded,
				onSnapshot,
			});
			const initial = latestSnapshot as HookSnapshot | null;
			if (!initial) throw new Error("Expected an initial hook snapshot.");
			await act(async () => {
				initial.setBoard((current) => withLocallyCreatedBacklogCard(current, "new01"));
			});
			const nonceBeforeAdvance = (latestSnapshot as HookSnapshot | null)?.workspaceHydrationNonce;

			await renderWithStreamedState({
				streamedWorkspaceState: createWorkspaceState("persisted-task", 2),
				onDiscarded,
				onSnapshot,
			});

			const after = latestSnapshot as HookSnapshot | null;
			expect(after && listBacklogTaskCardIds(after.board)).toEqual(["new01", "persisted-task"]);
			expect(after?.workspaceRevision).toBe(2);
			// 不是水合：持久化不会跳过下一次保存，本地新卡随新 revision 重发。
			expect(after?.workspaceHydrationNonce).toBe(nonceBeforeAdvance);
			expect(onDiscarded).not.toHaveBeenCalled();
		});

		it("保存冲突后 refetch 拿到相同的远端 board：保留本地新卡、前进 revision、不提示", async () => {
			const onDiscarded = vi.fn();
			fetchWorkspaceStateMock.mockResolvedValue(createWorkspaceState("persisted-task", 3));
			let latestSnapshot: HookSnapshot | null = null;
			const onSnapshot = (snapshot: HookSnapshot) => {
				latestSnapshot = snapshot;
			};
			await renderWithStreamedState({
				streamedWorkspaceState: createWorkspaceState("persisted-task", 1),
				onDiscarded,
				onSnapshot,
			});
			const initial = latestSnapshot as HookSnapshot | null;
			if (!initial) throw new Error("Expected an initial hook snapshot.");
			await act(async () => {
				initial.setBoard((current) => withLocallyCreatedBacklogCard(current, "new01"));
			});
			await act(async () => {
				await (latestSnapshot as HookSnapshot | null)?.refreshWorkspaceState();
			});

			const after = latestSnapshot as HookSnapshot | null;
			expect(after && listBacklogTaskCardIds(after.board)).toEqual(["new01", "persisted-task"]);
			expect(after?.workspaceRevision).toBe(3);
			expect(onDiscarded).not.toHaveBeenCalled();
		});

		it("远端 board 真有变化：本地新卡按原位置并回远端 board，并标记这次水合之后必须保存", async () => {
			const onDiscarded = vi.fn();
			let latestSnapshot: HookSnapshot | null = null;
			const onSnapshot = (snapshot: HookSnapshot) => {
				latestSnapshot = snapshot;
			};
			await renderWithStreamedState({
				streamedWorkspaceState: createWorkspaceState("persisted-task", 1),
				onDiscarded,
				onSnapshot,
			});
			const initial = latestSnapshot as HookSnapshot | null;
			if (!initial) throw new Error("Expected an initial hook snapshot.");
			await act(async () => {
				initial.setBoard((current) => withLocallyCreatedBacklogCard(current, "new01"));
			});

			const remoteState = createWorkspaceState("persisted-task", 2);
			remoteState.board = withRetitledCard(remoteState.board, "persisted-task", "Renamed on another device");
			await renderWithStreamedState({ streamedWorkspaceState: remoteState, onDiscarded, onSnapshot });

			const after = latestSnapshot as HookSnapshot | null;
			expect(after && listBacklogTaskCardIds(after.board)).toEqual(["new01", "persisted-task"]);
			expect(after?.board.columns[0]?.cards[1]?.title).toBe("Renamed on another device");
			expect(after?.latestWorkspaceBoardHydrationFromRuntime).toMatchObject({
				workspaceHydrationNonce: after?.workspaceHydrationNonce,
				hydratedBoardContainsLocalChangesNotYetPersistedByRuntime: true,
			});
			expect(
				after &&
					listBacklogTaskCardIds(
						after.latestWorkspaceBoardHydrationFromRuntime?.boardAcknowledgedByRuntime ?? after.board,
					),
			).toEqual(["persisted-task"]);
			expect(onDiscarded).not.toHaveBeenCalled();
		});

		it("远端 board 真有变化且本地改过已有卡：以远端为准并提示被丢弃", async () => {
			const onDiscarded = vi.fn();
			let latestSnapshot: HookSnapshot | null = null;
			const onSnapshot = (snapshot: HookSnapshot) => {
				latestSnapshot = snapshot;
			};
			await renderWithStreamedState({
				streamedWorkspaceState: createWorkspaceState("persisted-task", 1),
				onDiscarded,
				onSnapshot,
			});
			const initial = latestSnapshot as HookSnapshot | null;
			if (!initial) throw new Error("Expected an initial hook snapshot.");
			await act(async () => {
				initial.setBoard((current) => withRetitledCard(current, "persisted-task", "Renamed locally"));
			});

			const remoteState = createWorkspaceState("persisted-task", 2);
			remoteState.board = withRetitledCard(remoteState.board, "persisted-task", "Renamed on another device");
			await renderWithStreamedState({ streamedWorkspaceState: remoteState, onDiscarded, onSnapshot });

			const after = latestSnapshot as HookSnapshot | null;
			expect(after?.board.columns[0]?.cards[0]?.title).toBe("Renamed on another device");
			expect(
				after?.latestWorkspaceBoardHydrationFromRuntime?.hydratedBoardContainsLocalChangesNotYetPersistedByRuntime,
			).toBe(false);
			expect(onDiscarded).toHaveBeenCalledOnce();
		});

		it("整板保存成功后，发出的那份 board 成为基线：之后远端只推 revision 时本地无未保存改动、直接采纳", async () => {
			let latestSnapshot: HookSnapshot | null = null;
			const onSnapshot = (snapshot: HookSnapshot) => {
				latestSnapshot = snapshot;
			};
			await renderWithStreamedState({
				streamedWorkspaceState: createWorkspaceState("persisted-task", 1),
				onSnapshot,
			});
			const initial = latestSnapshot as HookSnapshot | null;
			if (!initial) throw new Error("Expected an initial hook snapshot.");
			const savedBoard = withLocallyCreatedBacklogCard(initial.board, "new01");
			await act(async () => {
				initial.setBoard(savedBoard);
			});
			await act(async () => {
				(latestSnapshot as HookSnapshot | null)?.recordWorkspaceBoardSavedByRuntime({
					workspaceId: "project-a",
					savedBoard,
					savedRevision: 2,
				});
			});
			expect((latestSnapshot as HookSnapshot | null)?.workspaceRevision).toBe(2);
			// 迟到的保存响应不能让 revision 倒退。
			await act(async () => {
				(latestSnapshot as HookSnapshot | null)?.recordWorkspaceBoardSavedByRuntime({
					workspaceId: "project-a",
					savedBoard: initial.board,
					savedRevision: 1,
				});
			});
			expect((latestSnapshot as HookSnapshot | null)?.workspaceRevision).toBe(2);

			// 远端（另一个设备）删掉了 new01：本地相对基线没有未保存改动，采纳远端。
			await renderWithStreamedState({
				streamedWorkspaceState: createWorkspaceState("persisted-task", 3),
				onSnapshot,
			});
			const after = latestSnapshot as HookSnapshot | null;
			expect(after && listBacklogTaskCardIds(after.board)).toEqual(["persisted-task"]);
		});
	});

	// RVF-004：runtime 会纠正 incoming board（例如把已启动任务从 backlog 移回原列）。同 revision 的广播不会再进
	// 水合分支，所以保存响应里 runtime 实际落盘的 board 要在这里吸收，并成为之后三方判定的基线。
	it("保存响应里 runtime 纠正过的 board 被吸收进本地（保留保存之后的本地新卡），并成为之后的基线", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onSnapshot = (snapshot: HookSnapshot) => {
			latestSnapshot = snapshot;
		};
		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceState("persisted-task", 1)}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					onSnapshot={onSnapshot}
				/>,
			);
		});
		const initial = latestSnapshot as HookSnapshot | null;
		if (!initial) throw new Error("Expected an initial hook snapshot.");
		const boardSentInSave = initial.board;
		const boardPersistedByRuntime: BoardData = {
			...boardSentInSave,
			columns: boardSentInSave.columns.map((column) =>
				column.id === "backlog"
					? { ...column, cards: [] }
					: column.id === "in_progress"
						? { ...column, cards: boardSentInSave.columns[0]?.cards ?? [] }
						: column,
			),
		};
		// 保存发出之后、响应到达之前，本地又建了一张卡。
		await act(async () => {
			initial.setBoard((current) => ({
				...current,
				columns: current.columns.map((column) =>
					column.id === "backlog"
						? {
								...column,
								cards: [
									{
										id: "new01",
										title: "created after the save was sent",
										prompt: "created after the save was sent",
										startInPlanMode: false,
										baseRef: "main",
										createdAt: 60,
										updatedAt: 60,
									},
									...column.cards,
								],
							}
						: column,
				),
			}));
		});
		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.recordWorkspaceBoardSavedByRuntime({
				workspaceId: "project-a",
				savedBoard: boardSentInSave,
				savedRevision: 2,
				boardPersistedByRuntimeInSaveResponse: boardPersistedByRuntime,
			});
		});
		const afterSave = latestSnapshot as HookSnapshot | null;
		expect(afterSave?.workspaceRevision).toBe(2);
		const describeColumnsOf = (board: BoardData | undefined) =>
			board?.columns.map((column) => [column.id, column.cards.map((card) => card.id)]);
		// normalizeBoardData 会补齐缺省列（validation），所以按列 id 断言。
		expect(describeColumnsOf(afterSave?.board)).toEqual(
			expect.arrayContaining([
				["backlog", ["new01"]],
				["in_progress", ["persisted-task"]],
			]),
		);
		expect(
			afterSave?.latestWorkspaceBoardHydrationFromRuntime?.hydratedBoardContainsLocalChangesNotYetPersistedByRuntime,
		).toBe(true);
		expect(
			describeColumnsOf(afterSave?.latestWorkspaceBoardHydrationFromRuntime?.boardAcknowledgedByRuntime),
		).toEqual(
			expect.arrayContaining([
				["backlog", []],
				["in_progress", ["persisted-task"]],
			]),
		);
	});

	it("切项目 reset 后的头一份快照以快照为底整体替换 sessions，不与上一个项目的合并（cf427 跨项目串写）", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onSnapshot = (snapshot: HookSnapshot) => {
			latestSnapshot = snapshot;
		};
		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceStateWithSessions("persisted-task", 4, {
						"task-from-previous-project": createSessionSummary("task-from-previous-project", 1000, null),
					})}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					onSnapshot={onSnapshot}
				/>,
			);
		});
		expect(Object.keys((latestSnapshot as HookSnapshot | null)?.sessions ?? {})).toEqual([
			"task-from-previous-project",
		]);

		// reset 时 currentProjectId 已是目标项目：只看 projectId 会把头一份快照当成同项目合并。
		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.resetWorkspaceSyncState();
		});
		// 在途期间不清空（只渲染过渡外壳、也不保存），由头一份快照整体替换。
		expect(Object.keys((latestSnapshot as HookSnapshot | null)?.sessions ?? {})).toEqual([
			"task-from-previous-project",
		]);

		await act(async () => {
			root.render(
				<HookHarness
					streamedWorkspaceState={createWorkspaceStateWithSessions("persisted-task", 1, {
						"task-of-this-project": createSessionSummary("task-of-this-project", 500, null),
					})}
					streamedTaskSessionSummariesApplierRef={{ current: null }}
					onSnapshot={onSnapshot}
				/>,
			);
		});
		expect(Object.keys((latestSnapshot as HookSnapshot | null)?.sessions ?? {})).toEqual(["task-of-this-project"]);
	});

	it("换项目时以新项目快照整体替换 sessions：上一个项目的同号任务摘要不残留，新项目先到的推流摘要保留", async () => {
		const applierRef: StreamedTaskSessionSummariesApplierRef = { current: null };
		let latestSnapshot: HookSnapshot | null = null;
		const onSnapshot = (snapshot: HookSnapshot) => {
			latestSnapshot = snapshot;
		};
		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedWorkspaceState={createWorkspaceStateWithSessions("a-task", 1, {
						// 上一个项目里的同号任务，updatedAt 比新项目的还新——合并会让它胜出。
						"shared-task": createSessionSummary("shared-task", 9000, "from project a"),
					})}
					streamedTaskSessionSummariesApplierRef={applierRef}
					onSnapshot={onSnapshot}
				/>,
			);
		});
		expect((latestSnapshot as HookSnapshot | null)?.projectIdOwningHydratedBoard).toBe("project-a");

		// 切到 B：快照到达那一帧（还没 apply）board 仍属于 A。
		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-b"
					streamedWorkspaceState={null}
					streamedTaskSessionSummariesApplierRef={applierRef}
					onSnapshot={onSnapshot}
				/>,
			);
		});
		expect((latestSnapshot as HookSnapshot | null)?.projectIdOwningHydratedBoard).toBe("project-a");

		// B 的推流批次比 B 快照的 apply 先进 sessions 更新队列。
		await act(async () => {
			applierRef.current?.([createSessionSummary("b-streamed-task", 5000, "from project b stream")], "project-b");
		});
		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-b"
					streamedWorkspaceState={createWorkspaceStateWithSessions("b-task", 1, {
						"shared-task": createSessionSummary("shared-task", 2000, "from project b"),
					})}
					streamedTaskSessionSummariesApplierRef={applierRef}
					onSnapshot={onSnapshot}
				/>,
			);
		});

		const afterSwitch = latestSnapshot as HookSnapshot | null;
		expect(afterSwitch?.projectIdOwningHydratedBoard).toBe("project-b");
		expect(afterSwitch?.sessions["shared-task"]?.latestHookActivity?.finalMessage).toBe("from project b");
		expect(afterSwitch?.sessions["b-streamed-task"]?.updatedAt).toBe(5000);
	});
});
