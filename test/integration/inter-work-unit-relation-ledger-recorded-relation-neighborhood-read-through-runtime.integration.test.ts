import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	appendCommittedEventsIntoLedgerOfActiveKanbanRuntimeLiveCaptureAndWaitForCommit,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
} from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { resolveInterWorkUnitRelationNeighborhoodSessionStartInjection } from "../../src/prompts/inter-work-unit-relation-neighborhood-append-system-prompt";
import {
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	type TaskMutationIntentWithResolvedActor,
} from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceContext, mutateWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { createWorkUnitRelationPresentationPreferenceApi } from "../../src/trpc/work-unit-relation-presentation-preference-api";
import { createWorkUnitRelationReadApi } from "../../src/trpc/work-unit-relation-read-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

const PARENT_CARD_CREATED_AT = 1_000;

function createCard(taskId: string, prompt: string, createdAt: number): RuntimeBoardCard {
	return {
		id: taskId,
		title: prompt.split("\n")[0] ?? prompt,
		prompt,
		startInPlanMode: false,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function boardWithBacklogCards(backlogCards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: backlogCards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function intentActedByParentCard(workspaceId: string): TaskMutationIntentWithResolvedActor {
	return {
		taskMutationIntentKind: "kanban_cli_task_create",
		resolvedKanbanActor: {
			kanbanActorKind: "kanban_board_card_work_unit",
			actingKanbanBoardCardWorkUnit: {
				workUnitType: "kanban_board_card",
				workspaceId,
				taskId: "p0001",
				taskIncarnationCreatedAtEpochMs: PARENT_CARD_CREATED_AT,
			},
		},
	};
}

describe("recorded inter-work-unit relation neighborhood read through the runtime", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it("projects live captured relations, resolves bare ids across projects, renders the L1 recap and fails closed after deactivation", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		try {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-relation-read");
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: boardWithBacklogCards([
					createCard("p0001", "Coordinate the rollout\n\nSecond paragraph is not part of the recap.", 1_000),
				]),
				sessions: {},
			});
			const { workspaceId, repoPath } = await loadWorkspaceContext(repositoryPath, { autoCreateIfMissing: false });

			const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			const workUnitRelationReadApi = createWorkUnitRelationReadApi({
				readRecordedInterWorkUnitRelationProjection:
					readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
				getWorkspacePathById: (requestedWorkspaceId) => (requestedWorkspaceId === workspaceId ? repoPath : null),
				readLatestNotificationSummaryTextOfTaskCard: async (_workspaceId, taskId) =>
					taskId === "c0001" ? { summaryText: "Child is waiting for review.", triggeredAt: 5_000 } : null,
			});
			try {
				await activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
				await mutateWorkspaceState(repositoryPath, intentActedByParentCard(workspaceId), (state) => ({
					board: boardWithBacklogCards([
						createCard("c0001", "Implement the child slice", 2_000),
						...(state.board.columns[0]?.cards ?? []),
					]),
					value: null,
				}));

				const childNeighborhood = await workUnitRelationReadApi.getRelationNeighborhoodSummary({
					workUnit: { workUnitSelectorKind: "kanban_board_card_by_bare_task_id", bareTaskId: "c0001" },
				});
				expect(childNeighborhood.recordedRelations.map((relation) => relation.relationKind)).toEqual([
					"provenance_created_by",
				]);
				expect(childNeighborhood.recordedRelations[0]?.isCreationTimePrimaryProvenanceOfSubjectCard).toBe(true);
				expect(childNeighborhood.renderedNeighborhoodSummaryText).toContain(
					`This task was created by task p0001 "Coordinate the rollout" [${workspaceId}]`,
				);
				expect(childNeighborhood.hasAnyRelationVisibleByDefault).toBe(true);
				const qualifiedPreview = await workUnitRelationReadApi.getRelationModelingPreview({
					workUnit: {
						workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
						kanbanBoardCard: {
							workUnitType: "kanban_board_card",
							workspaceId,
							taskId: "c0001",
							taskIncarnationCreatedAtEpochMs: 2_000,
						},
					},
					draftTaskTitle: "子任务",
					relationNeighborhoodDepth: 2,
					referenceRelationDrafts: [],
					relationRevocations: [],
				});
				expect(qualifiedPreview.rootWorkUnitKey).toBe(`kanban_board_card:${workspaceId}:c0001:2000`);
				expect(qualifiedPreview.workUnits).toHaveLength(2);
				await expect(
					workUnitRelationReadApi.getRelationModelingPreview({
						workUnit: {
							workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
							kanbanBoardCard: {
								workUnitType: "kanban_board_card",
								workspaceId,
								taskId: "c0001",
								taskIncarnationCreatedAtEpochMs: 2_001,
							},
						},
						draftTaskTitle: "不存在的一世",
						relationNeighborhoodDepth: 2,
						referenceRelationDrafts: [],
						relationRevocations: [],
					}),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
				const relatedPreview = await workUnitRelationReadApi.getDirectlyRelatedTaskPreviewPage({
					task: {
						workUnitType: "kanban_board_card",
						workspaceId,
						taskId: "c0001",
						taskIncarnationCreatedAtEpochMs: 2_000,
					},
				});
				expect(relatedPreview.totalTaskCount).toBe(1);
				expect(relatedPreview.entries[0]).toMatchObject({
					task: { workspaceId, taskId: "p0001", taskIncarnationCreatedAtEpochMs: PARENT_CARD_CREATED_AT },
					title: "Coordinate the rollout",
					relations: [
						{
							relationClass: "recorded",
							relationKind: "provenance_created_by",
							directionFromPreviewSubject: "outgoing",
						},
					],
				});

				// 读之后的新事件在下一次读时增量追上。
				await mutateWorkspaceState(repositoryPath, intentActedByParentCard(workspaceId), (state) => ({
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards: column.cards.map((card) =>
								card.id === "c0001" ? { ...card, prompt: "Implement the child slice, now with tests" } : card,
							),
						})),
					},
					value: null,
				}));
				const parentNeighborhood = await workUnitRelationReadApi.getRelationNeighborhoodSummary({
					workUnit: {
						workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
						bareTaskId: "p0001",
						workspaceId,
					},
				});
				expect(
					parentNeighborhood.recordedRelations.map((relation) => [
						relation.relationKind,
						relation.recordedRelationKindSpecificAttributes,
					]),
				).toEqual([
					["provenance_created_by", {}],
					["interaction_requirements_amended_by", { amendedCardFieldNames: ["prompt"] }],
				]);
				expect(parentNeighborhood.renderedNeighborhoodSummaryText).toContain(
					"This task amended the requirements of task c0001",
				);

				const identity = await workUnitRelationReadApi.resolveKanbanBoardCardIdentityByBareTaskId({
					bareTaskId: "p0001",
				});
				expect(
					identity.kanbanBoardCardIdentityCandidates.map((candidate) => [
						candidate.workspaceRepositoryPath,
						candidate.currentTitle,
						candidate.promptFirstParagraph,
						candidate.kanbanBoardCardFirstObservationRoute,
					]),
				).toEqual([
					[
						repoPath,
						"Coordinate the rollout",
						"Coordinate the rollout",
						"board_state_baseline_at_live_capture_activation",
					],
				]);

				const globalRecap = await workUnitRelationReadApi.getWorkUnitContext({
					workUnit: { workUnitSelectorKind: "kanban_board_card_by_bare_task_id", bareTaskId: "c0001" },
					workUnitContextLevel: "global_recap",
				});
				expect(globalRecap.workUnitContextProviderAvailability).toBe("available");
				expect(globalRecap.globalRecapText).toContain("Implement the child slice, now with tests");
				expect(globalRecap.globalRecapText).toContain("Child is waiting for review.");
				expect(globalRecap.workUnitContextCompleteness.missingContextParts).toEqual([
					"claude_away_summary_not_read_by_level_one_fallback",
				]);

				await expect(
					workUnitRelationReadApi.getRelationNeighborhoodSummary({
						workUnit: { workUnitSelectorKind: "kanban_board_card_by_bare_task_id", bareTaskId: "zzzzz" },
					}),
				).rejects.toMatchObject({ code: "NOT_FOUND" });

				// 会话启动注入：有默认可见关系的卡注入邻域摘要；认不出的会话 id（by-the-way 会话）不注入。
				const childSessionStartInjection = (
					await resolveInterWorkUnitRelationNeighborhoodSessionStartInjection({
						workspaceId,
						taskId: "c0001",
					})
				)?.interWorkUnitRelationNeighborhoodAppendSystemPromptText;
				expect(childSessionStartInjection).toContain("# Kanban Relations Of This Task");
				expect(childSessionStartInjection).toContain("This task was created by task p0001");
				expect(
					await resolveInterWorkUnitRelationNeighborhoodSessionStartInjection({
						workspaceId,
						taskId: "by-the-way-session-of-c0001",
					}),
				).toBeNull();

				// 静音：只认带已校验页面 nonce 的 Web UI 请求；落账后下一次读即可见，重复静音不重复记事件。
				const presentationPreferenceApi = createWorkUnitRelationPresentationPreferenceApi({
					readRecordedInterWorkUnitRelationProjection:
						readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
					appendCommittedEventsIntoLedgerAndWaitForCommit:
						appendCommittedEventsIntoLedgerOfActiveKanbanRuntimeLiveCaptureAndWaitForCommit,
				});
				const createdByRelationId = childNeighborhood.recordedRelations[0]?.relationId ?? "";
				const muteRequest = { relationId: createdByRelationId, recordedRelationMutedInPresentation: true };
				const cliOriginEvidence = {
					decodedCliActorClaimsRequestHeader:
						decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
				};
				await expect(
					presentationPreferenceApi.setRecordedRelationPresentationMutePreference(muteRequest, cliOriginEvidence),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const webUiOriginEvidence = {
					...cliOriginEvidence,
					webUiPageLoadRequestOriginNonceVerificationStatus: "verified" as const,
				};
				expect(
					await presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
						muteRequest,
						webUiOriginEvidence,
					),
				).toMatchObject({ relationPresentationPreferenceEventRecorded: true });
				expect(
					await presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
						muteRequest,
						webUiOriginEvidence,
					),
				).toMatchObject({ relationPresentationPreferenceEventRecorded: false });
				const childNeighborhoodAfterMute = await workUnitRelationReadApi.getRelationNeighborhoodSummary({
					workUnit: { workUnitSelectorKind: "kanban_board_card_by_bare_task_id", bareTaskId: "c0001" },
				});
				expect(childNeighborhoodAfterMute.recordedRelations[0]?.mutedInPresentationAt).not.toBeNull();
				// 只隐藏被静音的那条：「需求被 p0001 修订」仍默认可见，所以照常注入，只是不再说「由 p0001 创建」。
				const childSessionStartInjectionAfterMute = (
					await resolveInterWorkUnitRelationNeighborhoodSessionStartInjection({
						workspaceId,
						taskId: "c0001",
					})
				)?.interWorkUnitRelationNeighborhoodAppendSystemPromptText;
				expect(childSessionStartInjectionAfterMute).not.toContain("was created by");
				expect(childSessionStartInjectionAfterMute).toContain(
					"This task had its requirements amended by task p0001",
				);
				expect(childSessionStartInjectionAfterMute).toContain("1 relation(s) muted by the user are not listed");
			} finally {
				await activatedLiveCapture.deactivate();
			}
			// 停用之后绝不返回空邻域冒充「没有关系」。
			const readAfterDeactivation = workUnitRelationReadApi.getRelationNeighborhoodSummary({
				workUnit: { workUnitSelectorKind: "kanban_board_card_by_bare_task_id", bareTaskId: "c0001" },
			});
			await expect(readAfterDeactivation).rejects.toBeInstanceOf(TRPCError);
			await expect(readAfterDeactivation).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
	});
});
