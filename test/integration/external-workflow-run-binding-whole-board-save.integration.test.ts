import { readFileSync, writeFileSync } from "node:fs";
import type * as NodeOsModule from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeBoardData, RuntimeExternalWorkflowRunBinding } from "../../src/core/api-contract";
import { validateExternalWorkflowRunBindingUpdate } from "../../src/core/task-external-workflow-run-binding";
import {
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// 仅将账号锁目录定向到隔离 HOME；实际 SQLite 锁与持久化漏斗保持原样。
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof NodeOsModule>();
	return { ...original, userInfo: () => ({ ...original.userInfo(), homedir: original.homedir() }) };
});

afterEach(() => vi.unstubAllEnvs());

const stoppedObservation: NonNullable<RuntimeExternalWorkflowRunBinding["lastObservedState"]> = {
	observedAtEpochMs: 20,
	availability: "observed",
	businessStage: "planning",
	executionQualification: "explicitly_stopped",
	waitingReason: "用户已停止原 Run",
	materialFilePaths: ["/persistent/workflow-artifacts/plan.md"],
};

async function createExternalWorkflowWorkspace(bindingAlreadyRegistered = true) {
	const fixture = createIsolatedGitTestWorkspaceFixture({
		fixtureRootDirectoryNamePrefix: "external-workflow-board-save-",
	});
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"));
	const repository = fixture.createNonBareRepository({
		repositoryDirectoryName: "external-workflow-project",
		initialBranchName: "main",
	});
	writeFileSync(join(repository.repositoryPath, "README.md"), "隔离整板保存回归\n");
	repository.commitAllRepositoryFilesAtDate({
		message: "初始化隔离项目",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	const context = await loadWorkspaceContext(repository.repositoryPath);
	const binding: RuntimeExternalWorkflowRunBinding = {
		owningWorkspaceId: context.workspaceId,
		owningTaskId: "workflow-task",
		owningTaskIncarnationCreatedAtEpochMs: 1,
		workflowProviderId: "software-factory",
		workflowKind: "delivery_planning",
		workItemId: "original-work-item",
		runId: "stopped-original-run",
		workflowDatabasePath: "/persistent/workflows.sqlite",
		artifactDirectoryPath: "/persistent/workflow-artifacts",
		lastObservedState: stoppedObservation,
	};
	const seeded = await mutateWorkspaceState(
		repository.repositoryPath,
		TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
		(state) => ({
			board: {
				...state.board,
				columns: state.board.columns.map((column) => ({
					...column,
					cards:
						column.id === "backlog"
							? [
									{
										id: "workflow-task",
										title: "原任务",
										prompt: "原始需求",
										baseRef: "main",
										startInPlanMode: false,
										createdAt: 1,
										updatedAt: 1,
										externalWorkflowRunBinding: bindingAlreadyRegistered ? binding : undefined,
									},
								]
							: [],
				})),
			},
			value: null,
		}),
	);
	return { repositoryPath: repository.repositoryPath, context, binding, state: seeded.state };
}

const wholeBoardBindingOverrides: Array<[string, Partial<RuntimeExternalWorkflowRunBinding> | undefined]> = [
	["省略整个引用", undefined],
	["替换 Run", { runId: "replacement-run" }],
	["替换 Work Item", { workItemId: "replacement-work-item" }],
	["替换数据库", { workflowDatabasePath: "/persistent/replacement.sqlite" }],
	["替换产物目录", { artifactDirectoryPath: "/persistent/replacement-artifacts" }],
	["伪造工作区归属", { owningWorkspaceId: "another-workspace" }],
	["伪造任务归属", { owningTaskId: "another-task" }],
	["伪造引用代次", { owningTaskIncarnationCreatedAtEpochMs: 2 }],
	["回退观察", { lastObservedState: { ...stoppedObservation, observedAtEpochMs: 10 } }],
	["同时间不同观察", { lastObservedState: { ...stoppedObservation, availability: "unavailable" } }],
	["清除已有观察", { lastObservedState: undefined }],
	[
		"绕过显式入口发布新观察",
		{
			lastObservedState: {
				...stoppedObservation,
				observedAtEpochMs: 30,
				executionQualification: "stage_work_required",
			},
		},
	],
];

it.each(wholeBoardBindingOverrides)("整板保存保留当前代次的服务端引用：%s", async (_label, override) => {
	const { repositoryPath, context, binding, state } = await createExternalWorkflowWorkspace();
	const saved = await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		expectedRevision: state.revision,
		sessions: {},
		board: {
			...state.board,
			columns: state.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => ({
					...card,
					title: "仍可保存普通看板编辑",
					externalWorkflowRunBinding: override === undefined ? undefined : { ...binding, ...override },
				})),
			})),
		},
	});
	const savedCard = saved.board.columns.flatMap((column) => column.cards)[0];
	expect(savedCard?.title).toBe("仍可保存普通看板编辑");
	expect(savedCard?.externalWorkflowRunBinding).toEqual(binding);
	expect(saved.revision).toBe(state.revision + 1);
	const persistedBoard = JSON.parse(readFileSync(join(context.statePath, "board.json"), "utf8")) as RuntimeBoardData;
	expect(persistedBoard.columns.flatMap((column) => column.cards)[0]?.externalWorkflowRunBinding).toEqual(binding);
	const reloaded = await loadWorkspaceState(repositoryPath);
	expect(reloaded.board.columns.flatMap((column) => column.cards)[0]?.externalWorkflowRunBinding).toEqual(binding);
	expect(() =>
		validateExternalWorkflowRunBindingUpdate(
			savedCard,
			{ ...binding, runId: "replacement-run" },
			context.workspaceId,
			1,
		),
	).toThrow("不能以替换引用绕过原执行");
});

it("整板伪造卡片与引用的新代次不能替换原 Run 或解除 Stop", async () => {
	const { repositoryPath, context, binding, state } = await createExternalWorkflowWorkspace();
	const saved = await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		expectedRevision: state.revision,
		sessions: {},
		board: {
			...state.board,
			columns: state.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => ({
					...card,
					createdAt: 2,
					externalWorkflowRunBinding: {
						...binding,
						owningTaskIncarnationCreatedAtEpochMs: 2,
						runId: "replacement-run-for-forged-incarnation",
						lastObservedState: {
							...stoppedObservation,
							observedAtEpochMs: 30,
							executionQualification: "stage_work_required",
						},
					},
				})),
			})),
		},
	});
	const persistedBoard = JSON.parse(readFileSync(join(context.statePath, "board.json"), "utf8")) as RuntimeBoardData;
	const reloaded = await loadWorkspaceState(repositoryPath);
	for (const board of [saved.board, persistedBoard, reloaded.board]) {
		const cards = board.columns.flatMap((column) => column.cards);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.createdAt).toBe(1);
		expect(cards[0]?.externalWorkflowRunBinding).toEqual(binding);
	}
});

it("无 revision 的旧快照也不能抹掉服务端刚登记的失联观察", async () => {
	const { repositoryPath, binding, state } = await createExternalWorkflowWorkspace();
	const unavailableBinding = {
		...binding,
		lastObservedState: { ...stoppedObservation, observedAtEpochMs: 30, availability: "unavailable" as const },
	};
	await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (current) => ({
		board: {
			...current.board,
			columns: current.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => ({ ...card, externalWorkflowRunBinding: unavailableBinding })),
			})),
		},
		value: null,
	}));
	const saved = await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: state.board,
		sessions: {},
	});
	expect(saved.board.columns.flatMap((column) => column.cards)[0]?.externalWorkflowRunBinding).toEqual(
		unavailableBinding,
	);
});

it.each([false, true])("整板保存不能为未绑定卡伪造首次绑定（新建卡：%s）", async (newTaskCard) => {
	const { repositoryPath, binding, state } = await createExternalWorkflowWorkspace(false);
	const taskId = newTaskCard ? "new-workflow-task" : "workflow-task";
	const saved = await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		expectedRevision: state.revision,
		sessions: {},
		board: {
			...state.board,
			columns: state.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => ({
					...card,
					id: taskId,
					externalWorkflowRunBinding: { ...binding, owningTaskId: taskId },
				})),
			})),
		},
	});
	expect(saved.board.columns.flatMap((column) => column.cards)[0]?.externalWorkflowRunBinding).toBeUndefined();
});
