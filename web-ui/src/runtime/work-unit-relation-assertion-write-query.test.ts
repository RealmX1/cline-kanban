import type { SyntheticEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrpcClientErrorWithCodeForTest } from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";
import {
	assertReferenceRelationDirectlyAsWebUiUserFromExplicitUserGesture,
	classifyInterWorkUnitRelationAssertionWriteFailure,
	collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent,
	revokeEffectiveRelationAssertionDirectlyAsWebUiUserFromExplicitUserGesture,
} from "@/runtime/work-unit-relation-assertion-write-query";

const { assertReferenceRelationMutateMock, revokeRelationAssertionMutateMock, getRuntimeTrpcClientMock } = vi.hoisted(
	() => ({
		assertReferenceRelationMutateMock: vi.fn(),
		revokeRelationAssertionMutateMock: vi.fn(),
		getRuntimeTrpcClientMock: vi.fn(),
	}),
);

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: getRuntimeTrpcClientMock,
}));

// React 合成事件只需要 nativeEvent；用最小形状构造，避免依赖 React 内部。
function buildReactSyntheticEventWithNativeIsTrusted(nativeEventIsTrusted: boolean): SyntheticEvent {
	return { nativeEvent: { isTrusted: nativeEventIsTrusted } as Event } as SyntheticEvent;
}

function stubBrowserNavigator(navigatorFields: { webdriver: boolean; userAgent: string }): void {
	vi.stubGlobal("navigator", navigatorFields);
}

describe("work-unit-relation-assertion-write-query", () => {
	beforeEach(() => {
		assertReferenceRelationMutateMock.mockReset();
		revokeRelationAssertionMutateMock.mockReset();
		getRuntimeTrpcClientMock.mockReset();
		getRuntimeTrpcClientMock.mockReturnValue({
			workUnit: {
				assertReferenceRelationDirectlyAsWebUiUser: { mutate: assertReferenceRelationMutateMock },
				revokeEffectiveRelationAssertionDirectlyAsWebUiUser: { mutate: revokeRelationAssertionMutateMock },
			},
		});
		assertReferenceRelationMutateMock.mockResolvedValue({
			relationAssertionWriteOutcome: "asserted_relation_applied_and_effective",
		});
		revokeRelationAssertionMutateMock.mockResolvedValue({
			relationAssertionWriteOutcome: "effective_relation_assertion_revoked",
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("React 合成事件读 nativeEvent.isTrusted；原生 DOM 事件读 isTrusted；带上 navigator.webdriver 与 userAgent", () => {
		stubBrowserNavigator({ webdriver: false, userAgent: "Mozilla/5.0 test browser" });
		expect(
			collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(
				buildReactSyntheticEventWithNativeIsTrusted(true),
			),
		).toEqual({
			triggeringDomEventIsTrusted: true,
			navigatorWebdriver: false,
			navigatorUserAgent: "Mozilla/5.0 test browser",
		});
		// jsdom 里 dispatchEvent 派发的事件 isTrusted 恒为 false——正是脚本合成点击的样子。
		expect(
			collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(new MouseEvent("click"))
				.triggeringDomEventIsTrusted,
		).toBe(false);
		expect(
			collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(
				buildReactSyntheticEventWithNativeIsTrusted(false),
			).triggeringDomEventIsTrusted,
		).toBe(false);

		stubBrowserNavigator({ webdriver: true, userAgent: "x".repeat(1500) });
		const automatedBrowserCharacteristics =
			collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(
				buildReactSyntheticEventWithNativeIsTrusted(true),
			);
		expect(automatedBrowserCharacteristics.navigatorWebdriver).toBe(true);
		// runtime 契约 userAgent 上限 1000：超长截断，不让整单被拒。
		expect(automatedBrowserCharacteristics.navigatorUserAgent).toHaveLength(1000);
	});

	it("添加关系：把请求与触发事件采集到的客户端特征一起发给 assertReferenceRelationDirectlyAsWebUiUser", async () => {
		stubBrowserNavigator({ webdriver: false, userAgent: "Mozilla/5.0 test browser" });
		await assertReferenceRelationDirectlyAsWebUiUserFromExplicitUserGesture(
			buildReactSyntheticEventWithNativeIsTrusted(true),
			{
				workspaceId: "workspace-current-project",
				referenceRelationAssertion: {
					subjectWorkUnit: {
						workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
						bareTaskId: "abc12",
						workspaceId: "workspace-current-project",
					},
					relationKind: "reference_is_generally_related_with",
					counterpartWorkUnit: {
						workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
						bareTaskId: "def34",
						workspaceId: "workspace-other-project",
					},
					relationAssertionRationaleOneSentence: "Both touch the config loader.",
					relationAssertionEvidencePointers: [],
					assertedRelationKindSpecificAttributes: {},
				},
			},
		);
		expect(getRuntimeTrpcClientMock).toHaveBeenCalledWith("workspace-current-project");
		expect(assertReferenceRelationMutateMock).toHaveBeenCalledWith({
			subjectWorkUnit: {
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
				bareTaskId: "abc12",
				workspaceId: "workspace-current-project",
			},
			relationKind: "reference_is_generally_related_with",
			counterpartWorkUnit: {
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
				bareTaskId: "def34",
				workspaceId: "workspace-other-project",
			},
			relationAssertionRationaleOneSentence: "Both touch the config loader.",
			relationAssertionEvidencePointers: [],
			assertedRelationKindSpecificAttributes: {},
			webUiUserDecisionClientCharacteristics: {
				triggeringDomEventIsTrusted: true,
				navigatorWebdriver: false,
				navigatorUserAgent: "Mozilla/5.0 test browser",
			},
		});
	});

	it("撤销：合成事件也照实上报 isTrusted=false（由 runtime 拒绝，传输层不替它做决定）", async () => {
		stubBrowserNavigator({ webdriver: true, userAgent: "HeadlessChrome" });
		await revokeEffectiveRelationAssertionDirectlyAsWebUiUserFromExplicitUserGesture(new MouseEvent("click"), {
			workspaceId: "workspace-current-project",
			relationId: "relation-1",
			relationAssertionRevocationReason: "relation_was_incorrect",
		});
		expect(revokeRelationAssertionMutateMock).toHaveBeenCalledWith({
			relationId: "relation-1",
			relationAssertionRevocationReason: "relation_was_incorrect",
			webUiUserDecisionClientCharacteristics: {
				triggeringDomEventIsTrusted: false,
				navigatorWebdriver: true,
				navigatorUserAgent: "HeadlessChrome",
			},
		});
	});

	it("失败分类：按 tRPC code 归类，剥掉 runtime 的 snake_case 前缀，留下那句人话", () => {
		expect(
			classifyInterWorkUnitRelationAssertionWriteFailure(
				buildTrpcClientErrorWithCodeForTest(
					"BAD_REQUEST",
					"asserted_relation_endpoints_invalid: A cross-repository counterpart must be in a different project.",
				),
			),
		).toEqual({
			writeFailureKind: "relation_assertion_rejected_as_invalid_by_runtime",
			runtimeRelationAssertionWriteErrorCode: "asserted_relation_endpoints_invalid",
			writeFailureHumanReadableSentence: "A cross-repository counterpart must be in a different project.",
		});
		expect(
			classifyInterWorkUnitRelationAssertionWriteFailure(
				buildTrpcClientErrorWithCodeForTest(
					"FORBIDDEN",
					"web_ui_user_decision_requires_trusted_user_dom_event: This decision was triggered by a synthetic (untrusted) DOM event.",
				),
			).writeFailureKind,
		).toBe("web_ui_user_decision_request_origin_rejected_by_runtime");
		expect(
			classifyInterWorkUnitRelationAssertionWriteFailure(
				buildTrpcClientErrorWithCodeForTest("SERVICE_UNAVAILABLE", "Relation ledger database is not open."),
			),
		).toEqual({
			writeFailureKind: "inter_work_unit_relation_ledger_unavailable",
			runtimeRelationAssertionWriteErrorCode: null,
			writeFailureHumanReadableSentence: "Relation ledger database is not open.",
		});
		for (const [trpcErrorCode, expectedWriteFailureKind] of [
			["PRECONDITION_FAILED", "relation_assertion_precondition_not_met"],
			["NOT_FOUND", "relation_endpoint_or_asserted_relation_not_found_in_inter_work_unit_relation_ledger"],
			["CONFLICT", "relation_assertion_write_kept_conflicting_with_concurrent_writes"],
			["INTERNAL_SERVER_ERROR", "unexpected_relation_assertion_write_failure"],
		] as const) {
			expect(
				classifyInterWorkUnitRelationAssertionWriteFailure(
					buildTrpcClientErrorWithCodeForTest(trpcErrorCode, "x: y"),
				).writeFailureKind,
			).toBe(expectedWriteFailureKind);
		}
		expect(classifyInterWorkUnitRelationAssertionWriteFailure(new TypeError("Failed to fetch"))).toEqual({
			writeFailureKind: "unexpected_relation_assertion_write_failure",
			runtimeRelationAssertionWriteErrorCode: null,
			writeFailureHumanReadableSentence: "Failed to fetch",
		});
	});
});
