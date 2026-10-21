import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import {
	type RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser,
	useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser,
} from "@/hooks/use-board-snapshot-read-from-runtime-for-post-deploy-verification-workspace-not-hydrated-in-browser";
import type { RuntimeWorkspaceStateResponse } from "@/runtime/types";
import type { BoardData } from "@/types";

interface Deferred<ValueType> {
	resolve: (value: ValueType) => void;
	reject: (error: unknown) => void;
}

const pendingFetchWorkspaceStateCalls = vi.hoisted(
	() => [] as Array<{ workspaceId: string; deferred: Deferred<RuntimeWorkspaceStateResponse> }>,
);
const fetchWorkspaceStateMock = vi.hoisted(() =>
	vi.fn(
		(workspaceId: string) =>
			new Promise<RuntimeWorkspaceStateResponse>((resolve, reject) => {
				pendingFetchWorkspaceStateCalls.push({ workspaceId, deferred: { resolve, reject } });
			}),
	),
);
vi.mock("@/runtime/workspace-state-query", () => ({
	fetchWorkspaceState: fetchWorkspaceStateMock,
}));

const documentVisibility = vi.hoisted(() => ({ isDocumentVisible: true }));
vi.mock("@/hooks/use-document-visibility", () => ({
	useDocumentVisibility: () => documentVisibility.isDocumentVisible,
}));

type HookInput = Parameters<
	typeof useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser
>[0];
type HookResult = ReturnType<
	typeof useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser
>;

let container: HTMLDivElement;
let root: Root;
let latestHookResult: HookResult | null = null;
let previousActEnvironment: boolean | undefined;

function HookHarness(props: HookInput): null {
	latestHookResult = useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser(props);
	return null;
}

function renderHookWith(input: HookInput): void {
	act(() => {
		root.render(<HookHarness {...input} />);
	});
}

function requireLatestHookResult(): HookResult {
	if (!latestHookResult) {
		throw new Error("hook 尚未渲染");
	}
	return latestHookResult;
}

function boardWithValidationCardTitled(title: string): BoardData {
	const board = createInitialBoardData();
	return {
		columns: board.columns.map((column) =>
			column.id === "validation"
				? {
						...column,
						cards: [
							{
								id: "task-1",
								title,
								prompt: title,
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					}
				: column,
		),
	};
}

function workspaceStateResponseWithBoard(board: BoardData, repoPath: string): RuntimeWorkspaceStateResponse {
	return {
		repoPath,
		statePath: `${repoPath}/.state`,
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board,
		sessions: {},
		revision: 1,
	} as unknown as RuntimeWorkspaceStateResponse;
}

async function resolveFetchWorkspaceStateCall(
	callIndex: number,
	response: RuntimeWorkspaceStateResponse,
): Promise<void> {
	const call = pendingFetchWorkspaceStateCalls[callIndex];
	if (!call) {
		throw new Error(
			`第 ${callIndex} 次 fetchWorkspaceState 调用不存在（共 ${pendingFetchWorkspaceStateCalls.length} 次）`,
		);
	}
	await act(async () => {
		call.deferred.resolve(response);
		await Promise.resolve();
	});
}

async function rejectFetchWorkspaceStateCall(callIndex: number): Promise<void> {
	const call = pendingFetchWorkspaceStateCalls[callIndex];
	if (!call) {
		throw new Error(`第 ${callIndex} 次 fetchWorkspaceState 调用不存在`);
	}
	await act(async () => {
		call.deferred.reject(new Error("runtime unavailable"));
		await Promise.resolve();
	});
}

function readTitleOfValidationCard(
	snapshot: RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser | null,
) {
	return snapshot?.boardReadFromRuntime.columns.find((column) => column.id === "validation")?.cards[0]?.title ?? null;
}

beforeEach(() => {
	vi.useFakeTimers();
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	latestHookResult = null;
	documentVisibility.isDocumentVisible = true;
	pendingFetchWorkspaceStateCalls.length = 0;
	fetchWorkspaceStateMock.mockClear();
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("useBoardSnapshotReadFromRuntimeForPostDeployVerificationWorkspaceNotHydratedInBrowser", () => {
	it("workspace 为 null（面板读浏览器里的 board）时不读", () => {
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: null,
			runtimeBoardColumnMembershipChangeHintOfWorkspace: null,
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(fetchWorkspaceStateMock).not.toHaveBeenCalled();
		expect(requireLatestHookResult().runtimeBoardSnapshot).toBeNull();
	});

	it("种子命中：切到快照模式时直接沿用当前项目已水合的 board，不发请求", () => {
		const seed: RuntimeBoardSnapshotOfPostDeployVerificationWorkspaceNotHydratedInBrowser = {
			workspaceIdOwningRuntimeBoardSnapshot: "cline-kanban",
			boardReadFromRuntime: boardWithValidationCardTitled("浏览器里的卡"),
			taskSessionsReadFromRuntime: {},
			workspacePathReadFromRuntime: "/repo/cline-kanban",
		};
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: null,
			runtimeBoardColumnMembershipChangeHintOfWorkspace: null,
			currentProjectBoardHydratedInBrowserForSeeding: seed,
		});
		// 过渡窗口：调用方不再给种子（board 还没换成新项目的），面板改读 cline-kanban 的快照。
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: "cline-kanban",
			runtimeBoardColumnMembershipChangeHintOfWorkspace: "{}",
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		expect(fetchWorkspaceStateMock).not.toHaveBeenCalled();
		expect(readTitleOfValidationCard(requireLatestHookResult().runtimeBoardSnapshot)).toBe("浏览器里的卡");
	});

	it("workspace 变化立即读；先发的旧 workspace 响应晚到时丢弃", async () => {
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: "project-a",
			runtimeBoardColumnMembershipChangeHintOfWorkspace: null,
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: "cline-kanban",
			runtimeBoardColumnMembershipChangeHintOfWorkspace: null,
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		expect(pendingFetchWorkspaceStateCalls.map((call) => call.workspaceId)).toEqual(["project-a", "cline-kanban"]);
		await resolveFetchWorkspaceStateCall(
			0,
			workspaceStateResponseWithBoard(boardWithValidationCardTitled("A 项目的同号卡"), "/repo/a"),
		);
		expect(requireLatestHookResult().runtimeBoardSnapshot).toBeNull();
		await resolveFetchWorkspaceStateCall(
			1,
			workspaceStateResponseWithBoard(boardWithValidationCardTitled("cline-kanban 的卡"), "/repo/cline-kanban"),
		);
		const snapshot = requireLatestHookResult().runtimeBoardSnapshot;
		expect(snapshot?.workspaceIdOwningRuntimeBoardSnapshot).toBe("cline-kanban");
		expect(snapshot?.workspacePathReadFromRuntime).toBe("/repo/cline-kanban");
		expect(readTitleOfValidationCard(snapshot)).toBe("cline-kanban 的卡");
	});

	it("列计数提示变化后去抖重读；读失败保留上一份", async () => {
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: "cline-kanban",
			runtimeBoardColumnMembershipChangeHintOfWorkspace: "validation:1",
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		await resolveFetchWorkspaceStateCall(
			0,
			workspaceStateResponseWithBoard(boardWithValidationCardTitled("第一版"), "/repo/cline-kanban"),
		);
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: "cline-kanban",
			runtimeBoardColumnMembershipChangeHintOfWorkspace: "validation:0,trash:1",
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		expect(fetchWorkspaceStateMock).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(399);
		});
		expect(fetchWorkspaceStateMock).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(fetchWorkspaceStateMock).toHaveBeenCalledTimes(2);
		await rejectFetchWorkspaceStateCall(1);
		expect(readTitleOfValidationCard(requireLatestHookResult().runtimeBoardSnapshot)).toBe("第一版");
	});

	it("只在可见时每 30s 轮询；显式 refetch 立即读", async () => {
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: "cline-kanban",
			runtimeBoardColumnMembershipChangeHintOfWorkspace: null,
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		expect(fetchWorkspaceStateMock).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(30_000);
		});
		expect(fetchWorkspaceStateMock).toHaveBeenCalledTimes(2);

		documentVisibility.isDocumentVisible = false;
		renderHookWith({
			workspaceIdToReadBoardSnapshotFrom: "cline-kanban",
			runtimeBoardColumnMembershipChangeHintOfWorkspace: null,
			currentProjectBoardHydratedInBrowserForSeeding: null,
		});
		act(() => {
			vi.advanceTimersByTime(90_000);
		});
		expect(fetchWorkspaceStateMock).toHaveBeenCalledTimes(2);

		act(() => {
			requireLatestHookResult().refetchRuntimeBoardSnapshot();
		});
		expect(fetchWorkspaceStateMock).toHaveBeenCalledTimes(3);
		expect(pendingFetchWorkspaceStateCalls.at(-1)?.workspaceId).toBe("cline-kanban");
	});
});
