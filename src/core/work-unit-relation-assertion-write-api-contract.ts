import { z } from "zod";

import {
	ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS,
	assertedInterWorkUnitRelationSchema,
	assertedReferenceRelationKindSpecificAttributesSchema,
} from "./inter-work-unit-asserted-relation-kind-registry-contract";
import {
	RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES,
	RELATION_ASSERTION_REVOCATION_REASONS,
} from "./inter-work-unit-relation-assertion-lifecycle-event-contract";
import { workUnitSelectorForRelationReadSchema } from "./work-unit-relation-read-api-contract";

// dd2db 2.1 写入面的 tRPC 契约（`workUnit.*` 的断言与撤销）。两组入口，按行动者分开：
// - `…AsActingWorkUnit`：agent 经 CLI 调用；主语一律是请求方工作单元（由 CLI 声明头的环境变量解析，R3.4 不接受 --from/--to），
//   走确认矩阵路由（2.1 只开放 M1 与撤销权表、只有 S1；其余策略明确拒绝、绝不降级）。
// - `…DirectlyAsWebUiUser`：Relations 面板的用户手势；必须带已校验的页面 nonce、不能带 CLI 声明头，
//   直接生效（d-confirm §1.3），永远不受拒绝墓碑抑制，并记录客户端特征供事后甄别（d-confirm §4.3 威胁模型）。

const relationAssertionRationaleOneSentenceSchema = z.string().trim().min(1).max(600);
const relationAssertionEvidencePointerSchema = z.string().trim().min(1).max(1000);

export const assertReferenceRelationAsActingWorkUnitRequestSchema = z.object({
	relationKind: z.enum(ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS),
	counterpartWorkUnit: workUnitSelectorForRelationReadSchema,
	relationAssertionRationaleOneSentence: relationAssertionRationaleOneSentenceSchema,
	relationAssertionEvidencePointers: z.array(relationAssertionEvidencePointerSchema).max(50).default([]),
	assertedRelationKindSpecificAttributes: assertedReferenceRelationKindSpecificAttributesSchema.default({}),
	agentSelectedConfirmationStrategy: z.enum(RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES).optional(),
	strategySelectionRationale: z.string().trim().min(1).max(600).optional(),
	dryRunWithoutWritingIntoLedger: z.boolean().default(false),
});
export type AssertReferenceRelationAsActingWorkUnitRequest = z.infer<
	typeof assertReferenceRelationAsActingWorkUnitRequestSchema
>;

export const revokeEffectiveRelationAssertionAsActingWorkUnitRequestSchema = z.object({
	relationId: z.string().trim().min(1),
	relationAssertionRevocationReason: z.enum(RELATION_ASSERTION_REVOCATION_REASONS),
	agentSelectedConfirmationStrategy: z.enum(RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES).optional(),
	strategySelectionRationale: z.string().trim().min(1).max(600).optional(),
	dryRunWithoutWritingIntoLedger: z.boolean().default(false),
});
export type RevokeEffectiveRelationAssertionAsActingWorkUnitRequest = z.infer<
	typeof revokeEffectiveRelationAssertionAsActingWorkUnitRequestSchema
>;

// 由触发决策的那次 DOM 事件与 navigator 采集（客户端特征只供事后甄别，不是凭据）；isTrusted 为 false 的合成事件直接拒绝。
export const webUiUserDecisionClientCharacteristicsSchema = z.object({
	triggeringDomEventIsTrusted: z.boolean(),
	navigatorWebdriver: z.boolean(),
	navigatorUserAgent: z.string().max(1000),
});
export type WebUiUserDecisionClientCharacteristics = z.infer<typeof webUiUserDecisionClientCharacteristicsSchema>;

export const assertReferenceRelationDirectlyAsWebUiUserRequestSchema = z.object({
	subjectWorkUnit: workUnitSelectorForRelationReadSchema,
	relationKind: z.enum(ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS),
	counterpartWorkUnit: workUnitSelectorForRelationReadSchema,
	relationAssertionRationaleOneSentence: relationAssertionRationaleOneSentenceSchema,
	relationAssertionEvidencePointers: z.array(relationAssertionEvidencePointerSchema).max(50).default([]),
	assertedRelationKindSpecificAttributes: assertedReferenceRelationKindSpecificAttributesSchema.default({}),
	webUiUserDecisionClientCharacteristics: webUiUserDecisionClientCharacteristicsSchema,
});
export type AssertReferenceRelationDirectlyAsWebUiUserRequest = z.infer<
	typeof assertReferenceRelationDirectlyAsWebUiUserRequestSchema
>;

export const revokeEffectiveRelationAssertionDirectlyAsWebUiUserRequestSchema = z.object({
	relationId: z.string().trim().min(1),
	relationAssertionRevocationReason: z.enum(RELATION_ASSERTION_REVOCATION_REASONS),
	webUiUserDecisionClientCharacteristics: webUiUserDecisionClientCharacteristicsSchema,
});
export type RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest = z.infer<
	typeof revokeEffectiveRelationAssertionDirectlyAsWebUiUserRequestSchema
>;

export const INTER_WORK_UNIT_RELATION_ASSERTION_WRITE_OUTCOMES = [
	"asserted_relation_applied_and_effective",
	"reassertion_merged_into_already_effective_assertion",
	"effective_relation_assertion_revoked",
	// 重复的撤销（双击、重试）：已经是撤销态，不再记事件。
	"relation_assertion_was_already_revoked",
	"dry_run_would_apply_asserted_relation",
	"dry_run_would_merge_into_already_effective_assertion",
	"dry_run_would_revoke_effective_relation_assertion",
] as const;

export const interWorkUnitRelationAssertionWriteResponseSchema = z.object({
	relationAssertionWriteOutcome: z.enum(INTER_WORK_UNIT_RELATION_ASSERTION_WRITE_OUTCOMES),
	// 合并、已撤销、dry-run 没有新的可确认变更。
	relationAffectingConfirmableChangeId: z.string().nullable(),
	// 写入之后（dry-run 时是「假如写入」）的关系；撤销后为撤销态。
	assertedRelation: assertedInterWorkUnitRelationSchema,
	// 判定依据（与 created_and_routed 事件里记的同一份），dry-run 也给出。
	confirmationRoutingDecision: z.record(z.string(), z.unknown()),
	// d-vocab §1.4：每次写入都用两种视角回显一句话，写反了一眼能看出来。
	relationStatementReadFromSubjectPerspective: z.string(),
	relationStatementReadFromAnchorPerspective: z.string(),
	userRejectionSuppressionTombstoneRecorded: z.boolean(),
});
export type InterWorkUnitRelationAssertionWriteResponse = z.infer<
	typeof interWorkUnitRelationAssertionWriteResponseSchema
>;
