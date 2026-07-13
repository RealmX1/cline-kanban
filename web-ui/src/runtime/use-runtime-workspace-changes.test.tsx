import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskWorktreeMode, RuntimeWorkspaceChangesResponse } from "@/runtime/types";
import {
	type RuntimeWorkspaceChangesQueryPhase,
	useRuntimeWorkspaceChanges,
} from "@/runtime/use-runtime-workspace-changes";

const getChangesQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			getChanges: {
				query: getChangesQueryMock,
			},
		},
	}),
}));

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

function createWorkspaceChangesResponse(path: string): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/project",
		generatedAt: Date.now(),
		files: [
			{
				path,
				status: "modified",
				additions: 3,
				deletions: 1,
				oldText: "old line\n",
				newText: "new line\n",
			},
		],
	};
}

interface HookSnapshot {
	paths: string[];
	queryPhase: RuntimeWorkspaceChangesQueryPhase;
	isRequestInFlight: boolean;
	errorMessage: string | null;
	changes: RuntimeWorkspaceChangesResponse | null;
}

function HookHarness({
	taskId,
	workspaceId = "project-1",
	baseRef = "main",
	worktreeMode = null,
	stateVersion = 0,
	viewKey = null,
	clearOnViewTransition = true,
	pollIntervalMs = null,
	onSnapshot,
}: {
	taskId: string | null;
	workspaceId?: string | null;
	baseRef?: string | null;
	worktreeMode?: RuntimeTaskWorktreeMode | null;
	stateVersion?: number;
	viewKey?: string | null;
	clearOnViewTransition?: boolean;
	pollIntervalMs?: number | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const workspaceChanges = useRuntimeWorkspaceChanges(
		taskId,
		workspaceId,
		baseRef,
		worktreeMode,
		"working_copy",
		stateVersion,
		pollIntervalMs,
		viewKey,
		clearOnViewTransition,
	);

	useEffect(() => {
		onSnapshot({
			paths: workspaceChanges.changes?.files.map((file) => file.path) ?? [],
			queryPhase: workspaceChanges.queryPhase,
			isRequestInFlight: workspaceChanges.isRequestInFlight,
			errorMessage: workspaceChanges.error?.message ?? null,
			changes: workspaceChanges.changes,
		});
	}, [
		onSnapshot,
		workspaceChanges.changes,
		workspaceChanges.error,
		workspaceChanges.isRequestInFlight,
		workspaceChanges.queryPhase,
	]);

	return null;
}

describe("useRuntimeWorkspaceChanges", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		getChangesQueryMock.mockReset();
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

	it("forwards worktreeMode to the getChanges request for inplace tasks", async () => {
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("inplace.ts"));

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-inplace"
					worktreeMode="inplace"
					onSnapshot={() => {
						/* noop */
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(getChangesQueryMock).toHaveBeenCalledWith({
			taskId: "task-inplace",
			baseRef: "main",
			worktreeMode: "inplace",
			mode: "working_copy",
		});
	});

	it("omits worktreeMode from the getChanges request by default", async () => {
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("default.ts"));

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-default"
					onSnapshot={() => {
						/* noop */
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(getChangesQueryMock).toHaveBeenCalledTimes(1);
		expect(getChangesQueryMock.mock.calls[0]?.[0]).not.toHaveProperty("worktreeMode");
	});

	it("keeps the same changes reference when a poll returns content-identical files (dedup)", async () => {
		// 两次响应文件内容完全相同，仅对象引用 / generatedAt 不同——模拟 1s 轮询在工作树未变时的空转。
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("stable.ts"));
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("stable.ts"));

		const snapshots: HookSnapshot[] = [];
		const onSnapshot = (snapshot: HookSnapshot) => {
			snapshots.push(snapshot);
		};

		await act(async () => {
			root.render(<HookHarness taskId="task-a" stateVersion={0} onSnapshot={onSnapshot} />);
			await Promise.resolve();
		});

		const firstChangesRef = snapshots.at(-1)?.changes ?? null;
		expect(firstChangesRef).not.toBeNull();

		// stateVersion 递增触发 refetch；内容相同 → 应保留旧引用，绝不下发新对象。
		await act(async () => {
			root.render(<HookHarness taskId="task-a" stateVersion={1} onSnapshot={onSnapshot} />);
			await Promise.resolve();
		});

		expect(getChangesQueryMock).toHaveBeenCalledTimes(2);
		expect(snapshots.at(-1)?.changes).toBe(firstChangesRef);
	});

	it("replaces the changes reference when a poll returns different file content", async () => {
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("before.ts"));
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("after.ts"));

		const snapshots: HookSnapshot[] = [];
		const onSnapshot = (snapshot: HookSnapshot) => {
			snapshots.push(snapshot);
		};

		await act(async () => {
			root.render(<HookHarness taskId="task-a" stateVersion={0} onSnapshot={onSnapshot} />);
			await Promise.resolve();
		});

		const firstChangesRef = snapshots.at(-1)?.changes ?? null;

		await act(async () => {
			root.render(<HookHarness taskId="task-a" stateVersion={1} onSnapshot={onSnapshot} />);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)?.changes).not.toBe(firstChangesRef);
		expect(snapshots.at(-1)?.paths).toEqual(["after.ts"]);
	});

	it("clears the previous task diff immediately when switching tasks", async () => {
		const taskBDiffDeferred = createDeferred<RuntimeWorkspaceChangesResponse>();
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("task-a.ts"));
		getChangesQueryMock.mockImplementationOnce(() => taskBDiffDeferred.promise);

		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					onSnapshot={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: ["task-a.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
		});

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-b"
					onSnapshot={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: [],
			queryPhase: "initial_loading",
			isRequestInFlight: true,
		});

		await act(async () => {
			taskBDiffDeferred.resolve(createWorkspaceChangesResponse("task-b.ts"));
			await taskBDiffDeferred.promise;
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: ["task-b.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
		});
	});

	it("clears the previous diff immediately when the last-turn view key changes", async () => {
		const nextTurnDiffDeferred = createDeferred<RuntimeWorkspaceChangesResponse>();
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("turn-1.ts"));
		getChangesQueryMock.mockImplementationOnce(() => nextTurnDiffDeferred.promise);

		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					viewKey="awaiting_review:checkpoint-2:checkpoint-1"
					onSnapshot={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: ["turn-1.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
		});

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					viewKey="running:checkpoint-2:checkpoint-1"
					onSnapshot={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: [],
			queryPhase: "initial_loading",
			isRequestInFlight: true,
		});

		await act(async () => {
			nextTurnDiffDeferred.resolve(createWorkspaceChangesResponse("turn-2.ts"));
			await nextTurnDiffDeferred.promise;
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: ["turn-2.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
		});
	});

	it("keeps the previous diff visible during a view-key transition when requested", async () => {
		const nextTurnDiffDeferred = createDeferred<RuntimeWorkspaceChangesResponse>();
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("turn-1.ts"));
		getChangesQueryMock.mockImplementationOnce(() => nextTurnDiffDeferred.promise);

		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					viewKey="running:checkpoint-1:none"
					clearOnViewTransition={false}
					onSnapshot={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: ["turn-1.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
		});

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					viewKey="awaiting_review:checkpoint-2:checkpoint-1"
					clearOnViewTransition={false}
					onSnapshot={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: ["turn-1.ts"],
			queryPhase: "refreshing",
			isRequestInFlight: true,
		});

		await act(async () => {
			nextTurnDiffDeferred.resolve(createWorkspaceChangesResponse("turn-2.ts"));
			await nextTurnDiffDeferred.promise;
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: ["turn-2.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
		});
	});

	it("keeps an initial error stable while the automatic retry is in flight", async () => {
		vi.useFakeTimers();
		const retryResponse = createDeferred<RuntimeWorkspaceChangesResponse>();
		getChangesQueryMock.mockRejectedValueOnce(new Error("temporary changes failure"));
		getChangesQueryMock.mockImplementationOnce(() => retryResponse.promise);

		const snapshots: HookSnapshot[] = [];
		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-initial-error"
					pollIntervalMs={1_000}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			await Promise.resolve();
		});

		expect(snapshots.at(-1)).toMatchObject({
			paths: [],
			queryPhase: "initial_error",
			isRequestInFlight: false,
			errorMessage: "temporary changes failure",
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(snapshots.at(-1)).toMatchObject({
			paths: [],
			queryPhase: "initial_error",
			isRequestInFlight: true,
			errorMessage: "temporary changes failure",
		});

		await act(async () => {
			retryResponse.resolve(createWorkspaceChangesResponse("recovered.ts"));
			await retryResponse.promise;
		});
		expect(snapshots.at(-1)).toMatchObject({
			paths: ["recovered.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
			errorMessage: null,
		});
		vi.useRealTimers();
	});

	it("clears an earlier task error when transitioning to a different task", async () => {
		const nextTaskResponse = createDeferred<RuntimeWorkspaceChangesResponse>();
		getChangesQueryMock.mockRejectedValueOnce(new Error("task-a failed"));
		getChangesQueryMock.mockImplementationOnce(() => nextTaskResponse.promise);

		const snapshots: HookSnapshot[] = [];
		await act(async () => {
			root.render(<HookHarness taskId="task-a" onSnapshot={(snapshot) => snapshots.push(snapshot)} />);
			await Promise.resolve();
		});
		expect(snapshots.at(-1)).toMatchObject({
			queryPhase: "initial_error",
			errorMessage: "task-a failed",
		});

		await act(async () => {
			root.render(<HookHarness taskId="task-b" onSnapshot={(snapshot) => snapshots.push(snapshot)} />);
		});
		expect(snapshots.at(-1)).toMatchObject({
			paths: [],
			queryPhase: "initial_loading",
			isRequestInFlight: true,
			errorMessage: null,
		});

		await act(async () => {
			nextTaskResponse.resolve(createWorkspaceChangesResponse("task-b.ts"));
			await nextTaskResponse.promise;
		});
		expect(snapshots.at(-1)).toMatchObject({
			paths: ["task-b.ts"],
			queryPhase: "ready",
			errorMessage: null,
		});
	});

	it("retains the last successful changes through a failed poll and its retry", async () => {
		vi.useFakeTimers();
		const recoveryResponse = createDeferred<RuntimeWorkspaceChangesResponse>();
		getChangesQueryMock.mockResolvedValueOnce(createWorkspaceChangesResponse("last-good.ts"));
		getChangesQueryMock.mockRejectedValueOnce(new Error("poll failed"));
		getChangesQueryMock.mockImplementationOnce(() => recoveryResponse.promise);

		const snapshots: HookSnapshot[] = [];
		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-stale-after-error"
					pollIntervalMs={1_000}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			await Promise.resolve();
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(snapshots.at(-1)).toMatchObject({
			paths: ["last-good.ts"],
			queryPhase: "stale_after_refresh_error",
			isRequestInFlight: false,
			errorMessage: "poll failed",
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(snapshots.at(-1)).toMatchObject({
			paths: ["last-good.ts"],
			queryPhase: "stale_after_refresh_error",
			isRequestInFlight: true,
			errorMessage: "poll failed",
		});

		await act(async () => {
			recoveryResponse.resolve(createWorkspaceChangesResponse("recovered.ts"));
			await recoveryResponse.promise;
		});
		expect(snapshots.at(-1)).toMatchObject({
			paths: ["recovered.ts"],
			queryPhase: "ready",
			isRequestInFlight: false,
			errorMessage: null,
		});
		vi.useRealTimers();
	});

	it("distinguishes disabled collection from missing workspace query scope", async () => {
		const snapshots: HookSnapshot[] = [];
		await act(async () => {
			root.render(<HookHarness taskId={null} onSnapshot={(snapshot) => snapshots.push(snapshot)} />);
		});
		expect(snapshots.at(-1)?.queryPhase).toBe("disabled");

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-missing-workspace"
					workspaceId={null}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
		});
		expect(snapshots.at(-1)?.queryPhase).toBe("missing_workspace_scope");
		expect(getChangesQueryMock).not.toHaveBeenCalled();
	});

	it("waits for a slow poll to settle before scheduling the next poll", async () => {
		vi.useFakeTimers();
		const initialResponse = createDeferred<RuntimeWorkspaceChangesResponse>();
		const firstPollResponse = createDeferred<RuntimeWorkspaceChangesResponse>();
		getChangesQueryMock.mockImplementationOnce(() => initialResponse.promise);
		getChangesQueryMock.mockImplementationOnce(() => firstPollResponse.promise);
		getChangesQueryMock.mockResolvedValue(createWorkspaceChangesResponse("after-slow-poll.ts"));

		const snapshots: HookSnapshot[] = [];
		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-slow-poll"
					pollIntervalMs={1_000}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
			initialResponse.resolve(createWorkspaceChangesResponse("initial.ts"));
			await initialResponse.promise;
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(getChangesQueryMock).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(getChangesQueryMock).toHaveBeenCalledTimes(2);

		await act(async () => {
			firstPollResponse.resolve(createWorkspaceChangesResponse("slow-poll-finished.ts"));
			await firstPollResponse.promise;
		});
		expect(snapshots.at(-1)?.paths).toEqual(["slow-poll-finished.ts"]);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(getChangesQueryMock).toHaveBeenCalledTimes(3);
		vi.useRealTimers();
	});
});
