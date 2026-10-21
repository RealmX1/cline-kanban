import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import type { WebUiUserDecisionClientCharacteristics } from "../../src/core/work-unit-relation-assertion-write-api-contract";
import { listInjectionReceiptsOfAssertedInterWorkUnitRelation } from "../../src/inter-work-unit-relation-ledger/asserted-inter-work-unit-relation-projection-from-ledger-events";
import type { KanbanRequestOriginActorEvidence } from "../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
	runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
} from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { resolveInterWorkUnitRelationNeighborhoodSessionStartInjection } from "../../src/prompts/inter-work-unit-relation-neighborhood-append-system-prompt";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { createWorkUnitRelationAssertionWriteApi } from "../../src/trpc/work-unit-relation-assertion-write-api";
import { createWorkUnitRelationReadApi } from "../../src/trpc/work-unit-relation-read-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// 两档期限约定（test/README.md）：账本 worker 冷启动、后台注入回执落账都是「终会发生」的等待，单档放宽到 15s；
// 用例超时闭合全部等待（两次 runtime 激活各自的基线 + 若干次 waitFor）。
const EVENTUALLY_HAPPENS_WAIT_TIMEOUT_MS = 15_000;
const REFERENCE_RELATION_ASSERTION_WRITE_INTEGRATION_TEST_TIMEOUT_MS = 90_000;

function createCard(taskId: string, prompt: string, createdAt: number): RuntimeBoardCard {
	return {
		id: taskId,
		title: prompt,
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

function kanbanCliEvidenceOfCardSession(input: {
	workspaceId: string;
	taskId: string;
	nativeConversationSessionId: string;
}): KanbanRequestOriginActorEvidence {
	return {
		decodedCliActorClaimsRequestHeader: {
			cliActorClaimsRequestHeaderStatus: "present",
			claims: {
				claimedEnvironmentVariableValuesByName: {
					KANBAN_TASK_ID: input.taskId,
					KANBAN_HOOK_WORKSPACE_ID: input.workspaceId,
					KANBAN_TASK_CONVERSATION_SESSION_ID: input.taskId,
					CLAUDE_CODE_SESSION_ID: input.nativeConversationSessionId,
				},
				invokingKanbanCliCodeVersion: "test",
				invokingProcessWorkingDirectory: null,
			},
		},
	};
}

const WEB_UI_USER_EVIDENCE: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
	webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
};

const TRUSTED_USER_GESTURE: WebUiUserDecisionClientCharacteristics = {
	triggeringDomEventIsTrusted: true,
	navigatorWebdriver: false,
	navigatorUserAgent: "integration-test-browser",
};

describe("reference relation assertion write through the runtime", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it(
		"asserts, merges, revokes as incorrect, suppresses the same evidence, keeps one effective relation per natural key and records injection receipts",
		async () => {
			const gitFixture = createIsolatedGitTestWorkspaceFixture();
			const previousHome = process.env.HOME;
			process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
			try {
				const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-relation-assert");
				mkdirSync(repositoryPath, { recursive: true });
				gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
				await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: boardWithBacklogCards([
						createCard("a0001", "Diagnose the resume path", 1_000),
						createCard("b0002", "Resume path rewrite", 2_000),
					]),
					sessions: {},
				});
				const { workspaceId, repoPath } = await loadWorkspaceContext(repositoryPath, {
					autoCreateIfMissing: false,
				});
				const evidenceOfCardA = kanbanCliEvidenceOfCardSession({
					workspaceId,
					taskId: "a0001",
					nativeConversationSessionId: "session-a-1",
				});
				const evidenceOfCardB = kanbanCliEvidenceOfCardSession({
					workspaceId,
					taskId: "b0002",
					nativeConversationSessionId: "session-b-1",
				});
				const cardBSelector = {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id" as const,
					bareTaskId: "b0002",
				};
				const cardASelector = {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id" as const,
					bareTaskId: "a0001",
				};

				const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
				const writeApi = createWorkUnitRelationAssertionWriteApi({
					readRecordedInterWorkUnitRelationProjection:
						readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
					runInterWorkUnitRelationLedgerClientOperation:
						runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
					getWorkspacePathById: (requestedWorkspaceId) => (requestedWorkspaceId === workspaceId ? repoPath : null),
				});
				const readApi = createWorkUnitRelationReadApi({
					readRecordedInterWorkUnitRelationProjection:
						readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
					getWorkspacePathById: (requestedWorkspaceId) => (requestedWorkspaceId === workspaceId ? repoPath : null),
					readLatestNotificationSummaryTextOfTaskCard: async () => null,
				});
				const assertConcernsFromA = (relationAssertionEvidencePointers: string[], dryRun = false) =>
					writeApi.assertReferenceRelationAsActingWorkUnit(
						{
							relationKind: "reference_concerns_behavior_or_state_of",
							counterpartWorkUnit: cardBSelector,
							relationAssertionRationaleOneSentence: "A diagnoses why B's resume path picks the wrong session.",
							relationAssertionEvidencePointers,
							assertedRelationKindSpecificAttributes: {
								concernedAspectSummary: "resume path",
								concernNature: "diagnoses_failure_of",
							},
							dryRunWithoutWritingIntoLedger: dryRun,
						},
						evidenceOfCardA,
					);
				try {
					await activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;

					// dry-run：给出路由与双视角回显，但什么都不写。
					const dryRun = await assertConcernsFromA(["notes/diagnosis.md"], true);
					expect(dryRun).toMatchObject({
						relationAssertionWriteOutcome: "dry_run_would_apply_asserted_relation",
						relationAffectingConfirmableChangeId: null,
						confirmationRoutingDecision: {
							matchedConfirmationAuthorityRowIds: ["M1"],
							effectiveConfirmationStrategy: "applied_immediately_without_user_review",
						},
					});
					expect(dryRun.relationStatementReadFromSubjectPerspective).toContain(
						'task a0001 "Diagnose the resume path"',
					);
					expect(dryRun.relationStatementReadFromAnchorPerspective).toMatch(
						/^task b0002 .* has its behavior or state concerned by task a0001/u,
					);
					expect(
						(await readApi.getRelationNeighborhoodSummary({ workUnit: cardBSelector })).assertedRelations,
					).toEqual([]);

					const applied = await assertConcernsFromA(["notes/diagnosis.md"]);
					expect(applied.relationAssertionWriteOutcome).toBe("asserted_relation_applied_and_effective");
					expect(applied.relationAffectingConfirmableChangeId).toMatch(/^relation-affecting-confirmable-change-/u);
					const relationId = applied.assertedRelation.relationId;

					// 重断言 = 合并：证据并集、版本 +1，仍是同一条关系。
					const merged = await assertConcernsFromA(["notes/diagnosis.md", "logs/resume.txt"]);
					expect(merged).toMatchObject({
						relationAssertionWriteOutcome: "reassertion_merged_into_already_effective_assertion",
						assertedRelation: {
							relationId,
							assertedRelationStateVersion: 2,
							relationAssertionEvidencePointers: ["notes/diagnosis.md", "logs/resume.txt"],
						},
					});

					// 断言方视角在「References (asserted)」，对端视角是「单方面声明·未经确认」引用块。
					const neighborhoodOfA = await readApi.getRelationNeighborhoodSummary({ workUnit: cardASelector });
					expect(neighborhoodOfA.assertedRelations.map((relation) => relation.relationId)).toEqual([relationId]);
					expect(neighborhoodOfA.renderedNeighborhoodSummaryText).toContain("## References (asserted)");
					expect(neighborhoodOfA.renderedNeighborhoodSummaryText).toContain(
						"This task concerns the behavior or state of task b0002",
					);
					const neighborhoodOfB = await readApi.getRelationNeighborhoodSummary({ workUnit: cardBSelector });
					expect(neighborhoodOfB.renderedNeighborhoodSummaryText).toContain(
						"## Declared unilaterally by another work unit",
					);
					expect(neighborhoodOfB.renderedNeighborhoodSummaryText).toContain(
						'declared by task a0001 "Diagnose the resume path"',
					);

					// 策略：偏离默认要理由；S2–S6 本 runtime 没有，明确拒绝、绝不降成 S1。
					await expect(
						writeApi.assertReferenceRelationAsActingWorkUnit(
							{
								relationKind: "reference_is_generally_related_with",
								counterpartWorkUnit: cardBSelector,
								relationAssertionRationaleOneSentence: "Both touch the resume path.",
								relationAssertionEvidencePointers: [],
								assertedRelationKindSpecificAttributes: {},
								agentSelectedConfirmationStrategy: "pending_until_explicit_user_decision_without_deadline",
								strategySelectionRationale: "The user should decide.",
								dryRunWithoutWritingIntoLedger: false,
							},
							evidenceOfCardA,
						),
					).rejects.toMatchObject({
						code: "PRECONDITION_FAILED",
						message: expect.stringContaining("confirmation_strategy_not_yet_available_in_this_runtime"),
					});
					await expect(
						writeApi.assertReferenceRelationAsActingWorkUnit(
							{
								relationKind: "reference_is_cross_repository_counterpart_with",
								counterpartWorkUnit: cardBSelector,
								relationAssertionRationaleOneSentence: "Same repository, so not a counterpart.",
								relationAssertionEvidencePointers: [],
								assertedRelationKindSpecificAttributes: {
									sharedCrossRepositoryContractPointer: "docs/contract.md",
								},
								dryRunWithoutWritingIntoLedger: false,
							},
							evidenceOfCardA,
						),
					).rejects.toMatchObject({ code: "BAD_REQUEST" });

					// 对端 agent 撤销别人的断言要 S2（限时否决），本 runtime 没有 → 拒绝，请用户在 Web UI 撤销。
					await expect(
						writeApi.revokeEffectiveRelationAssertionAsActingWorkUnit(
							{
								relationId,
								relationAssertionRevocationReason: "relation_was_incorrect",
								dryRunWithoutWritingIntoLedger: false,
							},
							evidenceOfCardB,
						),
					).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

					// 会话启动注入：B 启动时看到这条单方面声明。解析本身不落账——注入回执只在会话成功启动之后提交
					// （session-manager 装载新会话之后调用提交回调，这里直接扮演那一步），后台落账。
					const sessionStartInjectionIntoB = await resolveInterWorkUnitRelationNeighborhoodSessionStartInjection({
						workspaceId,
						taskId: "b0002",
					});
					const injectedIntoB =
						sessionStartInjectionIntoB?.interWorkUnitRelationNeighborhoodAppendSystemPromptText;
					expect(injectedIntoB).toContain("Declared unilaterally by another work unit");
					const readInjectionReceiptsOfRelation = () =>
						readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((reader) =>
							listInjectionReceiptsOfAssertedInterWorkUnitRelation(
								reader.projectionState.assertedInterWorkUnitRelationProjectionState,
								relationId,
							),
						);
					expect(await readInjectionReceiptsOfRelation()).toEqual([]);
					const commitInjectionReceiptOfB =
						sessionStartInjectionIntoB?.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded;
					expect(commitInjectionReceiptOfB).toEqual(expect.any(Function));
					commitInjectionReceiptOfB?.();
					await vi.waitFor(
						async () => {
							const receipts = await readInjectionReceiptsOfRelation();
							expect(receipts).toEqual([
								expect.objectContaining({
									injectedIntoKanbanTaskConversationSessionId: "b0002",
									injectedAssertedRelationStateVersion: 2,
								}),
							]);
						},
						{ timeout: EVENTUALLY_HAPPENS_WAIT_TIMEOUT_MS },
					);
					// 同一会话再次启动（同一版本）：幂等键已记过，账本不追加第二条。提交即同步入队，排在随后的列举之前。
					(
						await resolveInterWorkUnitRelationNeighborhoodSessionStartInjection({ workspaceId, taskId: "b0002" })
					)?.commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded?.();
					const injectionReceiptEventsOfB = (
						await runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture((ledgerClient) =>
							ledgerClient.listCommittedEvents({ subjectWorkspaceId: workspaceId, subjectTaskId: "b0002" }),
						)
					).filter(
						(event) =>
							event.eventKind ===
							"effective_inter_work_unit_relation_assertions_injected_into_conversation_session",
					);
					expect(injectionReceiptEventsOfB).toHaveLength(1);
					expect(injectionReceiptEventsOfB[0]?.eventPayload).toMatchObject({
						injectedIntoKanbanTaskConversationSession: { workspaceId, kanbanTaskConversationSessionId: "b0002" },
						assertedRelationInjectionChannel: "session_start_append_system_prompt",
						injectedAssertedRelations: [{ relationId, assertedRelationStateVersion: 2 }],
					});

					// 用户的决策只认可信手势 + 已校验 nonce。
					await expect(
						writeApi.revokeEffectiveRelationAssertionDirectlyAsWebUiUser(
							{
								relationId,
								relationAssertionRevocationReason: "relation_was_incorrect",
								webUiUserDecisionClientCharacteristics: {
									...TRUSTED_USER_GESTURE,
									triggeringDomEventIsTrusted: false,
								},
							},
							WEB_UI_USER_EVIDENCE,
						),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
					await expect(
						writeApi.revokeEffectiveRelationAssertionDirectlyAsWebUiUser(
							{
								relationId,
								relationAssertionRevocationReason: "relation_was_incorrect",
								webUiUserDecisionClientCharacteristics: TRUSTED_USER_GESTURE,
							},
							evidenceOfCardA,
						),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
					const revoked = await writeApi.revokeEffectiveRelationAssertionDirectlyAsWebUiUser(
						{
							relationId,
							relationAssertionRevocationReason: "relation_was_incorrect",
							webUiUserDecisionClientCharacteristics: TRUSTED_USER_GESTURE,
						},
						WEB_UI_USER_EVIDENCE,
					);
					expect(revoked).toMatchObject({
						relationAssertionWriteOutcome: "effective_relation_assertion_revoked",
						userRejectionSuppressionTombstoneRecorded: true,
						assertedRelation: { assertionEffectivenessState: "revoked", assertedRelationStateVersion: 3 },
					});
					expect(
						await writeApi.revokeEffectiveRelationAssertionDirectlyAsWebUiUser(
							{
								relationId,
								relationAssertionRevocationReason: "relation_was_incorrect",
								webUiUserDecisionClientCharacteristics: TRUSTED_USER_GESTURE,
							},
							WEB_UI_USER_EVIDENCE,
						),
					).toMatchObject({ relationAssertionWriteOutcome: "relation_assertion_was_already_revoked" });
					expect(
						(await readApi.getRelationNeighborhoodSummary({ workUnit: cardBSelector })).assertedRelations,
					).toEqual([]);

					// 被用户判为有误后：同证据（子集）重断言被墓碑抑制；带新证据放行，成为新的一条。
					await expect(assertConcernsFromA(["logs/resume.txt"])).rejects.toMatchObject({
						code: "PRECONDITION_FAILED",
						message: expect.stringContaining("relation_assertion_suppressed_by_user_rejection_tombstone"),
					});
					const reassertedWithNewEvidence = await assertConcernsFromA(["logs/resume-second-run.txt"]);
					expect(reassertedWithNewEvidence.relationAssertionWriteOutcome).toBe(
						"asserted_relation_applied_and_effective",
					);
					expect(reassertedWithNewEvidence.assertedRelation.relationId).not.toBe(relationId);

					// Web UI 用户的直接断言永远不受墓碑抑制，决策来源记为用户断言；它生效后 agent 不能自行撤销。
					const userAsserted = await writeApi.assertReferenceRelationDirectlyAsWebUiUser(
						{
							subjectWorkUnit: cardBSelector,
							relationKind: "reference_reuses_produced_outputs_of",
							counterpartWorkUnit: cardASelector,
							relationAssertionRationaleOneSentence: "B builds on A's diagnosis notes.",
							relationAssertionEvidencePointers: [],
							assertedRelationKindSpecificAttributes: { reusedOutputSummary: "diagnosis notes" },
							webUiUserDecisionClientCharacteristics: TRUSTED_USER_GESTURE,
						},
						WEB_UI_USER_EVIDENCE,
					);
					expect(userAsserted.assertedRelation).toMatchObject({
						relationAsserterActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce",
						relationAsserterWorkUnitRef: null,
						effectiveConfirmableChangeDecisionSource:
							"asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
					});
					await expect(
						writeApi.revokeEffectiveRelationAssertionAsActingWorkUnit(
							{
								relationId: userAsserted.assertedRelation.relationId,
								relationAssertionRevocationReason: "relation_ended_naturally",
								dryRunWithoutWritingIntoLedger: false,
							},
							evidenceOfCardB,
						),
					).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

					// agent 以「有误」撤销自己的断言：只抑制同一个原生会话；换了会话（新的策略身份）可以再提。
					const verifiesRelation = await writeApi.assertReferenceRelationAsActingWorkUnit(
						{
							relationKind: "reference_verifies_claims_of",
							counterpartWorkUnit: cardBSelector,
							relationAssertionRationaleOneSentence: "A re-checks B's root cause claim.",
							relationAssertionEvidencePointers: [],
							assertedRelationKindSpecificAttributes: {
								claimsUnderVerification: [{ claimSummary: "root cause is X", verificationVerdict: "pending" }],
							},
							dryRunWithoutWritingIntoLedger: false,
						},
						evidenceOfCardA,
					);
					expect(
						await writeApi.revokeEffectiveRelationAssertionAsActingWorkUnit(
							{
								relationId: verifiesRelation.assertedRelation.relationId,
								relationAssertionRevocationReason: "relation_was_incorrect",
								dryRunWithoutWritingIntoLedger: false,
							},
							evidenceOfCardA,
						),
					).toMatchObject({
						relationAssertionWriteOutcome: "effective_relation_assertion_revoked",
						userRejectionSuppressionTombstoneRecorded: true,
					});
					const reassertVerifies = (evidence: KanbanRequestOriginActorEvidence) =>
						writeApi.assertReferenceRelationAsActingWorkUnit(
							{
								relationKind: "reference_verifies_claims_of",
								counterpartWorkUnit: cardBSelector,
								relationAssertionRationaleOneSentence: "A re-checks B's root cause claim again.",
								relationAssertionEvidencePointers: [],
								assertedRelationKindSpecificAttributes: {
									claimsUnderVerification: [
										{ claimSummary: "root cause is X", verificationVerdict: "pending" },
									],
								},
								dryRunWithoutWritingIntoLedger: false,
							},
							evidence,
						);
					await expect(reassertVerifies(evidenceOfCardA)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
					expect(
						(
							await reassertVerifies(
								kanbanCliEvidenceOfCardSession({
									workspaceId,
									taskId: "a0001",
									nativeConversationSessionId: "session-a-2",
								}),
							)
						).relationAssertionWriteOutcome,
					).toBe("asserted_relation_applied_and_effective");

					// 并发的同自然键断言：CAS 保证只生效一条，另一条合并进去。
					const concurrentOutcomes = await Promise.all(
						[0, 1].map(() =>
							writeApi.assertReferenceRelationAsActingWorkUnit(
								{
									relationKind: "reference_requirement_originates_from",
									counterpartWorkUnit: cardBSelector,
									relationAssertionRationaleOneSentence: "A's requirement came out of B's review.",
									relationAssertionEvidencePointers: [],
									assertedRelationKindSpecificAttributes: {},
									dryRunWithoutWritingIntoLedger: false,
								},
								evidenceOfCardA,
							),
						),
					);
					expect(concurrentOutcomes.map((outcome) => outcome.relationAssertionWriteOutcome).sort()).toEqual([
						"asserted_relation_applied_and_effective",
						"reassertion_merged_into_already_effective_assertion",
					]);
					expect(new Set(concurrentOutcomes.map((outcome) => outcome.assertedRelation.relationId)).size).toBe(1);

					// 用户建模是替代而非合并：整批 CAS、相同提交可重试、旧证据可删除。
					const selectedForRevision = concurrentOutcomes[0].assertedRelation;
					const revisionRequest = {
						workUnit: cardASelector,
						modelingSubmissionId: "user-revision-test",
						referenceRelationDrafts: [
							{
								draftId: "revision",
								replacesRelationId: selectedForRevision.relationId,
								expectedAssertedRelationStateVersion: 2,
								counterpartWorkUnit: selectedForRevision.relationStatementAnchorWorkUnitRef,
								relationKind: "reference_requirement_originates_from" as const,
								currentTaskIsStatementSubject: true,
								relationAssertionRationaleOneSentence: "用户核对后的需求来源",
								relationAssertionEvidencePointers: ["new-evidence.md"],
								assertedRelationKindSpecificAttributes: {},
							},
						],
						relationRevocations: [],
						webUiUserDecisionClientCharacteristics: TRUSTED_USER_GESTURE,
					};
					await expect(
						writeApi.applyReferenceRelationModelingChangesDirectlyAsWebUiUser(
							revisionRequest,
							WEB_UI_USER_EVIDENCE,
						),
					).resolves.toMatchObject({ alreadyApplied: false });
					await expect(
						writeApi.applyReferenceRelationModelingChangesDirectlyAsWebUiUser(
							revisionRequest,
							WEB_UI_USER_EVIDENCE,
						),
					).resolves.toMatchObject({ alreadyApplied: true });
					const revised = (
						await readApi.getRelationNeighborhoodSummary({ workUnit: cardASelector })
					).assertedRelations.find((entry) => entry.relationKind === "reference_requirement_originates_from");
					expect(revised?.relationAssertionEvidencePointers).toEqual(["new-evidence.md"]);
					expect(revised?.relationId).not.toBe(selectedForRevision.relationId);
					await expect(
						writeApi.applyReferenceRelationModelingChangesDirectlyAsWebUiUser(
							{
								...revisionRequest,
								modelingSubmissionId: "stale-revision",
								referenceRelationDrafts: [
									...revisionRequest.referenceRelationDrafts,
									{
										...revisionRequest.referenceRelationDrafts[0],
										draftId: "other-new",
										replacesRelationId: null,
										expectedAssertedRelationStateVersion: null,
										relationKind: "reference_is_cross_repository_counterpart_with" as const,
									},
								],
							},
							WEB_UI_USER_EVIDENCE,
						),
					).rejects.toMatchObject({ code: "CONFLICT" });
					await expect(
						writeApi.applyReferenceRelationModelingChangesDirectlyAsWebUiUser(
							{
								...revisionRequest,
								webUiUserDecisionClientCharacteristics: {
									...TRUSTED_USER_GESTURE,
									triggeringDomEventIsTrusted: false,
								},
							},
							WEB_UI_USER_EVIDENCE,
						),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
					const preview = await readApi.getRelationModelingPreview({
						workUnit: cardASelector,
						draftTaskTitle: "",
						relationNeighborhoodDepth: 3,
						referenceRelationDrafts: [],
						relationRevocations: [],
					});
					expect(preview.relations.some((entry) => entry.relationId === revised?.relationId)).toBe(true);
					expect(
						await readApi.suggestReferenceRelationsForTaskModeling({
							workUnit: cardASelector,
							draftTaskTitle: "",
							relationNeighborhoodDepth: 2,
							referenceRelationDrafts: [],
							relationRevocations: [],
						}),
					).toMatchObject({ availability: "unavailable", candidates: [] });
					if (!revised) throw new Error("缺少修改后的关系");
					const competingEdits = await Promise.allSettled(
						["first-editor", "second-editor"].map((submissionId) =>
							writeApi.applyReferenceRelationModelingChangesDirectlyAsWebUiUser(
								{
									...revisionRequest,
									modelingSubmissionId: submissionId,
									referenceRelationDrafts: [
										{
											...revisionRequest.referenceRelationDrafts[0],
											replacesRelationId: revised.relationId,
											expectedAssertedRelationStateVersion: revised.assertedRelationStateVersion,
											relationAssertionRationaleOneSentence: submissionId,
										},
									],
								},
								WEB_UI_USER_EVIDENCE,
							),
						),
					);
					expect(competingEdits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
					expect(competingEdits.filter((result) => result.status === "rejected")).toHaveLength(1);

					// 写侧当前态表只是缓存：与从族 4 事件推出的投影逐条一致（全量重建 = 增量维护）。
					const currentStateRows =
						await runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture(
							async (ledgerClient) => await ledgerClient.listInterWorkUnitAssertedRelationCurrentStateRows(),
						);
					const projectedRelations =
						await readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((reader) => [
							...reader.projectionState.assertedInterWorkUnitRelationProjectionState.assertedRelationsByRelationId.values(),
						]);
					expect(
						currentStateRows.map((row) => [
							row.relationId,
							row.relationAssertionNaturalKey,
							row.assertionEffectivenessState,
							row.assertedRelationStateVersion,
						]),
					).toEqual(
						projectedRelations
							.map((relation) => [
								relation.relationId,
								relation.relationAssertionNaturalKey,
								relation.assertionEffectivenessState,
								relation.assertedRelationStateVersion,
							])
							.sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
					);
				} finally {
					await activatedLiveCapture.deactivate();
				}
				await expect(assertConcernsFromA(["notes/after-shutdown.md"])).rejects.toMatchObject({
					code: "SERVICE_UNAVAILABLE",
				});
			} finally {
				registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				gitFixture.cleanup();
			}
		},
		REFERENCE_RELATION_ASSERTION_WRITE_INTEGRATION_TEST_TIMEOUT_MS,
	);
});
