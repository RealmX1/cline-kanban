// dd2db 2.1 Relations 面板的断言型关系写入传输助手：「添加关系」（用户直接断言参照关系）与「撤销」（用户撤销生效中的断言）。
// 把 tRPC 细节（procedure 路径、错误码、错误信息的 `<snake_case_code>: <句子>` 格式）挡在这里，hook 只管状态编排。
//
// 两个 procedure 都是决策类（R3）：**只能由显式的用户手势处理器（onClick）调用**，绝不能放进 effect、hook 自动流程或
// 自动化模块——grit/relation-user-decision-calls-only-from-explicit-user-gesture-handlers.grit 拦截 effect 回调里的调用。
// 第一个参数必须是触发这次决策的那个 DOM / React 事件：runtime 拒绝 isTrusted 为 false 的合成事件（FORBIDDEN），
// 并把 navigator.webdriver / userAgent 记进事件供事后甄别浏览器自动化（客户端特征只是甄别线索，不是凭据）。
// runtime 还要求请求带已校验的页面 nonce；getRuntimeTrpcClient 会自动带上 nonce 头。

import type {
	AssertReferenceRelationDirectlyAsWebUiUserRequest,
	InterWorkUnitRelationAssertionWriteResponse,
	RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest,
	WebUiUserDecisionClientCharacteristics,
} from "@runtime-work-unit-relation-assertion-write-api-contract";
import { TRPCClientError } from "@trpc/client";
import type { SyntheticEvent } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

// React 合成事件（onClick 拿到的）或原生 DOM 事件。
export type TriggeringExplicitUserGestureEvent = SyntheticEvent | Event;

// 与 runtime 契约 webUiUserDecisionClientCharacteristicsSchema 的 navigatorUserAgent.max(1000) 对齐，超长截断而不是整单被拒。
const NAVIGATOR_USER_AGENT_MAXIMUM_LENGTH_ACCEPTED_BY_RUNTIME = 1000;

function readIsTrustedOfTriggeringExplicitUserGestureEvent(
	triggeringUserGestureEvent: TriggeringExplicitUserGestureEvent,
): boolean {
	// React 合成事件读 nativeEvent.isTrusted（合成事件自身的 isTrusted 在旧版 React 上不可靠）；原生事件直接读。
	if ("nativeEvent" in triggeringUserGestureEvent && triggeringUserGestureEvent.nativeEvent) {
		return triggeringUserGestureEvent.nativeEvent.isTrusted === true;
	}
	return triggeringUserGestureEvent.isTrusted === true;
}

export function collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(
	triggeringUserGestureEvent: TriggeringExplicitUserGestureEvent,
): WebUiUserDecisionClientCharacteristics {
	const browserNavigator = typeof navigator === "undefined" ? null : navigator;
	return {
		triggeringDomEventIsTrusted: readIsTrustedOfTriggeringExplicitUserGestureEvent(triggeringUserGestureEvent),
		navigatorWebdriver: browserNavigator?.webdriver === true,
		navigatorUserAgent: (browserNavigator?.userAgent ?? "").slice(
			0,
			NAVIGATOR_USER_AGENT_MAXIMUM_LENGTH_ACCEPTED_BY_RUNTIME,
		),
	};
}

// 只给显式的用户手势处理器调用（见文件头）。主语由调用方给出（面板所在的卡），runtime 校验端点与 kind 专有属性。
export async function assertReferenceRelationDirectlyAsWebUiUserFromExplicitUserGesture(
	triggeringUserGestureEvent: TriggeringExplicitUserGestureEvent,
	input: {
		workspaceId: string;
		referenceRelationAssertion: Omit<
			AssertReferenceRelationDirectlyAsWebUiUserRequest,
			"webUiUserDecisionClientCharacteristics"
		>;
	},
): Promise<InterWorkUnitRelationAssertionWriteResponse> {
	const webUiUserDecisionClientCharacteristics =
		collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(triggeringUserGestureEvent);
	const trpcClient = getRuntimeTrpcClient(input.workspaceId);
	return await trpcClient.workUnit.assertReferenceRelationDirectlyAsWebUiUser.mutate({
		...input.referenceRelationAssertion,
		webUiUserDecisionClientCharacteristics,
	});
}

// 只给显式的用户手势处理器调用（见文件头）。撤销一条已撤销的关系不报错，outcome 为 relation_assertion_was_already_revoked。
export async function revokeEffectiveRelationAssertionDirectlyAsWebUiUserFromExplicitUserGesture(
	triggeringUserGestureEvent: TriggeringExplicitUserGestureEvent,
	input: {
		workspaceId: string;
		relationId: RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest["relationId"];
		relationAssertionRevocationReason: RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest["relationAssertionRevocationReason"];
	},
): Promise<InterWorkUnitRelationAssertionWriteResponse> {
	const webUiUserDecisionClientCharacteristics =
		collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(triggeringUserGestureEvent);
	const trpcClient = getRuntimeTrpcClient(input.workspaceId);
	return await trpcClient.workUnit.revokeEffectiveRelationAssertionDirectlyAsWebUiUser.mutate({
		relationId: input.relationId,
		relationAssertionRevocationReason: input.relationAssertionRevocationReason,
		webUiUserDecisionClientCharacteristics,
	});
}

export type InterWorkUnitRelationAssertionWriteFailureKind =
	// SERVICE_UNAVAILABLE：关系账本没打开 / 打不开，没有落账。
	| "inter_work_unit_relation_ledger_unavailable"
	// FORBIDDEN：runtime 不认这是一次用户决策（页面 nonce 没校验过、带了 CLI 头、或触发事件不是可信的用户事件）。
	| "web_ui_user_decision_request_origin_rejected_by_runtime"
	// BAD_REQUEST：kind 专有属性 / 端点不合法（自指、同项目的跨仓配对等）。
	| "relation_assertion_rejected_as_invalid_by_runtime"
	// PRECONDITION_FAILED：端点卡已永久删除等前提不成立。
	| "relation_assertion_precondition_not_met"
	// NOT_FOUND：端点卡或要撤销的关系在账本里不存在。
	| "relation_endpoint_or_asserted_relation_not_found_in_inter_work_unit_relation_ledger"
	// CONFLICT：并发写入一直在改这条关系，重试即可。
	| "relation_assertion_write_kept_conflicting_with_concurrent_writes"
	// 其余：网络断开、runtime 离线、未预期的服务端错误。
	| "unexpected_relation_assertion_write_failure";

export interface InterWorkUnitRelationAssertionWriteFailure {
	writeFailureKind: InterWorkUnitRelationAssertionWriteFailureKind;
	// runtime 错误信息里 `<snake_case_code>: ` 前缀的 code；没有前缀（网络错误、账本不可用等）为 null。
	runtimeRelationAssertionWriteErrorCode: string | null;
	// 去掉 code 前缀后的那句人话，原样展示给用户。
	writeFailureHumanReadableSentence: string;
}

const RUNTIME_RELATION_ASSERTION_WRITE_ERROR_MESSAGE_WITH_CODE_PREFIX_PATTERN = /^([a-z][a-z0-9_]*): ([\s\S]+)$/u;

function readTrpcErrorCodeOfRelationAssertionWriteFailure(error: unknown): string | null {
	if (!(error instanceof TRPCClientError)) {
		return null;
	}
	const errorData = error.data as { code?: unknown } | null | undefined;
	return typeof errorData?.code === "string" ? errorData.code : null;
}

const WRITE_FAILURE_KIND_BY_TRPC_ERROR_CODE: Record<string, InterWorkUnitRelationAssertionWriteFailureKind> = {
	SERVICE_UNAVAILABLE: "inter_work_unit_relation_ledger_unavailable",
	FORBIDDEN: "web_ui_user_decision_request_origin_rejected_by_runtime",
	BAD_REQUEST: "relation_assertion_rejected_as_invalid_by_runtime",
	PRECONDITION_FAILED: "relation_assertion_precondition_not_met",
	NOT_FOUND: "relation_endpoint_or_asserted_relation_not_found_in_inter_work_unit_relation_ledger",
	CONFLICT: "relation_assertion_write_kept_conflicting_with_concurrent_writes",
};

export function classifyInterWorkUnitRelationAssertionWriteFailure(
	error: unknown,
): InterWorkUnitRelationAssertionWriteFailure {
	const rawFailureMessage = error instanceof Error ? error.message : String(error);
	const codePrefixMatch =
		RUNTIME_RELATION_ASSERTION_WRITE_ERROR_MESSAGE_WITH_CODE_PREFIX_PATTERN.exec(rawFailureMessage);
	const trpcErrorCode = readTrpcErrorCodeOfRelationAssertionWriteFailure(error);
	return {
		writeFailureKind:
			(trpcErrorCode ? WRITE_FAILURE_KIND_BY_TRPC_ERROR_CODE[trpcErrorCode] : undefined) ??
			"unexpected_relation_assertion_write_failure",
		runtimeRelationAssertionWriteErrorCode: codePrefixMatch?.[1] ?? null,
		writeFailureHumanReadableSentence: codePrefixMatch?.[2] ?? rawFailureMessage,
	};
}
