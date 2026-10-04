import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerTaskCommand } from "../../../src/commands/task";

// `kanban task get` 在当前 project 找不到卡时，经 runtime 的全局 task 身份登记簿跨 project 解析（dd2db 1b）。
// 唯一活卡候选却定位 / 读取不到时必须如实报错（说清候选在哪、为何读不到），绝不能误报「匹配多张卡」；
// 多个活卡候选、唯一候选可读、墓碑三条既有路径保持不变。
// runtime 与 workspace 索引全部 mock：按请求头里的 workspace id 返回各自的 board，按路径返回各自的 workspace。

const CURRENT_DIRECTORY_WORKSPACE = { repoPath: "/fake/current-directory-repo", workspaceId: "workspace-current" };
const OWNING_WORKSPACE_OF_CANDIDATE = { repoPath: "/fake/owning-repo-of-candidate", workspaceId: "workspace-owning" };
const CROSS_PROJECT_TASK_ID = "a1b2c";

const harness = vi.hoisted(() => {
	const emptyBoardState = { board: { columns: [] as unknown[] }, sessions: {} };
	return {
		emptyBoardState,
		boardStateByWorkspaceId: new Map<string, unknown>(),
		workspaceContextByRepositoryPath: new Map<string, { repoPath: string; workspaceId: string }>(),
		workspaceContextLoadFailureMessageByRepositoryPath: new Map<string, string>(),
		kanbanBoardCardIdentityCandidates: [] as unknown[],
	};
});

vi.mock("@trpc/client", () => ({
	// 真实 createRuntimeTrpcClient 把 workspace id 放进请求头；这里读回它来区分「当前 project」与「候选所在 project」。
	httpBatchLink: (httpBatchLinkOptions: unknown) => httpBatchLinkOptions,
	createTRPCProxyClient: (trpcClientConfig: { links: Array<{ headers: () => Record<string, string> }> }) => {
		const workspaceIdFromRequestHeader = trpcClientConfig.links[0]?.headers()["x-kanban-workspace-id"] ?? null;
		return {
			workspace: {
				getState: {
					query: async () =>
						(workspaceIdFromRequestHeader
							? harness.boardStateByWorkspaceId.get(workspaceIdFromRequestHeader)
							: undefined) ?? harness.emptyBoardState,
				},
				getTaskContext: { query: async () => null },
			},
			workUnit: {
				resolveKanbanBoardCardIdentityByBareTaskId: {
					query: async () => ({ kanbanBoardCardIdentityCandidates: harness.kanbanBoardCardIdentityCandidates }),
				},
				getRelationNeighborhoodSummary: {
					query: async () => ({ recordedRelations: [], renderedNeighborhoodSummaryText: "" }),
				},
			},
		};
	},
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	detectGitRepositoryInfo: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(),
	loadWorkspaceBoardById: vi.fn(),
	loadWorkspaceContext: async (repositoryPath: string) => {
		const loadFailureMessage = harness.workspaceContextLoadFailureMessageByRepositoryPath.get(repositoryPath);
		if (loadFailureMessage) {
			throw new Error(loadFailureMessage);
		}
		const workspaceContext = harness.workspaceContextByRepositoryPath.get(repositoryPath);
		if (!workspaceContext) {
			throw new Error(`Project ${repositoryPath} is not added to Kanban yet.`);
		}
		return workspaceContext;
	},
	mutateWorkspaceState: async () => {
		throw new Error("task get must not write board.json from the CLI process");
	},
	resolveWorkspacePath: vi.fn(),
}));

function createBoardStateWithBacklogTaskCard(taskId: string) {
	return {
		board: {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: taskId,
							title: "跨 project 的卡",
							prompt: "prompt",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 2,
						},
					],
				},
			],
		},
		sessions: {},
	};
}

function createKanbanBoardCardIdentityCandidate(input: {
	workspaceId: string;
	workspaceRepositoryPath: string | null;
	permanentlyRemovedFromBoardAt?: number | null;
}) {
	return {
		kanbanBoardCard: {
			workUnitType: "kanban_board_card",
			workspaceId: input.workspaceId,
			taskId: CROSS_PROJECT_TASK_ID,
			taskIncarnationCreatedAtEpochMs: 1,
		},
		workspaceRepositoryPath: input.workspaceRepositoryPath,
		currentTitle: "跨 project 的卡",
		promptFirstParagraph: "prompt",
		lastKnownBoardColumnId: "backlog",
		movedToTrashColumnAt: null,
		permanentlyRemovedFromBoardAt: input.permanentlyRemovedFromBoardAt ?? null,
		creationActorKind: null,
		kanbanBoardCardFirstObservationRoute: "live_runtime_capture",
	};
}

async function runKanbanTaskGetFromCurrentDirectory(): Promise<{ exitCode: unknown; output: Record<string, unknown> }> {
	const stdoutChunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdoutChunks.push(String(chunk));
		return true;
	});
	vi.spyOn(process, "cwd").mockReturnValue(CURRENT_DIRECTORY_WORKSPACE.repoPath);
	const program = new Command();
	registerTaskCommand(program);
	await program.parseAsync(["node", "kanban", "task", "get", "--task-id", CROSS_PROJECT_TASK_ID]);
	return { exitCode: process.exitCode, output: JSON.parse(stdoutChunks.join("")) };
}

describe("kanban task get 的跨 project 解析", () => {
	beforeEach(() => {
		process.exitCode = undefined;
		harness.boardStateByWorkspaceId.clear();
		harness.workspaceContextByRepositoryPath.clear();
		harness.workspaceContextLoadFailureMessageByRepositoryPath.clear();
		harness.workspaceContextByRepositoryPath.set(CURRENT_DIRECTORY_WORKSPACE.repoPath, CURRENT_DIRECTORY_WORKSPACE);
		harness.workspaceContextByRepositoryPath.set(
			OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
			OWNING_WORKSPACE_OF_CANDIDATE,
		);
		harness.kanbanBoardCardIdentityCandidates = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("唯一活卡候选可读：返回候选 project 里的卡并标注经全局登记簿解析（行为不变）", async () => {
		harness.kanbanBoardCardIdentityCandidates = [
			createKanbanBoardCardIdentityCandidate({
				workspaceId: OWNING_WORKSPACE_OF_CANDIDATE.workspaceId,
				workspaceRepositoryPath: OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
			}),
		];
		harness.boardStateByWorkspaceId.set(
			OWNING_WORKSPACE_OF_CANDIDATE.workspaceId,
			createBoardStateWithBacklogTaskCard(CROSS_PROJECT_TASK_ID),
		);

		const { exitCode, output } = await runKanbanTaskGetFromCurrentDirectory();

		expect(exitCode).not.toBe(1);
		expect(output).toMatchObject({
			ok: true,
			workspacePath: OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
			task: { id: CROSS_PROJECT_TASK_ID, column: "backlog" },
			resolvedAcrossProjectsThroughGlobalTaskIdentityRegistry: true,
		});
	});

	it("唯一活卡候选没有 repository 路径：如实说明它所在 workspace 不在 runtime 已知项目里，不误报匹配多张卡", async () => {
		harness.kanbanBoardCardIdentityCandidates = [
			createKanbanBoardCardIdentityCandidate({
				workspaceId: "workspace-no-longer-registered",
				workspaceRepositoryPath: null,
			}),
		];

		const { exitCode, output } = await runKanbanTaskGetFromCurrentDirectory();

		expect(exitCode).toBe(1);
		expect(output.ok).toBe(false);
		expect(output.error).toEqual(expect.stringContaining("workspace-no-longer-registered"));
		expect(output.error).toEqual(expect.stringContaining("--project-path"));
		expect(output.error).not.toEqual(expect.stringContaining("matches more than one"));
	});

	it("唯一活卡候选有路径但那个 project 的 board 上已没有这张卡：说明候选路径，不误报匹配多张卡", async () => {
		harness.kanbanBoardCardIdentityCandidates = [
			createKanbanBoardCardIdentityCandidate({
				workspaceId: OWNING_WORKSPACE_OF_CANDIDATE.workspaceId,
				workspaceRepositoryPath: OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
			}),
		];

		const { exitCode, output } = await runKanbanTaskGetFromCurrentDirectory();

		expect(exitCode).toBe(1);
		expect(output.error).toEqual(expect.stringContaining(OWNING_WORKSPACE_OF_CANDIDATE.repoPath));
		expect(output.error).not.toEqual(expect.stringContaining("matches more than one"));
	});

	it("唯一活卡候选的路径无法解析成 runtime workspace：说明这是跨 project 解析的第二步失败，带上候选路径与原因", async () => {
		harness.kanbanBoardCardIdentityCandidates = [
			createKanbanBoardCardIdentityCandidate({
				workspaceId: OWNING_WORKSPACE_OF_CANDIDATE.workspaceId,
				workspaceRepositoryPath: OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
			}),
		];
		harness.workspaceContextLoadFailureMessageByRepositoryPath.set(
			OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
			"workspace index is unreadable",
		);

		const { exitCode, output } = await runKanbanTaskGetFromCurrentDirectory();

		expect(exitCode).toBe(1);
		expect(output.error).toEqual(expect.stringContaining(OWNING_WORKSPACE_OF_CANDIDATE.repoPath));
		expect(output.error).toEqual(expect.stringContaining("workspace index is unreadable"));
		expect(output.error).toEqual(expect.stringContaining("cross-project"));
		expect(output.error).not.toEqual(expect.stringContaining("matches more than one"));
	});

	it("多个活卡候选：文案保持「匹配多张卡，用 --project-path 选一个」不变", async () => {
		harness.kanbanBoardCardIdentityCandidates = [
			createKanbanBoardCardIdentityCandidate({
				workspaceId: OWNING_WORKSPACE_OF_CANDIDATE.workspaceId,
				workspaceRepositoryPath: OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
			}),
			createKanbanBoardCardIdentityCandidate({
				workspaceId: "workspace-second-owner",
				workspaceRepositoryPath: "/fake/second-owning-repo",
			}),
		];

		const { exitCode, output } = await runKanbanTaskGetFromCurrentDirectory();

		expect(exitCode).toBe(1);
		expect(output.error).toEqual(
			expect.stringContaining(
				`Task id "${CROSS_PROJECT_TASK_ID}" matches more than one Kanban task card (${OWNING_WORKSPACE_OF_CANDIDATE.repoPath}, /fake/second-owning-repo); pass --project-path to choose one.`,
			),
		);
	});

	it("只有墓碑候选：照旧返回永久删除的身份墓碑", async () => {
		harness.kanbanBoardCardIdentityCandidates = [
			createKanbanBoardCardIdentityCandidate({
				workspaceId: OWNING_WORKSPACE_OF_CANDIDATE.workspaceId,
				workspaceRepositoryPath: OWNING_WORKSPACE_OF_CANDIDATE.repoPath,
				permanentlyRemovedFromBoardAt: 5,
			}),
		];

		const { exitCode, output } = await runKanbanTaskGetFromCurrentDirectory();

		expect(exitCode).not.toBe(1);
		expect(output).toEqual({
			ok: true,
			taskPermanentlyRemovedFromBoard: true,
			permanentlyRemovedTaskIdentityTombstones: harness.kanbanBoardCardIdentityCandidates,
		});
	});
});
