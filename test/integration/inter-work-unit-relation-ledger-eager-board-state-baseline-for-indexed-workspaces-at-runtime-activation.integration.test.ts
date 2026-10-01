import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	getWorkspaceDirectoryPath,
	loadWorkspaceContext,
	mutateWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

function createBacklogCard(taskId: string, prompt: string): RuntimeBoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1_000,
		updatedAt: 1_000,
	};
}

function createBoardWithBacklogCards(backlogCards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: backlogCards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

// 账本存储根由 vitest setup 按测试文件隔离；workspace 索引随 HOME 走，这里把 HOME 指到 fixture，绝不碰真实 ~/.cline。
async function withIsolatedHomeContainingOneIndexedWorkspaceWrittenBeforeActivation(
	run: (context: { workspacePath: string; workspaceId: string }) => Promise<void>,
	// 账本存储根按测试文件隔离而不是按用例，workspaceId 又由仓库目录名派生：每个用例用自己的目录名，避免共用基线。
	projectDirectoryName = "project-indexed-before-activation",
): Promise<void> {
	const gitFixture: IsolatedGitTestWorkspaceFixture = createIsolatedGitTestWorkspaceFixture();
	const previousHome = process.env.HOME;
	process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
	try {
		const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, projectDirectoryName);
		mkdirSync(repositoryPath, { recursive: true });
		gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
		// 激活前（未注册捕获）写入的存量 board：模拟部署前就已存在的 workspace。
		await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: createBoardWithBacklogCards([createBacklogCard("t0001", "requirement written before deploy")]),
			sessions: {},
		});
		const workspaceContext = await loadWorkspaceContext(repositoryPath, { autoCreateIfMissing: false });
		await run({ workspacePath: workspaceContext.repoPath, workspaceId: workspaceContext.workspaceId });
	} finally {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		gitFixture.cleanup();
	}
}

describe("inter-work-unit relation ledger eager board state baseline at runtime activation", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it("baselines every indexed workspace right after activation without writing the board, so a later out-of-funnel edit is detected instead of absorbed", async () => {
		await withIsolatedHomeContainingOneIndexedWorkspaceWrittenBeforeActivation(
			async ({ workspacePath, workspaceId }) => {
				const boardFilePath = join(getWorkspaceDirectoryPath(workspaceId), "board.json");
				const metaFilePath = join(getWorkspaceDirectoryPath(workspaceId), "meta.json");
				const boardFileBytesBeforeActivation = readFileSync(boardFilePath, "utf8");
				const metaFileBytesBeforeActivation = readFileSync(metaFilePath, "utf8");

				const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
				try {
					await activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;

					// 建立基线不改 board 内容、不推进 revision、不写盘。
					expect(readFileSync(boardFilePath, "utf8")).toBe(boardFileBytesBeforeActivation);
					expect(readFileSync(metaFilePath, "utf8")).toBe(metaFileBytesBeforeActivation);

					// 首次漏斗通过之前，有人绕过 runtime 直接改 board.json（等同仍直接写盘的 CLI 动词或手工编辑）。
					writeFileSync(
						boardFilePath,
						JSON.stringify(
							createBoardWithBacklogCards([
								createBacklogCard("t0001", "requirement written before deploy"),
								createBacklogCard("t0002", "card added outside the runtime persistence funnel"),
							]),
							null,
							2,
						),
					);
					await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
						board: state.board,
						value: null,
						save: false,
					}));

					const workspaceEvents = (await activatedLiveCapture.ledgerClient.listCommittedEvents({})).filter(
						(event) => event.subjectWorkspaceId === workspaceId,
					);
					const baselineEvents = workspaceEvents.filter(
						(event) =>
							event.eventKind === "board_state_baseline_observed_at_live_task_mutation_capture_activation",
					);
					expect(baselineEvents).toHaveLength(1);
					expect(
						(
							baselineEvents[0]?.eventPayload.baselineTaskCards as Array<{ kanbanBoardCard: { taskId: string } }>
						).map((baselineTaskCard) => baselineTaskCard.kanbanBoardCard.taskId),
					).toEqual(["t0001"]);
					const detectedOutsideFunnel = workspaceEvents.filter(
						(event) =>
							event.eventPayload.taskMutationOccurrenceCaptureMode ===
							"detected_by_board_diff_outside_runtime_persistence_funnel",
					);
					expect(detectedOutsideFunnel.map((event) => [event.eventKind, event.subjectTaskId])).toEqual([
						["task_card_created_on_board", "t0002"],
					]);
				} finally {
					await activatedLiveCapture.deactivate();
				}
			},
		);
	});

	it("records each card's main session facets in the baseline and reserves task ids seen in local traces", async () => {
		await withIsolatedHomeContainingOneIndexedWorkspaceWrittenBeforeActivation(
			async ({ workspacePath, workspaceId }) => {
				await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: createBoardWithBacklogCards([createBacklogCard("t0001", "requirement written before deploy")]),
					sessions: {
						t0001: {
							taskId: "t0001",
							state: "interrupted",
							agentId: "claude",
							workspacePath: null,
							pid: null,
							startedAt: null,
							updatedAt: 2_000,
							lastOutputAt: null,
							reviewReason: "interrupted",
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
						} as RuntimeTaskSessionSummary,
					},
				});
				mkdirSync(join(process.env.HOME as string, ".cline", "worktrees", "d0004"), { recursive: true });

				const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
				try {
					await activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
					const events = await activatedLiveCapture.ledgerClient.listCommittedEvents({});
					const baselineTaskCards = events.find(
						(event) =>
							event.subjectWorkspaceId === workspaceId &&
							event.eventKind === "board_state_baseline_observed_at_live_task_mutation_capture_activation",
					)?.eventPayload.baselineTaskCards as Array<Record<string, unknown>>;
					expect(baselineTaskCards[0]?.mainConversationSessionLastPersistedSummaryAtBaseline).toMatchObject({
						legacyProjectedSessionState: "interrupted",
						liveness: expect.any(String),
						turnOwner: expect.any(String),
						userTurnKind: expect.any(String),
					});
					// 同一测试文件的前一个用例可能已占住 t0001；本用例只断言新出现的痕迹 id 被占住。
					const newlyReservedTaskIds = events
						.filter((event) => event.eventKind === "task_id_reservation_seeded_from_existing_artifacts")
						.flatMap((event) =>
							(event.eventPayload.newlyReservedTaskIdEntries as Array<{ taskId: string }>).map(
								(entry) => entry.taskId,
							),
						);
					expect(newlyReservedTaskIds).toContain("d0004");
					expect(newlyReservedTaskIds).toContain("t0001");
				} finally {
					await activatedLiveCapture.deactivate();
				}
			},
			"project-with-main-session-summary-before-activation",
		);
	});

	it("exports each legacy board dependency left in board.json as a retirement observation at baseline (J2)", async () => {
		await withIsolatedHomeContainingOneIndexedWorkspaceWrittenBeforeActivation(async ({ workspaceId }) => {
			const boardFilePath = join(getWorkspaceDirectoryPath(workspaceId), "board.json");
			const legacyBoardDependency = {
				id: "7a758c2a",
				fromTaskId: "t0001",
				toTaskId: "t0009",
				createdAt: 1_500,
			};
			writeFileSync(
				boardFilePath,
				JSON.stringify(
					{
						...JSON.parse(readFileSync(boardFilePath, "utf8")),
						dependencies: [legacyBoardDependency],
					},
					null,
					2,
				),
			);

			const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			try {
				await activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
				const retirementObservations = (await activatedLiveCapture.ledgerClient.listCommittedEvents({})).filter(
					(event) =>
						event.subjectWorkspaceId === workspaceId &&
						event.eventKind === "legacy_board_dependency_observed_at_retirement",
				);
				expect(retirementObservations).toHaveLength(1);
				expect(retirementObservations[0]?.idempotencyKey).toBe(
					`legacy-board-dependency-retirement:${workspaceId}:7a758c2a`,
				);
				expect(retirementObservations[0]?.eventPayload.legacyBoardDependencyAsPersistedBeforeRetirement).toEqual(
					legacyBoardDependency,
				);
			} finally {
				await activatedLiveCapture.deactivate();
			}
		}, "project-with-legacy-board-dependency-before-activation");
	});

	it("deactivating while the eager baseline is still in flight awaits it before closing the ledger worker, with no unhandled rejection", async () => {
		await withIsolatedHomeContainingOneIndexedWorkspaceWrittenBeforeActivation(async () => {
			const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			await expect(activatedLiveCapture.deactivate()).resolves.toBeUndefined();
			await expect(
				activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion,
			).resolves.toBeUndefined();
		});
	});
});
