// 记录型关系静音（族 7）的并发串行：同一 runtime 进程内并发的静音请求必须依次「读追上账本的投影 → 判断是否已在目标状态
// → 需要时追加并等待提交」，否则并发的相同请求都会读到旧状态、各追加一条不可撤回的事件。
// 依赖全部是最小 fake：读函数从内存投影状态读，追加函数异步延迟后才把事件应用到同一份状态并计数。
import { describe, expect, it } from "vitest";

import type {
	CapturingKanbanRuntimeInstanceIdentity,
	InterWorkUnitRelationLedgerEventDraft,
} from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../../../src/core/kanban-cli-invocation-environment-actor-claims";
import type { KanbanRequestOriginActorEvidence } from "../../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	createEmptyRecordedInterWorkUnitRelationProjectionState,
	type RecordedInterWorkUnitRelationProjectionState,
} from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";
import { createWorkUnitRelationPresentationPreferenceApi } from "../../../src/trpc/work-unit-relation-presentation-preference-api";

const RECORDED_RELATION_ID_UNDER_TEST = "recorded-relation-id-under-concurrent-mute-test";

const FAKE_CAPTURING_KANBAN_RUNTIME_INSTANCE: CapturingKanbanRuntimeInstanceIdentity = {
	kanbanRuntimeInstanceId: "fake-kanban-runtime-instance-for-concurrent-mute-test",
	kanbanRuntimeProcessId: 1,
	kanbanRuntimeCodeVersion: "0.0.0-test",
};

const WEB_UI_ORIGIN_EVIDENCE_WITH_VERIFIED_PAGE_LOAD_NONCE: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
	webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
};

function createProjectionStateWithOneUnmutedRecordedRelation(): RecordedInterWorkUnitRelationProjectionState {
	const projectionState = createEmptyRecordedInterWorkUnitRelationProjectionState();
	projectionState.recordedRelationsByRelationId.set(RECORDED_RELATION_ID_UNDER_TEST, {
		relationId: RECORDED_RELATION_ID_UNDER_TEST,
		relationKind: "provenance_created_by",
		relationStatementSubjectWorkUnitRef: {
			workUnitType: "kanban_board_card",
			workspaceId: "workspace-of-concurrent-mute-test",
			taskId: "c0001",
			taskIncarnationCreatedAtEpochMs: 2_000,
		},
		relationStatementAnchorWorkUnitRef: {
			workUnitType: "kanban_board_card",
			workspaceId: "workspace-of-concurrent-mute-test",
			taskId: "p0001",
			taskIncarnationCreatedAtEpochMs: 1_000,
		},
		relationFirstEstablishedAt: 2_000,
		relationLastUpdatedAt: 2_000,
		mostRecentProjectedFromEventIds: [],
		captureChannelsOfDerivingEvents: [],
		occurrenceCountByTaskMutationEventKind: {},
		recordedRelationKindSpecificAttributes: {},
		isCreationTimePrimaryProvenanceOfSubjectCard: true,
		mutedInPresentationAt: null,
		mutedInPresentationByActorKind: null,
	});
	return projectionState;
}

function waitForMacrotaskSoThatConcurrentRequestsInterleave(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

// 最小 fake 账本：追加先异步等待（模拟 worker 往返），再把族 7 事件应用到内存投影。
// failingAppendCallOrdinals 里的第 N 次追加（从 1 计）在等待后失败，且不改投影状态。
function createFakeLedgerBackedPresentationPreferenceApi(options: { failingAppendCallOrdinals?: number[] } = {}) {
	const projectionState = createProjectionStateWithOneUnmutedRecordedRelation();
	const committedPresentationPreferenceEventKinds: string[] = [];
	let appendCallCount = 0;
	const presentationPreferenceApi = createWorkUnitRelationPresentationPreferenceApi({
		readRecordedInterWorkUnitRelationProjection: async (read) => {
			await waitForMacrotaskSoThatConcurrentRequestsInterleave();
			return await read({
				projectionState,
				readRetainedTaskCardFieldValuesBySha256: async () => new Map(),
				findRetainedTaskCardFieldKeywordMatchesBySha256: async () => new Map(),
			});
		},
		appendCommittedEventsIntoLedgerAndWaitForCommit: async (buildEventDrafts) => {
			appendCallCount += 1;
			const appendCallOrdinal = appendCallCount;
			const eventDrafts: InterWorkUnitRelationLedgerEventDraft[] = buildEventDrafts(
				FAKE_CAPTURING_KANBAN_RUNTIME_INSTANCE,
			);
			await waitForMacrotaskSoThatConcurrentRequestsInterleave();
			if (options.failingAppendCallOrdinals?.includes(appendCallOrdinal)) {
				throw new Error(`fake ledger append #${appendCallOrdinal} failed`);
			}
			for (const eventDraft of eventDrafts) {
				committedPresentationPreferenceEventKinds.push(eventDraft.eventKind);
				if (eventDraft.eventKind === "recorded_relation_muted_in_presentation_by_user") {
					projectionState.presentationMuteStateByRelationId.set(RECORDED_RELATION_ID_UNDER_TEST, {
						mutedInPresentationAt: eventDraft.occurredAt,
						mutedInPresentationByActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce",
					});
				} else {
					projectionState.presentationMuteStateByRelationId.delete(RECORDED_RELATION_ID_UNDER_TEST);
				}
			}
		},
	});
	return {
		presentationPreferenceApi,
		projectionState,
		committedPresentationPreferenceEventKinds,
		readAppendCallCount: () => appendCallCount,
	};
}

describe("createWorkUnitRelationPresentationPreferenceApi 并发静音请求的进程内串行", () => {
	it("并发两次相同的静音请求只追加一条事件，恰好一个响应声称已记录", async () => {
		const { presentationPreferenceApi, committedPresentationPreferenceEventKinds, readAppendCallCount } =
			createFakeLedgerBackedPresentationPreferenceApi();
		const muteRequest = { relationId: RECORDED_RELATION_ID_UNDER_TEST, recordedRelationMutedInPresentation: true };

		const concurrentResponses = await Promise.all([
			presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
				muteRequest,
				WEB_UI_ORIGIN_EVIDENCE_WITH_VERIFIED_PAGE_LOAD_NONCE,
			),
			presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
				muteRequest,
				WEB_UI_ORIGIN_EVIDENCE_WITH_VERIFIED_PAGE_LOAD_NONCE,
			),
		]);

		expect(readAppendCallCount()).toBe(1);
		expect(committedPresentationPreferenceEventKinds).toEqual(["recorded_relation_muted_in_presentation_by_user"]);
		expect(
			concurrentResponses.filter((response) => response.relationPresentationPreferenceEventRecorded),
		).toHaveLength(1);
	});

	it("并发静音 + 取消静音时两次都追加，最终状态与后到者一致", async () => {
		const { presentationPreferenceApi, projectionState, committedPresentationPreferenceEventKinds } =
			createFakeLedgerBackedPresentationPreferenceApi();

		const concurrentResponses = await Promise.all([
			presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
				{ relationId: RECORDED_RELATION_ID_UNDER_TEST, recordedRelationMutedInPresentation: true },
				WEB_UI_ORIGIN_EVIDENCE_WITH_VERIFIED_PAGE_LOAD_NONCE,
			),
			presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
				{ relationId: RECORDED_RELATION_ID_UNDER_TEST, recordedRelationMutedInPresentation: false },
				WEB_UI_ORIGIN_EVIDENCE_WITH_VERIFIED_PAGE_LOAD_NONCE,
			),
		]);

		expect(concurrentResponses.map((response) => response.relationPresentationPreferenceEventRecorded)).toEqual([
			true,
			true,
		]);
		expect(committedPresentationPreferenceEventKinds).toEqual([
			"recorded_relation_muted_in_presentation_by_user",
			"recorded_relation_unmuted_in_presentation_by_user",
		]);
		expect(projectionState.presentationMuteStateByRelationId.has(RECORDED_RELATION_ID_UNDER_TEST)).toBe(false);
	});

	it("前一个请求追加失败不毒化串行区：并发的后一个相同请求仍能正常追加", async () => {
		const { presentationPreferenceApi, projectionState, committedPresentationPreferenceEventKinds } =
			createFakeLedgerBackedPresentationPreferenceApi({ failingAppendCallOrdinals: [1] });
		const muteRequest = { relationId: RECORDED_RELATION_ID_UNDER_TEST, recordedRelationMutedInPresentation: true };

		const concurrentOutcomes = await Promise.allSettled([
			presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
				muteRequest,
				WEB_UI_ORIGIN_EVIDENCE_WITH_VERIFIED_PAGE_LOAD_NONCE,
			),
			presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
				muteRequest,
				WEB_UI_ORIGIN_EVIDENCE_WITH_VERIFIED_PAGE_LOAD_NONCE,
			),
		]);

		expect(concurrentOutcomes[0]).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: "fake ledger append #1 failed" }),
		});
		expect(concurrentOutcomes[1]).toMatchObject({
			status: "fulfilled",
			value: expect.objectContaining({ relationPresentationPreferenceEventRecorded: true }),
		});
		expect(committedPresentationPreferenceEventKinds).toEqual(["recorded_relation_muted_in_presentation_by_user"]);
		expect(projectionState.presentationMuteStateByRelationId.has(RECORDED_RELATION_ID_UNDER_TEST)).toBe(true);
	});

	it("没有已校验页面 nonce 的请求在串行区之外直接 FORBIDDEN，不读也不写", async () => {
		const { presentationPreferenceApi, readAppendCallCount } = createFakeLedgerBackedPresentationPreferenceApi();

		await expect(
			presentationPreferenceApi.setRecordedRelationPresentationMutePreference(
				{ relationId: RECORDED_RELATION_ID_UNDER_TEST, recordedRelationMutedInPresentation: true },
				{
					decodedCliActorClaimsRequestHeader:
						decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
				},
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(readAppendCallCount()).toBe(0);
	});
});
