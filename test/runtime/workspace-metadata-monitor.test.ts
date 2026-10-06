import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitSyncMocks = vi.hoisted(() => ({
	getGitSyncSummary: vi.fn(),
	probeGitWorkspaceState: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	getTaskWorkspacePathInfo: vi.fn(),
}));

const gitUtilsMocks = vi.hoisted(() => ({
	runGit: vi.fn(),
}));

const gitChangeTokenMocks = vi.hoisted(() => ({
	computeWorktreeGitChangeToken: vi.fn(),
}));

const taskCommitIntegrationProvenanceMocks = vi.hoisted(() => ({
	refreshTaskCommitIntegrationProvenance: vi.fn(),
}));

vi.mock("../../src/workspace/git-sync.js", () => ({
	getGitSyncSummary: gitSyncMocks.getGitSyncSummary,
	probeGitWorkspaceState: gitSyncMocks.probeGitWorkspaceState,
}));

vi.mock("../../src/workspace/task-worktree.js", () => ({
	getTaskWorkspacePathInfo: taskWorktreeMocks.getTaskWorkspacePathInfo,
}));

vi.mock("../../src/workspace/git-utils.js", () => ({
	runGit: gitUtilsMocks.runGit,
}));

vi.mock("../../src/workspace/git-change-token.js", () => ({
	computeWorktreeGitChangeToken: gitChangeTokenMocks.computeWorktreeGitChangeToken,
}));

vi.mock("../../src/workspace/task-commit-integration-provenance.js", () => ({
	refreshTaskCommitIntegrationProvenance: taskCommitIntegrationProvenanceMocks.refreshTaskCommitIntegrationProvenance,
}));

// fork-point（git merge-base HEAD <baseRef>）的确定性返回；非 merge-base 调用退化为失败。
const FORK_POINT_COMMIT = "f00ba4c0ffee1234";
// base 分支 tip（git rev-parse --verify <baseRef>^{commit}）。仅用于门控失效判定，不下发前端。
const BASE_REF_TIP_COMMIT = "ba5e7100dec0de99";
// `git rev-list --left-right --count <baseRef>...HEAD` 的输出：左=behind、右=ahead。
const DEFAULT_COMMITS_BEHIND_BASE_REF = 12;
const DEFAULT_COMMITS_AHEAD_OF_BASE_REF = 3;

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskWorktreeMode } from "../../src/core/api-contract";
import { ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE } from "../../src/core/runtime-state-stream-workspace-metadata-probe-scope-declaration";
import {
	createWorkspaceMetadataMonitor,
	type WorkspaceMetadataMonitor,
	workspaceMetadataGitSpawnConcurrencyLimiter,
} from "../../src/server/workspace-metadata-monitor";

const WORKSPACE_PATH = "/repo/project";
const BRANCH_TASK_WORKTREE_PATH = "/repo/.cline/worktrees/abc/task-branch";

interface TaskWorkspacePathInfoOptions {
	cwd: string;
	taskId: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}

function createBoardCard(id: string, worktreeMode?: RuntimeTaskWorktreeMode): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		...(worktreeMode ? { worktreeMode } : {}),
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [createBoardCard("task-backlog", "inplace")] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: [createBoardCard("task-branch"), createBoardCard("task-inplace", "inplace")],
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [createBoardCard("task-trash")] },
		],
	};
}

describe("createWorkspaceMetadataMonitor", () => {
	let monitor: WorkspaceMetadataMonitor;
	// 可变，供「base 分支单方面推进」的用例改写 rev-parse 的返回。
	let stubbedBaseRefTipCommit: string;
	const onMetadataUpdated = vi.fn();

	// 改动前的语义：一个订阅、整个项目。按范围探测的用例另行声明订阅与范围。
	const connectWorkspaceAsWholeProjectSubscriber = (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) =>
		monitor.connectWorkspace({
			...input,
			subscriberId: "subscriber-declaring-whole-project",
			probeScope: ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE,
		});

	const countRevParseCalls = () =>
		gitUtilsMocks.runGit.mock.calls.filter((call) => (call[1] as string[])[0] === "rev-parse").length;

	beforeEach(() => {
		stubbedBaseRefTipCommit = BASE_REF_TIP_COMMIT;
		onMetadataUpdated.mockReset();
		gitSyncMocks.getGitSyncSummary.mockReset();
		gitSyncMocks.probeGitWorkspaceState.mockReset();
		taskWorktreeMocks.getTaskWorkspacePathInfo.mockReset();
		gitUtilsMocks.runGit.mockReset();
		gitUtilsMocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
			if (args[0] === "merge-base") {
				return {
					ok: true,
					stdout: FORK_POINT_COMMIT,
					stderr: "",
					output: FORK_POINT_COMMIT,
					error: null,
					exitCode: 0,
				};
			}
			if (args[0] === "rev-parse") {
				return {
					ok: true,
					stdout: stubbedBaseRefTipCommit,
					stderr: "",
					output: stubbedBaseRefTipCommit,
					error: null,
					exitCode: 0,
				};
			}
			if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
				const divergence = `${DEFAULT_COMMITS_BEHIND_BASE_REF}\t${DEFAULT_COMMITS_AHEAD_OF_BASE_REF}`;
				return { ok: true, stdout: divergence, stderr: "", output: divergence, error: null, exitCode: 0 };
			}
			return { ok: false, stdout: "", stderr: "", output: "", error: "unexpected git call", exitCode: 1 };
		});

		taskWorktreeMocks.getTaskWorkspacePathInfo.mockImplementation(async (options: TaskWorkspacePathInfoOptions) =>
			options.worktreeMode === "inplace"
				? {
						taskId: options.taskId,
						path: options.cwd,
						exists: true,
						baseRef: options.baseRef,
					}
				: {
						taskId: options.taskId,
						path: BRANCH_TASK_WORKTREE_PATH,
						exists: false,
						baseRef: options.baseRef,
					},
		);
		gitSyncMocks.probeGitWorkspaceState.mockImplementation(async (cwd: string) => ({
			repoRoot: cwd,
			headCommit: "abcdef1234567890",
			currentBranch: "main",
			upstreamBranch: null,
			aheadCount: 0,
			behindCount: 0,
			changedFiles: 2,
			untrackedPaths: [],
			stateToken: `token:${cwd}`,
		}));
		gitSyncMocks.getGitSyncSummary.mockImplementation(async () => ({
			currentBranch: "main",
			upstreamBranch: null,
			changedFiles: 2,
			additions: 5,
			deletions: 1,
			aheadCount: 0,
			behindCount: 0,
		}));
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockReset();
		// 默认：廉价 token 恒定 → 首刷后同状态复用缓存、跳过真探针。
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");
		taskCommitIntegrationProvenanceMocks.refreshTaskCommitIntegrationProvenance.mockReset();
		taskCommitIntegrationProvenanceMocks.refreshTaskCommitIntegrationProvenance.mockImplementation(
			async (input: {
				taskId: string;
				baseRef: string;
				worktreeMode?: RuntimeTaskWorktreeMode;
				worktreeExists: boolean;
				commitsAheadOfBaseRef: number | null;
				commitsBehindBaseRef: number | null;
			}) => ({
				baseRef: input.baseRef,
				commitsAheadOfBaseRef: input.taskId === "task-trash" ? 0 : input.commitsAheadOfBaseRef,
				commitsBehindBaseRef: input.taskId === "task-trash" ? 4 : input.commitsBehindBaseRef,
				taskCommitsIntegratedIntoBaseRef:
					input.worktreeMode === "inplace" ? null : input.taskId === "task-trash" ? 2 : null,
				taskCommitIntegrationTrackingStatus:
					input.worktreeMode === "inplace"
						? "inplace_task_commit_ownership_unavailable"
						: input.taskId === "task-trash"
							? "complete"
							: "legacy_history_unavailable",
				observationSource:
					input.taskId === "task-trash"
						? "persisted_final_snapshot"
						: input.worktreeExists
							? "live_worktree"
							: "unavailable",
				observedAt: 100,
			}),
		);

		monitor = createWorkspaceMetadataMonitor({ onMetadataUpdated });
	});

	afterEach(() => {
		monitor.close();
	});

	it("forwards each tracked card's worktreeMode to getTaskWorkspacePathInfo", async () => {
		await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		const callsByTaskId = new Map(
			taskWorktreeMocks.getTaskWorkspacePathInfo.mock.calls.map((call) => {
				const options = call[0] as TaskWorkspacePathInfoOptions;
				return [options.taskId, options];
			}),
		);

		expect(callsByTaskId.get("task-inplace")).toMatchObject({
			cwd: WORKSPACE_PATH,
			baseRef: "main",
			worktreeMode: "inplace",
		});
		expect(callsByTaskId.get("task-branch")).toMatchObject({
			cwd: WORKSPACE_PATH,
			baseRef: "main",
		});
		expect(callsByTaskId.get("task-branch")).not.toHaveProperty("worktreeMode");
	});

	it("reports the repo root as an existing workspace for inplace tasks", async () => {
		const metadata = await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		const inplaceTask = metadata.taskWorkspaces.find((task) => task.taskId === "task-inplace");
		expect(inplaceTask).toMatchObject({
			path: WORKSPACE_PATH,
			exists: true,
			branch: "main",
			// fork-point（git merge-base HEAD <baseRef>）现算并随 metadata 暴露。
			baseCommit: FORK_POINT_COMMIT,
			// 一条 `rev-list --left-right --count` 同出双向分歧：左=behind、右=ahead。
			commitsAheadOfBaseRef: DEFAULT_COMMITS_AHEAD_OF_BASE_REF,
			commitsBehindBaseRef: DEFAULT_COMMITS_BEHIND_BASE_REF,
			changedFiles: 2,
			additions: 5,
			deletions: 1,
			workspaceGitStatus: {
				taskCommitsIntegratedIntoBaseRef: null,
				taskCommitIntegrationTrackingStatus: "inplace_task_commit_ownership_unavailable",
			},
		});
		expect(gitUtilsMocks.runGit).toHaveBeenCalledWith(WORKSPACE_PATH, ["merge-base", "HEAD", "main"]);
		expect(gitUtilsMocks.runGit).toHaveBeenCalledWith(WORKSPACE_PATH, [
			"rev-list",
			"--left-right",
			"--count",
			"main...HEAD",
		]);

		const branchTask = metadata.taskWorkspaces.find((task) => task.taskId === "task-branch");
		expect(branchTask).toMatchObject({
			path: BRANCH_TASK_WORKTREE_PATH,
			exists: false,
			branch: null,
			// 未落地的 worktree（exists:false）不探测分叉点 → baseCommit 与双向分歧均为 null。
			baseCommit: null,
			commitsAheadOfBaseRef: null,
			commitsBehindBaseRef: null,
			changedFiles: null,
		});
	});

	describe("按连接声明的范围探测（Board Scope 下跨项目打开不等整个项目的 git）", () => {
		const createBoardWithReviewColumnCards = (): RuntimeBoardData => {
			const board = createBoard();
			const reviewColumn = board.columns.find((column) => column.id === "review");
			reviewColumn?.cards.push(
				{ ...createBoardCard("task-review-auto-review"), autoReviewEnabled: true },
				createBoardCard("task-review-without-auto-review"),
			);
			return board;
		};
		const probedTaskIds = () =>
			new Set(
				taskWorktreeMocks.getTaskWorkspacePathInfo.mock.calls.map(
					(call) => (call[0] as TaskWorkspacePathInfoOptions).taskId,
				),
			);
		const focusedTaskProbeScope = (focusedTaskIds: string[]) =>
			({
				workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
				focusedTaskIds,
			}) as const;

		it("只探焦点任务与 Review 列开了 auto-review 的卡，快照也只含它们", async () => {
			const metadata = await monitor.connectWorkspace({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoardWithReviewColumnCards(),
				subscriberId: "board-scope-tab",
				probeScope: focusedTaskProbeScope(["task-branch"]),
			});

			expect(probedTaskIds()).toEqual(new Set(["task-branch", "task-review-auto-review"]));
			expect(metadata.taskWorkspaces.map((task) => task.taskId)).toEqual(["task-branch", "task-review-auto-review"]);
		});

		it("同一项目另一个连接要整个项目时取并集", async () => {
			await monitor.connectWorkspace({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoardWithReviewColumnCards(),
				subscriberId: "board-scope-tab",
				probeScope: focusedTaskProbeScope(["task-branch"]),
			});
			const metadata = await monitor.connectWorkspace({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoardWithReviewColumnCards(),
				subscriberId: "single-project-tab",
				probeScope: ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE,
			});

			expect(metadata.taskWorkspaces.map((task) => task.taskId)).toEqual([
				"task-branch",
				"task-inplace",
				"task-review-auto-review",
				"task-review-without-auto-review",
				"task-trash",
			]);
		});

		it("连接改成整个项目后不等结果，补探完经 onMetadataUpdated 推送全部任务", async () => {
			await monitor.connectWorkspace({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
				subscriberId: "board-scope-tab",
				probeScope: focusedTaskProbeScope(["task-branch"]),
			});
			expect(probedTaskIds()).toEqual(new Set(["task-branch"]));
			onMetadataUpdated.mockReset();

			monitor.updateSubscriberProbeScope({
				workspaceId: "workspace-1",
				subscriberId: "board-scope-tab",
				probeScope: ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE,
			});
			await vi.waitFor(() => expect(onMetadataUpdated).toHaveBeenCalled());

			const pushedMetadata = onMetadataUpdated.mock.calls.at(-1)?.[1] as {
				taskWorkspaces: Array<{ taskId: string }>;
			};
			expect(pushedMetadata.taskWorkspaces.map((task) => task.taskId)).toEqual([
				"task-branch",
				"task-inplace",
				"task-trash",
			]);
		});

		it("范围收窄回焦点任务后也推送（基准是上一轮的快照，不是按新范围现算的）", async () => {
			await connectWorkspaceAsWholeProjectSubscriber({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
			});
			onMetadataUpdated.mockReset();

			monitor.updateSubscriberProbeScope({
				workspaceId: "workspace-1",
				subscriberId: "subscriber-declaring-whole-project",
				probeScope: focusedTaskProbeScope(["task-branch"]),
			});
			await vi.waitFor(() => expect(onMetadataUpdated).toHaveBeenCalled());

			const pushedMetadata = onMetadataUpdated.mock.calls.at(-1)?.[1] as {
				taskWorkspaces: Array<{ taskId: string }>;
			};
			expect(pushedMetadata.taskWorkspaces.map((task) => task.taskId)).toEqual(["task-branch"]);
		});

		it("未声明过的订阅改范围被忽略（连接已断开或从未连上）", async () => {
			monitor.updateSubscriberProbeScope({
				workspaceId: "workspace-1",
				subscriberId: "never-connected",
				probeScope: ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE,
			});
			await Promise.resolve();
			expect(taskWorktreeMocks.getTaskWorkspacePathInfo).not.toHaveBeenCalled();
		});

		it("最后一个连接断开后保留缓存：重连时没变的 worktree 不再跑完整探针", async () => {
			await connectWorkspaceAsWholeProjectSubscriber({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
			});
			const summaryCallsAfterFirstConnect = gitSyncMocks.getGitSyncSummary.mock.calls.length;
			monitor.disconnectWorkspace("workspace-1", "subscriber-declaring-whole-project");

			await connectWorkspaceAsWholeProjectSubscriber({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
			});
			// token 不变、在兜底窗口内：复用保留的缓存，不再算 git 摘要。
			expect(gitSyncMocks.getGitSyncSummary.mock.calls.length).toBe(summaryCallsAfterFirstConnect);
		});

		describe("首轮刷新失败时 connectWorkspace 自己摘掉刚登记的订阅（调用方拿不到结果，没法替它断开）", () => {
			const FIRST_REFRESH_FAILURE_MESSAGE = "首轮刷新里解析 task worktree 路径失败";
			const connectWholeProjectSubscriberWhoseFirstRefreshFails = () => {
				taskWorktreeMocks.getTaskWorkspacePathInfo.mockRejectedValueOnce(new Error(FIRST_REFRESH_FAILURE_MESSAGE));
				return monitor.connectWorkspace({
					workspaceId: "workspace-1",
					workspacePath: WORKSPACE_PATH,
					board: createBoard(),
					subscriberId: "whole-project-tab-whose-first-refresh-failed",
					probeScope: ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE,
				});
			};

			it("失败的订阅声明的整个项目不再钉住同项目后续 Board Scope 连接的范围并集", async () => {
				await expect(connectWholeProjectSubscriberWhoseFirstRefreshFails()).rejects.toThrow(
					FIRST_REFRESH_FAILURE_MESSAGE,
				);

				const metadata = await monitor.connectWorkspace({
					workspaceId: "workspace-1",
					workspacePath: WORKSPACE_PATH,
					board: createBoard(),
					subscriberId: "board-scope-tab",
					probeScope: focusedTaskProbeScope(["task-branch"]),
				});

				expect(metadata.taskWorkspaces.map((task) => task.taskId)).toEqual(["task-branch"]);
			});

			it("没有别的连接时随之停掉轮询，不再定时探测", async () => {
				// 只假轮询用的 setInterval：setImmediate 保持真实，用来冲掉首轮里其余任务还在飞的探针。
				vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
				try {
					await expect(connectWholeProjectSubscriberWhoseFirstRefreshFails()).rejects.toThrow(
						FIRST_REFRESH_FAILURE_MESSAGE,
					);
					await new Promise((resolve) => setImmediate(resolve));
					const probeCallsAfterFailedFirstRefresh = taskWorktreeMocks.getTaskWorkspacePathInfo.mock.calls.length;

					expect(vi.getTimerCount()).toBe(0);
					// 跨过好几个轮询间隔（监视器里是 3s）：残留的定时器会在这里重新探测。
					await vi.advanceTimersByTimeAsync(10_000);
					await new Promise((resolve) => setImmediate(resolve));
					expect(taskWorktreeMocks.getTaskWorkspacePathInfo.mock.calls.length).toBe(
						probeCallsAfterFailedFirstRefresh,
					);
				} finally {
					vi.useRealTimers();
				}
			});
		});
	});

	it("不追踪 backlog，但保留 Done 卡片的持久 Git 状态投影", async () => {
		const metadata = await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		const trackedTaskIds = metadata.taskWorkspaces.map((task) => task.taskId);
		expect(trackedTaskIds).toEqual(["task-branch", "task-inplace", "task-trash"]);
		expect(metadata.taskWorkspaces.find((task) => task.taskId === "task-trash")?.workspaceGitStatus).toMatchObject({
			commitsAheadOfBaseRef: 0,
			commitsBehindBaseRef: 4,
			taskCommitsIntegratedIntoBaseRef: 2,
			observationSource: "persisted_final_snapshot",
		});
	});

	it("廉价 token 未变且在兜底窗口内时，二次刷新跳过 probe（不再 spawn git）", async () => {
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");

		await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;
		expect(probeCallsAfterFirstRefresh).toBeGreaterThan(0);

		// 二次刷新：token 不变、窗口内 → 不应再调 probe（真探针被门控短路）。
		await monitor.updateWorkspaceState({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBe(probeCallsAfterFirstRefresh);
	});

	it("base 分支单方面推进时击穿两层门控，behind 随之更新", async () => {
		// 这是 behind 的承重回归：worktree 自身完全没动（廉价 token 与 probe 的 stateToken 都恒定），
		// 只有 base 分支前进。若门控不比对 base tip，commitsBehindBaseRef 会被永久冻结在首次算出的值。
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");
		const firstMetadata = await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		expect(firstMetadata.taskWorkspaces.find((task) => task.taskId === "task-inplace")).toMatchObject({
			commitsBehindBaseRef: DEFAULT_COMMITS_BEHIND_BASE_REF,
		});
		const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;

		// base 分支推进（如本地 main 新落了提交）→ rev-parse 返回新 tip，同时分歧计数改口。
		stubbedBaseRefTipCommit = "ba5e7100dec0de99-advanced";
		const advancedCommitsBehind = DEFAULT_COMMITS_BEHIND_BASE_REF + 4;
		gitUtilsMocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
			if (args[0] === "merge-base") {
				return {
					ok: true,
					stdout: FORK_POINT_COMMIT,
					stderr: "",
					output: FORK_POINT_COMMIT,
					error: null,
					exitCode: 0,
				};
			}
			if (args[0] === "rev-parse") {
				return {
					ok: true,
					stdout: stubbedBaseRefTipCommit,
					stderr: "",
					output: stubbedBaseRefTipCommit,
					error: null,
					exitCode: 0,
				};
			}
			if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
				const divergence = `${advancedCommitsBehind}\t${DEFAULT_COMMITS_AHEAD_OF_BASE_REF}`;
				return { ok: true, stdout: divergence, stderr: "", output: divergence, error: null, exitCode: 0 };
			}
			return { ok: false, stdout: "", stderr: "", output: "", error: "unexpected git call", exitCode: 1 };
		});

		const secondMetadata = await monitor.updateWorkspaceState({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBeGreaterThan(probeCallsAfterFirstRefresh);
		expect(secondMetadata.taskWorkspaces.find((task) => task.taskId === "task-inplace")).toMatchObject({
			commitsBehindBaseRef: advancedCommitsBehind,
			commitsAheadOfBaseRef: DEFAULT_COMMITS_AHEAD_OF_BASE_REF,
		});
	});

	it("base tip 未变时不因新增的 rev-parse 而破坏既有的「跳过 probe」门控", async () => {
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");
		await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;

		await monitor.updateWorkspaceState({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBe(probeCallsAfterFirstRefresh);
	});

	it("同一刷新周期内，共享同一 baseRef 的所有任务只解析一次 base tip", async () => {
		const trackedTaskCount = 8;
		const sharedBaseRefBoard: RuntimeBoardData = {
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: Array.from({ length: trackedTaskCount }, (_unused, index) =>
						createBoardCard(`task-${index}`, "inplace"),
					),
				},
			],
		};

		const metadata = await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-dedupe",
			workspacePath: WORKSPACE_PATH,
			board: sharedBaseRefBoard,
		});

		// 前置校验：确实有多个任务参与本轮刷新（否则去重断言不成立）。
		expect(metadata.taskWorkspaces).toHaveLength(trackedTaskCount);
		// 核心断言：rev-parse 按 baseRef 去重，开销与任务数无关。
		expect(countRevParseCalls()).toBe(1);
		expect(gitUtilsMocks.runGit).toHaveBeenCalledWith(WORKSPACE_PATH, ["rev-parse", "--verify", "main^{commit}"]);
	});

	it("廉价 token 变化时，二次刷新重新跑 probe", async () => {
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("token-v1");
		await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;

		// 廉价 token 改变（HEAD/index/工作树发生变化）→ 门控放行 → 重新探针。
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("token-v2");
		await monitor.updateWorkspaceState({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBeGreaterThan(probeCallsAfterFirstRefresh);
	});

	it("即使廉价 token 未变，超过兜底窗口后仍强制跑一次 probe（补上就地未暂存编辑）", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date(0));
			gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");

			await connectWorkspaceAsWholeProjectSubscriber({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
			});
			const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;

			// 推进系统时间越过兜底窗口（10s）。token 仍不变，但窗口过期 → 应强制重新探针。
			vi.setSystemTime(new Date(11_000));
			await monitor.updateWorkspaceState({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
			});
			expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBeGreaterThan(probeCallsAfterFirstRefresh);
		} finally {
			vi.useRealTimers();
		}
	});

	it("单次刷新内所有 task 的真探针被钳到共享并发上限（不随 task 数线性爆发）", async () => {
		const concurrencyLimit = workspaceMetadataGitSpawnConcurrencyLimiter.concurrency;
		// 注入远多于并发上限的 tracked task，逼出「所有 task 同一 poll tick 内并发探针」这一热路径。
		const trackedTaskCount = concurrencyLimit * 4;

		let activeProbeCount = 0;
		let peakProbeConcurrency = 0;
		// mock probe：进入时 +1、记录峰值，await 一个可控延迟后 -1。延迟期间占住限流器的槽位，
		// 使「同时在飞的真探针数」= 限流器实际放行的并发数，从而观测到真实并发峰值。
		gitSyncMocks.probeGitWorkspaceState.mockImplementation(async (cwd: string) => {
			activeProbeCount += 1;
			peakProbeConcurrency = Math.max(peakProbeConcurrency, activeProbeCount);
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeProbeCount -= 1;
			return {
				repoRoot: cwd,
				headCommit: "abcdef1234567890",
				currentBranch: "main",
				upstreamBranch: null,
				aheadCount: 0,
				behindCount: 0,
				changedFiles: 2,
				untrackedPaths: [],
				stateToken: `token:${cwd}`,
			};
		});

		const manyInplaceCardsBoard: RuntimeBoardData = {
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: Array.from({ length: trackedTaskCount }, (_unused, index) =>
						createBoardCard(`task-${index}`, "inplace"),
					),
				},
			],
		};

		const metadata = await connectWorkspaceAsWholeProjectSubscriber({
			workspaceId: "workspace-concurrency",
			workspacePath: WORKSPACE_PATH,
			board: manyInplaceCardsBoard,
		});

		// 前置校验：确实触发了远多于上限的 task 探针（否则并发断言不成立）。
		expect(metadata.taskWorkspaces).toHaveLength(trackedTaskCount);
		expect(peakProbeConcurrency).toBeGreaterThan(1);
		// 核心断言：观测到的并发峰值被钳在共享上限内，不随 task 数线性增长。
		expect(peakProbeConcurrency).toBeLessThanOrEqual(concurrencyLimit);
	});
});
