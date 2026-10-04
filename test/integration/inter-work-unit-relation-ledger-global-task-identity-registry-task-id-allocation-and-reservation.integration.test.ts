import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import {
	collectTaskIdReservationSeedEntriesFromExistingLocalTraces,
	collectTaskIdReservationSeedingResultFromExistingLocalTraces,
} from "../../src/inter-work-unit-relation-ledger/global-task-identity-registry-task-id-reservation-seeding-from-existing-local-traces";
import {
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	InterWorkUnitRelationLedgerUnavailableError,
} from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	createCapturingKanbanRuntimeInstanceIdentity,
	createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger,
} from "../../src/inter-work-unit-relation-ledger/workspace-board-persistence-funnel-task-mutation-event-capture-backed-by-relation-ledger";
import {
	allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable,
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	type WorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
} from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	getWorkspaceDirectoryPath,
	getWorkspacesRootPath,
	loadWorkspaceContext,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// 让 runtime 分配时生成的候选 id 可控：排队的候选按序先出，排空后回落到真实的随机生成。
// 只有这样才能确定性地复现「分配恰好抽中一个本机痕迹里出现过、但还没播种的 id」。
const shortTaskIdCandidateOverridesForAllocation = vi.hoisted(() => ({
	forcedShortTaskIdCandidatesInDrawOrder: [] as string[],
}));

vi.mock("../../src/core/task-id", async (importOriginal) => {
	const originalTaskIdModule = await importOriginal<
		Record<string, unknown> & { createShortTaskId: (randomUuid: () => string) => string }
	>();
	return {
		...originalTaskIdModule,
		createShortTaskId: (randomUuid: () => string) =>
			shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder.shift() ??
			originalTaskIdModule.createShortTaskId(randomUuid),
	};
});

function createCard(taskId: string, createdAt: number): RuntimeBoardCard {
	return {
		id: taskId,
		title: `card ${taskId}`,
		prompt: `card ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBacklogBoard(cards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function listBoardTaskIds(board: RuntimeBoardData): string[] {
	return board.columns.flatMap((column) => column.cards.map((card) => card.id));
}

async function withTwoIsolatedWorkspacesAndLedger(
	run: (context: {
		firstWorkspacePath: string;
		secondWorkspacePath: string;
		isolatedHomeDirectoryPath: string;
		ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
		realCapture: WorkspaceBoardPersistenceFunnelTaskMutationEventCapture;
	}) => Promise<void>,
): Promise<void> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const previousHome = process.env.HOME;
	process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
	const ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
		join(gitFixture.isolatedHomeDirectoryPath, "inter-work-unit-relation-ledger-test-root"),
	);
	try {
		const workspacePaths = ["project-a", "project-b"].map((projectName) => {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, projectName);
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			return repositoryPath;
		});
		for (const workspacePath of workspacePaths) {
			await loadWorkspaceState(workspacePath);
		}
		const realCapture = createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger({
			ledgerClient,
			capturingKanbanRuntimeInstance: createCapturingKanbanRuntimeInstanceIdentity(),
		});
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);
		await run({
			firstWorkspacePath: workspacePaths[0] as string,
			secondWorkspacePath: workspacePaths[1] as string,
			isolatedHomeDirectoryPath: gitFixture.isolatedHomeDirectoryPath,
			ledgerClient,
			realCapture,
		});
	} finally {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		await ledgerClient.close();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		gitFixture.cleanup();
	}
}

// 走真实的 live capture 激活（账本存储根由 vitest setup 按测试文件隔离）；HOME 指到 fixture，
// 本机痕迹（~/.cline/worktrees、~/.claude/projects、workspace 索引）全落在 fixture 里，绝不碰真实 HOME。
// workspaceIdsInProjectDirectoryNameOrder 与传入的项目目录名一一对应、同序。
async function withIsolatedHomeContainingIndexedWorkspacesForLiveCaptureActivation(
	projectDirectoryNames: string[],
	run: (context: {
		isolatedHomeDirectoryPath: string;
		workspaceIdsInProjectDirectoryNameOrder: string[];
	}) => Promise<void>,
): Promise<void> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const previousHome = process.env.HOME;
	process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
	try {
		const workspaceIdsInProjectDirectoryNameOrder: string[] = [];
		for (const projectDirectoryName of projectDirectoryNames) {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, projectDirectoryName);
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			await loadWorkspaceState(repositoryPath);
			workspaceIdsInProjectDirectoryNameOrder.push((await loadWorkspaceContext(repositoryPath)).workspaceId);
		}
		await run({
			isolatedHomeDirectoryPath: gitFixture.isolatedHomeDirectoryPath,
			workspaceIdsInProjectDirectoryNameOrder,
		});
	} finally {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder.length = 0;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		gitFixture.cleanup();
	}
}

async function listTaskIdsNewlyReservedBySeedingFromExistingLocalTraces(
	ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient,
): Promise<string[]> {
	return (await ledgerClient.listCommittedEvents({}))
		.filter((event) => event.eventKind === "task_id_reservation_seeded_from_existing_artifacts")
		.flatMap((event) =>
			(event.eventPayload.newlyReservedTaskIdEntries as Array<{ taskId: string }>).map((entry) => entry.taskId),
		);
}

describe("global task identity registry: runtime task id allocation and reservation", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder.length = 0;
	});

	it("waits for activation-time seeding before allocating, so an allocation requested right after activation never hands out an id seen in local traces", async () => {
		await withIsolatedHomeContainingIndexedWorkspacesForLiveCaptureActivation(
			["project-allocating-right-after-activation"],
			async ({ isolatedHomeDirectoryPath, workspaceIdsInProjectDirectoryNameOrder: [workspaceId] }) => {
				if (!workspaceId) throw new Error("Expected one indexed workspace.");
				mkdirSync(join(isolatedHomeDirectoryPath, ".cline", "worktrees", "e0005"), { recursive: true });
				// 第一个候选就是痕迹里的 id：若分配不等播种，它会先于播种被占成「已分配」并原样返回。
				shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder.push("e0005");

				const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
				try {
					const allocatedTaskId = await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
						requestingWorkspaceId: workspaceId,
					});
					expect(shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder).toEqual([]);
					expect(allocatedTaskId).not.toBe("e0005");
					expect(allocatedTaskId).toMatch(/^[0-9a-f]{5}$/u);
					expect(
						await listTaskIdsNewlyReservedBySeedingFromExistingLocalTraces(activatedLiveCapture.ledgerClient),
					).toContain("e0005");
				} finally {
					await activatedLiveCapture.deactivate();
				}
			},
		);
	});

	it("keeps allocation fail-closed while a local trace directory cannot be read, and allocates again once a later seeding attempt succeeds", async () => {
		await withIsolatedHomeContainingIndexedWorkspacesForLiveCaptureActivation(
			["project-with-unreadable-task-worktrees-directory-at-activation"],
			async ({ isolatedHomeDirectoryPath, workspaceIdsInProjectDirectoryNameOrder: [workspaceId] }) => {
				if (!workspaceId) throw new Error("Expected one indexed workspace.");
				const taskWorktreesHomePath = join(isolatedHomeDirectoryPath, ".cline", "worktrees");
				mkdirSync(join(taskWorktreesHomePath, "f0006"), { recursive: true });
				mkdirSync(getWorkspaceDirectoryPath(workspaceId), { recursive: true });
				writeFileSync(
					join(getWorkspaceDirectoryPath(workspaceId), "board.json"),
					JSON.stringify(createBacklogBoard([createCard("f0007", 1_000)]), null, 2),
				);
				// 非 ENOENT/ENOTDIR 的痕迹目录读失败（EACCES）：播种不能装作「这里没有 id」，分配必须拒绝。
				chmodSync(taskWorktreesHomePath, 0o000);
				try {
					const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
					try {
						await expect(
							allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
								requestingWorkspaceId: workspaceId,
							}),
						).rejects.toBeInstanceOf(InterWorkUnitRelationLedgerUnavailableError);
						// 播种失败不拖垮急切基线任务（它永不 reject），只是分配保持拒绝。
						await expect(
							activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion,
						).resolves.toBeUndefined();
						expect(
							await listTaskIdsNewlyReservedBySeedingFromExistingLocalTraces(activatedLiveCapture.ledgerClient),
						).not.toContain("f0006");

						// 目录恢复可读后，下一次分配重新发起播种；成功之后才放行，且不会抽中刚占住的痕迹 id。
						// board 上的 f0007 已由（不等播种成功的）急切基线登记，所以只断言 f0006 由播种新占住。
						chmodSync(taskWorktreesHomePath, 0o755);
						shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder.push(
							"f0006",
							"f0007",
						);
						const allocatedTaskId = await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
							requestingWorkspaceId: workspaceId,
						});
						expect(shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder).toEqual([]);
						expect(allocatedTaskId).not.toBe("f0006");
						expect(allocatedTaskId).not.toBe("f0007");
						expect(allocatedTaskId).toMatch(/^[0-9a-f]{5}$/u);
						expect(
							await listTaskIdsNewlyReservedBySeedingFromExistingLocalTraces(activatedLiveCapture.ledgerClient),
						).toContain("f0006");
					} finally {
						await activatedLiveCapture.deactivate();
					}
				} finally {
					// 失败路径也要恢复权限，否则 fixture 清理删不掉这个目录。
					chmodSync(taskWorktreesHomePath, 0o755);
				}
			},
		);
	});

	it("keeps seeding fail-closed when the workspace index itself cannot be read", async () => {
		await withIsolatedHomeContainingIndexedWorkspacesForLiveCaptureActivation(
			["project-with-unreadable-workspace-index-at-seeding"],
			async ({ isolatedHomeDirectoryPath }) => {
				writeFileSync(join(getWorkspacesRootPath(), "index.json"), "{ this workspace index is not valid json");
				await expect(
					collectTaskIdReservationSeedingResultFromExistingLocalTraces({
						taskWorktreesHomePath: join(isolatedHomeDirectoryPath, ".cline", "worktrees"),
						claudeCodeProjectsDirectoryPath: join(isolatedHomeDirectoryPath, ".claude", "projects"),
					}),
				).rejects.toThrow(/Malformed JSON/u);
			},
		);
	});

	it("skips only the workspace whose board or sessions file is unreadable, so other workspaces can still allocate task ids", async () => {
		await withIsolatedHomeContainingIndexedWorkspacesForLiveCaptureActivation(
			[
				"project-a-with-malformed-board-json",
				"project-b-with-schema-invalid-sessions-json",
				"project-c-with-healthy-board",
			],
			async ({
				isolatedHomeDirectoryPath,
				workspaceIdsInProjectDirectoryNameOrder: [
					workspaceIdWithMalformedBoardJson,
					workspaceIdWithSchemaInvalidSessionsJson,
					workspaceIdWithHealthyBoard,
				],
			}) => {
				if (
					!workspaceIdWithMalformedBoardJson ||
					!workspaceIdWithSchemaInvalidSessionsJson ||
					!workspaceIdWithHealthyBoard
				) {
					throw new Error("Expected three indexed workspaces.");
				}
				for (const workspaceId of [
					workspaceIdWithMalformedBoardJson,
					workspaceIdWithSchemaInvalidSessionsJson,
					workspaceIdWithHealthyBoard,
				]) {
					mkdirSync(getWorkspaceDirectoryPath(workspaceId), { recursive: true });
				}
				writeFileSync(
					join(getWorkspaceDirectoryPath(workspaceIdWithMalformedBoardJson), "board.json"),
					"{ this board file is not valid json",
				);
				writeFileSync(
					join(getWorkspaceDirectoryPath(workspaceIdWithSchemaInvalidSessionsJson), "sessions.json"),
					JSON.stringify({ d0003: { notATaskSessionSummary: true } }),
				);
				writeFileSync(
					join(getWorkspaceDirectoryPath(workspaceIdWithHealthyBoard), "board.json"),
					JSON.stringify(createBacklogBoard([createCard("d0001", 1_000)]), null, 2),
				);
				mkdirSync(join(isolatedHomeDirectoryPath, ".cline", "worktrees", "d0002"), { recursive: true });

				const seedingCollectionResult = await collectTaskIdReservationSeedingResultFromExistingLocalTraces({
					taskWorktreesHomePath: join(isolatedHomeDirectoryPath, ".cline", "worktrees"),
					claudeCodeProjectsDirectoryPath: join(isolatedHomeDirectoryPath, ".claude", "projects"),
				});
				expect(seedingCollectionResult.seededTaskIdEntries.map((entry) => entry.taskId)).toEqual([
					"d0001",
					"d0002",
				]);
				expect(
					seedingCollectionResult.workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding.map(
						(skippedWorkspace) => skippedWorkspace.workspaceId,
					),
				).toEqual([workspaceIdWithMalformedBoardJson, workspaceIdWithSchemaInvalidSessionsJson]);
				expect(
					seedingCollectionResult.workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding[0]
						?.boardSessionsOrMetaFileReadFailureMessage,
				).toMatch(/Malformed JSON/u);

				shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder.push("d0001", "d0002");
				const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
				try {
					const allocatedTaskId = await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
						requestingWorkspaceId: workspaceIdWithHealthyBoard,
					});
					expect(shortTaskIdCandidateOverridesForAllocation.forcedShortTaskIdCandidatesInDrawOrder).toEqual([]);
					expect(allocatedTaskId).not.toBe("d0001");
					expect(allocatedTaskId).not.toBe("d0002");
					expect(allocatedTaskId).toMatch(/^[0-9a-f]{5}$/u);
					const reservedTaskIds = await listTaskIdsNewlyReservedBySeedingFromExistingLocalTraces(
						activatedLiveCapture.ledgerClient,
					);
					expect(reservedTaskIds).toEqual(expect.arrayContaining(["d0001", "d0002"]));
					// 被跳过的 workspace 里的 id 这次没占住——这是「不让一个坏文件阻断全局分配」的已知代价。
					expect(reservedTaskIds).not.toContain("d0003");
				} finally {
					await activatedLiveCapture.deactivate();
				}
			},
		);
	});

	it("rejects a new card whose id is already taken by a card in another workspace, and leaves that board unwritten", async () => {
		await withTwoIsolatedWorkspacesAndLedger(async ({ firstWorkspacePath, secondWorkspacePath }) => {
			await saveWorkspaceState(firstWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBacklogBoard([createCard("a0001", 1_000)]),
				sessions: {},
			});

			await expect(
				saveWorkspaceState(secondWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: createBacklogBoard([createCard("a0001", 2_000)]),
					sessions: {},
				}),
			).rejects.toThrow(/task_id_already_registered_in_global_task_identity_registry/u);
			expect(listBoardTaskIds((await loadWorkspaceState(secondWorkspacePath)).board)).toEqual([]);
		});
	});

	it("never reuses the id of a permanently deleted card for a new incarnation", async () => {
		await withTwoIsolatedWorkspacesAndLedger(async ({ firstWorkspacePath }) => {
			await saveWorkspaceState(firstWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBacklogBoard([createCard("a0001", 1_000)]),
				sessions: {},
			});
			await saveWorkspaceState(firstWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBacklogBoard([]),
				sessions: {},
			});

			await expect(
				saveWorkspaceState(firstWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: createBacklogBoard([createCard("a0001", 5_000)]),
					sessions: {},
				}),
			).rejects.toThrow(/task_id_already_registered_in_global_task_identity_registry/u);
			// 同一张卡（同 incarnation）重新出现不是复用，照常放行。
			await saveWorkspaceState(firstWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBacklogBoard([createCard("a0001", 1_000)]),
				sessions: {},
			});
		});
	});

	it("allocates ids that are only usable by the requesting workspace", async () => {
		await withTwoIsolatedWorkspacesAndLedger(async ({ firstWorkspacePath, secondWorkspacePath }) => {
			const secondWorkspaceId = (await loadWorkspaceContext(secondWorkspacePath)).workspaceId;
			const allocatedTaskId = await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
				requestingWorkspaceId: secondWorkspaceId,
			});
			if (allocatedTaskId === null) {
				throw new Error("Expected the registered live capture to allocate a task id.");
			}
			expect(allocatedTaskId).toMatch(/^[0-9a-f]{5}$/u);

			await expect(
				saveWorkspaceState(firstWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: createBacklogBoard([createCard(allocatedTaskId, 1_000)]),
					sessions: {},
				}),
			).rejects.toThrow(/task_id_already_registered_in_global_task_identity_registry/u);
			await saveWorkspaceState(secondWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBacklogBoard([createCard(allocatedTaskId, 1_000)]),
				sessions: {},
			});
			expect(listBoardTaskIds((await loadWorkspaceState(secondWorkspacePath)).board)).toEqual([allocatedTaskId]);
		});
	});

	it("reserves ids seen in local traces once, so a new card cannot take them", async () => {
		await withTwoIsolatedWorkspacesAndLedger(
			async ({ firstWorkspacePath, isolatedHomeDirectoryPath, ledgerClient }) => {
				const taskWorktreesHomePath = join(isolatedHomeDirectoryPath, "trace-worktrees");
				const claudeCodeProjectsDirectoryPath = join(isolatedHomeDirectoryPath, "trace-claude-projects");
				mkdirSync(join(taskWorktreesHomePath, "b0002"), { recursive: true });
				mkdirSync(join(taskWorktreesHomePath, "not-a-task-id-shaped-directory"), { recursive: true });
				mkdirSync(join(claudeCodeProjectsDirectoryPath, "-Users-someone--cline-worktrees-c0003-some-repo"), {
					recursive: true,
				});

				const seededTaskIdEntries = await collectTaskIdReservationSeedEntriesFromExistingLocalTraces({
					taskWorktreesHomePath,
					claudeCodeProjectsDirectoryPath,
				});
				expect(seededTaskIdEntries).toEqual([
					{ taskId: "b0002", observedInExistingLocalTraceSourceKinds: ["kanban_task_worktree_directory_name"] },
					{
						taskId: "c0003",
						observedInExistingLocalTraceSourceKinds: [
							"claude_code_projects_directory_name_of_kanban_task_worktree_session",
						],
					},
				]);
				const seedingEventDraft = {
					eventFamily: "fact_observed_by_kanban_runtime_event",
					eventKind: "task_id_reservation_seeded_from_existing_artifacts",
					occurredAt: 1,
					actor: {
						kanbanActorKind: "kanban_runtime_system_component",
						kanbanRuntimeSystemComponentName: "test_task_id_reservation_seeding",
					},
					actorNativeConversationSessionIdentity: null,
					actorKanbanTaskConversationSessionId: null,
					actorRepositoryIdentityAtEventTime: null,
					onBehalfOfInitiatingWorkUnit: null,
					causedBySystemExecutedCause: null,
					recordCaptureChannel: "live_runtime_capture",
					capturingKanbanRuntimeInstance: createCapturingKanbanRuntimeInstanceIdentity(),
					invokingKanbanCliCodeVersion: null,
					occurredAtConversationTurnReference: null,
					idempotencyKey: null,
					subjectWorkspaceId: null,
					subjectTaskId: null,
					eventPayload: { observedFactKind: "task_id_reservation_seeded_from_existing_artifacts" },
				} as const;
				expect(
					await ledgerClient.seedTaskIdReservationsFromExistingLocalTraces({
						seededTaskIdEntries,
						seedingEventDraft,
					}),
				).toBe(2);
				expect(
					await ledgerClient.seedTaskIdReservationsFromExistingLocalTraces({
						seededTaskIdEntries,
						seedingEventDraft,
					}),
				).toBe(0);
				const seedingEvents = (await ledgerClient.listCommittedEvents({})).filter(
					(event) => event.eventKind === "task_id_reservation_seeded_from_existing_artifacts",
				);
				expect(seedingEvents).toHaveLength(1);
				expect(seedingEvents[0]?.eventPayload.newlyReservedTaskIdEntries).toEqual(seededTaskIdEntries);

				await expect(
					saveWorkspaceState(firstWorkspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
						board: createBacklogBoard([createCard("c0003", 1_000)]),
						sessions: {},
					}),
				).rejects.toThrow(/task_id_already_registered_in_global_task_identity_registry/u);
			},
		);
	});
});
