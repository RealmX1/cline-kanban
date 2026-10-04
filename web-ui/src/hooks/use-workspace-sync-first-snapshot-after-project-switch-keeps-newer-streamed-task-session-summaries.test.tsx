import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "@/runtime/types";
import type { StreamedTaskSessionSummariesApplierRef } from "@/runtime/use-runtime-state-stream";
import type { BoardData } from "@/types";

const fetchWorkspaceStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/workspace-state-query", () => ({
	fetchWorkspaceState: fetchWorkspaceStateMock,
}));

function createWorkspaceStateWithSessions(
	projectRepoPath: string,
	revision: number,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: projectRepoPath,
		statePath: `${projectRepoPath}/.cline/kanban`,
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: [{ name: "main" }],
		},
		board: createInitialBoardData(),
		sessions,
		revision,
	};
}

function createSessionSummary(
	taskId: string,
	projectRepoPath: string,
	updatedAt: number,
	finalMessage: string | null,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: finalMessage ? "awaiting_review" : "running",
		agentId: "cline",
		workspacePath: projectRepoPath,
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

interface WorkspaceSyncHookSnapshotForProjectSwitchTest {
	sessions: Record<string, RuntimeTaskSessionSummary>;
	resetWorkspaceSyncState: () => void;
}

function WorkspaceSyncHookHarnessWithSwitchableProject({
	currentProjectId,
	streamedWorkspaceState,
	streamedTaskSessionSummariesApplierRef,
	onSnapshot,
}: {
	currentProjectId: string;
	streamedWorkspaceState: RuntimeWorkspaceStateResponse | null;
	streamedTaskSessionSummariesApplierRef: StreamedTaskSessionSummariesApplierRef;
	onSnapshot: (snapshot: WorkspaceSyncHookSnapshotForProjectSwitchTest) => void;
}): null {
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [, setCanPersistWorkspaceState] = useState(false);
	const { resetWorkspaceSyncState } = useWorkspaceSync({
		currentProjectId,
		board,
		streamedWorkspaceState,
		streamedTaskSessionSummariesApplierRef,
		hasNoProjects: false,
		hasReceivedSnapshot: true,
		isDocumentVisible: false,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
	});

	useEffect(() => {
		onSnapshot({ sessions, resetWorkspaceSyncState });
	}, [onSnapshot, resetWorkspaceSyncState, sessions]);

	return null;
}

describe("useWorkspaceSync first workspace snapshot after a project switch", () => {
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

	it("keeps newer streamed summaries that arrived after reset over older ones in the first snapshot, and drops the previous project's entries", async () => {
		const previousProjectRepoPath = "/tmp/previous-project";
		const nextProjectRepoPath = "/tmp/next-project";
		const streamedTaskSessionSummariesApplierRef: StreamedTaskSessionSummariesApplierRef = { current: null };
		let latestSnapshot: WorkspaceSyncHookSnapshotForProjectSwitchTest | null = null;
		const recordSnapshot = (snapshot: WorkspaceSyncHookSnapshotForProjectSwitchTest) => {
			latestSnapshot = snapshot;
		};

		await act(async () => {
			root.render(
				<WorkspaceSyncHookHarnessWithSwitchableProject
					currentProjectId="previous-project"
					streamedWorkspaceState={createWorkspaceStateWithSessions(previousProjectRepoPath, 7, {
						"previous-project-task": createSessionSummary(
							"previous-project-task",
							previousProjectRepoPath,
							500,
							null,
						),
					})}
					streamedTaskSessionSummariesApplierRef={streamedTaskSessionSummariesApplierRef}
					onSnapshot={recordSnapshot}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an initial hook snapshot.");
		}
		const snapshotOnPreviousProject: WorkspaceSyncHookSnapshotForProjectSwitchTest = latestSnapshot;
		expect(Object.keys(snapshotOnPreviousProject.sessions)).toEqual(["previous-project-task"]);
		const streamedTaskSessionSummariesApplier = streamedTaskSessionSummariesApplierRef.current;
		if (!streamedTaskSessionSummariesApplier) {
			throw new Error("Expected the streamed task session summaries applier to be registered on mount.");
		}

		// 切项目：清场。
		await act(async () => {
			snapshotOnPreviousProject.resetWorkspaceSyncState();
		});

		// reset 之后、新项目头一份快照被吸收之前，旁路 applier 先后并入：上一个项目尾巴上的一批（推流尚未切走），
		// 以及新项目里比头一份快照更新的一批。
		await act(async () => {
			streamedTaskSessionSummariesApplier([
				createSessionSummary("previous-project-task", previousProjectRepoPath, 900, "Previous project output"),
			]);
			streamedTaskSessionSummariesApplier([
				createSessionSummary("next-project-task", nextProjectRepoPath, 2000, "Newer streamed output"),
			]);
		});

		// 新项目头一份快照到达，里面是同一张卡较旧的 summary。
		await act(async () => {
			root.render(
				<WorkspaceSyncHookHarnessWithSwitchableProject
					currentProjectId="next-project"
					streamedWorkspaceState={createWorkspaceStateWithSessions(nextProjectRepoPath, 1, {
						"next-project-task": createSessionSummary("next-project-task", nextProjectRepoPath, 1000, null),
					})}
					streamedTaskSessionSummariesApplierRef={streamedTaskSessionSummariesApplierRef}
					onSnapshot={recordSnapshot}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot after the first snapshot of the next project.");
		}
		const snapshotAfterFirstSnapshotOfNextProject: WorkspaceSyncHookSnapshotForProjectSwitchTest = latestSnapshot;
		expect(Object.keys(snapshotAfterFirstSnapshotOfNextProject.sessions)).toEqual(["next-project-task"]);
		expect(snapshotAfterFirstSnapshotOfNextProject.sessions["next-project-task"]?.updatedAt).toBe(2000);
		expect(
			snapshotAfterFirstSnapshotOfNextProject.sessions["next-project-task"]?.latestHookActivity?.finalMessage,
		).toBe("Newer streamed output");
		expect(snapshotAfterFirstSnapshotOfNextProject.sessions["previous-project-task"]).toBeUndefined();
	});

	it("takes the first snapshot's summary when it is newer than the one streamed in after reset", async () => {
		const nextProjectRepoPath = "/tmp/next-project";
		const streamedTaskSessionSummariesApplierRef: StreamedTaskSessionSummariesApplierRef = { current: null };
		let latestSnapshot: WorkspaceSyncHookSnapshotForProjectSwitchTest | null = null;
		const recordSnapshot = (snapshot: WorkspaceSyncHookSnapshotForProjectSwitchTest) => {
			latestSnapshot = snapshot;
		};

		await act(async () => {
			root.render(
				<WorkspaceSyncHookHarnessWithSwitchableProject
					currentProjectId="previous-project"
					streamedWorkspaceState={null}
					streamedTaskSessionSummariesApplierRef={streamedTaskSessionSummariesApplierRef}
					onSnapshot={recordSnapshot}
				/>,
			);
		});

		const streamedTaskSessionSummariesApplier = streamedTaskSessionSummariesApplierRef.current;
		if (latestSnapshot === null || !streamedTaskSessionSummariesApplier) {
			throw new Error("Expected an initial hook snapshot and a registered applier.");
		}
		const initialSnapshot: WorkspaceSyncHookSnapshotForProjectSwitchTest = latestSnapshot;

		await act(async () => {
			initialSnapshot.resetWorkspaceSyncState();
		});
		await act(async () => {
			streamedTaskSessionSummariesApplier([
				createSessionSummary("next-project-task", nextProjectRepoPath, 1000, "Older streamed output"),
			]);
		});
		await act(async () => {
			root.render(
				<WorkspaceSyncHookHarnessWithSwitchableProject
					currentProjectId="next-project"
					streamedWorkspaceState={createWorkspaceStateWithSessions(nextProjectRepoPath, 1, {
						"next-project-task": createSessionSummary(
							"next-project-task",
							nextProjectRepoPath,
							3000,
							"Snapshot output",
						),
					})}
					streamedTaskSessionSummariesApplierRef={streamedTaskSessionSummariesApplierRef}
					onSnapshot={recordSnapshot}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot after the first snapshot of the next project.");
		}
		const snapshotAfterFirstSnapshotOfNextProject: WorkspaceSyncHookSnapshotForProjectSwitchTest = latestSnapshot;
		expect(snapshotAfterFirstSnapshotOfNextProject.sessions["next-project-task"]?.updatedAt).toBe(3000);
		expect(
			snapshotAfterFirstSnapshotOfNextProject.sessions["next-project-task"]?.latestHookActivity?.finalMessage,
		).toBe("Snapshot output");
	});
});
