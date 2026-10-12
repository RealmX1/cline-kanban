import { createHash } from "node:crypto";

import {
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitReferenceRelationKind,
	type AssertedReferenceRelationKindSpecificAttributes,
} from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import {
	type InterWorkUnitRelationAssertionLifecycleEventKind,
	RELATION_ASSERTION_NATURAL_KEY_DERIVATION_VERSION,
	type RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys,
	type UserRejectionSuppressionTombstone,
} from "../core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import type {
	CapturingKanbanRuntimeInstanceIdentity,
	InterWorkUnitRelationLedgerEventDraft,
	InterWorkUnitRelationWorkUnitReference,
	KanbanActor,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import type { WebUiUserDecisionClientCharacteristics } from "../core/work-unit-relation-assertion-write-api-contract";
import type { ResolvedKanbanActorWithEventEnvelopeContext } from "./kanban-actor-resolution-from-request-origin-evidence";
import {
	buildInterWorkUnitRelationWorkUnitKey,
	type KanbanBoardCardIdentityProjectionState,
} from "./kanban-board-card-identity-projection-from-ledger-events";

// dd2db 2.1 断言写入的纯规划助手：自然键、证据锚点、提议方策略身份、端点计划指纹、拒绝墓碑匹配、kind 属性与端点校验、
// 双视角回显、族 4 事件草稿。编排（读投影、守卫读、CAS 提交、错误码）在 src/trpc/work-unit-relation-assertion-write-api.ts。

export type InterWorkUnitRelationAssertionProposer =
	| {
			proposerKind: "acting_work_unit_via_kanban_cli";
			actingWorkUnit: InterWorkUnitRelationWorkUnitReference;
			resolvedActorWithEventEnvelopeContext: ResolvedKanbanActorWithEventEnvelopeContext;
	  }
	| {
			proposerKind: "web_ui_user_with_verified_page_load_nonce";
			webUiUserDecisionClientCharacteristics: WebUiUserDecisionClientCharacteristics;
	  };

const WEB_UI_USER_RELATION_PROPOSER_POLICY_IDENTITY_KEY = "kanban_web_ui_user_with_verified_page_load_nonce";

// d-confirm §5.2：额度、冷却、墓碑按提议方「策略身份」计——优先原生会话身份（跨越采纳不变），退用 kanban 会话 id，
// 再退用工作单元。与「事件记在哪个工作单元名下」是两回事。
export function buildRelationProposerPolicyIdentityKey(proposer: InterWorkUnitRelationAssertionProposer): string {
	if (proposer.proposerKind === "web_ui_user_with_verified_page_load_nonce") {
		return WEB_UI_USER_RELATION_PROPOSER_POLICY_IDENTITY_KEY;
	}
	const context = proposer.resolvedActorWithEventEnvelopeContext;
	if (context.actorNativeConversationSessionIdentity) {
		const identity = context.actorNativeConversationSessionIdentity;
		return `native_conversation_session:${identity.conversationSessionHostKanbanAgentId}:${identity.nativeConversationSessionId}`;
	}
	if (context.actorKanbanTaskConversationSessionId) {
		return `kanban_task_conversation_session:${context.actorKanbanTaskConversationSessionId}`;
	}
	return `work_unit:${buildInterWorkUnitRelationWorkUnitKey(proposer.actingWorkUnit)}`;
}

// 自然键 = kind + 有序限定端点（对称 kind 按无序对）+ 影响语义的关键属性（参照轴没有），再取哈希（d-confirm §4.7）。
export function buildRelationAssertionNaturalKey(input: {
	relationKind: AssertedInterWorkUnitReferenceRelationKind;
	relationStatementSubjectWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
	relationStatementAnchorWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
}): string {
	const endpointKeys = [
		buildInterWorkUnitRelationWorkUnitKey(input.relationStatementSubjectWorkUnitRef),
		buildInterWorkUnitRelationWorkUnitKey(input.relationStatementAnchorWorkUnitRef),
	];
	if (
		ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[input.relationKind].relationEndpointSymmetry ===
		"symmetric_unordered_endpoint_pair"
	) {
		endpointKeys.sort();
	}
	const naturalKeyMaterial = [input.relationKind, ...endpointKeys].join("\u0000");
	return `relation-assertion-natural-key-v${RELATION_ASSERTION_NATURAL_KEY_DERIVATION_VERSION}-${createHash("sha256").update(naturalKeyMaterial, "utf8").digest("hex").slice(0, 40)}`;
}

export function normalizeRelationAssertionEvidenceAnchors(evidencePointers: readonly string[]): string[] {
	return [
		...new Set(evidencePointers.map((pointer) => pointer.trim()).filter((pointer) => pointer.length > 0)),
	].sort();
}

export function hashRelationAssertionEvidenceAnchorSet(normalizedEvidenceAnchors: readonly string[]): string {
	return createHash("sha256").update(normalizedEvidenceAnchors.join("\n"), "utf8").digest("hex");
}

// 端点的计划指纹：卡 = 当前 prompt 正文的指纹（Y-OBLIG：指纹不含标题）；独立会话没有计划。
export function readEndpointPlanFingerprintFromKanbanBoardCardIdentityProjection(
	identityProjectionState: KanbanBoardCardIdentityProjectionState,
	endpoint: InterWorkUnitRelationWorkUnitReference,
): string | null {
	if (endpoint.workUnitType !== "kanban_board_card") {
		return null;
	}
	return (
		identityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.get(
			buildInterWorkUnitRelationWorkUnitKey(endpoint),
		)?.currentFieldValueSha256ByFieldName.prompt ?? null
	);
}

// 写墓碑与匹配墓碑共用这一处读法：两端指纹各自带上端点工作单元键，两侧就不会各自按位置拼出不同形状。
export function readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection(
	identityProjectionState: KanbanBoardCardIdentityProjectionState,
	relationStatementSubjectWorkUnitRef: InterWorkUnitRelationWorkUnitReference,
	relationStatementAnchorWorkUnitRef: InterWorkUnitRelationWorkUnitReference,
): RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys {
	return {
		subjectEndpointWorkUnitKey: buildInterWorkUnitRelationWorkUnitKey(relationStatementSubjectWorkUnitRef),
		subjectEndpointPlanFingerprint: readEndpointPlanFingerprintFromKanbanBoardCardIdentityProjection(
			identityProjectionState,
			relationStatementSubjectWorkUnitRef,
		),
		anchorEndpointWorkUnitKey: buildInterWorkUnitRelationWorkUnitKey(relationStatementAnchorWorkUnitRef),
		anchorEndpointPlanFingerprint: readEndpointPlanFingerprintFromKanbanBoardCardIdentityProjection(
			identityProjectionState,
			relationStatementAnchorWorkUnitRef,
		),
	};
}

// 两端计划都没变 = 新断言的每个端点，按端点工作单元键在墓碑里找到同一个端点，且指纹相同。对称 kind 反向重断言时
// 主语 / 锚点位置对调，但端点键不变，所以仍逐端点比对；有向 kind 的自然键带方向，端点键与位置一一对应，行为不变。
// 墓碑里找不到某个端点键（不该发生：自然键相同即端点相同）时不能断言「没变」，按变了处理、不抑制。
function areRelationEndpointPlanFingerprintsUnchangedSinceRejectionAlignedByEndpointWorkUnitKey(
	endpointPlanFingerprintsAtRejection: RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys,
	proposedAssertionEndpointPlanFingerprints: RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys,
): boolean {
	const endpointPlanFingerprintAtRejectionByEndpointWorkUnitKey = new Map<string, string | null>([
		[
			endpointPlanFingerprintsAtRejection.subjectEndpointWorkUnitKey,
			endpointPlanFingerprintsAtRejection.subjectEndpointPlanFingerprint,
		],
		[
			endpointPlanFingerprintsAtRejection.anchorEndpointWorkUnitKey,
			endpointPlanFingerprintsAtRejection.anchorEndpointPlanFingerprint,
		],
	]);
	const proposedEndpointWorkUnitKeyAndPlanFingerprintPairs: Array<[string, string | null]> = [
		[
			proposedAssertionEndpointPlanFingerprints.subjectEndpointWorkUnitKey,
			proposedAssertionEndpointPlanFingerprints.subjectEndpointPlanFingerprint,
		],
		[
			proposedAssertionEndpointPlanFingerprints.anchorEndpointWorkUnitKey,
			proposedAssertionEndpointPlanFingerprints.anchorEndpointPlanFingerprint,
		],
	];
	return proposedEndpointWorkUnitKeyAndPlanFingerprintPairs.every(
		([endpointWorkUnitKey, proposedEndpointPlanFingerprint]) =>
			endpointPlanFingerprintAtRejectionByEndpointWorkUnitKey.has(endpointWorkUnitKey) &&
			endpointPlanFingerprintAtRejectionByEndpointWorkUnitKey.get(endpointWorkUnitKey) ===
				proposedEndpointPlanFingerprint,
	);
}

// Y-CONF-9 命中抑制：自然键相同（调用方已按自然键取墓碑）、新断言的证据锚点是墓碑锚点的子集（没有新证据）、
// 两端计划指纹都与墓碑相同（按端点工作单元键对齐），三者同时满足才抑制。Web UI 用户的直接断言永远不受抑制。
export function findUserRejectionSuppressionTombstoneSuppressingAssertion(input: {
	userRejectionSuppressionTombstonesOfNaturalKey: readonly UserRejectionSuppressionTombstone[];
	proposer: InterWorkUnitRelationAssertionProposer;
	normalizedProposedEvidenceAnchors: readonly string[];
	proposedAssertionEndpointPlanFingerprints: RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys;
}): UserRejectionSuppressionTombstone | null {
	if (input.proposer.proposerKind === "web_ui_user_with_verified_page_load_nonce") {
		return null;
	}
	const proposerPolicyIdentityKey = buildRelationProposerPolicyIdentityKey(input.proposer);
	return (
		input.userRejectionSuppressionTombstonesOfNaturalKey.find((tombstone) => {
			const scopeApplies =
				tombstone.suppressionScope === "all_relation_proposers_except_web_ui_user_direct_assertions" ||
				tombstone.suppressedRelationProposerPolicyIdentityKey === proposerPolicyIdentityKey;
			const rejectedEvidenceAnchors = new Set(tombstone.rejectedEvidenceAnchors);
			return (
				scopeApplies &&
				input.normalizedProposedEvidenceAnchors.every((anchor) => rejectedEvidenceAnchors.has(anchor)) &&
				areRelationEndpointPlanFingerprintsUnchangedSinceRejectionAlignedByEndpointWorkUnitKey(
					tombstone.endpointPlanFingerprintsAtRejection,
					input.proposedAssertionEndpointPlanFingerprints,
				)
			);
		}) ?? null
	);
}

export type RelationAssertionWritePlanningValidationResult<T> =
	| { validationPassed: true; validatedValue: T }
	| { validationPassed: false; validationFailureMessage: string };

// 按注册表校验专有属性：只允许本 kind 的属性、至少满足一组必填；泛相关的一句话理由就是断言理由本身。
export function validateAndCompleteAssertedReferenceRelationKindSpecificAttributes(input: {
	relationKind: AssertedInterWorkUnitReferenceRelationKind;
	assertedRelationKindSpecificAttributes: AssertedReferenceRelationKindSpecificAttributes;
	relationAssertionRationaleOneSentence: string;
}): RelationAssertionWritePlanningValidationResult<AssertedReferenceRelationKindSpecificAttributes> {
	const registryEntry = ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[input.relationKind];
	const attributes: AssertedReferenceRelationKindSpecificAttributes = {
		...input.assertedRelationKindSpecificAttributes,
	};
	const allowedAttributeKeys = new Set<string>(registryEntry.allowedKindSpecificAttributeKeys);
	const disallowedAttributeKeys = Object.entries(attributes)
		.filter(([, value]) => value !== undefined)
		.map(([attributeKey]) => attributeKey)
		.filter((attributeKey) => !allowedAttributeKeys.has(attributeKey));
	if (disallowedAttributeKeys.length > 0) {
		return {
			validationPassed: false,
			validationFailureMessage: `${input.relationKind} does not take ${disallowedAttributeKeys.join(", ")}; it accepts only ${[...allowedAttributeKeys].join(", ") || "no kind-specific attributes"}.`,
		};
	}
	if (input.relationKind === "reference_is_generally_related_with") {
		attributes.relatednessRationaleOneSentence ??= input.relationAssertionRationaleOneSentence;
	}
	const isAttributePresent = (attributeKey: keyof AssertedReferenceRelationKindSpecificAttributes): boolean => {
		const value = attributes[attributeKey];
		return Array.isArray(value) ? value.length > 0 : value !== undefined;
	};
	const requiredAlternatives = registryEntry.requiredKindSpecificAttributeKeyAlternatives;
	if (
		requiredAlternatives.length > 0 &&
		!requiredAlternatives.some((alternative) => alternative.every((attributeKey) => isAttributePresent(attributeKey)))
	) {
		return {
			validationPassed: false,
			validationFailureMessage: `${input.relationKind} requires ${requiredAlternatives.map((alternative) => alternative.join(" + ")).join(" or ")}.`,
		};
	}
	return { validationPassed: true, validatedValue: attributes };
}

export function validateAssertedReferenceRelationEndpoints(input: {
	relationKind: AssertedInterWorkUnitReferenceRelationKind;
	relationStatementSubjectWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
	relationStatementAnchorWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
}): RelationAssertionWritePlanningValidationResult<null> {
	const registryEntry = ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[input.relationKind];
	const subject = input.relationStatementSubjectWorkUnitRef;
	const anchor = input.relationStatementAnchorWorkUnitRef;
	if (buildInterWorkUnitRelationWorkUnitKey(subject) === buildInterWorkUnitRelationWorkUnitKey(anchor)) {
		return { validationPassed: false, validationFailureMessage: "A work unit cannot be related to itself." };
	}
	if (!registryEntry.allowedSubjectWorkUnitTypes.includes(subject.workUnitType)) {
		return {
			validationPassed: false,
			validationFailureMessage: `${input.relationKind} needs a Kanban task card on the asserting side; a standalone agent session has no requirements of its own to originate (create a task card, or let a card resume this session first).`,
		};
	}
	if (!registryEntry.allowedAnchorWorkUnitTypes.includes(anchor.workUnitType)) {
		return {
			validationPassed: false,
			validationFailureMessage: `${input.relationKind} does not accept a ${anchor.workUnitType} counterpart.`,
		};
	}
	if (
		registryEntry.rejectsEndpointsInSameKanbanWorkspace &&
		subject.workUnitType === "kanban_board_card" &&
		anchor.workUnitType === "kanban_board_card" &&
		subject.workspaceId === anchor.workspaceId
	) {
		return {
			validationPassed: false,
			validationFailureMessage:
				"Both task cards belong to the same project, so they are not cross-repository counterparts; assert reference_is_generally_related_with instead.",
		};
	}
	return { validationPassed: true, validatedValue: null };
}

// d-vocab §1.4：两种视角各一句。主语视角用正向读法，锚点视角用反向读法。
export function renderRelationStatementFromBothEndpointPerspectives(input: {
	relationKind: AssertedInterWorkUnitReferenceRelationKind;
	subjectWorkUnitDisplayLabel: string;
	anchorWorkUnitDisplayLabel: string;
}): { relationStatementReadFromSubjectPerspective: string; relationStatementReadFromAnchorPerspective: string } {
	const registryEntry = ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[input.relationKind];
	return {
		relationStatementReadFromSubjectPerspective: `${input.subjectWorkUnitDisplayLabel} ${registryEntry.forwardReadingPhraseFromSubject} ${input.anchorWorkUnitDisplayLabel}`,
		relationStatementReadFromAnchorPerspective: `${input.anchorWorkUnitDisplayLabel} ${registryEntry.inverseReadingPhraseFromAnchor} ${input.subjectWorkUnitDisplayLabel}`,
	};
}

function resolveActorOfProposer(proposer: InterWorkUnitRelationAssertionProposer): KanbanActor {
	return proposer.proposerKind === "web_ui_user_with_verified_page_load_nonce"
		? { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" }
		: proposer.resolvedActorWithEventEnvelopeContext.resolvedKanbanActor;
}

// 账本索引列（subjectWorkspaceId / subjectTaskId）取关系主语那张卡；主语是独立会话时退用锚点那张卡。
function selectKanbanBoardCardForLedgerEventSubjectIndex(
	endpoints: readonly InterWorkUnitRelationWorkUnitReference[],
): { subjectWorkspaceId: string | null; subjectTaskId: string | null } {
	const card = endpoints.find((endpoint) => endpoint.workUnitType === "kanban_board_card");
	return card && card.workUnitType === "kanban_board_card"
		? { subjectWorkspaceId: card.workspaceId, subjectTaskId: card.taskId }
		: { subjectWorkspaceId: null, subjectTaskId: null };
}

export function buildInterWorkUnitRelationAssertionLifecycleEventDraft(input: {
	proposer: InterWorkUnitRelationAssertionProposer;
	eventKind: InterWorkUnitRelationAssertionLifecycleEventKind;
	occurredAt: number;
	capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity;
	relationEndpoints: readonly InterWorkUnitRelationWorkUnitReference[];
	eventPayload: Record<string, unknown>;
}): InterWorkUnitRelationLedgerEventDraft {
	const context =
		input.proposer.proposerKind === "acting_work_unit_via_kanban_cli"
			? input.proposer.resolvedActorWithEventEnvelopeContext
			: null;
	return {
		eventFamily: "inter_work_unit_relation_assertion_lifecycle_event",
		eventKind: input.eventKind,
		occurredAt: input.occurredAt,
		actor: resolveActorOfProposer(input.proposer),
		actorNativeConversationSessionIdentity: context?.actorNativeConversationSessionIdentity ?? null,
		actorKanbanTaskConversationSessionId: context?.actorKanbanTaskConversationSessionId ?? null,
		actorRepositoryIdentityAtEventTime: context?.actorRepositoryIdentityAtEventTime ?? null,
		onBehalfOfInitiatingWorkUnit: null,
		causedBySystemExecutedCause: null,
		recordCaptureChannel: "live_runtime_capture",
		capturingKanbanRuntimeInstance: input.capturingKanbanRuntimeInstance,
		invokingKanbanCliCodeVersion: context?.invokingKanbanCliCodeVersion ?? null,
		occurredAtConversationTurnReference: null,
		idempotencyKey: null,
		...selectKanbanBoardCardForLedgerEventSubjectIndex(input.relationEndpoints),
		eventPayload: {
			...input.eventPayload,
			...(input.proposer.proposerKind === "web_ui_user_with_verified_page_load_nonce"
				? { webUiUserDecisionClientCharacteristics: input.proposer.webUiUserDecisionClientCharacteristics }
				: {}),
		},
	};
}
