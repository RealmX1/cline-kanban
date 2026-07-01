import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseGitHistoryDataResult, useGitHistoryData } from "@/components/git-history/use-git-history-data";
import type {
	RuntimeGitCommitChangedFileMetadataResponse,
	RuntimeGitCommitDiffResponse,
	RuntimeGitCommitFileDiffPatchResponse,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSyncSummary,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceChangesResponse,
} from "@/runtime/types";

const getGitRefsQueryMock = vi.hoisted(() => vi.fn());
const getGitLogQueryMock = vi.hoisted(() => vi.fn());
const getCommitDiffQueryMock = vi.hoisted(() => vi.fn());
const getCommitChangedFileMetadataQueryMock = vi.hoisted(() => vi.fn());
const getCommitFileDiffPatchQueryMock = vi.hoisted(() => vi.fn());
const getChangesQueryMock = vi.hoisted(() => vi.fn());
const getWorkspaceChangesQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			getGitRefs: {
				query: getGitRefsQueryMock,
			},
			getGitLog: {
				query: getGitLogQueryMock,
			},
			getCommitDiff: {
				query: getCommitDiffQueryMock,
			},
			getCommitChangedFileMetadata: {
				query: getCommitChangedFileMetadataQueryMock,
			},
			getCommitFileDiffPatch: {
				query: getCommitFileDiffPatchQueryMock,
			},
			getChanges: {
				query: getChangesQueryMock,
			},
			getWorkspaceChanges: {
				query: getWorkspaceChangesQueryMock,
			},
		},
	}),
}));

interface HookSnapshot {
	refs: string[];
	activeRefName: string | null;
	commits: string[];
	selectedCommitHash: string | null;
	isRefsLoading: boolean;
	isLogLoading: boolean;
	isDiffLoading: boolean;
	diffFiles: Array<{
		path: string;
		patch: string | null;
		isPatchLoading: boolean;
	}>;
}

function createGitSummary(branch: string): RuntimeGitSyncSummary {
	return {
		currentBranch: branch,
		upstreamBranch: `origin/${branch}`,
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	};
}

function createRefsResponse(
	branch: string,
	hash: string,
	options?: { includeRemote?: boolean; remoteHash?: string },
): RuntimeGitRefsResponse {
	return {
		ok: true,
		refs: [
			{
				name: branch,
				type: "branch",
				hash,
				isHead: true,
				upstreamName: options?.includeRemote ? `origin/${branch}` : undefined,
				ahead: 0,
				behind: 0,
			},
			...(options?.includeRemote
				? [
						{
							name: `origin/${branch}`,
							type: "remote" as const,
							hash: options.remoteHash ?? hash,
							isHead: false,
						},
					]
				: []),
		],
	};
}

function createLogResponse(
	hashOrCommits: string | Array<{ hash: string; message: string; relation?: "selected" | "upstream" | "shared" }>,
	message?: string,
): RuntimeGitLogResponse {
	const commits =
		typeof hashOrCommits === "string"
			? [
					{
						hash: hashOrCommits,
						message: message ?? "Test commit",
					},
				]
			: hashOrCommits;

	return {
		ok: true,
		totalCount: commits.length,
		commits: commits.map((commit) => ({
			hash: commit.hash,
			shortHash: commit.hash.slice(0, 8),
			authorName: "Test User",
			authorEmail: "test@example.com",
			date: "2026-03-12T00:00:00.000Z",
			message: commit.message,
			parentHashes: [],
			relation: commit.relation,
		})),
	};
}

function createDiffResponse(hash: string): RuntimeGitCommitDiffResponse {
	return {
		ok: true,
		commitHash: hash,
		files: [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				patch: "@@ -1 +1 @@\n-old\n+new\n",
			},
		],
	};
}

function createChangedFileMetadataResponse(hash: string): RuntimeGitCommitChangedFileMetadataResponse {
	return {
		ok: true,
		commitHash: hash,
		files: [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
			},
		],
	};
}

function createFileDiffPatchResponse(hash: string, path = "src/example.ts"): RuntimeGitCommitFileDiffPatchResponse {
	return {
		ok: true,
		commitHash: hash,
		path,
		patch: "@@ -1 +1 @@\n-old\n+new\n",
	};
}

function createWorkspaceChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/project",
		generatedAt: Date.now(),
		files: [],
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function HookHarness({
	taskScope,
	enabled = true,
	onRender,
}: {
	taskScope: { taskId: string; baseRef: string; worktreeMode?: RuntimeTaskWorktreeMode } | null;
	enabled?: boolean;
	onRender: (snapshot: HookSnapshot, gitHistory: UseGitHistoryDataResult) => void;
}): null {
	const gitHistory = useGitHistoryData({
		workspaceId: "project-1",
		taskScope,
		gitSummary: createGitSummary(taskScope ? "task-branch" : "main"),
		enabled,
	});

	onRender(
		{
			refs: gitHistory.refs.map((ref) => ref.name),
			activeRefName: gitHistory.activeRef?.name ?? null,
			commits: gitHistory.commits.map((commit) => commit.hash),
			selectedCommitHash: gitHistory.selectedCommitHash,
			isRefsLoading: gitHistory.isRefsLoading,
			isLogLoading: gitHistory.isLogLoading,
			isDiffLoading: gitHistory.isDiffLoading,
			diffFiles:
				gitHistory.diffSource?.type === "commit"
					? gitHistory.diffSource.files.map((file) => ({
							path: file.path,
							patch: file.patch,
							isPatchLoading: file.isPatchLoading,
						}))
					: [],
		},
		gitHistory,
	);

	return null;
}

function requireLatestGitHistory(gitHistory: UseGitHistoryDataResult | null): UseGitHistoryDataResult {
	if (!gitHistory) {
		throw new Error("Expected git history hook result.");
	}
	return gitHistory;
}

describe("useGitHistoryData", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		getGitRefsQueryMock.mockReset();
		getGitLogQueryMock.mockReset();
		getCommitDiffQueryMock.mockReset();
		getCommitChangedFileMetadataQueryMock.mockReset();
		getCommitFileDiffPatchQueryMock.mockReset();
		getChangesQueryMock.mockReset();
		getWorkspaceChangesQueryMock.mockReset();

		getGitRefsQueryMock.mockImplementation(async (taskScope: { taskId: string; baseRef: string } | null) =>
			taskScope ? createRefsResponse("task-branch", "taskhash1") : createRefsResponse("main", "homehash1"),
		);
		getGitLogQueryMock.mockImplementation(
			async ({ taskScope }: { taskScope?: { taskId: string; baseRef: string } | null }) =>
				taskScope ? createLogResponse("taskhash1", "Task commit") : createLogResponse("homehash1", "Home commit"),
		);
		getCommitDiffQueryMock.mockImplementation(async ({ commitHash }: { commitHash: string }) =>
			createDiffResponse(commitHash),
		);
		getCommitChangedFileMetadataQueryMock.mockImplementation(async ({ commitHash }: { commitHash: string }) =>
			createChangedFileMetadataResponse(commitHash),
		);
		getCommitFileDiffPatchQueryMock.mockImplementation(
			async ({ commitHash, path }: { commitHash: string; path: string }) =>
				createFileDiffPatchResponse(commitHash, path),
		);
		getChangesQueryMock.mockImplementation(async () => createWorkspaceChangesResponse());
		getWorkspaceChangesQueryMock.mockImplementation(async () => createWorkspaceChangesResponse());

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

	it("forwards worktreeMode through every git history query for inplace tasks", async () => {
		const inplaceScope = { taskId: "task-1", baseRef: "main", worktreeMode: "inplace" as const };

		await act(async () => {
			root.render(<HookHarness taskScope={inplaceScope} onRender={() => {}} />);
			await flushPromises();
		});
		await act(async () => {
			await flushPromises();
		});

		expect(getGitRefsQueryMock).toHaveBeenCalledWith(inplaceScope);
		expect(getGitLogQueryMock).toHaveBeenCalledWith(
			expect.objectContaining({ taskScope: inplaceScope }),
			expect.anything(),
		);
		expect(getChangesQueryMock).toHaveBeenCalledWith(inplaceScope);
		expect(getCommitChangedFileMetadataQueryMock).toHaveBeenCalledWith(
			expect.objectContaining({ taskScope: inplaceScope }),
		);
		expect(getCommitDiffQueryMock).not.toHaveBeenCalled();
	});

	it("does not expose home git history data during a task scope transition", async () => {
		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					onRender={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await flushPromises();
		});

		const settledHomeSnapshot = snapshots.at(-1);
		expect(settledHomeSnapshot).toMatchObject({
			refs: ["main"],
			activeRefName: "main",
			commits: ["homehash1"],
		});

		const firstTaskScopeSnapshotIndex = snapshots.length;
		await act(async () => {
			root.render(
				<HookHarness
					taskScope={{
						taskId: "task-1",
						baseRef: "main",
					}}
					onRender={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await flushPromises();
		});

		const transitionSnapshot = snapshots[firstTaskScopeSnapshotIndex];
		expect(transitionSnapshot).toMatchObject({
			refs: [],
			activeRefName: null,
			commits: [],
			selectedCommitHash: null,
			isRefsLoading: true,
			isLogLoading: true,
			isDiffLoading: true,
		});
	});

	it("reports loading on the first render before git history queries resolve", async () => {
		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					onRender={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
		});

		const firstSnapshot = snapshots[0];
		expect(firstSnapshot).toMatchObject({
			refs: [],
			activeRefName: null,
			commits: [],
			selectedCommitHash: null,
			isRefsLoading: true,
			isLogLoading: true,
			isDiffLoading: true,
		});
	});

	it("clears cached refs and diff data when the panel closes so reopen starts cleanly", async () => {
		const snapshots: HookSnapshot[] = [];

		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					onRender={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await flushPromises();
		});

		expect(snapshots.at(-1)).toMatchObject({
			refs: ["main"],
			activeRefName: "main",
			commits: ["homehash1"],
			selectedCommitHash: "homehash1",
			isRefsLoading: false,
			isLogLoading: false,
			isDiffLoading: false,
			diffFiles: [
				{
					path: "src/example.ts",
					patch: null,
					isPatchLoading: false,
				},
			],
		});

		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					enabled={false}
					onRender={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await flushPromises();
		});

		const snapshotsBeforeReopen = snapshots.length;
		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					enabled={true}
					onRender={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
		});

		const reopenSnapshot = snapshots[snapshotsBeforeReopen];
		expect(reopenSnapshot).toMatchObject({
			refs: [],
			activeRefName: null,
			commits: [],
			selectedCommitHash: null,
			isRefsLoading: true,
			isLogLoading: true,
			isDiffLoading: true,
		});
	});

	it("loads the active branch together with its upstream remote when both refs are available", async () => {
		getGitRefsQueryMock.mockResolvedValue(createRefsResponse("main", "homehash1", { includeRemote: true }));

		await act(async () => {
			root.render(<HookHarness taskScope={null} onRender={() => {}} />);
			await flushPromises();
		});

		expect(getGitLogQueryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: "main",
				refs: ["main", "origin/main"],
			}),
			expect.anything(),
		);
	});

	it("selects the checked out branch head by default when the remote has newer commits", async () => {
		const snapshots: HookSnapshot[] = [];

		getGitRefsQueryMock.mockResolvedValue(
			createRefsResponse("main", "homehash1", {
				includeRemote: true,
				remoteHash: "remotehash1",
			}),
		);
		getGitLogQueryMock.mockResolvedValue(
			createLogResponse([
				{ hash: "remotehash1", message: "Remote commit", relation: "upstream" },
				{ hash: "homehash1", message: "Local head", relation: "selected" },
				{ hash: "basehash1", message: "Base commit", relation: "shared" },
			]),
		);

		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					onRender={(snapshot) => {
						snapshots.push(snapshot);
					}}
				/>,
			);
			await flushPromises();
		});

		expect(snapshots.at(-1)).toMatchObject({
			activeRefName: "main",
			commits: ["remotehash1", "homehash1", "basehash1"],
			selectedCommitHash: "homehash1",
		});
	});

	it("loads one commit file patch on demand", async () => {
		let latestGitHistory: UseGitHistoryDataResult | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					onRender={(_snapshot, gitHistory) => {
						latestGitHistory = gitHistory;
					}}
				/>,
			);
			await flushPromises();
		});
		await act(async () => {
			await flushPromises();
		});

		expect(getCommitDiffQueryMock).not.toHaveBeenCalled();
		const gitHistoryBeforeFilePatch = requireLatestGitHistory(latestGitHistory);
		const diffSource = gitHistoryBeforeFilePatch.diffSource;
		expect(diffSource?.type).toBe("commit");
		if (!diffSource || diffSource.type !== "commit") {
			throw new Error("Expected commit diff source.");
		}
		const file = diffSource.files[0];
		expect(file?.patch).toBeNull();

		await act(async () => {
			await gitHistoryBeforeFilePatch.loadCommitFileDiffPatch(file!);
			await flushPromises();
		});

		expect(getCommitFileDiffPatchQueryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				commitHash: "homehash1",
				path: "src/example.ts",
			}),
		);
		const gitHistoryAfterFilePatch = requireLatestGitHistory(latestGitHistory);
		expect(
			gitHistoryAfterFilePatch.diffSource?.type === "commit"
				? gitHistoryAfterFilePatch.diffSource.files[0]?.patch
				: null,
		).toContain("+new");
	});

	it("loads all commit file patches through the full diff query on demand", async () => {
		let latestGitHistory: UseGitHistoryDataResult | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					taskScope={null}
					onRender={(_snapshot, gitHistory) => {
						latestGitHistory = gitHistory;
					}}
				/>,
			);
			await flushPromises();
		});

		expect(getCommitDiffQueryMock).not.toHaveBeenCalled();

		await act(async () => {
			await requireLatestGitHistory(latestGitHistory).loadAllCommitFileDiffPatches();
			await flushPromises();
		});

		expect(getCommitDiffQueryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				commitHash: "homehash1",
			}),
		);
		const gitHistoryAfterFullDiff = requireLatestGitHistory(latestGitHistory);
		expect(
			gitHistoryAfterFullDiff.diffSource?.type === "commit"
				? gitHistoryAfterFullDiff.diffSource.files[0]?.patch
				: null,
		).toContain("+new");
	});
});
