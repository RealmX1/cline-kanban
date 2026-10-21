import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type {
	AssertedInterWorkUnitReferenceRelationKind,
	AssertedInterWorkUnitRelation,
	AssertedReferenceRelationKindSpecificAttributes,
} from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import {
	isUserExplicitConsentDecisionSource,
	RELATION_ASSERTION_NATURAL_KEY_DERIVATION_VERSION,
	RELATION_ASSERTION_SUPPRESSED_BY_USER_REJECTION_TOMBSTONE_ERROR_CODE,
	type RelationAffectingConfirmableChangeConfirmationStrategy,
	type RelationAffectingConfirmableChangeDecisionSource,
	type RelationAssertionRevocationReason,
	type UserRejectionSuppressionTombstone,
} from "../core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import type {
	CommittedInterWorkUnitRelationLedgerEvent,
	InterWorkUnitRelationLedgerEventDraft,
	InterWorkUnitRelationWorkUnitReference,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import type { IncomingWorkItemRelationCandidate } from "../core/task-indexing-support-contract";
import type {
	AssertReferenceRelationAsActingWorkUnitRequest,
	AssertReferenceRelationDirectlyAsWebUiUserRequest,
	InterWorkUnitRelationAssertionWriteResponse,
	RevokeEffectiveRelationAssertionAsActingWorkUnitRequest,
	RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest,
	WebUiUserDecisionClientCharacteristics,
} from "../core/work-unit-relation-assertion-write-api-contract";
import type { WorkUnitSelectorForRelationRead } from "../core/work-unit-relation-read-api-contract";
import {
	applyInterWorkUnitRelationAssertionLifecycleEvent,
	createEmptyAssertedInterWorkUnitRelationProjectionState,
	findAssertedInterWorkUnitRelationByRelationId,
	findEffectiveAssertedInterWorkUnitRelationByNaturalKey,
} from "../inter-work-unit-relation-ledger/asserted-inter-work-unit-relation-projection-from-ledger-events";
import { findCurrentlyOwningWorkUnitOfConversationSessionIdentity } from "../inter-work-unit-relation-ledger/conversation-session-ownership-period-projection-from-ledger-events";
import {
	buildInterWorkUnitRelationAssertionLifecycleEventDraft,
	buildRelationAssertionNaturalKey,
	buildRelationProposerPolicyIdentityKey,
	findUserRejectionSuppressionTombstoneSuppressingAssertion,
	hashRelationAssertionEvidenceAnchorSet,
	type InterWorkUnitRelationAssertionProposer,
	normalizeRelationAssertionEvidenceAnchors,
	readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection,
	renderRelationStatementFromBothEndpointPerspectives,
	validateAndCompleteAssertedReferenceRelationKindSpecificAttributes,
	validateAssertedReferenceRelationEndpoints,
} from "../inter-work-unit-relation-ledger/inter-work-unit-relation-assertion-write-planning";
import {
	type InterWorkUnitRelationLedgerDatabaseWorkerClient,
	InterWorkUnitRelationLedgerUnavailableError,
} from "../inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import {
	type KanbanActorResolutionLookups,
	type KanbanRequestOriginActorEvidence,
	resolveKanbanActorFromRequestOriginEvidence,
} from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { createKanbanActorResolutionLookupsBackedByWorkspaceStateFiles } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { buildInterWorkUnitRelationWorkUnitKey } from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import type { RecordedInterWorkUnitRelationProjectionReader } from "../inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
import {
	buildRoutingDecisionForChangeAssertedDirectlyByWebUiUser,
	classifyReferenceRelationAssertionIntoConfirmationMatrixRows,
	classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows,
	type RelationAffectingConfirmableChangeRoutingDecisionRecordedInLedger,
	routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows,
} from "../inter-work-unit-relation-ledger/relation-affecting-confirmable-change-confirmation-matrix-routing";
import { buildTaskIndexingSupportUnverifiedReferenceRoutingDecision } from "../inter-work-unit-relation-ledger/task-indexing-support-unverified-reference-confirmation-policy";
import {
	buildWorkUnitDisplayEntries,
	type WorkspaceRepositoryPathLookupByWorkspaceId,
} from "../inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-assembly";
import { readWorkspaceBoardByIdAndRunWithBoardLockHeld } from "../state/workspace-state";
import { taskIndexingMaterialRequirementsFingerprint } from "../task-indexing-support/incoming-work-item-relation-analysis";
import type { RuntimeTrpcContext } from "./app-router";
import { applyReferenceRelationModelingChanges } from "./work-unit-relation-modeling-write-api";
import { resolveWorkUnitSelectorAgainstRecordedRelationProjection } from "./work-unit-relation-read-api";

// dd2db 2.1 断言型关系写入面（`workUnit.*` 的断言与撤销）。每次写入：读投影做规划 → 账本守卫读 → 带守卫值 CAS 提交族 4 事件
// → 重读投影返回。守卫状态在读与提交之间被别的写入改了就重来；关系库只由 runtime 写（Y-EVENT-1），多实例共库靠 CAS 串行。

// 守卫读与提交之间被并发写入改掉的重试上限；用完仍冲突就如实报 CONFLICT，让调用方重试。
const MAXIMUM_COMPARE_AND_SET_ATTEMPTS_PER_RELATION_ASSERTION_WRITE = 4;

export type InterWorkUnitRelationLedgerClientCapabilitiesUsedByRelationAssertionWrites = Pick<
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	| "readInterWorkUnitRelationAssertionWriteGuardState"
	| "commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet"
> &
	Partial<
		Pick<
			InterWorkUnitRelationLedgerDatabaseWorkerClient,
			"commitReferenceRelationModelingChanges" | "readReferenceRelationModelingSubmissionFingerprint"
		>
	>;

export interface CreateWorkUnitRelationAssertionWriteApiDependencies {
	readRecordedInterWorkUnitRelationProjection: <T>(
		read: (reader: RecordedInterWorkUnitRelationProjectionReader) => Promise<T> | T,
	) => Promise<T>;
	runInterWorkUnitRelationLedgerClientOperation: <T>(
		operation: (
			ledgerClient: InterWorkUnitRelationLedgerClientCapabilitiesUsedByRelationAssertionWrites,
			capturingKanbanRuntimeInstance: Parameters<
				typeof buildInterWorkUnitRelationAssertionLifecycleEventDraft
			>[0]["capturingKanbanRuntimeInstance"],
		) => Promise<T>,
	) => Promise<T>;
	getWorkspacePathById: WorkspaceRepositoryPathLookupByWorkspaceId;
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
}

function throwRelationAssertionWriteError(
	code: TRPCError["code"],
	relationAssertionWriteErrorCode: string,
	message: string,
): never {
	throw new TRPCError({ code, message: `${relationAssertionWriteErrorCode}: ${message}` });
}

async function translateLedgerUnavailability<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof InterWorkUnitRelationLedgerUnavailableError) {
			throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error.message });
		}
		throw error;
	}
}

// 决策类 procedure 的来源校验（R3 b 项）：必须带已校验的页面 nonce、不能带 CLI 声明头（CLI 请求永远不记为用户决策），
// 触发它的 DOM 事件必须是可信的用户事件（脚本合成的 click 拒绝）。客户端特征原样记进事件，供事后甄别浏览器自动化。
function assertWebUiUserDecisionRequestOrigin(
	evidence: KanbanRequestOriginActorEvidence,
	clientCharacteristics: WebUiUserDecisionClientCharacteristics,
): void {
	if (
		evidence.webUiPageLoadRequestOriginNonceVerificationStatus !== "verified" ||
		evidence.decodedCliActorClaimsRequestHeader.cliActorClaimsRequestHeaderStatus !== "absent"
	) {
		throwRelationAssertionWriteError(
			"FORBIDDEN",
			"web_ui_user_decision_requires_verified_page_load_nonce_without_cli_actor_header",
			"Asserting or revoking a relation as the user is a Web UI decision; the request needs a verified Web UI page-load nonce and must not come from the Kanban CLI.",
		);
	}
	if (!clientCharacteristics.triggeringDomEventIsTrusted) {
		throwRelationAssertionWriteError(
			"FORBIDDEN",
			"web_ui_user_decision_requires_trusted_user_dom_event",
			"This decision was triggered by a synthetic (untrusted) DOM event; only a real user gesture can assert or revoke a relation as the user.",
		);
	}
}

// 带人话解释每一种「不是工作单元」的行动者为什么不能断言关系、该怎么办。
async function resolveActingWorkUnitProposerOfKanbanCliRequest(
	evidence: KanbanRequestOriginActorEvidence,
	lookups: KanbanActorResolutionLookups,
): Promise<Extract<InterWorkUnitRelationAssertionProposer, { proposerKind: "acting_work_unit_via_kanban_cli" }>> {
	if (evidence.decodedCliActorClaimsRequestHeader.cliActorClaimsRequestHeaderStatus === "absent") {
		throwRelationAssertionWriteError(
			"FORBIDDEN",
			"acting_work_unit_relation_write_requires_kanban_cli_actor_header",
			"This procedure is for agents calling through the Kanban CLI (the subject is the calling work unit); the Web UI uses the *DirectlyAsWebUiUser procedures.",
		);
	}
	const resolved = await resolveKanbanActorFromRequestOriginEvidence(evidence, lookups);
	const actor = resolved.resolvedKanbanActor;
	switch (actor.kanbanActorKind) {
		case "kanban_board_card_work_unit":
			return {
				proposerKind: "acting_work_unit_via_kanban_cli",
				actingWorkUnit: actor.actingKanbanBoardCardWorkUnit,
				resolvedActorWithEventEnvelopeContext: resolved,
			};
		case "kanban_unmanaged_standalone_agent_conversation_session_work_unit":
			return {
				proposerKind: "acting_work_unit_via_kanban_cli",
				actingWorkUnit: actor.actingStandaloneAgentConversationSession,
				resolvedActorWithEventEnvelopeContext: resolved,
			};
		case "kanban_home_sidebar_agent_session_not_a_work_unit":
			return throwRelationAssertionWriteError(
				"FORBIDDEN",
				"kanban_home_sidebar_agent_session_is_not_a_work_unit",
				"The Kanban sidebar agent session is not a work unit, so it cannot be one end of a relation; ask the user to add the relation in the Relations panel.",
			);
		case "kanban_cli_invocation_without_task_or_session_environment":
			return throwRelationAssertionWriteError(
				"BAD_REQUEST",
				"relation_subject_work_unit_not_resolvable_from_invoking_environment",
				`The subject of a relation is the calling work unit, but this CLI process carries neither a Kanban task nor a recognizable agent session (missing: ${actor.missingEnvironmentVariableNames.join(", ")}). Run it from inside a Kanban task session or an agent session.`,
			);
		case "unresolved_actor":
			return throwRelationAssertionWriteError(
				"BAD_REQUEST",
				"relation_subject_work_unit_not_resolvable_from_invoking_environment",
				`Kanban could not resolve which work unit is calling (${actor.unresolvedActorReason}).`,
			);
		default:
			return throwRelationAssertionWriteError(
				"FORBIDDEN",
				"acting_work_unit_relation_write_requires_kanban_cli_actor_header",
				"Only a Kanban task card or a standalone agent session calling through the Kanban CLI can assert relations through this procedure.",
			);
	}
}

// 写入点名一个原生会话时，按此刻的会话归属解析：已被某张卡采纳的存成那张卡（d-vocab §2.1）。
function resolveWorkUnitByCurrentConversationSessionOwnership(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	workUnit: InterWorkUnitRelationWorkUnitReference,
): InterWorkUnitRelationWorkUnitReference {
	if (workUnit.workUnitType !== "kanban_unmanaged_standalone_agent_conversation_session") {
		return workUnit;
	}
	const owningWorkUnit = findCurrentlyOwningWorkUnitOfConversationSessionIdentity(
		reader.projectionState.conversationSessionOwnershipProjectionState,
		workUnit,
	);
	return owningWorkUnit?.workUnitType === "kanban_board_card" ? owningWorkUnit : workUnit;
}

function resolveRelationEndpointFromSelector(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	selector: WorkUnitSelectorForRelationRead,
	endpointRoleForMessages: string,
): InterWorkUnitRelationWorkUnitReference {
	const endpoint = resolveWorkUnitByCurrentConversationSessionOwnership(
		reader,
		resolveWorkUnitSelectorAgainstRecordedRelationProjection(reader.projectionState, selector),
	);
	assertKanbanBoardCardEndpointNotPermanentlyRemoved(reader, endpoint, endpointRoleForMessages);
	return endpoint;
}

// 生效前重校验（d-confirm §4.4 第 2 条）：端点存在且不是墓碑。trash 列里的卡照常可以作端点。
function assertKanbanBoardCardEndpointNotPermanentlyRemoved(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	endpoint: InterWorkUnitRelationWorkUnitReference,
	endpointRoleForMessages: string,
): void {
	if (endpoint.workUnitType !== "kanban_board_card") {
		return;
	}
	const identity =
		reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.get(
			buildInterWorkUnitRelationWorkUnitKey(endpoint),
		);
	if (!identity) {
		throwRelationAssertionWriteError(
			"NOT_FOUND",
			"relation_endpoint_not_known_to_inter_work_unit_relation_ledger",
			`The ${endpointRoleForMessages} task ${endpoint.taskId} is not known to the relation ledger yet.`,
		);
	}
	if (identity.permanentlyRemovedFromBoardAt !== null) {
		throwRelationAssertionWriteError(
			"PRECONDITION_FAILED",
			"relation_endpoint_task_card_permanently_removed",
			`The ${endpointRoleForMessages} task ${endpoint.taskId} was permanently removed from its board; relations cannot be asserted on a removed card.`,
		);
	}
}

function proposerWorkUnitOrNull(
	proposer: InterWorkUnitRelationAssertionProposer,
	mappedActingWorkUnit: InterWorkUnitRelationWorkUnitReference | null,
): InterWorkUnitRelationWorkUnitReference | null {
	return proposer.proposerKind === "acting_work_unit_via_kanban_cli" ? mappedActingWorkUnit : null;
}

// dry-run 与「提交之后投影还没追上」都用它：在空的断言投影上套用这批事件草稿，得到与真实投影同形的关系。
function previewAssertedRelationByApplyingEventDraftsToScratchProjection(
	eventDrafts: InterWorkUnitRelationLedgerEventDraft[],
	existingRelation: AssertedInterWorkUnitRelation | null,
	relationId: string,
): AssertedInterWorkUnitRelation | null {
	const scratchState = createEmptyAssertedInterWorkUnitRelationProjectionState();
	if (existingRelation) {
		scratchState.assertedRelationsByRelationId.set(existingRelation.relationId, structuredClone(existingRelation));
	}
	eventDrafts.forEach((eventDraft, index) => {
		const previewEvent: CommittedInterWorkUnitRelationLedgerEvent = {
			...eventDraft,
			eventId: `relation-assertion-write-preview-${index}`,
			globalCommittedEventSequence: index + 1,
			recordedInSourceOfTruthEventLogAt: eventDraft.occurredAt,
		};
		applyInterWorkUnitRelationAssertionLifecycleEvent(scratchState, previewEvent);
	});
	return findAssertedInterWorkUnitRelationByRelationId(scratchState, relationId);
}

interface ReferenceRelationAssertionWriteInput {
	proposer: InterWorkUnitRelationAssertionProposer;
	// CLI：主语就是请求方工作单元；Web UI：面板所在的卡。
	subjectWorkUnitSelectorOfWebUiUser: WorkUnitSelectorForRelationRead | null;
	relationKind: AssertedInterWorkUnitReferenceRelationKind;
	counterpartWorkUnit: WorkUnitSelectorForRelationRead;
	relationAssertionRationaleOneSentence: string;
	relationAssertionEvidencePointers: string[];
	assertedRelationKindSpecificAttributes: AssertedReferenceRelationKindSpecificAttributes;
	agentSelectedConfirmationStrategy: RelationAffectingConfirmableChangeConfirmationStrategy | null;
	strategySelectionRationale: string | null;
	dryRunWithoutWritingIntoLedger: boolean;
	expectedSupportEndpoints?: {
		subject: KanbanBoardCardWorkUnitQualifiedReference;
		anchor: KanbanBoardCardWorkUnitQualifiedReference;
	};
}

interface RelationRevocationWriteInput {
	proposer: InterWorkUnitRelationAssertionProposer;
	relationId: string;
	relationAssertionRevocationReason: RelationAssertionRevocationReason;
	agentSelectedConfirmationStrategy: RelationAffectingConfirmableChangeConfirmationStrategy | null;
	strategySelectionRationale: string | null;
	dryRunWithoutWritingIntoLedger: boolean;
}

export interface RuntimeTaskIndexingSupportReferenceAssertionWritePort {
	assertUnverifiedReferenceRelationAsTaskIndexingSupport: (input: {
		subject: KanbanBoardCardWorkUnitQualifiedReference;
		candidate: IncomingWorkItemRelationCandidate;
		expectedRequirementsFingerprintByTaskIdentity: Readonly<Record<string, string>>;
	}) => Promise<void>;
}

export function createWorkUnitRelationAssertionWriteApi(
	deps: CreateWorkUnitRelationAssertionWriteApiDependencies,
): RuntimeTrpcContext["workUnitRelationAssertionWriteApi"] & RuntimeTaskIndexingSupportReferenceAssertionWritePort {
	const kanbanActorResolutionLookups =
		deps.kanbanActorResolutionLookups ?? createKanbanActorResolutionLookupsBackedByWorkspaceStateFiles();

	function routeOrThrow(
		proposer: InterWorkUnitRelationAssertionProposer,
		classifyRows: () => string[],
		agentSelectedConfirmationStrategy: RelationAffectingConfirmableChangeConfirmationStrategy | null,
		strategySelectionRationale: string | null,
	): {
		routingDecision: RelationAffectingConfirmableChangeRoutingDecisionRecordedInLedger;
		decisionSource: RelationAffectingConfirmableChangeDecisionSource;
	} {
		if (proposer.proposerKind === "runtime_task_indexing_support_unverified_reference")
			return {
				routingDecision: buildTaskIndexingSupportUnverifiedReferenceRoutingDecision(),
				decisionSource: "strategy_requires_no_user_review",
			};
		if (proposer.proposerKind === "web_ui_user_with_verified_page_load_nonce") {
			return {
				routingDecision: buildRoutingDecisionForChangeAssertedDirectlyByWebUiUser(),
				decisionSource: "asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
			};
		}
		const routing = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: classifyRows(),
			agentSelectedConfirmationStrategy,
			strategySelectionRationale,
		});
		if (!routing.routingSucceeded) {
			return throwRelationAssertionWriteError(
				"PRECONDITION_FAILED",
				routing.routingRefusalErrorCode,
				routing.routingRefusalMessage,
			);
		}
		return { routingDecision: routing.routingDecision, decisionSource: "strategy_requires_no_user_review" };
	}

	async function buildWriteResponse(input: {
		relationAssertionWriteOutcome: InterWorkUnitRelationAssertionWriteResponse["relationAssertionWriteOutcome"];
		relationAffectingConfirmableChangeId: string | null;
		assertedRelation: AssertedInterWorkUnitRelation;
		routingDecision: RelationAffectingConfirmableChangeRoutingDecisionRecordedInLedger;
		userRejectionSuppressionTombstoneRecorded: boolean;
		reader: RecordedInterWorkUnitRelationProjectionReader;
	}): Promise<InterWorkUnitRelationAssertionWriteResponse> {
		const [subjectDisplayEntry, anchorDisplayEntry] = await buildWorkUnitDisplayEntries(
			input.reader,
			[
				input.assertedRelation.relationStatementSubjectWorkUnitRef,
				input.assertedRelation.relationStatementAnchorWorkUnitRef,
			],
			deps.getWorkspacePathById,
		);
		return {
			relationAssertionWriteOutcome: input.relationAssertionWriteOutcome,
			relationAffectingConfirmableChangeId: input.relationAffectingConfirmableChangeId,
			assertedRelation: input.assertedRelation,
			confirmationRoutingDecision: { ...input.routingDecision },
			...renderRelationStatementFromBothEndpointPerspectives({
				relationKind: input.assertedRelation.relationKind as AssertedInterWorkUnitReferenceRelationKind,
				subjectWorkUnitDisplayLabel: subjectDisplayEntry?.workUnitDisplayLabel ?? "subject work unit",
				anchorWorkUnitDisplayLabel: anchorDisplayEntry?.workUnitDisplayLabel ?? "anchor work unit",
			}),
			userRejectionSuppressionTombstoneRecorded: input.userRejectionSuppressionTombstoneRecorded,
		};
	}

	// 提交成功后重读投影（读之前先追上账本），拿到与之后任何读一致的关系；极端情况下（投影还没认出）退用本地预演。
	async function readCommittedAssertedRelationAndBuildResponse(
		relationId: string,
		fallbackPreviewRelation: AssertedInterWorkUnitRelation | null,
		responseFields: Omit<Parameters<typeof buildWriteResponse>[0], "assertedRelation" | "reader">,
	): Promise<InterWorkUnitRelationAssertionWriteResponse> {
		return await deps.readRecordedInterWorkUnitRelationProjection(async (reader) => {
			const assertedRelation =
				findAssertedInterWorkUnitRelationByRelationId(
					reader.projectionState.assertedInterWorkUnitRelationProjectionState,
					relationId,
				) ?? fallbackPreviewRelation;
			if (!assertedRelation) {
				throw new Error(`Asserted relation ${relationId} is missing right after it was committed.`);
			}
			return await buildWriteResponse({ ...responseFields, assertedRelation, reader });
		});
	}

	async function writeReferenceRelationAssertion(
		input: ReferenceRelationAssertionWriteInput,
	): Promise<InterWorkUnitRelationAssertionWriteResponse> {
		const attributeValidation = validateAndCompleteAssertedReferenceRelationKindSpecificAttributes({
			relationKind: input.relationKind,
			assertedRelationKindSpecificAttributes: input.assertedRelationKindSpecificAttributes,
			relationAssertionRationaleOneSentence: input.relationAssertionRationaleOneSentence,
		});
		if (!attributeValidation.validationPassed) {
			throwRelationAssertionWriteError(
				"BAD_REQUEST",
				"asserted_relation_kind_specific_attributes_invalid",
				attributeValidation.validationFailureMessage,
			);
		}
		const kindSpecificAttributes = attributeValidation.validatedValue;
		const normalizedEvidenceAnchors = normalizeRelationAssertionEvidenceAnchors(
			input.relationAssertionEvidencePointers,
		);
		const proposerPolicyIdentityKey = buildRelationProposerPolicyIdentityKey(input.proposer);
		for (let attempt = 1; attempt <= MAXIMUM_COMPARE_AND_SET_ATTEMPTS_PER_RELATION_ASSERTION_WRITE; attempt += 1) {
			const plan = await deps.readRecordedInterWorkUnitRelationProjection((reader) => {
				const mappedActingWorkUnit =
					input.proposer.proposerKind === "acting_work_unit_via_kanban_cli"
						? resolveWorkUnitByCurrentConversationSessionOwnership(reader, input.proposer.actingWorkUnit)
						: null;
				let subject: InterWorkUnitRelationWorkUnitReference;
				if (mappedActingWorkUnit) {
					subject = mappedActingWorkUnit;
					assertKanbanBoardCardEndpointNotPermanentlyRemoved(reader, subject, "subject");
				} else if (input.subjectWorkUnitSelectorOfWebUiUser) {
					subject = resolveRelationEndpointFromSelector(
						reader,
						input.subjectWorkUnitSelectorOfWebUiUser,
						"subject",
					);
				} else {
					throw new Error(
						"A relation assertion needs either the acting work unit or the Web UI subject selector.",
					);
				}
				const anchor = resolveRelationEndpointFromSelector(reader, input.counterpartWorkUnit, "counterpart");
				if (
					input.expectedSupportEndpoints &&
					(JSON.stringify(subject) !== JSON.stringify(input.expectedSupportEndpoints.subject) ||
						JSON.stringify(anchor) !== JSON.stringify(input.expectedSupportEndpoints.anchor))
				)
					throw new Error("support 关系端点 incarnation 已变化，拒绝写入。");
				const endpointValidation = validateAssertedReferenceRelationEndpoints({
					relationKind: input.relationKind,
					relationStatementSubjectWorkUnitRef: subject,
					relationStatementAnchorWorkUnitRef: anchor,
				});
				if (!endpointValidation.validationPassed) {
					throwRelationAssertionWriteError(
						"BAD_REQUEST",
						"asserted_relation_endpoints_invalid",
						endpointValidation.validationFailureMessage,
					);
				}
				const relationAssertionNaturalKey = buildRelationAssertionNaturalKey({
					relationKind: input.relationKind,
					relationStatementSubjectWorkUnitRef: subject,
					relationStatementAnchorWorkUnitRef: anchor,
				});
				return {
					reader,
					subject,
					anchor,
					mappedActingWorkUnit,
					relationAssertionNaturalKey,
					endpointPlanFingerprintsWithEndpointWorkUnitKeys:
						readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection(
							reader.projectionState.kanbanBoardCardIdentityProjectionState,
							subject,
							anchor,
						),
					effectiveRelationInProjection: findEffectiveAssertedInterWorkUnitRelationByNaturalKey(
						reader.projectionState.assertedInterWorkUnitRelationProjectionState,
						relationAssertionNaturalKey,
					),
					evaluatedAsOfGlobalCommittedEventSequence:
						reader.projectionState.lastAppliedGlobalCommittedEventSequence,
				};
			});
			const subjectAndAnchorKeys = new Set([
				buildInterWorkUnitRelationWorkUnitKey(plan.subject),
				buildInterWorkUnitRelationWorkUnitKey(plan.anchor),
			]);
			const { routingDecision, decisionSource } = routeOrThrow(
				input.proposer,
				() =>
					classifyReferenceRelationAssertionIntoConfirmationMatrixRows({
						proposerIsOneOfTheRelationEndpoints:
							plan.mappedActingWorkUnit !== null &&
							subjectAndAnchorKeys.has(buildInterWorkUnitRelationWorkUnitKey(plan.mappedActingWorkUnit)),
					}),
				input.agentSelectedConfirmationStrategy,
				input.strategySelectionRationale,
			);
			const relationEndpoints = [plan.subject, plan.anchor];
			const outcome = await deps.runInterWorkUnitRelationLedgerClientOperation(
				async (ledgerClient, capturingKanbanRuntimeInstance) => {
					const guard = await ledgerClient.readInterWorkUnitRelationAssertionWriteGuardState({
						relationAssertionNaturalKey: plan.relationAssertionNaturalKey,
						relationId: null,
					});
					const occurredAt = Date.now();
					const buildEventDraft = (
						eventKind: Parameters<typeof buildInterWorkUnitRelationAssertionLifecycleEventDraft>[0]["eventKind"],
						eventPayload: Record<string, unknown>,
					) =>
						buildInterWorkUnitRelationAssertionLifecycleEventDraft({
							proposer: input.proposer,
							eventKind,
							occurredAt,
							capturingKanbanRuntimeInstance,
							relationEndpoints,
							eventPayload,
						});
					const compareAndSetExpectations = {
						relationAssertionNaturalKey: plan.relationAssertionNaturalKey,
						expectedEffectiveRelationIdOfNaturalKey:
							guard.effectiveAssertedRelationOfNaturalKey?.relationId ?? null,
						expectedUserRejectionSuppressionTombstoneCountOfNaturalKey:
							guard.userRejectionSuppressionTombstonesOfNaturalKey.length,
					};
					const effectiveOfNaturalKey = guard.effectiveAssertedRelationOfNaturalKey;
					if (effectiveOfNaturalKey) {
						// 投影落后于守卫（别的实例 / 请求刚提交）：重追投影再判。
						if (
							!plan.effectiveRelationInProjection ||
							plan.effectiveRelationInProjection.relationId !== effectiveOfNaturalKey.relationId ||
							plan.effectiveRelationInProjection.assertedRelationStateVersion !==
								effectiveOfNaturalKey.assertedRelationStateVersion
						) {
							return { writeAttemptOutcome: "retry_after_projection_catches_up" } as const;
						}
						// 已有确认属于原声称。新 support 发现只在自己的备注/处置事件保存，绝不合入后继承其用户确认。
						if (input.proposer.proposerKind === "runtime_task_indexing_support_unverified_reference")
							return {
								writeAttemptOutcome: "reassertion_merged_into_already_effective_assertion",
								relationId: effectiveOfNaturalKey.relationId,
								previewRelation: plan.effectiveRelationInProjection,
							} as const;
						const mergeEventDraft = buildEventDraft(
							"inter_work_unit_relation_reassertion_merged_into_already_effective_assertion",
							{
								mergedIntoEffectiveRelationId: effectiveOfNaturalKey.relationId,
								relationAssertionNaturalKey: plan.relationAssertionNaturalKey,
								reassertingProposerPolicyIdentityKey: proposerPolicyIdentityKey,
								reassertingProposerWorkUnitRef: proposerWorkUnitOrNull(
									input.proposer,
									plan.mappedActingWorkUnit,
								),
								reassertionRationaleOneSentence: input.relationAssertionRationaleOneSentence,
								reassertionEvidencePointers: normalizedEvidenceAnchors,
								reassertionKindSpecificAttributes: kindSpecificAttributes,
								reassertionDecisionSource: decisionSource,
								confirmationRoutingDecision: routingDecision,
								assertedRelationStateVersionAfterMerge: effectiveOfNaturalKey.assertedRelationStateVersion + 1,
								evaluatedAsOfGlobalCommittedEventSequence: plan.evaluatedAsOfGlobalCommittedEventSequence,
							},
						);
						const previewRelation = previewAssertedRelationByApplyingEventDraftsToScratchProjection(
							[mergeEventDraft],
							plan.effectiveRelationInProjection,
							effectiveOfNaturalKey.relationId,
						);
						if (input.dryRunWithoutWritingIntoLedger) {
							return {
								writeAttemptOutcome: "dry_run_would_merge_into_already_effective_assertion",
								previewRelation,
							} as const;
						}
						const committedEvents =
							await ledgerClient.commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet({
								compareAndSetExpectations,
								assertedRelationStateWrite: {
									assertedRelationStateWriteKind: "bump_version_of_effective_asserted_relation",
									relationId: effectiveOfNaturalKey.relationId,
									expectedAssertedRelationStateVersion: effectiveOfNaturalKey.assertedRelationStateVersion,
								},
								userRejectionSuppressionTombstoneInsert: null,
								eventDrafts: [mergeEventDraft],
							});
						return committedEvents
							? ({
									writeAttemptOutcome: "reassertion_merged_into_already_effective_assertion",
									relationId: effectiveOfNaturalKey.relationId,
									previewRelation,
								} as const)
							: ({ writeAttemptOutcome: "retry_after_compare_and_set_conflict" } as const);
					}
					const suppressingTombstone = findUserRejectionSuppressionTombstoneSuppressingAssertion({
						userRejectionSuppressionTombstonesOfNaturalKey: guard.userRejectionSuppressionTombstonesOfNaturalKey,
						proposer: input.proposer,
						normalizedProposedEvidenceAnchors: normalizedEvidenceAnchors,
						proposedAssertionEndpointPlanFingerprints: plan.endpointPlanFingerprintsWithEndpointWorkUnitKeys,
					});
					if (suppressingTombstone) {
						return throwRelationAssertionWriteError(
							"PRECONDITION_FAILED",
							RELATION_ASSERTION_SUPPRESSED_BY_USER_REJECTION_TOMBSTONE_ERROR_CODE,
							"This relation was revoked as incorrect, and nothing has changed since: no new evidence pointer, and neither work unit's requirements were amended. It is not asserted again; add an evidence pointer that was not part of the rejected assertion if you have new evidence.",
						);
					}
					const relationAffectingConfirmableChangeId = `relation-affecting-confirmable-change-${randomUUID()}`;
					const relationId = `asserted-relation-${randomUUID()}`;
					const eventDrafts = [
						buildEventDraft("relation_affecting_confirmable_change_created_and_routed", {
							relationAffectingConfirmableChangeId,
							relationAffectingConfirmableChangeKind: "asserted_relation_or_work_unit_gate_creation",
							relationProposerPolicyIdentityKey: proposerPolicyIdentityKey,
							relationProposerWorkUnitRef: proposerWorkUnitOrNull(input.proposer, plan.mappedActingWorkUnit),
							proposedInterWorkUnitRelationAssertion: {
								relationId,
								relationKind: input.relationKind,
								relationStatementSubjectWorkUnitRef: plan.subject,
								relationStatementAnchorWorkUnitRef: plan.anchor,
								relationAssertionNaturalKey: plan.relationAssertionNaturalKey,
								relationAssertionNaturalKeyDerivationVersion: RELATION_ASSERTION_NATURAL_KEY_DERIVATION_VERSION,
								relationAssertionRationaleOneSentence: input.relationAssertionRationaleOneSentence,
								relationAssertionEvidencePointers: normalizedEvidenceAnchors,
								assertedRelationKindSpecificAttributes: kindSpecificAttributes,
								endpointPlanFingerprintsAtAssertion: {
									subjectEndpointPlanFingerprint:
										plan.endpointPlanFingerprintsWithEndpointWorkUnitKeys.subjectEndpointPlanFingerprint,
									anchorEndpointPlanFingerprint:
										plan.endpointPlanFingerprintsWithEndpointWorkUnitKeys.anchorEndpointPlanFingerprint,
								},
							},
							confirmationRoutingDecision: routingDecision,
							evaluatedAsOfGlobalCommittedEventSequence: plan.evaluatedAsOfGlobalCommittedEventSequence,
						}),
						buildEventDraft("relation_affecting_confirmable_change_applied_and_effective", {
							relationAffectingConfirmableChangeId,
							relationAffectingConfirmableChangeKind: "asserted_relation_or_work_unit_gate_creation",
							relationAffectingConfirmableChangeDecisionSource: decisionSource,
							appliedRelationId: relationId,
							assertedRelationStateVersionAfterApplication: 1,
						}),
					];
					const previewRelation = previewAssertedRelationByApplyingEventDraftsToScratchProjection(
						eventDrafts,
						null,
						relationId,
					);
					if (input.dryRunWithoutWritingIntoLedger) {
						return { writeAttemptOutcome: "dry_run_would_apply_asserted_relation", previewRelation } as const;
					}
					const committedEvents =
						await ledgerClient.commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet({
							compareAndSetExpectations,
							assertedRelationStateWrite: {
								assertedRelationStateWriteKind: "insert_newly_effective_asserted_relation",
								relationId,
								relationKind: input.relationKind,
							},
							userRejectionSuppressionTombstoneInsert: null,
							eventDrafts,
						});
					return committedEvents
						? ({
								writeAttemptOutcome: "asserted_relation_applied_and_effective",
								relationId,
								relationAffectingConfirmableChangeId,
								previewRelation,
							} as const)
						: ({ writeAttemptOutcome: "retry_after_compare_and_set_conflict" } as const);
				},
			);
			switch (outcome.writeAttemptOutcome) {
				case "retry_after_projection_catches_up":
				case "retry_after_compare_and_set_conflict":
					continue;
				case "dry_run_would_merge_into_already_effective_assertion":
				case "dry_run_would_apply_asserted_relation":
					if (!outcome.previewRelation) {
						throw new Error("Dry-run preview of the asserted relation is missing.");
					}
					return await buildWriteResponse({
						relationAssertionWriteOutcome: outcome.writeAttemptOutcome,
						relationAffectingConfirmableChangeId: null,
						assertedRelation: outcome.previewRelation,
						routingDecision,
						userRejectionSuppressionTombstoneRecorded: false,
						reader: plan.reader,
					});
				case "reassertion_merged_into_already_effective_assertion":
					return await readCommittedAssertedRelationAndBuildResponse(outcome.relationId, outcome.previewRelation, {
						relationAssertionWriteOutcome: outcome.writeAttemptOutcome,
						relationAffectingConfirmableChangeId: null,
						routingDecision,
						userRejectionSuppressionTombstoneRecorded: false,
					});
				case "asserted_relation_applied_and_effective":
					return await readCommittedAssertedRelationAndBuildResponse(outcome.relationId, outcome.previewRelation, {
						relationAssertionWriteOutcome: outcome.writeAttemptOutcome,
						relationAffectingConfirmableChangeId: outcome.relationAffectingConfirmableChangeId,
						routingDecision,
						userRejectionSuppressionTombstoneRecorded: false,
					});
			}
		}
		return throwRelationAssertionWriteError(
			"CONFLICT",
			"relation_assertion_write_kept_conflicting_with_concurrent_writes",
			"Concurrent writes kept changing this relation while it was being asserted; retry the command.",
		);
	}

	async function writeRelationAssertionRevocation(
		input: RelationRevocationWriteInput,
	): Promise<InterWorkUnitRelationAssertionWriteResponse> {
		const proposerPolicyIdentityKey = buildRelationProposerPolicyIdentityKey(input.proposer);
		for (let attempt = 1; attempt <= MAXIMUM_COMPARE_AND_SET_ATTEMPTS_PER_RELATION_ASSERTION_WRITE; attempt += 1) {
			const plan = await deps.readRecordedInterWorkUnitRelationProjection((reader) => {
				const relation = findAssertedInterWorkUnitRelationByRelationId(
					reader.projectionState.assertedInterWorkUnitRelationProjectionState,
					input.relationId,
				);
				if (!relation) {
					throwRelationAssertionWriteError(
						"NOT_FOUND",
						"asserted_relation_not_found_in_inter_work_unit_relation_ledger",
						`No asserted relation with id ${input.relationId} is known (recorded relations cannot be revoked; they can only be muted in the Web UI).`,
					);
				}
				return {
					reader,
					relation,
					mappedActingWorkUnit:
						input.proposer.proposerKind === "acting_work_unit_via_kanban_cli"
							? resolveWorkUnitByCurrentConversationSessionOwnership(reader, input.proposer.actingWorkUnit)
							: null,
					endpointPlanFingerprintsWithEndpointWorkUnitKeys:
						readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection(
							reader.projectionState.kanbanBoardCardIdentityProjectionState,
							relation.relationStatementSubjectWorkUnitRef,
							relation.relationStatementAnchorWorkUnitRef,
						),
					evaluatedAsOfGlobalCommittedEventSequence:
						reader.projectionState.lastAppliedGlobalCommittedEventSequence,
				};
			});
			const { relation } = plan;
			const { routingDecision, decisionSource } = routeOrThrow(
				input.proposer,
				() =>
					classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows({
						revokedAssertionIncludesUserExplicitConsent: relation.decisionSourcesOfEffectiveAssertion.some(
							isUserExplicitConsentDecisionSource,
						),
						revokerIsOriginalAsserter:
							plan.mappedActingWorkUnit !== null &&
							relation.relationAsserterWorkUnitRef !== null &&
							buildInterWorkUnitRelationWorkUnitKey(plan.mappedActingWorkUnit) ===
								buildInterWorkUnitRelationWorkUnitKey(relation.relationAsserterWorkUnitRef),
					}),
				input.agentSelectedConfirmationStrategy,
				input.strategySelectionRationale,
			);
			if (relation.assertionEffectivenessState !== "applied_and_effective") {
				return await buildWriteResponse({
					relationAssertionWriteOutcome: "relation_assertion_was_already_revoked",
					relationAffectingConfirmableChangeId: null,
					assertedRelation: relation,
					routingDecision,
					userRejectionSuppressionTombstoneRecorded: false,
					reader: plan.reader,
				});
			}
			const normalizedRejectedEvidenceAnchors = normalizeRelationAssertionEvidenceAnchors(
				relation.relationAssertionEvidencePointers,
			);
			// Y-CONF-9：「有误」才留墓碑。用户撤销 → 抑制所有提议方；agent 撤销自己的断言 → 只抑制它自己（与抽取 / 建议类组件）。
			const userRejectionSuppressionTombstone: UserRejectionSuppressionTombstone | null =
				input.relationAssertionRevocationReason === "relation_was_incorrect"
					? {
							relationAssertionNaturalKey: relation.relationAssertionNaturalKey,
							rejectedEvidenceAnchors: normalizedRejectedEvidenceAnchors,
							rejectedEvidenceAnchorSetHash: hashRelationAssertionEvidenceAnchorSet(
								normalizedRejectedEvidenceAnchors,
							),
							// 指纹按端点工作单元键记：对称 kind 之后由另一端反向重断言时，仍能逐端点对上（Y-CONF-9）。
							endpointPlanFingerprintsAtRejection: plan.endpointPlanFingerprintsWithEndpointWorkUnitKeys,
							...(input.proposer.proposerKind === "web_ui_user_with_verified_page_load_nonce"
								? {
										suppressionScope: "all_relation_proposers_except_web_ui_user_direct_assertions",
										suppressedRelationProposerPolicyIdentityKey: null,
									}
								: {
										suppressionScope:
											"extraction_or_suggestion_origin_proposers_and_same_proposer_policy_identity_only",
										suppressedRelationProposerPolicyIdentityKey:
											relation.relationAsserterPolicyIdentityKey ?? proposerPolicyIdentityKey,
									}),
						}
					: null;
			const relationEndpoints = [
				relation.relationStatementSubjectWorkUnitRef,
				relation.relationStatementAnchorWorkUnitRef,
			];
			const outcome = await deps.runInterWorkUnitRelationLedgerClientOperation(
				async (ledgerClient, capturingKanbanRuntimeInstance) => {
					const guard = await ledgerClient.readInterWorkUnitRelationAssertionWriteGuardState({
						relationAssertionNaturalKey: relation.relationAssertionNaturalKey,
						relationId: relation.relationId,
					});
					if (
						guard.effectiveAssertedRelationOfNaturalKey?.relationId !== relation.relationId ||
						guard.effectiveAssertedRelationOfNaturalKey.assertedRelationStateVersion !==
							relation.assertedRelationStateVersion
					) {
						return { writeAttemptOutcome: "retry_after_projection_catches_up" } as const;
					}
					const occurredAt = Date.now();
					const relationAffectingConfirmableChangeId = `relation-affecting-confirmable-change-${randomUUID()}`;
					const eventDrafts = [
						buildInterWorkUnitRelationAssertionLifecycleEventDraft({
							proposer: input.proposer,
							eventKind: "relation_affecting_confirmable_change_created_and_routed",
							occurredAt,
							capturingKanbanRuntimeInstance,
							relationEndpoints,
							eventPayload: {
								relationAffectingConfirmableChangeId,
								relationAffectingConfirmableChangeKind:
									"applied_asserted_relation_or_work_unit_gate_revocation",
								relationProposerPolicyIdentityKey: proposerPolicyIdentityKey,
								relationProposerWorkUnitRef: proposerWorkUnitOrNull(input.proposer, plan.mappedActingWorkUnit),
								targetRelationId: relation.relationId,
								targetRelationAssertionNaturalKey: relation.relationAssertionNaturalKey,
								relationAssertionRevocationReason: input.relationAssertionRevocationReason,
								confirmationRoutingDecision: routingDecision,
								evaluatedAsOfGlobalCommittedEventSequence: plan.evaluatedAsOfGlobalCommittedEventSequence,
							},
						}),
						buildInterWorkUnitRelationAssertionLifecycleEventDraft({
							proposer: input.proposer,
							eventKind: "relation_affecting_confirmable_change_applied_and_effective",
							occurredAt,
							capturingKanbanRuntimeInstance,
							relationEndpoints,
							eventPayload: {
								relationAffectingConfirmableChangeId,
								relationAffectingConfirmableChangeKind:
									"applied_asserted_relation_or_work_unit_gate_revocation",
								relationAffectingConfirmableChangeDecisionSource: decisionSource,
								revokedRelationId: relation.relationId,
								relationAssertionRevocationReason: input.relationAssertionRevocationReason,
								userRejectionSuppressionTombstone,
								assertedRelationStateVersionAfterApplication: relation.assertedRelationStateVersion + 1,
							},
						}),
					];
					const previewRelation = previewAssertedRelationByApplyingEventDraftsToScratchProjection(
						eventDrafts,
						relation,
						relation.relationId,
					);
					if (input.dryRunWithoutWritingIntoLedger) {
						return {
							writeAttemptOutcome: "dry_run_would_revoke_effective_relation_assertion",
							previewRelation,
						} as const;
					}
					const committedEvents =
						await ledgerClient.commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet({
							compareAndSetExpectations: {
								relationAssertionNaturalKey: relation.relationAssertionNaturalKey,
								expectedEffectiveRelationIdOfNaturalKey: relation.relationId,
								expectedUserRejectionSuppressionTombstoneCountOfNaturalKey:
									guard.userRejectionSuppressionTombstonesOfNaturalKey.length,
							},
							assertedRelationStateWrite: {
								assertedRelationStateWriteKind: "mark_effective_asserted_relation_revoked",
								relationId: relation.relationId,
								expectedAssertedRelationStateVersion: relation.assertedRelationStateVersion,
							},
							userRejectionSuppressionTombstoneInsert: userRejectionSuppressionTombstone,
							eventDrafts,
						});
					return committedEvents
						? ({
								writeAttemptOutcome: "effective_relation_assertion_revoked",
								relationAffectingConfirmableChangeId,
								previewRelation,
							} as const)
						: ({ writeAttemptOutcome: "retry_after_compare_and_set_conflict" } as const);
				},
			);
			switch (outcome.writeAttemptOutcome) {
				case "retry_after_projection_catches_up":
				case "retry_after_compare_and_set_conflict":
					continue;
				case "dry_run_would_revoke_effective_relation_assertion":
					if (!outcome.previewRelation) {
						throw new Error("Dry-run preview of the revoked relation is missing.");
					}
					return await buildWriteResponse({
						relationAssertionWriteOutcome: outcome.writeAttemptOutcome,
						relationAffectingConfirmableChangeId: null,
						assertedRelation: outcome.previewRelation,
						routingDecision,
						userRejectionSuppressionTombstoneRecorded: false,
						reader: plan.reader,
					});
				case "effective_relation_assertion_revoked":
					return await readCommittedAssertedRelationAndBuildResponse(
						relation.relationId,
						outcome.previewRelation,
						{
							relationAssertionWriteOutcome: outcome.writeAttemptOutcome,
							relationAffectingConfirmableChangeId: outcome.relationAffectingConfirmableChangeId,
							routingDecision,
							userRejectionSuppressionTombstoneRecorded: userRejectionSuppressionTombstone !== null,
						},
					);
			}
		}
		return throwRelationAssertionWriteError(
			"CONFLICT",
			"relation_assertion_write_kept_conflicting_with_concurrent_writes",
			"Concurrent writes kept changing this relation while it was being revoked; retry the command.",
		);
	}

	return {
		assertUnverifiedReferenceRelationAsTaskIndexingSupport: async ({
			subject,
			candidate,
			expectedRequirementsFingerprintByTaskIdentity,
		}) => {
			if (candidate.cross_project || subject.workspaceId !== candidate.task_reference.workspaceId)
				throw new Error("跨项目 support 分诊只返回候选，不写最终关系。");
			if (
				!["reference_concerns_behavior_or_state_of", "reference_is_generally_related_with"].includes(
					candidate.relation_kind,
				)
			)
				throw new Error("support 只能写入未核验参照关系。");
			const selector = (reference: KanbanBoardCardWorkUnitQualifiedReference): WorkUnitSelectorForRelationRead => ({
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
				bareTaskId: reference.taskId,
				workspaceId: reference.workspaceId,
			});
			await readWorkspaceBoardByIdAndRunWithBoardLockHeld(subject.workspaceId, async (board) => {
				for (const endpoint of [subject, candidate.task_reference]) {
					const column = board.columns.find((entry) => entry.cards.some((card) => card.id === endpoint.taskId));
					const task = column?.cards.find((card) => card.id === endpoint.taskId);
					if (!task || !column || task.createdAt !== endpoint.taskIncarnationCreatedAtEpochMs)
						throw new Error("support 关系端点 incarnation 已变化，拒绝写入。");
					const expected = expectedRequirementsFingerprintByTaskIdentity[JSON.stringify(endpoint)];
					if (
						!expected ||
						taskIndexingMaterialRequirementsFingerprint({
							taskReference: endpoint,
							title: task.title ?? "",
							prompt: task.prompt,
							columnId: column.id,
						}) !== expected
					)
						throw new Error("support 关系端点要求在最终写入前已变化或缺少分析指纹，拒绝过时分诊。");
				}
				return await translateLedgerUnavailability(() =>
					writeReferenceRelationAssertion({
						proposer: { proposerKind: "runtime_task_indexing_support_unverified_reference" },
						subjectWorkUnitSelectorOfWebUiUser: selector(subject),
						counterpartWorkUnit: selector(candidate.task_reference),
						expectedSupportEndpoints: { subject, anchor: candidate.task_reference },
						relationKind: candidate.relation_kind,
						relationAssertionRationaleOneSentence: candidate.rationale.slice(0, 600),
						relationAssertionEvidencePointers: candidate.evidence,
						assertedRelationKindSpecificAttributes:
							candidate.relation_kind === "reference_concerns_behavior_or_state_of"
								? {
										concernNature: "checks_scope_overlap_with",
										concernedAspectSummary: candidate.rationale.slice(0, 600),
									}
								: {},
						agentSelectedConfirmationStrategy: null,
						strategySelectionRationale: null,
						dryRunWithoutWritingIntoLedger: false,
					}),
				);
			});
		},
		applyReferenceRelationModelingChangesDirectlyAsWebUiUser: async (input, evidence) => {
			assertWebUiUserDecisionRequestOrigin(evidence, input.webUiUserDecisionClientCharacteristics);
			return translateLedgerUnavailability(() => applyReferenceRelationModelingChanges(deps, input));
		},
		assertReferenceRelationAsActingWorkUnit: async (
			input: AssertReferenceRelationAsActingWorkUnitRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) =>
			await translateLedgerUnavailability(async () =>
				writeReferenceRelationAssertion({
					proposer: await resolveActingWorkUnitProposerOfKanbanCliRequest(
						kanbanRequestOriginActorEvidence,
						kanbanActorResolutionLookups,
					),
					subjectWorkUnitSelectorOfWebUiUser: null,
					relationKind: input.relationKind,
					counterpartWorkUnit: input.counterpartWorkUnit,
					relationAssertionRationaleOneSentence: input.relationAssertionRationaleOneSentence,
					relationAssertionEvidencePointers: input.relationAssertionEvidencePointers,
					assertedRelationKindSpecificAttributes: input.assertedRelationKindSpecificAttributes,
					agentSelectedConfirmationStrategy: input.agentSelectedConfirmationStrategy ?? null,
					strategySelectionRationale: input.strategySelectionRationale ?? null,
					dryRunWithoutWritingIntoLedger: input.dryRunWithoutWritingIntoLedger,
				}),
			),
		revokeEffectiveRelationAssertionAsActingWorkUnit: async (
			input: RevokeEffectiveRelationAssertionAsActingWorkUnitRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) =>
			await translateLedgerUnavailability(async () =>
				writeRelationAssertionRevocation({
					proposer: await resolveActingWorkUnitProposerOfKanbanCliRequest(
						kanbanRequestOriginActorEvidence,
						kanbanActorResolutionLookups,
					),
					relationId: input.relationId,
					relationAssertionRevocationReason: input.relationAssertionRevocationReason,
					agentSelectedConfirmationStrategy: input.agentSelectedConfirmationStrategy ?? null,
					strategySelectionRationale: input.strategySelectionRationale ?? null,
					dryRunWithoutWritingIntoLedger: input.dryRunWithoutWritingIntoLedger,
				}),
			),
		assertReferenceRelationDirectlyAsWebUiUser: async (
			input: AssertReferenceRelationDirectlyAsWebUiUserRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => {
			assertWebUiUserDecisionRequestOrigin(
				kanbanRequestOriginActorEvidence,
				input.webUiUserDecisionClientCharacteristics,
			);
			return await translateLedgerUnavailability(async () =>
				writeReferenceRelationAssertion({
					proposer: {
						proposerKind: "web_ui_user_with_verified_page_load_nonce",
						webUiUserDecisionClientCharacteristics: input.webUiUserDecisionClientCharacteristics,
					},
					subjectWorkUnitSelectorOfWebUiUser: input.subjectWorkUnit,
					relationKind: input.relationKind,
					counterpartWorkUnit: input.counterpartWorkUnit,
					relationAssertionRationaleOneSentence: input.relationAssertionRationaleOneSentence,
					relationAssertionEvidencePointers: input.relationAssertionEvidencePointers,
					assertedRelationKindSpecificAttributes: input.assertedRelationKindSpecificAttributes,
					agentSelectedConfirmationStrategy: null,
					strategySelectionRationale: null,
					dryRunWithoutWritingIntoLedger: false,
				}),
			);
		},
		revokeEffectiveRelationAssertionDirectlyAsWebUiUser: async (
			input: RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => {
			assertWebUiUserDecisionRequestOrigin(
				kanbanRequestOriginActorEvidence,
				input.webUiUserDecisionClientCharacteristics,
			);
			return await translateLedgerUnavailability(async () =>
				writeRelationAssertionRevocation({
					proposer: {
						proposerKind: "web_ui_user_with_verified_page_load_nonce",
						webUiUserDecisionClientCharacteristics: input.webUiUserDecisionClientCharacteristics,
					},
					relationId: input.relationId,
					relationAssertionRevocationReason: input.relationAssertionRevocationReason,
					agentSelectedConfirmationStrategy: null,
					strategySelectionRationale: null,
					dryRunWithoutWritingIntoLedger: false,
				}),
			);
		},
	};
}
