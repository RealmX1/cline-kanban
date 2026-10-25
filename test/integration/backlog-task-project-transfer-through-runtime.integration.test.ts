import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardCard } from "../../src/core/api-contract";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { listKanbanBoardCardIdentityProjectionsByBareTaskId } from "../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
} from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	recoverPendingBacklogTaskProjectTransfers,
	transferNeverStartedBacklogTaskToProject,
} from "../../src/state/backlog-task-project-transfer";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	getRuntimeHomePath,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createTaskCardActionApi } from "../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
	TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
} from "../utilities/task-mutation-intent-for-test-fixture";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function createIsolatedBacklogTaskProjectTransferScenario() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const source = fixture.createNonBareRepository({
		repositoryDirectoryName: "transfer-source",
		initialBranchName: "main",
	});
	const target = fixture.createNonBareRepository({
		repositoryDirectoryName: "transfer-target",
		initialBranchName: "target-main",
	});
	for (const repository of [source, target]) {
		await writeFile(join(repository.repositoryPath, "project.txt"), "隔离迁移测试\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "建立隔离项目",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
	}
	const originalCard: RuntimeBoardCard = {
		id: "move2",
		title: "保留完整原文的任务",
		prompt: "迁移前完整正文",
		startInPlanMode: true,
		baseRef: "main",
		createdAt: 2345,
		updatedAt: 2345,
		images: [{ id: "original-image", data: "b3JpZ2luYWw=", mimeType: "image/png", name: "原始附件.png" }],
		taskCommentEntries: [
			{ taskCommentEntryId: randomUUID(), commentText: "原始备注", createdAt: 2345, updatedAt: 2345 },
		],
	};
	const initialSourceState = await loadWorkspaceState(source.repositoryPath);
	await saveWorkspaceState(source.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: {
			...initialSourceState.board,
			columns: initialSourceState.board.columns.map((column) =>
				column.id === "backlog" ? { ...column, cards: [originalCard] } : column,
			),
		},
		sessions: {},
	});
	const sourceScope = await loadWorkspaceContext(source.repositoryPath);
	const targetSnapshotBeforeTransfer = await loadWorkspaceState(target.repositoryPath);
	const targetScope = await loadWorkspaceContext(target.repositoryPath);
	const request = {
		operationId: randomUUID(),
		taskId: originalCard.id,
		taskIncarnationCreatedAtEpochMs: originalCard.createdAt,
		targetWorkspaceId: targetScope.workspaceId,
		targetBaseRef: "target-main",
	};
	return { source, target, sourceScope, targetScope, originalCard, request, targetSnapshotBeforeTransfer };
}

describe("未启动 Backlog 跨项目迁移", { timeout: 60000 }, () => {
	it("保持同一身份，支持返回原项目，拒绝旧整板复活，并在目标写入后恢复", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const source = fixture.createNonBareRepository({
			repositoryDirectoryName: "transfer-source",
			initialBranchName: "main",
		});
		const target = fixture.createNonBareRepository({
			repositoryDirectoryName: "transfer-target",
			initialBranchName: "main",
		});
		for (const repository of [source, target]) {
			await writeFile(join(repository.repositoryPath, "project.txt"), "隔离迁移测试\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "建立隔离项目",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
		}
		const card: RuntimeBoardCard = {
			id: "move1",
			title: "保持身份的任务",
			prompt: "完整任务正文",
			startInPlanMode: true,
			baseRef: "main",
			createdAt: 1234,
			updatedAt: 1234,
			taskCommentEntries: [
				{ taskCommentEntryId: randomUUID(), commentText: "保留备注", createdAt: 1234, updatedAt: 1234 },
			],
		};
		await saveWorkspaceState(source.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: { columns: [{ id: "backlog", title: "Backlog", cards: [card] }] },
			sessions: {},
		});
		const sourceScope = await loadWorkspaceContext(source.repositoryPath);
		const targetScope = await loadWorkspaceContext(target.repositoryPath);
		const capture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		try {
			await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			const request = {
				operationId: randomUUID(),
				taskId: card.id,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				targetWorkspaceId: targetScope.workspaceId,
				targetBaseRef: "main",
			};
			const originalBoard = await loadWorkspaceBoardById(sourceScope.workspaceId);
			await transferNeverStartedBacklogTaskToProject(
				sourceScope.workspaceId,
				request,
				TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
			);
			await transferNeverStartedBacklogTaskToProject(
				sourceScope.workspaceId,
				request,
				TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
			);
			expect(
				(await loadWorkspaceBoardById(sourceScope.workspaceId)).columns.flatMap((column) => column.cards),
			).toHaveLength(0);
			expect(
				(await loadWorkspaceBoardById(targetScope.workspaceId)).columns.flatMap((column) => column.cards),
			).toEqual([card]);
			await expect(
				saveWorkspaceState(source.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: originalBoard,
					sessions: {},
				}),
			).rejects.toThrow("旧看板快照");
			await readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((reader) => {
				const identities = listKanbanBoardCardIdentityProjectionsByBareTaskId(
					reader.projectionState.kanbanBoardCardIdentityProjectionState,
					card.id,
				);
				expect(identities).toHaveLength(1);
				expect(identities[0]?.kanbanBoardCard.workspaceId).toBe(sourceScope.workspaceId);
				expect(identities[0]?.currentWorkspaceId).toBe(targetScope.workspaceId);
				expect(identities[0]?.permanentlyRemovedFromBoardAt).toBeNull();
			});
			await transferNeverStartedBacklogTaskToProject(
				targetScope.workspaceId,
				{ ...request, operationId: randomUUID(), targetWorkspaceId: sourceScope.workspaceId },
				TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
			);
			const recoveryRequest = { ...request, operationId: randomUUID() };
			const receiptPath = join(
				getRuntimeHomePath(),
				"backlog-task-project-transfers",
				`${recoveryRequest.operationId}.json`,
			);

			const originalWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
			const powerLoss = vi
				.spyOn(lockedFileSystem, "writeJsonFileAtomic")
				.mockImplementation(async (path, value, options) => {
					if (
						path === receiptPath &&
						value &&
						typeof value === "object" &&
						"status" in value &&
						value.status === "target_saved"
					)
						throw new Error("模拟断电");
					return originalWrite(path, value, options);
				});
			await expect(
				transferNeverStartedBacklogTaskToProject(
					sourceScope.workspaceId,
					recoveryRequest,
					TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
				),
			).rejects.toThrow("模拟断电");
			powerLoss.mockRestore();

			await recoverPendingBacklogTaskProjectTransfers(sourceScope.workspaceId);
			expect(JSON.parse(await readFile(receiptPath, "utf8")).status).toBe("completed");
			expect(
				(await loadWorkspaceBoardById(targetScope.workspaceId)).columns.flatMap((column) => column.cards),
			).toEqual([card]);
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			await capture.deactivate();
		}
	});

	it("中断恢复保留目标合法新值、来源原文证据和唯一迁移审计", async () => {
		const scenario = await createIsolatedBacklogTaskProjectTransferScenario();
		const { sourceScope, targetScope, originalCard, target, request } = scenario;
		const receiptPath = join(getRuntimeHomePath(), "backlog-task-project-transfers", `${request.operationId}.json`);
		const capture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		try {
			await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			const originalWrite = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
			const powerLoss = vi
				.spyOn(lockedFileSystem, "writeTextFileAtomic")
				.mockImplementation((path, value, options) => {
					if (path === join(sourceScope.statePath, "board.json")) throw new Error("模拟目标已落盘后的断电");
					return originalWrite(path, value, options);
				});
			await expect(
				transferNeverStartedBacklogTaskToProject(
					sourceScope.workspaceId,
					request,
					TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
				),
			).rejects.toThrow("模拟目标已落盘后的断电");
			powerLoss.mockRestore();
			expect(JSON.parse(await readFile(receiptPath, "utf8")).status).toBe("target_saved");

			const targetState = await loadWorkspaceState(target.repositoryPath);
			const editedTargetCard: RuntimeBoardCard = {
				...originalCard,
				title: "目标项目中合法更新的标题",
				prompt: "目标项目中合法更新的正文",
				baseRef: request.targetBaseRef,
				updatedAt: 3456,
				images: [...(originalCard.images ?? []), { id: "new-image", data: "bmV3", mimeType: "image/png" }],
				taskCommentEntries: [
					...(originalCard.taskCommentEntries ?? []),
					{ taskCommentEntryId: randomUUID(), commentText: "目标新增备注", createdAt: 3456, updatedAt: 3456 },
				],
			};
			await saveWorkspaceState(target.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					...targetState.board,
					columns: targetState.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((card) => (card.id === originalCard.id ? editedTargetCard : card)),
					})),
				},
				sessions: {},
				expectedRevision: targetState.revision,
			});

			await recoverPendingBacklogTaskProjectTransfers(sourceScope.workspaceId);
			await recoverPendingBacklogTaskProjectTransfers(targetScope.workspaceId);
			expect(
				(await loadWorkspaceBoardById(targetScope.workspaceId)).columns.flatMap((column) => column.cards),
			).toEqual([editedTargetCard]);
			expect(
				(await loadWorkspaceBoardById(sourceScope.workspaceId)).columns.flatMap((column) => column.cards),
			).toEqual([]);
			const completedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
			expect(completedReceipt.status).toBe("completed");
			expect(completedReceipt.taskCard).toEqual(originalCard);
			const events = await capture.ledgerClient.listCommittedEvents({ subjectTaskId: originalCard.id });
			expect(events.filter((event) => event.eventKind === "task_card_project_transfer_completed")).toHaveLength(1);
			expect(
				events.some(
					(event) =>
						event.subjectWorkspaceId === targetScope.workspaceId &&
						event.eventKind === "task_card_field_value_changed",
				),
			).toBe(true);
			await readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((reader) => {
				const identities = listKanbanBoardCardIdentityProjectionsByBareTaskId(
					reader.projectionState.kanbanBoardCardIdentityProjectionState,
					originalCard.id,
				);
				expect(identities).toHaveLength(1);
				expect(identities[0]?.currentWorkspaceId).toBe(targetScope.workspaceId);
				expect(identities[0]?.permanentlyRemovedFromBoardAt).toBeNull();
			});
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			await capture.deactivate();
		}
	});

	it("拒绝旧目标整板遗漏迁入卡，并允许显式卡片动作移列和删除", async () => {
		const { sourceScope, targetScope, originalCard, target, request, targetSnapshotBeforeTransfer } =
			await createIsolatedBacklogTaskProjectTransferScenario();
		await transferNeverStartedBacklogTaskToProject(
			sourceScope.workspaceId,
			request,
			TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
		);
		const currentTargetState = await loadWorkspaceState(target.repositoryPath);
		await expect(
			saveWorkspaceState(target.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: targetSnapshotBeforeTransfer.board,
				sessions: {},
				expectedRevision: targetSnapshotBeforeTransfer.revision,
			}),
		).rejects.toMatchObject({ name: "WorkspaceStateConflictError" });
		await expect(
			saveWorkspaceState(target.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: targetSnapshotBeforeTransfer.board,
				sessions: {},
			}),
		).rejects.toThrow("迁入");
		expect(await loadWorkspaceState(target.repositoryPath)).toMatchObject({
			board: currentTargetState.board,
			revision: currentTargetState.revision,
		});

		const cardActions = createTaskCardActionApi({
			runtimeApi: {
				startTaskSession: async () => {
					throw new Error("本用例不应启动会话");
				},
				stopTaskSession: async () => ({ ok: true, summary: null }),
				transitionTaskToReview: async () => {
					throw new Error("本用例不应交接会话");
				},
			},
			workspaceApi: {
				ensureWorktree: async () => {
					throw new Error("本用例不应建立工作树");
				},
				deleteWorktree: async () => ({ ok: true, removed: false }),
			},
			broadcastRuntimeWorkspaceStateUpdated: () => undefined,
			broadcastRuntimeProjectsUpdated: () => undefined,
			findTaskSessionSummaryLiveInRuntimeProcessMemory: () => null,
			taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
		});
		const targetActionScope = { workspaceId: targetScope.workspaceId, workspacePath: target.repositoryPath };
		const moved = await cardActions.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			targetActionScope,
			{ taskId: originalCard.id },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(moved.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe("trash");
		const deleted = await cardActions.permanentlyDeleteTaskCardsWithFullResourceCleanup(
			targetActionScope,
			{
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
					selectedTaskIds: [originalCard.id],
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(deleted.permanentlyDeletedTaskCards).toHaveLength(1);
		expect((await loadWorkspaceBoardById(targetScope.workspaceId)).columns.flatMap((column) => column.cards)).toEqual(
			[],
		);
	});

	it("携带当前版本的整板仍允许显式删除迁入卡", async () => {
		const { sourceScope, targetScope, target, request, targetSnapshotBeforeTransfer } =
			await createIsolatedBacklogTaskProjectTransferScenario();
		await transferNeverStartedBacklogTaskToProject(
			sourceScope.workspaceId,
			request,
			TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
		);
		const currentTargetState = await loadWorkspaceState(target.repositoryPath);
		await saveWorkspaceState(target.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: targetSnapshotBeforeTransfer.board,
			sessions: {},
			expectedRevision: currentTargetState.revision,
		});
		expect((await loadWorkspaceBoardById(targetScope.workspaceId)).columns.flatMap((column) => column.cards)).toEqual(
			[],
		);
	});
});
