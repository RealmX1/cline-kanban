import { z } from "zod";

// Post-Deploy Verification「移入 Done 结案」的请求侧契约。独立成文件而不是写在 api-contract.ts 的 PDV 一节：
// taskCardAction 的 moveIntoDone 请求 / 响应 schema 定义在 api-contract.ts 靠前的位置，要引用这里的 schema；
// 放在 PDV 一节（文件末段）会在模块求值时撞上 const 的暂时性死区。api-contract.ts 原样 re-export 本文件的全部导出。

// 入 Done 前需显式确认的项（plan Grilling #6 / #8）：
//   skip_validation     = review/in_progress 跳过 validation 列直接入 Done
//   in_progress_active  = 任务仍处于 in_progress（session 可能仍在跑）
// CLI 单次 `verification-confirm --ack a,b`；UI in_progress 拆成两次顺序对话框。
export const runtimePostDeployVerificationAcknowledgementSchema = z.enum(["skip_validation", "in_progress_active"]);
export type RuntimePostDeployVerificationAcknowledgement = z.infer<
	typeof runtimePostDeployVerificationAcknowledgementSchema
>;

// 未全勾也能结案进 Done，但每个未勾项必须带原因（2026-10-11 用户需求）。原因码：
//   manual_reproduction_cost_exceeds_verification_value                       = 手工复现过于繁琐，成本与收益不相称
//   trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation = 触发时机随机 / 罕见，转为在自然使用中观察
//                                                                             （结案时生成持久的待观察记录，资产不被自动清理）
//   assertion_already_covered_by_other_verification_evidence                  = 已由其他途径覆盖（部署前测试、其他任务的验证、日常使用已观察到）
//   assertion_obsolete_because_verified_behavior_changed_or_removed           = 断言已过时（后续改动替代或移除了该行为）
//   custom_reason_described_in_reason_text                                    = 自定义，必须填写原因文本
export const runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema = z.enum([
	"manual_reproduction_cost_exceeds_verification_value",
	"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
	"assertion_already_covered_by_other_verification_evidence",
	"assertion_obsolete_because_verified_behavior_changed_or_removed",
	"custom_reason_described_in_reason_text",
]);
export type RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode = z.infer<
	typeof runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema
>;

function requireReasonTextForCustomUncheckedChecklistItemClosureReason(
	value: {
		uncheckedChecklistItemClosureReasonCode: RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode;
		uncheckedChecklistItemClosureReasonText?: string;
	},
	context: z.RefinementCtx,
): void {
	if (
		value.uncheckedChecklistItemClosureReasonCode === "custom_reason_described_in_reason_text" &&
		(value.uncheckedChecklistItemClosureReasonText ?? "").trim().length === 0
	) {
		context.addIssue({
			code: "custom",
			path: ["uncheckedChecklistItemClosureReasonText"],
			message: "自定义原因必须填写原因文本。",
		});
	}
}

// 不绑定具体项的原因（「应用到全部未勾项」、CLI `--reason-for-all-unchecked`）。
export const runtimePostDeployVerificationUncheckedChecklistItemClosureReasonWithoutItemSchema = z
	.object({
		uncheckedChecklistItemClosureReasonCode:
			runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema,
		uncheckedChecklistItemClosureReasonText: z.string().optional(),
	})
	.superRefine(requireReasonTextForCustomUncheckedChecklistItemClosureReason);
export type RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonWithoutItem = z.infer<
	typeof runtimePostDeployVerificationUncheckedChecklistItemClosureReasonWithoutItemSchema
>;

export const runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema = z
	.object({
		checklistItemId: z.string(),
		uncheckedChecklistItemClosureReasonCode:
			runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema,
		uncheckedChecklistItemClosureReasonText: z.string().optional(),
	})
	.superRefine(requireReasonTextForCustomUncheckedChecklistItemClosureReason);
export type RuntimePostDeployVerificationUncheckedChecklistItemClosureReason = z.infer<
	typeof runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema
>;

export const runtimePostDeployVerificationClosureOutcomeSchema = z.enum([
	"all_checklist_items_checked",
	"closed_into_done_with_unchecked_items_reasoned",
]);
export type RuntimePostDeployVerificationClosureOutcome = z.infer<
	typeof runtimePostDeployVerificationClosureOutcomeSchema
>;

// 移入 Done 时随请求带上的结案信息。逐项原因优先；没逐项给的未勾项统一套用 ...AppliedToRemaining...。
// 服务端只在任务受门禁（在活跃部署组里、未结案、有未勾项）时读它；不受门禁的移列忽略它。
export const runtimePostDeployVerificationDoneEntryClosureRequestSchema = z.object({
	uncheckedChecklistItemClosureReasons: z
		.array(runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema)
		.optional(),
	closureReasonAppliedToRemainingUncheckedChecklistItems:
		runtimePostDeployVerificationUncheckedChecklistItemClosureReasonWithoutItemSchema.optional(),
	confirmedAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema).optional(),
});
export type RuntimePostDeployVerificationDoneEntryClosureRequest = z.infer<
	typeof runtimePostDeployVerificationDoneEntryClosureRequestSchema
>;

// 门禁拒绝移入 Done 时 TRPCError(PRECONDITION_FAILED) 的 message 前缀（机读）：客户端据此打开原因对话框，
// CLI 据此提示加 `--reason-for-all-unchecked`。前缀后是人读说明。
export const POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX =
	"POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS:";
